/**
 * server/tests/central.test.ts — Central adapter unit tests, NO network.
 *
 * TokenManager is tested against an injected clock + stub fetch; the row
 * mapping helpers are tested against recorded Central API JSON inlined here
 * (classic monitoring/v1 + central/v2 shapes). CentralAdapter.pull() is
 * exercised end-to-end with an in-memory fake `fetch` (FetchLike injection)
 * to cover candidate-path fallback, missing sections, section failures,
 * pagination, 429 backoff and the secret-free call log. Sleeps are injected
 * (SleepFn) so backoff and page pacing cost no wall time here.
 */

import { describe, expect, it } from 'vitest';
import type { PlaneState } from '../src/planes/types';
import {
  CentralAdapter,
  GREENLAKE_CCS_TOKEN_URL,
  isNewCentralGateway,
  TokenManager,
  ageString,
  durationString,
  externalSiteId,
  firmwareIsApproved,
  mapCentralClient,
  mapCentralDevice,
  mapCentralNotification,
  mapCentralSite,
  parseApprovedFirmware,
  parseRetryAfterMs,
  parseTimestamp,
  parseUsageIntervalSec,
  sevFor,
  siteIdForName,
  mapCentralGatewayPort,
  mapCentralRadio,
  mapCentralSwitchPort,
  mapCentralWlan,
  mapMobilityEvent,
  mapTopologyLink,
  mapTopologyNode,
  mapUsageSamples,
  normalizeCentralMac,
  type FetchLike,
} from '../src/planes/central';

// -- Recorded fixtures (shapes as the classic Central APIs return them) -------

const AP_ROW = {
  name: 'ap-lobby-01',
  serial: 'CN12345678',
  macaddr: 'AA:BB:CC:DD:EE:FF',
  model: 'AP-635',
  ip_address: '10.42.1.20',
  status: 'Up',
  site: 'Campus-01 HQ',
  firmware_version: '10.6.0.2',
  uptime: 3200000,
};

const SWITCH_ROW = {
  name: 'sw-acc-01',
  serial: 'SG98765432',
  macaddr: 'aa:bb:cc:00:11:22',
  model: 'Aruba CX 6300M-48G',
  ip_address: '10.42.0.14',
  status: 'Down',
  site: 'Riverside Clinic',
  firmware_version: '10.11.1030',
};

const SITE_ROW = { site_id: 12, site_name: 'Riverside Clinic', site_address: '88 Harbor St', device_count: 24 };

const CLIENT_ROW = {
  macaddr: '11:22:33:44:55:66',
  username: 'laptop-jane',
  ip_address: '10.42.8.41',
  os: 'Windows 11',
  client_type: 'wireless',
  site: 'Campus-01 HQ',
  associated_device: 'ap-lobby-01',
  ssid: 'Meridian-Staff',
  vlan: 820,
  role: 'staff',
  health: 92,
  session_age: 14700,
  auth_method: '802.1X',
};

const NOTIFICATION_ROW = {
  severity: 'Critical',
  type: 'AP disconnected',
  description: 'ap-lobby-01 lost contact with the controller',
  site: 'Riverside Clinic',
  timestamp: 1_753_000_000, // epoch seconds
  state: 'active',
  device_name: 'ap-riv-01',
};

// -- TokenManager --------------------------------------------------------------

describe('TokenManager', () => {
  function clock(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
    let t = start;
    return { now: () => t, advance: (ms) => (t += ms) };
  }

  it('caches the token until expiry minus the 60s margin', async () => {
    const clk = clock();
    let fetches = 0;
    const tm = new TokenManager(async () => {
      fetches += 1;
      return { accessToken: `tok-${fetches}`, expiresInSec: 3600 };
    }, clk.now);

    expect(await tm.get()).toBe('tok-1');
    clk.advance(3_539_000); // just inside the validity window
    expect(await tm.get()).toBe('tok-1');
    expect(fetches).toBe(1);

    clk.advance(2_000); // now past expiry − 60s
    expect(await tm.get()).toBe('tok-2');
    expect(fetches).toBe(2);
  });

  it('single-flight: concurrent get() calls share one token fetch', async () => {
    let fetches = 0;
    let release!: (t: { accessToken: string; expiresInSec: number }) => void;
    const tm = new TokenManager(
      () =>
        new Promise((resolve) => {
          fetches += 1;
          release = resolve;
        }),
      clock().now,
    );
    const a = tm.get();
    const b = tm.get();
    const c = tm.get();
    release({ accessToken: 'shared', expiresInSec: 7200 });
    expect(await Promise.all([a, b, c])).toEqual(['shared', 'shared', 'shared']);
    expect(fetches).toBe(1);
  });

  it('a failed fetch does not poison the manager — the next get() retries', async () => {
    let fetches = 0;
    const tm = new TokenManager(async () => {
      fetches += 1;
      if (fetches === 1) throw new Error('gateway unreachable');
      return { accessToken: 'recovered', expiresInSec: 3600 };
    }, clock().now);
    await expect(tm.get()).rejects.toThrow('gateway unreachable');
    expect(await tm.get()).toBe('recovered');
    expect(fetches).toBe(2);
  });

  it('invalidate() forces a re-authentication', async () => {
    let fetches = 0;
    const tm = new TokenManager(async () => ({ accessToken: `tok-${++fetches}`, expiresInSec: 3600 }), clock().now);
    expect(await tm.get()).toBe('tok-1');
    tm.invalidate();
    expect(await tm.get()).toBe('tok-2');
  });

  it('never caches a token shorter than the refresh margin', async () => {
    const clk = clock();
    let fetches = 0;
    const tm = new TokenManager(async () => ({ accessToken: `tok-${++fetches}`, expiresInSec: 30 }), clk.now);
    await tm.get();
    expect(await tm.get()).toBe('tok-2'); // 30s < 60s margin → no caching
  });
});

// -- Pure helpers ----------------------------------------------------------------

describe('pure helpers', () => {
  it('parseApprovedFirmware parses the comma map and skips junk', () => {
    expect(parseApprovedFirmware('cx=10.13,ap=10.6')).toEqual([
      ['cx', '10.13'],
      ['ap', '10.6'],
    ]);
    expect(parseApprovedFirmware('cx=10.13,,=bogus,noeq')).toEqual([['cx', '10.13']]);
    expect(parseApprovedFirmware(undefined)).toEqual([]);
  });

  it('firmwareIsApproved is honestly true without a declared train', () => {
    expect(firmwareIsApproved('switch', 'CX 6300M', '10.11.1030', [])).toBe(true);
    expect(firmwareIsApproved('switch', 'CX 6300M', '10.13.1005', [['cx', '10.13']])).toBe(true);
    expect(firmwareIsApproved('switch', 'CX 6300M', '10.11.1030', [['cx', '10.13']])).toBe(false);
    expect(firmwareIsApproved('ap', 'AP-635', '10.6.0.2', [['cx', '10.13']])).toBe(true); // family not covered
    expect(firmwareIsApproved('switch', 'CX 6300M', 'unknown', [['cx', '10.13']])).toBe(true);
  });

  it('externalSiteId slugs names outside the canonical union', () => {
    expect(externalSiteId('Zebra Kiosk')).toBe('ext-zebra-kiosk');
    expect(externalSiteId('HQ – East Wing!')).toBe('ext-hq-east-wing');
    expect(externalSiteId('   ')).toBe('ext-unknown');
  });

  it('siteIdForName canonicalises known aliases and keeps unknown display strings', () => {
    expect(siteIdForName('Campus-01 HQ')).toEqual({ siteId: 'campus-01', siteName: 'Campus-01 — Meridian HQ' });
    expect(siteIdForName('Zebra Kiosk')).toEqual({ siteId: 'ext-zebra-kiosk', siteName: 'Zebra Kiosk' });
    expect(siteIdForName(null)).toEqual({ siteId: 'multiple', siteName: 'Multiple' });
  });

  it('ageString / durationString / parseTimestamp / sevFor', () => {
    const now = 1_753_000_000_000;
    expect(ageString(now - 45_000, now)).toBe('45s');
    expect(ageString(now - 12 * 60_000, now)).toBe('12m');
    expect(ageString(now - 6 * 3_600_000, now)).toBe('6h');
    expect(ageString(now - 2 * 86_400_000, now)).toBe('2d');
    expect(durationString(14700)).toBe('4h 5m');
    expect(durationString(50)).toBe('50s');
    expect(parseTimestamp(1_753_000_000)).toBe(1_753_000_000_000); // epoch s → ms
    expect(parseTimestamp(1_753_000_000_000)).toBe(1_753_000_000_000);
    expect(parseTimestamp('2026-07-25T09:41:00Z')).toBe(Date.parse('2026-07-25T09:41:00Z'));
    expect(parseTimestamp('junk')).toBeNull();
    expect(sevFor('Critical')).toBe('P1');
    expect(sevFor('Warning')).toBe('P2');
    expect(sevFor('Informational')).toBe('P3');
  });

  it('parseRetryAfterMs reads both Retry-After forms and rejects junk', () => {
    const now = 1_753_000_000_000;
    expect(parseRetryAfterMs('30', now)).toBe(30_000); // delta-seconds
    expect(parseRetryAfterMs('  5 ', now)).toBe(5_000);
    expect(parseRetryAfterMs(new Date(now + 12_000).toUTCString(), now)).toBe(12_000); // HTTP-date
    expect(parseRetryAfterMs(new Date(now - 12_000).toUTCString(), now)).toBe(0); // never negative
    expect(parseRetryAfterMs('soon', now)).toBeNull();
    expect(parseRetryAfterMs(null, now)).toBeNull();
  });
});

// -- Row mapping -------------------------------------------------------------------

describe('mapCentralDevice', () => {
  it('maps an AP row: up/success, canonical site, identity hints', () => {
    const d = mapCentralDevice(AP_ROW, 'ap');
    expect(d).not.toBeNull();
    expect(d!.name).toBe('ap-lobby-01');
    expect(d!.type).toBe('ap');
    expect(d!.plane).toBe('CENTRAL');
    expect(d!.planeTone).toBe('accent');
    expect(d!.state).toBe('up');
    expect(d!.stateTone).toBe('success');
    expect(d!.siteId).toBe('campus-01');
    expect(d!.siteName).toBe('Campus-01 — Meridian HQ');
    expect(d!.firmware).toBe('10.6.0.2');
    expect(d!.firmwareApproved).toBe(true);
    expect(d!.serial).toBe('CN12345678');
    expect(d!.mac).toBe('AA:BB:CC:DD:EE:FF');
    expect(d!.localShell).toBe(false); // cloud-claimed
    expect(d!.reconciliationIssue).toBe(false); // reconcile computes this
    expect(d!.licence).toBe('unknown');
  });

  it('maps Down → down/danger and passes unknown statuses through neutral', () => {
    const down = mapCentralDevice(SWITCH_ROW, 'switch');
    expect(down!.state).toBe('down');
    expect(down!.stateTone).toBe('danger');
    const prov = mapCentralDevice({ ...AP_ROW, status: 'Provisioning' }, 'ap');
    expect(prov!.state).toBe('provisioning');
    expect(prov!.stateTone).toBe('neutral');
  });

  it('maps the v1alpha1 online/offline vocabulary onto up/down', () => {
    const on = mapCentralDevice({ ...AP_ROW, status: 'online' }, 'ap');
    expect(on!.state).toBe('up');
    expect(on!.stateTone).toBe('success');
    const off = mapCentralDevice({ ...AP_ROW, status: 'Offline' }, 'ap');
    expect(off!.state).toBe('down');
    expect(off!.stateTone).toBe('danger');
  });

  it('applies the approved-firmware map by device family', () => {
    const approved: [string, string][] = [['cx', '10.13']];
    expect(mapCentralDevice(SWITCH_ROW, 'switch', approved)!.firmwareApproved).toBe(false);
    expect(mapCentralDevice(AP_ROW, 'ap', approved)!.firmwareApproved).toBe(true); // family not covered
  });

  it('unknown site names get a generated ext- id; missing site lands on multiple', () => {
    const d = mapCentralDevice({ ...AP_ROW, site: 'Zebra Kiosk' }, 'ap');
    expect(d!.siteId).toBe('ext-zebra-kiosk');
    expect(d!.siteName).toBe('Zebra Kiosk');
    const noSite = mapCentralDevice({ ...AP_ROW, site: undefined }, 'ap');
    expect(noSite!.siteId).toBe('multiple');
  });

  it('returns null for junk rows', () => {
    expect(mapCentralDevice(null, 'ap')).toBeNull();
    expect(mapCentralDevice({ model: 'AP-635' }, 'ap')).toBeNull(); // no name/serial/mac
  });

  it('maps a v1alpha1 camelCase device row (deviceName/serialNumber/siteName/…)', () => {
    const d = mapCentralDevice(
      {
        deviceName: 'ap-lobby-02',
        serialNumber: 'CN87654321',
        macAddress: 'AA:BB:CC:00:00:01',
        model: 'AP-635',
        ipv4: '10.42.1.21',
        status: 'Up',
        siteName: 'Campus-01 HQ',
        firmwareVersion: '10.6.0.3',
      },
      'ap',
    );
    expect(d).not.toBeNull();
    expect(d!.name).toBe('ap-lobby-02');
    expect(d!.state).toBe('up');
    expect(d!.stateTone).toBe('success');
    expect(d!.siteId).toBe('campus-01');
    expect(d!.firmware).toBe('10.6.0.3');
    expect(d!.serial).toBe('CN87654321');
    expect(d!.mac).toBe('AA:BB:CC:00:00:01');
  });

  it('carries the management IP when the plane reports one, and omits it otherwise', () => {
    // Devices search and the terminal's resolveTarget() both key on it.
    expect(mapCentralDevice(AP_ROW, 'ap')!.ip).toBe('10.42.1.20');
    expect(mapCentralDevice({ deviceName: 'ap-x', ipAddress: '10.9.9.9' }, 'ap')!.ip).toBe('10.9.9.9');
    expect(mapCentralDevice({ name: 'ap-y' }, 'ap')).not.toHaveProperty('ip');
  });
});

