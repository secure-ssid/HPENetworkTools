/**
 * server/src/services/maintenance.ts — the maintenance-window store and scheduler.
 *
 * Windows (shared/maintenanceWindows.ts) persist to
 * data/maintenance-windows.json — the silence store's own pattern: atomic
 * write, 0600, HPE_DATA_DIR override for tests, and expired one-shot windows
 * FLAGGED on read, never deleted (an expired window is the record that
 * suppression was scheduled; the calendar turning over must not erase it).
 * Windows are real user data and apply in BOTH demo and live mode, exactly
 * like silences and raised tickets.
 *
 * The scheduler is the materialization bridge: bounded (one interval, an
 * in-flight lock so a slow tick is never stacked, an unref'd timer that never
 * keeps the process alive — the configBackups discipline), started/stopped
 * with the server lifecycle. At a window's start it creates ONE silence
 * through the existing silence store — reason = the window's reason, until =
 * the span's exact end, windowId stamped for provenance — and the silence's
 * own expiry ends the suppression at the window's end. Idempotency is the
 * window row's `lastMaterialized` stamp: a restart never raises a second
 * silence for the same span, and an operator who deletes the materialized
 * silence (an override for the rest of that occurrence) is not re-silenced
 * by the next tick.
 *
 * Demo mode adds the authored fixture windows (shared DEMO_MAINTENANCE_WINDOWS)
 * as VIRTUAL silences — computed on each read, registered with the silence
 * service only while this scheduler runs, and never written to the operator's
 * store or audit log. The fixture showcase (the flapping 3rd-floor AP benched
 * under "maintenance window") is a rendering of the feature, not rows in
 * anyone's data.
 */

import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  DEMO_MAINTENANCE_WINDOWS,
  windowSpanAt,
  windowToSilenceMatcher,
  type MaintenanceMatchers,
  type MaintenanceSchedule,
  type MaintenanceWindow,
} from '@hpe/shared';
import { settings } from '../config/settings';
import { appendBrokerLog, brokerDataDir } from './writeBroker';
import { logSilenceEvent, registerFixtureSilenceSource, SilenceStore, silenceStore, type WindowSilence } from './silences';

/** What a window create needs from the route — the store stamps the rest. */
export interface MaintenanceWindowInput {
  reason: string;
  matchers: MaintenanceMatchers;
  schedule: MaintenanceSchedule;
  enabled: boolean;
  createdBy: string;
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

export class MaintenanceStore {
  private windows: MaintenanceWindow[] | null = null;

  constructor(private readonly dataDir: string = process.env.HPE_DATA_DIR ?? brokerDataDir()) {}

  private get file(): string {
    return path.join(this.dataDir, 'maintenance-windows.json');
  }

