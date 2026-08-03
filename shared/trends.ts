/**
 * shared/trends.ts — hardware/telemetry trend series: types + the pure
 * normalizer that turns a plane's positional keys[]+samples[] payload into
 * renderable TrendSeries.
 *
 * The three Central trend endpoints this serves (verified shapes):
 *
 *   switch hardware  GET /network-monitoring/v1/switches/{serial}/hardware-trends
 *                    ONE call, 7 series (cpuUtilization, memoryUtilization,
 *                    systemTemperature, poeAvailable, poeConsumption,
 *                    powerConsumption, totalPowerConsumption) as positional
 *                    keys[] + samples[]{timestamp (epoch ms), data[] (strings)}.
 *   AP               GET /network-monitoring/v1/aps/{serial}/{metric}-trends
 *                    for metric cpu|memory|throughput — envelope
 *                    trends.graph{keys,samples}, ISO timestamps, and the
 *                    throughput series is BYTES PER BUCKET, so it must be
 *                    scaled by the detected bucket width into bit/s before it
 *                    means anything.
 *   switch interfaces GET /network-monitoring/v1/switches/{serial}/interface-trends
 *                    — envelope response{keys,samples}: txBytes/rxBytes plus
 *                    the error counters (inErrors, outErrors, inDiscards,
 *                    outDiscards, inFcs, inCrcErrors, inFragmented,
 *                    outCollision, inRunts, inGiants), all cumulative
 *                    counters.
 *
 * The honesty rules, stated once here and enforced by the normalizer:
 *
 *   - ok = ANY series parsed at least one real sample. A payload that
 *     answered with nothing usable is 'empty', not 'ok', and never a chart
 *     full of zeros.
 *   - Gap insertion: when two consecutive samples sit further apart than
 *     GAP_FACTOR x the detected bucket width, a null point is inserted at the
 *     first missing bucket — the chart line BREAKS there. A confident line
 *     drawn across an outage is a lie with a slope.
 *   - Counter vs gauge: cumulative-since-boot counters are differentiated
 *     into per-second rates (x8 into bit/s for byte counters). A counter
 *     RESET (value goes down — a reboot mid-window) yields a null, never a
 *     negative rate; the first sample of a counter series has no predecessor
 *     and is null too.
 *   - Bucket width is DETECTED (median of consecutive sample deltas), never
 *     assumed: the plane picks the interval from the queried range, and
 *     guessing wrong scales every derived rate by the same wrong factor.
 *   - Duplicate buckets are last-write-wins: a retransmitted bucket replaces
 *     the earlier reading instead of double-drawing it.
 *
 * Pure: same payload in, same TrendSet out, no clock, no environment.
 */

import type { DetailSource } from './types';

// ---------------------------------------------------------------------------
// The requested window
// ---------------------------------------------------------------------------

/** ISO 8601 bounds of the window a trend/DPI read was asked for. */
export interface TrendWindow {
  start: string; // ISO
  end: string; // ISO
}

/**
 * The applications endpoint caps a query window at 7 days and answers a
 * wider one with a 400 (singular {error} body, verified). Validating before
 * the call costs nothing; discovering it from the error path costs a round
 * trip and reads as a plane failure instead of a caller mistake.
 */
export const TREND_WINDOW_MAX_MS = 7 * 24 * 60 * 60 * 1000;

export type TrendWindowResult = { ok: true; window: TrendWindow } | { ok: false; error: string };

/**
 * Validate and canonicalize a requested window. A refusal is NOT a plane
 * failure — the caller gets the reason in words and no call is issued.
 */
export function normalizeTrendWindow(
  start: string | null | undefined,
  end: string | null | undefined,
): TrendWindowResult {
  const startMs = Date.parse(start ?? '');
  const endMs = Date.parse(end ?? '');
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
    return { ok: false, error: 'the window bounds must be ISO 8601 timestamps' };
  }
  if (startMs >= endMs) {
    return { ok: false, error: 'the window start must be before its end' };
  }
  if (endMs - startMs > TREND_WINDOW_MAX_MS) {
    const days = Math.round(((endMs - startMs) / 86_400_000) * 10) / 10;
    return { ok: false, error: `the window spans ${days} days — the endpoint refuses anything wider than 7` };
  }
  return { ok: true, window: { start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString() } };
}

