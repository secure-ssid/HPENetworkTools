/**
 * server/tests/anomaly.test.ts — anomaly flags: the robust z-score math, the
 * additive envelope block, and the demo injection, NO network beyond a
 * loopback-mounted router.
 *
 * The pure math (shared/anomaly.ts) is driven with hand-computed series —
 * median, MAD and the mean-deviation fallback all worked out in the test
 * body, so a regression in the constants shows up as a wrong expected
 * number, not as a snapshot diff. Service-level tests construct
 * MetricsHistoryService instances with clock/cadence/sampler injected (the
 * metricsHistory.test.ts pattern): HPE_SETTINGS_PATH and HPE_DATA_DIR point
 * at a tmp dir before any app module is imported, so nothing here touches
 * the real data/.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ANOMALY_MAD_SCALE,
  ANOMALY_MIN_POINTS,
  ANOMALY_Z_THRESHOLD,
  METRICS_DEMO_NOTE,
  anomalyFlags,
  envelopeAnomalies,
  metricsAnomalies,
  type AnomalyFlag,
  type MetricPoint,
  type MetricsEnvelopeWithAnomalies,
  type MetricsHistoryEnvelope,
} from '@hpe/shared';
import type { MetricsHistoryService as MetricsHistoryServiceT, MetricsSample } from '../src/services/metricsHistory';

let MetricsHistoryService: typeof import('../src/services/metricsHistory').MetricsHistoryService;
let createMetricsRouter: typeof import('../src/routes/metrics').createMetricsRouter;

let tmpDir: string;

const NOW = Date.parse('2026-07-25T12:00:00Z');
const STEP = 5 * 60_000;

/** A series of n points ending at NOW, oldest first. */
const series = (values: number[]): MetricPoint[] =>
  values.map((v, i) => ({ t: new Date(NOW - (values.length - 1 - i) * STEP).toISOString(), v }));

function makeService(opts: {
  nowMs?: () => number;
  liveSampling?: boolean;
  sample?: () => MetricsSample;
}): MetricsHistoryServiceT {
  return new MetricsHistoryService({
    nowMs: opts.nowMs ?? (() => NOW),
    liveSampling: () => opts.liveSampling ?? true,
    ...(opts.sample ? { sample: opts.sample } : {}),
  });
}

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'hpe-anomaly-'));
  process.env.HPE_SETTINGS_PATH = join(tmpDir, 'settings.json');
  process.env.HPE_DATA_DIR = join(tmpDir, 'data');
  ({ MetricsHistoryService } = await import('../src/services/metricsHistory'));
  ({ createMetricsRouter } = await import('../src/routes/metrics'));
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.HPE_SETTINGS_PATH;
  delete process.env.HPE_DATA_DIR;
});

// ---------------------------------------------------------------------------
// anomalyFlags — the robust z-score math
// ---------------------------------------------------------------------------

