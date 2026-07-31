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
 *
 * A tick only reports what actually happened:
 *   - a plane still on the StubAdapter is skipped outright (no call record, no
 *     sync stamp, no history row — three fabricated successes a cycle would
 *     otherwise evict real plane events from the 100-entry log)
 *   - a pull that carried no dataset updates health but NOT lastSync
 *   - datasets the pull could not read travel through as `partial`, so the
 *     registry holds the plane at 'warning' and freshness is not attributed to
 *     a dataset that was never fetched
 *   - a failed plane is not re-polled until the registry's backoff window
 *     expires; syncNow(force) ignores the window
 *   - a pull that does not return within HPE_POLL_TIMEOUT_MS is abandoned and
 *     reported as a plane failure. It is not cancelled (adapters own their own
 *     requests), so the plane's in-flight lock is held until it really settles
 */

import { PLANE_DATASET_KEYS, PLANE_ROW_DATASET_KEYS, type PlaneRowDatasetKey } from '@hpe/shared';
import { settings, type SettingsStore } from '../config/settings';
import { registry, StubAdapter, type PlaneRegistry } from '../planes/registry';
import { PLANE_IDS, type PlaneId, type PlanePull } from '../planes/types';

/** The row-array datasets this cache merges. NOT `keyof PlanePull`: a pull
 *  also carries the `config` object, the `assignments` feed and the `partial`
 *  metadata list, none of which are row arrays to concatenate. */
export type DatasetKey = PlaneRowDatasetKey;

const DATASET_KEYS: DatasetKey[] = [...PLANE_ROW_DATASET_KEYS];

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
  /** Why each skipped plane was skipped — see SyncSkipReason. Without this a
   *  caller can only count skips, and every summary that tried to describe
   *  them had to guess which kind they were. */
  skippedReason: Partial<Record<PlaneId, SyncSkipReason>>;
}

const SYNC_LOG_LIMIT = 100;

/**
 * How long a single plane's pull may run before the poller stops waiting.
 *
 * Every adapter already sets AbortSignal.timeout on its own HTTP calls, so
 * this is not about a hung socket — it is about a pull that makes many bounded
 * calls (paged inventories, per-kind SSE reads) and adds up to something
 * unbounded, or that retries inside its own loop. Two minutes is well beyond
 * any healthy cycle and well inside the point where an operator would rather
 * be told the plane is stuck.
 */
const DEFAULT_POLL_TIMEOUT_MS = 120_000;

function pollTimeoutMs(): number {
  const raw = Number(process.env.HPE_POLL_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_POLL_TIMEOUT_MS;
}

/** Distinguishable from a vendor error so the log line can say what happened. */
class PollTimeoutError extends Error {
  constructor(ms: number) {
    super(`no response after ${Math.round(ms / 1000)}s`);
    this.name = 'PollTimeoutError';
  }
}

/**
 * Stop waiting after `ms`.
 *
 * This cannot cancel the pull — adapters own their own requests — so it does
 * not pretend to. The caller keeps the plane's in-flight lock until the real
 * promise settles, so an abandoned pull never runs alongside its successor.
 */
function withPollTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new PollTimeoutError(ms)), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err as Error);
      },
    );
  });
}
export type TickResult = 'ok' | 'error' | 'skipped';

/**
 * Why a tick did nothing.
 *
 * 'skipped' on its own is five different facts wearing one word, and only the
 * first of them is work in progress. A plane still on the StubAdapter is
 * skipped on every cycle forever — it has credentials and no implementation to
 * spend them on — and reporting that as "already syncing" tells the operator
 * to wait for a result that is never coming.
 */
export type SyncSkipReason =
  /** A previous tick for this plane has not settled yet. Genuinely in flight. */
  | 'in-flight'
  /** Scheduled polling is off (demo mode with nothing set to live). */
  | 'polling-off'
  /** The adapter reports no credentials. */
  | 'unlinked'
  /** Linked, but still on the StubAdapter: no call was made and none will be. */
  | 'no-adapter'
  /** The plane's failure backoff window has not expired (scheduled polls only). */
  | 'backoff'
  /** Credentials were re-saved mid-pull, so the answer was discarded. */
  | 'superseded';

/** A tick's outcome, plus the reason when it did nothing. */
interface TickOutcome {
  result: TickResult;
  reason?: SyncSkipReason;
}

