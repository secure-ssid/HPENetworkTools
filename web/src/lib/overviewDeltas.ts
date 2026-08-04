/**
 * Overview last-hour delta chips from the metrics-history envelope.
 *
 * Pure sums across planes at the newest sample vs ~1h earlier. Empty when
 * the envelope is missing, a plane has no series, or there is no earlier
 * baseline (one sample cannot be a delta). Never invents counts.
 */

import type { MetricPoint, MetricsHistoryEnvelope, PlaneMetricsSeries, StatDef } from '@hpe/shared';

export type OverviewDeltaTone = 'positive' | 'negative' | 'neutral';

export type OverviewDeltaChip = {
  id: 'devices-down' | 'alerts' | 'devices' | 'clients' | 'licences';
  label: string;
  href: string;
  tone: OverviewDeltaTone;
};

const HOUR_MS = 60 * 60 * 1000;

const SERIES_KEYS = ['devices', 'devicesDown', 'clients', 'alerts'] as const;
type SeriesKey = (typeof SERIES_KEYS)[number];

/** Sample closest to `targetMs` (absolute distance). */
export function pointNear(points: readonly MetricPoint[], targetMs: number): MetricPoint | null {
  if (points.length === 0) return null;
  let best = points[0]!;
  let bestDist = Math.abs(Date.parse(best.t) - targetMs);
  for (let i = 1; i < points.length; i += 1) {
    const p = points[i]!;
    const d = Math.abs(Date.parse(p.t) - targetMs);
    if (d < bestDist) {
      best = p;
      bestDist = d;
    }
  }
  return best;
}

/** Newest sample timestamp across every non-empty plane series, or null. */
export function latestSampleMs(planes: MetricsHistoryEnvelope['planes']): number | null {
  let max = -Infinity;
  for (const series of Object.values(planes)) {
    for (const key of SERIES_KEYS) {
      const pts = series[key];
      if (!pts || pts.length === 0) continue;
      const t = Date.parse(pts[pts.length - 1]!.t);
      if (Number.isFinite(t) && t > max) max = t;
    }
  }
  return Number.isFinite(max) && max > -Infinity ? max : null;
}

function sumAt(
  planes: MetricsHistoryEnvelope['planes'],
  key: SeriesKey,
  atMs: number,
): number | null {
  let sum = 0;
  let any = false;
  for (const series of Object.values(planes) as PlaneMetricsSeries[]) {
    const pts = series[key];
    if (!pts || pts.length === 0) continue;
    const p = pointNear(pts, atMs);
    if (!p) continue;
    sum += p.v;
    any = true;
  }
  return any ? sum : null;
}

function formatSigned(n: number): string {
  return n > 0 ? `+${n}` : String(n);
}

/**
 * Build actionable chips for the Overview "what changed" strip.
 * `nowMs` is injectable for tests; production uses the newest sample clock.
 */
