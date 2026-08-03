/**
 * shared/metricsHistory.ts — metrics-history contracts + demo synthesis.
 *
 * The portal keeps a short, bounded history of the counts the poller cache
 * genuinely offers — per plane: devices reported (and how many of them down),
 * client sessions, open alerts; per device: attached client count — so tables
 * can render a Grafana-style table sparkline instead of a bare "now" number.
 *
 * Two provenance modes, and the envelope always says which:
 *
 *   - Live: the server's in-memory ring buffer, sampled from the poller cache
 *     on a fixed cadence (server/src/services/metricsHistory.ts). Memory-only
 *     by design: the repo's JSONL/rotation culture exists for audit trails,
 *     where a dropped record is indistinguishable from "it never happened".
 *     A 24h ring of counts carries no such burden — the envelope's `since`
 *     states the window actually covered, so a restart shortens history
 *     honestly rather than corrupting a record.
 *   - Demo: deterministic series synthesized from the shared fixtures, so the
 *     UI demonstrates fully without credentials. Every value is a pure
 *     function of its sample timestamp — the same bucket always yields the
 *     same number, across calls and across restarts — and `note` names the
 *     synthesis. The bases are the fixture rows themselves, never invented
 *     estate totals.
 */

import { ALERTS, CLIENTS, DEVICES } from './fixtures';

/** One sampled count. `t` is the sample time (ISO); `v` the count then. */
export interface MetricPoint {
  t: string;
  v: number;
}

/** The per-plane series the sampler keeps. An EMPTY array is "no samples",
 *  never a flat zero — a plane that reported no such dataset has no series. */
export interface PlaneMetricsSeries {
  /** Devices the plane reported at each sample. */
  devices: MetricPoint[];
  /** Of those, how many carried state 'down'. */
  devicesDown: MetricPoint[];
  /** Client sessions the plane reported. */
  clients: MetricPoint[];
  /** Open alerts the plane reported. */
  alerts: MetricPoint[];
}

export interface MetricsHistoryEnvelope {
  /** 'demo' ONLY when every series is synthesized (fixtures, no plane polled). */
  dataSource: 'demo' | 'live';
  /** Oldest sample any series carries (ISO). Null = nothing sampled yet —
   *  the UI says "no samples yet", never draws a line. */
  since: string | null;
  /** Cadence the sampler runs at (ms) — for the honest "sampled every 5m". */
  sampleMs: number;
  /** Retention bound of the ring buffer (ms) — for the honest "last 24h". */
  retentionMs: number;
  /** Per-plane series, keyed by the display label the Overview rows and the
   *  device lanes already use ('CENTRAL', 'MIST', …). */
  planes: Record<string, PlaneMetricsSeries>;
  /** Per-device attached-client counts, keyed by device name (DeviceRow.name).
   *  Only devices at least one client attributed itself to appear here. */
  deviceClients: Record<string, MetricPoint[]>;
  /** Present when the whole envelope is synthesized demo data. */
  note?: string;
}

/** Sample cadence: 5 minutes. Env-overridable on the server; the envelope
 *  reports the value in force so the UI never hardcodes it. */
export const METRICS_SAMPLE_MS = 5 * 60 * 1000;

/** Retention: 24h — one capacity-288 ring at the default cadence. */
export const METRICS_RETENTION_MS = 24 * 60 * 60 * 1000;

/** Ring capacity implied by the defaults (288 points = 24h at 5m). */
export const METRICS_RING_CAPACITY = METRICS_RETENTION_MS / METRICS_SAMPLE_MS;

/** The demo envelope's provenance note (mirrors config-backups' wording). */
export const METRICS_DEMO_NOTE = 'synthesized demo history — no plane was sampled';

// ---------------------------------------------------------------------------
// Demo synthesis — deterministic in the sample timestamp
// ---------------------------------------------------------------------------

/** Small stable hash (the config-backup nameHash rule): picks a per-series
 *  phase and per-bucket jitter without Math.random, so the demo estate is
 *  stable across restarts. */
export function stableHash(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i += 1) h = (h * 31 + seed.charCodeAt(i)) % 9973;
  return h;
}

/**
 * One synthesized value: a slow daily wave plus a faster wobble plus a small
 * deterministic per-bucket jitter, clamped at zero and rounded to a count.
 * Pure in `tMs` — given the same timestamp every caller derives the same
 * number, which is what makes the demo series deterministic.
 */