// ---------------------------------------------------------------------------
// Series model
// ---------------------------------------------------------------------------

/** One point on a series. `v: null` is a HOLE — an inserted gap marker, a
 *  counter reset, an unparseable bucket — never a zero. */
export interface TrendPoint {
  t: string; // ISO — start of the sample bucket
  v: number | null;
}

/** How a series' raw values must be read. */
export type TrendSeriesKind =
  /** An instantaneous reading (cpu %, temperature, PoE watts): pass through. */
  | 'gauge'
  /** Cumulative since boot (byte/error counters): differentiate into a
   *  per-second rate. */
  | 'counter'
  /** A total over each bucket (AP throughput bytes-per-bucket): scale by the
   *  bucket width into a per-second rate. */
  | 'bucket-total';

/** The rate a counter/bucket-total series is converted to. 'bits-per-second'
 *  treats the raw values as BYTES and multiplies by 8. */
export type TrendRateUnit = 'bits-per-second' | 'per-second';

export interface TrendSeries {
  /** The plane's own series name, from keys[] ('cpuUtilization', 'inErrors'). */
  key: string;
  kind: TrendSeriesKind;
  /** Set on counter/bucket-total series (the conversion actually applied);
   *  null on gauges, which carry no derived rate. */
  rate: TrendRateUnit | null;
  /** The detected bucket width (median sample delta), null when fewer than
   *  two usable samples arrived — in which case no rate conversion happened. */
  bucketMs: number | null;
  /** Oldest-first. Gaps are explicit null points (see the header). */
  points: TrendPoint[];
  /** Usable samples the plane reported for THIS series (pre-conversion).
   *  A series can carry samples and still render holes — one counter sample
   *  is a real answer that yields no rate. */
  samples: number;
}

export interface TrendSet {
  /** In the plane's keys[] order. */
  series: TrendSeries[];
  /** At least one series parsed at least one real sample. */
  ok: boolean;
}

/** Per-key interpretation for normalizeTrendSet. Absent key = gauge. */
export interface TrendSeriesSpec {
  kind?: TrendSeriesKind;
  rate?: TrendRateUnit;
}

/**
 * The interface-trends keys that are cumulative counters, and the rate each
 * converts to (verified key set: txBytes/rxBytes plus the ten error
 * counters). A key NOT listed here defaults to gauge — differentiating a
 * series we do not know is a counter would invent a rate out of a reading.
 */
export const INTERFACE_TREND_COUNTER_KEYS: Record<string, TrendRateUnit> = {
  txBytes: 'bits-per-second',
  rxBytes: 'bits-per-second',
  inErrors: 'per-second',
  outErrors: 'per-second',
  inDiscards: 'per-second',
  outDiscards: 'per-second',
  inFcs: 'per-second',
  inCrcErrors: 'per-second',
  inFragmented: 'per-second',
  outCollision: 'per-second',
  inRunts: 'per-second',
  inGiants: 'per-second',
};

/** The spec map for a switch interface-trends payload: counters classified,
 *  anything else left a gauge. */
export function interfaceTrendSpecs(keys: readonly string[]): Record<string, TrendSeriesSpec> {
  const out: Record<string, TrendSeriesSpec> = {};
  for (const key of keys) {
    const rate = INTERFACE_TREND_COUNTER_KEYS[key];
    if (rate) out[key] = { kind: 'counter', rate };
  }
  return out;
}

/**
 * The spec map for an AP {metric}-trends payload. The endpoint is per-metric,
 * so EVERY series it returns is that metric: throughput is bytes-per-bucket
 * and converts to bit/s; cpu/memory are gauges.
 */
export function apTrendSpecs(metric: ApTrendMetric, keys: readonly string[]): Record<string, TrendSeriesSpec> {
  if (metric !== 'throughput') return {};
  const out: Record<string, TrendSeriesSpec> = {};
  for (const key of keys) out[key] = { kind: 'bucket-total', rate: 'bits-per-second' };
  return out;
}