export function overviewHourDeltas(
  metrics: MetricsHistoryEnvelope | null | undefined,
  nowMs?: number,
): OverviewDeltaChip[] {
  if (!metrics || Object.keys(metrics.planes).length === 0) return [];

  const latest = latestSampleMs(metrics.planes);
  if (latest === null) return [];

  const endMs = nowMs ?? latest;
  const startMs = endMs - HOUR_MS;

  // Need a baseline sample at least ~half a sample cadence before "now".
  const minSpan = Math.max(metrics.sampleMs * 0.5, 60_000);

  const chips: OverviewDeltaChip[] = [];

  const downNow = sumAt(metrics.planes, 'devicesDown', endMs);
  const downThen = sumAt(metrics.planes, 'devicesDown', startMs);
  if (downNow !== null && downThen !== null && Math.abs(endMs - startMs) >= minSpan) {
    // Only emit when baseline and latest are distinct enough in time on raw series.
    const spanOk = hasSpan(metrics.planes, 'devicesDown', minSpan);
    if (spanOk) {
      const d = downNow - downThen;
      if (d > 0) {
        chips.push({
          id: 'devices-down',
          label: `${formatSigned(d)} down`,
          href: '/devices',
          tone: 'negative',
        });
      } else if (d < 0) {
        chips.push({
          id: 'devices-down',
          label: `${Math.abs(d)} recovered`,
          href: '/devices',
          tone: 'positive',
        });
      }
    }
  }

  const alertsNow = sumAt(metrics.planes, 'alerts', endMs);
  const alertsThen = sumAt(metrics.planes, 'alerts', startMs);
  if (alertsNow !== null && alertsThen !== null && hasSpan(metrics.planes, 'alerts', minSpan)) {
    const d = alertsNow - alertsThen;
    if (d > 0) {
      chips.push({
        id: 'alerts',
        label: `${formatSigned(d)} alerts`,
        href: '/alerts',
        tone: 'negative',
      });
    } else if (d < 0) {
      chips.push({
        id: 'alerts',
        label: `${Math.abs(d)} fewer alerts`,
        href: '/alerts',
        tone: 'positive',
      });
    }
  }

  const devNow = sumAt(metrics.planes, 'devices', endMs);
  const devThen = sumAt(metrics.planes, 'devices', startMs);
  if (devNow !== null && devThen !== null && hasSpan(metrics.planes, 'devices', minSpan)) {
    const d = devNow - devThen;
    if (d !== 0) {
      chips.push({
        id: 'devices',
        label: `${formatSigned(d)} devices`,
        href: '/devices',
        tone: 'neutral',
      });
    }
  }

  const cliNow = sumAt(metrics.planes, 'clients', endMs);
  const cliThen = sumAt(metrics.planes, 'clients', startMs);
  if (cliNow !== null && cliThen !== null && hasSpan(metrics.planes, 'clients', minSpan)) {
    const d = cliNow - cliThen;
    if (d !== 0) {
      chips.push({
        id: 'clients',
        label: `${formatSigned(d)} clients`,
        href: '/clients',
        tone: 'neutral',
      });
    }
  }

  return chips;
}

/** True when at least one plane series for `key` spans `minSpanMs`. */
function hasSpan(
  planes: MetricsHistoryEnvelope['planes'],
  key: SeriesKey,
  minSpanMs: number,
): boolean {
  for (const series of Object.values(planes)) {
    const pts = series[key];
    if (!pts || pts.length < 2) continue;
    const first = Date.parse(pts[0]!.t);
    const last = Date.parse(pts[pts.length - 1]!.t);
    if (Number.isFinite(first) && Number.isFinite(last) && last - first >= minSpanMs) return true;
  }
  return false;
}

/**
 * Expiring-licence chip from Overview stats (e.g. "Licences ≤60d" → 34).
 * Snapshot count, not a metrics delta — still actionable on the same strip.
 * Hidden when the label is missing, unparseable, or zero.
 */
export function overviewLicenceChip(
  stats: readonly StatDef[] | null | undefined,
): OverviewDeltaChip | null {
  if (!stats || stats.length === 0) return null;
  const row = stats.find((s) => {
    const label = s.label.trim().toLowerCase();
    return label.startsWith('licences') || label.startsWith('licenses');
  });
  if (!row) return null;
  const raw = String(row.value).replace(/,/g, '').trim();
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  return {
    id: 'licences',
    label: n === 1 ? '1 licence ≤60d' : `${n} licences ≤60d`,
    href: '/licenses',
    tone: 'negative',
  };
}

/** Merge last-hour deltas with the optional expiring-licence snapshot chip. */
export function overviewActionChips(
  metrics: MetricsHistoryEnvelope | null | undefined,
  stats?: readonly StatDef[] | null,
  nowMs?: number,
): OverviewDeltaChip[] {
  const chips = overviewHourDeltas(metrics, nowMs);
  const licence = overviewLicenceChip(stats);
  if (licence) chips.push(licence);
  return chips;
}
