/** SSE object CRUD, commit retry and manual-reconciliation cleanup. */

import { apiFetch, serverMessage } from './core';
import {
  type SseCommitRetryResult,
  type SseInventory,
  type SseKindReadStatus,
  type SseManualCleanupResult,
  type SseMutationResult,
  type SseObjectKind,
  type SseObjectSummary,
} from '@hpe/shared';

// ---------------------------------------------------------------------------
// HPE Aruba Networking SSE — object inventory + reviewed CRUD, all under
// /api/sse/*. The inventory read is always served from the poller's cache
// (never a live call); mutations require an explicit reviewConfirmed:true
// (the review dialog's job) and are gated server-side on the token's declared
// write scope — a 403 here means "this token is read-only", not a bug.
// ---------------------------------------------------------------------------

/** GET /api/sse/inventory — null when the plane is not linked (409) or the
 *  backend cannot be reached; the caller renders the same "not linked" panel
 *  either way rather than a spinner that never resolves. */
export async function getSseInventory(): Promise<SseInventory | null> {
  try {
    const r = await apiFetch('/api/sse/inventory');
    if (!r.ok) return null;
    return (await r.json()) as SseInventory;
  } catch {
    return null;
  }
}

export interface SseKindListing {
  rows: SseObjectSummary[];
  total: number | null;
  truncated: boolean;
  unavailable: boolean;
  /** Secret-free vendor read outcome supplied by the cached inventory. */
  readStatus?: SseKindReadStatus;
  /** Present when the portal could not complete the list read. */
  readError?: string;
}

export function failedSseReadStatus(status: number): SseKindReadStatus {
  if (status === 401 || status === 403) {
    return {
      state: 'failed',
      reason: 'denied',
      httpCode: status,
      message: `The SSE read was refused (HTTP ${status}); the token's grants or this tenant's entitlement do not cover it.`,
    };
  }
  if (status === 404) {
    return {
      state: 'failed',
      reason: 'unsupported',
      httpCode: 404,
      message: 'This SSE kind is unsupported or limited-release for this tenant (HTTP 404).',
    };
  }
  return {
    state: 'failed',
    reason: 'service-error',
    httpCode: status,
    message:
      status === 429
        ? 'The SSE service rate-limited the read (HTTP 429).'
        : `The SSE service returned an error for the read (HTTP ${status}).`,
  };
}

/** GET /api/sse/objects/:kind — one kind's cached rows, optionally filtered. */
export async function getSseKind(kind: SseObjectKind, q?: string): Promise<SseKindListing> {
  try {
    const qs = q?.trim() ? `?q=${encodeURIComponent(q.trim())}` : '';
    const r = await apiFetch(`/api/sse/objects/${encodeURIComponent(kind)}${qs}`);
    if (!r.ok) {
      return {
        rows: [],
        total: null,
        truncated: false,
        unavailable: true,
        readStatus: failedSseReadStatus(r.status),
        readError: await serverMessage(r, `read failed — HTTP ${r.status}`),
      };
    }
    const body = (await r.json()) as Partial<SseKindListing>;
    if (!Array.isArray(body.rows) || typeof body.unavailable !== 'boolean') {
      return {
        rows: [],
        total: null,
        truncated: false,
        unavailable: true,
        readStatus: {
          state: 'failed',
          reason: 'invalid-response',
          httpCode: r.status,
          message: 'The portal returned a successful but unrecognized SSE list response.',
        },
        readError: 'successful SSE list response was not recognized',
      };
    }
    return body as SseKindListing;
  } catch (err) {
    return {
      rows: [],
      total: null,
      truncated: false,
      unavailable: true,
      readStatus: {
        state: 'failed',
        reason: 'unreachable',
        httpCode: null,
        message: 'The portal backend could not be reached for this SSE read.',
      },
      readError: `cannot reach the portal backend: ${(err as Error).message}`,
    };
  }
}

