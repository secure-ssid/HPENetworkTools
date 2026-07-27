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
    // Stub stage: no outbound traffic. The poller still records the cycle so
    // freshness stamps behave the way they will with a real adapter.
    return {};
  }
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

  states(): Record<PlaneId, PlaneState> {
    const out = {} as Record<PlaneId, PlaneState>;
    for (const id of PLANE_IDS) out[id] = { ...this.runtime.get(id)!.state };
    return out;
  }

  state(id: PlaneId): PlaneState {
    return { ...this.runtime.get(id)!.state };
  }

  recentCalls(id: PlaneId): ApiCallLogEntry[] {
    return [...this.runtime.get(id)!.calls];
  }

  /**
   * Rebuild one plane's adapter from current settings (after credentials are
   * saved or cleared). Call counters and the call log survive the swap.
   */
  reinitPlane(id: PlaneId): PlaneState {
    const prev = this.runtime.get(id);
    const calls = prev ? prev.calls : [];
    const rt = this.buildRuntime(id, calls);
    if (prev && prev.day === todayKey()) {
      rt.callsToday = prev.callsToday;
      rt.day = prev.day;
      rt.state.callsToday = rt.callsToday;
    }
    this.runtime.set(id, rt);
    return { ...rt.state };
  }

  /** Record an outbound API call (poller pulls, connection tests, …). */
  recordCall(id: PlaneId, call: { path: string; ms: number; code: string }): void {
    const rt = this.runtime.get(id);
    if (!rt) return;
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

  /** Stamp the result of a poll cycle onto the plane's state. */
  markSyncResult(id: PlaneId, ok: boolean, info: { deviceCount?: number | null; note?: string } = {}): void {
    const rt = this.runtime.get(id);
    if (!rt) return;
    if (ok) {
      rt.state.lastSync = new Date().toISOString();
      if (rt.state.health === 'degraded') rt.state.health = rt.baseHealth;
      if (info.deviceCount !== undefined) rt.state.deviceCount = info.deviceCount;
      if (info.note !== undefined) rt.state.note = info.note;
    } else {
      rt.state.health = 'degraded';
      rt.state.note = info.note ?? 'poll failed — showing last good data';
    }
  }

  // -- internals -------------------------------------------------------------

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
