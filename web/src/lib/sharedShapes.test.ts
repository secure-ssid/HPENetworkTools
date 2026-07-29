/**
 * sharedShapes.test.ts — the shared/ shapes and helpers the live code paths
 * depend on: relative ages and SLA countdowns (so a raised ticket is never
 * frozen at "now"), per-plane freshness and sync outcomes (design rule 1 —
 * never present stale or missing data as current), the derived site profile
 * (so an unauthored site never renders another site's numbers), and the
 * reconciliation / lane / connect constants the live branches emit.
 *
 * Pure data and pure functions — no DOM.
 */

import { describe, expect, it } from 'vitest';
import {
  CONNECT_ENDPOINT_KEY,
  CONNECT_FIELDS,
  DEVICES,
  DEVICE_RECONCILIATION,
  LANE_META,
  PLANE_MARK,
  PLANE_WRITE_MODE,
  QUEUED_CHANGES,
  REAL_SITE_IDS,
  SITES,
  SYSTEMS,
  applyDeviceRowToProfile,
  deriveSiteProfile,
  deviceProfile,
  isRealSiteId,
  planeFreshness,
  relativeAge,
  scopeForPlane,
  seedFormFromRow,
  slaCountdown,
  syncOutcomeFor,
  toSiteAlertRow,
  toSiteDeviceRow,
} from '../../../shared';
import type {
  AlertCorrelation,
  AlertRow,
  DeviceEvidence,
  DeviceRow,
  DeviceTerminalPayload,
  Plane,
  PortObject,
  QueuedChangeRow,
  SiteReachability,
  VlanObject,
} from '../../../shared';

const NOW = Date.parse('2026-07-26T12:00:00.000Z');
const ago = (ms: number): string => new Date(NOW - ms).toISOString();

describe('relativeAge — the fixtures own age vocabulary', () => {
  it('formats seconds, minutes, hours and days', () => {
    expect(relativeAge(ago(40_000), NOW)).toBe('40s');
    expect(relativeAge(ago(12 * 60_000), NOW)).toBe('12m');
    expect(relativeAge(ago(6 * 3_600_000), NOW)).toBe('6h');
    expect(relativeAge(ago(3 * 86_400_000), NOW)).toBe('3d');
  });

  it('reads dash rather than inventing an age it does not have', () => {
    expect(relativeAge(null, NOW)).toBe('—');
    expect(relativeAge(undefined, NOW)).toBe('—');
    expect(relativeAge('not-a-date', NOW)).toBe('—');
  });
});

describe('slaCountdown — a countdown, not a snapshot', () => {
  it('counts down while there is time left', () => {
    expect(slaCountdown(new Date(NOW + 72 * 60_000).toISOString(), NOW)).toBe('SLA breach in 1h 12m');
    expect(slaCountdown(new Date(NOW + 40 * 60_000).toISOString(), NOW)).toBe('SLA breach in 40m');
  });

  it('says so once the deadline has passed', () => {
    expect(slaCountdown(ago(40 * 60_000), NOW)).toBe('SLA breached 40m ago');
  });

  it('returns null with no deadline, so authored fixture strings survive', () => {
    expect(slaCountdown(undefined, NOW)).toBeNull();
    expect(slaCountdown('nonsense', NOW)).toBeNull();
  });
});

describe('planeFreshness — staleness expires (design rule 1)', () => {
  it('is fresh inside the window and stale past it', () => {
    expect(planeFreshness(ago(30_000), 90, NOW)).toEqual({ lastSync: ago(30_000), ageSec: 30, stale: false });
    expect(planeFreshness(ago(6 * 3_600_000), 90, NOW).stale).toBe(true);
  });

  it('treats a plane that has never synced as stale, not as healthy', () => {
    expect(planeFreshness(null, 90, NOW)).toEqual({ lastSync: null, ageSec: null, stale: true });
  });
});

describe('syncOutcomeFor — "answered with nothing" is not a healthy sync', () => {
  it('separates ok / empty / partial / failed', () => {
    expect(syncOutcomeFor({ ok: true, reported: ['devices'], rows: 24 })).toBe('ok');
    expect(syncOutcomeFor({ ok: true, reported: ['devices'], rows: 0 })).toBe('empty');
    expect(syncOutcomeFor({ ok: true, reported: [], rows: 0 })).toBe('empty');
    expect(syncOutcomeFor({ ok: true, reported: ['devices'], missing: ['clients'], rows: 24 })).toBe('partial');
    expect(syncOutcomeFor({ ok: false, reported: [], rows: 0 })).toBe('failed');
  });
});