/** GET /api/sse/objects/:kind/:id — on-demand fresh detail read (edit drawer). */
export async function getSseObject(kind: SseObjectKind, id: string): Promise<{ ok: boolean; object?: Record<string, unknown>; message?: string }> {
  try {
    const r = await apiFetch(`/api/sse/objects/${encodeURIComponent(kind)}/${encodeURIComponent(id)}`);
    if (r.ok) return { ok: true, object: (await r.json()) as Record<string, unknown> };
    return { ok: false, message: await serverMessage(r, `read failed — HTTP ${r.status}`) };
  } catch (err) {
    return { ok: false, message: `cannot reach the portal backend: ${(err as Error).message}` };
  }
}

/** Uniform result for the SSE mutation endpoints (create/update/delete). */
export interface SseMutationCallResult {
  ok: boolean;
  message: string;
  result?: SseMutationResult;
  code?: string;
  /** A previous mutation is staged and must be committed before another write. */
  pendingCommit?: boolean;
}

export interface SseCommitRetryCallResult {
  ok: boolean;
  message: string;
  result?: SseCommitRetryResult;
  code?: string;
}

export interface SseManualCleanupCallResult {
  ok: boolean;
  message: string;
  result?: SseManualCleanupResult;
  code?: string;
}

export interface SseErrorResponse {
  message: string;
  code?: string;
  result?: SseManualCleanupResult;
}

export async function sseErrorResponse(r: Response, fallback: string): Promise<SseErrorResponse> {
  try {
    const body = (await r.json()) as {
      error?: unknown;
      message?: unknown;
      code?: unknown;
      result?: unknown;
    };
    return {
      message:
        typeof body.error === 'string'
          ? body.error
          : typeof body.message === 'string'
            ? body.message
            : fallback,
      ...(typeof body.code === 'string' ? { code: body.code } : {}),
      ...(body.result && typeof body.result === 'object'
        ? { result: body.result as SseManualCleanupResult }
        : {}),
    };
  } catch {
    return { message: fallback };
  }
}

export async function sseMutate(url: string, method: 'POST' | 'PUT' | 'DELETE', body: unknown): Promise<SseMutationCallResult> {
  try {
    const r = await apiFetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (r.ok) {
      const result = (await r.json()) as SseMutationResult;
      /* `outcome: 'unverified'` is the server saying the tenant accepted the
         Commit and then did NOT show the change when it read the object back.
         It is a distinct state the service works hard to establish — see
         sseObjects.refreshCache, which compares the returned id and the
         reviewed fields — and collapsing it into "applied and committed"
         reports an unconfirmed change as a finished one. */
      const message = !result.mutation.ok
        ? result.mutation.message
        : result.staged
          ? `applied, but the commit failed — the change is staged: ${result.commit.message}`
          : result.outcome === 'unverified'
            ? `committed, but the change could not be confirmed on the tenant: ${result.cacheRefresh.message}`
            : 'applied and committed';
      return { ok: result.mutation.ok, message, result };
    }
    const { message, code } = await sseErrorResponse(r, `request failed — HTTP ${r.status}`);
    const pendingCommit = code === 'SSE_PENDING_MUTATION';
    return {
      ok: false,
      message,
      ...(code ? { code } : {}),
      ...(pendingCommit ? { pendingCommit: true } : {}),
    };
  } catch (err) {
    return { ok: false, message: `cannot reach the portal backend: ${(err as Error).message}` };
  }
}

/** POST /api/sse/objects/:kind — create, review-confirmed. */
export async function createSseObject(kind: SseObjectKind, fields: Record<string, unknown>, reviewConfirmed?: boolean): Promise<SseMutationCallResult> {
  return sseMutate(`/api/sse/objects/${encodeURIComponent(kind)}`, 'POST', { fields, ...(reviewConfirmed === undefined ? {} : { reviewConfirmed }) });
}

