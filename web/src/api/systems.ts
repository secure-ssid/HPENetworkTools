/** Systems screen: per-plane state, credentials, sync and retirement. */

import {
  DataSource,
  ScreenEnvelope,
  apiFailure,
  apiFetch,
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
  countOf,
} from '@hpe/shared';

/** Request bodies are intentionally broad at the boundary while callers submit ConnectorConfig. */
export type SystemCredentialPayload = Record<string, unknown>;

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
  authenticated?: boolean;
  dataset?: string;
  /** How the first poll with the new credentials went, when one was run. */
  /** Outcome of the first poll the save ran. 'pending' means the save did
   *  not wait long enough to find out — not that nothing is happening. */
  indexed?: 'ok' | 'error' | 'skipped' | 'pending';
}

/** One sentence per kind of skip. Only the first is work in progress; the
 *  rest are planes that were not contacted, and three of them will still not
 *  be contacted on the next attempt. */
const SKIP_WORDING: Record<string, (n: number) => string> = {
  'in-flight': (n) => `${n} already syncing`,
  'no-adapter': (n) => `${n} has no sync adapter yet — nothing was sent`,
  unlinked: (n) => `${n} no longer linked`,
  'polling-off': (n) => `${n} skipped — scheduled polling is off`,
  backoff: (n) => `${n} still in its failure backoff window`,
  superseded: (n) => `${n} discarded — credentials changed mid-sync`,
};

function skipClauses(skipped: string[], reasons: Record<string, string>): string[] {
  const counts = new Map<string, number>();
  for (const plane of skipped) {
    // A skip the server did not explain must not borrow another skip's
    // wording. It gets counted as unexplained, which is what it is.
    const reason = reasons[plane] ?? 'unexplained';
    counts.set(reason, (counts.get(reason) ?? 0) + 1);
  }
  return [...counts].map(([reason, n]) =>
    SKIP_WORDING[reason] ? SKIP_WORDING[reason](n) : `${n} skipped for an unstated reason`,
  );
}

/** Ask the poller to run one immediate cycle for every linked plane. */
export async function syncSystems(): Promise<SystemMutationResult> {
  try {
    const r = await apiFetch('/api/systems/sync', { method: 'POST' });
    if (r.ok) {
      const body = (await r.json().catch(() => ({}))) as {
        ok?: boolean;
        requested?: string[];
        started?: string[];
        synced?: string[];
        failed?: string[];
        skipped?: string[];
        skippedReason?: Record<string, string>;
      };
      const skipped = body.skipped ?? [];
      const failed = body.failed?.length ?? 0;
      // `started` counts attempts and has always included the failures, so it
      // was never the number that synchronized. Older servers do not send
      // `synced`; subtracting is then the only honest reading available.
      const synced = body.synced?.length ?? Math.max(0, (body.started?.length ?? 0) - failed);
      const clauses = [`${countOf(synced, 'linked system')} synchronized`];
      // The failure count used to REPLACE the success count, so a run that
      // refreshed four planes and lost one reported only the loss.
      if (failed > 0) clauses.push(`${failed} failed`);
      clauses.push(...skipClauses(skipped, body.skippedReason ?? {}));
      return { ok: body.ok !== false, message: clauses.join('; ') };
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
    const r = await apiFetch(`/api/systems/${encodeURIComponent(plane)}/test`, {
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
        authenticated?: boolean;
        dataset?: string;
      };
      return {
        ok: true,
        message: body.message,
        ms: body.ms,
        source: body.source,
        authenticated: body.authenticated,
        dataset: body.dataset,
      };
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
    const r = await apiFetch(`/api/systems/${encodeURIComponent(plane)}/credentials`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(creds),
    });
    if (r.ok) {
      /* The save runs the plane's first poll before it answers, so the message
         can report what the plane actually said instead of promising a future.
         Each outcome gets its own sentence because they are four different
         situations, and the generic wording made a plane that will never index
         read the same as one that already had. A body we cannot read leaves
         `indexed` undefined, and the wording drops back to the save alone
         rather than claiming an outcome nobody observed. */
      const indexed = ((await r.json().catch(() => null)) as { indexed?: string } | null)?.indexed;
      if (indexed === 'ok') {
        return { ok: true, message: 'credentials saved and the plane indexed', indexed };
      }
      if (indexed === 'error') {
        return {
          ok: true,
          message: 'credentials saved, but the first poll failed — the plane detail says why',
          indexed: 'error',
        };
      }
      if (indexed === 'skipped') {
        return {
          ok: true,
          message: 'credentials saved — no poll ran, so nothing has been read yet',
          indexed: 'skipped',
        };
      }
      if (indexed === 'pending') {
        // The poll is genuinely running; the save just stopped waiting for it.
        // That is a different thing from success and from failure, and the
        // operator is the one who decides whether to go and look.
        return {
          ok: true,
          message: 'credentials saved — the first poll is still running, so the plane detail is the place to check it',
          indexed: 'pending',
        };
      }
      return { ok: true, message: 'credentials saved' };
    }
    return { ok: false, message: await serverMessage(r, `save failed — HTTP ${r.status}`) };
  } catch (err) {
    return { ok: false, message: `cannot reach the portal backend: ${(err as Error).message}` };
  }
}

/** DELETE /api/systems/:plane — clear creds; the adapter becomes unlinked. */
export async function retireSystem(plane: string): Promise<SystemMutationResult> {
  try {
    const r = await apiFetch(`/api/systems/${encodeURIComponent(plane)}`, { method: 'DELETE' });
    if (r.ok) return { ok: true, message: 'plane retired — credentials cleared, adapter unlinked' };
    return { ok: false, message: await serverMessage(r, `retire failed — HTTP ${r.status}`) };
  } catch (err) {
    return { ok: false, message: `cannot reach the portal backend: ${(err as Error).message}` };
  }
}