describe('site identity — real sites vs bookkeeping pseudo-sites', () => {
  it('lists exactly the sites with an inventory row', () => {
    expect(REAL_SITE_IDS).toEqual(SITES.map((s) => s.id));
    expect(REAL_SITE_IDS).toHaveLength(10);
  });

  it('rejects the pseudo-sites that alert and device rows use', () => {
    expect(isRealSiteId('campus-02')).toBe(true);
    for (const pseudo of ['core-services', 'workspace', 'multiple', 'no-such-place']) {
      expect(isRealSiteId(pseudo)).toBe(false);
    }
  });
});

describe('deriveSiteProfile — a site renders its own numbers', () => {
  it('describes Campus-02 from its own inventory row, not Warehouse-DC1', () => {
    const profile = deriveSiteProfile('campus-02');
    expect(profile).not.toBeNull();
    expect(profile!.name).toBe('Campus-02 Research');
    expect(profile!.siteId).toBe('campus-02');
    expect(profile!.deviceCount).toBe('96');
    expect(profile!.clients).toBe('1,212');
    expect(profile!.facts.find((f) => f.k === 'Subnets')!.v).toBe('10.44.0.0/16');
    // Warehouse-DC1's authored fallback leaked these three values everywhere.
    expect(profile!.deviceCount).not.toBe('18');
    expect(profile!.core).not.toBe('sw-wh1-1');
    expect(profile!.devices.map((d) => d.name)).not.toContain('sw-wh1-1');
  });

  it('files the site own devices and only its open alerts', () => {
    const profile = deriveSiteProfile('campus-02')!;
    expect(profile.devices.map((d) => d.name).sort()).toEqual(
      DEVICES.filter((d) => d.siteId === 'campus-02').map((d) => d.name).sort(),
    );
    // The one Campus-02 alert in the fixtures is acked, not open.
    expect(profile.alerts).toHaveLength(0);
    expect(profile.alertCount).toBe('0');
    expect(profile.alertNote).toBe('none open');
  });

  it('marks a stale-inventory site stale instead of asserting health', () => {
    const profile = deriveSiteProfile('riverside')!;
    expect(profile.health).toBeNull();
    expect(profile.healthNote).toBe('inventory stale');
  });

  it('reads dash for facts the portal does not hold', () => {
    const profile = deriveSiteProfile('southpoint')!;
    expect(profile.drift).toBe('—');
    expect(profile.clientDelta).toBe('no peak recorded');
    expect(profile.facts.find((f) => f.k === 'WAN')!.v).toBe('—'); // no recorded chain
  });

  it('returns null for a pseudo-site so the caller can 404', () => {
    expect(deriveSiteProfile('core-services')).toBeNull();
    expect(deriveSiteProfile('workspace')).toBeNull();
  });
});

describe('site-detail row mappers', () => {
  it('maps an inventory row without inventing role or uptime', () => {
    const row = DEVICES.find((d) => d.name === 'sw-core-a')!;
    expect(toSiteDeviceRow(row)).toEqual({
      name: 'sw-core-a',
      model: 'CX 8325-48Y8C',
      plane: 'LOCAL',
      planeTone: 'neutral',
      role: '—',
      state: 'degraded',
      stateTone: 'warning',
      uptime: '—',
    });
  });

  it('composes the "Open here" meta as plane · age', () => {
    const alert: AlertRow = {
      sev: 'P2',
      tone: 'warning',
      title: 'sw-core-a PSU 2 absent',
      detail: 'psu2 removed 03:12',
      siteId: 'campus-01',
      siteName: 'Campus-01 HQ',
      plane: 'LOCAL',
      state: 'open',
      age: '3h',
      device: 'sw-core-a',
    };
    expect(toSiteAlertRow(alert)).toEqual({ sev: 'P2', tone: 'warning', title: 'sw-core-a PSU 2 absent', meta: 'local · 3h' });
  });
});

describe('applyDeviceRowToProfile — the inventory row wins on identity', () => {
  it('overrides the name-prefix profile with the row the API returned', () => {
    const row = DEVICES.find((d) => d.name === 'sw-riv-2')!;
    const merged = applyDeviceRowToProfile(deviceProfile('sw-riv-2'), row);
    expect(merged.model).toBe('CX 6200F-24G');
    expect(merged.site).toBe('Riverside Clinic');
    expect(merged.plane).toBe('CLASSIC');
    expect(merged.state).toBe('double-claimed');
    expect(merged.stateTone).toBe('danger');
    // Authored demo depth survives — only identity is overridden.
    expect(merged.ip).toBe(deviceProfile('sw-riv-2').ip);
    expect(merged.ports).toEqual(deviceProfile('sw-riv-2').ports);
  });

  it('leaves the profile untouched when no row is available', () => {
    expect(applyDeviceRowToProfile(deviceProfile('sw-core-a'), null)).toEqual(deviceProfile('sw-core-a'));
  });
});