/** PUT /api/sse/objects/:kind/:id — update, review-confirmed. */
export async function updateSseObject(kind: SseObjectKind, id: string, fields: Record<string, unknown>, reviewConfirmed?: boolean): Promise<SseMutationCallResult> {
  return sseMutate(`/api/sse/objects/${encodeURIComponent(kind)}/${encodeURIComponent(id)}`, 'PUT', { fields, ...(reviewConfirmed === undefined ? {} : { reviewConfirmed }) });
}

/** DELETE /api/sse/objects/:kind/:id — delete, review-confirmed. */
export async function deleteSseObject(kind: SseObjectKind, id: string, reviewConfirmed?: boolean): Promise<SseMutationCallResult> {
  return sseMutate(`/api/sse/objects/${encodeURIComponent(kind)}/${encodeURIComponent(id)}`, 'DELETE', reviewConfirmed === undefined ? {} : { reviewConfirmed });
}

/** POST /api/sse/commit/retry — commit-only retry for a staged change; never
 *  replays the mutation that already landed. The caller must supply the
 *  explicit review action rather than this client silently confirming it. */
export async function retrySseCommit(reviewConfirmed?: boolean): Promise<SseCommitRetryCallResult> {
  if (reviewConfirmed === false) {
    return { ok: false, message: 'review the tenant-wide commit before retrying' };
  }
  try {
    const r = await apiFetch('/api/sse/commit/retry', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(reviewConfirmed === undefined ? {} : { reviewConfirmed }),
    });
    if (r.ok) {
      const result = (await r.json()) as SseCommitRetryResult;
      const recoveryAction = result.recovery?.action;
      const ok =
        recoveryAction === 'cleanup-only' || recoveryAction === 'refresh-and-cleanup'
          ? true
          : recoveryAction === 'manual-reconciliation'
            ? false
            : result.commit.ok;
      return {
        ok,
        message:
          recoveryAction === 'cleanup-only' || recoveryAction === 'refresh-and-cleanup'
            ? result.recovery?.message || result.commit.message
            : result.commit.message,
        result,
      };
    }
    const { message, code } = await sseErrorResponse(r, `retry failed — HTTP ${r.status}`);
    return { ok: false, message, ...(code ? { code } : {}) };
  } catch (err) {
    return { ok: false, message: `cannot reach the portal backend: ${(err as Error).message}` };
  }
}

/** POST /api/sse/recovery/manual-cleanup — removes only an ambiguous journal
 * after separate reviewed-action and manual-reconciliation acknowledgments.
 * The server never calls a mutation or tenant-wide Commit on this path. */
export async function cleanupSseManualReconciliation(
  reviewConfirmed: boolean | undefined,
  manualReconciled: boolean,
): Promise<SseManualCleanupCallResult> {
  if (reviewConfirmed === false) {
    return { ok: false, message: 'review the cleanup-only recovery before continuing' };
  }
  if (manualReconciled !== true) {
    return {
      ok: false,
      message: 'attest that the ambiguous outcome was manually reconciled in the SSE admin console',
    };
  }
  try {
    const r = await apiFetch('/api/sse/recovery/manual-cleanup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...(reviewConfirmed === undefined ? {} : { reviewConfirmed }), manualReconciled: true }),
    });
    if (r.ok) {
      const result = (await r.json()) as SseManualCleanupResult;
      const removed =
        result.recovery?.action === 'manual-cleanup' &&
        result.recovery.status === 'journal-removed';
      return {
        ok: removed,
        message: result.recovery?.message || result.commit.message,
        result,
      };
    }
    const { message, code, result } = await sseErrorResponse(
      r,
      `manual cleanup failed — HTTP ${r.status}`,
    );
    return {
      ok: false,
      message,
      ...(code ? { code } : {}),
      ...(result ? { result } : {}),
    };
  } catch (err) {
    return { ok: false, message: `cannot reach the portal backend: ${(err as Error).message}` };
  }
}