const skip = (reason: SyncSkipReason): TickOutcome => ({ result: 'skipped', reason });

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

  /**
   * Most recent successful sync from a plane that contributes a dataset.
   *
   * A dataset the pull did not carry lends nothing. Neither does one it
   * carried EMPTY while naming it in `partial` — that is a denied or 404 read
   * published as a zero, and a zero the plane never saw must not arrive
   * wearing a fresh stamp.
   *
   * A `partial` dataset that did deliver rows is the opposite fact, and the
   * distinction is the whole of this method. The walk stopped short; what it
   * returned was still read on this pull. ClearPass caps the auth log at
   * MAX_AUTH_EVENTS and so declares `authEvents` partial on any estate busier
   * than that — every tick, forever — and UXI does the same for a truncated
   * inventory. Refusing them a stamp left the Auth-events header reading
   * 'SYNCED —', which that screen's own contract defines as 'no successful
   * poll yet', above two hundred events read seconds earlier. Those rows are
   * short, not stale, and `partial` plus the plane's warning health already
   * say short in the places built to say it.
   *
   * Row count is a safe test here only because DatasetKey is
   * PlaneRowDatasetKey: every key this takes names an array. The structured
   * datasets (`config`, `sse`, `greenlake`) are not addressable through it.
   */
  lastSyncFor(...keys: DatasetKey[]): string | null {
    const freshness = this.freshness();
    let latest: string | null = null;
    for (const [plane, pull] of this.contributions) {
      const unread = pull.partial ?? [];
      const contributes = keys.some((key) => {
        const rows = pull[key];
        if (rows === undefined) return false;
        return unread.includes(key) ? rows.length > 0 : true;
      });
      if (!contributes) continue;
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
    const skippedReason: Partial<Record<PlaneId, SyncSkipReason>> = {};
    for (const [id, outcome] of results) {
      if (outcome.result === 'skipped' && outcome.reason) skippedReason[id] = outcome.reason;
    }
    return {
      requested,
      synced: results.filter(([, o]) => o.result === 'ok').map(([id]) => id),
      failed: results.filter(([, o]) => o.result === 'error').map(([id]) => id),
      skipped: results.filter(([, o]) => o.result === 'skipped').map(([id]) => id),
      skippedReason,
    };
  }

  /**
   * Immediately poll ONE plane, ignoring the backoff window (like syncNow's
   * force flag). Used by the SSE mutation routes to refresh the cached
   * inventory right after a commit — the object change must be visible
   * immediately, not after the next 60s poll tick.
   */
  async syncNowFor(id: PlaneId): Promise<TickResult> {
    return (await this.tick(id, true)).result;
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

  private async tick(id: PlaneId, force = false): Promise<TickOutcome> {
    // A slow pull (minutes) against a short interval must not stack up —
    // skip this tick if the plane's previous one hasn't settled yet.
    if (this.inFlight.has(id)) return skip('in-flight');
    this.inFlight.add(id);
    let pending: Promise<PlanePull> | null = null;
    try {
      if (!force && !this.scheduledPollingEnabled()) return skip('polling-off');
      const adapter = this.reg.get(id);
      const state = adapter.state();
      if (!state.linked) return skip('unlinked');
      // A stub plane has no sync implementation: pull() makes no call and
      // reads nothing. Recording it as a cycle would fabricate a success —
      // the registry already refuses the stamp and the call entry, and the
      // history row would be just as untrue.
      if (adapter instanceof StubAdapter) return skip('no-adapter');
      // Failure backoff: a plane that just failed (429, dead token) waits out
      // the registry's window before a SCHEDULED poll retries. An operator's
      // syncNow(force) always gets to try.
      if (!force && state.nextAttemptAt) {
        const due = Date.parse(state.nextAttemptAt);
        if (Number.isFinite(due) && Date.now() < due) return skip('backoff');
      }
      const generation = this.generations.get(id) ?? 0;
      const timeoutMs = pollTimeoutMs();
      // No synthetic 'poll()' entry in the vendor call log: every adapter
      // records its own requests with the real path, latency and status (the
      // 429s the Activity list exists to evidence), so a cycle marker would
      // only over-count 'Calls today' and evict real traffic from the 50-deep
      // buffer. The cycle itself is recorded in the sync history below.
      // Held past the timeout when a pull is abandoned, so the in-flight lock
      // can outlive our willingness to wait for it (see the finally below).
      pending = adapter.pull();
      try {
        const pull = await withPollTimeout(pending, timeoutMs);
        pending = null;
        if ((this.generations.get(id) ?? 0) !== generation) return skip('superseded');
        // A sync stamp means data arrived. A cycle that returned no dataset at
        // all (not even config/assignments/sse) proves the plane answered, not
        // that anything was read, so it must not move `lastSync`.
        const carried = PLANE_DATASET_KEYS.some((k) => pull[k] !== undefined);
        // The cache keeps a plane's last good pull even when it carried ONLY a
        // structured, non-row dataset (config/assignments/sse) — the row-array
        // check alone (DATASET_KEYS) would silently drop an SSE-only pull, and
        // GET /api/sse/inventory would never see anything the adapter read.
        if (carried) {
          this.contributions.set(id, pull);
        }
        const deviceCount = pull.devices ? pull.devices.length : state.deviceCount;
        // SSE carries per-kind failure evidence even when every kind failed.
        // Cache that evidence, but degrade/back off exactly like a thrown pull:
        // a zero-kind inventory is not a successful sync stamp.
        if (id === 'sse' && pull.sse && Object.keys(pull.sse.kinds).length === 0) {
          this.reg.markSyncResult(id, false, { note: 'SSE inventory read failed for every object kind' });
          this.log(id, 'poll failed — SSE inventory read failed for every object kind', 'error');
          return { result: 'error' };
        }
        this.reg.markSyncResult(id, true, {
          deviceCount,
          partial: pull.partial,
          stamp: carried,
          ...(carried ? {} : { note: 'reachable — the pull carried no dataset' }),
        });
        const unread = pull.partial?.length ? ` — not read: ${pull.partial.join(', ')}` : '';
        // Name the sections that actually landed. '0 devices reported' would
        // read as an authoritative zero for a plane that publishes no device
        // inventory at all (GreenLake reports subscriptions, UXI sensors).
        const counts = DATASET_KEYS.filter((k) => pull[k] !== undefined).map((k) => `${k} ${pull[k]!.length}`);
        this.log(
          id,
          carried ? `poll ok — ${counts.length > 0 ? counts.join(', ') : 'no rows'}${unread}` : 'poll ok — no datasets returned',
          'ok',
        );
        return { result: 'ok' };
      } catch (err) {
        const timedOut = err instanceof PollTimeoutError;
        if (!timedOut) pending = null;
        if ((this.generations.get(id) ?? 0) !== generation) return skip('superseded');
        // A timeout is reported as a plane failure, not as silent staleness.
        // Before this, a pull that never returned stranded the plane on data
        // the UI went on presenting as current until the process restarted.
        const note = timedOut
          ? `poll timed out: ${(err as Error).message}`
          : `poll failed: ${(err as Error).message}`;
        this.reg.markSyncResult(id, false, { note });
        // One history row per failure, naming the backoff the registry just
        // applied — the design's own row is 'Poll rejected — HTTP 429, backing
        // off 600s' (shared/fixtures.ts) rather than an identical failure a
        // minute forever.
        const due = state.nextAttemptAt ? Date.parse(state.nextAttemptAt) : NaN;
        const waitSec = Number.isFinite(due) ? Math.max(0, Math.round((due - Date.now()) / 1000)) : null;
        const backoff = waitSec === null ? '' : ` — backing off ${waitSec}s`;
        this.log(
          id,
          `${timedOut ? 'poll timed out' : 'poll failed'} — ${(err as Error).message}${backoff}`,
          'error',
        );
        return { result: 'error' };
      }
    } finally {
      if (pending) {
        // We stopped waiting, but the vendor call has not stopped running.
        // Hold the lock until it settles: releasing now would let the next
        // tick start a second concurrent pull against a plane already
        // struggling, and let a late reply overwrite a fresher one.
        void pending.then(
          () => this.inFlight.delete(id),
          () => this.inFlight.delete(id),
        );
      } else {
        this.inFlight.delete(id);
      }
    }
  }
}

/** Process-wide singleton. */
export const poller = new Poller(registry, settings);
