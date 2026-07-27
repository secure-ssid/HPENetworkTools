/**
 * server/src/services/poller.ts — per-plane poll loop and in-memory cache.
 *
 * One interval per plane (settings.pollIntervalSec, default 60s) calls
 * adapter.pull() and merges the result into the cache. Each plane's last good
 * pull is kept separately, so a plane that starts failing keeps contributing
 * its previous data while the rest refresh — staleness stays visible per
 * plane via the registry's PlaneState (lastSync / health), never hidden.
 *
 * Scheduled adapter traffic pauses only when the whole portal is fixture-only.
 * Blend mode and per-section live overrides both need the cache to keep
 * filling. Settings are re-read every tick, so source changes take effect
 * without a restart. An explicit syncNow() always attempts linked planes.
 */

import { settings, type SettingsStore } from '../config/settings';
import { registry, type PlaneRegistry } from '../planes/registry';
import { PLANE_IDS, type PlaneId, type PlanePull } from '../planes/types';

export type DatasetKey = keyof PlanePull;

const DATASET_KEYS: DatasetKey[] = ['devices', 'sites', 'clients', 'alerts', 'authEvents', 'subscriptions'];

/** Merged view of every plane's last good pull, per dataset. */
export interface DataCache {
  devices: NonNullable<PlanePull['devices']>;
  sites: NonNullable<PlanePull['sites']>;
  clients: NonNullable<PlanePull['clients']>;
  alerts: NonNullable<PlanePull['alerts']>;
  authEvents: NonNullable<PlanePull['authEvents']>;
  subscriptions: NonNullable<PlanePull['subscriptions']>;
}

export interface SyncEvent {
  time: string; // ISO
  plane: PlaneId;
  what: string;
  result: 'ok' | 'error';
}

export interface SyncNowResult {
  requested: PlaneId[];
  synced: PlaneId[];
  failed: PlaneId[];
  skipped: PlaneId[];
}

const SYNC_LOG_LIMIT = 100;
type TickResult = 'ok' | 'error' | 'skipped';

export class Poller {
  private timers = new Map<PlaneId, NodeJS.Timeout>();
  private contributions = new Map<PlaneId, PlanePull>(); // last good pull per plane
  private syncLog: SyncEvent[] = [];
  private running = false;
  private inFlight = new Set<PlaneId>(); // planes with an unsettled tick
  private generations = new Map<PlaneId, number>(); // invalidates pulls started before a plane re-init

  constructor(
    private readonly reg: PlaneRegistry,
    private readonly store: SettingsStore,
  ) {}

  /** Start (or no-op if already running) one interval per plane. */
  start(): void {
    if (this.running) return;
    this.running = true;
    const intervalMs = Math.max(5, this.store.get().pollIntervalSec) * 1000;
    for (const id of PLANE_IDS) {
      const timer = setInterval(() => {
        void this.tick(id);
      }, intervalMs);
      timer.unref(); // never keep the process alive for polling
      this.timers.set(id, timer);
      void this.tick(id); // immediate first cycle
    }
  }

  stop(): void {
    for (const timer of this.timers.values()) clearInterval(timer);
    this.timers.clear();
    this.running = false;
  }

  isRunning(): boolean {
    return this.running;
  }

  /** Re-read settings (interval change, credentials changed) and restart. */
  restart(): void {
    this.stop();
    this.start();
  }

  /** Merged view of every plane's last good pull. Empty until planes sync. */
  getCache(): DataCache {
    const cache: DataCache = { devices: [], sites: [], clients: [], alerts: [], authEvents: [], subscriptions: [] };
    for (const pull of this.contributions.values()) {
      for (const key of DATASET_KEYS) {
        const rows = pull[key];
        if (rows) (cache[key] as unknown[]).push(...rows);
      }
    }
    return cache;
  }

  /**
   * Per-plane view of the last good pulls. The reconciliation layer needs the
   * plane split that getCache() deliberately flattens away. The map is a
   * copy; the pulls themselves are shared by reference (treat as read-only).
   */
  contributionsByPlane(): ReadonlyMap<PlaneId, PlanePull> {
    return new Map(this.contributions);
  }

  /** Per-plane freshness: plane id → last successful sync (ISO or null). */
  freshness(): Record<PlaneId, string | null> {
    const states = this.reg.states();
    const out = {} as Record<PlaneId, string | null>;
    for (const id of PLANE_IDS) out[id] = states[id].lastSync;
    return out;
  }

