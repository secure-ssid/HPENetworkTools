/**
 * server/tests/deviceTrendsRoutes.test.ts — the on-demand device trend routes
 * (/api/devices/:name/trends/hardware|interfaces|ap/:metric) in both modes.
 *
 * Same harness as siteDetailMist.test.ts: an in-process app on an ephemeral
 * port with settings/data redirected to a tmp dir; live tests seed the
 * poller's contributions by hand and stub the Central adapter's lazy methods.
 *
 * Demo mode serves the authored reads by device NAME and 404s a device the
 * demo world did not author one for. Live mode resolves the reconciled row,
 * walks the claiming planes for the capability, refuses reads the device
 * class cannot answer BEFORE spending a call, and turns a throwing adapter
 * into a failed payload with the note — never an empty chart.
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
  tmpDir = mkdtempSync(join(tmpdir(), 'hpe-device-trends-'));
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

describe('device trend routes — demo mode', () => {
  it('GET /api/devices/sw-core-a/trends/hardware serves the authored read, gap markers included', async () => {
    const { status, body } = await getJson('/api/devices/sw-core-a/trends/hardware');
    expect(status).toBe(200);
    expect(body.dataSource).toBe('demo');
    const live = body.hardwareTrends;
    expect(live.source.sections).toEqual({ hardware: 'ok' });
    expect(live.source.plane).toBe('central');
    expect(live.trends.ok).toBe(true);
    // The seven hardware series, in the endpoint's own order.
    expect(live.trends.series.map((s: { key: string }) => s.key)).toEqual([
      'cpuUtilization',
      'memoryUtilization',
      'systemTemperature',
      'poeAvailable',
      'poeConsumption',
      'powerConsumption',
      'totalPowerConsumption',
    ]);
    // The authored 03:00–05:00 telemetry outage is an explicit null marker,
    // never a bridged line: the cpu series breaks at exactly one point.
    const cpu = live.trends.series[0];
    const holes = cpu.points.filter((p: { v: number | null }) => p.v === null);
    expect(holes).toHaveLength(1);
    // 24 hourly buckets minus the two skipped, plus the one gap marker.
    expect(cpu.points).toHaveLength(23);
  });

  it('GET /api/devices/sw-core-a/trends/interfaces serves counters differentiated into rates', async () => {
    const { status, body } = await getJson('/api/devices/sw-core-a/trends/interfaces');
    expect(status).toBe(200);
    const live = body.interfaceTrends;
    expect(live.source.sections).toEqual({ interfaces: 'ok' });
    const tx = live.trends.series.find((s: { key: string }) => s.key === 'txBytes');
    expect(tx.kind).toBe('counter');
    expect(tx.rate).toBe('bits-per-second');
    // The first sample of a counter series has no predecessor — a hole, never
    // a rate; the second is the hourly increment scaled by 8 into bit/s.
    expect(tx.points[0].v).toBeNull();
    expect(tx.points[1].v).toBeCloseTo((1_280_000_000_000 * 8) / 3600, 0);
    // The CRC burst is real data: inCrcErrors moves in the last four buckets.
    const crc = live.trends.series.find((s: { key: string }) => s.key === 'inCrcErrors');
    const tail = crc.points.slice(-1)[0];
    expect(tail.v).toBeCloseTo(6 / 3600, 6);
  });

  it('GET /api/devices/ap-1f-04/trends/ap/throughput converts bytes-per-bucket to bit/s', async () => {
    const { status, body } = await getJson('/api/devices/ap-1f-04/trends/ap/throughput');
    expect(status).toBe(200);
    const live = body.apTrends;
    expect(live.metric).toBe('throughput');
    expect(live.source.sections).toEqual({ trends: 'ok' });
    const series = live.trends.series[0];
    expect(series.kind).toBe('bucket-total');
    expect(series.rate).toBe('bits-per-second');
    // Hour 0: 130e9 bytes over a 3600s bucket → 130e9*8/3600 bit/s. A
    // bucket-total needs no predecessor, so the first point is a real rate.
    expect(series.points[0].v).toBeCloseTo((130_000_000_000 * 8) / 3600, 0);
  });

  it('404s a device the demo world authored no read for, an unknown device, and an unknown metric', async () => {
    const noRead = await getJson('/api/devices/sw-core-b/trends/hardware');
    expect(noRead.status).toBe(404);
    expect(noRead.body.error).toContain("no hardware-trend read recorded for 'sw-core-b'");

    const unknown = await getJson('/api/devices/no-such-device/trends/hardware');
    expect(unknown.status).toBe(404);

    const badMetric = await getJson('/api/devices/ap-1f-04/trends/ap/bogus');
    expect(badMetric.status).toBe(404);
    expect(badMetric.body.error).toContain("unknown AP trend metric 'bogus'");
  });
});

describe('device trend routes — live mode', () => {
  let contributions: Map<string, unknown>;
  let planes: { get(id: string): Record<string, unknown> };
  let clearDetailCache: () => void;
  const undo: Array<() => void> = [];

  const CENTRAL_SWITCH = {
    name: 'sw-live-1',
    model: 'CX 6300M-48G',
    type: 'switch',
    siteId: 'campus-02',
    siteName: 'Campus-02 Research',
    plane: 'CENTRAL',
    planeTone: 'accent',
    state: 'up',
    stateTone: 'success',
    firmware: '10.13.1005',
    firmwareApproved: true,
    licence: 'Foundation',
    reconciliationIssue: false,
    localShell: false,
    serial: 'CSLIVE1',
  };

  const LOCAL_SWITCH = {
    ...CENTRAL_SWITCH,
    name: 'sw-local-1',
    plane: 'LOCAL',
    planeTone: 'neutral',
    serial: 'LSW1',
  };

  const CENTRAL_AP = {
    ...CENTRAL_SWITCH,
    name: 'ap-live-1',
    type: 'ap',
    serial: 'CAPLIVE1',
  };

  const HW_TRENDS = {
    serial: 'CSLIVE1',
    window: { start: '2026-07-27T12:00:00.000Z', end: '2026-07-28T12:00:00.000Z' },
    trends: {
      ok: true,
      series: [
        {
          key: 'cpuUtilization',
          kind: 'gauge',
          rate: null,
          bucketMs: 3_600_000,
          samples: 2,
          points: [
            { t: '2026-07-27T12:00:00.000Z', v: 14 },
            { t: '2026-07-27T13:00:00.000Z', v: 15 },
          ],
        },
      ],
    },
    source: { plane: 'central', at: new Date().toISOString(), sections: { hardware: 'ok' } },
  };

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

  function stub(plane: string, methods: Record<string, unknown>): void {
    const adapter = planes.get(plane);
    const keys = Object.keys(methods);
    for (const k of keys) adapter[k] = methods[k];
    undo.push(() => {
      for (const k of keys) delete adapter[k];
    });
  }

  it('serves the adapter read with the requested window, and the second open from the TTL cache', async () => {
    contributions.set('central', { devices: [CENTRAL_SWITCH] });
    const asked: Array<string> = [];
    stub('central', {
      switchHardwareTrends: async (serial: string, window: { start: string; end: string }) => {
        asked.push(`${serial}|${window.start}|${window.end}`);
        return HW_TRENDS;
      },
    });
    const qs = '?start=2026-07-27T12:00:00.000Z&end=2026-07-28T12:00:00.000Z';
    const first = await getJson(`/api/devices/sw-live-1/trends/hardware${qs}`);
    expect(first.status).toBe(200);
    expect(first.body.hardwareTrends.trends.series[0].points[1].v).toBe(15);
    expect(first.body.hardwareTrends.source.cached).toBeFalsy();
    expect(asked).toEqual(['CSLIVE1|2026-07-27T12:00:00.000Z|2026-07-28T12:00:00.000Z']);

    const second = await getJson(`/api/devices/sw-live-1/trends/hardware${qs}`);
    expect(second.status).toBe(200);
    expect(second.body.hardwareTrends.source.cached).toBe(true);
    expect(asked).toHaveLength(1);
  });

  it('an adapter without the capability is an honest null, and a non-switch is refused before any call', async () => {
    // LOCAL-claimed only — no claiming plane's adapter grows the trend reads,
    // so the route answers null rather than implying the plane has no telemetry.
    contributions.set('local', { devices: [LOCAL_SWITCH] });
    const none = await getJson('/api/devices/sw-local-1/trends/hardware');
    expect(none.status).toBe(200);
    expect(none.body.hardwareTrends).toBeNull();

    contributions.set('central', { devices: [CENTRAL_AP] });
    const called: string[] = [];
    stub('central', {
      switchHardwareTrends: async (serial: string) => {
        called.push(serial);
        return HW_TRENDS;
      },
    });
    const notSwitch = await getJson('/api/devices/ap-live-1/trends/hardware');
    expect(notSwitch.status).toBe(404);
    expect(notSwitch.body.error).toContain('not a switch');
    expect(called).toHaveLength(0); // refused before spending a metered call
  });

  it('a read that throws becomes a failed payload with the note — never an empty chart', async () => {
    contributions.set('central', { devices: [CENTRAL_SWITCH] });
    stub('central', {
      switchHardwareTrends: async () => {
        throw new Error('central token refresh failed');
      },
    });
    const { status, body } = await getJson('/api/devices/sw-live-1/trends/hardware');
    expect(status).toBe(200);
    expect(body.hardwareTrends.trends).toBeUndefined();
    expect(body.hardwareTrends.source.sections).toEqual({ hardware: 'failed' });
    expect(body.hardwareTrends.source.note).toContain('central token refresh failed');
  });

  it('walks the claiming planes: a double-claimed row is asked of the plane that can answer', async () => {
    // Central outranks LOCAL (PLANE_RANK), so the display row is Central's —
    // but the assertion here is the walk itself: the reconciled row's claim
    // list is consulted in order and the first plane WITH the capability is
    // asked, identified by the row's serial.
    const doubleClaimed = {
      ...CENTRAL_SWITCH,
      name: 'sw-double-1',
      plane: 'LOCAL',
      planeTone: 'neutral',
      claimedBy: ['LOCAL', 'CENTRAL'],
      serial: 'CDOUBLE1',
    };
    contributions.set('local', { devices: [doubleClaimed] });
    contributions.set('central', { devices: [{ ...doubleClaimed, plane: 'CENTRAL', planeTone: 'accent' }] });
    const asked: string[] = [];
    stub('central', {
      switchHardwareTrends: async (serial: string) => {
        asked.push(serial);
        return HW_TRENDS;
      },
    });
    const { status, body } = await getJson('/api/devices/sw-double-1/trends/hardware?serial=CDOUBLE1');
    expect(status).toBe(200);
    expect(asked).toEqual(['CDOUBLE1']);
    expect(body.hardwareTrends.source.plane).toBe('central');
  });

  it('resolves by serial over name, and 404s a device the live cache does not hold', async () => {
    contributions.set('central', { devices: [CENTRAL_SWITCH] });
    stub('central', {
      switchInterfaceTrends: async (serial: string) => {
        expect(serial).toBe('CSLIVE1');
        return { ...HW_TRENDS, source: { ...HW_TRENDS.source, sections: { interfaces: 'ok' } } };
      },
    });
    const bySerial = await getJson('/api/devices/whatever-name/trends/interfaces?plane=CENTRAL&serial=CSLIVE1');
    expect(bySerial.status).toBe(200);
    expect(bySerial.body.interfaceTrends.source.sections).toEqual({ interfaces: 'ok' });

    const missing = await getJson('/api/devices/ghost-1/trends/hardware');
    expect(missing.status).toBe(404);
  });

  it('serves AP trend metrics for a Central AP, and refuses a switch asked for one', async () => {
    contributions.set('central', { devices: [CENTRAL_AP, CENTRAL_SWITCH] });
    const asked: string[] = [];
    stub('central', {
      apTrends: async (serial: string, metric: string) => {
        asked.push(`${serial}|${metric}`);
        return { ...HW_TRENDS, serial, metric, source: { ...HW_TRENDS.source, sections: { trends: 'ok' } } };
      },
    });
    const ap = await getJson('/api/devices/ap-live-1/trends/ap/cpu');
    expect(ap.status).toBe(200);
    expect(ap.body.apTrends.metric).toBe('cpu');
    expect(asked).toEqual(['CAPLIVE1|cpu']);

    const notAp = await getJson('/api/devices/sw-live-1/trends/ap/cpu');
    expect(notAp.status).toBe(404);
    expect(notAp.body.error).toContain('not an AP');
    expect(asked).toHaveLength(1); // still just the AP call — the refusal cost nothing
  });
});
