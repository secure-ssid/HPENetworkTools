/**
 * server/src/planes/registry.ts — one adapter per plane, built from settings.
 *
 * The registry owns each plane's mutable PlaneState (single source of truth —
 * adapters hold a reference and report it via state()), plus the operational
 * bookkeeping the Connected-systems screen needs:
 *   - callsToday counter per plane (resets at local midnight — on READ as well
 *     as on write, so a plane that stopped calling never shows yesterday's
 *     total as today's)
 *   - a ring buffer of the last 50 outbound API calls per plane
 *   - a ring buffer of the last 50 notable plane events (credential changes,
 *     poll failures, backoff, recovery) for the drawer's "Recent events"
 *   - failure backoff: a plane that keeps failing is not re-polled at the same
 *     cadence against the quota it is already exceeding
 *
 * 'central', 'greenlake', 'clearpass', 'uxi', 'mist' and 'aos8' with complete
 * credentials get their real adapters (CentralAdapter: gatewayBaseUrl +
 * clientId + clientSecret; GreenLakeAdapter: workspaceId + clientId +
 * clientSecret; ClearPassAdapter: publisher (or host) + clientId +
 * clientSecret, or a legacy pre-minted token; UxiAdapter: clientId +
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
 * present stale data as current"), using the SHARED definition
 * (shared/logic.ts planeStaleness + staleAfterSecFor) so the registry, the
 * poller and every screen expire a plane at the same age and in the same
 * vocabulary. Past staleAfterSec a plane reports 'degraded', which is what
 * makes reconcile mark its devices 'unverified'. `stale` additionally covers a
 * partial pull (some datasets unread), and `reason` names every case —
 * 'aged-out' | 'degraded' | 'partial' | 'never-synced' — so a consumer can
 * render the distinction instead of re-deriving it from lastSync.
 */

import {
  planeStaleness,
  staleAfterSecFor,
  type PlaneStaleReason,
} from '../../../shared';
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
  type PlaneEventEntry,
  type PlaneHealth,
  type PlaneId,
  type PlanePull,
  type PlaneState,
  type PlaneTokenInfo,
} from './types';

const CALL_LOG_LIMIT = 50;
const EVENT_LOG_LIMIT = 50;

/**
 * Failure backoff (README:463 "429s every third poll"). After a failed poll a
 * plane waits pollInterval × 2^(failures−1), capped at 10 minutes, before a
 * SCHEDULED poll is attempted again — an operator-driven syncNow(force)
 * ignores the gate. Without this a throttled plane is re-polled 1,440 times a
 * day against the exact quota it is already exceeding.
 */
const BACKOFF_CAP_SEC = 600;

/**
 * Daily outbound-call budgets, so "Calls today" has the denominator the design
 * shows ('4,105 / 20k'). ONLY vendor limits the docs actually state get a
 * default — Mist's 20k/day (README:462). Every other plane is null ("unknown
 * tier"), which renders bare rather than inventing a quota; an operator who
 * knows their tier stores `callBudget` on the plane's credential record.
 */
const DEFAULT_CALL_BUDGET: Partial<Record<PlaneId, number>> = { mist: 20_000 };

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
  /**
   * The rows this plane is SERVING must not be presented as current: it aged
   * out, its last poll failed, or its last pull was partial (shared/logic.ts
   * planeStaleness). An unlinked plane is never stale — it contributes no
   * rows — and neither is a linked plane that has never synced, for the same
   * reason: there is nothing on screen from it to mispresent, and `reason`
   * still says 'never-synced' for a consumer that renders the distinction
   * (the Sites "Last sync" column prints 'never' from `lastSync`).
   */
  stale: boolean;
  /** Seconds since the last successful sync; null when there has not been one. */
  ageSec: number | null;
  /** WHY it is stale ('aged-out' | 'never-synced' | 'degraded' | 'partial'), or
   *  null when the plane is current. */
  reason: PlaneStaleReason;
}

interface PlaneRuntime {
  adapter: PlaneAdapter;
  state: PlaneState;
  baseHealth: PlaneHealth; // health to restore after a successful sync
  calls: ApiCallLogEntry[];
  events: PlaneEventEntry[];
  callsToday: number;
  day: string; // local YYYY-MM-DD the counter belongs to
}