describe('mapCentralSite', () => {
  it('maps a v2 site row with an honest empty health', () => {
    const s = mapCentralSite(SITE_ROW);
    expect(s).not.toBeNull();
    expect(s!.id).toBe('riverside');
    expect(s!.name).toBe('Riverside Clinic');
    expect(s!.planes).toEqual([{ name: 'CENTRAL', tone: 'accent' }]);
    expect(s!.devices).toBe(24);
    expect(s!.health).toBeNull(); // the endpoint reports no health score
    expect(s!.tone).toBe('stale');
  });

  it('generates ext- ids for sites outside the canonical union', () => {
    expect(mapCentralSite({ site_name: 'Zebra Kiosk' })!.id).toBe('ext-zebra-kiosk');
  });

  it("carries the caller's sync stamp, and '—' when the plane has never synced", () => {
    // Central's site object has no per-site sync time, so the stamp is the
    // plane's own freshness — never invented per site.
    expect(mapCentralSite(SITE_ROW, '6h')!.sync).toBe('6h');
    expect(mapCentralSite(SITE_ROW)!.sync).toBe('—');
  });

  it('returns null without a site name', () => {
    expect(mapCentralSite({ site_id: 4 })).toBeNull();
  });

  it('maps a v1alpha1 site row (scopeName/deviceCount)', () => {
    const s = mapCentralSite({ scopeName: 'Riverside Clinic', collectionName: 'corp', deviceCount: 7 });
    expect(s).not.toBeNull();
    expect(s!.id).toBe('riverside');
    expect(s!.name).toBe('Riverside Clinic');
    expect(s!.devices).toBe(7);
  });
});

describe('mapCentralClient', () => {
  it('maps a full wireless client row', () => {
    const c = mapCentralClient(CLIENT_ROW);
    expect(c).not.toBeNull();
    expect(c!.name).toBe('laptop-jane');
    expect(c!.type).toBe('laptop');
    expect(c!.mac).toBe('11:22:33:44:55:66');
    expect(c!.medium).toBe('wireless');
    expect(c!.siteId).toBe('campus-01');
    expect(c!.attach).toBe('ap-lobby-01');
    expect(c!.where).toBe('Meridian-Staff');
    expect(c!.vlan).toBe('820');
    expect(c!.role).toBe('staff');
    expect(c!.health).toBe('92');
    expect(c!.healthTone).toBe('success');
    expect(c!.quality).toBe(92);
    expect(c!.problem).toBe(false);
    expect(c!.session).toBe('4h 5m');
    expect(c!.auth).toBe('802.1X');
    expect(c!.plane).toBe('CENTRAL');
  });

  it('tolerates a sparse row: MAC only, everything else defaults', () => {
    const c = mapCentralClient({ macaddr: 'aabb.ccdd.eeff' });
    expect(c).not.toBeNull();
    expect(c!.name).toBe('aabb.ccdd.eeff');
    expect(c!.ip).toBe('pending');
    expect(c!.medium).toBe('wired'); // no ssid/network field → wired
    expect(c!.type).toBe('unknown');
    expect(c!.siteId).toBe('multiple');
    expect(c!.healthTone).toBe('neutral');
    expect(c!.session).toBe('—');
    expect(c!.group).toBe('—');
  });

  it('flags poor health as a problem', () => {
    const c = mapCentralClient({ macaddr: 'x', health: 'poor' });
    expect(c!.healthTone).toBe('warning');
    expect(c!.quality).toBeNull();
    expect(c!.problem).toBe(true);
    const n = mapCentralClient({ macaddr: 'x', health: 31 });
    expect(n!.healthTone).toBe('danger');
    expect(n!.quality).toBe(31);
    expect(n!.problem).toBe(true);
  });

  it('does not turn a text health label into a zero numeric experience score', () => {
    const c = mapCentralClient({ macaddr: 'x', health: 'good' });
    expect(c!.health).toBe('good');
    expect(c!.quality).toBeNull();
    expect(c!.problem).toBe(false);
  });

  it('returns null without a MAC', () => {
    expect(mapCentralClient({ username: 'nobody' })).toBeNull();
  });

  it('accepts the v1alpha1 macAddress spelling instead of discarding the row', () => {
    // Regression: the reader knew macaddr/mac only, so a camelCase clients
    // payload failed the !mac guard on EVERY row — 0 clients, plane healthy.
    const c = mapCentralClient({ macAddress: 'aa:bb:cc:dd:ee:01', hostName: 'jane-laptop' });
    expect(c).not.toBeNull();
    expect(c!.mac).toBe('aa:bb:cc:dd:ee:01');
    expect(c!.name).toBe('jane-laptop');
  });

  it('types a desk handset as voip, not as a mobile phone', () => {
    // Every VoIP vocabulary contains 'phone', so a generic phone test first
    // made the 'voip' bucket unreachable — the Clients type filter could never
    // offer it in live mode.
    expect(mapCentralClient({ mac: 'x', category: 'VoIP Phone', vendor: 'Mitel' })!.type).toBe('voip');
    expect(mapCentralClient({ mac: 'x', function: 'IP Phone' })!.type).toBe('voip');
    expect(mapCentralClient({ mac: 'x', category: 'phone system' })!.type).toBe('voip');
    // …without swallowing the real mobiles or the tablets above them.
    expect(mapCentralClient({ mac: 'x', os: 'iPhone OS 17' })!.type).toBe('phone');
    expect(mapCentralClient({ mac: 'x', os: 'Android 14', category: 'Smartphone' })!.type).toBe('phone');
    expect(mapCentralClient({ mac: 'x', os: 'iPadOS 17' })!.type).toBe('tablet');
    expect(mapCentralClient(CLIENT_ROW)!.type).toBe('laptop');
  });

  it('reads the classic radio facts, not only the v1alpha1 camelCase ones', () => {
    // The classic endpoint is tried FIRST, so band/channel under snake_case
    // spellings left `link` at '—' with the facts on the wire.
    const c = mapCentralClient({
      macaddr: '11:22:33:44:55:66',
      band: '5',
      channel: 36,
      signal_strength: -52,
      signal_db: 41,
      speed: 866,
    });
    expect(c!.link).toBe('5 GHz · ch 36'); // bare values get the design's units
    expect(c!.rssi).toBe('-52 dBm');
    expect(c!.snr).toBe('41 dB');
    expect(c!.tput).toBe('866 Mbps');
    // Nothing reported stays honestly empty rather than becoming '0'.
    const bare = mapCentralClient({ macaddr: '11:22:33:44:55:66' });
    expect(bare!.link).toBe('—');
    expect(bare!.tput).toBe('—');
    expect(bare!.rssi).toBe('—');
  });

  it('maps a v1alpha1 camelCase client row (userName/ipv4/connectedTo/vlanId/…)', () => {
    const c = mapCentralClient({
      mac: 'aa:bb:cc:11:22:33',
      userName: 'jane@corp.example',
      hostName: 'jane-laptop',
      ipv4: '10.42.8.41',
      status: 'Connected',
      health: 88,
      siteName: 'Campus-01 HQ',
      connectedTo: 'ap-lobby-01',
      network: 'Meridian-Staff',
      vlanId: 820,
      authentication: '802.1X',
      role: 'staff',
      modelOs: 'Windows 11',
    });
    expect(c).not.toBeNull();
    expect(c!.name).toBe('jane@corp.example');
    expect(c!.model).toBe('Windows 11');
    expect(c!.type).toBe('laptop');
    expect(c!.ip).toBe('10.42.8.41');
    expect(c!.medium).toBe('wireless'); // network (ssid) present
    expect(c!.siteId).toBe('campus-01');
    expect(c!.attach).toBe('ap-lobby-01');
    expect(c!.where).toBe('Meridian-Staff');
    expect(c!.vlan).toBe('820'); // numeric vlanId stringified
    expect(c!.auth).toBe('802.1X');
    expect(c!.role).toBe('staff');
    expect(c!.health).toBe('88');
    expect(c!.healthTone).toBe('success');
  });

  it('derives the session from connectedSince when no session seconds exist', () => {
    const now = Date.parse('2025-06-21T13:00:00Z');
    const c = mapCentralClient(
      { mac: 'aa:bb:cc:11:22:33', connectedSince: '2025-06-21T10:00:00Z' }, // 3h before now
      now,
    );
    expect(c).not.toBeNull();
    expect(c!.session).toBe('3h 0m');
  });

  it('falls back to keyManagement for auth when authentication is blank', () => {
    const c = mapCentralClient({ mac: 'aa:bb:cc:11:22:33', authentication: '', keyManagement: 'WPA3-SAE' });
    expect(c!.auth).toBe('WPA3-SAE');
    // an explicit auth_method still wins over keyManagement
    const d = mapCentralClient({ mac: 'aa:bb:cc:11:22:33', auth_method: '802.1X', keyManagement: 'WPA2-PSK' });
    expect(d!.auth).toBe('802.1X');
  });

  it('classifies media clients and preserves reported wireless band/channel detail', () => {
    const c = mapCentralClient({
      mac: '24:3f:75:de:21:b7',
      type: 'Wireless',
      category: 'Audio & Video',
      function: 'Media Streaming',
      vendor: 'Roku',
      modelOs: 'Roku TV',
      wirelessBand: '5 GHz',
      wirelessChannel: '149E (80 MHz)',
    });
    expect(c!.model).toBe('Roku TV');
    expect(c!.type).toBe('media');
    expect(c!.link).toBe('5 GHz · 149E (80 MHz)');
  });

  it("trusts the explicit v1alpha1 type field over the ssid/network inference", () => {
    const c = mapCentralClient({ mac: 'aa:bb:cc:11:22:33', type: 'Wired', network: 'Meridian-Staff' });
    expect(c!.medium).toBe('wired'); // the old inference would have said wireless
    const w = mapCentralClient({ mac: 'aa:bb:cc:11:22:33', type: 'Wireless' });
    expect(w!.medium).toBe('wireless');
  });

  it('reads the GA wireless row: SNR, band/channel, SSID and medium — and still says — for what it omits', () => {
    // Live shape from /network-monitoring/v1/clients. The portal claimed SNR
    // was 'not reported by CENTRAL' only because it never called this
    // endpoint; its `type` is the RESOURCE kind, so the medium has to come
    // from clientConnectionType or the whole wireless roster reads 'wired'.
    const now = Date.parse('2026-07-28T15:00:00.000Z');
    const c = mapCentralClient(
      {
        macAddress: '24:3f:75:de:21:b7',
        clientName: '55RokuSelectSeries4KTV',
        type: 'network-monitoring/client-monitoring',
        clientConnectionType: 'Wireless',
        connectedDeviceType: 'AP',
        connectedTo: 'Office-655',
        wlanName: 'aruba-home',
        siteName: 'Campus-01 HQ',
        ipv4: '192.168.1.104',
        vlanId: '200',
        role: 'aruba-home',
        clientOperatingSystem: 'Roku TV',
        clientCategory: 'Audio & Video',
        clientFunction: 'Media Streaming',
        clientVendor: 'Roku',
        clientTags: 'AV,ml-IoT',
        keyManagement: 'WPA2-PSK',
        authenticationType: '',
        wirelessBand: '5 GHz',
        wirelessChannel: '149E (80 MHz)',
        snr: 48,
        connectedAt: '2026-07-28T13:00:00.000Z',
        status: 'Connected',
      },
      now,
    );
    expect(c!.medium).toBe('wireless');
    expect(c!.snr).toBe('48 dB');
    expect(c!.link).toBe('5 GHz · 149E (80 MHz)');
    expect(c!.where).toBe('aruba-home');
    expect(c!.attach).toBe('Office-655');
    expect(c!.name).toBe('55RokuSelectSeries4KTV');
    expect(c!.model).toBe('Roku TV');
    expect(c!.type).toBe('media');
    expect(c!.auth).toBe('WPA2-PSK');
    expect(c!.vlan).toBe('200');
    expect(c!.session).toBe('2h 0m');
    // Honesty: the GA payload carries no signal strength, retry, rate or roam
    // counters, so those stay '—' rather than being invented from the SNR.
    expect(c!.rssi).toBe('—');
    expect(c!.retries).toBe('—');
    expect(c!.tput).toBe('—');
    expect(c!.roams).toBe('—');
  });

  it('reads GA wired rows as wired and keeps their null SNR as —', () => {
    const c = mapCentralClient({
      macAddress: '00:0b:86:b8:c4:b8',
      type: 'network-monitoring/client-monitoring',
      clientConnectionType: 'Wired',
      connectedTo: 'CX6300-CORE',
      port: '1/1/17',
      snr: null,
    });
    expect(c!.medium).toBe('wired');
    expect(c!.snr).toBe('—');
    expect(c!.where).toBe('1/1/17');
  });

  it('maps Central clientFunction/clientCategory into the type vocabulary, without forcing the ones that do not fit', () => {
    const ga = (fields: Record<string, unknown>) =>
      mapCentralClient({ macAddress: 'aa:bb:cc:dd:ee:01', ...fields })!.type;
    // 'Video Surveillance' contains 'video' — the media test would have
    // claimed a security camera before the imaging test ever ran.
    expect(ga({ clientFunction: 'Video Surveillance', clientCategory: 'Public Safety' })).toBe('imaging');
    expect(ga({ clientFunction: 'E-Reader', clientOperatingSystem: 'Kindle' })).toBe('tablet');
    expect(ga({ clientFunction: 'Television Sets', clientCategory: 'Audio & Video' })).toBe('media');
    expect(ga({ clientFunction: 'Gaming Platform' })).toBe('media');
    expect(ga({ clientFunction: 'Home Automation', clientCategory: 'Smart Home' })).toBe('building');
    expect(ga({ clientFunction: 'Energy Monitoring', clientOperatingSystem: 'Energy Detective' })).toBe('building');
    expect(ga({ clientCategory: 'IoT Connectivity', clientVendor: 'Espressif' })).toBe('building');
    expect(ga({ clientFunction: 'Printer', clientOperatingSystem: 'Canon Printer' })).toBe('printer');
    // No honest bucket exists for an uplinked switch seen as a client, and
    // 'Unclassified' is the plane saying it does not know — both stay unknown
    // instead of being filed under a type the plane never claimed.
    expect(ga({ clientFunction: 'Network Switching', clientCategory: 'Network Infrastructure' })).toBe('unknown');
    expect(ga({ clientFunction: 'Unclassified', clientCategory: 'Unclassified' })).toBe('unknown');
  });
});

