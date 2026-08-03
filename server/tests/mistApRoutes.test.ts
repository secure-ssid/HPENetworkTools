/**
 * server/tests/mistApRoutes.test.ts — the Mist AP rich-stats dataset on the
 * screen payloads, and the LLDP-derived site topology fallback.
 *
 * In-process app on an ephemeral port (same harness as routes.test.ts):
 * HPE_SETTINGS_PATH/HPE_DATA_DIR point at a tmp dir so nothing here touches
 * the real data/ files. Coverage:
 *   (a) DEMO device detail — the fixture Mist APs carry their stats row on
 *       `mistAp` (radios, env, power, LLDP), the AP32 keeps env null, and a
 *       non-Mist device gets an explicit null rather than an absent key.
 *   (b) LIVE device detail — the row is joined off the Mist poll by serial,
 *       and a device the stats walk did not carry reads null.
 *   (c) LIVE site topology — when Mist publishes no /topology graph the site
 *       page's graph is built from the APs' own LLDP uplink reports (edgeType
 *       'LLDP', provenance note, neighbour dedupe, unreachables counted);
 *       a plane graph that DID answer always wins, and a failed read is
 *       never swapped for the prettier data.
 *   (d) UNIT — mistApStatsFor identity precedence and mistLldpTopology's
 *       edge/node shaping rules.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

let server: Server;
let base: string;
let tmpDir: string;

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'hpe-mist-ap-routes-'));
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

// ---------------------------------------------------------------------------
// (a) demo payloads
// ---------------------------------------------------------------------------

describe('demo device detail carries the fixture Mist AP stats row', () => {
  it('ap-3f-12: the full RF/env/power/LLDP row, joined to the fixture device', async () => {
    const { status, body } = await getJson('/api/devices/ap-3f-12');
    expect(status).toBe(200);
    expect(body.dataSource).toBe('demo');
    expect(body.mistAp.deviceName).toBe('ap-3f-12');
    expect(body.mistAp.serial).toBe('MST43KF1201');
    expect(body.mistAp.radios.map((r: any) => r.band)).toEqual(['2.4 GHz', '5 GHz']);
    expect(body.mistAp.radios[0]).toMatchObject({
      channel: 6,
      utilAllPct: 58,
      utilTxPct: 22,
      utilRxInBssPct: 18,
      utilRxOtherBssPct: 14,
      utilNonWifiPct: 4,
    });
    expect(body.mistAp.env.ambientTempC).toBe(23.8);
    expect(body.mistAp.powerSrc).toBe('PoE 802.3at');
    expect(body.mistAp.powerConstrained).toBe(false);
    expect(body.mistAp.lldpUplink).toMatchObject({ systemName: 'sw-cam02-1', portId: 'ge-0/0/12' });
    // The claim code rides the device row (the demo fixtures carry it).
    expect(body.device.claimCode).toBe('KV4M9Q2X7RND3H1');
  });

  it('ap-ng-02: env stays null — the AP32 sensor story survives the wire', async () => {
    const { status, body } = await getJson('/api/devices/ap-ng-02');
    expect(status).toBe(200);
    expect(body.mistAp.deviceName).toBe('ap-ng-02');
    expect(body.mistAp.env).toBeNull();
    expect(body.mistAp.powerConstrained).toBe(false);
  });

  it('ap-3f-14: the PoE-constrained DFS-ticket AP keeps both its firmware words', async () => {
    const { status, body } = await getJson('/api/devices/ap-3f-14');
    expect(status).toBe(200);
    expect(body.mistAp.powerConstrained).toBe(true);
    expect(body.device.firmwareTarget).toBe('0.14.29');
    expect(body.device.firmwareUpdate).toBe('inprogress');
    expect(body.device.firmwareApproved).toBe(false);
  });

  it('a non-Mist device gets an explicit null, not an absent key or a guessed row', async () => {
    const { status, body } = await getJson('/api/devices/sw-core-a');
    expect(status).toBe(200);
    expect(body.mistAp).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// (b) + (c) live payloads — seeded poller contributions, stubbed adapters
// ---------------------------------------------------------------------------

describe('live Mist AP stats payloads', () => {
  let contributions: Map<string, unknown>;
  let planes: { get(id: string): Record<string, unknown> };
  let clearDetailCache: () => void;
  const undo: Array<() => void> = [];

  const setDemoMode = (demoMode: boolean) =>
    fetch(`${base}/api/settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ demoMode }),
    });

  const AP = {
    name: 'ap-mist-1',
    model: 'AP43',
    type: 'ap',
    siteId: 'campus-02',
    siteName: 'Campus-02 Research',
    plane: 'MIST',
    planeTone: 'info',
    state: 'up',
    stateTone: 'success',
    firmware: '0.14.29',
    firmwareApproved: true,
    licence: 'unknown',
    reconciliationIssue: false,
    localShell: false,
    serial: 'MST43KF9001',
    mac: '3c:52:82:3f:90:01',
  };
  // A second AP uplinking to the SAME neighbour chassis — the dedupe case.
  const AP2 = { ...AP, name: 'ap-mist-2', serial: 'MST43KF9002', mac: '3c:52:82:3f:90:02' };
  const SITE = {
    id: 'campus-02',
    name: 'Campus-02 Research',
    subnet: '—',
    planes: [{ name: 'MIST', tone: 'info' }],
    mix: '—',
    devices: 2,
    clients: '—',
    health: null,
    healthPct: '—',
    tone: 'stale',
    alerts: '—',
    alertTone: 'neutral',
    sync: '1m',
  };
  const statsRow = (over: Record<string, unknown>) => ({
    deviceName: 'ap-mist-1',
    deviceUuid: '00000000-0000-0000-1000-3c52823f9001',
    mac: '3c:52:82:3f:90:01',
    serial: 'MST43KF9001',
    siteId: 'campus-02',
    siteName: 'Campus-02 Research',
    numClients: 7,
    cpuUtilPct: 19,
    memTotalKb: 997_376,
    memUsedKb: 401_408,
    uptimeSec: 900_000,
    rxBps: null,
    txBps: null,
    extIp: null,
    dns: null,
    gateway: null,
    dhcpServer: null,
    powerSrc: 'PoE 802.3at',
    powerConstrained: false,
    radios: [
      {
        band: '5 GHz',
        channel: 36,
        bandwidthMHz: 40,
        powerDbm: 14,
        noiseFloorDbm: -96,
        utilAllPct: 31,
        utilTxPct: 12,
        utilRxInBssPct: 9,
        utilRxOtherBssPct: 7,
        utilNonWifiPct: 3,
        numClients: 7,
      },
    ],
    ports: [
      {
        name: 'eth0',
        up: true,
        speedMbps: 1000,
        fullDuplex: true,
        rxBytes: 1_000,
        txBytes: 2_000,
        rxErrors: 0,
        txErrors: 0,
        peakBps: null,
      },
    ],
    env: { ambientTempC: 22.4, pressureHpa: null, humidityPct: 40, accelX: null, accelY: null, accelZ: null },
    lldpUplink: {
      systemName: 'CX6300-CORE',
      systemDesc: 'HPE JL660A',
      portId: '1/1/5',
      chassisId: '3c:52:82:c0:99:01',
      mgmtAddr: '10.44.1.2',
    },
    ...over,
  });

  const source = (sections: Record<string, string>) => ({
    plane: 'mist',
    at: new Date().toISOString(),
    sections,
  });

  /** Attach stub methods to a plane's LIVE adapter instance, with teardown. */
  function stub(plane: string, methods: Record<string, unknown>): void {
    const adapter = planes.get(plane);
    const keys = Object.keys(methods);
    for (const k of keys) adapter[k] = methods[k];
    undo.push(() => {
      for (const k of keys) delete adapter[k];
    });
  }

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

  it('device detail joins the stats row off the poll by serial — no per-object call', async () => {
    contributions.set('mist', { devices: [AP], sites: [SITE], mistApStats: [statsRow({})] });
    const { status, body } = await getJson('/api/devices/ap-mist-1');
    expect(status).toBe(200);
    expect(body.mistAp.serial).toBe('MST43KF9001');
    expect(body.mistAp.radios[0]).toMatchObject({ band: '5 GHz', utilRxOtherBssPct: 7 });
    expect(body.mistAp.env.ambientTempC).toBe(22.4);
    expect(body.mistAp.lldpUplink).toMatchObject({ systemName: 'CX6300-CORE', portId: '1/1/5' });
  });

  it('a device the stats walk did not carry reads an explicit null', async () => {
    contributions.set('mist', { devices: [AP2], sites: [SITE], mistApStats: [statsRow({})] });
    const { status, body } = await getJson('/api/devices/ap-mist-2');
    expect(status).toBe(200);
    expect(body.device.name).toBe('ap-mist-2');
    expect(body.mistAp).toBeNull();
  });

  it('site topology falls back to the APs’ own LLDP uplinks when Mist publishes no graph', async () => {
    // No siteTopology stub: the real adapter answers null for a site it has
    // never pulled (nativeSiteIds is empty), exactly the "no graph" path.
    contributions.set('mist', {
      devices: [AP, AP2],
      sites: [SITE],
      mistApStats: [
        statsRow({}),
        statsRow({
          deviceName: 'ap-mist-2',
          deviceUuid: '00000000-0000-0000-1000-3c52823f9002',
          serial: 'MST43KF9002',
          mac: '3c:52:82:3f:90:02',
          lldpUplink: {
            systemName: 'CX6300-CORE',
            systemDesc: 'HPE JL660A',
            portId: '1/1/6',
            chassisId: '3c:52:82:c0:99:01',
            mgmtAddr: '10.44.1.2',
          },
        }),
        // A third AP whose row carried no lldp_stat: real, and unreachable by
        // this graph — counted, never drawn.
        statsRow({
          deviceName: 'ap-mist-3',
          deviceUuid: '00000000-0000-0000-1000-3c52823f9003',
          serial: 'MST43KF9003',
          mac: '3c:52:82:3f:90:03',
          lldpUplink: null,
        }),
      ],
    });
    const { status, body } = await getJson('/api/sites/campus-02');
    expect(status).toBe(200);
    expect(body.topology.source.plane).toBe('mist');
    expect(body.topology.source.sections).toEqual({ nodes: 'ok', links: 'ok' });
    expect(body.topology.source.note).toContain('LLDP');
    // Two edges, both typed by their evidence.
    expect(body.topology.links).toHaveLength(2);
    expect(body.topology.links.every((l: any) => l.edgeType === 'LLDP')).toBe(true);
    const first = body.topology.links.find((l: any) => l.from === 'MST43KF9001');
    expect(first.to).toBe('3c:52:82:c0:99:01');
    expect(first.fromPorts.map((p: any) => p.name)).toEqual(['eth0']);
    expect(first.toPorts.map((p: any) => p.name)).toEqual(['1/1/5']);
    expect(first.speedBps).toBe(1_000_000_000);
    // One shared neighbour node for both APs (chassis-id dedupe), so three
    // nodes total; the neighbour is honest about being unmanaged, with its
    // own system description as the model.
    expect(body.topology.nodes).toHaveLength(3);
    const neighbour = body.topology.nodes.find((n: any) => n.serial === '3c:52:82:c0:99:01');
    expect(neighbour).toMatchObject({ name: 'CX6300-CORE', type: 'Unmanaged', model: 'HPE JL660A' });
    // The third AP is counted as unreached, not silently dropped.
    expect(body.topology.isolatedDevicesCount).toBe(1);
  });

  it('a plane graph that answered always wins over the LLDP fallback', async () => {
    contributions.set('mist', { devices: [AP], sites: [SITE], mistApStats: [statsRow({})] });
    stub('mist', {
      siteTopology: async (siteId: string) => ({
        siteId,
        nodes: [
          { serial: 'SW1', name: 'core-1', type: 'Switch', deviceFunction: '-', status: 'ONLINE', health: 'Good', healthReason: null, model: null, ipv4: null, mac: null },
        ],
        links: [],
        source: source({ nodes: 'ok', links: 'empty' }),
      }),
    });
    const { status, body } = await getJson('/api/sites/campus-02');
    expect(status).toBe(200);
    expect(body.topology.nodes).toHaveLength(1);
    expect(body.topology.nodes[0].name).toBe('core-1');
    expect(body.topology.links).toEqual([]);
    expect(body.topology.source.note ?? '').not.toContain('LLDP');
  });

  it('a failed topology read keeps its failure — the LLDP graph never launders it', async () => {
    contributions.set('mist', { devices: [AP], sites: [SITE], mistApStats: [statsRow({})] });
    stub('mist', {
      siteTopology: async () => {
        throw new Error('mist topology unavailable');
      },
    });
    const { status, body } = await getJson('/api/sites/campus-02');
    expect(status).toBe(200);
    expect(body.topology.source.sections).toEqual({ nodes: 'failed', links: 'failed' });
    expect(body.topology.source.note).toContain('mist topology unavailable');
    expect(body.topology.nodes).toBeUndefined();
    expect(body.topology.links).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// (d) unit — the join and the graph builder
// ---------------------------------------------------------------------------

describe('mistApStatsFor / mistLldpTopology units', () => {
  const row = (over: Record<string, unknown>) =>
    ({
      deviceName: 'ap-1',
      deviceUuid: 'uuid-1',
      mac: '3C:52:82:00:00:01',
      serial: 'SN-1',
      siteId: 'campus-02',
      siteName: 'Campus-02 Research',
      numClients: null,
      cpuUtilPct: null,
      memTotalKb: null,
      memUsedKb: null,
      uptimeSec: null,
      rxBps: null,
      txBps: null,
      extIp: null,
      dns: null,
      gateway: null,
      dhcpServer: null,
      powerSrc: null,
      powerConstrained: null,
      radios: [],
      ports: [],
      env: null,
      lldpUplink: null,
      ...over,
    }) as import('@hpe/shared').MistApStatsRow;

  it('serial beats MAC beats name; a wrong-name serial match still wins', async () => {
    const { mistApStatsFor } = await import('../src/routes/screens/mistApStats');
    const rows = [row({}), row({ deviceName: 'ap-1', serial: 'SN-2', mac: null })];
    expect(mistApStatsFor({ name: 'ap-1', serial: 'sn-1' }, rows)?.serial).toBe('SN-1');
    expect(mistApStatsFor({ name: 'other', mac: '3c5282000001' }, rows)?.serial).toBe('SN-1');
    expect(mistApStatsFor({ name: 'ap-1' }, rows)?.serial).toBe('SN-1');
    expect(mistApStatsFor({ name: 'ghost' }, rows)).toBeNull();
  });

  it('no LLDP anywhere means no graph — never an empty invention', async () => {
    const { mistLldpTopology } = await import('../src/routes/screens/mistApStats');
    expect(mistLldpTopology({ id: 'campus-02', name: 'Campus-02 Research' }, [row({})])).toBeNull();
  });

  it('several up ports carry names but no picked speed; zero up ports name nothing', async () => {
    const { mistLldpTopology } = await import('../src/routes/screens/mistApStats');
    const lldp = { systemName: 'sw-1', systemDesc: null, portId: '1/1/5', chassisId: null, mgmtAddr: null };
    const multi = mistLldpTopology({ id: 'campus-02', name: 'Campus-02 Research' }, [
      row({
        lldpUplink: lldp,
        ports: [
          { name: 'eth0', up: true, speedMbps: 1000, fullDuplex: true, rxBytes: null, txBytes: null, rxErrors: null, txErrors: null, peakBps: null },
          { name: 'eth1', up: true, speedMbps: 2500, fullDuplex: true, rxBytes: null, txBytes: null, rxErrors: null, txErrors: null, peakBps: null },
        ],
      }),
    ]);
    expect(multi?.links?.[0]?.fromPorts.map((p) => p.name)).toEqual(['eth0', 'eth1']);
    // lldp_stat names no local port, so with two candidates no speed is chosen.
    expect(multi?.links?.[0]?.speedBps).toBeNull();

    const dark = mistLldpTopology({ id: 'campus-02', name: 'Campus-02 Research' }, [
      row({ lldpUplink: lldp, ports: [] }),
    ]);
    expect(dark?.links?.[0]?.fromPorts).toEqual([]);
    expect(dark?.links?.[0]?.toPorts.map((p) => p.name)).toEqual(['1/1/5']);
    expect(dark?.links?.[0]?.speedBps).toBeNull();
  });

  it('the AP card takes the reconciled row’s own state word, verbatim', async () => {
    const { mistLldpTopology } = await import('../src/routes/screens/mistApStats');
    const graph = mistLldpTopology(
      { id: 'campus-02', name: 'Campus-02 Research' },
      [row({ lldpUplink: { systemName: 'sw-1', systemDesc: null, portId: null, chassisId: null, mgmtAddr: null } })],
      [{ name: 'ap-1', serial: 'SN-1', state: 'down' }],
    );
    expect(graph?.nodes?.find((n) => n.serial === 'SN-1')?.status).toBe('down');
    // A portId-less report still draws the edge — '? ↔ ?' wording is the
    // renderer's, and it beats dropping the adjacency.
    expect(graph?.links?.[0]?.toPorts).toEqual([]);
  });
});
