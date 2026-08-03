/**
 * server/src/services/metricsHistory.ts — bounded in-memory metrics history.
 *
 * Samples the poller cache on a fixed cadence (default 5m,
 * HPE_METRICS_SAMPLE_MS) into per-series ring buffers retained for 24h
 * (capacity = retention / interval = 288 points at the default), so the UI
 * can render table sparklines of what the poller genuinely sees: per plane,
 * devices reported (and how many down), client sessions and open alerts;
 * per device, the attached-client count its clients attribute to it.
 *
 * Memory-only, deliberately (see shared/metricsHistory.ts): this is a
 * redundant observability buffer the poller rebuilds within a day, not an
 * audit trail. The envelope's `since` states the window actually covered, so
 * a restart shortens history honestly — "since server start", never a
 * backfilled fiction. The repo's JSONL/rotation culture stays with the logs
 * whose gaps would be indistinguishable from "it never happened".
 *
 * The poller's own disciplines are kept: one interval, unref'd so it never
 * keeps the process alive, an immediate first sample on start(), and an
 * in-flight lock so a slow sample is never stacked by the next tick.
 * Sampling pauses exactly when scheduled polling does (fixture-only demo):
 * there is no cache to read, and the demo envelope is synthesized on read
 * from the shared fixtures instead — deterministic, labelled, never mixed
 * with real samples.
 *
 * Every served envelope also carries an additive `anomalies` block: each
 * series flagged against its own median (robust z-score, shared/anomaly.ts),
 * computed on read so flags and series can never drift apart. The demo
 * envelope gets one synthesized anomaly in each of two plane device series
 * (injectDemoAnomalies) so the markers showcase without credentials —
 * synthesized like the rest of the demo history, and labelled by the same
 * note.
 */

import {
  METRICS_DEMO_NOTE,
  METRICS_RETENTION_MS,
  METRICS_SAMPLE_MS,
  demoAmplitude,
  demoMetricsBases,
  demoWindow,
  metricsAnomalies,
  stableHash,
  type MetricPoint,
  type MetricsEnvelopeWithAnomalies,
  type MetricsHistoryEnvelope,
  type PlaneMetricsSeries,
} from '@hpe/shared';
import { settings } from '../config/settings';
import { normalizeMac } from '../planes/clearpass';
import { PLANE_LABEL } from './reconcile';
import { poller } from './poller';
import type { PlaneId, PlanePull } from '../planes/types';

/** One sampling pass over the cache, before timestamps are attached. */
export interface MetricsSample {
  /** Per plane display label — only datasets the pull actually carried. */
  planes: Record<string, { devices?: number; devicesDown?: number; clients?: number; alerts?: number }>;
  /** Per device name: attached clients, deduped across planes by MAC. */
  deviceClients: Record<string, number>;
}

/**
 * Map one moment's per-plane pulls to counts. Exported pure so tests can
 * drive it with fabricated pulls.
 *
 * A dataset the pull did not carry (undefined) contributes NO point — the
 * series keeps an honest gap rather than a zero the plane never stated. The
 * per-device count dedupes clients across planes on the normalized MAC (two
 * planes reporting the same session must not double an AP's client count);
 * a client whose `attach` names no device is unattributable and counts
 * nowhere — an undercount the UI labels, never an invented attribution.
 */
export function sampleFromPulls(contributions: ReadonlyMap<PlaneId, PlanePull>): MetricsSample {
  const planes: MetricsSample['planes'] = {};
  const deviceClients: Record<string, number> = {};
  const seenMacs = new Set<string>();
  for (const [id, pull] of contributions) {
    const label = PLANE_LABEL[id];
    const entry = (planes[label] ??= {});
    if (pull.devices !== undefined) {
      entry.devices = pull.devices.length;
      entry.devicesDown = pull.devices.filter((d) => d.state === 'down').length;
    }
    if (pull.clients !== undefined) entry.clients = pull.clients.length;
    if (pull.alerts !== undefined) entry.alerts = pull.alerts.length;
    for (const client of pull.clients ?? []) {
      if (!client.mac || client.mac === '—') continue;
      const mac = normalizeMac(client.mac);
      if (seenMacs.has(mac)) continue;
      seenMacs.add(mac);
      const attach = client.attach;
      if (!attach || attach === '—') continue;
      deviceClients[attach] = (deviceClients[attach] ?? 0) + 1;
    }
  }
  return { planes, deviceClients };
}

const PLANE_METRICS = ['devices', 'devicesDown', 'clients', 'alerts'] as const;
type PlaneMetric = (typeof PLANE_METRICS)[number];

/** How far the demo's injected showcase anomalies sit from the fixture base,
 *  in units of the series' own synthesis amplitude: far enough that the
 *  robust z-score flags them at any time of day, proportional enough to read
 *  as a count excursion rather than a rendering bug. */