/**
 * Credential freshness for the fact strip's fourth fact. SECURITY: PlaneState
 * is served unmasked by /api/systems/state — this carries HOW the credential
 * is obtained and (once an adapter stamps it) when it expires, never the
 * secret or any fragment of one.
 */
function tokenFor(creds: PlaneCredentials | null): PlaneTokenInfo | null {
  if (!creds) return null;
  if (creds.clientId && creds.clientSecret) return { expiresAt: null, source: 'oauth client_credentials' };
  if (creds.token) return { expiresAt: null, source: 'static token' };
  if (creds.privateKey) return { expiresAt: null, source: 'ssh private key' };
  if (creds.password) return { expiresAt: null, source: 'ssh password' };
  return null;
}

/** Operator-stored daily call budget, else the documented vendor default. */
function callBudgetFor(id: PlaneId, creds: PlaneCredentials | null): number | null {
  const stored = creds?.callBudget;
  if (stored && /^\d+$/.test(stored.trim())) return Number(stored.trim());
  return DEFAULT_CALL_BUDGET[id] ?? null;
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

  /** Seconds a plane may go without a successful sync before it reads stale —
   *  the shared window, so screens.ts cannot expire a plane at another age. */
  staleAfterSec(): number {
    return staleAfterSecFor(this.store.get().pollIntervalSec);
  }

  recentCalls(id: PlaneId): ApiCallLogEntry[] {
    return [...this.runtime.get(id)!.calls];
  }

  /** Notable plane events, newest first — the drawer's "Recent events" list. */
  recentEvents(id: PlaneId): PlaneEventEntry[] {
    return [...this.runtime.get(id)!.events];
  }

  /**
   * Record one notable plane event (credential change, poll failure, backoff,
   * recovery, brokered write). NEVER pass credential material: the payload is
   * served unmasked by /api/systems/state.
   */
  recordEvent(id: PlaneId, event: { what: string; who: string }): void {
    const rt = this.runtime.get(id);
    if (!rt) return;
    rt.events.unshift({ time: new Date().toISOString(), what: event.what, who: event.who });
    if (rt.events.length > EVENT_LOG_LIMIT) rt.events.length = EVENT_LOG_LIMIT;
  }

  /**
   * Rebuild one plane's adapter from current settings (after credentials are
   * saved or cleared). Call counters and the call log survive the swap.
   */
  reinitPlane(id: PlaneId): PlaneStateView {
    const prev = this.runtime.get(id);
    const calls = prev ? prev.calls : [];
    const events = prev ? prev.events : [];
    const rt = this.buildRuntime(id, calls, events);
    if (prev && prev.day === todayKey()) {
      rt.callsToday = prev.callsToday;
      rt.day = prev.day;
      rt.state.callsToday = rt.callsToday;
    }
    this.runtime.set(id, rt);
    this.recordEvent(id, {
      what: rt.state.linked ? 'credentials saved — adapter rebuilt' : 'credentials cleared — plane unlinked',
      who: 'operator',
    });
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
    this.roll(rt);
    rt.callsToday += 1;
    rt.state.callsToday = rt.callsToday;
  }

  /**
   * Stamp the result of a poll cycle onto the plane's state.
   *
   * `partial` names datasets the pull could not fetch: the sync still
   * happened, but it is not a complete one, so the plane holds at 'warning'
   * rather than being restored to healthy — a dataset that was never read must
   * not read as an authoritative zero behind a green badge.
   *
   * `stamp: false` says the cycle succeeded but carried NO dataset at all: the
   * plane answered, so it is not degraded, but nothing arrived, so `lastSync`
   * must not move — a sync stamp means data arrived (README §State
   * management).
   *
   * A failure starts/extends the backoff window (`nextAttemptAt`) that the
   * poller's scheduled ticks respect.
   */
  markSyncResult(
    id: PlaneId,
    ok: boolean,
    info: { deviceCount?: number | null; note?: string; partial?: readonly string[]; stamp?: boolean } = {},
  ): void {
    const rt = this.runtime.get(id);
    if (!rt) return;
    if (ok) {
      // A stub adapter's empty pull is not a sync: it made no calls and read
      // nothing, so stamping lastSync would claim freshness it cannot have.
      // The 'sync adapter not yet implemented' note stays the only signal.
      if (rt.adapter instanceof StubAdapter) return;
      const wasDegraded = rt.state.health === 'degraded';
      if (info.stamp !== false) rt.state.lastSync = new Date().toISOString();
      if (info.partial !== undefined && info.partial.length > 0) {
        rt.state.health = 'warning';
      } else if (wasDegraded) {
        rt.state.health = rt.baseHealth;
      }
      if (info.deviceCount !== undefined) rt.state.deviceCount = info.deviceCount;
      if (info.note !== undefined) rt.state.note = info.note;
      if (wasDegraded) {
        this.recordEvent(id, { what: `sync recovered after ${rt.state.consecutiveFailures ?? 0} failed polls`, who: 'poller' });
      }
      rt.state.consecutiveFailures = 0;
      rt.state.nextAttemptAt = null;
    } else {
      rt.state.health = 'degraded';
      rt.state.note = info.note ?? 'poll failed — showing last good data';
      const failures = (rt.state.consecutiveFailures ?? 0) + 1;
      rt.state.consecutiveFailures = failures;
      const waitSec = Math.min(
        BACKOFF_CAP_SEC,
        Math.max(1, this.store.get().pollIntervalSec) * Math.pow(2, failures - 1),
      );
      rt.state.nextAttemptAt = new Date(Date.now() + waitSec * 1000).toISOString();
      this.recordEvent(id, { what: `poll failed (${failures} in a row) — backing off ${waitSec}s`, who: 'poller' });
    }
  }

  // -- internals -------------------------------------------------------------

  /** Local-midnight rollover for the daily call counter. Called on every read
   *  as well as on write: a plane that stopped calling (unlinked, backed off,
   *  polling paused) must not keep showing yesterday's total as today's. */
  private roll(rt: PlaneRuntime): void {
    const day = todayKey();
    if (rt.day === day) return;
    rt.day = day;
    rt.callsToday = 0;
    rt.state.callsToday = 0;
  }

  /**
   * The stored state plus clock-derived freshness, from the SHARED definition
   * (planeStaleness). A plane whose last good sync has aged out reads
   * 'degraded' even though nothing threw: the poller skips ticks (previous
   * pull still in flight, scheduled polling paused) and those record no
   * failure, so health alone would stay green while the data silently aged.
   *
   * Only 'aged-out' rewrites `health` — a plane that has simply never synced
   * keeps its honest 'first sync pending' warning, and a partial pull keeps
   * 'warning' rather than being reported as a failure. Both are still `stale`
   * with a reason, which is what a consumer rendering 'unverified' reads. The
   * STORED health is untouched, so the next good poll still restores
   * baseHealth. 'unlinked' is left alone — it has nothing to be stale about.
   */
  private snapshot(rt: PlaneRuntime, nowMs: number): PlaneStateView {
    this.roll(rt);
    const freshness = planeStaleness(
      { linked: rt.state.linked, health: rt.state.health, lastSync: rt.state.lastSync },
      this.staleAfterSec(),
      nowMs,
    );
    return {
      ...rt.state,
      capabilities: rt.adapter.capabilities?.() ?? rt.state.capabilities,
      health: freshness.reason === 'aged-out' ? 'degraded' : rt.state.health,
      // 'never-synced' is reported through `reason`, not through `stale`: the
      // plane is serving no rows, so flagging it stale would only mark other
      // planes' data unverified by association.
      stale: freshness.stale && freshness.reason !== 'never-synced',
      ageSec: freshness.ageSec,
      reason: freshness.reason,
    };
  }

  private buildRuntime(id: PlaneId, calls: ApiCallLogEntry[], events: PlaneEventEntry[] = []): PlaneRuntime {
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
      callBudget: linked ? callBudgetFor(id, creds) : null,
      token: linked ? tokenFor(creds) : null,
      // `scope` is deliberately NOT set here: shared/logic.ts scopeForPlane()
      // is the one definition and both the Systems badge and the capability
      // matrix already read it from the stored credential record.
      consecutiveFailures: 0,
      nextAttemptAt: null,
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
    return { adapter, state, baseHealth, calls, events, callsToday: 0, day: todayKey() };
  }
}

/** Process-wide singleton. */
export const registry = new PlaneRegistry(settings);