describe('anomalyFlags', () => {
  it('flags a high outlier at its hand-computed z, and nothing else', () => {
    // median 10; absolute deviations sort to [0,0,0,0,1,1,1,1,1,1,2,2,25],
    // so MAD = 1 and z(35) = 0.6745 × 25.
    const s = series([8, 9, 10, 11, 12, 9, 10, 11, 10, 9, 11, 10, 35]);
    const flags = anomalyFlags(s);
    expect(flags).toHaveLength(1);
    const flag = flags[0]!;
    expect(flag.index).toBe(12);
    expect(flag.direction).toBe('high');
    expect(flag.v).toBe(35);
    expect(flag.t).toBe(s[12]!.t);
    expect(flag.z).toBeCloseTo(ANOMALY_MAD_SCALE * 25, 10);
  });

  it('flags a low outlier with a negative z', () => {
    // median 20, MAD = 1 (same shape as above), z(2) = 0.6745 × (2 − 20).
    const s = series([18, 19, 20, 21, 22, 19, 20, 21, 20, 19, 21, 20, 2]);
    const flags = anomalyFlags(s);
    expect(flags).toHaveLength(1);
    expect(flags[0]!.direction).toBe('low');
    expect(flags[0]!.z).toBeCloseTo(ANOMALY_MAD_SCALE * -18, 10);
  });

  it('honours the 3.5 cut-off exactly: 6 MADs flag, 5 do not', () => {
    // Both series: median 10, MAD = 1 (the replaced point moves from
    // deviation 2 to deviation 5/6, which stays the max — the median of the
    // rest is untouched).
    const at5 = series([8, 9, 10, 11, 15, 9, 10, 11, 10, 9, 11, 10]);
    const at6 = series([8, 9, 10, 11, 16, 9, 10, 11, 10, 9, 11, 10]);
    expect(ANOMALY_MAD_SCALE * 5).toBeLessThan(ANOMALY_Z_THRESHOLD);
    expect(ANOMALY_MAD_SCALE * 6).toBeGreaterThanOrEqual(ANOMALY_Z_THRESHOLD);
    expect(anomalyFlags(at5)).toEqual([]);
    expect(anomalyFlags(at6).map((f) => f.v)).toEqual([16]);
  });

  it('a perfectly constant series has no scale to measure against — no flags', () => {
    expect(anomalyFlags(series(new Array(20).fill(7)))).toEqual([]);
  });

  it('a MAD of 0 falls back to the mean deviation, so a huge outlier still flags', () => {
    // Eleven 10s and one 40: MAD = 0, mean deviation = 30/12 = 2.5,
    // z(40) = 0.6745 × 30 / 2.5 ≈ 8.1. Small steady counts wobble exactly
    // like this, and the excursion must not hide behind the zero MAD.
    const flags = anomalyFlags(series([10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 40]));
    expect(flags).toHaveLength(1);
    expect(flags[0]!.direction).toBe('high');
    expect(flags[0]!.z).toBeCloseTo((ANOMALY_MAD_SCALE * 30) / 2.5, 10);
  });

  it('...but the same fallback keeps a ±1 wobble in a steady series unflagged', () => {
    // Eight 10s, four 11s: MAD = 0, mean deviation = 4/12, z(11) ≈ 2.0.
    const flags = anomalyFlags(series([10, 11, 10, 10, 11, 10, 10, 11, 10, 10, 11, 10]));
    expect(flags).toEqual([]);
  });

  it('fewer than minPoints samples is never a guess, however wild the point', () => {
    const s = series([10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 400]);
    expect(s.length).toBeLessThan(ANOMALY_MIN_POINTS);
    expect(anomalyFlags(s)).toEqual([]);
    // The same series flags once the caller honestly lowers the minimum.
    expect(anomalyFlags(s, { minPoints: 11 })).toHaveLength(1);
  });

  it('respects a caller-set threshold', () => {
    const s = series([8, 9, 10, 11, 15, 9, 10, 11, 10, 9, 11, 10]); // z(15) ≈ 3.37
    expect(anomalyFlags(s)).toEqual([]);
    expect(anomalyFlags(s, { zThreshold: 3 })).toHaveLength(1);
  });

  it('empty series, no flags', () => {
    expect(anomalyFlags([])).toEqual([]);
  });

  it('returns flags in series order when several points run away together', () => {
    const s = series([10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 60, 0]);
    const flags = anomalyFlags(s);
    expect(flags.map((f) => f.index)).toEqual([...flags.map((f) => f.index)].sort((a, b) => a - b));
    expect(flags.map((f) => f.direction)).toContain('high');
  });
});

// ---------------------------------------------------------------------------
// metricsAnomalies — the additive envelope block
// ---------------------------------------------------------------------------

