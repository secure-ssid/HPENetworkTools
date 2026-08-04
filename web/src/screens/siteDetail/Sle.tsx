/**
 * web/src/screens/siteDetail/Sle.tsx — the site page's Mist SLE section and
 * the per-metric drill-down drawer behind it.
 *
 * The section renders the polled MistSleRow: the overall score plus one
 * clickable row per metric the site scores (`sle.metrics`). Clicking opens
 * the drill drawer, which is the ONLY caller of the lazy drill endpoint —
 * the route spends four per-metric endpoints on the Mist plane, so nothing
 * here fetches on the poll cadence.
 *
 * The drawer's honesty rules mirror the portal's other detail reads:
 *  - a payload renders per-section, worded off `source.sections` — 'ok' with
 *    rows, 'empty' (the plane answered with nothing), 'failed' (the call
 *    broke) and 'not-fetched' (never asked) are four different sentences;
 *  - the route answering 404 / `sleDetail: null` is "not reported", a
 *    straight sentence rather than an empty drill;
 *  - the read itself failing (HTTP 500, unreachable) is a failure sentence,
 *    never an empty drill.
 */

import { useEffect, useState } from 'react';
import { Badge, Drawer, SectionHeader, Sparkline, Spinner } from '../../nightdesk';
import { getSleMetricDetail, type SleMetricDetailResult } from '../../api/client';
import { countOf, detailHasRows, detailState, hhmmLocal as hhmm } from '@hpe/shared';
import type {
  MetricPoint,
  MistSleClassifier,
  MistSleImpact,
  MistSleMetric,
  MistSleMetricDetail,
  MistSleRow,
  MistSleTrend,
  Tone,
} from '@hpe/shared';

/** ≥0.9 good, 0.7–0.9 moderate, <0.7 poor — the SLE badge's own thresholds,
 *  the same rule the Sites screen's badge follows (Mist scores per
 *  classifier, not per the merged inventory's health mix). */
function sleTone(success: number | null): Tone {
  if (success === null) return 'neutral';
  if (success >= 0.9) return 'success';
  if (success >= 0.7) return 'warning';
  return 'danger';
}

function pct(v: number | null): string {
  return v === null ? '—' : `${Math.round(v * 100)}%`;
}

/** 'time-to-connect' -> 'Time to connect' — display-only; the wire name stays
 *  Mist's (it is also the drill route's key). */
