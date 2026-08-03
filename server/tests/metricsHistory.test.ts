/**
 * server/tests/metricsHistory.test.ts — metrics history, NO network.
 *
 * Service-level tests construct MetricsHistoryService instances with the
 * clock, cadence, sampling predicate and sampler all injected. Route-level
 * tests mount createMetricsRouter with such a service on a bare Express app,
 * plus one createApp() boot to prove the singleton registration.
 *
 * HPE_SETTINGS_PATH and HPE_DATA_DIR point at a tmp dir before any app module
 * is imported (the settings/poller singletons resolve their paths at import),
 * so nothing here touches the real data/ — the same pattern as
 * configBackup.test.ts.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CLIENTS,
  DEVICES,
  METRICS_DEMO_NOTE,
  METRICS_RING_CAPACITY,
  demoMetricsBases,
  demoValue,
  demoWindow,
  planeMetricsKey,
  type MetricsHistoryEnvelope,
} from '@hpe/shared';
import type { PlaneId, PlanePull } from '../src/planes/types';
import type {
  MetricsHistoryService as MetricsHistoryServiceT,
  MetricsSample,
} from '../src/services/metricsHistory';

let MetricsHistoryService: typeof import('../src/services/metricsHistory').MetricsHistoryService;
let sampleFromPulls: typeof import('../src/services/metricsHistory').sampleFromPulls;
let createMetricsRouter: typeof import('../src/routes/metrics').createMetricsRouter;
let createApp: typeof import('../src/index').createApp;

let tmpDir: string;
let appServer: Server;
let appBase: string;

const NOW = Date.parse('2026-07-25T12:00:00Z');

function makeService(opts: {
  intervalMs?: number;
  retentionMs?: number;
  nowMs?: () => number;
  liveSampling?: boolean;
  sample?: () => MetricsSample;
}): MetricsHistoryServiceT {
  return new MetricsHistoryService({
    intervalMs: opts.intervalMs,
    retentionMs: opts.retentionMs,
    nowMs: opts.nowMs ?? (() => NOW),
    liveSampling: () => opts.liveSampling ?? true,
    ...(opts.sample ? { sample: opts.sample } : {}),
  });
}

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'hpe-metrics-'));
  process.env.HPE_SETTINGS_PATH = join(tmpDir, 'settings.json');
  process.env.HPE_DATA_DIR = join(tmpDir, 'data');
  ({ MetricsHistoryService, sampleFromPulls } = await import('../src/services/metricsHistory'));
  ({ createMetricsRouter } = await import('../src/routes/metrics'));
  ({ createApp } = await import('../src/index'));
  appServer = createApp().listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => appServer.once('listening', resolve));
  appBase = `http://127.0.0.1:${(appServer.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => appServer.close(() => resolve()));
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.HPE_SETTINGS_PATH;
  delete process.env.HPE_DATA_DIR;
});

// ---------------------------------------------------------------------------
// sampleFromPulls — the pure cache → counts mapping
// ---------------------------------------------------------------------------

describe('sampleFromPulls', () => {
  it('counts devices, downs, clients and alerts per plane label', () => {
    const pulls = new Map<PlaneId, PlanePull>([
      [
        'central',
        {
          devices: [{ state: 'up' }, { state: 'down' }, { state: 'down' }],
          clients: [{ mac: 'aa:bb:cc:dd:ee:01', attach: 'ap-1' }],
          alerts: [{}, {}],
        } as unknown as PlanePull,
      ],
    ]);
    const sample = sampleFromPulls(pulls);
    expect(sample.planes.CENTRAL).toEqual({ devices: 3, devicesDown: 2, clients: 1, alerts: 2 });
    expect(sample.deviceClients).toEqual({ 'ap-1': 1 });
  });

  it('records nothing for datasets a pull did not carry', () => {
    const pulls = new Map<PlaneId, PlanePull>([
      ['mist', { clients: [] } as unknown as PlanePull],
    ]);
    const sample = sampleFromPulls(pulls);
    // clients was carried (empty): a real zero. devices was not: no key at
    // all, so the series keeps a gap rather than a zero Mist never stated.
    expect(sample.planes.MIST).toEqual({ clients: 0 });
  });

  it('dedupes per-device clients across planes on the normalized MAC', () => {
    const client = (mac: string, attach: string) => ({ mac, attach });
    const pulls = new Map<PlaneId, PlanePull>([
      ['central', { clients: [client('AA-BB-CC-DD-EE-01', 'ap-1'), client('aa:bb:cc:dd:ee:02', 'ap-1')] } as unknown as PlanePull],
      // The same session reported by a second plane must not double the AP's
      // count — nor must a client that names no device count anywhere.
      ['mist', { clients: [client('aa:bb:cc:dd:ee:01', 'ap-1'), client('aa:bb:cc:dd:ee:03', '—')] } as unknown as PlanePull],
    ]);
    expect(sampleFromPulls(pulls).deviceClients).toEqual({ 'ap-1': 2 });
  });
});

// ---------------------------------------------------------------------------
// The ring buffer
// ---------------------------------------------------------------------------

describe('MetricsHistoryService rings', () => {
  it('drops the oldest point past capacity', () => {
    // retention 3000 / interval 1000 → capacity 3
    let t = NOW;
    let current = 0;
    const service = makeService({
      intervalMs: 1_000,
      retentionMs: 3_000,
      nowMs: () => t,
      sample: () => ({ planes: { CENTRAL: { devices: current } }, deviceClients: { 'ap-1': current } }),
    });
    for (let i = 0; i < 5; i += 1) {
      current = i + 1;
      service.sampleNow();
      t += 1_000;
    }
    const ring = service.series('plane:CENTRAL:devices');
    expect(ring.map((p) => p.v)).toEqual([3, 4, 5]);
    expect(ring[0]!.t).toBe(new Date(NOW + 2_000).toISOString());
    expect(service.series('device:ap-1').map((p) => p.v)).toEqual([3, 4, 5]);
  });

  it('never samples when nothing is polling (demo), and the envelope says so', () => {
    const service = makeService({ liveSampling: false });
    expect(service.sampleNow()).toBe(false);
    const envelope = service.envelope();
    expect(envelope.dataSource).toBe('demo');
    expect(envelope.note).toBe(METRICS_DEMO_NOTE);
  });

  it('an in-flight sample is never stacked by a reentrant tick', () => {
    const reentrantCalls: boolean[] = [];
    const service = makeService({
      sample: () => {
        // The guard makes this inner call a skip rather than a recursion.
        reentrantCalls.push(service.sampleNow());
        return { planes: {}, deviceClients: {} };
      },
    });
    expect(service.sampleNow()).toBe(true);
    expect(reentrantCalls).toEqual([false]);
  });

  it('envelope() reports the ring contents with an honest since', () => {
    const service = makeService({ sample: () => ({ planes: { MIST: { clients: 7 } }, deviceClients: {} }) });
    service.sampleNow();
    const envelope = service.envelope();
    expect(envelope.dataSource).toBe('live');
    expect(envelope.since).toBe(new Date(NOW).toISOString());
    expect(envelope.planes.MIST?.clients).toEqual([{ t: new Date(NOW).toISOString(), v: 7 }]);
    // A metric the sample never carried has no series — not even an empty
    // claim. (The key exists on the wire shape only once sampled.)
    expect(envelope.planes.MIST?.devices).toEqual([]);
    expect(envelope.deviceClients).toEqual({});
  });

  it('start() takes an immediate sample and stop() clears the timer', () => {
    const service = makeService({ sample: () => ({ planes: { LOCAL: { devices: 4 } }, deviceClients: {} }) });
    expect(service.isRunning()).toBe(false);
    service.start();
    try {
      expect(service.isRunning()).toBe(true);
      expect(service.series('plane:LOCAL:devices')).toHaveLength(1);
      service.start(); // idempotent — still one timer, still one sample
      expect(service.series('plane:LOCAL:devices')).toHaveLength(1);
    } finally {
      service.stop();
    }
    expect(service.isRunning()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Demo synthesis — deterministic, fixture-based
// ---------------------------------------------------------------------------

describe('demo synthesis', () => {
  it('is a pure function of the sample timestamp', () => {
    expect(demoValue('CENTRAL:devices', 10, 2, NOW)).toBe(demoValue('CENTRAL:devices', 10, 2, NOW));
    expect(demoWindow('x', 5, 1, NOW)).toEqual(demoWindow('x', 5, 1, NOW));
  });

  it('never synthesizes a negative count', () => {
    for (let i = 0; i < 500; i += 1) {
      expect(demoValue('tiny', 1, 3, NOW + i * 60_000)).toBeGreaterThanOrEqual(0);
    }
  });

  it('two envelopes at the same clock are identical, and agree on overlapping buckets across time', () => {
    const a = makeService({ liveSampling: false }).envelope();
    const b = makeService({ liveSampling: false }).envelope();
    expect(a).toEqual(b);
    // One sample-interval later: the window shifts by one bucket, but every
    // overlapping timestamp keeps its value — history does not rewrite itself.
    const later = makeService({ liveSampling: false, nowMs: () => NOW + 5 * 60_000 }).envelope();
    const before = new Map(a.planes.CENTRAL!.devices.map((p) => [p.t, p.v]));
    for (const p of later.planes.CENTRAL!.devices) {
      if (before.has(p.t)) expect(p.v).toBe(before.get(p.t));
    }
  });

  it('fills the full 24h window at ring capacity, anchored to fixture counts', () => {
    const envelope = makeService({ liveSampling: false }).envelope();
    const central = envelope.planes.CENTRAL!;
    expect(central.devices).toHaveLength(METRICS_RING_CAPACITY);
    const bases = demoMetricsBases();
    const fixtureDevices = DEVICES.filter((d) => d.plane === 'CENTRAL').length;
    expect(bases.planes.CENTRAL?.devices).toBe(fixtureDevices);
    // The series wobbles around the fixture base, never far from it.
    const values = central.devices.map((p) => p.v);
    expect(Math.min(...values)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...values)).toBeLessThanOrEqual(fixtureDevices * 2);
    expect(envelope.since).toBe(central.devices[0]!.t);
    // Per-device bases count the fixture clients' own attributions.
    const attach = CLIENTS.find((c) => c.attach && c.attach !== '—')!.attach;
    expect(envelope.deviceClients[attach]).toHaveLength(METRICS_RING_CAPACITY);
  });

  it('bridges the Overview demo row names to envelope labels', () => {
    expect(planeMetricsKey('HPE Aruba Central')).toBe('CENTRAL');
    expect(planeMetricsKey('Local switch collector')).toBe('LOCAL');
    expect(planeMetricsKey('CENTRAL')).toBe('CENTRAL');
  });
});

// ---------------------------------------------------------------------------
// The route
// ---------------------------------------------------------------------------

describe('metrics router', () => {
  it('serves the service envelope verbatim', async () => {
    const service = makeService({ liveSampling: false });
    const app = express();
    app.use('/api', createMetricsRouter(service));
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const res = await fetch(`${base}/api/metrics`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as MetricsHistoryEnvelope;
      expect(body).toEqual(service.envelope());
      expect(body.dataSource).toBe('demo');
      expect(body.note).toBe(METRICS_DEMO_NOTE);
      expect(body.sampleMs).toBeGreaterThan(0);
      expect(body.retentionMs).toBeGreaterThan(0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('is registered on the real app (demo envelope with no planes linked)', async () => {
    const res = await fetch(`${appBase}/api/metrics`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as MetricsHistoryEnvelope;
    expect(body.dataSource).toBe('demo');
    expect(body.note).toBe(METRICS_DEMO_NOTE);
    expect(body.planes.CENTRAL?.devices.length).toBeGreaterThan(0);
    expect(body.since).not.toBeNull();
  });
});