describe('metricsAnomalies', () => {
  const spiked = series([10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 40]);
  const calm = series([8, 9, 10, 11, 12, 9, 10, 11, 10, 9, 11, 10]);

  const envelope: MetricsHistoryEnvelope = {
    dataSource: 'live',
    since: spiked[0]!.t,
    sampleMs: STEP,
    retentionMs: 24 * 60 * 60_000,
    planes: {
      CENTRAL: { devices: spiked, devicesDown: [], clients: calm, alerts: [] },
      MIST: { devices: calm, devicesDown: [], clients: [], alerts: [] },
    },
    deviceClients: { 'ap-1': spiked, 'ap-2': calm },
  };

  it('is sparse: only series carrying a flag appear', () => {
    const block = metricsAnomalies(envelope);
    expect(Object.keys(block.planes)).toEqual(['CENTRAL']);
    expect(Object.keys(block.planes.CENTRAL!)).toEqual(['devices']);
    expect(block.planes.CENTRAL!.devices).toHaveLength(1);
    expect(Object.keys(block.deviceClients)).toEqual(['ap-1']);
  });

  it('flags each series against its own median, not a global one', () => {
    // CENTRAL.devices and ap-1 carry the same numbers, so both flag; the
    // identical calm series under two keys flags in neither.
    const block = metricsAnomalies(envelope);
    expect(block.planes.CENTRAL!.devices![0]!.z).toBeCloseTo(block.deviceClients['ap-1']![0]!.z, 10);
  });

  it('envelopeAnomalies reads the additive block, or null from an older server', () => {
    const served: MetricsEnvelopeWithAnomalies = { ...envelope, anomalies: metricsAnomalies(envelope) };
    expect(envelopeAnomalies(served)).toEqual(served.anomalies);
    expect(envelopeAnomalies(envelope)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The served envelope — flags computed on read
// ---------------------------------------------------------------------------

describe('envelope anomaly block', () => {
  it('a live ring with enough samples flags its spike on read', () => {
    // Eleven steady samples then a spike: MAD 0 → mean-deviation fallback,
    // z = 0.6745 × 30 / 2.5 ≈ 8.1 → one high flag on the last point.
    const values = [10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 40];
    let i = 0;
    let t = NOW - (values.length - 1) * STEP;
    const service = makeService({
      nowMs: () => t,
      sample: () => ({ planes: { CENTRAL: { devices: values[i]! } }, deviceClients: {} }),
    });
    for (; i < values.length; i += 1) {
      service.sampleNow();
      t += STEP;
    }
    const envelope = service.envelope();
    expect(envelope.dataSource).toBe('live');
    const flags = envelope.anomalies.planes.CENTRAL?.devices ?? [];
    expect(flags).toHaveLength(1);
    expect(flags[0]!.direction).toBe('high');
    expect(flags[0]!.index).toBe(values.length - 1);
    // The flag addresses the served series: index, timestamp and value agree.
    const point = envelope.planes.CENTRAL!.devices[flags[0]!.index]!;
    expect(flags[0]!.t).toBe(point.t);
    expect(flags[0]!.v).toBe(point.v);
  });

  it('a thin live ring contributes no flags — and no invented confidence', () => {
    const service = makeService({ sample: () => ({ planes: { MIST: { devices: 7 } }, deviceClients: {} }) });
    service.sampleNow();
    const envelope = service.envelope();
    expect(envelope.anomalies.planes).toEqual({});
    expect(envelope.anomalies.deviceClients).toEqual({});
  });

  it('the route serves the block verbatim as part of the envelope', async () => {
    const service = makeService({ liveSampling: false });
    const app = express();
    app.use('/api', createMetricsRouter(service));
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const res = await fetch(`${base}/api/metrics`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as MetricsEnvelopeWithAnomalies;
      expect(body.anomalies).toEqual(service.envelope().anomalies);
      expect(body.note).toBe(METRICS_DEMO_NOTE);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

// ---------------------------------------------------------------------------
// The demo injection — deterministic, synthesized, showcased
// ---------------------------------------------------------------------------

describe('demo anomaly injection', () => {
  const demoEnvelope = (nowMs: number = NOW) =>
    makeService({ liveSampling: false, nowMs: () => nowMs }).envelope();

  it('flags exactly two plane device series — one high, one low, one point each', () => {
    const envelope = demoEnvelope();
    const entries = Object.entries(envelope.anomalies.planes);
    expect(entries).toHaveLength(2);
    const directions: string[] = [];
    for (const [label, metrics] of entries) {
      // Only the devices series of the plane flags — never its other metrics.
      expect(Object.keys(metrics!)).toEqual(['devices']);
      const flags = metrics!.devices!;
      expect(flags).toHaveLength(1);
      directions.push(flags[0]!.direction);
      // The flag addresses the served series it was computed over.
      const series = envelope.planes[label]!.devices;
      expect(flags[0]!.t).toBe(series[flags[0]!.index]!.t);
      expect(flags[0]!.v).toBe(series[flags[0]!.index]!.v);
    }
    expect(directions.sort()).toEqual(['high', 'low']);
    // No per-device client series flags either: the synthesis wobbles inside
    // the threshold everywhere it was not deliberately spiked.
    expect(envelope.anomalies.deviceClients).toEqual({});
  });

  it('targets the two largest fixture device inventories, not hardcoded planes', () => {
    const envelope = demoEnvelope();
    expect(Object.keys(envelope.anomalies.planes).sort()).toEqual(['AOS-8', 'LOCAL']);
  });

  it('is deterministic across reads and keeps a timestamp pure across windows', () => {
    const a = demoEnvelope();
    expect(demoEnvelope()).toEqual(a);
    // One sample-interval later the window shifts by a bucket; every
    // overlapping timestamp — including the spiked ones — keeps its value.
    const later = demoEnvelope(NOW + STEP);
    for (const label of Object.keys(a.anomalies.planes)) {
      const before = new Map(a.planes[label]!.devices.map((p) => [p.t, p.v]));
      for (const p of later.planes[label]!.devices) {
        if (before.has(p.t)) expect(p.v).toBe(before.get(p.t));
      }
      // The flag follows the same timestamp into the shifted window.
      const beforeT = a.anomalies.planes[label]!.devices![0]!.t;
      const laterFlags = later.anomalies.planes[label]!.devices!;
      expect(laterFlags).toHaveLength(1);
      expect(laterFlags[0]!.t).toBe(beforeT);
    }
  });

  it('the injected spike keeps the synthesized label: the envelope note is untouched', () => {
    const envelope = demoEnvelope();
    expect(envelope.dataSource).toBe('demo');
    expect(envelope.note).toBe(METRICS_DEMO_NOTE);
  });
});

// ---------------------------------------------------------------------------
// Type-level expectations kept honest: a flag is a series address
// ---------------------------------------------------------------------------

describe('AnomalyFlag shape', () => {
  it('carries index, timestamp, value, direction and z — nothing else', () => {
    const flags: AnomalyFlag[] = anomalyFlags(series([10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 40]));
    expect(Object.keys(flags[0]!).sort()).toEqual(['direction', 'index', 't', 'v', 'z']);
  });
});
