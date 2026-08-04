/**
 * web/src/screens/deviceDetail/trends.tsx — the 'Hardware trends' panel:
 * Central's per-device telemetry (a switch's hardware gauges and interface
 * error counters, an AP's cpu/memory/throughput), read ON DEMAND for the one
 * device being viewed — one fetch per mount and per window change, never on
 * the 60s poll (the route behind it spends the metered plane call).
 *
 * The honesty rules this panel exists under:
 *
 *  - A gap stays a gap. The normalizer marks missing buckets with explicit
 *    null points, and TrendSpark breaks the line at every one of them — a
 *    confident line across a telemetry outage is a lie with a slope.
 *  - "Current" means the latest SAMPLE the window carried, and the tile
 *    captions its timestamp; it never reads as a live reading.
 *  - Every read outcome is worded: not asked / asked and nothing usable /
 *    asked and it broke are three different sentences, and a failed section
 *    names the plane's own note rather than implying the device has no
 *    telemetry.
 *  - Interface error counters follow the reference collapse rule: a counter
 *    that moved earns a row with its total and rate line; counters that
 *    stayed at zero are stated once, together, underneath — and a counter
 *    the plane never sampled is not claimed as either.
 */

import { useEffect, useState } from 'react';
import { Button, SectionHeader, SegmentedControl, useToast } from '../../nightdesk';
import {
  AP_TREND_METRICS,
  countOf,
  detailState,
  formatCount,
  hhmmLocal as hhmm,
  type ApTrendMetric,
  type ApTrendsLive,
  type DetailSource,
  type SwitchHardwareTrendsLive,
  type SwitchInterfaceTrendsLive,
  type TrendPoint,
  type TrendSeries,
} from '@hpe/shared';
import {
  getDeviceApTrends,
  getDeviceHardwareTrends,
  getDeviceInterfaceTrends,
  type DeviceDetailIdentity,
  type DeviceTrendResult,
} from '../../api/client';
import { exportTableCsv } from '../../lib/csv';
import { downloadApiCsv } from '../../lib/downloadApiCsv';
import { isSecretDeviceField, speedText } from './facts';
import { LiveGapNote } from './tables';

// ---------------------------------------------------------------------------
// Window selection
// ---------------------------------------------------------------------------

const TREND_WINDOWS = [
  { value: '1h', label: '1h' },
  { value: '6h', label: '6h' },
  { value: '24h', label: '24h' },
  { value: '3d', label: '3d' },
  { value: '7d', label: '7d' },
];
type TrendWindowKey = (typeof TREND_WINDOWS)[number]['value'];

const TREND_WINDOW_MS: Record<TrendWindowKey, number> = {
  '1h': 60 * 60_000,
  '6h': 6 * 60 * 60_000,
  '24h': 24 * 60 * 60_000,
  '3d': 3 * 24 * 60 * 60_000,
  '7d': 7 * 24 * 60 * 60_000,
};

// ---------------------------------------------------------------------------
// Series wording
// ---------------------------------------------------------------------------

const SERIES_LABEL: Record<string, string> = {
  cpuUtilization: 'CPU',
  memoryUtilization: 'Memory',
  systemTemperature: 'System temp',
  poeAvailable: 'PoE budget',
  poeConsumption: 'PoE draw',
  powerConsumption: 'System power',
  totalPowerConsumption: 'Total power',
  throughput: 'Throughput',
};

function seriesLabel(key: string): string {
  return SERIES_LABEL[key] ?? key;
}

/** Bits per second as an engineer writes a RATE: 950000000 → '950 Mb/s'. */
export function rateText(bps: number | null | undefined): string | null {
  const text = speedText(bps);
  return text === null ? null : `${text}/s`;
}

/**
 * Flatten trend series to CSV rows. Only metric key / timestamp / numeric
 * sample — never device secrets, claim codes, or raw vendor bodies.
 */
export function trendSeriesExportRows(seriesList: readonly TrendSeries[]): Array<Array<string | number>> {
  const rows: Array<Array<string | number>> = [];
  for (const s of seriesList) {
    if (isSecretDeviceField(s.key)) continue;
    for (const p of s.points ?? []) {
      if (p == null || p.v == null) continue;
      rows.push([s.key, p.t, p.v]);
    }
  }
  return rows;
}