describe('lane, reconciliation and write-model constants', () => {
  it('PLANE_MARK reproduces every LANE_META rule colour', () => {
    for (const [plane, meta] of Object.entries(LANE_META)) {
      expect(PLANE_MARK[plane as Plane]).toBe(meta!.mark);
    }
    expect(PLANE_MARK.GREENLAKE).toBeTruthy();
    expect(PLANE_MARK['THIRD-PARTY']).toBeTruthy();
  });

  it('DEVICE_RECONCILIATION carries the authored estate truth (README:237)', () => {
    expect(DEVICE_RECONCILIATION).toEqual({ doubleClaimed: 3, unclaimed: 14 });
  });

  it('scopeForPlane never claims a write path the broker does not have', () => {
    expect(scopeForPlane('central', { linked: false, scopes: 'write:brokered' })).toBe('read only');
    expect(scopeForPlane('central', { linked: true, scopes: 'read:all' })).toBe('read only');
    expect(scopeForPlane('central', { linked: true, scopes: 'read:all write:brokered' })).toBe('read + broker');
    expect(scopeForPlane('local', { linked: true })).toBe('read + ssh');
    expect(scopeForPlane('aos8', { linked: true })).toBe('read + ssh');
    expect(scopeForPlane('mist', { linked: true, scopes: 'write:brokered' })).toBe('read only');
    expect(PLANE_WRITE_MODE.clearpass).toBe('read only');
  });
});

describe('connect-drawer credential keys match what the adapters read', () => {
  it('names the endpoint key each adapter isComplete() checks', () => {
    expect(CONNECT_ENDPOINT_KEY).toEqual({
      central: 'gatewayBaseUrl',
      mist: 'apiHost',
      classic: 'baseUrl',
      greenlake: 'workspaceId',
      aos8: 'master',
      local: 'host',
      clearpass: 'host',
      uxi: 'baseUrl',
      sse: 'baseUrl',
    });
  });

  it('supplies the extra required fields the endpoint alone cannot satisfy', () => {
    expect(CONNECT_FIELDS.mist.map((f) => f.key)).toEqual(['orgId', 'token']);
    expect(CONNECT_FIELDS.clearpass.map((f) => f.key)).toEqual(['token', 'coaEnforcementProfile']);
    expect(CONNECT_FIELDS.aos8.map((f) => f.key)).toEqual(['username', 'password']);
    expect(CONNECT_FIELDS.local.filter((f) => !f.optional).map((f) => f.key)).toEqual(['username']);
    expect(CONNECT_FIELDS.clearpass[0].secret).toBe(true);
    // The CoA profile is the one ClearPass field a working link does NOT need:
    // clearpass.ts only sends `enforcement_profile` when it is set, and a
    // wrong name 422s the disconnect. Required would gate every new link on a
    // value the operator has to guess.
    expect(CONNECT_FIELDS.clearpass.find((f) => f.key === 'coaEnforcementProfile')?.optional).toBe(true);
    expect(CONNECT_FIELDS.clearpass.filter((f) => !f.optional).map((f) => f.key)).toEqual(['token']);
  });
});

describe('seedFormFromRow — live rows never inherit fixture values', () => {
  const port: PortObject = {
    kind: 'port',
    origin: 'observed',
    device: 'sw-live-1',
    port: '1/1/9',
    desc: 'uplink',
    summary: 'access · poe',
    state: 'up',
    tone: 'success',
  };
  const vlan: VlanObject = { kind: 'vlan', origin: 'observed', id: '440', name: 'lab', detail: '—', role: '—' };

  it('keeps the authored demo seeds byte-identical', () => {
    expect(seedFormFromRow('port', port)).toMatchObject({ vlan: '812' });
    expect(seedFormFromRow('vlan', vlan)).toMatchObject({ helpers: '10.42.0.20, 10.44.0.20' });
    expect(seedFormFromRow('vlan', { ...vlan, id: '812' })).toMatchObject({ helpers: '10.42.0.20' });
  });

  it('leaves unknown live fields blank rather than seeding Meridian values', () => {
    expect(seedFormFromRow('port', port, { live: true })).toMatchObject({ vlan: '' });
    expect(seedFormFromRow('vlan', vlan, { live: true })).toMatchObject({ helpers: '' });
  });

  it('still parses what the live row actually carries', () => {
    const withVlan: PortObject = { ...port, summary: 'access vlan 440 · 802.1X' };
    const seeded = seedFormFromRow('port', withVlan, { live: true });
    expect(seeded.vlan).toBe('440');
    expect(seeded.dot1x).toBe(true);
  });
});