describe('mapCentralNotification', () => {
  it('maps severity, site, device and relative age', () => {
    const now = 1_753_000_000_000 + 10 * 60_000; // 10m after the event
    const a = mapCentralNotification(NOTIFICATION_ROW, now);
    expect(a).not.toBeNull();
    expect(a!.sev).toBe('P1');
    expect(a!.tone).toBe('danger');
    expect(a!.title).toBe('AP disconnected');
    expect(a!.siteId).toBe('riverside');
    expect(a!.state).toBe('open');
    expect(a!.age).toBe('10m');
    expect(a!.device).toBe('ap-riv-01');
    expect(a!.plane).toBe('CENTRAL');
  });

  it('maps acknowledgement state variants', () => {
    expect(mapCentralNotification({ ...NOTIFICATION_ROW, state: 'acknowledged' })!.state).toBe('acked');
    expect(mapCentralNotification({ ...NOTIFICATION_ROW, state: 'active', is_ack: true })!.state).toBe('acked');
  });

  it('maps v1alpha1 cleared/resolved statuses to cleared, keeps Open open', () => {
    // live /network-notifications/v1/alerts rows: status:'Cleared' on cleared alerts
    expect(mapCentralNotification({ ...NOTIFICATION_ROW, state: undefined, status: 'Cleared' })!.state).toBe('cleared');
    expect(mapCentralNotification({ ...NOTIFICATION_ROW, state: undefined, status: 'Resolved' })!.state).toBe('cleared');
    expect(mapCentralNotification({ ...NOTIFICATION_ROW, state: undefined, status: 'Open' })!.state).toBe('open');
  });

  it('returns null for empty rows', () => {
    expect(mapCentralNotification({ severity: 'Critical' })).toBeNull();
  });

  it('maps a v1alpha1 alert row (name/summary/createdAt/key)', () => {
    const now = Date.parse('2025-06-21T10:10:00Z');
    const a = mapCentralNotification(
      {
        name: 'AP disconnected',
        summary: 'ap-lobby-01 lost contact with the controller',
        severity: 'Critical',
        status: 'Open',
        siteName: 'Riverside Clinic',
        createdAt: '2025-06-21T10:00:00Z', // ISO string
        key: 'alert-key-1',
        id: 'alert-1',
      },
      now,
    );
    expect(a).not.toBeNull();
    expect(a!.title).toBe('AP disconnected');
    expect(a!.detail).toBe('ap-lobby-01 lost contact with the controller');
    expect(a!.sev).toBe('P1');
    expect(a!.siteId).toBe('riverside');
    expect(a!.state).toBe('open');
    expect(a!.age).toBe('10m');
    expect(a!.alertId).toBe('alert-1');
  });

  it("parses the device name from a leading 'Device <name>' summary when no field carries it", () => {
    // v1alpha1 rows have no device-name field; the summary embeds it.
    const parsed = mapCentralNotification({
      name: 'Config Out of Sync',
      summary: 'Device LR655 configuration is out of sync with the group template',
      severity: 'Major',
      status: 'Open',
    });
    expect(parsed!.device).toBe('LR655');

    // A summary that does not lead with 'Device ' stays honestly unnamed.
    const unnamed = mapCentralNotification({
      name: 'Config Out of Sync',
      summary: 'LR655 configuration is out of sync',
      severity: 'Major',
      status: 'Open',
    });
    expect(unnamed!.device).toBe('');

    // A real device field always wins over the summary parse.
    const field = mapCentralNotification({
      name: 'Config Out of Sync',
      summary: 'Device LR655 configuration is out of sync',
      device_name: 'sw-core-a',
      severity: 'Major',
      status: 'Open',
    });
    expect(field!.device).toBe('sw-core-a');
  });
});

// -- pull() with an in-memory fake fetch (no network) ------------------------------

type HandlerResult = { status?: number; body?: unknown; headers?: Record<string, string> };
type Handler = (method: string, pathname: string, query: URLSearchParams) => HandlerResult | undefined;

function fakeFetch(handler: Handler): { fn: FetchLike; calls: string[] } {
  const calls: string[] = [];
  const fn: FetchLike = async (url, init) => {
    const u = new URL(url);
    const method = (init?.method as string | undefined) ?? 'GET';
    calls.push(`${method} ${u.pathname}${u.search}`);
    const result = handler(method, u.pathname, u.searchParams);
    if (!result) {
      return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify(result.body ?? {}), {
      status: result.status ?? 200,
      headers: { 'content-type': 'application/json', ...(result.headers ?? {}) },
    });
  };
  return { fn, calls };
}

function makeState(): PlaneState {
  return { id: 'central', linked: true, health: 'warning', lastSync: null, deviceCount: null, callsToday: 0, note: null };
}

const CREDS = { gatewayBaseUrl: 'https://apigw-prod2.central.arubanetworks.com', clientId: 'id-1', clientSecret: 'shh-secret' };

function makeAdapter(handler: Handler) {
  const { fn, calls } = fakeFetch(handler);
  const recorded: { path: string; ms: number; code: string }[] = [];
  const state = makeState();
  // Sleeps are recorded, never awaited for real — backoff and page pacing are
  // asserted on the requested delays, so the suite stays instant.
  const slept: number[] = [];
  const adapter = new CentralAdapter(CREDS, state, (c) => recorded.push(c), fn, async (ms) => {
    slept.push(ms);
  });
  return { adapter, state, recorded, calls, slept };
}

const HAPPY_ROUTES: Record<string, unknown> = {
  'POST /oauth2/token': { access_token: 'tok-1', expires_in: 7200 },
  'GET /monitoring/v1/aps': { aps: [AP_ROW], total: 1 },
  'GET /monitoring/v1/switches': { switches: [SWITCH_ROW], total: 1 },
  'GET /monitoring/v1/gateways': { gateways: [], total: 0 },
  'GET /central/v2/sites': { sites: [SITE_ROW], total: 1 },
  'GET /monitoring/v1/clients': { clients: [CLIENT_ROW], total: 1 },
  'GET /central/v1/notifications': { notifications: [NOTIFICATION_ROW], total: 1 },
};

function routeHandler(routes: Record<string, unknown>): Handler {
  return (method, pathname) => {
    const body = routes[`${method} ${pathname}`];
    return body === undefined ? undefined : { body };
  };
}

