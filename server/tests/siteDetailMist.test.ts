/**
 * server/tests/siteDetailMist.test.ts — the Mist-published slices of the site
 * page (floor plans, the SLE row, located-client dots) and the on-demand SLE
 * drill route, in both modes.
 *
 * Same harness as routes.test.ts: an in-process app on an ephemeral port with
 * settings/data redirected to a tmp dir; live tests seed the poller's
 * contributions by hand and stub the Mist adapter's lazy method.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

let server: Server;
let base: string;
let tmpDir: string;

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'hpe-site-mist-'));
  process.env.HPE_SETTINGS_PATH = join(tmpDir, 'settings.json');
  process.env.HPE_DATA_DIR = join(tmpDir, 'data');
  process.env.HPE_CREDENTIAL_INDEX_WAIT_MS = '0';
  const { createApp } = await import('../src/index');
  server = createApp().listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.HPE_SETTINGS_PATH;
  delete process.env.HPE_DATA_DIR;
  delete process.env.HPE_CREDENTIAL_INDEX_WAIT_MS;
});

async function getJson(path: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${path}`);
  return { status: res.status, body: await res.json() };
}

describe('site detail Mist keys — demo mode', () => {
  it('GET /api/sites/campus-02 carries the authored map, SLE row and located-client dots', async () => {
    const { status, body } = await getJson('/api/sites/campus-02');
    expect(status).toBe(200);
    expect(body.dataSource).toBe('demo');

    expect(body.maps).toHaveLength(1);
    expect(body.maps[0].mapId).toBe('map-cam02-3f');
    expect(body.maps[0].imageUrl).toContain('data:image/svg+xml');
    expect(body.maps[0].widthPx).toBe(1200);
    expect(body.maps[0].aps).toHaveLength(2);
    expect(body.maps[0].aps[0]).toMatchObject({ deviceName: 'ap-3f-12', x: 320, y: 240 });

    expect(body.sle.siteId).toBe('campus-02');
    expect(body.sle.overall).toBe(0.96);
    expect(body.sle.metrics.length).toBeGreaterThan(0);

    // Both authored roster clients carrying x/y/mapId land as dots — nothing
    // else about them is served (the page has no client table).
    expect(body.mapClients).toHaveLength(2);
    const mehta = body.mapClients.find((c: { mac: string }) => c.mac === 'de:ad:0b:14:65:22');
    expect(mehta).toMatchObject({ name: 's.mehta', x: 414, y: 296, mapId: 'map-cam02-3f' });
    expect(Object.keys(mehta).sort()).toEqual(['health', 'healthTone', 'mac', 'mapId', 'name', 'x', 'y']);
  });

  it('GET /api/sites/warehouse-dc1 answers the empty forms honestly', async () => {
    const { status, body } = await getJson('/api/sites/warehouse-dc1');
    expect(status).toBe(200);
    expect(body.maps).toEqual([]);
    expect(body.sle).toBeNull();
    expect(body.mapClients).toEqual([]);
    expect(body.rogues).toEqual([]);
  });

  it('GET /api/sites/campus-02 carries the authored rogue report with the on-your-wire row', async () => {
    const { status, body } = await getJson('/api/sites/campus-02');
    expect(status).toBe(200);
    expect(body.rogues).toHaveLength(4);
    const onWire = body.rogues.find((r: { seenOnLan: boolean }) => r.seenOnLan === true);
    expect(onWire).toMatchObject({ bssid: '5c:5b:35:00:0e:77', ssid: 'FREE-CLINIC-WIFI', avgRssi: -48 });
    // The not-reported flag stays null — never an assumed safe-looking false.
    expect(body.rogues.some((r: { seenOnLan: boolean | null }) => r.seenOnLan === null)).toBe(true);
  });

  it('GET /api/systems/mist/audit-log serves the authored org log, deterministic and secret-free', async () => {
    const { status, body } = await getJson('/api/systems/mist/audit-log');
    expect(status).toBe(200);
    expect(body.dataSource).toBe('demo');
    expect(body.auditLog.source).toMatchObject({ plane: 'mist', at: '2026-07-26T11:59:00.000Z', sections: { logs: 'ok' } });
    expect(body.auditLog.entries).toHaveLength(3);
    // Newest first, exactly as authored — a fixed clock, no moving parts.
    expect(body.auditLog.entries.map((e: { id: string }) => e.id)).toEqual(['log-demo-0003', 'log-demo-0002', 'log-demo-0001']);
    expect(body.auditLog.entries[0].before).toContain('<redacted by the portal>');
    expect(JSON.stringify(body.auditLog)).not.toContain('super-secret');
    // The limit parameter is honoured.
    const limited = await getJson('/api/systems/mist/audit-log?limit=1');
    expect(limited.body.auditLog.entries).toHaveLength(1);
  });

  it('GET /api/sites/:siteId/sle/:metric serves the authored drill-down', async () => {
    const { status, body } = await getJson('/api/sites/campus-02/sle/coverage');
    expect(status).toBe(200);
    expect(body.sleDetail.metric).toBe('coverage');
    expect(body.sleDetail.classifiers.map((c: { name: string }) => c.name)).toEqual([
      'signal-strength',
      'interference',
    ]);
    expect(body.sleDetail.impactedClients[0]).toMatchObject({ mac: 'de:ad:0b:14:65:22', name: 's.mehta' });
    expect(body.sleDetail.impactedAps[0]).toMatchObject({ name: 'ap-3f-14' });
    expect(body.sleDetail.trend.total).toHaveLength(24);
    expect(body.sleDetail.source.sections).toEqual({
      classifiers: 'ok',
      impactedClients: 'ok',
      impactedAps: 'ok',
      trend: 'ok',
    });
  });

  it('the demo drill 404s a drill the demo world did not author', async () => {
    const { status, body } = await getJson('/api/sites/campus-02/sle/roaming');
    expect(status).toBe(404);
    expect(body.error).toContain("no SLE drill-down recorded for 'roaming'");
  });

  it('the demo drill 404s an unknown site rather than fabricating one', async () => {
    const { status } = await getJson('/api/sites/no-such-place/sle/coverage');
    expect(status).toBe(404);
  });
});

describe('site detail Mist keys — live mode', () => {
  let contributions: Map<string, unknown>;
  let planes: { get(id: string): Record<string, unknown> };
  let clearDetailCache: () => void;
  const undo: Array<() => void> = [];

  const MIST_AP = {
    name: 'ap-live-1',
    model: 'AP43',
    type: 'ap',
    siteId: 'campus-02',
    siteName: 'Campus-02 Research',
    plane: 'MIST',
    planeTone: 'info',
    state: 'up',
    stateTone: 'success',
    firmware: '0.14.28552',
    firmwareApproved: true,
    licence: 'SUB-MAN',
    reconciliationIssue: false,
    localShell: false,
    serial: 'MST43LIVE1',
  };

  const LOCATED_CLIENT = {
    name: 's.mehta',
    model: 'iPhone 16',
    type: 'phone',
    mac: 'DE:AD:0B:14:65:22',
    ip: '10.44.12.140',
    medium: 'wireless',
    siteId: 'campus-02',
    siteName: 'Campus-02 Research',
    group: 'clinical-floors',
    attach: 'ap-live-1',
    where: '3F east',
    plane: 'MIST',
    planeTone: 'info',
    auth: '802.1X',
    authBy: 'clearpass',
    role: 'Clinical staff',
    vlan: 'vlan 820',
    health: 'sticky client',
    healthTone: 'warning',
    session: '48m',
    problem: true,
    link: '2.4 GHz · ch 6 · 20 MHz',
    rssi: '−71 dBm',
    snr: '21 dB',
    retries: '11.2%',
    tput: '144 Mbps',
    roams: '0',
    quality: 52,
    zone: '3F east',
    closet: 'IDF-3F-A',
    x: 414,
    y: 296,
    mapId: 'map-live-1',
  };

  const LIVE_MAP = {
    siteId: 'campus-02',
    siteName: 'Campus-02 Research',
    mapId: 'map-live-1',
    name: 'Live floor',
    imageUrl: 'https://api.mist.com/api/v1/sites/s1/maps/map-live-1.png',
    widthPx: 800,
    heightPx: 600,
    widthM: null,
    heightM: null,
    orientationDeg: null,
    aps: [{ deviceName: 'ap-live-1', deviceUuid: null, mac: null, x: 100, y: 120 }],
  };

  const OTHER_SITE_MAP = { ...LIVE_MAP, siteId: 'northgate', siteName: 'Northgate Clinic', mapId: 'map-ng-1' };

  const LIVE_SLE = {
    siteId: 'campus-02',
    siteName: 'Campus-02 Research',
    coverage: 0.9,
    capacity: null,
    roaming: null,
    apHealth: null,
    wan: null,
    overall: 0.9,
  };

  const DRILL = {
    siteId: 'campus-02',
    siteName: 'Campus-02 Research',
    metric: 'coverage',
    classifiers: [{ name: 'signal-strength', samples: 10, degraded: 10, durationSec: 600, impact: null }],
    impactedClients: [],
    impactedAps: [],
    trend: { startSec: null, endSec: null, intervalSec: null, total: [], degraded: [] },
    source: {
      plane: 'mist',
      at: new Date().toISOString(),
      sections: { classifiers: 'ok', impactedClients: 'empty', impactedAps: 'empty', trend: 'empty' },
    },
  };

  function stub(plane: string, methods: Record<string, unknown>): void {
    const adapter = planes.get(plane);
    const keys = Object.keys(methods);
    for (const k of keys) adapter[k] = methods[k];
    undo.push(() => {
      for (const k of keys) delete adapter[k];
    });
  }

  const setDemoMode = (demoMode: boolean) =>
    fetch(`${base}/api/settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ demoMode }),
    });

  beforeAll(async () => {
    const { poller } = await import('../src/services/poller');
    const { registry } = await import('../src/planes/registry');
    const screens = await import('../src/routes/screens');
    contributions = (poller as unknown as { contributions: Map<string, unknown> }).contributions;
    planes = registry as unknown as { get(id: string): Record<string, unknown> };
    clearDetailCache = screens.resetDetailCache;
    await setDemoMode(false);
  });

  afterEach(() => {
    while (undo.length > 0) undo.pop()!();
    contributions.clear();
    clearDetailCache();
  });

  afterAll(async () => {
    contributions.clear();
    await setDemoMode(true);
  });

  it('a live site page carries the Mist maps, SLE row and located-client dots for THIS site only', async () => {
    contributions.set('mist', {
      devices: [MIST_AP],
      clients: [LOCATED_CLIENT, { ...LOCATED_CLIENT, name: 'other', mac: '00:11:22:33:44:55', siteId: 'northgate', siteName: 'Northgate Clinic' }],
      mistMaps: [LIVE_MAP, OTHER_SITE_MAP],
      mistSle: [LIVE_SLE],
    });
    const { status, body } = await getJson('/api/sites/campus-02');
    expect(status).toBe(200);
    expect(body.maps.map((m: { mapId: string }) => m.mapId)).toEqual(['map-live-1']);
    expect(body.sle).toMatchObject({ siteId: 'campus-02', overall: 0.9 });
    // The northgate client's dot does not leak into this site's payload.
    expect(body.mapClients).toHaveLength(1);
    expect(body.mapClients[0]).toMatchObject({ name: 's.mehta', x: 414, y: 296, mapId: 'map-live-1' });
  });

  it('the drill route calls the adapter once and serves the second open from the TTL cache', async () => {
    contributions.set('mist', { devices: [MIST_AP] });
    const asked: string[] = [];
    stub('mist', {
      mistSleMetricDetail: async (siteId: string, metric: string) => {
        asked.push(`${siteId}|${metric}`);
        return DRILL;
      },
    });
    const first = await getJson('/api/sites/campus-02/sle/coverage');
    expect(first.status).toBe(200);
    expect(first.body.sleDetail.classifiers[0].name).toBe('signal-strength');
    expect(first.body.sleDetail.source.sections.classifiers).toBe('ok');
    expect(first.body.sleDetail.source.cached).toBeFalsy();

    const second = await getJson('/api/sites/campus-02/sle/coverage');
    expect(second.status).toBe(200);
    expect(second.body.sleDetail.source.cached).toBe(true);
    // The portal's site id is the join key; the adapter owns the native-uuid
    // resolution, same as siteTopology.
    expect(asked).toEqual(['campus-02|coverage']);
  });

  it('a drill read that throws becomes a failed payload with the adapter note — never an empty drill', async () => {
    contributions.set('mist', { devices: [MIST_AP] });
    stub('mist', {
      mistSleMetricDetail: async () => {
        throw new Error('mist sle unavailable');
      },
    });
    const { status, body } = await getJson('/api/sites/campus-02/sle/coverage');
    expect(status).toBe(200);
    expect(body.sleDetail.classifiers).toBeUndefined();
    expect(body.sleDetail.source.sections).toEqual({
      classifiers: 'failed',
      impactedClients: 'failed',
      impactedAps: 'failed',
      trend: 'failed',
    });
    expect(body.sleDetail.source.note).toContain('mist sle unavailable');
  });

  it('an adapter without the capability is an honest null, and an unknown site is a 404', async () => {
    contributions.set('mist', { devices: [MIST_AP] });
    const noCapability = await getJson('/api/sites/campus-02/sle/coverage');
    expect(noCapability.status).toBe(200);
    expect(noCapability.body.sleDetail).toBeNull();

    const unknown = await getJson('/api/sites/no-such-place/sle/coverage');
    expect(unknown.status).toBe(404);
  });

  it('a live site page carries the Mist rogue report for THIS site only', async () => {
    contributions.set('mist', {
      devices: [MIST_AP],
      mistRogues: [
        { siteId: 'campus-02', siteName: 'Campus-02 Research', bssid: '5c:5b:35:00:0e:77', ssid: 'FREE-WIFI', channel: 6, avgRssi: -48, numAps: 2, seenOnLan: true },
        { siteId: 'northgate', siteName: 'Northgate Clinic', bssid: '70:a7:41:19:02:3c', ssid: 'Xfinitywifi', channel: 149, avgRssi: -78, numAps: 3, seenOnLan: false },
      ],
    });
    const { status, body } = await getJson('/api/sites/campus-02');
    expect(status).toBe(200);
    expect(body.rogues).toHaveLength(1);
    expect(body.rogues[0]).toMatchObject({ bssid: '5c:5b:35:00:0e:77', seenOnLan: true });
  });

  it('the audit-log route calls the adapter once and serves the second read from the TTL cache', async () => {
    contributions.set('mist', { devices: [MIST_AP] });
    const asked: number[] = [];
    stub('mist', {
      mistAuditLog: async (limit?: number) => {
        asked.push(limit ?? -1);
        return {
          entries: [
            { id: 'log-live-1', at: '2026-08-01T10:00:00.000Z', admin: 'a@b.c', message: 'changed a WLAN', siteId: null, siteName: null },
          ],
          source: { plane: 'mist', at: new Date().toISOString(), sections: { logs: 'ok' } },
        };
      },
    });
    const first = await getJson('/api/systems/mist/audit-log?limit=5');
    expect(first.status).toBe(200);
    expect(first.body.auditLog.entries).toHaveLength(1);
    expect(first.body.auditLog.source.cached).toBeFalsy();
    const second = await getJson('/api/systems/mist/audit-log?limit=5');
    expect(second.body.auditLog.source.cached).toBe(true);
    expect(asked).toEqual([5]);
  });

  it('a failed audit read is a failed section with the note — and no capability is an honest null', async () => {
    contributions.set('mist', { devices: [MIST_AP] });
    stub('mist', {
      mistAuditLog: async () => {
        throw new Error('mist logs unavailable');
      },
    });
    const failed = await getJson('/api/systems/mist/audit-log');
    expect(failed.status).toBe(200);
    expect(failed.body.auditLog.entries).toBeUndefined();
    expect(failed.body.auditLog.source.sections).toEqual({ logs: 'failed' });
    expect(failed.body.auditLog.source.note).toContain('mist logs unavailable');
  });

  it('the audit-log route answers null when no linked plane can read it', async () => {
    // Nothing stubbed: the unconfigured Mist adapter has no mistAuditLog.
    const { status, body } = await getJson('/api/systems/mist/audit-log');
    expect(status).toBe(200);
    expect(body.auditLog).toBeNull();
  });
});