const DEMO_ANOMALY_AMPLITUDES = 12;

export interface MetricsHistoryServiceOptions {
  /** Sample cadence; HPE_METRICS_SAMPLE_MS or 5m. */
  intervalMs?: number;
  /** Ring retention; the capacity is retention / interval. */
  retentionMs?: number;
  nowMs?: () => number;
  /** When false the service records nothing and envelope() synthesizes the
   *  demo window. Default: the poller's own scheduled-polling rule — demo
   *  mode with nothing set to live means there is no cache to sample. */
  liveSampling?: () => boolean;
  /** The sampler; defaults to the poller cache. Tests inject. */
  sample?: () => MetricsSample;
}

function defaultIntervalMs(): number {
  const raw = Number(process.env.HPE_METRICS_SAMPLE_MS);
  return Number.isFinite(raw) && raw >= 1_000 ? raw : METRICS_SAMPLE_MS;
}

export class MetricsHistoryService {
  private readonly intervalMs: number;
  private readonly retentionMs: number;
  private readonly capacity: number;
  private readonly nowMs: () => number;
  private readonly liveSampling: () => boolean;
  private readonly sample: () => MetricsSample;
  private timer: NodeJS.Timeout | null = null;
  private sampling = false;
  /** series key → ring of points, oldest first. Plane series key
   *  `plane:<label>:<metric>`; per-device key `device:<name>`. */
  private readonly rings = new Map<string, MetricPoint[]>();

  constructor(opts: MetricsHistoryServiceOptions = {}) {
    this.intervalMs = opts.intervalMs ?? defaultIntervalMs();
    this.retentionMs = opts.retentionMs ?? METRICS_RETENTION_MS;
    this.capacity = Math.max(1, Math.ceil(this.retentionMs / this.intervalMs));
    this.nowMs = opts.nowMs ?? (() => Date.now());
    this.liveSampling =
      opts.liveSampling ??
      (() => {
        const s = settings.get();
        return (
          !s.demoMode ||
          s.blendLive === true ||
          Object.values(s.sectionMode ?? {}).some((mode) => mode === 'live')
        );
      });
    this.sample = opts.sample ?? (() => sampleFromPulls(poller.contributionsByPlane()));
  }

  private push(key: string, point: MetricPoint): void {
    const ring = this.rings.get(key) ?? [];
    ring.push(point);
    if (ring.length > this.capacity) ring.splice(0, ring.length - this.capacity);
    this.rings.set(key, ring);
  }

  /**
   * Record one sample now. Returns false when skipped: a previous sample is
   * still in flight (never stacked), or nothing is polling (demo — the
   * synthesized envelope answers instead, so a recorded fixture-shaped
   * "sample" would mix provenance).
   */
  sampleNow(): boolean {
    if (this.sampling) return false;
    if (!this.liveSampling()) return false;
    this.sampling = true;
    try {
      const t = new Date(this.nowMs()).toISOString();
      const sample = this.sample();
      for (const [label, counts] of Object.entries(sample.planes)) {
        for (const metric of PLANE_METRICS) {
          const v = counts[metric];
          if (v !== undefined) this.push(`plane:${label}:${metric}`, { t, v });
        }
      }
      for (const [device, v] of Object.entries(sample.deviceClients)) {
        this.push(`device:${device}`, { t, v });
      }
      return true;
    } finally {
      this.sampling = false;
    }
  }

