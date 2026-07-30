/** Systems screen: per-plane state, credentials, sync and retirement. */

import {
  DataSource,
  ScreenEnvelope,
  apiFailure,
  fetchScreen,
  serverMessage,
} from './core';
import {
  PERMISSIONS,
  SYNC_HISTORY,
  SYSTEMS,
  type PermissionRow,
  type PlaneScope,
  type SyncHistoryRow,
  type SystemRow,
} from '@hpe/shared';

export type SystemCredentialPayload = Record<string, string | string[]>;

export interface SystemsData extends ScreenEnvelope {
  systems: SystemRow[];
  syncHistory: SyncHistoryRow[];
  permissions: PermissionRow[];
}

export async function getSystems(): Promise<SystemsData> {
  const result = await fetchScreen<SystemsData>('/api/systems');
  if (result.kind === 'ok') return result.data;
  if (result.kind === 'http-error') {
    return apiFailure<SystemsData>(result.message, { systems: [], syncHistory: [], permissions: [] });
  }
  return { systems: SYSTEMS, syncHistory: SYNC_HISTORY, permissions: PERMISSIONS, dataSource: 'demo' };
}

// ---------------------------------------------------------------------------
// Systems live state + mutations — /api/systems/*
//
// getSystemsState() reads the server's plane registry (linked/health/lastSync/
// callsToday/recentCalls) plus the poller's sync history; it returns null when
// the backend is unreachable so the Systems screen can say "backend offline"
// and render fixture state instead. The mutation helpers never fall back —
// they surface the server's own message ({error} or {ok:false,message}).
// ---------------------------------------------------------------------------

/** One recorded outbound API call (server ring buffer entry). */
export interface LiveApiCall {
  time: string; // ISO
  path: string;
  ms: number;
  code: string;
}

/** Credential freshness for the fact strip — expiry + source, never a secret. */
export interface LivePlaneToken {
  expiresAt: string | null; // null = the plane publishes no expiry (static key)
  source: string; // 'oauth client_credentials', 'static token', 'sso' …
}

/** What the portal can do with a plane (server PlaneCapabilities). */
export interface LivePlaneCapabilities {
  localShell?: boolean;
  brokeredWrite?: boolean;
  configRead?: boolean;
  /** This plane accepts reviewed direct writes + automatic commit outside any
   *  ticketed queue (New Central's SSID apply, SSE's object CRUD) — false when
   *  the plane cannot, or when a linked SSE token's declared scope excludes
   *  write. The Systems Configuration tab's SSE object browser reads this
   *  directly to enable/disable its own mutation controls. */
  directWrite?: boolean;
}

/**
 * Per-plane registry state (server PlaneStateView) + its recent call log.
 *
 * Everything below `note` is optional because the registry fills it in as the
 * adapters learn it — but it IS on the wire (registry.snapshot() spreads the
 * whole PlaneState and stamps `stale`/`ageSec`), so the client must not strip
 * it: staleness is part of the UI, and a screen that cannot see `stale` has to
 * re-derive it from `lastSync` with its own idea of the window.
 */
export interface LivePlaneState {
  id: string;
  linked: boolean;
  health: 'healthy' | 'degraded' | 'warning' | 'unlinked';
  lastSync: string | null; // ISO of the last successful pull
  deviceCount: number | null;
  callsToday: number;
  note: string | null;
  recentCalls: LiveApiCall[];
  /** The last successful sync has aged past the registry's staleness window. */
  stale?: boolean;
  /** Seconds since that sync; null when the plane has never synced. */
  ageSec?: number | null;
  /** Daily outbound-call budget — the "Calls today" denominator. null = the
   *  vendor tier is unknown, so the fact renders bare rather than inventing one. */
  callBudget?: number | null;
  token?: LivePlaneToken | null;
  /** What the operator actually granted, parsed from the stored `scopes`. */
  scope?: PlaneScope;
  scopeNote?: string;
  capabilities?: LivePlaneCapabilities;
  /** Consecutive failed polls + the earliest time a scheduled poll retries. */
  consecutiveFailures?: number;
  nextAttemptAt?: string | null;
}

/** One poller sync-history entry (server SyncEvent). */
export interface LiveSyncEvent {
  time: string; // ISO
  plane: string;
  what: string;
  result: 'ok' | 'error';
}

