/**
 * server/tests/trends.test.ts — the trend-series normalizer (shared/trends.ts),
 * NO network.
 *
 * Every conversion is driven with hand-computed expectations: bucket-width
 * detection, gap insertion, counter differentiation, the bytes-per-bucket to
 * bit/s conversion and duplicate-bucket last-write-wins are all worked out in
 * the test body, so a regression shows up as a wrong number, not a snapshot
 * diff.
 */

import { describe, expect, it } from 'vitest';
import {
  TREND_WINDOW_MAX_MS,
  apTrendSpecs,
  detectBucketMs,
  interfaceTrendSpecs,
  normalizeTrendSet,
  normalizeTrendWindow,
  parseTrendTimestamp,
} from '@hpe/shared';

const T0 = Date.parse('2026-07-28T12:00:00.000Z');
const iso = (ms: number): string => new Date(ms).toISOString();

describe('normalizeTrendWindow — the 7-day cap, enforced before any call', () => {
  it('accepts a window inside the cap and canonicalizes the bounds', () => {
    const w = normalizeTrendWindow('2026-07-27T12:00:00Z', '2026-07-28T12:00:00.000Z');
    expect(w).toEqual({
      ok: true,
      window: { start: '2026-07-27T12:00:00.000Z', end: '2026-07-28T12:00:00.000Z' },
    });
  });

  it('accepts exactly 7 days and refuses 7 days plus one millisecond', () => {
    const ok = normalizeTrendWindow(iso(T0), iso(T0 + TREND_WINDOW_MAX_MS));
    expect(ok.ok).toBe(true);
    const wide = normalizeTrendWindow(iso(T0), iso(T0 + TREND_WINDOW_MAX_MS + 1));
    expect(wide.ok).toBe(false);
    if (!wide.ok) expect(wide.error).toMatch(/7/);
  });

  it('says the span in days when it refuses', () => {
    const wide = normalizeTrendWindow(iso(T0), iso(T0 + 14 * 86_400_000));
    expect(wide.ok).toBe(false);
    if (!wide.ok) expect(wide.error).toContain('14 days');
  });

  it('refuses an inverted window and an unparseable bound', () => {
    expect(normalizeTrendWindow(iso(T0 + 1000), iso(T0)).ok).toBe(false);
    expect(normalizeTrendWindow('whenever', iso(T0)).ok).toBe(false);
    expect(normalizeTrendWindow(undefined, iso(T0)).ok).toBe(false);
    expect(normalizeTrendWindow(iso(T0), '').ok).toBe(false);
  });
});

describe('parseTrendTimestamp', () => {
  it('reads epoch ms as a number or a numeric string, and ISO strings', () => {
    expect(parseTrendTimestamp(T0)).toBe(T0);
    expect(parseTrendTimestamp(String(T0))).toBe(T0);
    expect(parseTrendTimestamp('2026-07-28T12:00:00.000Z')).toBe(T0);
  });

  it('refuses 0, negatives and junk — never a 1970 point', () => {
    expect(parseTrendTimestamp(0)).toBeNull();
    expect(parseTrendTimestamp(-5)).toBeNull();
    expect(parseTrendTimestamp('nope')).toBeNull();
    expect(parseTrendTimestamp('')).toBeNull();
    expect(parseTrendTimestamp(null)).toBeNull();
    expect(parseTrendTimestamp(undefined)).toBeNull();
  });
});

describe('detectBucketMs — bucket width from the median delta', () => {
  it('is the median of consecutive deltas', () => {
    expect(detectBucketMs([T0, T0 + 60_000, T0 + 120_000])).toBe(60_000);
  });

  it('shrugs off one outage-sized outlier delta', () => {
    // deltas: 60s, 60s, 3h → median 60s
    expect(detectBucketMs([T0, T0 + 60_000, T0 + 120_000, T0 + 120_000 + 3 * 3_600_000])).toBe(60_000);
  });

  it('averages the two middle deltas when the count is even', () => {
    // deltas: 60s and 240s → (60+240)/2
    expect(detectBucketMs([T0, T0 + 60_000, T0 + 300_000])).toBe(150_000);
  });

  it('is null with fewer than two distinct timestamps', () => {
    expect(detectBucketMs([])).toBeNull();
    expect(detectBucketMs([T0])).toBeNull();
    expect(detectBucketMs([T0, T0])).toBeNull();
  });
});