/** One series value with its unit, as the series' own kind dictates. */
function seriesValueText(series: TrendSeries, v: number): string {
  if (series.key === 'cpuUtilization' || series.key === 'memoryUtilization') return `${Math.round(v)}%`;
  if (series.key === 'systemTemperature') return `${v.toFixed(1)} °C`;
  if (series.rate === 'bits-per-second') return rateText(v) ?? '—';
  if (series.rate === 'per-second') return `${v.toFixed(2)}/s`;
  return `${Math.round(v)} W`;
}

/** The latest usable sample on a series — never a hole dressed as current. */
function latestPoint(series: TrendSeries): TrendPoint | null {
  for (let i = series.points.length - 1; i >= 0; i -= 1) {
    const point = series.points[i]!;
    if (point.v !== null) return point;
  }
  return null;
}

/**
 * The first coverage hole across these series, worded from the missing
 * buckets themselves ('no samples 03:00–05:00'). A leading null — a counter
 * series' first sample has no predecessor and yields no rate — is NOT a
 * coverage hole, so only a null sitting between two real samples qualifies.
 */
export function gapPhrase(series: TrendSeries[]): string | null {
  for (const s of series) {
    for (let i = 1; i < s.points.length; i += 1) {
      const point = s.points[i]!;
      if (point.v !== null) continue;
      const before = s.points[i - 1]!;
      if (before.v === null) continue;
      const after = s.points.slice(i + 1).find((p) => p.v !== null);
      if (!after) continue;
      return `no samples ${hhmm(point.t)}–${hhmm(after.t)}`;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// TrendSpark — a sparkline that breaks at every hole
// ---------------------------------------------------------------------------

/**
 * A gap-aware sparkline in nightdesk.Sparkline's visual language (one SVG,
 * no chart library, x by sample index). Where Sparkline draws one polyline,
 * this draws one polyline per contiguous run of real samples and NOTHING
 * across a null point — the hole is the information. A run of one sample
 * renders as one dot, never a two-point fiction.
 */
export function TrendSpark({
  points,
  label,
  width = 132,
  height = 22,
  stroke,
}: {
  points: TrendPoint[];
  label: string;
  width?: number;
  height?: number;
  stroke?: string;
}) {
  const color = stroke ?? 'var(--nd-accent)';
  const values = points.filter((p) => p.v !== null).map((p) => p.v as number);
  if (values.length === 0) return null; // the caller words the empty case
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min;
  const xAt = (i: number) => (points.length > 1 ? (i / (points.length - 1)) * width : width / 2);
  const yAt = (v: number) => (span === 0 ? height / 2 : height - 1.5 - ((v - min) / span) * (height - 3));

  const runs: Array<Array<{ x: number; y: number }>> = [];
  let current: Array<{ x: number; y: number }> = [];
  points.forEach((point, i) => {
    if (point.v === null) {
      if (current.length > 0) runs.push(current);
      current = [];
      return;
    }
    current.push({ x: xAt(i), y: yAt(point.v) });
  });
  if (current.length > 0) runs.push(current);

  // A break is a hole BETWEEN two real samples — the outage in the middle of
  // the line. An edge hole (a counter's first sample yields no rate, so the
  // line simply starts one bucket later) is not a missing-sample break and
  // is never announced as one.
  const broken = points.some(
    (p, i) =>
      p.v === null && points.slice(0, i).some((q) => q.v !== null) && points.slice(i + 1).some((q) => q.v !== null),
  );
  const ariaLabel = broken ? `${label} · line broken where samples are missing` : label;
  return (
    <span role="img" aria-label={ariaLabel} title={ariaLabel} className="nt-inline-flex nt-v-mid">
      <svg aria-hidden="true" width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
        {runs.map((run, index) =>
          run.length === 1 ? (
            <circle key={index} cx={run[0]!.x.toFixed(1)} cy={run[0]!.y.toFixed(1)} r={1.5} fill={color} />
          ) : (
            <polyline
              key={index}
              points={run.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')}
              fill="none"
              stroke={color}
              strokeWidth={1.5}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          ),
        )}
      </svg>
    </span>
  );
}

// ---------------------------------------------------------------------------
// Small building blocks (the device page's own visual language)
// ---------------------------------------------------------------------------

/** One small tile: a micro label, the value, and a caption naming the sample
 *  it came from — "current" is always the latest sample, never a live claim. */
function TrendTile({ label, value, caption, pct }: { label: string; value: string; caption: string; pct?: number | null }) {
  return (
    <div className="nt-device-section nt-section-panel nt-stack nt-gap-5 nt-min-w-0">
      <span
        className="nt-mono-label"
      >
        {label}
      </span>
      {pct !== null && pct !== undefined ? (
        <span
          aria-hidden
          className="nt-trend-track"
        >
          <span
            className="nt-trend-fill" style={{ ["--nd-health" as string]: `${Math.min(100, Math.max(0, pct))}%` }}
          />
        </span>
      ) : null}
      <span
        className="nt-configure-row__name-primary"
      >
        {value}
      </span>
      <span
        className="nt-hint-muted"
      >
        {caption}
      </span>
    </div>
  );
}

/** One sparkline row: series label, the broken-at-gaps line, latest sample. */
function TrendRow({ series }: { series: TrendSeries }) {
  const latest = latestPoint(series);
  return (
    <div
      className="nt-trend-row"
    >
      <span
        className="nt-mono-label nt-w-104"
      >
        {seriesLabel(series.key)}
      </span>
      <span className="nt-flex-none">
        <TrendSpark
          points={series.points}
          label={`${seriesLabel(series.key)} trend, ${countOf(series.samples, 'sample')}`}
        />
      </span>
      <span
        className="nt-mono-11 nt-ellipsis nt-trend-val"
      >
        {latest ? `${seriesValueText(series, latest.v as number)} · at ${hhmm(latest.t)}` : 'no usable samples'}
      </span>
    </div>
  );
}

/** The coverage/provenance caption under a read: what it describes, what the
 *  window actually carried, where it breaks, and when the plane was read. */
function TrendCaption({ live, section }: { live: SwitchHardwareTrendsLive | SwitchInterfaceTrendsLive | ApTrendsLive; section: string }) {
  const series = live.trends?.series ?? [];
  const points = series.flatMap((s) => s.points.filter((p) => p.v !== null));
  const sorted = points.map((p) => p.t).sort();
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const gap = gapPhrase(series);
  return (
    <div
      className="nt-hint-muted nt-pad-6-lh"
    >
      {[
        section,
        first && last ? `${countOf(points.length, 'sample')} · ${hhmm(first)}–${hhmm(last)}` : null,
        gap,
        `read ${hhmm(live.source.at)} from ${live.source.plane.toUpperCase()}${live.source.cached ? ' (cached)' : ''}`,
      ]
        .filter((part): part is string => Boolean(part))
        .join(' · ')}
    </div>
  );
}

/** One trend read's outcome as the panel's gap sentence — the four states,
 *  worded differently because an operator acts on them differently. */
function readOutcomeNote(
  result: DeviceTrendResult<SwitchHardwareTrendsLive | SwitchInterfaceTrendsLive | ApTrendsLive>,
  section: string,
  copy: { label: string; notReported: string; empty: string; failed: string },
): { sentence: string } | null {
  if (result.kind === 'not-reported') return { sentence: copy.notReported };
  if (result.kind === 'failed') return { sentence: `${copy.failed} — ${result.message}` };
  const source = result.live.source as DetailSource<string>;
  const state = detailState(source, section);
  if (state === 'failed') {
    return {
      sentence: result.live.source.note ? `${copy.failed} — ${result.live.source.note}` : copy.failed,
    };
  }
  if (state === 'not-fetched') {
    return {
      sentence: result.live.source.note
        ? `${copy.label} was not read — ${result.live.source.note}`
        : `${copy.label} was not read for this device.`,
    };
  }
  // 'empty' — and 'ok' that carried no usable samples — say the same thing.
  if (!result.live.trends?.ok) return { sentence: copy.empty };
  return null;
}

// ---------------------------------------------------------------------------
// Interface error counters — the reference collapse rule
// ---------------------------------------------------------------------------

/** The ten error counters, in the endpoint's own order. */
const ERROR_COUNTERS: ReadonlyArray<{ key: string; label: string }> = [
  { key: 'inErrors', label: 'in errors' },
  { key: 'outErrors', label: 'out errors' },
  { key: 'inDiscards', label: 'in discards' },
  { key: 'outDiscards', label: 'out discards' },
  { key: 'inFcs', label: 'FCS errors' },
  { key: 'inCrcErrors', label: 'CRC errors' },
  { key: 'inFragmented', label: 'fragments' },
  { key: 'outCollision', label: 'collisions' },
  { key: 'inRunts', label: 'runts' },
  { key: 'inGiants', label: 'giants' },
];

/**
 * How much one counter moved across the window. The normalizer differentiated
 * the cumulative counter into per-second rates — point i's value × the
 * seconds since point i−1 IS the counter's movement in that bucket — so the
 * window total is recoverable without re-reading the raw payload. Buckets
 * around a hole (a gap, a counter reset, an unreadable sample) contribute
 * nothing, which is the honest amount: the counter may have moved there and
 * we do not know. null when no bucket yielded a rate at all.
 */
export function counterWindowTotal(series: TrendSeries): number | null {
  let total = 0;
  let counted = false;
  for (let i = 1; i < series.points.length; i += 1) {
    const point = series.points[i]!;
    if (point.v === null) continue;
    const dt = Date.parse(point.t) - Date.parse(series.points[i - 1]!.t);
    if (!Number.isFinite(dt) || dt <= 0) continue;
    total += point.v * (dt / 1000);
    counted = true;
  }
  return counted ? Math.round(total) : null;
}

/** The error block of a switch's interface-trends read: a row per counter
 *  that moved, one line for every counter that stayed at zero. */
function InterfaceErrors({ live }: { live: SwitchInterfaceTrendsLive }) {
  const series = live.trends?.series ?? [];
  const moved: Array<{ key: string; label: string; total: number; series: TrendSeries }> = [];
  const zeroed: string[] = [];
  const unread: string[] = [];
  for (const counter of ERROR_COUNTERS) {
    const s = series.find((entry) => entry.key === counter.key);
    if (!s || s.samples === 0) continue; // the plane never sampled it — claimed as nothing
    const total = counterWindowTotal(s);
    if (total === null) {
      unread.push(counter.label);
    } else if (total === 0) {
      zeroed.push(counter.label);
    } else {
      moved.push({ ...counter, total, series: s });
    }
  }
  return (
    <div className="nt-stack nt-gap-2">
      <div className="nt-plane-theater nt-plane-theater--compact" role="note">NightDesk · trend cinema · telemetry owns hue</div>
      <SectionHeader
        label="Interface errors"
        meta={moved.length > 0 ? `${countOf(moved.length, 'counter')} MOVED` : undefined}
      />
      {moved.map((counter) => (
        <div
          key={counter.key}
          className="nt-trend-row"
        >
          <span
            className="nt-mono-label nt-w-104"
          >
            {counter.label}
          </span>
          <span className="nt-flex-none">
            <TrendSpark points={counter.series.points} label={`${counter.label} rate over the window`} />
          </span>
          <span
            className="nt-mono-11 nt-ellipsis nt-trend-val"
          >
            {formatCount(counter.total)} in the window
          </span>
        </div>
      ))}
      {zeroed.length > 0 ? (
        <LiveGapNote>
          {zeroed.length + moved.length === ERROR_COUNTERS.length && moved.length === 0
            ? `All ${zeroed.length} reported error counters stayed at zero across the window.`
            : `${zeroed.join(', ')} stayed at zero across the window.`}
        </LiveGapNote>
      ) : null}
      {unread.length > 0 ? (
        <LiveGapNote>
          {`${unread.join(', ')}: the counter was sampled but no rate is derivable — differentiation needs two samples.`}
        </LiveGapNote>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The two panel bodies
// ---------------------------------------------------------------------------

/** The switch half: hardware gauges, the PoE budget, interface errors. */
function SwitchTrends({
  hardware,
  interfaces,
}: {
  hardware: DeviceTrendResult<SwitchHardwareTrendsLive>;
  interfaces: DeviceTrendResult<SwitchInterfaceTrendsLive>;
}) {
  const hardwareNote = readOutcomeNote(hardware, 'hardware', {
    label: 'Hardware trends',
    notReported:
      'No hardware-trend read is available for this device — no claiming plane answered for it.',
    empty: 'The plane answered with no usable hardware samples in this window.',
    failed: 'Hardware trends could not be read',
  });
  const interfaceNote = readOutcomeNote(interfaces, 'interfaces', {
    label: 'Interface counters',
    notReported: 'No interface-trend read is available for this device — no claiming plane answered for it.',
    empty: 'The plane answered with no usable interface counters in this window.',
    failed: 'Interface counters could not be read',
  });

  const set = hardware.kind === 'ok' ? hardware.live.trends : undefined;
  const series = set?.ok ? set.series : [];
  const byKey = new Map(series.map((s) => [s.key, s]));
  const tileFor = (key: string) => {
    const s = byKey.get(key);
    const latest = s ? latestPoint(s) : null;
    return s && latest ? { series: s, latest } : null;
  };
  const cpu = tileFor('cpuUtilization');
  const memory = tileFor('memoryUtilization');
  const temperature = tileFor('systemTemperature');
  const poeDraw = tileFor('poeConsumption');
  const poeBudget = tileFor('poeAvailable');
  const poePct =
    poeDraw && poeBudget && (poeBudget.latest.v as number) > 0
      ? Math.round(((poeDraw.latest.v as number) / (poeBudget.latest.v as number)) * 100)
      : null;

  return (
    <>
      {hardwareNote !== null ? (
        <LiveGapNote>{hardwareNote.sentence}</LiveGapNote>
      ) : (
        <>
          <div
            className="nt-stat-grid"
          >
            {cpu ? (
              <TrendTile
                label="CPU"
                value={seriesValueText(cpu.series, cpu.latest.v as number)}
                caption={`latest sample ${hhmm(cpu.latest.t)}`}
              />
            ) : null}
            {memory ? (
              <TrendTile
                label="Memory"
                value={seriesValueText(memory.series, memory.latest.v as number)}
                caption={`latest sample ${hhmm(memory.latest.t)}`}
              />
            ) : null}
            {temperature ? (
              <TrendTile
                label="System temp"
                value={seriesValueText(temperature.series, temperature.latest.v as number)}
                caption={`latest sample ${hhmm(temperature.latest.t)}`}
              />
            ) : null}
            {poeDraw ? (
              <TrendTile
                label="PoE draw"
                value={seriesValueText(poeDraw.series, poeDraw.latest.v as number)}
                caption={
                  poeBudget
                    ? `of ${Math.round(poeBudget.latest.v as number)} W budget · ${hhmm(poeDraw.latest.t)}`
                    : `budget not reported · ${hhmm(poeDraw.latest.t)}`
                }
                pct={poePct}
              />
            ) : null}
          </div>
          {series.map((s) => (s.samples > 0 ? <TrendRow key={s.key} series={s} /> : null))}
          {hardware.kind === 'ok' ? <TrendCaption live={hardware.live} section="hardware gauges" /> : null}
        </>
      )}
      {interfaceNote !== null ? (
        <LiveGapNote>{interfaceNote.sentence}</LiveGapNote>
      ) : interfaces.kind === 'ok' ? (
        <>
          <InterfaceErrors live={interfaces.live} />
          <TrendCaption live={interfaces.live} section="interface counters" />
        </>
      ) : null}
    </>
  );
}

/** The AP half: one row per metric, each with its own read outcome — a metric
 *  whose call broke says so beside the two that answered. */
function ApTrends({ reads }: { reads: Partial<Record<ApTrendMetric, DeviceTrendResult<ApTrendsLive>>> }) {
  const okReads = AP_TREND_METRICS.map((metric) => reads[metric]).filter(
    (r): r is DeviceTrendResult<ApTrendsLive> & { kind: 'ok' } => r?.kind === 'ok',
  );
  const cpu = reads.cpu?.kind === 'ok' ? reads.cpu.live.trends?.series[0] : undefined;
  const memory = reads.memory?.kind === 'ok' ? reads.memory.live.trends?.series[0] : undefined;
  const throughput = reads.throughput?.kind === 'ok' ? reads.throughput.live.trends?.series[0] : undefined;
  const cpuLatest = cpu && cpu.samples > 0 ? latestPoint(cpu) : null;
  const memoryLatest = memory && memory.samples > 0 ? latestPoint(memory) : null;
  const throughputLatest = throughput && throughput.samples > 0 ? latestPoint(throughput) : null;

  return (
    <>
      {okReads.length === 0 ? null : (
        <div
          className="nt-stat-grid"
        >
          {cpuLatest && cpu ? (
            <TrendTile
              label="CPU"
              value={seriesValueText(cpu, cpuLatest.v as number)}
              caption={`latest sample ${hhmm(cpuLatest.t)}`}
            />
          ) : null}
          {memoryLatest && memory ? (
            <TrendTile
              label="Memory"
              value={seriesValueText(memory, memoryLatest.v as number)}
              caption={`latest sample ${hhmm(memoryLatest.t)}`}
            />
          ) : null}
          {throughputLatest && throughput ? (
            <TrendTile
              label="Throughput"
              value={seriesValueText(throughput, throughputLatest.v as number)}
              caption={`latest sample ${hhmm(throughputLatest.t)}`}
            />
          ) : null}
        </div>
      )}
      {AP_TREND_METRICS.map((metric) => {
        const result = reads[metric];
        if (!result) return null;
        const note = readOutcomeNote(result, 'trends', {
          label: `The ${metric} trend`,
          notReported: `No ${metric} trend read is available for this AP — no claiming plane answered for it.`,
          empty: `The plane answered with no usable ${metric} samples in this window.`,
          failed: `The ${metric} trend could not be read`,
        });
        if (note !== null) {
          return <LiveGapNote key={metric}>{note.sentence}</LiveGapNote>;
        }
        const s = result.kind === 'ok' ? result.live.trends?.series[0] : undefined;
        if (!s) return null;
        return <TrendRow key={metric} series={s} />;
      })}
      {okReads.map((result) => (
        <TrendCaption key={result.live.metric} live={result.live} section={`${result.live.metric} trend`} />
      ))}
    </>
  );
}

// ---------------------------------------------------------------------------
// The panel
// ---------------------------------------------------------------------------

interface TrendsState {
  hardware: DeviceTrendResult<SwitchHardwareTrendsLive> | null;
  interfaces: DeviceTrendResult<SwitchInterfaceTrendsLive> | null;
  ap: Partial<Record<ApTrendMetric, DeviceTrendResult<ApTrendsLive>>>;
}

export function HardwareTrendsPanel({
  name,
  type,
  identity,
}: {
  /** The device row's display name — the demo read is addressed by it, and it
   *  keys the route alongside the identity pair. */
  name: string;
  type: 'switch' | 'ap';
  /** plane+serial straight off the reconciled row, so a name shared by two
   *  devices can never pull the other's telemetry. */
  identity: DeviceDetailIdentity;
}) {
  const { toast } = useToast();
  const [windowKey, setWindowKey] = useState<TrendWindowKey>('24h');
  const [state, setState] = useState<TrendsState | null>(null);

  /* Navigating device-to-device keeps this screen mounted: the previous
     device's reads are dropped during render, so none of them can commit
     under the new name; the effect below re-reads. */
  const panelKey = `${name} ${type} ${identity.plane ?? ''} ${identity.serial ?? ''} ${windowKey}`;
  const [prevPanelKey, setPrevPanelKey] = useState(panelKey);
  if (prevPanelKey !== panelKey) {
    setPrevPanelKey(panelKey);
    setState(null);
  }

  useEffect(() => {
    let live = true;
    const endMs = Date.now();
    const window = {
      start: new Date(endMs - TREND_WINDOW_MS[windowKey]).toISOString(),
      end: new Date(endMs).toISOString(),
    };
    if (type === 'switch') {
      void Promise.all([
        getDeviceHardwareTrends(name, window, identity),
        getDeviceInterfaceTrends(name, window, identity),
      ]).then(([hardware, interfaces]) => {
        if (live) setState({ hardware, interfaces, ap: {} });
      });
    } else {
      void Promise.all(
        AP_TREND_METRICS.map(async (metric) => [metric, await getDeviceApTrends(name, metric, window, identity)] as const),
      ).then((entries) => {
        if (live) setState({ hardware: null, interfaces: null, ap: Object.fromEntries(entries) });
      });
    }
    return () => {
      live = false;
    };
    // panelKey folds name+type+identity+windowKey into the one key the effect
    // actually re-reads on; listing them separately says the same thing twice.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panelKey]);

  const windowLabel = TREND_WINDOWS.find((w) => w.value === windowKey)?.label ?? windowKey;
  const plane =
    state?.hardware?.kind === 'ok'
      ? state.hardware.live.source.plane
      : state?.ap.cpu?.kind === 'ok'
        ? state.ap.cpu.live.source.plane
        : null;
  const meta = [plane?.toUpperCase(), windowLabel.toUpperCase()].filter(Boolean).join(' · ');

  const exportableSeries: TrendSeries[] = [];
  if (state) {
    if (type === 'switch') {
      if (state.hardware?.kind === 'ok' && state.hardware.live.trends?.ok) {
        exportableSeries.push(...state.hardware.live.trends.series);
      }
      if (state.interfaces?.kind === 'ok' && state.interfaces.live.trends?.ok) {
        exportableSeries.push(...state.interfaces.live.trends.series);
      }
    } else {
      for (const metric of AP_TREND_METRICS) {
        const r = state.ap[metric];
        if (r?.kind === 'ok' && r.live.trends?.ok) exportableSeries.push(...r.live.trends.series);
      }
    }
  }
  const exportRows = trendSeriesExportRows(exportableSeries);

  const downloadServerCsv = () => {
    void (async () => {
      const endMs = Date.now();
      const baseQs = new URLSearchParams();
      baseQs.set('start', new Date(endMs - TREND_WINDOW_MS[windowKey]).toISOString());
      baseQs.set('end', new Date(endMs).toISOString());
      if (identity.plane) baseQs.set('plane', identity.plane);
      if (identity.serial) baseQs.set('serial', identity.serial);

      const jobs: Array<{ part: string; metric?: string; file: string }> = [];
      if (type === 'switch') {
        if (state?.hardware?.kind === 'ok' && state.hardware.live.trends?.ok) {
          jobs.push({ part: 'hardware', file: `device-trends-${name}-hardware.csv` });
        }
        if (state?.interfaces?.kind === 'ok' && state.interfaces.live.trends?.ok) {
          jobs.push({ part: 'interfaces', file: `device-trends-${name}-interfaces.csv` });
        }
      } else {
        for (const metric of AP_TREND_METRICS) {
          const r = state?.ap[metric];
          if (r?.kind === 'ok' && r.live.trends?.ok) {
            jobs.push({
              part: 'ap',
              metric,
              file: `device-trends-${name}-ap-${metric}.csv`,
            });
          }
        }
      }
      if (jobs.length === 0) {
        toast('No server trends to download', {
          description: 'Wait for a successful on-demand read first.',
          tone: 'warning',
        });
        return;
      }

      let ok = 0;
      let lastError: string | undefined;
      for (const job of jobs) {
        const qs = new URLSearchParams(baseQs);
        qs.set('part', job.part);
        if (job.metric) qs.set('metric', job.metric);
        const res = await downloadApiCsv(
          `/api/devices/${encodeURIComponent(name)}/trends/export?${qs.toString()}`,
          job.file,
        );
        if (res.ok) ok += 1;
        else lastError = res.error;
      }
      if (ok > 0) {
        toast('Server CSV downloaded', {
          description: `${ok} trend file${ok === 1 ? '' : 's'} — metric/t/v only, no secrets.`,
          tone: 'success',
        });
      } else {
        toast('Server CSV failed', {
          description: lastError ?? 'Could not download export',
          tone: 'warning',
        });
      }
    })();
  };

  return (
    <div className="nt-stack nt-gap-2">
      <div className="nt-plane-theater nt-plane-theater--compact" role="note">NightDesk · trend cinema · telemetry owns hue</div>
      <SectionHeader label="Hardware trends" meta={meta || undefined} />
      <div className="nt-row nt-gap-8 nt-self-start nt-pad-4-0">
        <SegmentedControl
          options={TREND_WINDOWS}
          value={windowKey}
          onValueChange={(v) => setWindowKey(v as TrendWindowKey)}
          ariaLabel="Trend window"
        />
        {exportRows.length > 0 ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              const n = exportTableCsv(
                `device-trends-${name}-${windowKey}.csv`,
                ['metric', 't', 'v'],
                exportRows,
              );
              toast(`Exported ${n} trend sample${n === 1 ? '' : 's'}`, {
                description: 'Metric key, timestamp, value only — no secrets.',
                tone: 'success',
              });
            }}
          >
            Export trends
          </Button>
        ) : null}
        {exportRows.length > 0 ? (
          <Button variant="ghost" size="sm" onClick={downloadServerCsv}>
            Download server CSV
          </Button>
        ) : null}
      </div>
      {state === null ? (
        <LiveGapNote>
          Reading {type === 'switch' ? 'hardware' : 'AP'} trends — fetched on demand for this device, never on
          the poll.
        </LiveGapNote>
      ) : type === 'switch' ? (
        <SwitchTrends hardware={state.hardware!} interfaces={state.interfaces!} />
      ) : (
        <ApTrends reads={state.ap} />
      )}
    </div>
  );
}