  /** One immediate sample plus one per interval. The timer never keeps the
   *  process alive (the poller's own rule). */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.sampleNow();
    }, this.intervalMs);
    this.timer.unref();
    this.sampleNow();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  isRunning(): boolean {
    return this.timer !== null;
  }

  /** Points for one ring, oldest first (empty when never sampled). */
  series(key: string): MetricPoint[] {
    return [...(this.rings.get(key) ?? [])];
  }

  /**
   * The envelope /api/metrics serves: the base envelope plus the additive
   * `anomalies` block — every served series flagged against its own median
   * (shared/anomaly.ts), computed on read so a series and its flags can
   * never drift apart. Series shorter than the flagger's minimum and series
   * with nothing unusual simply contribute no entry.
   */
  envelope(): MetricsEnvelopeWithAnomalies {
    const base = this.baseEnvelope();
    return { ...base, anomalies: metricsAnomalies(base) };
  }

  /**
   * The envelope without derived blocks. Synthesized from the fixtures when no
   * plane is polling (demo); otherwise the real ring contents, with `since`
   * stating the window actually covered — null when nothing has landed yet.
   */
  private baseEnvelope(): MetricsHistoryEnvelope {
    if (!this.liveSampling()) return this.demoEnvelope();
    const planes: Record<string, PlaneMetricsSeries> = {};
    const deviceClients: Record<string, MetricPoint[]> = {};
    let since: string | null = null;
    for (const [key, ring] of this.rings) {
      if (ring.length === 0) continue;
      if (since === null || ring[0]!.t < since) since = ring[0]!.t;
      if (key.startsWith('plane:')) {
        const [, label, metric] = key.split(':') as [string, string, PlaneMetric];
        (planes[label] ??= { devices: [], devicesDown: [], clients: [], alerts: [] })[metric] = [...ring];
      } else {
        deviceClients[key.slice('device:'.length)] = [...ring];
      }
    }
    return {
      dataSource: 'live',
      since,
      sampleMs: this.intervalMs,
      retentionMs: this.retentionMs,
      planes,
      deviceClients,
    };
  }

  /**
   * The demo envelope: a full window per fixture-backed series, deterministic
   * in the sample timestamp. Only metrics with a nonzero fixture base get a
   * series — a plane with no fixture clients shows "no series", not a flat
   * invented zero.
   */
  private demoEnvelope(): MetricsHistoryEnvelope {
    const now = this.nowMs();
    const bases = demoMetricsBases();
    const planes: Record<string, PlaneMetricsSeries> = {};
    for (const [label, counts] of Object.entries(bases.planes)) {
      const series: PlaneMetricsSeries = { devices: [], devicesDown: [], clients: [], alerts: [] };
      for (const metric of PLANE_METRICS) {
        const base = counts[metric];
        if (base === 0) continue;
        series[metric] = demoWindow(`${label}:${metric}`, base, demoAmplitude(metric, base), now, this.intervalMs, this.capacity);
      }
      if (PLANE_METRICS.some((m) => series[m].length > 0)) planes[label] = series;
    }
    this.injectDemoAnomalies(planes, bases);
    const deviceClients: Record<string, MetricPoint[]> = {};
    for (const [device, base] of Object.entries(bases.deviceClients)) {
      deviceClients[device] = demoWindow(`device:${device}`, base, demoAmplitude('clients', base), now, this.intervalMs, this.capacity);
    }
    // Every window shares the same start: the oldest bucket demoWindow emits.
    const since =
      Object.keys(planes).length > 0 || Object.keys(deviceClients).length > 0
        ? new Date((Math.floor(now / this.intervalMs) - (this.capacity - 1)) * this.intervalMs).toISOString()
        : null;
    return {
      dataSource: 'demo',
      since,
      sampleMs: this.intervalMs,
      retentionMs: this.retentionMs,
      planes,
      deviceClients,
      note: METRICS_DEMO_NOTE,
    };
  }

  /**
   * The demo showcase: exactly one synthesized anomaly in each of two plane
   * device series — the series the Overview plane rows draw — so the anomaly
   * markers have something to show without credentials. One plane's count
   * spikes high, another's dips low, so both directions render.
   *
   * The injection honours the synthesis' own determinism rule: the anomalous
   * bucket is chosen by residue class (bucket ≡ hash mod window length), so
   * any 24h window contains exactly one, and a timestamp's value never
   * depends on when the envelope was read — history does not rewrite itself.
   * The envelope's `note` already names the whole history synthesized; these
   * two points are part of that synthesis, not a claim about a real estate.
   *
   * Targets derive from the fixture bases (the two largest device
   * inventories), never hardcoded plane names, so a fixture edit moves the
   * showcase rather than breaking it.
   */
  private injectDemoAnomalies(
    planes: Record<string, PlaneMetricsSeries>,
    bases: ReturnType<typeof demoMetricsBases>,
  ): void {
    const targets = Object.entries(bases.planes)
      .filter(([, counts]) => counts.devices > 0)
      .sort((a, b) => b[1].devices - a[1].devices)
      .slice(0, 2);
    const directions = ['high', 'low'] as const;
    targets.forEach(([label, counts], i) => {
      const series = planes[label]?.devices;
      if (!series || series.length === 0) return;
      const base = counts.devices;
      const amplitude = demoAmplitude('devices', base);
      const direction = directions[i]!;
      const residue = stableHash(`demo-anomaly:${label}:devices`) % series.length;
      for (const p of series) {
        const bucket = Math.floor(Date.parse(p.t) / this.intervalMs);
        if (((bucket % series.length) + series.length) % series.length === residue) {
          p.v =
            direction === 'high'
              ? base + DEMO_ANOMALY_AMPLITUDES * (amplitude + 1)
              : Math.max(0, base - DEMO_ANOMALY_AMPLITUDES * (amplitude + 1));
        }
      }
    });
  }
}

/** Process-wide singleton. */
export const metricsHistory = new MetricsHistoryService();