describe('normalizeTrendSet — gauges', () => {
  it('maps positional data by the keys order, not by assumption', () => {
    const set = normalizeTrendSet(
      ['memoryUtilization', 'cpuUtilization'],
      [
        { timestamp: T0, data: ['39', '14'] },
        { timestamp: T0 + 3_600_000, data: ['40', '15'] },
      ],
    );
    expect(set.ok).toBe(true);
    expect(set.series.map((s) => s.key)).toEqual(['memoryUtilization', 'cpuUtilization']);
    expect(set.series[0].kind).toBe('gauge');
    expect(set.series[0].rate).toBeNull();
    expect(set.series[0].points).toEqual([
      { t: iso(T0), v: 39 },
      { t: iso(T0 + 3_600_000), v: 40 },
    ]);
    expect(set.series[1].points[0].v).toBe(14);
  });

  it('reads ISO timestamps (the AP envelope shape) and parses string values', () => {
    const set = normalizeTrendSet(
      ['cpuUtilization'],
      [
        { timestamp: '2026-07-28T12:00:00.000Z', data: ['18'] },
        { timestamp: '2026-07-28T12:05:00.000Z', data: ['19.5'] },
      ],
    );
    expect(set.series[0].bucketMs).toBe(300_000);
    expect(set.series[0].points[1]).toEqual({ t: '2026-07-28T12:05:00.000Z', v: 19.5 });
  });

  it('turns an unparseable bucket value into a hole, never a zero', () => {
    const set = normalizeTrendSet(
      ['cpuUtilization'],
      [
        { timestamp: T0, data: [''] },
        { timestamp: T0 + 60_000, data: ['NaN-ish'] },
      ],
    );
    expect(set.series[0].points.map((p) => p.v)).toEqual([null, null]);
    // The samples still COUNT — the plane reported buckets, just not values.
    expect(set.series[0].samples).toBe(0);
    expect(set.ok).toBe(false);
  });

  it('counts usable samples per series for the ok verdict', () => {
    const set = normalizeTrendSet(
      ['cpuUtilization', 'memoryUtilization'],
      [
        { timestamp: T0, data: ['14', ''] },
        { timestamp: T0 + 60_000, data: ['15', '40'] },
      ],
    );
    expect(set.series[0].samples).toBe(2);
    expect(set.series[1].samples).toBe(1);
    expect(set.ok).toBe(true);
  });
});

describe('normalizeTrendSet — gaps: never a confident line across an outage', () => {
  it('inserts a null marker at the first missing bucket when Δ > 1.5x bucket', () => {
    const set = normalizeTrendSet(
      ['cpuUtilization'],
      [
        { timestamp: T0, data: ['14'] },
        { timestamp: T0 + 60_000, data: ['15'] },
        { timestamp: T0 + 120_000, data: ['16'] },
        // a missing 1-minute bucket: the next sample is 2 minutes out
        { timestamp: T0 + 240_000, data: ['17'] },
      ],
    );
    expect(set.series[0].bucketMs).toBe(60_000);
    expect(set.series[0].points).toEqual([
      { t: iso(T0), v: 14 },
      { t: iso(T0 + 60_000), v: 15 },
      { t: iso(T0 + 120_000), v: 16 },
      { t: iso(T0 + 180_000), v: null },
      { t: iso(T0 + 240_000), v: 17 },
    ]);
  });

  it('does NOT insert a marker at exactly 1.5x the bucket — that is jitter, not an outage', () => {
    const set = normalizeTrendSet(
      ['cpuUtilization'],
      [
        { timestamp: T0, data: ['14'] },
        { timestamp: T0 + 60_000, data: ['15'] },
        { timestamp: T0 + 120_000, data: ['16'] },
        { timestamp: T0 + 210_000, data: ['17'] }, // Δ 90s = exactly 1.5x the 60s bucket
      ],
    );
    expect(set.series[0].bucketMs).toBe(60_000);
    expect(set.series[0].points).toHaveLength(4);
    expect(set.series[0].points.some((p) => p.v === null)).toBe(false);
  });

  it('inserts no markers when the bucket width cannot be detected', () => {
    const set = normalizeTrendSet(['cpuUtilization'], [{ timestamp: T0, data: ['14'] }]);
    expect(set.series[0].bucketMs).toBeNull();
    expect(set.series[0].points).toEqual([{ t: iso(T0), v: 14 }]);
  });
});

describe('normalizeTrendSet — duplicate buckets are last-write-wins', () => {
  it('the later sample replaces the earlier one for the same timestamp', () => {
    const set = normalizeTrendSet(
      ['cpuUtilization'],
      [
        { timestamp: T0, data: ['14'] },
        { timestamp: T0 + 60_000, data: ['15'] },
        { timestamp: T0 + 60_000, data: ['19'] }, // retransmitted bucket
      ],
    );
    expect(set.series[0].points).toEqual([
      { t: iso(T0), v: 14 },
      { t: iso(T0 + 60_000), v: 19 },
    ]);
  });
});

