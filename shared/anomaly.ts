/**
 * shared/anomaly.ts — anomaly flags on metric series.
 *
 * A robust z-score over a MetricPoint series: how many robust standard
 * deviations a sample sits from the series' own median, where the robust
 * scale is the MAD (median absolute deviation). Robust, because a plain
 * mean/std score lets the outlier itself inflate the yardstick it is
 * measured against; median and MAD barely move when one point runs away.
 *
 * The honesty rules, stated once here and enforced by the math:
 *
 *   - Fewer than `minPoints` samples → no flags. A median over a handful of
 *     points is a guess, and a flag derived from a guess would be one too.
 *   - A perfectly constant series (no deviation anywhere) → no flags: there
 *     is no scale to measure a deviation against.
 *   - When more than half the points equal the median the MAD is 0 — the
 *     usual case for small integer counts that wobble by ±1 — so the scale
 *     falls back to the MEAN absolute deviation from the median (the
 *     classical MAD===0 fallback). A ±1 wobble in an otherwise steady
 *     series stays well under the threshold; a genuine excursion does not.
 *   - The flag says a sample is unusual FOR THAT SERIES over the retained
 *     window. It is statistics over what the portal kept — never a
 *     prediction, never an ML claim.
 */

import type { MetricPoint, MetricsHistoryEnvelope } from './metricsHistory';

/** Which way a flagged point deviated from its series' median. */
export type AnomalyDirection = 'high' | 'low';

/** One flagged sample. `index` addresses the served series array, so a UI
 *  can place a marker without re-deriving anything. */
export interface AnomalyFlag {
  /** Position in the series the flag was computed over. */
  index: number;
  /** The sample's own timestamp (ISO) and value, copied for convenience. */
  t: string;
  v: number;
  direction: AnomalyDirection;
  /** Signed robust z-score; |z| >= the threshold in force. */
  z: number;
}

export interface AnomalyOptions {
  /** Minimum series length before any flag is computed (default
   *  ANOMALY_MIN_POINTS). Below it: no flags, never a guess. */
  minPoints?: number;
  /** |z| at or above which a point is flagged (default ANOMALY_Z_THRESHOLD). */
  zThreshold?: number;
}

/** Below 12 samples (= 1h at the default 5m cadence) median and scale are
 *  noise, so the series reports nothing unusual — however wild it looks. */
export const ANOMALY_MIN_POINTS = 12;

/** The classical modified z-score cut-off (Iglewicz & Hoaglin, 1993): |z|
 *  at or beyond 3.5 robust standard deviations is "a potential outlier". */
export const ANOMALY_Z_THRESHOLD = 3.5;

/** Scales the MAD to a standard-deviation estimate for normal data (the
 *  0.75 quantile of the standard normal), so z reads in familiar sigmas. */
export const ANOMALY_MAD_SCALE = 0.6745;

/** Median of a numeric list; the mean of the two middle values when even. */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Flag the points of one series that sit unusually far from the series' own
 * median. Pure: same series and options, same flags. Returns the flags in
 * series order (oldest first); an empty result means "nothing unusual
 * enough to say" OR "not enough data to say anything" — the caller's
 * `minPoints` rule decides which, and both render as silence.
 */
export function anomalyFlags(series: MetricPoint[], options: AnomalyOptions = {}): AnomalyFlag[] {
  const minPoints = options.minPoints ?? ANOMALY_MIN_POINTS;
  const zThreshold = options.zThreshold ?? ANOMALY_Z_THRESHOLD;
  if (series.length < minPoints) return [];
  const values = series.map((p) => p.v);
  const med = median(values);
  const deviations = values.map((v) => Math.abs(v - med));
  const mad = median(deviations);
  // MAD===0 (over half the series is one value — steady small counts): fall
  // back to the mean absolute deviation, or a ±1 wobble would measure
  // against a zero yardstick. A truly constant series has mean deviation 0
  // too, and then there is simply nothing to measure against.
  const scale = mad > 0 ? mad : deviations.reduce((a, b) => a + b, 0) / deviations.length;
  if (scale === 0) return [];
  const flags: AnomalyFlag[] = [];
  for (let i = 0; i < series.length; i += 1) {
    const z = (ANOMALY_MAD_SCALE * (values[i]! - med)) / scale;
    if (Math.abs(z) >= zThreshold) {
      flags.push({ index: i, t: series[i]!.t, v: values[i]!, direction: z > 0 ? 'high' : 'low', z });
    }
  }
  return flags;
}

// ---------------------------------------------------------------------------
// The additive envelope block
// ---------------------------------------------------------------------------

/** The plane metrics an envelope carries series for. */
export type PlaneMetricKind = 'devices' | 'devicesDown' | 'clients' | 'alerts';

/**
 * The flags computed over an envelope's series, keyed exactly like the
 * envelope itself. Sparse: only series carrying at least one flag appear —
 * "no entry" covers both "nothing unusual" and "not enough samples", which
 * the UI is meant to render identically: as nothing.
 */
export interface MetricsAnomalyBlock {
  planes: Partial<Record<string, Partial<Record<PlaneMetricKind, AnomalyFlag[]>>>>;
  deviceClients: Record<string, AnomalyFlag[]>;
}

/** The /api/metrics payload with the additive anomaly block attached. */
export type MetricsEnvelopeWithAnomalies = MetricsHistoryEnvelope & { anomalies: MetricsAnomalyBlock };

/**
 * Compute the anomaly block for a served envelope: every plane metric
 * series and every per-device client series, flagged against its own
 * median. Pure in the envelope — the same envelope always yields the same
 * block, which is what keeps the demo envelope deterministic.
 */
export function metricsAnomalies(
  envelope: MetricsHistoryEnvelope,
  options: AnomalyOptions = {},
): MetricsAnomalyBlock {
  const planes: MetricsAnomalyBlock['planes'] = {};
  for (const [label, series] of Object.entries(envelope.planes)) {
    for (const metric of ['devices', 'devicesDown', 'clients', 'alerts'] as const) {
      const flags = anomalyFlags(series[metric], options);
      if (flags.length > 0) (planes[label] ??= {})[metric] = flags;
    }
  }
  const deviceClients: Record<string, AnomalyFlag[]> = {};
  for (const [device, series] of Object.entries(envelope.deviceClients)) {
    const flags = anomalyFlags(series, options);
    if (flags.length > 0) deviceClients[device] = flags;
  }
  return { planes, deviceClients };
}

/**
 * The anomaly block of a served envelope, when the server computed one.
 * The field is additive, so an older server sends none — and a UI must read
 * that as "no flags to draw", never as a parse failure.
 */
export function envelopeAnomalies(envelope: MetricsHistoryEnvelope): MetricsAnomalyBlock | null {
  return (envelope as Partial<MetricsEnvelopeWithAnomalies>).anomalies ?? null;
}
