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
  sevFor,
  siteIdForName,
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