describe('normalizeTrendSet — counters differentiate into rates', () => {
  const counterSamples = (values: string[], stepMs = 60_000) =>
    values.map((v, i) => ({ timestamp: T0 + i * stepMs, data: [v] }));

  it('converts a cumulative counter into a per-second rate over the actual Δt', () => {
    const set = normalizeTrendSet(
      ['inErrors'],
      counterSamples(['800', '1400', '2000']),
      { inErrors: { kind: 'counter', rate: 'per-second' } },
    );
    expect(set.series[0].points.map((p) => p.v)).toEqual([null, 10, 10]);
  });

  it('scales byte counters by 8 into bit/s', () => {
    const set = normalizeTrendSet(
      ['txBytes'],
      counterSamples(['800', '1400']),
      { txBytes: { kind: 'counter', rate: 'bits-per-second' } },
    );
    expect(set.series[0].points[1].v).toBe(80); // 600 bytes over 60s = 10 B/s = 80 bit/s
  });

  it('a counter RESET (value goes down — a reboot) is a hole, never a negative rate', () => {
    const set = normalizeTrendSet(
      ['inErrors'],
      counterSamples(['800', '1400', '100', '250']),
      { inErrors: { kind: 'counter' } },
    );
    expect(set.series[0].points.map((p) => p.v)).toEqual([null, 10, null, 2.5]);
  });

  it('the sample after a gap yields no rate — the counter may have reset unseen', () => {
    const set = normalizeTrendSet(
      ['inErrors'],
      [
        { timestamp: T0, data: ['800'] },
        { timestamp: T0 + 60_000, data: ['1400'] },
        { timestamp: T0 + 120_000, data: ['2000'] },
        { timestamp: T0 + 120_000 + 3 * 3_600_000, data: ['5000'] }, // 3h later: a gap
      ],
      { inErrors: { kind: 'counter' } },
    );
    expect(set.series[0].bucketMs).toBe(60_000);
    expect(set.series[0].points.map((p) => p.v)).toEqual([null, 10, 10, null, null]);
  });
});

describe('normalizeTrendSet — bucket-total (AP throughput) to bit/s', () => {
  it('divides the per-bucket bytes by the DETECTED bucket width, times 8', () => {
    const set = normalizeTrendSet(
      ['throughput'],
      [
        { timestamp: '2026-07-28T12:00:00.000Z', data: ['360000000'] },
        { timestamp: '2026-07-28T12:05:00.000Z', data: ['720000000'] },
      ],
      { throughput: { kind: 'bucket-total', rate: 'bits-per-second' } },
    );
    expect(set.series[0].bucketMs).toBe(300_000);
    expect(set.series[0].rate).toBe('bits-per-second');
    // 3.6e8 bytes over 300s = 1.2e6 B/s = 9.6e6 bit/s
    expect(set.series[0].points[0].v).toBeCloseTo(9_600_000, 6);
    expect(set.series[0].points[1].v).toBeCloseTo(19_200_000, 6);
  });

  it('refuses to scale by a guessed width — one sample, no rate', () => {
    const set = normalizeTrendSet(
      ['throughput'],
      [{ timestamp: T0, data: ['360000000'] }],
      { throughput: { kind: 'bucket-total', rate: 'bits-per-second' } },
    );
    expect(set.series[0].bucketMs).toBeNull();
    expect(set.series[0].points[0].v).toBeNull();
    expect(set.series[0].samples).toBe(1); // the sample was real
    expect(set.ok).toBe(true);
  });
});

describe('normalizeTrendSet — defensive parsing', () => {
  it('drops junk samples and junk keys without shifting the columns', () => {
    const set = normalizeTrendSet(
      ['cpuUtilization', null, 'memoryUtilization'],
      [
        'junk',
        { timestamp: 'not-a-time', data: ['1', '2', '3'] },
        { timestamp: T0, data: ['14', 'x', '39'] },
        { timestamp: T0 + 60_000 }, // no data array
      ],
    );
    expect(set.series.map((s) => s.key)).toEqual(['cpuUtilization', 'memoryUtilization']);
    expect(set.series[0].points).toEqual([
      { t: iso(T0), v: 14 },
      { t: iso(T0 + 60_000), v: null },
    ]);
    expect(set.series[1].points[0].v).toBe(39);
  });

  it('an empty payload is not ok — never a chart of zeros', () => {
    expect(normalizeTrendSet(['cpuUtilization'], []).ok).toBe(false);
    expect(normalizeTrendSet([], []).series).toHaveLength(0);
    expect(normalizeTrendSet(null, null).ok).toBe(false);
  });
});

describe('spec builders', () => {
  it('interfaceTrendSpecs classifies the verified counter keys and leaves the rest gauges', () => {
    const specs = interfaceTrendSpecs(['txBytes', 'inCrcErrors', 'someFutureKey']);
    expect(specs.txBytes).toEqual({ kind: 'counter', rate: 'bits-per-second' });
    expect(specs.inCrcErrors).toEqual({ kind: 'counter', rate: 'per-second' });
    expect('someFutureKey' in specs).toBe(false); // unknown keys stay gauges
  });

  it('apTrendSpecs makes every series of the throughput endpoint a bucket-total', () => {
    expect(apTrendSpecs('throughput', ['throughput', 'txBytes'])).toEqual({
      throughput: { kind: 'bucket-total', rate: 'bits-per-second' },
      txBytes: { kind: 'bucket-total', rate: 'bits-per-second' },
    });
    expect(apTrendSpecs('cpu', ['cpuUtilization'])).toEqual({});
    expect(apTrendSpecs('memory', ['memoryUtilization'])).toEqual({});
  });
});