describe('CentralAdapter.pull()', () => {
  it('pulls every section, maps it, and reports the summary note', async () => {
    const { adapter, state, recorded } = makeAdapter(routeHandler(HAPPY_ROUTES));
    const pull = await adapter.pull();
    expect(pull.devices).toHaveLength(2); // ap + switch
    expect(pull.sites).toHaveLength(1);
    expect(pull.clients).toHaveLength(1);
    expect(pull.alerts).toHaveLength(1);
    expect(pull.devices![0].name).toBe('ap-lobby-01');
    // Regression: .map(mapFn) must not leak the array index into
    // mapCentralNotification's nowMs param — that zeroed every age.
    expect(pull.alerts![0].age).not.toBe('0s');
    expect(pull.alerts![0].age).toMatch(/^\d+[smhd]$/);
    expect(state.note).toBe('2 devices · 1 sites · 1 clients');
    expect(state.health).toBe('healthy'); // promoted from 'warning' on first success
    // secrets never appear in the recorded call log
    expect(JSON.stringify(recorded)).not.toContain('shh-secret');
    expect(recorded.some((c) => c.path === 'POST /oauth2/token' && c.code === '200')).toBe(true);
  });

  it('publishes the minted credential expiry on plane state (never the token)', async () => {
    // The registry can only publish HOW a credential is obtained; only the
    // adapter's token manager learns WHEN it dies, so the Systems 'Token' fact
    // read 'no expiry published' for every OAuth plane.
    const { adapter, state } = makeAdapter(routeHandler(HAPPY_ROUTES));
    const before = Date.now();
    await adapter.pull();
    expect(state.token?.source).toBe('oauth client_credentials');
    const expiresAt = Date.parse(state.token!.expiresAt!);
    expect(expiresAt).toBeGreaterThanOrEqual(before + 7200 * 1000);
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + 7200 * 1000);
    // SECURITY: PlaneState is served unmasked — expiry + label only.
    expect(JSON.stringify(state.token)).not.toContain('tok-1');
    expect(JSON.stringify(state.token)).not.toContain('shh-secret');
  });

  it('a token answer without expires_in publishes no expiry rather than the pacing default', async () => {
    const routes = { ...HAPPY_ROUTES, 'POST /oauth2/token': { access_token: 'tok-1' } };
    const { adapter, state } = makeAdapter(routeHandler(routes));
    await adapter.pull();
    expect(state.token).toEqual({ expiresAt: null, source: 'oauth client_credentials' });
  });

  it('caches the token across pulls (one token fetch for two pulls)', async () => {
    const { adapter, calls } = makeAdapter(routeHandler(HAPPY_ROUTES));
    await adapter.pull();
    await adapter.pull();
    expect(calls.filter((c) => c.startsWith('POST /oauth2/token'))).toHaveLength(1);
  });

  it('tolerates a 404 candidate by falling back to the alternate namespace', async () => {
    const routes = { ...HAPPY_ROUTES };
    delete routes['GET /monitoring/v1/aps'];
    routes['GET /network-monitoring/v1alpha1/aps'] = { aps: [AP_ROW], total: 1 };
    const { adapter, calls } = makeAdapter(routeHandler(routes));
    const pull = await adapter.pull();
    expect(pull.devices!.some((d) => d.name === 'ap-lobby-01')).toBe(true);
    expect(calls.some((c) => c.startsWith('GET /monitoring/v1/aps'))).toBe(true); // tried, 404
    expect(calls.some((c) => c.startsWith('GET /network-monitoring/v1alpha1/aps'))).toBe(true); // fallback worked
  });

  it('fails the pull naming the section when every inventory endpoint 404s', async () => {
    const routes = { ...HAPPY_ROUTES };
    delete routes['GET /monitoring/v1/aps'];
    delete routes['GET /monitoring/v1/switches'];
    delete routes['GET /monitoring/v1/gateways'];
    const { adapter } = makeAdapter(routeHandler(routes));
    await expect(adapter.pull()).rejects.toThrow(/section 'devices' failed/);
  });

  it('fails the pull naming the section on a non-404 error', async () => {
    const { adapter } = makeAdapter((method, pathname) => {
      if (method === 'GET' && pathname.startsWith('/central/v') && pathname.endsWith('/sites')) {
        return { status: 500, body: { error: 'boom' } };
      }
      const body = HAPPY_ROUTES[`${method} ${pathname}`];
      return body === undefined ? undefined : { body };
    });
    await expect(adapter.pull()).rejects.toThrow(/section 'sites' failed/);
  });

  it('missing notifications section → the key is omitted with a note, not a failure', async () => {
    const routes = { ...HAPPY_ROUTES };
    delete routes['GET /central/v1/notifications'];
    const { adapter, state } = makeAdapter(routeHandler(routes));
    const pull = await adapter.pull();
    // Omitted, NOT []: an empty array is an authoritative "no alerts", which is
    // a claim about a dataset that never answered. Undefined = unknown, which
    // is what datasetReported()/lastSyncFor() need to see.
    expect(pull.alerts).toBeUndefined();
    expect('alerts' in pull).toBe(false);
    expect(pull.devices).toHaveLength(2); // the sections that did answer still ship
    expect(state.note).toContain('not available: notifications');
  });

  it('a missing section holds the plane at warning and never claims a zero count', async () => {
    const routes = { ...HAPPY_ROUTES };
    delete routes['GET /monitoring/v1/clients'];
    const { adapter, state } = makeAdapter(routeHandler(routes));
    const pull = await adapter.pull();
    expect(pull.clients).toBeUndefined();
    // '0 clients' would be an assertion of fact about data we could not read.
    expect(state.note).not.toContain('clients ·');
    expect(state.note).not.toContain('0 clients');
    expect(state.note).toContain('not available: clients');
    // Not promoted to 'healthy': a partial read is not a complete sync.
    expect(state.health).toBe('warning');
  });

  it('paginates until the reported total is covered', async () => {
    const manyAps = Array.from({ length: 201 }, (_, i) => ({ ...AP_ROW, name: `ap-${i}`, serial: `SN${i}` }));
    const { adapter, calls } = makeAdapter((method, pathname, query) => {
      if (method === 'GET' && pathname === '/monitoring/v1/aps') {
        const offset = Number(query.get('offset') ?? 0);
        const limit = Number(query.get('limit') ?? 200);
        return { body: { aps: manyAps.slice(offset, offset + limit), total: manyAps.length } };
      }
      const body = HAPPY_ROUTES[`${method} ${pathname}`];
      return body === undefined ? undefined : { body };
    });
    const pull = await adapter.pull();
    expect(pull.devices!.filter((d) => d.type === 'ap')).toHaveLength(201);
    expect(calls.some((c) => c.includes('offset=0'))).toBe(true);
    expect(calls.some((c) => c.includes('offset=200'))).toBe(true);
  });

  it('keeps paging when the payload reports `count` (rows in THIS response), not `total`', async () => {
    // Regression: `count` was read as the grand total, so page 1 of a full
    // 500-row client response set total=500, offset=500, and 500 < 500 exited
    // the loop — 4,982 clients silently truncated to the first page.
    const manyClients = Array.from({ length: 1_100 }, (_, i) => ({
      macaddr: `aa:bb:cc:00:${String(Math.floor(i / 256)).padStart(2, '0')}:${String(i % 256).padStart(2, '0')}`,
      username: `user-${i}`,
      site: 'Campus-01 HQ',
    }));
    const { adapter, state, calls } = makeAdapter((method, pathname, query) => {
      if (method === 'GET' && pathname === '/monitoring/v1/clients') {
        const offset = Number(query.get('offset') ?? 0);
        const limit = Number(query.get('limit') ?? 500);
        const page = manyClients.slice(offset, offset + limit);
        return { body: { clients: page, count: page.length } }; // no `total` key at all
      }
      const body = HAPPY_ROUTES[`${method} ${pathname}`];
      return body === undefined ? undefined : { body };
    });
    const pull = await adapter.pull();
    expect(pull.clients).toHaveLength(1_100);
    expect(calls.some((c) => c.includes('/clients?offset=500'))).toBe(true);
    expect(calls.some((c) => c.includes('/clients?offset=1000'))).toBe(true);
    expect(state.note).toContain('1,100 clients');
    expect(state.note).not.toContain('truncated');
  });

  it('paces the pages of a section instead of bursting them', async () => {
    const manyAps = Array.from({ length: 401 }, (_, i) => ({ ...AP_ROW, name: `ap-${i}`, serial: `SN${i}` }));
    const { adapter, slept } = makeAdapter((method, pathname, query) => {
      if (method === 'GET' && pathname === '/monitoring/v1/aps') {
        const offset = Number(query.get('offset') ?? 0);
        return { body: { aps: manyAps.slice(offset, offset + 200), total: manyAps.length } };
      }
      const body = HAPPY_ROUTES[`${method} ${pathname}`];
      return body === undefined ? undefined : { body };
    });
    await adapter.pull();
    // Three pages → two follow-up requests, each preceded by a pacing delay.
    expect(slept.filter((ms) => ms === 150)).toHaveLength(2);
  });

  it('reports truncation when the page cap cuts a still-full walk short', async () => {
    // notifications caps at 5 pages x 100; a tenant with more must not present
    // the first 500 as the whole alert queue without saying so.
    const manyAlerts = Array.from({ length: 900 }, (_, i) => ({
      ...NOTIFICATION_ROW,
      id: `alert-${i}`,
    }));
    const { adapter, state } = makeAdapter((method, pathname, query) => {
      if (method === 'GET' && pathname === '/central/v1/notifications') {
        const offset = Number(query.get('offset') ?? 0);
        return { body: { notifications: manyAlerts.slice(offset, offset + 100) } };
      }
      const body = HAPPY_ROUTES[`${method} ${pathname}`];
      return body === undefined ? undefined : { body };
    });
    const pull = await adapter.pull();
    expect(pull.alerts).toHaveLength(500); // 5 pages, the cap
    expect(state.note).toContain('truncated: notifications');
    expect(state.health).toBe('warning'); // an incomplete read never stamps healthy
  });

  it('reports truncation when the endpoint hands over fewer rows than its own total', async () => {
    const routes = {
      ...HAPPY_ROUTES,
      'GET /central/v2/sites': { sites: [SITE_ROW], total: 12 }, // claims 12, gives 1
    };
    const { adapter, state } = makeAdapter(routeHandler(routes));
    const pull = await adapter.pull();
    expect(pull.sites).toHaveLength(1);
    expect(state.note).toContain('truncated: sites');
    expect(state.health).toBe('warning');
  });

  it('backs off and retries on 429, honouring Retry-After, instead of failing the pull', async () => {
    let apsCalls = 0;
    const { adapter, state, recorded, slept } = makeAdapter((method, pathname) => {
      if (method === 'GET' && pathname === '/monitoring/v1/aps') {
        apsCalls += 1;
        if (apsCalls <= 2) return { status: 429, body: {}, headers: { 'retry-after': '2' } };
      }
      const body = HAPPY_ROUTES[`${method} ${pathname}`];
      return body === undefined ? undefined : { body };
    });
    const pull = await adapter.pull();
    expect(pull.devices!.some((d) => d.name === 'ap-lobby-01')).toBe(true);
    expect(apsCalls).toBe(3); // two 429s, then the real answer
    expect(slept.filter((ms) => ms === 2_000)).toHaveLength(2); // Retry-After wins over the floor
    // README: the real 429s stay visible in the Activity tab.
    expect(recorded.filter((c) => c.code === '429')).toHaveLength(2);
    expect(state.health).toBe('healthy'); // a survived rate limit is not a failed sync
  });

  it('gives up after the bounded 429 retries and fails the section honestly', async () => {
    const { adapter, slept } = makeAdapter((method, pathname) => {
      if (method === 'GET' && pathname === '/monitoring/v1/aps') return { status: 429, body: {} };
      const body = HAPPY_ROUTES[`${method} ${pathname}`];
      return body === undefined ? undefined : { body };
    });
    await expect(adapter.pull()).rejects.toThrow(/section 'devices\/aps' failed.*429/);
    // Exponential floor when no Retry-After header is offered: 1s, 2s, 4s.
    expect(slept).toEqual([1_000, 2_000, 4_000]);
  });

  it('prefers the well-known payload key over an incidental array', async () => {
    // `{errors: [], aps: [...]}` — the first-array heuristic alone would zero the section.
    const routes = { ...HAPPY_ROUTES, 'GET /monitoring/v1/aps': { errors: [], aps: [AP_ROW], total: 1 } };
    const { adapter } = makeAdapter(routeHandler(routes));
    const pull = await adapter.pull();
    expect(pull.devices!.some((d) => d.name === 'ap-lobby-01')).toBe(true);
  });

  it('reads the /network-notifications/v1/alerts payload key instead of the first array', async () => {
    // The third notifications candidate returns its rows under `alerts`; with
    // that key unknown the heuristic returned `filters: []` — zero alerts, no
    // error, plane healthy.
    const routes = { ...HAPPY_ROUTES };
    delete routes['GET /central/v1/notifications'];
    routes['GET /network-notifications/v1/alerts'] = { count: 1, filters: [], alerts: [NOTIFICATION_ROW] };
    const { adapter, state } = makeAdapter(routeHandler(routes));
    const pull = await adapter.pull();
    expect(pull.alerts).toHaveLength(1);
    expect(pull.alerts![0].title).toBe('AP disconnected');
    expect(state.note).not.toContain('not available');
  });

  it("stamps site rows with the plane's own freshness once it has synced", async () => {
    const { adapter, state } = makeAdapter(routeHandler(HAPPY_ROUTES));
    // Cycle 1: the poller has not stamped lastSync yet, so '—' is honest.
    expect((await adapter.pull()).sites![0].sync).toBe('—');
    state.lastSync = new Date(Date.now() - 6 * 3600_000).toISOString();
    // Cycle 2 reports the previous successful read — what "Last sync" means.
    expect((await adapter.pull()).sites![0].sync).toBe('6h');
  });

  it('names every dataset it could not read in full so the registry can hold warning', async () => {
    const routes = { ...HAPPY_ROUTES };
    delete routes['GET /monitoring/v1/clients'];
    routes['GET /central/v2/sites'] = { sites: [SITE_ROW], total: 12 }; // claims 12, gives 1
    const { adapter } = makeAdapter(routeHandler(routes));
    const pull = await adapter.pull();
    // 'clients' could not be read at all; 'sites' was read but not in full —
    // omission alone cannot express the second, which is what partial is for.
    expect(pull.partial).toEqual(expect.arrayContaining(['clients', 'sites']));
    expect(pull.partial).not.toContain('devices');
  });

  it('claims brokered write but no shell: cloud-claimed devices get no portal shell', async () => {
    const { adapter, state } = makeAdapter(routeHandler(HAPPY_ROUTES));
    expect(adapter.capabilities()).toEqual({ localShell: false, brokeredWrite: true, configRead: false });
    expect(state.capabilities).toEqual({ localShell: false, brokeredWrite: true, configRead: false });
  });

  it('retries a transport failure on one page instead of losing the whole cycle', async () => {
    let apsCalls = 0;
    const { fn, calls } = fakeFetch(routeHandler(HAPPY_ROUTES));
    const recorded: { path: string; ms: number; code: string }[] = [];
    const state = makeState();
    const slept: number[] = [];
    const flaky: FetchLike = async (url, init) => {
      if (String(url).includes('/monitoring/v1/aps')) {
        apsCalls += 1;
        if (apsCalls === 1) throw new Error('The operation was aborted due to timeout');
      }
      return fn(url, init);
    };
    const adapter = new CentralAdapter(CREDS, state, (c) => recorded.push(c), flaky, async (ms) => {
      slept.push(ms);
    });
    const pull = await adapter.pull();
    expect(pull.devices!.some((d) => d.name === 'ap-lobby-01')).toBe(true);
    expect(apsCalls).toBe(2); // aborted once, retried once, then answered
    // The failed attempt still shows up in the Activity tab.
    expect(recorded.some((c) => c.code === 'network-error')).toBe(true);
    expect(calls.length).toBeGreaterThan(0);
  });

  it('gives up after the bounded transport retry rather than retrying forever', async () => {
    const state = makeState();
    let apsCalls = 0;
    const { fn } = fakeFetch(routeHandler(HAPPY_ROUTES));
    const adapter = new CentralAdapter(
      CREDS,
      state,
      () => {},
      async (url, init) => {
        if (String(url).includes('/monitoring/v1/aps')) {
          apsCalls += 1;
          throw new Error('ECONNRESET');
        }
        return fn(url, init);
      },
      async () => {},
    );
    await expect(adapter.pull()).rejects.toThrow(/section 'devices\/aps' failed/);
    expect(apsCalls).toBe(2); // the first try plus exactly one retry
  });

  it('retries once with a fresh token on 401', async () => {
    let tokenFetches = 0;
    let aps401 = true;
    const { adapter } = makeAdapter((method, pathname) => {
      if (method === 'POST' && pathname === '/oauth2/token') {
        tokenFetches += 1;
        return { body: { access_token: `tok-${tokenFetches}`, expires_in: 7200 } };
      }
      if (method === 'GET' && pathname === '/monitoring/v1/aps' && aps401) {
        aps401 = false;
        return { status: 401, body: { error: 'expired' } };
      }
      const body = HAPPY_ROUTES[`${method} ${pathname}`];
      return body === undefined ? undefined : { body };
    });
    const pull = await adapter.pull();
    expect(pull.devices!.some((d) => d.name === 'ap-lobby-01')).toBe(true);
    expect(tokenFetches).toBe(2);
  });

  it('falls back to v1alpha1 clients without leaking the classic-only calculate_total param', async () => {
    const routes = { ...HAPPY_ROUTES };
    delete routes['GET /monitoring/v1/clients'];
    routes['GET /network-monitoring/v1alpha1/clients'] = {
      items: [{ mac: 'aa:bb:cc:11:22:33', userName: 'jane@corp.example', siteName: 'Campus-01 HQ' }],
      total: 1,
      count: 1,
      next: 1,
    };
    const { adapter, calls } = makeAdapter(routeHandler(routes));
    const pull = await adapter.pull();
    expect(pull.clients).toHaveLength(1);
    expect(pull.clients![0].name).toBe('jane@corp.example');
    const classic = calls.filter((c) => c.startsWith('GET /monitoring/v1/clients'));
    expect(classic.some((c) => c.includes('calculate_total=true'))).toBe(true); // classic keeps it
    const v1a = calls.filter((c) => c.startsWith('GET /network-monitoring/v1alpha1/clients'));
    expect(v1a.length).toBeGreaterThan(0);
    expect(v1a.every((c) => !c.includes('calculate_total'))).toBe(true); // never leaks (v1alpha1 400s on it)
  });

  it('prefers the GA clients endpoint, which is the one that reports SNR', async () => {
    const routes = { ...HAPPY_ROUTES };
    routes['GET /network-monitoring/v1/clients'] = {
      items: [
        {
          macAddress: '24:3f:75:de:21:b7',
          clientName: 'roku-lobby',
          clientConnectionType: 'Wireless',
          wlanName: 'Meridian-Staff',
          siteName: 'Campus-01 HQ',
          snr: 48,
        },
      ],
      total: 1,
      count: 1,
      next: null,
    };
    // Same tenant, alpha shape: no snr at all. Reaching for it would put a '—'
    // on the wire for a field Central DOES report.
    routes['GET /network-monitoring/v1alpha1/clients'] = {
      items: [{ macAddress: '24:3f:75:de:21:b7', hostName: 'roku-lobby', siteName: 'Campus-01 HQ' }],
      total: 1,
      count: 1,
    };
    const { adapter, calls } = makeAdapter(routeHandler(routes));
    const pull = await adapter.pull();
    expect(pull.clients).toHaveLength(1);
    expect(pull.clients![0].snr).toBe('48 dB');
    const ga = calls.filter((c) => c.startsWith('GET /network-monitoring/v1/clients'));
    expect(ga.length).toBeGreaterThan(0);
    expect(ga.every((c) => !c.includes('calculate_total'))).toBe(true); // classic-only param never leaks
    expect(calls.some((c) => c.startsWith('GET /network-monitoring/v1alpha1/clients'))).toBe(false);
  });

  it('walks the GA clients endpoint on its `next` cursor, not on offset', async () => {
    // The GA endpoint IGNORES offset — verified against a live tenant:
    // '?offset=2&limit=2' hands back page ONE again. Paging it the offset way
    // re-reads the first page forever and silently drops every client past it.
    const manyClients = Array.from({ length: 1_100 }, (_, i) => ({
      macAddress: `aa:bb:cc:00:${String(Math.floor(i / 256)).padStart(2, '0')}:${String(i % 256).padStart(2, '0')}`,
      clientName: `client-${i}`,
      clientConnectionType: 'Wireless',
      siteName: 'Campus-01 HQ',
    }));
    const { adapter, state, calls } = makeAdapter((method, pathname, query) => {
      if (method === 'GET' && pathname === '/network-monitoring/v1/clients') {
        const limit = Number(query.get('limit') ?? 500);
        // Cursor semantics as the tenant implements them: page 1 when absent,
        // and offset is not consulted at all.
        const page = Number(query.get('next') ?? 1);
        const items = manyClients.slice((page - 1) * limit, (page - 1) * limit + limit);
        const done = (page - 1) * limit + items.length >= manyClients.length;
        return { body: { items, total: manyClients.length, count: items.length, next: done ? null : String(page + 1) } };
      }
      const body = HAPPY_ROUTES[`${method} ${pathname}`];
      return body === undefined ? undefined : { body };
    });
    const pull = await adapter.pull();
    expect(pull.clients).toHaveLength(1_100);
    const clientCalls = calls.filter((c) => c.startsWith('GET /network-monitoring/v1/clients'));
    expect(clientCalls).toHaveLength(3); // 500 + 500 + 100
    expect(clientCalls.every((c) => !c.includes('offset='))).toBe(true);
    expect(clientCalls.some((c) => c.includes('next=2'))).toBe(true);
    expect(clientCalls.some((c) => c.includes('next=3'))).toBe(true);
    expect(state.note).toContain('1,100 clients');
    expect(state.note).not.toContain('truncated');
  });

  it('reports truncation when the GA cursor walk is cut short by the page cap', async () => {
    // A cursor still outstanding at the page cap is exactly the silent loss
    // the offset walk reports — it must not present a partial roster as whole.
    const { adapter, state } = makeAdapter((method, pathname) => {
      if (method === 'GET' && pathname === '/network-monitoring/v1/clients') {
        const items = Array.from({ length: 500 }, (_, i) => ({
          macAddress: `aa:bb:cc:11:${String(i % 256).padStart(2, '0')}:${String(Math.floor(i / 256)).padStart(2, '0')}`,
          siteName: 'Campus-01 HQ',
        }));
        return { body: { items, count: items.length, next: 'more' } }; // never says stop
      }
      const body = HAPPY_ROUTES[`${method} ${pathname}`];
      return body === undefined ? undefined : { body };
    });
    await adapter.pull();
    expect(state.note).toContain('truncated: clients');
    expect(state.health).toBe('warning'); // an incomplete read never stamps healthy
  });

  it('pull-level: v1alpha1 clients get a real session from connectedSince, not —', async () => {
    const routes = { ...HAPPY_ROUTES };
    delete routes['GET /monitoring/v1/clients'];
    routes['GET /network-monitoring/v1alpha1/clients'] = {
      items: [
        {
          mac: 'aa:bb:cc:11:22:33',
          userName: 'jane@corp.example',
          siteName: 'Campus-01 HQ',
          connectedSince: new Date(Date.now() - 3 * 3600_000).toISOString(), // 3h ago
        },
      ],
      total: 1,
      count: 1,
    };
    const { adapter } = makeAdapter(routeHandler(routes));
    const pull = await adapter.pull();
    expect(pull.clients).toHaveLength(1);
    expect(pull.clients![0].session).not.toBe('—');
    expect(pull.clients![0].session).toBe('3h 0m');
  });
});