// ---------------------------------------------------------------------------
// The normalizer
// ---------------------------------------------------------------------------

/**
 * A timestamp pair further apart than this multiple of the bucket width is a
 * GAP, not a slow bucket. 1.5 tolerates jitter on the plane's side without
 * ever bridging a genuinely missing bucket.
 */
export const GAP_FACTOR = 1.5;

/**
 * Bucket width from sample timestamps: the MEDIAN of consecutive deltas.
 * The plane picks the interval from the queried range (the client-usage
 * endpoint picks 5 min vs 3 hours the same way), so it must be measured —
 * assuming one silently rescales every derived rate. Null when fewer than
 * two distinct timestamps exist.
 */
export function detectBucketMs(timestampsMs: readonly number[]): number | null {
  if (timestampsMs.length < 2) return null;
  const sorted = [...timestampsMs].sort((a, b) => a - b);
  const deltas: number[] = [];
  for (let i = 1; i < sorted.length; i += 1) {
    const d = sorted[i]! - sorted[i - 1]!;
    if (d > 0) deltas.push(d);
  }
  if (deltas.length === 0) return null;
  deltas.sort((a, b) => a - b);
  const mid = Math.floor(deltas.length / 2);
  return deltas.length % 2 === 1 ? deltas[mid]! : (deltas[mid - 1]! + deltas[mid]!) / 2;
}

/** Epoch ms from a plane timestamp: epoch ms as a number or numeric string,
 *  or an ISO 8601 string. 0/negative/unparseable → null (never 1970). */
export function parseTrendTimestamp(raw: unknown): number | null {
  let ms: number;
  if (typeof raw === 'number') {
    ms = raw;
  } else if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed.length === 0) return null;
    ms = /^\d+(\.\d+)?$/.test(trimmed) ? Number(trimmed) : Date.parse(trimmed);
  } else {
    return null;
  }
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

/** A numeric reading out of a plane that sends its statistics as strings. */
function trendValue(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw === 'string') {
    const n = Number(raw.trim());
    return raw.trim().length > 0 && Number.isFinite(n) ? n : null;
  }
  return null;
}

interface ParsedSample {
  tMs: number;
  data: unknown[];
}

/**
 * One positional keys[]+samples[] payload → a TrendSet. `samples` is read
 * defensively: entries without a usable timestamp are dropped, non-array
 * `data` reads as all-null columns, and duplicate timestamps are
 * last-write-wins (the later sample replaces the earlier one in place).
 */