  /** Most recent successful sync across all planes, or null if none yet. */
  lastSyncAny(): string | null {
    let latest: string | null = null;
    for (const ts of Object.values(this.freshness())) {
      if (ts && (latest === null || ts > latest)) latest = ts;
    }
    return latest;
  }

  /** Most recent successful sync from a plane that contributes a dataset. */
  lastSyncFor(...keys: DatasetKey[]): string | null {
    const freshness = this.freshness();
    let latest: string | null = null;
    for (const [plane, pull] of this.contributions) {
      if (!keys.some((key) => pull[key] !== undefined)) continue;
      const ts = freshness[plane];
      if (ts && (latest === null || ts > latest)) latest = ts;
    }
    return latest;
  }

  /** Sync history for the Connected-systems screen (newest first). */
  history(): SyncEvent[] {
    return [...this.syncLog];
  }

  /**
   * Immediately poll every currently linked plane. The regular in-flight
   * guard still applies, so this never overlaps an interval or another manual
   * sync for the same plane.
   */
  async syncNow(): Promise<SyncNowResult> {
    const states = this.reg.states();
    const requested = PLANE_IDS.filter((id) => states[id].linked);
    const results = await Promise.all(requested.map(async (id) => [id, await this.tick(id, true)] as const));
    return {
      requested,
      synced: results.filter(([, result]) => result === 'ok').map(([id]) => id),
      failed: results.filter(([, result]) => result === 'error').map(([id]) => id),
      skipped: results.filter(([, result]) => result === 'skipped').map(([id]) => id),
    };
  }

  /**
   * Remove one plane's last-good contribution. Incrementing its generation
   * also prevents an older in-flight pull from repopulating the cache or
   * stamping a newly re-initialised adapter's state.
   */
  clearPlane(id: PlaneId): void {
    this.contributions.delete(id);
    this.generations.set(id, (this.generations.get(id) ?? 0) + 1);
  }

  private log(plane: PlaneId, what: string, result: 'ok' | 'error'): void {
    this.syncLog.unshift({ time: new Date().toISOString(), plane, what, result });
    if (this.syncLog.length > SYNC_LOG_LIMIT) this.syncLog.length = SYNC_LOG_LIMIT;
  }

  private scheduledPollingEnabled(): boolean {
    const s = this.store.get();
    return (
      !s.demoMode ||
      s.blendLive === true ||
      Object.values(s.sectionMode ?? {}).some((mode) => mode === 'live')
    );
  }

  private async tick(id: PlaneId, force = false): Promise<TickResult> {
    // A slow pull (minutes) against a short interval must not stack up —
    // skip this tick if the plane's previous one hasn't settled yet.
    if (this.inFlight.has(id)) return 'skipped';
    this.inFlight.add(id);
    try {
      if (!force && !this.scheduledPollingEnabled()) return 'skipped';
      const adapter = this.reg.get(id);
      if (!adapter.state().linked) return 'skipped';
      const generation = this.generations.get(id) ?? 0;
      const started = Date.now();
      try {
        const pull = await adapter.pull();
        if ((this.generations.get(id) ?? 0) !== generation) return 'skipped';
        const ms = Date.now() - started;
        this.reg.recordCall(id, { path: 'poll()', ms, code: 'ok' });
        if (DATASET_KEYS.some((k) => pull[k] !== undefined)) {
          this.contributions.set(id, pull); // last good data survives later failures
        }
        const deviceCount = pull.devices ? pull.devices.length : adapter.state().deviceCount;
        this.reg.markSyncResult(id, true, { deviceCount });
        this.log(id, `poll ok — ${pull.devices?.length ?? 0} devices reported`, 'ok');
        return 'ok';
      } catch (err) {
        if ((this.generations.get(id) ?? 0) !== generation) return 'skipped';
        const ms = Date.now() - started;
        this.reg.recordCall(id, { path: 'poll()', ms, code: 'error' });
        this.reg.markSyncResult(id, false, { note: `poll failed: ${(err as Error).message}` });
        this.log(id, `poll failed — ${(err as Error).message}`, 'error');
        return 'error';
      }
    } finally {
      this.inFlight.delete(id);
    }
  }
}

/** Process-wide singleton. */
export const poller = new Poller(registry, settings);