function metricLabel(name: string): string {
  const words = name.replace(/-/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** '36 of 1,240 users · 4 of 72 APs' — each half only when both of its
 *  numbers were reported; an impact the row did not carry reads '—' rather
 *  than inventing a zero impact. */
function impactLabel(impact: MistSleImpact | null): string {
  if (!impact) return '—';
  const parts: string[] = [];
  if (impact.numUsers !== null) {
    parts.push(
      impact.totalUsers !== null
        ? `${impact.numUsers} of ${impact.totalUsers.toLocaleString()} users`
        : countOf(impact.numUsers, 'user'),
    );
  }
  if (impact.numAps !== null) {
    parts.push(
      impact.totalAps !== null
        ? `${impact.numAps} of ${impact.totalAps.toLocaleString()} APs`
        : countOf(impact.numAps, 'AP'),
    );
  }
  return parts.length > 0 ? parts.join(' · ') : '—';
}

/** Summed observation seconds as an operator says them ('56 min', '1.4 h'). */
function durationLabel(sec: number | null): string | null {
  if (sec === null || !Number.isFinite(sec) || sec <= 0) return null;
  const minutes = sec / 60;
  if (minutes < 90) return `${Math.max(1, Math.round(minutes))} min`;
  return `${(minutes / 60).toFixed(1)} h`;
}



/** One drill section's honest sentence for the three no-rows outcomes. */
function sectionNote(
  detail: MistSleMetricDetail,
  section: 'classifiers' | 'impactedClients' | 'impactedAps' | 'trend',
  what: string,
): string {
  const state = detailState(detail.source, section);
  if (state === 'failed') {
    return `The ${what} read failed${detail.source.note ? ` — ${detail.source.note}` : ''}.`;
  }
  if (state === 'empty') return `Mist reported no ${what} for this metric in the read window.`;
  return `${what.charAt(0).toUpperCase()}${what.slice(1)} were not fetched.`;
}

/** The trend series as a success-% sparkline. Intervals with no total (or a
 *  null degraded count) carry no countable success fraction and are skipped —
 *  a gap is honest, a zero would be a reading. */
function trendPoints(trend: MistSleTrend): MetricPoint[] {
  const points: MetricPoint[] = [];
  const start = trend.startSec;
  const step = trend.intervalSec;
  for (let i = 0; i < trend.total.length; i += 1) {
    const total = trend.total[i];
    const degraded = trend.degraded[i];
    if (total === null || total === undefined || total <= 0) continue;
    if (degraded === null || degraded === undefined) continue;
    const at = start !== null && step !== null ? new Date((start + i * step) * 1000).toISOString() : '';
    points.push({ t: at, v: Math.max(0, Math.min(100, (1 - degraded / total) * 100)) });
  }
  return points;
}

function TrendSection({ detail }: { detail: MistSleMetricDetail }) {
  const trend = detail.trend;
  const points = trend ? trendPoints(trend) : [];
  const windowLabel =
    trend?.startSec != null && trend.endSec != null
      ? `${hhmm(new Date(trend.startSec * 1000).toISOString())}–${hhmm(new Date(trend.endSec * 1000).toISOString())}`
      : null;
  return (
    <div className="nt-stack nt-gap-8">
      <SectionHeader label="Trend" meta={windowLabel ?? undefined} />
      {detailHasRows(detail.source, 'trend', points) ? (
        <>
          <Sparkline
            points={points}
            width={360}
            height={44}
            stroke="var(--nd-accent)"
            label={`${metricLabel(detail.metric)} success, ${countOf(points.length, 'interval')}${windowLabel ? ` · ${windowLabel}` : ''}`}
          />
          <div className="nt-hint-muted">
            success per interval, from the summary trend's total/degraded counts
          </div>
        </>
      ) : (
        <div className="nt-service-note">
          {detailState(detail.source, 'trend') === 'ok'
            ? 'The trend carried no countable intervals in the read window.'
            : sectionNote(detail, 'trend', 'trend')}
        </div>
      )}
    </div>
  );
}

function ClassifierRow({ c }: { c: MistSleClassifier }) {
  const duration = durationLabel(c.durationSec);
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'baseline',
        justifyContent: 'space-between',
        gap: 12,
        padding: '8px 0',
        borderBottom: '1px solid var(--nd-border-subtle)',
      }}
    >
      <span className="nt-body-sm" style={{ color: "var(--nd-text-primary)" }}>
        {metricLabel(c.name)}
      </span>
      <span className="nt-hint-muted" style={{ textAlign: "right" }}>
        {c.degraded !== null ? `${c.degraded.toLocaleString()} degraded` : '—'}
        {c.samples !== null ? ` of ${c.samples.toLocaleString()} samples` : ''}
        {duration ? ` · ${duration}` : ''}
        {c.impact ? ` · ${impactLabel(c.impact)}` : ''}
      </span>
    </div>
  );
}

function ImpactedRow({ name, mac, degraded }: { name: string | null; mac: string; degraded: number | null }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'baseline',
        justifyContent: 'space-between',
        gap: 12,
        padding: '8px 0',
        borderBottom: '1px solid var(--nd-border-subtle)',
      }}
    >
      <span style={{ minWidth: 0 }}>
        <span className="nt-body-sm" style={{ color: "var(--nd-text-primary)" }}>
          {name ?? mac}
        </span>
        {name !== null ? (
          <span className="nt-hint-muted" style={{ marginLeft: 8 }}>{mac}</span>
        ) : null}
      </span>
      <span className="nt-hint-muted">
        {degraded !== null ? `${countOf(degraded, 'degraded sample')}` : '—'}
      </span>
    </div>
  );
}