export function normalizeTrendSet(
  keys: unknown,
  samples: unknown,
  specs: Record<string, TrendSeriesSpec> = {},
): TrendSet {
  const columns = (Array.isArray(keys) ? keys : []).map((k) =>
    typeof k === 'string' && k.trim().length > 0 ? k.trim() : null,
  );

  // Last-write-wins per timestamp, keeping first-seen order for stability.
  const byTimestamp = new Map<number, unknown[]>();
  if (Array.isArray(samples)) {
    for (const raw of samples) {
      if (!raw || typeof raw !== 'object') continue;
      const s = raw as Record<string, unknown>;
      const tMs = parseTrendTimestamp(s.timestamp ?? s.ts);
      if (tMs === null) continue;
      byTimestamp.set(tMs, Array.isArray(s.data) ? s.data : []);
    }
  }
  const ordered: ParsedSample[] = [...byTimestamp.entries()]
    .map(([tMs, data]) => ({ tMs, data }))
    .sort((a, b) => a.tMs - b.tMs);

  const bucketMs = detectBucketMs(ordered.map((s) => s.tMs));

  const series: TrendSeries[] = [];
  for (let col = 0; col < columns.length; col += 1) {
    const key = columns[col];
    if (key === null) continue;
    const spec = specs[key] ?? {};
    const kind: TrendSeriesKind = spec.kind ?? 'gauge';
    const rate: TrendRateUnit | null = kind === 'gauge' ? null : (spec.rate ?? 'per-second');
    const scale = rate === 'bits-per-second' ? 8 : 1;

    const rawValues = ordered.map((s) => trendValue(s.data[col]));
    const sampleCount = rawValues.filter((v) => v !== null).length;

    const points: TrendPoint[] = [];
    let prevTMs: number | null = null;
    let prevRaw: number | null = null;
    for (let i = 0; i < ordered.length; i += 1) {
      const tMs = ordered[i]!.tMs;
      const raw = rawValues[i]!;
      // A hole in the timeline gets an explicit null marker at the first
      // missing bucket — the renderer's cue to break the line.
      const gap = prevTMs !== null && bucketMs !== null && tMs - prevTMs > GAP_FACTOR * bucketMs;
      if (gap) {
        points.push({ t: new Date(prevTMs! + bucketMs!).toISOString(), v: null });
      }

      let v: number | null;
      if (kind === 'gauge') {
        v = raw;
      } else if (kind === 'bucket-total') {
        // A per-bucket total without a known bucket width cannot become a
        // rate; scaling it by a guessed width would be a fabricated number.
        v = raw !== null && bucketMs !== null ? (raw * scale) / (bucketMs / 1000) : null;
      } else {
        // Counter: differentiate against the previous sample. No predecessor,
        // a gap in between, a hole on either side, or a value that went DOWN
        // (a reboot resets the counter) all yield a hole, never a rate.
        v =
          prevRaw !== null && raw !== null && prevTMs !== null && !gap && raw >= prevRaw
            ? ((raw - prevRaw) * scale) / ((tMs - prevTMs) / 1000)
            : null;
      }
      points.push({ t: new Date(tMs).toISOString(), v });
      prevTMs = tMs;
      prevRaw = raw;
    }
    series.push({ key, kind, rate, bucketMs, points, samples: sampleCount });
  }

  return { series, ok: series.some((s) => s.samples > 0) };
}

// ---------------------------------------------------------------------------
// On-demand payload envelopes (the *Live contract, same as ClientDetailLive)
// ---------------------------------------------------------------------------

/** The trend series a switch's hardware-trends endpoint returns (verified). */
export const SWITCH_HARDWARE_TREND_KEYS = [
  'cpuUtilization',
  'memoryUtilization',
  'systemTemperature',
  'poeAvailable',
  'poeConsumption',
  'powerConsumption',
  'totalPowerConsumption',
] as const;

/** The AP trend metrics with their own endpoint (/{metric}-trends). */
export const AP_TREND_METRICS = ['cpu', 'memory', 'throughput'] as const;
export type ApTrendMetric = (typeof AP_TREND_METRICS)[number];

/** Sections of the trend detail reads — one per endpoint call, so a screen
 *  can say the call broke instead of implying the device has no telemetry. */
export type HardwareTrendsSection = 'hardware';
export type ApTrendsSection = 'trends';
export type InterfaceTrendsSection = 'interfaces';

/**
 * A switch's hardware gauges, fetched on demand for ONE serial. Absent
 * `trends` = not fetched; a TrendSet with ok:false = the plane answered with
 * nothing usable (honest empty).
 */
export interface SwitchHardwareTrendsLive {
  /** The serial the read was issued for. */
  serial: string;
  /** The window the read was asked for. The series' own timestamps say what
   *  the plane actually returned; a renderer captions from those, and treats
   *  this as the request, never as proof of coverage. */
  window: TrendWindow;
  trends?: TrendSet;
  source: DetailSource<HardwareTrendsSection>;
}

/** One AP metric trend, fetched on demand for ONE serial + metric. */
export interface ApTrendsLive {
  serial: string;
  metric: ApTrendMetric;
  window: TrendWindow;
  trends?: TrendSet;
  source: DetailSource<ApTrendsSection>;
}

/** A switch's interface byte/error counter trends, on demand for ONE serial. */
export interface SwitchInterfaceTrendsLive {
  serial: string;
  window: TrendWindow;
  trends?: TrendSet;
  source: DetailSource<InterfaceTrendsSection>;
}
