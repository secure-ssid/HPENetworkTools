/**
 * server/tests/mistScreen.test.ts — GET /api/mist, the composed payload for
 * the Mist operational dashboard.
 *
 * Same harness as siteDetailMist.test.ts: an in-process app on an ephemeral
 * port with settings/data redirected to a tmp dir; live tests seed the
 * poller's contributions by hand.
 *
 * Covered:
 *  - demo mode serves the authored world: the MIST_PLANE_STATUS block, the
 *    SITE_SLE map, MIST_ROGUE_APS, MIST_AP_STATS, MIST_LICENSE_USAGES, the
 *    MIST-badged SSIDS and the MIST DEVICES rows;
 *  - live mode projects the poller cache: a dataset key rides the envelope
 *    ONLY when the Mist pull carried it (absent = not reported, distinct
 *    from present-and-empty), licenseUsages/wlans go explicit-null, devices
 *    are the MIST-claimed reconciled rows, and the plane block is the
 *    registry's own facts.
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
  tmpDir = mkdtempSync(join(tmpdir(), 'hpe-mist-screen-'));
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

describe('GET /api/mist — demo mode', () => {
  it('serves the authored plane block and every fixture dataset', async () => {
    const { status, body } = await getJson('/api/mist');
    expect(status).toBe(200);
    expect(body.dataSource).toBe('demo');

    expect(body.plane).toEqual({
      linked: true,
      health: 'healthy',
      lastSync: '2026-07-26T11:58:00.000Z',
      deviceCount: 128,
      clientCount: 1472,
      note: null,
    });

    // The SLE map is the authored one — only the Mist-managed sites carry a row.
    expect(Object.keys(body.sleBySiteId).sort()).toEqual(['campus-02', 'northgate', 'southpoint']);
    expect(body.sleBySiteId.southpoint.overall).toBe(0.55);

    // The rogue report leads with the on-your-wire finding and keeps the
    // not-reported flag null — never an assumed safe-looking false.
    expect(body.rogues).toHaveLength(5);
    expect(body.rogues.some((r: { seenOnLan: boolean | null }) => r.seenOnLan === true)).toBe(true);
    expect(body.rogues.some((r: { seenOnLan: boolean | null }) => r.seenOnLan === null)).toBe(true);

    expect(body.apStats).toHaveLength(3);
    expect(body.licenseUsages).toHaveLength(3);

    // WLANs are the MIST-badged rows only — the Central-only MRDN-Guest and
    // the AOS-8/CLASSIC rows are not Mist's inventory.
    expect(body.wlans.map((w: { name: string }) => w.name).sort()).toEqual(['MRDN-IoT', 'MRDN-Research', 'MRDN-Staff']);
    expect(body.wlans.every((w: { plane: string }) => w.plane.includes('MIST'))).toBe(true);

    // Devices are the MIST-claimed rows, firmware verdicts included.
    expect(body.devices.map((d: { name: string }) => d.name).sort()).toEqual(['ap-3f-12', 'ap-3f-14', 'ap-ng-02', 'sw-cam02-1']);
    const behind = body.devices.find((d: { name: string }) => d.name === 'ap-3f-14');
    expect(behind).toMatchObject({ firmware: '0.13.18', firmwareApproved: false, firmwareTarget: '0.14.29', firmwareUpdate: 'inprogress' });
  });
});

describe('GET /api/mist — live mode', () => {
  let contributions: Map<string, unknown>;

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
    firmware: '0.13.18',
    firmwareApproved: false,
    firmwareTarget: '0.14.29',
    licence: 'SUB-MAN',
    reconciliationIssue: false,
    localShell: false,
    serial: 'MST43LIVE1',
  };
  const CENTRAL_AP = { ...MIST_AP, name: 'ap-central-1', plane: 'CENTRAL', planeTone: 'accent', serial: 'CENLIVE1' };
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
  const LIVE_WLAN = { kind: 'ssid', name: 'MRDN-Live', vlan: 'vlan 822', security: 'WPA2-PSK', targets: 'Campus-02 Research · enabled', plane: 'MIST', tone: 'info' };

  const setDemoMode = (demoMode: boolean) =>
    fetch(`${base}/api/settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ demoMode }),
    });

  beforeAll(async () => {
    const { poller } = await import('../src/services/poller');
    contributions = (poller as unknown as { contributions: Map<string, unknown> }).contributions;
    await setDemoMode(false);
  });

  afterEach(() => {
    contributions.clear();
  });

  afterAll(async () => {
    contributions.clear();
    await setDemoMode(true);
  });

  it('projects the pull: datasets ride only when carried, devices are the MIST-claimed rows', async () => {
    contributions.set('mist', {
      devices: [MIST_AP],
      clients: [{ mac: 'aa:bb:cc:00:00:01' }, { mac: 'aa:bb:cc:00:00:02' }],
      mistSle: [LIVE_SLE],
      mistRogues: [],
      mistApStats: [],
      mistLicenseUsages: [{ siteId: 'campus-02', siteName: 'Campus-02 Research', numDevices: 1, numAps: 1, usages: { 'SUB-WLAN': 1 }, fullyLoaded: null }],
      config: { mode: 'configured', ssids: [LIVE_WLAN] },
    });
    contributions.set('central', { devices: [CENTRAL_AP] });

    const { status, body } = await getJson('/api/mist');
    expect(status).toBe(200);
    expect(body.dataSource).toBe('live');

    expect(body.sleBySiteId['campus-02']).toMatchObject({ overall: 0.9 });
    // Present-and-empty stays present — a real answer, distinct from absent.
    expect(body.rogues).toEqual([]);
    expect(body.apStats).toEqual([]);
    expect(body.licenseUsages).toHaveLength(1);
    expect(body.wlans).toEqual([LIVE_WLAN]);
    // The plane block counts the pull's own client rows.
    expect(body.plane.clientCount).toBe(2);
    // Only the MIST-claimed device is served — Central's row is not Mist's.
    expect(body.devices.map((d: { name: string }) => d.name)).toEqual(['ap-live-1']);
    expect(body.devices[0]).toMatchObject({ firmwareTarget: '0.14.29', firmwareApproved: false });
  });

  it('omits dataset keys the pull did not carry, with explicit nulls for usages and WLANs', async () => {
    contributions.set('mist', { devices: [MIST_AP] });
    const { body } = await getJson('/api/mist');
    expect('sleBySiteId' in body).toBe(false);
    expect('rogues' in body).toBe(false);
    expect('apStats' in body).toBe(false);
    expect(body.licenseUsages).toBeNull();
    expect(body.wlans).toBeNull();
    // A pull without a clients read reports no client count.
    expect(body.plane.clientCount).toBeNull();
  });

  it('an unlinked, unpulled estate answers the honest empty form', async () => {
    const { status, body } = await getJson('/api/mist');
    expect(status).toBe(200);
    expect(body.dataSource).toBe('live');
    expect(body.plane).toMatchObject({ linked: false, health: 'unlinked', lastSync: null });
    expect(body.syncedAt).toBeNull();
    expect('sleBySiteId' in body).toBe(false);
    expect('rogues' in body).toBe(false);
    expect('apStats' in body).toBe(false);
    expect(body.licenseUsages).toBeNull();
    expect(body.wlans).toBeNull();
    expect(body.devices).toEqual([]);
  });
});