/** The drill drawer's body for one settled read. */
function DrillBody({ result }: { result: SleMetricDetailResult }) {
  if (result.kind === 'not-reported') {
    return (
      <div className="nt-service-note">
        No drill-down was reported for this metric at this site — Mist publishes one only for a
        metric the site scored in the read window.
      </div>
    );
  }
  if (result.kind === 'failed') {
    return (
      <div className="nt-hint-muted" style={{ color: "var(--nd-danger)" }}>
        The drill-down read failed — {result.message}
      </div>
    );
  }
  const { detail } = result;
  const readAt = hhmm(detail.source.at);
  return (
    <div className="nt-stack nt-gap-22">
      <div className="nt-hint-muted">
        {`MIST · READ ${readAt}${detail.source.cached ? ' · CACHED' : ''}`}
      </div>
      <TrendSection detail={detail} />
      <div className="nt-stack nt-gap-2">
        <SectionHeader label="Classifiers" meta="WHY IT DEGRADES" />
        {detailHasRows(detail.source, 'classifiers', detail.classifiers)
          ? detail.classifiers!.map((c) => <ClassifierRow key={c.name} c={c} />)
          : <div className="nt-service-note">{sectionNote(detail, 'classifiers', 'classifiers')}</div>}
      </div>
      <div className="nt-stack nt-gap-2">
        <SectionHeader label="Impacted clients" meta="WHO" />
        {detailHasRows(detail.source, 'impactedClients', detail.impactedClients)
          ? detail.impactedClients!.map((c) => (
              <ImpactedRow key={c.mac} name={c.name} mac={c.mac} degraded={c.degraded} />
            ))
          : <div className="nt-service-note">{sectionNote(detail, 'impactedClients', 'impacted clients')}</div>}
      </div>
      <div className="nt-stack nt-gap-2">
        <SectionHeader label="Impacted APs" meta="WHERE" />
        {detailHasRows(detail.source, 'impactedAps', detail.impactedAps)
          ? detail.impactedAps!.map((ap) => (
              <ImpactedRow key={ap.mac} name={ap.name} mac={ap.mac} degraded={ap.degraded} />
            ))
          : <div className="nt-service-note">{sectionNote(detail, 'impactedAps', 'impacted APs')}</div>}
      </div>
    </div>
  );
}

/** One metric row in the section — clickable into the drill drawer. */
function MetricRow({ metric, onOpen }: { metric: MistSleMetric; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        width: '100%',
        padding: '9px 0',
        border: 'none',
        borderBottom: '1px solid var(--nd-border-subtle)',
        background: 'none',
        cursor: 'pointer',
        textAlign: 'left',
      }}
    >
      <span style={{ flex: 1, minWidth: 0 }}>
        <span className="nt-body-sm" style={{ display: "block", color: "var(--nd-text-primary)" }}>
          {metricLabel(metric.name)}
        </span>
        <span className="nt-hint-muted">
          {metric.degraded !== null && metric.samples !== null
            ? `${metric.degraded.toLocaleString()} degraded of ${metric.samples.toLocaleString()} samples`
            : 'sample counts not reported'}
          {` · ${impactLabel(metric.impact)}`}
        </span>
      </span>
      <Badge tone={sleTone(metric.success)}>{pct(metric.success)}</Badge>
      <span className="nt-service-note">drill →</span>
    </button>
  );
}

/** The five headline fractions when the row carries no per-metric detail —
 *  shown but not clickable: there is no metric name to drill with. */