export function demoValue(seed: string, base: number, amplitude: number, tMs: number): number {
  const phase = (stableHash(seed) % 360) * (Math.PI / 180);
  const day = (2 * Math.PI * tMs) / (24 * 60 * 60 * 1000);
  const wave = Math.sin(day + phase) * 0.6 + Math.sin(day * 3.7 + phase * 2) * 0.4;
  const bucket = Math.floor(tMs / METRICS_SAMPLE_MS);
  const jitter = ((stableHash(`${seed}#${bucket}`) % 100) / 100 - 0.5) * 0.4;
  return Math.max(0, Math.round(base + amplitude * (wave + jitter)));
}

/**
 * A full window of synthesized points ending at the last full bucket at or
 * before `endMs`. Deterministic for a given end: two calls an instant apart
 * agree on every overlapping bucket.
 */
export function demoWindow(
  seed: string,
  base: number,
  amplitude: number,
  endMs: number,
  sampleMs: number = METRICS_SAMPLE_MS,
  count: number = METRICS_RING_CAPACITY,
): MetricPoint[] {
  const last = Math.floor(endMs / sampleMs) * sampleMs;
  const points: MetricPoint[] = [];
  for (let i = count - 1; i >= 0; i -= 1) {
    const t = last - i * sampleMs;
    points.push({ t: new Date(t).toISOString(), v: demoValue(seed, base, amplitude, t) });
  }
  return points;
}

/** Per-plane/per-device bases the demo window wobbles around: the fixture
 *  rows' own counts, so a demo sparkline describes the same estate the demo
 *  tables list. Amplitudes scale with the base — device inventories barely
 *  move, client counts swing with the day, alerts swing most. */
export interface DemoMetricsBases {
  planes: Record<string, { devices: number; devicesDown: number; clients: number; alerts: number }>;
  deviceClients: Record<string, number>;
}

export function demoMetricsBases(): DemoMetricsBases {
  const planes: DemoMetricsBases['planes'] = {};
  const entry = (plane: string) => (planes[plane] ??= { devices: 0, devicesDown: 0, clients: 0, alerts: 0 });
  for (const d of DEVICES) {
    entry(d.plane).devices += 1;
    if (d.state === 'down') entry(d.plane).devicesDown += 1;
  }
  for (const c of CLIENTS) entry(c.plane).clients += 1;
  for (const a of ALERTS) entry(a.plane).alerts += 1;
  const deviceClients: Record<string, number> = {};
  for (const c of CLIENTS) {
    if (!c.attach || c.attach === '—') continue;
    deviceClients[c.attach] = (deviceClients[c.attach] ?? 0) + 1;
  }
  return { planes, deviceClients };
}

/** Amplitude per metric kind (the demo synthesis' only tuning knob). */
export function demoAmplitude(kind: 'devices' | 'devicesDown' | 'clients' | 'alerts', base: number): number {
  switch (kind) {
    case 'devices':
      return Math.max(1, Math.round(base * 0.05));
    case 'devicesDown':
      return Math.max(1, Math.round(base * 0.5));
    case 'clients':
      return Math.max(1, Math.round(base * 0.3));
    case 'alerts':
      return Math.max(1, Math.round(base * 0.5));
  }
}

/**
 * The Overview's demo plane rows use the prototypes' long names ('HPE Aruba
 * Central') while every other payload — and this envelope's `planes` map —
 * uses the short display label ('CENTRAL'). This map is the bridge; a name it
 * does not know is assumed to already be a label and passes through.
 */
export const OVERVIEW_PLANE_NAME_TO_LABEL: Record<string, string> = {
  'HPE Aruba Central': 'CENTRAL',
  Mist: 'MIST',
  'Central Classic': 'CLASSIC',
  GreenLake: 'GREENLAKE',
  'AOS-8 master': 'AOS-8',
  'Local switch collector': 'LOCAL',
  ClearPass: 'CLEARPASS',
};

/** The key an Overview plane row's name resolves to in `planes`. */
export function planeMetricsKey(overviewPlaneName: string): string {
  return OVERVIEW_PLANE_NAME_TO_LABEL[overviewPlaneName] ?? overviewPlaneName;
}