describe('DeviceRow carries the reconciliation fields the live path produces', () => {
  it('accepts claimedBy, ip, serial and mac as optional row fields', () => {
    const row: DeviceRow = {
      ...DEVICES[0],
      claimedBy: ['CENTRAL', 'CLASSIC'],
      ip: '10.42.8.11',
      serial: 'CN12345678',
      mac: 'aa:bb:cc:dd:ee:ff',
    };
    expect(row.claimedBy).toHaveLength(2);
    expect(DEVICES[0].claimedBy).toBeUndefined(); // fixtures stay as authored
  });
});

describe('the live-payload contracts the screens render from', () => {
  it('lets a correlation banner state its own severity, defaulting to none', () => {
    const stalePlanes: AlertCorrelation = {
      title: 'Two planes are behind',
      body: 'The queue below is unverified, not quiet.',
      tone: 'warning',
    };
    const authored: AlertCorrelation = { title: 'P1 storm', body: 'Four criticals on one gateway.' };
    expect(stalePlanes.tone).toBe('warning');
    // Absent, not defaulted here: the renderer keeps its existing 'danger'.
    expect(authored.tone).toBeUndefined();
  });

  it('keys a brokered queue row by the broker id, and the fixtures by nothing', () => {
    const brokered: QueuedChangeRow = {
      ...QUEUED_CHANGES[0],
      id: 'chg-mfk3x9a1b2c3',
      expiresAt: '2026-07-26T09:15:00.000Z',
    };
    expect(brokered.id).toBe('chg-mfk3x9a1b2c3');
    // A fixture row carries no id, which is exactly what makes it correctly
    // non-pushable — there is no queued change behind it.
    expect(QUEUED_CHANGES.every((q) => q.id === undefined)).toBe(true);
  });

  it('reads an unknown reachability share as null, never as 0%', () => {
    const unlinked: SiteReachability = {
      collector: 'not linked',
      collectorTone: 'neutral',
      reachValue: null,
      collectorNote: 'No local collector is linked, so no device answers directly.',
    };
    const linked: SiteReachability = {
      collector: 'healthy',
      collectorTone: 'success',
      reachValue: 64,
      collectorNote: '9 of 14 devices at this site are claimed by the collector.',
      core: 'sw-core-a',
    };
    expect(unlinked.reachValue).toBeNull();
    expect(unlinked.core).toBeUndefined(); // offer no terminal without a target
    expect(linked.reachValue).toBe(64);
  });

  it('distinguishes "no evidence" from "every check passes"', () => {
    const none: DeviceEvidence = {
      checks: [],
      mode: 'unavailable',
      note: 'No plane reported evidence for this device.',
    };
    const live: DeviceEvidence = {
      mode: 'live',
      checks: [
        { mark: 'pass', tone: 'success', label: 'Identity evidence', rule: 'scan.coverage.identity' },
        { mark: 'fail', tone: 'warning', label: 'Plane freshness', rule: 'scan.coverage.freshness' },
      ],
    };
    // Both have "no failing check rendered green"; only `mode` separates them.
    expect(none.checks).toHaveLength(0);
    expect(none.mode).toBe('unavailable');
    expect(live.checks.map((c) => c.rule)).toEqual(['scan.coverage.identity', 'scan.coverage.freshness']);
  });

  it('names one shape for the shell payload both device-detail branches send', () => {
    const terminal: DeviceTerminalPayload = {
      banner: [{ text: 'connecting to sw-core-a…', tone: 'muted' }],
      quickCommands: ['show version', 'show interface brief'],
    };
    expect(terminal.banner[0].tone).toBe('muted');
    expect(terminal.quickCommands).toHaveLength(2);
  });

  it('records a console URL per plane, and none for the collector that has no console', () => {
    const byName = new Map(SYSTEMS.map((s) => [s.name, s.consoleUrl]));
    expect(byName.get('HPE Aruba Central')).toBe('https://app-us4.central.arubanetworks.com');
    expect(byName.get('Mist')).toBe('https://manage.mist.com');
    expect(byName.get('Local switch collector')).toBeUndefined();
    expect(SYSTEMS.filter((s) => s.consoleUrl === undefined).map((s) => s.name)).toEqual([
      'Local switch collector',
    ]);
    for (const s of SYSTEMS) {
      if (s.consoleUrl) expect(s.consoleUrl.startsWith('https://')).toBe(true);
    }
  });
});
