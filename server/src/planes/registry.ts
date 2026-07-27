/**
 * server/src/planes/registry.ts — one adapter per plane, built from settings.
 *
 * The registry owns each plane's mutable PlaneState (single source of truth —
 * adapters hold a reference and report it via state()), plus the operational
 * bookkeeping the Connected-systems screen needs:
 *   - callsToday counter per plane (resets at local midnight)
 *   - a ring buffer of the last 50 outbound API calls per plane
 *
 * 'central', 'greenlake', 'clearpass', 'uxi', 'mist' and 'aos8' with complete
 * credentials get their real adapters (CentralAdapter: gatewayBaseUrl +
 * clientId + clientSecret; GreenLakeAdapter: workspaceId + clientId +
 * clientSecret; ClearPassAdapter: host + token; UxiAdapter: clientId +
 * clientSecret; MistAdapter: apiHost + orgId + token; Aos8Adapter: master +
 * username/password). Other planes with credentials get a StubAdapter
 * (linked, pull() returns {} — real implementations land later). Planes
 * without credentials get an UnconfiguredAdapter (unlinked, health
 * 'unlinked'). reinitPlane() swaps one plane's adapter after its credentials
 * change.
 *
 * Freshness EXPIRES here. `lastSync` is stamped on a successful pull, but a
 * plane can also go quiet without ever throwing — a tick skipped because the
 * previous pull is still in flight, or scheduled polling paused — so state()
 * derives staleness from the clock on every read (README:469 rule 1: "Never
 * present stale data as current"). Past staleAfterSec a plane reports
 * 'degraded', which is what makes reconcile mark its devices 'unverified'.
 */

import { settings, type PlaneCredentials, type SettingsStore } from '../config/settings';
import { Aos8Adapter } from './aos8';
import { CentralAdapter } from './central';
import { ClearPassAdapter } from './clearpass';
import { GreenLakeAdapter } from './greenlake';
import { MistAdapter } from './mist';
import { UxiAdapter } from './uxi';
import {
  PLANE_IDS,
  type ApiCallLogEntry,
  type PlaneAdapter,
  type PlaneHealth,
  type PlaneId,
  type PlanePull,
  type PlaneState,
} from './types';

const CALL_LOG_LIMIT = 50;

/**
 * Poll intervals a plane may miss before its last sync reads stale. Three
 * gives one missed cycle plus a slow one before the portal stops calling the
 * data current; the floor keeps a very short configured interval (settings
 * allows 5s) from making every plane flap.
 */
const STALE_AFTER_INTERVALS = 3;
const STALE_AFTER_FLOOR_SEC = 90;

abstract class BaseAdapter implements PlaneAdapter {
  constructor(
    public readonly id: PlaneId,
    protected readonly stateRef: PlaneState,
  ) {}

  state(): PlaneState {
    return this.stateRef;
  }

  abstract pull(): Promise<PlanePull>;
}

/** No credentials stored for this plane. */
export class UnconfiguredAdapter extends BaseAdapter {
  async pull(): Promise<PlanePull> {
    return {};
  }
}

/** Credentials exist, but the real sync implementation has not landed yet. */
export class StubAdapter extends BaseAdapter {
  constructor(
    id: PlaneId,
    stateRef: PlaneState,
    readonly credentials: PlaneCredentials,
  ) {
    super(id, stateRef);
  }

  async pull(): Promise<PlanePull> {
    // Stub stage: no outbound traffic, and nothing read. markSyncResult() and
    // recordCall() both refuse to stamp this as a sync — an empty pull from an
    // adapter that never called anything is not evidence of anything.
    return {};
  }
}

/**
 * A plane's state as read out of the registry: the stored PlaneState with
 * clock-derived freshness folded in. Additive — every existing PlaneState
 * consumer keeps working, and callers that care about staleness read `stale`
 * instead of re-deriving it from `lastSync`.
 */
export interface PlaneStateView extends PlaneState {
  /** The last successful sync has aged past staleAfterSec (never synced = false). */
  stale: boolean;
  /** Seconds since the last successful sync; null when there has not been one. */
  ageSec: number | null;
}

interface PlaneRuntime {
  adapter: PlaneAdapter;
  state: PlaneState;
  baseHealth: PlaneHealth; // health to restore after a successful sync
  calls: ApiCallLogEntry[];
  callsToday: number;
  day: string; // local YYYY-MM-DD the counter belongs to
}

