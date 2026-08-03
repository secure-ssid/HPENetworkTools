import { countOf } from '@hpe/shared';
import type { MetricPoint } from '@hpe/shared';

/** A flagged sample to mark on the line, by series index. Structural: the
 *  shared AnomalyFlag carries (at least) these fields, so callers pass their
 *  flag arrays straight through. */
export type SparklineMarker = {
  /** Index into `points`; out-of-range markers render nothing. */
  index: number;
  /** Which way the point deviated — carried for callers' labels; the dot
   *  itself renders the same warning tone either way. */
  direction?: 'high' | 'low';
};

type SparklineProps = {
  points: MetricPoint[];
  width?: number;
  height?: number;
  /** Text alternative carrying the VALUE ("12 clients · last 24h"): the SVG is
   *  decorative and aria-hidden, so this label is what a screen reader gets. */
  label: string;
  stroke?: string;
  /** Flagged points to dot in the warning tone (anomaly markers). Purely
   *  additive: no markers, no change — and the aria label gains the flag
   *  mention only when there is one to mention. */
  markers?: SparklineMarker[];
};

/**
 * Nightdesk.Sparkline — a hand-rolled table sparkline (the Grafana
 * table-cell pattern): one SVG polyline, no chart library. Callers handle
 * the empty case themselves ("no samples" is honest text, not a flat line);
 * a single sample renders as one dot, never a two-point fiction.
 * `markers` dots a flagged sample in the warning tone — a sample the
 * caller's statistics found unusual, stated in the aria label, never
 * decorated into a prediction.
 */
export function Sparkline({ points, width = 96, height = 18, label, stroke, markers }: SparklineProps) {
  const color = stroke ?? 'var(--nd-accent)';
  const values = points.map((p) => p.v);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min;
  const coords2d = values.map((v, i) => ({
    x: points.length > 1 ? (i / (points.length - 1)) * width : width / 2,
    y: span === 0 ? height / 2 : height - 1.5 - ((v - min) / span) * (height - 3),
  }));
  const coords = coords2d.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`);
  const flagCount = markers?.length ?? 0;
  const ariaLabel = flagCount > 0 ? `${label} · ${countOf(flagCount, 'point')} flagged unusual` : label;
  return (
    <span role="img" aria-label={ariaLabel} title={ariaLabel} style={{ display: 'inline-flex', verticalAlign: 'middle' }}>
      <svg aria-hidden="true" width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
        {points.length === 1 ? (
          <circle cx={width / 2} cy={height / 2} r={1.5} fill={color} />
        ) : (
          <polyline
            points={coords.join(' ')}
            fill="none"
            stroke={color}
            strokeWidth={1.5}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        )}
        {markers?.map((m) => {
          const at = coords2d[m.index];
          if (!at) return null;
          return (
            <circle
              key={m.index}
              cx={at.x.toFixed(1)}
              cy={at.y.toFixed(1)}
              r={2}
              fill="var(--nd-warning)"
              stroke="var(--nd-bg-canvas)"
              strokeWidth={0.75}
            />
          );
        })}
      </svg>
    </span>
  );
}