export interface SystemsState {
  /** Always 'live' from the route — the registry has no fixture mode. */
  dataSource?: DataSource;
  /** Newest successful sync across every plane (ISO); null before the first. */
  syncedAt?: string | null;
  demoMode: boolean;
  planes: Record<string, LivePlaneState>;
  history: LiveSyncEvent[];
  apiError?: string;
}

/** Live per-plane state; null when the backend is absent (fixtures then). */
export async function getSystemsState(): Promise<SystemsState | null> {
  const result = await fetchScreen<SystemsState>('/api/systems/state');
  if (result.kind === 'ok') return result.data;
  if (result.kind === 'http-error') {
    return {
      dataSource: 'live',
      syncedAt: null,
      demoMode: false,
      planes: {},
      history: [],
      apiError: result.message,
    };
  }
  return null;
}

/** Uniform result for the mutation endpoints (test / credentials / retire). */
export interface SystemMutationResult {
  ok: boolean;
  message: string;
  ms?: number;
  source?: 'request' | 'stored';
}

/** Ask the poller to run one immediate cycle for every linked plane. */
export async function syncSystems(): Promise<SystemMutationResult> {
  try {
    const r = await fetch('/api/systems/sync', { method: 'POST' });
    if (r.ok) {
      const body = (await r.json().catch(() => ({}))) as {
        ok?: boolean;
        started?: string[];
        failed?: string[];
        skipped?: string[];
      };
      const started = body.started?.length ?? 0;
      const failed = body.failed?.length ?? 0;
      const skipped = body.skipped?.length ?? 0;
      return {
        ok: body.ok !== false,
        message:
          failed > 0
            ? `${failed} linked system${failed === 1 ? '' : 's'} failed to synchronize`
            : `${started} linked system${started === 1 ? '' : 's'} synchronized${skipped > 0 ? `; ${skipped} already syncing` : ''}`,
      };
    }
    return { ok: false, message: await serverMessage(r, `sync failed — HTTP ${r.status}`) };
  } catch (err) {
    return { ok: false, message: `cannot reach the portal backend: ${(err as Error).message}` };
  }
}

/**
 * POST /api/systems/:plane/test. A failed test is a normal result, not an
 * exception: the server answers 502 with {ok:false,message} (or 4xx {error})
 * and we surface that message verbatim.
 */
export async function testSystem(
  plane: string,
  creds: SystemCredentialPayload,
): Promise<SystemMutationResult> {
  try {
    const r = await fetch(`/api/systems/${encodeURIComponent(plane)}/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(creds),
    });
    if (r.ok) {
      const body = (await r.json()) as {
        ok: boolean;
        message: string;
        ms?: number;
        source?: 'request' | 'stored';
      };
      return { ok: true, message: body.message, ms: body.ms, source: body.source };
    }
    return { ok: false, message: await serverMessage(r, `test failed — HTTP ${r.status}`) };
  } catch (err) {
    return { ok: false, message: `cannot reach the portal backend: ${(err as Error).message}` };
  }
}

/** POST /api/systems/:plane/credentials — store creds and re-init the adapter. */
export async function saveSystemCredentials(
  plane: string,
  creds: SystemCredentialPayload,
): Promise<SystemMutationResult> {
  try {
    const r = await fetch(`/api/systems/${encodeURIComponent(plane)}/credentials`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(creds),
    });
    if (r.ok) return { ok: true, message: 'credentials saved — the plane re-indexes on the next poll' };
    return { ok: false, message: await serverMessage(r, `save failed — HTTP ${r.status}`) };
  } catch (err) {
    return { ok: false, message: `cannot reach the portal backend: ${(err as Error).message}` };
  }
}

/** DELETE /api/systems/:plane — clear creds; the adapter becomes unlinked. */
export async function retireSystem(plane: string): Promise<SystemMutationResult> {
  try {
    const r = await fetch(`/api/systems/${encodeURIComponent(plane)}`, { method: 'DELETE' });
    if (r.ok) return { ok: true, message: 'plane retired — credentials cleared, adapter unlinked' };
    return { ok: false, message: await serverMessage(r, `retire failed — HTTP ${r.status}`) };
  } catch (err) {
    return { ok: false, message: `cannot reach the portal backend: ${(err as Error).message}` };
  }
}