  /** Rows exactly as persisted — the basis for every mutation and write. */
  private stored(): MaintenanceWindow[] {
    if (this.windows !== null) return this.windows.map((w) => ({ ...w }));
    this.windows = [];
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (Array.isArray(parsed)) this.windows = parsed as MaintenanceWindow[];
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error(`maintenance: unreadable store, starting empty: ${(err as Error).message}`);
      }
    }
    return this.stored();
  }

  /** Every window on file, expired one-shots flagged — never dropped. */
  list(now: number = Date.now()): MaintenanceWindow[] {
    return this.stored().map((w) => ({ ...w, expired: windowSpanAt(w, now).state === 'expired' }));
  }

  get(id: string): MaintenanceWindow | null {
    return this.stored().find((w) => w.id === id) ?? null;
  }

  /** Create and persist a window. Validation lives in the route; by the time
   *  this runs the input is well-formed. */
  create(input: MaintenanceWindowInput, now: number = Date.now()): MaintenanceWindow {
    const window: MaintenanceWindow = {
      id: `mw-${new Date(now).getTime().toString(36)}${randomBytes(3).toString('hex')}`,
      reason: input.reason,
      matchers: input.matchers,
      schedule: input.schedule,
      enabled: input.enabled,
      createdBy: input.createdBy,
      createdAt: new Date(now).toISOString(),
    };
    this.save([window, ...this.stored()]);
    return window;
  }

  /** Flip a window on or off. Returns the updated row, or null for an
   *  unknown id — the route turns that into a 404. */
  setEnabled(id: string, enabled: boolean): MaintenanceWindow | null {
    const windows = this.stored();
    const found = windows.find((w) => w.id === id);
    if (!found) return null;
    found.enabled = enabled;
    this.save(windows);
    return { ...found };
  }

  /** The scheduler's idempotency stamp: the span this window last raised a
   *  silence for. Persisted, so a restart cannot double-materialize. */
  markMaterialized(id: string, spanStartIso: string): void {
    const windows = this.stored();
    const found = windows.find((w) => w.id === id);
    if (!found) return;
    found.lastMaterialized = spanStartIso;
    this.save(windows);
  }

  /** Remove a window by id. Returns the removed row, or null for an unknown
   *  id — the route turns that into a 404, and nothing is audit-logged for a
   *  removal that removed nothing. */
  remove(id: string): MaintenanceWindow | null {
    const windows = this.stored();
    const idx = windows.findIndex((w) => w.id === id);
    if (idx === -1) return null;
    const [removed] = windows.splice(idx, 1);
    this.save(windows);
    return removed ?? null;
  }

  private save(windows: MaintenanceWindow[]): void {
    fs.mkdirSync(this.dataDir, { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(windows, null, 2) + '\n', { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, this.file);
    this.windows = windows;
  }
}

export const maintenanceStore = new MaintenanceStore();

// ---------------------------------------------------------------------------
// The scheduler
// ---------------------------------------------------------------------------

export interface MaintenanceServiceOptions {
  store?: MaintenanceStore;
  silences?: SilenceStore;
  dataDir?: string;
  nowMs?: () => number;
  /** Tick cadence; HPE_MAINTENANCE_INTERVAL_MS or 60s. */
  intervalMs?: number;
  demoMode?: () => boolean;
}

export interface MaterializeResult {
  /** True when a previous tick was still running — never stacked. */
  skipped?: boolean;
  /** Silences created this tick. */
  materialized: number;
}

function defaultIntervalMs(): number {
  const raw = Number(process.env.HPE_MAINTENANCE_INTERVAL_MS);
  return Number.isFinite(raw) && raw >= 1_000 ? raw : 60_000;
}

export class MaintenanceService {
  private readonly store: MaintenanceStore;
  private readonly silences: SilenceStore;
  private readonly dataDir: string;
  private readonly nowMs: () => number;
  private readonly intervalMs: number;
  private readonly demoMode: () => boolean;
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;

  constructor(opts: MaintenanceServiceOptions = {}) {
    this.store = opts.store ?? maintenanceStore;
    this.silences = opts.silences ?? silenceStore;
    this.dataDir = opts.dataDir ?? process.env.HPE_DATA_DIR ?? brokerDataDir();
    this.nowMs = opts.nowMs ?? (() => Date.now());
    this.intervalMs = opts.intervalMs ?? defaultIntervalMs();
    this.demoMode = opts.demoMode ?? (() => settings.get().demoMode);
  }

  /**
   * One materialization pass. For every enabled window currently inside a
   * span, create the span's silence — once, via `lastMaterialized` — through
   * the ordinary silence store, pinned to end exactly at the span's end. The
   * create is audit-logged as what it is: a maintenance window acting, not an
   * operator.
   */
  tick(): MaterializeResult {
    if (this.ticking) return { skipped: true, materialized: 0 };
    this.ticking = true;
    try {
      const now = this.nowMs();
      let materialized = 0;
      for (const window of this.store.list(now)) {
        if (!window.enabled || window.expired) continue;
        const at = windowSpanAt(window, now);
        if (at.state !== 'active') continue;
        const spanStart = new Date(at.span.start).toISOString();
        if (window.lastMaterialized === spanStart) continue;
        const matcher = windowToSilenceMatcher(window);
        // Second line of defence (the route is the first): never raise a
        // silence that names nothing — it would hush the whole queue.
        if (!matcher.plane && !matcher.device && !matcher.titleContains) continue;
        const silence = this.silences.create(
          { ...matcher, reason: window.reason, until: new Date(at.span.end).toISOString(), windowId: window.id },
          now,
        );
        this.store.markMaterialized(window.id, spanStart);
        logSilenceEvent(
          this.dataDir,
          'maintenance-window',
          silence,
          `window ${window.id} · until ${silence.until} — ${window.reason}`,
          now,
        );
        materialized += 1;
      }
      return { materialized };
    } finally {
      this.ticking = false;
    }
  }

  /**
   * The demo fixtures' VIRTUAL silences for `now`: each enabled fixture
   * window inside a span contributes one, pinned to the span's bounds. Demo
   * mode only, and never persisted — see the header.
   */
  fixtureSilences(now: number): WindowSilence[] {
    if (!this.demoMode()) return [];
    const silences: WindowSilence[] = [];
    for (const window of DEMO_MAINTENANCE_WINDOWS) {
      if (!window.enabled) continue;
      const at = windowSpanAt(window, now);
      if (at.state !== 'active') continue;
      const matcher = windowToSilenceMatcher(window);
      if (!matcher.plane && !matcher.device && !matcher.titleContains) continue;
      silences.push({
        id: `mw-sil-${window.id}`,
        ...matcher,
        reason: window.reason,
        createdAt: new Date(at.span.start).toISOString(),
        until: new Date(at.span.end).toISOString(),
        windowId: window.id,
      });
    }
    return silences;
  }

  /** One tick now plus one per interval. The fixture silence source lives
   *  exactly as long as the scheduler — a stopped service showcases nothing.
   *  The timer never keeps the process alive (the poller's own rule). */
  start(): void {
    if (this.timer) return;
    registerFixtureSilenceSource((now) => this.fixtureSilences(now));
    this.timer = setInterval(() => {
      this.tick();
    }, this.intervalMs);
    this.timer.unref();
    this.tick();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    registerFixtureSilenceSource(null);
  }
}

export const maintenance = new MaintenanceService();

/** One audit-log line for a window create/enable/disable/delete — the same
 *  append-only change log every other operator write uses, with ticket '—'
 *  because a window is not a brokered write: nothing leaves the portal. */
export function logMaintenanceEvent(
  dataDir: string,
  window: MaintenanceWindow,
  result: string,
  now: number = Date.now(),
): void {
  appendBrokerLog(dataDir, {
    ts: new Date(now).toISOString(),
    event: 'maintenance-window',
    changeId: window.id,
    ticket: '—',
    kind: 'alert',
    result,
    ...(window.matchers.device ? { device: window.matchers.device } : {}),
    ...(window.matchers.plane ? { plane: window.matchers.plane } : {}),
  });
}