function todayKey(): string {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

export class PlaneRegistry {
  private runtime = new Map<PlaneId, PlaneRuntime>();

  constructor(private readonly store: SettingsStore) {
    for (const id of PLANE_IDS) this.runtime.set(id, this.buildRuntime(id, []));
  }

  get(id: PlaneId): PlaneAdapter {
    const rt = this.runtime.get(id);
    if (!rt) throw new Error(`unknown plane '${id}'`);
    return rt.adapter;
  }

  states(): Record<PlaneId, PlaneStateView> {
    const out = {} as Record<PlaneId, PlaneStateView>;
    const nowMs = Date.now();
    for (const id of PLANE_IDS) out[id] = this.snapshot(this.runtime.get(id)!, nowMs);
    return out;
  }

  state(id: PlaneId): PlaneStateView {
    return this.snapshot(this.runtime.get(id)!, Date.now());
  }

  /** Seconds a plane may go without a successful sync before it reads stale. */
  staleAfterSec(): number {
    return Math.max(STALE_AFTER_FLOOR_SEC, STALE_AFTER_INTERVALS * this.store.get().pollIntervalSec);
  }

  recentCalls(id: PlaneId): ApiCallLogEntry[] {
    return [...this.runtime.get(id)!.calls];
  }

  /**
   * Rebuild one plane's adapter from current settings (after credentials are
   * saved or cleared). Call counters and the call log survive the swap.
   */
  reinitPlane(id: PlaneId): PlaneStateView {
    const prev = this.runtime.get(id);
    const calls = prev ? prev.calls : [];
    const rt = this.buildRuntime(id, calls);
    if (prev && prev.day === todayKey()) {
      rt.callsToday = prev.callsToday;
      rt.day = prev.day;
      rt.state.callsToday = rt.callsToday;
    }
    this.runtime.set(id, rt);
    return this.snapshot(rt, Date.now());
  }

  /** Record an outbound API call (poller pulls, connection tests, …). */
  recordCall(id: PlaneId, call: { path: string; ms: number; code: string }): void {
    const rt = this.runtime.get(id);
    if (!rt) return;
    // The poller books one synthetic 'poll()' entry per cycle. For a stub
    // plane nothing went out, so counting it would inflate 'Calls today' and
    // evict real entries from the 50-deep log with fabricated traffic.
    if (call.path === 'poll()' && rt.adapter instanceof StubAdapter) return;
    rt.calls.unshift({ time: new Date().toISOString(), path: call.path, ms: call.ms, code: call.code });
    if (rt.calls.length > CALL_LOG_LIMIT) rt.calls.length = CALL_LOG_LIMIT;
    const day = todayKey();
    if (rt.day !== day) {
      rt.day = day;
      rt.callsToday = 0;
    }
    rt.callsToday += 1;
    rt.state.callsToday = rt.callsToday;
  }

  /**
   * Stamp the result of a poll cycle onto the plane's state. `partial` names
   * datasets the pull could not fetch: the sync still happened, but it is not
   * a complete one, so the plane holds at 'warning' rather than being restored
   * to healthy — a dataset that was never read must not read as an
   * authoritative zero behind a green badge.
   */
  markSyncResult(
    id: PlaneId,
    ok: boolean,
    info: { deviceCount?: number | null; note?: string; partial?: readonly string[] } = {},
  ): void {
    const rt = this.runtime.get(id);
    if (!rt) return;
    if (ok) {
      // A stub adapter's empty pull is not a sync: it made no calls and read
      // nothing, so stamping lastSync would claim freshness it cannot have.
      // The 'sync adapter not yet implemented' note stays the only signal.
      if (rt.adapter instanceof StubAdapter) return;
      rt.state.lastSync = new Date().toISOString();
      if (info.partial !== undefined && info.partial.length > 0) {
        rt.state.health = 'warning';
      } else if (rt.state.health === 'degraded') {
        rt.state.health = rt.baseHealth;
      }
      if (info.deviceCount !== undefined) rt.state.deviceCount = info.deviceCount;
      if (info.note !== undefined) rt.state.note = info.note;
    } else {
      rt.state.health = 'degraded';
      rt.state.note = info.note ?? 'poll failed — showing last good data';
    }
  }

  // -- internals -------------------------------------------------------------

  /**
   * The stored state plus clock-derived freshness. A plane whose last good
   * sync has aged out reads 'degraded' even though nothing threw: the poller
   * skips ticks (previous pull still in flight, scheduled polling paused) and
   * those record no failure, so health alone would stay green while the data
   * silently aged. 'unlinked' is left alone — it has nothing to be stale
   * about — and the STORED health is untouched, so the next good poll still
   * restores baseHealth.
   */
  private snapshot(rt: PlaneRuntime, nowMs: number): PlaneStateView {
    const syncedMs = rt.state.lastSync === null ? NaN : Date.parse(rt.state.lastSync);
    const ageSec = Number.isNaN(syncedMs) ? null : Math.max(0, Math.round((nowMs - syncedMs) / 1000));
    const stale = ageSec !== null && ageSec > this.staleAfterSec();
    return {
      ...rt.state,
      health: stale && rt.state.health !== 'unlinked' ? 'degraded' : rt.state.health,
      stale,
      ageSec,
    };
  }

  private buildRuntime(id: PlaneId, calls: ApiCallLogEntry[]): PlaneRuntime {
    const creds = this.store.get().planes[id];
    const linked = creds !== null && Object.keys(creds).length > 0;
    const state: PlaneState = {
      id,
      linked,
      health: 'unlinked',
      lastSync: null,
      deviceCount: null,
      callsToday: 0,
      note: 'no credentials configured',
    };
    let adapter: PlaneAdapter;
    let baseHealth: PlaneHealth = 'unlinked';
    if (id === 'central' && creds && CentralAdapter.isComplete(creds)) {
      // Real adapter: 'warning' only until the first sync completes (the
      // adapter promotes itself on success); failures degrade as usual.
      baseHealth = 'healthy';
      state.health = 'warning';
      state.note = 'credentials saved — first sync pending';
      adapter = new CentralAdapter(creds, state, (call) => this.recordCall(id, call));
    } else if (id === 'greenlake' && creds && GreenLakeAdapter.isComplete(creds)) {
      // Real adapter — same lifecycle as central above.
      baseHealth = 'healthy';
      state.health = 'warning';
      state.note = 'credentials saved — first sync pending';
      adapter = new GreenLakeAdapter(creds, state, (call) => this.recordCall(id, call));
    } else if (id === 'clearpass' && creds && ClearPassAdapter.isComplete(creds)) {
      // Real adapter — same lifecycle as central above.
      baseHealth = 'healthy';
      state.health = 'warning';
      state.note = 'credentials saved — first sync pending';
      adapter = new ClearPassAdapter(creds, state, (call) => this.recordCall(id, call));
    } else if (id === 'uxi' && creds && UxiAdapter.isComplete(creds)) {
      // Real adapter — same lifecycle as central above.
      baseHealth = 'healthy';
      state.health = 'warning';
      state.note = 'credentials saved — first sync pending';
      adapter = new UxiAdapter(creds, state, (call) => this.recordCall(id, call));
    } else if (id === 'mist' && creds && MistAdapter.isComplete(creds)) {
      // Real adapter — same lifecycle as central above.
      baseHealth = 'healthy';
      state.health = 'warning';
      state.note = 'credentials saved — first sync pending';
      adapter = new MistAdapter(creds, state, (call) => this.recordCall(id, call));
    } else if (id === 'aos8' && creds && Aos8Adapter.isComplete(creds)) {
      // Real adapter — same lifecycle as central above.
      baseHealth = 'healthy';
      state.health = 'warning';
      state.note = 'credentials saved — first sync pending';
      adapter = new Aos8Adapter(creds, state, (call) => this.recordCall(id, call));
    } else if (linked) {
      baseHealth = 'warning';
      state.health = 'warning';
      state.note = 'credentials saved — sync adapter not yet implemented (stub)';
      adapter = new StubAdapter(id, state, creds);
    } else {
      adapter = new UnconfiguredAdapter(id, state);
    }
    return { adapter, state, baseHealth, calls, callsToday: 0, day: todayKey() };
  }
}

/** Process-wide singleton. */
export const registry = new PlaneRegistry(settings);