// -- token endpoint selection: new-Central gateway → GreenLake SSO -------------

describe('token endpoint selection (devhub new-central)', () => {
  const NEW_CREDS = { gatewayBaseUrl: 'https://us1.api.central.arubanetworks.com', clientId: 'id-1', clientSecret: 'shh-secret' };

  it('classifies gateway host shapes', () => {
    expect(isNewCentralGateway('https://us1.api.central.arubanetworks.com')).toBe(true);
    expect(isNewCentralGateway('https://internal.api.central.arubanetworks.com')).toBe(true);
    expect(isNewCentralGateway('https://cn1.api.central.arubanetworks.com.cn')).toBe(true);
    expect(isNewCentralGateway('https://apigw-prod2.central.arubanetworks.com')).toBe(false);
    expect(isNewCentralGateway('https://api-ap.central.arubanetworks.com')).toBe(false);
  });

  /** Records {url, method, contentType} so assertions can see host + encoding. */
  function hostRecordingFetch(handler: (method: string, host: string, pathname: string) => HandlerResult | undefined) {
    const calls: Array<{ url: string; method: string; contentType: string | null }> = [];
    const fn: FetchLike = async (url, init) => {
      const u = new URL(url);
      const method = (init?.method as string | undefined) ?? 'GET';
      calls.push({
        url,
        method,
        contentType: ((init?.headers as Record<string, string> | undefined)?.['content-type']) ?? null,
      });
      const result = handler(method, u.host, u.pathname);
      if (!result) return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } });
      return new Response(JSON.stringify(result.body ?? {}), {
        status: result.status ?? 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    return { fn, calls };
  }

  function makeHostAdapter(creds: typeof NEW_CREDS, handler: (m: string, h: string, p: string) => HandlerResult | undefined) {
    const { fn, calls } = hostRecordingFetch(handler);
    const adapter = new CentralAdapter(creds, makeState(), () => {}, fn);
    return { adapter, calls };
  }

  const happy = (method: string, _host: string, pathname: string): HandlerResult | undefined => {
    if (method === 'POST' && pathname === '/as/token.oauth2') return { body: { access_token: 'tok-gl', expires_in: 7200 } };
    const body = HAPPY_ROUTES[`${method} ${pathname}`];
    return body === undefined ? undefined : { body };
  };

  it('a new-Central gateway mints its token on GreenLake SSO, form-encoded', async () => {
    const { adapter, calls } = makeHostAdapter(NEW_CREDS, happy);
    await adapter.pull();
    expect(calls[0].url).toBe(GREENLAKE_CCS_TOKEN_URL);
    expect(calls[0].contentType).toBe('application/x-www-form-urlencoded');
    expect(calls.some((c) => c.url.endsWith('/oauth2/token'))).toBe(false);
  });

  it('a classic gateway keeps its own /oauth2/token, JSON-encoded', async () => {
    const { adapter, calls } = makeHostAdapter(CREDS, happy);
    await adapter.pull();
    expect(calls[0].url).toBe(`${CREDS.gatewayBaseUrl}/oauth2/token`);
    expect(calls[0].contentType).toBe('application/json');
  });

  it('falls back across generations on a 404', async () => {
    const { adapter, calls } = makeHostAdapter(NEW_CREDS, (method, host, pathname) => {
      if (method === 'POST' && pathname === '/as/token.oauth2') return { status: 404, body: {} };
      return happy(method, host, pathname);
    });
    await adapter.pull();
    const tokenCalls = calls.filter((c) => c.method === 'POST' && (c.url.endsWith('/oauth2/token') || c.url.endsWith('/as/token.oauth2')));
    expect(tokenCalls.map((c) => c.url)).toEqual([GREENLAKE_CCS_TOKEN_URL, `${NEW_CREDS.gatewayBaseUrl}/oauth2/token`]);
  });

  it('remembers the resolved token endpoint — no re-probe on the next auth', async () => {
    const { adapter, calls } = makeHostAdapter(NEW_CREDS, (method, host, pathname) => {
      if (method === 'POST' && pathname === '/as/token.oauth2') return { status: 404, body: {} };
      if (method === 'POST' && pathname === '/oauth2/token') {
        // expires_in == refresh margin → born stale: every pull re-authenticates,
        // so the second pull proves which endpoint is tried first.
        return { body: { access_token: 'tok-gw', expires_in: 60 } };
      }
      return happy(method, host, pathname);
    });
    await adapter.pull(); // resolves gateway /oauth2/token after the SSO 404
    calls.length = 0;
    await adapter.pull();
    expect(calls[0].url).toBe(`${NEW_CREDS.gatewayBaseUrl}/oauth2/token`);
    expect(calls.some((c) => c.url === GREENLAKE_CCS_TOKEN_URL)).toBe(false);
  });

  it('a 400 from the SSO is bad credentials — no fall-through, honest error', async () => {
    const { adapter, calls } = makeHostAdapter(NEW_CREDS, (method, _host, pathname) => {
      if (method === 'POST' && pathname === '/as/token.oauth2') return { status: 400, body: { error: 'invalid_client' } };
      return { body: {} };
    });
    await expect(adapter.pull()).rejects.toThrow(/GreenLake SSO answered HTTP 400/);
    expect(calls.filter((c) => c.url.endsWith('/oauth2/token'))).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// ON-DEMAND DETAIL READS
//
// Fixtures below are RECORDED from the live tenant (site 79244870000394240),
// not invented: AP735-LR (PHT5M520SZ) radios + wlans, CX6300-CORE (SG30LMR164)
// interfaces, SS_9004_Gateway (CNJDKLB03G) ports, the link topology, and a
// macAddress-filtered clients-usage series. Central's habit of returning
// numbers as strings ('9', '-98', '1500 bytes', '1000') is preserved exactly,
// because normalizing it is half of what these mappers are for.
// ---------------------------------------------------------------------------

const RADIO_ROWS = [
  {
    power: '9', radioNumber: 1, mode: 'Client Access', channel: '11', channelUtilization: '24',
    status: 'UP', txUtilization: '0', rxUtilization: '20', bandwidth: '20 MHz', noiseFloor: '-98',
    id: 'PHT5M520SZ/radios/1', drops: '0', channelQuality: '95', clientCount: 1, retries: '0',
    macAddress: '48:00:20:27:0c:80', band: '2.4 GHz', nonWifiInterference: '4',
  },
  {
    power: '19', radioNumber: 0, mode: 'Client Access', channel: '157E', channelUtilization: '9',
    status: 'UP', txUtilization: '1', rxUtilization: '4', bandwidth: '80 MHz', noiseFloor: '-93',
    id: 'PHT5M520SZ/radios/0', drops: '0', channelQuality: '97', clientCount: 1, retries: '0',
    macAddress: '48:00:20:27:0c:a0', band: '5 GHz', nonWifiInterference: '4',
  },
  {
    power: '15', radioNumber: 2, mode: 'Client Access', channel: '213S', channelUtilization: '0',
    status: 'UP', txUtilization: '0', rxUtilization: '0', bandwidth: '160 MHz', noiseFloor: '-87',
    id: 'PHT5M520SZ/radios/2', drops: '0', channelQuality: '100', clientCount: 0, retries: '0',
    macAddress: '48:00:20:27:0c:90', band: '6 GHz', nonWifiInterference: '0',
  },
];

const WLAN_ROWS = [
  { status: 'ENABLED', band: '5 GHz, 6 GHz', securityLevel: 'Enterprise', security: 'WPA3 Enterprise (CCM 128)', wlanName: 'Air Pass', vlan: '200', clientCount: 0 },
  { status: 'ENABLED', band: '2.4 GHz, 5 GHz', securityLevel: 'Personal', security: 'WPA2 Personal', wlanName: 'aruba-home', vlan: '200', clientCount: 25 },
];

const SWITCH_PORT_CONNECTED = {
  speed: 5000000000, neighbourSerial: 'PHQHKZ22X5', lag: '', stpInstanceType: 'mstp', id: '1/1/3',
  stpPortState: 'Forwarding', status: 'Connected', serialNumber: 'SG30LMR164', stpPortRole: 'Designated',
  neighbourType: 'Access Point', neighbourHealth: 'Good', name: '1/1/3', adminStatus: 'Up', mtu: 1500,
  connector: 'RJ45', nativeVlan: 5, duplex: 'Full', vlanMode: 'Trunk', allowedVlans: ['5', '200'],
  allowedVlanIds: [5, 200], operStatus: 'Up', poeStatus: 'Drawing Watts', index: 3,
  poeClass: '802.3bt Type 3 (PoE++)', uplink: false, neighbour: 'Office-655', neighbourPort: 'eth0',
};

const SWITCH_PORT_IDLE = {
  speed: null, neighbourSerial: null, lag: '', id: '1/1/1', stpPortState: null, status: 'Not Connected',
  stpPortRole: null, neighbourType: null, neighbourHealth: null, name: '1/1/1', adminStatus: 'Up',
  mtu: 1500, connector: 'RJ45', nativeVlan: 200, duplex: '-', vlanMode: 'Access', allowedVlanIds: [],
  operStatus: 'Down', poeStatus: 'Not Used', poeClass: null, uplink: false, neighbour: null, neighbourPort: null,
};

const GATEWAY_PORT_UP = {
  connectorType: 'RJ45', macAddress: '20:4c:03:82:04:c4', speed: '1000', vlan: '1,5,33,50,55,200',
  mtu: '9216 bytes', id: 'CNJDKLB03G/ports/GE 0/0/1', portNumber: '1', health: 'Good',
  adminState: 'Enabled', duplex: 'Full', operState: 'Up', portType: 'Trunk', name: 'GE 0/0/1',
};

const GATEWAY_PORT_DOWN = {
  connectorType: 'RJ45', macAddress: '20:4c:03:82:04:c2', speed: 'Auto', vlan: '1', mtu: '1500 bytes',
  portNumber: '0', health: 'Unknown', adminState: 'Enabled', duplex: 'Auto', operState: 'Down',
  portType: 'Trunk', name: 'GE 0/0/0',
};

const TOPOLOGY_BODY = {
  type: 'Topology',
  id: 'linkTopology',
  isolatedDevicesCount: 0,
  isolatedHealth: null,
  devices: [
    { conductorSerial: null, internet: false, type: 'Switch', lastSeen: 0, healthReason: null, name: 'CX6300-CORE', serial: 'SG30LMR164', ipv4: '10.11.154.1', mac: '4c:d5:87:32:c0:80', health: 'Good', deployment: 'Standalone', model: 'CX-6300M', deviceFunction: 'Access Switch', status: 'ONLINE' },
    { conductorSerial: null, internet: false, type: 'Gateway', lastSeen: 1780779865157, healthReason: 'DEVICE_STATUS', name: 'SS_9004_Gateway-LTE', serial: 'CNP6L2H038', ipv4: '192.168.1.8', mac: '20:4c:03:e4:11:c8', health: 'Poor', deployment: 'Cluster', model: 'A9004-LTE', deviceFunction: 'Mobility GW', status: 'OFFLINE' },
    { conductorSerial: null, internet: null, type: 'Unmanaged', lastSeen: null, healthReason: null, name: 'Room 525', serial: 'tpd_204c03ff8c8a', ipv4: null, mac: '20:4c:03:ff:8c:8a', health: null, deployment: null, model: null, deviceFunction: '-', status: 'ONLINE' },
  ],
  links: [
    { speed: 1000000000, stpState: null, fromPortList: [{ index: 20, health: 'Good', lag: '', healthReason: null, name: '1/1/20' }], toPortList: [{ index: 1, health: 'Good', lag: null, healthReason: null, name: 'GE 0/0/1' }], to: 'CNJDKLB03G', health: 'Good', isSibling: null, from: 'SG30LMR164', healthReason: null, edgeType: 'System' },
    { speed: 5000000000, stpState: null, fromPortList: [{ index: 9, health: 'Good', lag: '', healthReason: null, name: '1/1/9' }], toPortList: [{ index: null, health: 'Unknown', lag: null, healthReason: null, name: 'eth0' }], to: 'tpd_204c03ff8c8a', health: 'Unknown', isSibling: null, from: 'SG30LMR164', healthReason: null, edgeType: 'System' },
  ],
};

const MOBILITY_ROW = {
  occurredAt: '2026-07-28T14:31:02.418Z',
  roamTime: '168',
  wlanName: 'SecureSSID',
  sourceAp: 'LR655',
  destinationAp: 'Office-655',
  fromChannel: '11',
  toChannel: '157E',
  fromBssid: '54:d7:e3:c5:ba:40',
  toBssid: '54:d7:e3:c5:de:70',
  rssi: '-42',
  radioBand: '5 GHz',
  roamProtocol: '11r',
  type: 'network-monitoring/client-monitoring',
  id: 'roam-1',
};

/** A macAddress-FILTERED clients-usage answer (per-client bytes). */
const USAGE_BODY = {
  interval: '5 mins',
  type: 'network-monitoring/client-monitoring',
  keys: ['txUsage', 'rxUsage'],
  samples: [
    { data: [1000, 500], ts: '2026-07-28T15:40:00Z' },
    { data: [2000, 1000], ts: '2026-07-28T15:45:00Z' },
  ],
};

describe('detail-read mappers', () => {
  it('normalizeCentralMac canonicalizes every spelling to one cache key and URL segment', () => {
    expect(normalizeCentralMac('04:C2:9B:8F:4C:9C')).toBe('04:c2:9b:8f:4c:9c');
    expect(normalizeCentralMac('04-c2-9b-8f-4c-9c')).toBe('04:c2:9b:8f:4c:9c');
    expect(normalizeCentralMac('04c2.9b8f.4c9c')).toBe('04:c2:9b:8f:4c:9c');
    // Not 12 hex digits: passed through rather than mangled into a wrong MAC.
    expect(normalizeCentralMac('  Office-655 ')).toBe('office-655');
    expect(normalizeCentralMac('   ')).toBeNull();
    expect(normalizeCentralMac(null)).toBeNull();
  });

  it('parseUsageIntervalSec reads the sampling interval instead of assuming it', () => {
    // Central picks 5 min for <=1 day and 3 hours beyond it: assuming one
    // would scale every derived throughput by 36x.
    expect(parseUsageIntervalSec('5 mins')).toBe(300);
    expect(parseUsageIntervalSec('3 hours')).toBe(10800);
    expect(parseUsageIntervalSec('1 day')).toBe(86400);
    expect(parseUsageIntervalSec('whenever')).toBeNull();
    expect(parseUsageIntervalSec(null)).toBeNull();
  });

  it('mapMobilityEvent turns a recorded roam into a timeline row with a numeric RSSI', () => {
    const e = mapMobilityEvent(MOBILITY_ROW)!;
    expect(e.kind).toBe('roam');
    expect(e.ts).toBe('2026-07-28T14:31:02.418Z');
    expect(e.detail).toContain('roamed LR655 -> Office-655');
    expect(e.detail).toContain('ch 11 -> 157E');
    expect(e.detail).toContain('168 ms');
    expect(e.device).toBe('Office-655');
    expect(e.rssiDbm).toBe(-42); // the plane sends the string '-42'
    expect(e.band).toBe('5 GHz');
    // '157E' is a channel PLUS a bonding marker — it must stay a string.
    expect(e.channel).toBe('157E');
    expect(e.wlan).toBe('SecureSSID');
  });

  it('mapMobilityEvent drops an undated event and tolerates a partial one', () => {
    expect(mapMobilityEvent({ sourceAp: 'a', destinationAp: 'b' })).toBeNull();
    const e = mapMobilityEvent({ occurredAt: '2026-07-28T14:00:00Z', destinationAp: 'LR655' })!;
    expect(e.detail).toBe('roamed to LR655');
    expect(e.rssiDbm).toBeNull(); // absent, not 0
  });

  it('mapUsageSamples reads the `keys` order rather than assuming tx comes first', () => {
    const swapped = { ...USAGE_BODY, keys: ['rxUsage', 'txUsage'] };
    expect(mapUsageSamples(USAGE_BODY)[0]).toEqual({ ts: '2026-07-28T15:40:00Z', txBytes: 1000, rxBytes: 500 });
    expect(mapUsageSamples(swapped)[0]).toEqual({ ts: '2026-07-28T15:40:00Z', txBytes: 500, rxBytes: 1000 });
  });

  it('mapCentralRadio normalizes Central strings to numbers and keeps the channel a string', () => {
    const r = mapCentralRadio(RADIO_ROWS[1])!;
    expect(r.number).toBe(0);
    expect(r.band).toBe('5 GHz');
    expect(r.channel).toBe('157E'); // NOT 157 — the E is a bonding marker
    expect(r.bandwidth).toBe('80 MHz');
    expect(r.powerDbm).toBe(19);
    expect(r.clients).toBe(1);
    expect(r.channelUtilPct).toBe(9);
    expect(r.rxUtilPct).toBe(4);
    expect(r.txUtilPct).toBe(1);
    expect(r.retries).toBe(0);
    expect(r.drops).toBe(0);
    expect(r.noiseFloorDbm).toBe(-93);
    expect(r.nonWifiInterference).toBe(4);
    expect(r.channelQuality).toBe(97);
    expect(r.status).toBe('UP');
    expect(r.mode).toBe('Client Access');
    expect(r.macAddress).toBe('48:00:20:27:0c:a0');
  });

  it('mapCentralRadio reports an omitted statistic as null, never 0', () => {
    const r = mapCentralRadio({ radioNumber: 0, band: '5 GHz', status: 'UP' })!;
    expect(r.powerDbm).toBeNull();
    expect(r.retries).toBeNull();
    expect(r.noiseFloorDbm).toBeNull();
    expect(r.channelQuality).toBeNull();
  });

  it('mapCentralWlan maps the recorded WLAN row and drops an unnamed one', () => {
    const w = mapCentralWlan(WLAN_ROWS[1])!;
    expect(w).toEqual({
      name: 'aruba-home', status: 'ENABLED', security: 'WPA2 Personal',
      securityLevel: 'Personal', band: '2.4 GHz, 5 GHz', vlan: '200', clients: 25,
    });
    expect(mapCentralWlan({ status: 'ENABLED' })).toBeNull();
  });

  it('mapCentralSwitchPort keeps the speed in bits per second and names the far end of the cable', () => {
    const p = mapCentralSwitchPort(SWITCH_PORT_CONNECTED)!;
    expect(p.name).toBe('1/1/3');
    expect(p.status).toBe('Connected');
    expect(p.adminStatus).toBe('Up');
    expect(p.operStatus).toBe('Up');
    expect(p.speedBps).toBe(5_000_000_000); // already bps on this endpoint
    expect(p.duplex).toBe('Full');
    expect(p.connector).toBe('RJ45');
    expect(p.mtu).toBe(1500);
    expect(p.vlanMode).toBe('Trunk');
    expect(p.nativeVlan).toBe(5);
    expect(p.allowedVlanIds).toEqual([5, 200]);
    expect(p.poeStatus).toBe('Drawing Watts');
    expect(p.poeClass).toBe('802.3bt Type 3 (PoE++)');
    expect(p.stpRole).toBe('Designated');
    expect(p.stpState).toBe('Forwarding');
    expect(p.neighbour).toBe('Office-655');
    expect(p.neighbourPort).toBe('eth0');
    expect(p.neighbourSerial).toBe('PHQHKZ22X5');
    expect(p.neighbourType).toBe('Access Point');
    expect(p.neighbourHealth).toBe('Good');
    expect(p.uplink).toBe(false);
  });

  it('mapCentralSwitchPort OMITS a neighbour Central did not report rather than emptying it', () => {
    // An empty string would render as "the plane failed to report a neighbour";
    // an absent key is "nothing is plugged in", which is what 'Not Connected'
    // actually means.
    const p = mapCentralSwitchPort(SWITCH_PORT_IDLE)!;
    expect('neighbour' in p).toBe(false);
    expect('stpRole' in p).toBe(false);
    expect('poeClass' in p).toBe(false);
    expect(p.speedBps).toBeNull(); // no negotiated speed, not 0
    expect(p.allowedVlanIds).toEqual([]); // present-and-empty: the plane DID say none
    expect(p.lag).toBeUndefined();
  });

  it('mapCentralGatewayPort rescales Mbps to bps and refuses to read Auto as a speed', () => {
    const up = mapCentralGatewayPort(GATEWAY_PORT_UP)!;
    expect(up.name).toBe('GE 0/0/1');
    expect(up.speedBps).toBe(1_000_000_000); // the plane says the string '1000'
    expect(up.mtu).toBe(9216); // the plane says '9216 bytes'
    expect(up.adminStatus).toBe('Enabled');
    expect(up.operStatus).toBe('Up');
    expect(up.status).toBe('Up');
    expect(up.vlanMode).toBe('Trunk');
    expect(up.allowedVlanIds).toEqual([1, 5, 33, 50, 55, 200]);
    expect(up.connector).toBe('RJ45');
    // The gateway ports endpoint reports NO neighbour/PoE/STP at all — those
    // keys must be absent, not blank.
    expect('neighbour' in up).toBe(false);
    expect('poeStatus' in up).toBe(false);
    expect('stpState' in up).toBe(false);

    const down = mapCentralGatewayPort(GATEWAY_PORT_DOWN)!;
    expect(down.speedBps).toBeNull(); // 'Auto' is not a speed
    expect(down.mtu).toBe(1500);
    expect(down.operStatus).toBe('Down');
  });

  it('mapTopologyNode keeps an unmanaged node honestly unassessed', () => {
    const managed = mapTopologyNode(TOPOLOGY_BODY.devices[1])!;
    expect(managed.serial).toBe('CNP6L2H038');
    expect(managed.health).toBe('Poor');
    expect(managed.healthReason).toBe('DEVICE_STATUS');
    expect(managed.deployment).toBe('Cluster');
    expect(managed.internet).toBe(false);
    expect(managed.lastSeen).toBe(1780779865157);

    const unmanaged = mapTopologyNode(TOPOLOGY_BODY.devices[2])!;
    expect(unmanaged.serial).toBe('tpd_204c03ff8c8a'); // synthetic id is still the graph key
    expect(unmanaged.health).toBeNull(); // Central does not assess it — a real answer
    expect(unmanaged.model).toBeNull();
    expect(unmanaged.internet).toBeNull();
    expect(unmanaged.lastSeen).toBeNull();
    // A switch with lastSeen 0 has no stamp; it must never render as 1970.
    expect(mapTopologyNode(TOPOLOGY_BODY.devices[0])!.lastSeen).toBe(0);
    expect(mapTopologyNode({ name: 'no serial' })).toBeNull();
  });

  it('mapTopologyLink carries both port lists and the plane own Unknown verdict', () => {
    const l = mapTopologyLink(TOPOLOGY_BODY.links[1])!;
    expect(l.from).toBe('SG30LMR164');
    expect(l.to).toBe('tpd_204c03ff8c8a');
    expect(l.fromPorts).toEqual([{ name: '1/1/9', index: 9, lag: null, health: 'Good', healthReason: null }]);
    expect(l.toPorts[0].name).toBe('eth0');
    expect(l.toPorts[0].index).toBeNull();
    expect(l.speedBps).toBe(5_000_000_000);
    expect(l.health).toBe('Unknown'); // the plane's verdict, not a failed read
    expect(l.edgeType).toBe('System');
    expect(mapTopologyLink({ from: 'A' })).toBeNull(); // half-attached edge
  });
});

// -- detail reads against the fake fetch -------------------------------------

const DETAIL_MAC = '04:c2:9b:8f:4c:9c';

/** makeAdapter + an injectable clock, so TTL expiry costs no wall time. */
function makeDetailAdapter(handler: Handler, clock: { ms: number } = { ms: Date.parse('2026-07-28T16:00:00Z') }) {
  const { fn, calls } = fakeFetch(handler);
  const recorded: { path: string; ms: number; code: string }[] = [];
  const state = makeState();
  const slept: number[] = [];
  const adapter = new CentralAdapter(
    CREDS,
    state,
    (c) => recorded.push(c),
    fn,
    async (ms) => {
      slept.push(ms);
    },
    () => clock.ms,
  );
  return { adapter, state, recorded, calls, slept, clock };
}

/** Handler for the recorded detail endpoints; unknown paths 404 as usual. */
function detailHandler(overrides: Record<string, HandlerResult> = {}): Handler {
  return (method, pathname) => {
    const decoded = decodeURIComponent(pathname);
    for (const [frag, result] of Object.entries(overrides)) {
      if (decoded.includes(frag)) return result;
    }
    if (method === 'POST' && pathname === '/oauth2/token') return { body: { access_token: 'tok-1', expires_in: 7200 } };
    if (decoded.endsWith('/mobility-trail')) return { body: { items: [MOBILITY_ROW], total: 1, count: 1, next: null } };
    if (decoded.endsWith('/clients-usage')) return { body: USAGE_BODY };
    if (decoded.endsWith('/radios')) return { body: { items: RADIO_ROWS, total: 3, count: 3 } };
    if (decoded.endsWith('/wlans')) return { body: { items: WLAN_ROWS, total: 2, count: 2 } };
    if (decoded.endsWith('/interfaces')) {
      return { body: { items: [SWITCH_PORT_CONNECTED, SWITCH_PORT_IDLE], total: 2, count: 2, offset: null } };
    }
    if (decoded.endsWith('/ports')) return { body: { items: [GATEWAY_PORT_UP, GATEWAY_PORT_DOWN], total: 2, count: 2 } };
    if (decoded.includes('/topology/')) return { body: TOPOLOGY_BODY };
    return undefined;
  };
}

describe('CentralAdapter.clientDetail()', () => {
  it('answers RSSI, roams, timeline and throughput for one MAC', async () => {
    const { adapter } = makeDetailAdapter(detailHandler());
    const d = (await adapter.clientDetail(DETAIL_MAC))!;
    expect(d.mac).toBe(DETAIL_MAC);
    expect(d.source.plane).toBe('central');
    expect(d.rssi).toBe(-42);
    expect(d.roams).toBe(1);
    expect(d.roamsWindowSec).toBe(86400);
    expect(d.timeline).toHaveLength(1);
    expect(d.timeline![0].device).toBe('Office-655');
    expect(d.usageSeries).toEqual([
      { ts: '2026-07-28T15:40:00Z', txBytes: 1000, rxBytes: 500 },
      { ts: '2026-07-28T15:45:00Z', txBytes: 2000, rxBytes: 1000 },
    ]);
    // 4,500 bytes over two 5-minute buckets = 4500*8/600 bits per second.
    expect(d.tputWindowSec).toBe(600);
    expect(d.tput).toBeCloseTo((4500 * 8) / 600, 6);
    expect(d.source.sections).toEqual({ rssi: 'ok', roams: 'ok', timeline: 'ok', tput: 'ok', usageSeries: 'ok' });
    expect(d.source.note).toBeNull();
    expect(d.source.cached).toBe(false);
  });

  it('asks clients-usage for THIS client only, and sends no end-at', async () => {
    // Unfiltered, /clients-usage is TENANT-WIDE (verified live: ~78 MB per
    // 5-min bucket vs 984 B for one client) — attributing that series to one
    // client would be fabrication. And an end-at from our clock 400s the
    // gateway whenever the two clocks disagree, so it is never sent.
    const { adapter, calls } = makeDetailAdapter(detailHandler());
    await adapter.clientDetail('04-C2-9B-8F-4C-9C');
    const usage = calls.find((c) => c.includes('/clients-usage'))!;
    expect(decodeURIComponent(usage)).toContain(`filter=macAddress eq '${DETAIL_MAC}'`);
    const trail = calls.find((c) => c.includes('/mobility-trail'))!;
    expect(decodeURIComponent(trail)).toContain(`/clients/${DETAIL_MAC}/mobility-trail`);
    expect(trail).toContain('limit=100');
    expect(decodeURIComponent(trail)).toContain('start-at=2026-07-27T16:00:00.000Z');
    expect(trail).not.toContain('end-at');
  });

  it('a stationary client with no roams is empty, NOT failed', async () => {
    const { adapter } = makeDetailAdapter(
      detailHandler({ '/mobility-trail': { body: { items: [], total: 0, count: 0, next: null } } }),
    );
    const d = (await adapter.clientDetail(DETAIL_MAC))!;
    // 0 roams is a real answer ('no roaming in the last 24h'), so `roams` is
    // 'ok' at 0 while the genuinely empty event list is 'empty'.
    expect(d.roams).toBe(0);
    expect(d.source.sections.roams).toBe('ok');
    expect(d.timeline).toEqual([]);
    expect(d.source.sections.timeline).toBe('empty');
    expect(d.rssi).toBeNull();
    expect(d.source.sections.rssi).toBe('empty');
    expect(d.source.note).toBeNull(); // an empty result is not an error
  });

  it('a broken section is marked failed while the section that answered still ships', async () => {
    const { adapter } = makeDetailAdapter(detailHandler({ '/mobility-trail': { status: 500, body: { error: 'boom' } } }));
    const d = (await adapter.clientDetail(DETAIL_MAC))!;
    expect(d.source.sections.rssi).toBe('failed');
    expect(d.source.sections.roams).toBe('failed');
    expect(d.source.sections.timeline).toBe('failed');
    expect(d.rssi).toBeUndefined(); // absent, never a fabricated or stale number
    expect(d.timeline).toBeUndefined();
    expect(d.source.sections.tput).toBe('ok'); // the other endpoint still answered
    expect(d.source.note).toContain('mobility trail: HTTP 500');
  });

  it('caches a detail read for its TTL, then re-reads once it expires', async () => {
    const clock = { ms: Date.parse('2026-07-28T16:00:00Z') };
    const { adapter, calls } = makeDetailAdapter(detailHandler(), clock);
    await adapter.clientDetail(DETAIL_MAC);
    const first = calls.filter((c) => c.includes('/clients')).length;
    expect(first).toBe(2); // mobility-trail + clients-usage

    clock.ms += 20_000;
    const again = (await adapter.clientDetail(DETAIL_MAC))!;
    expect(calls.filter((c) => c.includes('/clients')).length).toBe(first); // zero new calls
    expect(again.source.cached).toBe(true); // and it SAYS the numbers are cached
    expect(again.rssi).toBe(-42);

    clock.ms += 60_000; // past DETAIL_TTL_MS
    const fresh = (await adapter.clientDetail(DETAIL_MAC))!;
    expect(calls.filter((c) => c.includes('/clients')).length).toBe(first + 2);
    expect(fresh.source.cached).toBe(false);
  });

  it('two panes opening the same client at once share ONE round trip', async () => {
    const { adapter, calls } = makeDetailAdapter(detailHandler());
    const [a, b] = await Promise.all([adapter.clientDetail(DETAIL_MAC), adapter.clientDetail(DETAIL_MAC)]);
    expect(calls.filter((c) => c.includes('/clients')).length).toBe(2); // not 4
    expect(a!.rssi).toBe(b!.rssi);
  });

  it('caches the FAILED read too, so a re-rendering drawer cannot storm a sick tenant', async () => {
    const { adapter, calls } = makeDetailAdapter(
      detailHandler({ '/mobility-trail': { status: 503, body: {} }, '/clients-usage': { status: 503, body: {} } }),
    );
    const first = (await adapter.clientDetail(DETAIL_MAC))!;
    expect(first.source.sections).toEqual({ rssi: 'failed', roams: 'failed', timeline: 'failed', tput: 'failed', usageSeries: 'failed' });
    const before = calls.length;
    await adapter.clientDetail(DETAIL_MAC);
    expect(calls.length).toBe(before);
  });

  it('a blank MAC is answered with null — this plane cannot be asked about nothing', async () => {
    const { adapter, calls } = makeDetailAdapter(detailHandler());
    expect(await adapter.clientDetail('  ')).toBeNull();
    expect(calls).toHaveLength(0); // and it costs no call
  });

  it('a rate-limited detail read degrades immediately instead of holding the drawer for 30s', async () => {
    const { adapter, slept } = makeDetailAdapter(detailHandler({ '/mobility-trail': { status: 429, body: {} } }));
    const d = (await adapter.clientDetail(DETAIL_MAC))!;
    expect(d.source.sections.timeline).toBe('failed');
    expect(d.source.note).toContain('HTTP 429');
    // pull()'s 429 backoff exists so a poll cycle survives; on a request path
    // it would just stall a human. No sleeps here.
    expect(slept).toHaveLength(0);
  });
});

describe('CentralAdapter.deviceDetail()', () => {
  it('an AP is asked for radios and WLANs only, and the radios come back in order', async () => {
    const { adapter, calls } = makeDetailAdapter(detailHandler());
    const d = (await adapter.deviceDetail('PHT5M520SZ', 'ap'))!;
    expect(d.serial).toBe('PHT5M520SZ');
    expect(d.kind).toBe('ap');
    // Central hands them back 1, 0, 2 — an operator reads radio 0 first.
    expect(d.radios!.map((r) => r.number)).toEqual([0, 1, 2]);
    expect(d.radios![0].channel).toBe('157E');
    expect(d.radios![1].retries).toBe(0);
    expect(d.wlans!.map((w) => w.name)).toEqual(['Air Pass', 'aruba-home']);
    expect(d.source.sections).toEqual({ radios: 'ok', wlans: 'ok' });
    expect(d.ports).toBeUndefined(); // an AP has no /interfaces — never asked
    expect(calls.some((c) => c.includes('/interfaces'))).toBe(false);
    expect(calls.filter((c) => c.includes('/aps/'))).toHaveLength(2);
  });

  it('a switch is read from /interfaces with NO paging params (Central returns them all)', async () => {
    const { adapter, calls } = makeDetailAdapter(detailHandler());
    const d = (await adapter.deviceDetail('SG30LMR164', 'switch'))!;
    expect(d.ports!.map((p) => p.name)).toEqual(['1/1/3', '1/1/1']);
    expect(d.ports![0].neighbour).toBe('Office-655');
    expect(d.source.sections).toEqual({ ports: 'ok' });
    expect(d.radios).toBeUndefined();
    const call = calls.find((c) => c.includes('/interfaces'))!;
    // "Fetches all by default" (verified live: 28 of 28 in one response), so
    // paging params would only add wire noise and a 400 risk.
    expect(call).not.toContain('limit=');
    expect(call).not.toContain('offset=');
  });

  it('a gateway is read from /gateways/{serial}/ports, not the switch interface path', async () => {
    const { adapter, calls } = makeDetailAdapter(detailHandler());
    const d = (await adapter.deviceDetail('CNJDKLB03G', 'gateway'))!;
    expect(calls.some((c) => c.includes('/gateways/CNJDKLB03G/ports'))).toBe(true);
    expect(calls.some((c) => c.includes('/interfaces'))).toBe(false);
    expect(d.ports!.map((p) => p.name)).toEqual(['GE 0/0/1', 'GE 0/0/0']);
    expect(d.ports![0].speedBps).toBe(1_000_000_000);
    expect(d.source.sections).toEqual({ ports: 'ok' });
  });

  it('a device with no subresources reports empty, and a 404 reports failed', async () => {
    const { adapter } = makeDetailAdapter(detailHandler({ '/radios': { body: { items: [], total: 0 } } }));
    const empty = (await adapter.deviceDetail('PHT5M520SZ', 'ap'))!;
    expect(empty.radios).toEqual([]);
    expect(empty.source.sections.radios).toBe('empty');
    expect(empty.source.note).toBeNull();

    const { adapter: broken } = makeDetailAdapter(detailHandler({ '/radios': { status: 404, body: {} } }));
    const d = (await broken.deviceDetail('PHT5M520SZ', 'ap'))!;
    expect(d.radios).toBeUndefined(); // never a fabricated row
    expect(d.source.sections.radios).toBe('failed');
    expect(d.source.sections.wlans).toBe('ok'); // the section that answered still ships
    expect(d.source.note).toContain('radios: HTTP 404');
  });

  it('caches per serial AND kind, so one device drawer never re-reads the other', async () => {
    const { adapter, calls } = makeDetailAdapter(detailHandler());
    await adapter.deviceDetail('SG30LMR164', 'switch');
    await adapter.deviceDetail('SG30LMR164', 'switch');
    expect(calls.filter((c) => c.includes('/interfaces'))).toHaveLength(1);
    await adapter.deviceDetail('PHT5M520SZ', 'ap');
    expect(calls.filter((c) => c.includes('/radios'))).toHaveLength(1);
  });

  it('a blank serial is answered with null and costs no call', async () => {
    const { adapter, calls } = makeDetailAdapter(detailHandler());
    expect(await adapter.deviceDetail('', 'switch')).toBeNull();
    expect(calls).toHaveLength(0);
  });
});

describe('CentralAdapter.siteTopology()', () => {
  it('maps the site graph by serial, keeping unmanaged nodes and Unknown links honest', async () => {
    const { adapter } = makeDetailAdapter(detailHandler());
    const t = (await adapter.siteTopology('79244870000394240'))!;
    expect(t.siteId).toBe('79244870000394240');
    expect(t.nodes!.map((n) => n.serial)).toEqual(['SG30LMR164', 'CNP6L2H038', 'tpd_204c03ff8c8a']);
    expect(t.nodes![2].health).toBeNull();
    expect(t.links).toHaveLength(2);
    expect(t.links![0].fromPorts[0].name).toBe('1/1/20');
    expect(t.links![0].toPorts[0].name).toBe('GE 0/0/1');
    expect(t.links![1].health).toBe('Unknown');
    expect(t.isolatedDevicesCount).toBe(0);
    expect(t.isolatedHealth).toBeNull();
    expect(t.source.sections).toEqual({ nodes: 'ok', links: 'ok' });
  });

  it('reads devices and links BY NAME, never by "first array in the payload"', async () => {
    // The topology payload carries two sibling arrays; a first-array heuristic
    // would happily return a decoy.
    const decoy = { errors: [], warnings: ['x'], ...TOPOLOGY_BODY };
    const { adapter } = makeDetailAdapter(detailHandler({ '/topology/': { body: decoy } }));
    const t = (await adapter.siteTopology('79244870000394240'))!;
    expect(t.nodes).toHaveLength(3);
    expect(t.links).toHaveLength(2);
  });

  it('a site the plane cannot graph is failed, not an empty graph', async () => {
    const { adapter } = makeDetailAdapter(detailHandler({ '/topology/': { status: 404, body: {} } }));
    const t = (await adapter.siteTopology('nope'))!;
    expect(t.nodes).toBeUndefined();
    expect(t.links).toBeUndefined();
    expect(t.source.sections).toEqual({ nodes: 'failed', links: 'failed' });
    expect(t.source.note).toContain('topology: HTTP 404');
  });

  it('a blank site id is answered with null and costs no call', async () => {
    const { adapter, calls } = makeDetailAdapter(detailHandler());
    expect(await adapter.siteTopology('')).toBeNull();
    expect(calls).toHaveLength(0);
  });
});

describe('detail reads are not poller work', () => {
  it('pull() never issues a per-object detail call', async () => {
    // 9 devices x N subresources x 1440 polls/day is exactly the regression
    // this whole design exists to prevent.
    const { adapter, calls } = makeAdapter(routeHandler(HAPPY_ROUTES));
    await adapter.pull();
    for (const fragment of ['/mobility-trail', '/clients-usage', '/radios', '/wlans', '/interfaces', '/topology/']) {
      expect(calls.some((c) => c.includes(fragment))).toBe(false);
    }
  });
});
