/** GreenLake inventory summary and workspace actions. */

import { apiFetch, serverMessage } from './core';
import {
  type GreenLakeInventory,
  type GreenLakeWriteAction,
  type GreenLakeWriteResult,
} from '@hpe/shared';

// ---------------------------------------------------------------------------
// GreenLake workspace — platform inventory + reviewed writes
// ---------------------------------------------------------------------------

/** The inventory plus the server's view of whether writes are permitted. */
export interface GreenLakeInventoryResponse extends GreenLakeInventory {
  canWrite: boolean;
}

/**
 * GET /api/greenlake/inventory. Returns null when the portal backend cannot
 * be reached or the plane is not linked — the screen renders that as an
 * explicit failure, never as an empty workspace.
 */
export async function getGreenLakeInventory(): Promise<GreenLakeInventoryResponse | null> {
  try {
    const r = await apiFetch('/api/greenlake/inventory');
    if (!r.ok) return null;
    return (await r.json()) as GreenLakeInventoryResponse;
  } catch {
    return null;
  }
}

export interface GreenLakeActionCallResult {
  ok: boolean;
  message: string;
  /** Present on success — 'applied' or 'accepted' (202, validated async). */
  outcome?: GreenLakeWriteResult['outcome'];
  /** Whether the server re-read the workspace after the change. Absent means
   *  an older server that never refreshed, which the screen reports
   *  differently from a refresh that was tried and failed. */
  cacheRefresh?: GreenLakeWriteResult['cacheRefresh'];
  /** The workspace's handle for a change it accepted but has not applied. */
  transactionId?: GreenLakeWriteResult['transactionId'];
  /** The id of the object the change created, when the API returned one. */
  id?: GreenLakeWriteResult['id'];
}

/**
 * POST /api/greenlake/actions/:action, review-confirmed.
 *
 * `outcome` is surfaced verbatim so the caller can distinguish a change the
 * workspace performed from one it merely accepted for asynchronous
 * validation — reporting a 202 as done would overstate what happened.
 *
 * `cacheRefresh` is surfaced for the same reason one step further on: an
 * applied change whose inventory re-read failed leaves the screen showing the
 * state from before it, and the operator has to be told that rather than left
 * to conclude the write did nothing.
 *
 * `transactionId` and `id` complete the same thought. Telling an operator a
 * change is not applied yet, or is applied but not yet visible, only helps if
 * they can go and look. The workspace hands back a handle for exactly those
 * cases and the portal was dropping it here — leaving "check GreenLake" as
 * advice with nothing to check against.
 */
export async function runGreenLakeAction(
  action: GreenLakeWriteAction,
  fields: Record<string, unknown>,
  reviewConfirmed?: boolean,
): Promise<GreenLakeActionCallResult> {
  try {
    const r = await apiFetch(`/api/greenlake/actions/${encodeURIComponent(action)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields, ...(reviewConfirmed === undefined ? {} : { reviewConfirmed }) }),
    });
    if (!r.ok) {
      return { ok: false, message: await serverMessage(r, `${action} failed — HTTP ${r.status}`) };
    }
    const body = (await r.json()) as GreenLakeWriteResult;
    return {
      ok: true,
      message: body.detail,
      outcome: body.outcome,
      cacheRefresh: body.cacheRefresh,
      transactionId: body.transactionId,
      id: body.id,
    };
  } catch (err) {
    return { ok: false, message: `cannot reach the portal backend: ${(err as Error).message}` };
  }
}