function HeadlineRows({ sle }: { sle: MistSleRow }) {
  const rows: Array<{ k: string; v: number | null }> = [
    { k: 'Coverage', v: sle.coverage },
    { k: 'Capacity', v: sle.capacity },
    { k: 'Roaming', v: sle.roaming },
    { k: 'AP health', v: sle.apHealth },
    { k: 'WAN', v: sle.wan },
  ];
  return (
    <>
      {rows.map((row) => (
        <div
          key={row.k}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            padding: '9px 0',
            borderBottom: '1px solid var(--nd-border-subtle)',
          }}
        >
          <span className="nt-body-sm" style={{ color: "var(--nd-text-primary)" }}>{row.k}</span>
          <Badge tone={sleTone(row.v)}>{pct(row.v)}</Badge>
        </div>
      ))}
      <div className="nt-hint-muted" style={{ paddingTop: 6 }}>
        Per-metric detail was not reported for this site, so there is nothing to drill into.
      </div>
    </>
  );
}

/**
 * The wireless-experience section: the site's Mist SLE scores, each metric
 * clickable into its drill-down drawer. Rendered for every site — a site no
 * plane scores gets the honest not-reported line, never a 0% score.
 */
export function SiteSle({
  sle,
  mistClaimed,
  siteKey,
  siteName,
}: {
  sle: MistSleRow | null | undefined;
  /** True when a Mist badge claims the site — selects which honest empty
   *  sentence the section shows (Mist has SLE and said nothing vs no plane
   *  publishes SLE here at all). */
  mistClaimed: boolean;
  /** The key the drill route resolves — the canonical site id. */
  siteKey: string;
  siteName: string;
}) {
  /* The open drill: which metric, and its read result (null = in flight).
   * Keyed by metric so a late answer is filed against the metric asked about,
   * and re-opening a metric this mount re-reads (the server TTL-caches, so a
   * reopen inside the window costs no plane call). */
  const [drill, setDrill] = useState<{ metric: string; result: SleMetricDetailResult | null } | null>(null);

  useEffect(() => {
    if (!drill || drill.result !== null) return;
    let live = true;
    const metric = drill.metric;
    void getSleMetricDetail(siteKey, metric)
      .then((result) => {
        if (live) setDrill((cur) => (cur && cur.metric === metric ? { ...cur, result } : cur));
      })
      .catch(() => {
        if (live) {
          setDrill((cur) =>
            cur && cur.metric === metric
              ? { ...cur, result: { kind: 'failed', message: 'the drill-down request failed' } }
              : cur,
          );
        }
      });
    return () => {
      live = false;
    };
  }, [drill, siteKey]);

  return (
    <div className="nt-stack nt-gap-2">
      <SectionHeader
        label="Wireless experience"
        meta={sle ? `OVERALL ${pct(sle.overall)} · MIST SLE` : 'NOT REPORTED'}
      />
      {sle === undefined ? (
        <div className="nt-service-note">The portal did not say whether this site reports SLE scores.</div>
      ) : sle === null ? (
        <div className="nt-service-note">
          {mistClaimed
            ? 'Mist reported no SLE scores for this site this cycle — an unscored window is "not reported", never a 0%.'
            : 'No linked plane publishes SLE scores for this site.'}
        </div>
      ) : (
        <>
          {sle.metrics && sle.metrics.length > 0 ? (
            sle.metrics.map((m) => (
              <MetricRow key={m.name} metric={m} onOpen={() => setDrill({ metric: m.name, result: null })} />
            ))
          ) : (
            <HeadlineRows sle={sle} />
          )}
        </>
      )}
      <Drawer
        open={drill !== null}
        onOpenChange={(open) => {
          if (!open) setDrill(null);
        }}
        width="lg"
        title={drill ? metricLabel(drill.metric) : undefined}
        description={drill ? `${siteName} · Mist SLE drill-down` : undefined}
      >
        {drill ? (
          drill.result === null ? (
            <div className="nt-center-pad" style={{ padding: 48 }}>
              <Spinner size="md" />
            </div>
          ) : (
            <DrillBody result={drill.result} />
          )
        ) : (
          <></>
        )}
      </Drawer>
    </div>
  );
}
