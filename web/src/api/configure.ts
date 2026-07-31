/** Configure screen writes: render, dry-run, queue, push and discard. */

import {
  ApiError,
  ApiResult,
  fetchScreen,
  postForResult,
} from './core';
import {
  type BlastRadiusRow,
  type BrokerAuditEvent,
  type ConfigForm,
  type ConfigKind,
  type SsidApplyResult,
  type SsidCatalog,
} from '@hpe/shared';

/** POST /api/configure/render — pure render, no ticket needed. */
export interface RenderedConfig {
  rendered: string;
  meta: string;
  blastRadius: BlastRadiusRow[];
}

export async function renderConfig(kind: ConfigKind, form: ConfigForm): Promise<ApiResult<RenderedConfig>> {
  return postForResult<RenderedConfig>('/api/configure/render', { kind, form });
}

/** POST /api/configure/dry-run — ticket-gated rehearsal (+ rollback snapshot when linked). */
export interface DryRunResult extends RenderedConfig {
  ok: boolean;
  kind: string;
  ticket: string;
  target: 'central' | 'console';
  reachable: boolean | null; // null = no read-back attempted
  snapshot: boolean; // a rollback snapshot was stored (kept 24h)
  httpCode?: number;
  note: string; // honest one-liner from the broker
}

export async function dryRunConfig(
  kind: ConfigKind,
  form: ConfigForm,
  ticket: string,
): Promise<ApiResult<DryRunResult>> {
  return postForResult<DryRunResult>('/api/configure/dry-run', { kind, form, ticket });
}

/** A queued change as the broker persists it (server BrokeredChange). */
export interface BrokeredChange {
  id: string;
  object: { kind: ConfigKind; form: ConfigForm };
  what: string;
  ticket: string;
  state: 'ready' | 'applying' | 'needs window' | 'console';
  where: string;
  rendered: string;
  createdAt: string; // ISO
  expiresAt: string | null; // 15-min lease on ready changes
}

export async function queueChange(
  kind: ConfigKind,
  form: ConfigForm,
  ticket: string,
): Promise<ApiResult<BrokeredChange>> {
  return postForResult<BrokeredChange>('/api/configure/queue', { kind, form, ticket });
}

/** GET /api/configure/queue — null only when no backend answers. */
export async function getChangeQueue(): Promise<BrokeredChange[] | ApiError | null> {
  const result = await fetchScreen<{ changes: BrokeredChange[] }>('/api/configure/queue');
  if (result.kind === 'ok') {
    // A 200 carrying the wrong body is an API failure, not an empty queue:
    // handing `undefined` to the screen would silently read as "nothing is
    // pending" and let the operator push against a queue nobody can see.
    if (!Array.isArray(result.data?.changes)) {
      return { error: 'The portal API returned an unexpected change-queue payload.' };
    }
    return result.data.changes;
  }
  if (result.kind === 'http-error') return { error: result.message };
  return null;
}

/**
 * GET /api/configure/history — the broker's own audit log, newest first.
 *
 * Same rule as getChangeQueue(): null ONLY when no backend answered (there is
 * no fixture audit log — an authored one would be a fabricated record of
 * changes this install never brokered), and an HTTP error surfaces as {error}
 * rather than turning into an empty list that reads as "nothing ever happened".
 *
 * SECURITY: BrokerAuditEvent is {ts,event,changeId,ticket,kind,result} —
 * shared/types.ts pins that rendered configuration bodies are NOT part of the
 * row. Nothing here may widen it.
 */
export interface ChangeHistory {
  events: BrokerAuditEvent[];
  /** Rotated log generations the server could not read. Non-empty means the
   *  list above is missing a stretch of history that does exist on disk. */
  unreadable: string[];
}

export async function getChangeHistory(limit = 50): Promise<ChangeHistory | ApiError | null> {
  const result = await fetchScreen<{ events: BrokerAuditEvent[]; unreadable?: unknown }>(
    `/api/configure/history?limit=${encodeURIComponent(String(limit))}`,
  );
  if (result.kind === 'ok') {
    // Same rule as an HTTP error: a wrong-shaped 200 must not collapse into an
    // empty drawer that reads as "nothing has ever been brokered here".
    if (!Array.isArray(result.data?.events)) {
      return { error: 'The portal API returned an unexpected change-history payload.' };
    }
    // A server too old to report this cannot be assumed complete, but it also
    // cannot be assumed broken. Absent means "not stated", which renders the
    // same as the good case — the claim only travels when the server makes it.
    const unreadable = Array.isArray(result.data.unreadable)
      ? result.data.unreadable.filter((g): g is string => typeof g === 'string')
      : [];
    return { events: result.data.events, unreadable };
  }
  if (result.kind === 'http-error') return { error: result.message };
  return null;
}

/**
 * Push outcome.
 *
 * `applied` means the plane confirmed the change is in effect — not merely
 * that the call returned 2xx. A 202 arrives as `accepted`, which is neither
 * success nor failure: the plane has the request and has not acted on it yet,
 * so there is nothing to retry and nothing to celebrate.
 */
export interface PushResult {
  ok: boolean;
  applied: boolean;
  accepted?: boolean;
  changeId: string;
  ticket: string;
  kind: string;
  httpCode?: number;
  snapshot: boolean;
  message: string;
}

export async function pushChange(changeId: string): Promise<ApiResult<PushResult>> {
  return postForResult<PushResult>('/api/configure/push', { changeId });
}

export async function discardChange(changeId: string): Promise<ApiResult<{ ok: boolean; changeId: string }>> {
  return postForResult<{ ok: boolean; changeId: string }>('/api/configure/discard', { changeId });
}

// ---------------------------------------------------------------------------
// SSID direct write — /api/configure/ssids/* (catalog + reviewed apply)
//
// SSIDs do NOT go through the ticketed queue/dry-run/push above: the editor
// loads a live catalog when its drawer opens, then applies a reviewed change
// directly (no ticket — an explicit reviewConfirmed:true stands in for one).
// ---------------------------------------------------------------------------

/**
 * GET /api/configure/ssids/catalog — never 4xx on its own; an unlinked or
 * Classic-only Central answers 200 with every section named in
 * `unavailable` so the drawer can disable what it cannot offer instead of
 * guessing. `null` means the backend itself did not answer at all.
 */
export async function getSsidCatalog(): Promise<SsidCatalog | ApiError | null> {
  const result = await fetchScreen<SsidCatalog>('/api/configure/ssids/catalog');
  if (result.kind === 'ok') return result.data;
  if (result.kind === 'http-error') return { error: result.message };
  return null;
}

/**
 * POST /api/configure/ssids/apply — a reviewed direct SSID change.
 * `reviewConfirmed` must be `true`; the server logs one audit line per
 * attempt (success, partial, or failure) with no ticket and no payload body.
 */
export async function applySsidDirect(form: ConfigForm, reviewConfirmed: boolean): Promise<ApiResult<SsidApplyResult>> {
  return postForResult<SsidApplyResult>('/api/configure/ssids/apply', { form, reviewConfirmed });
}
