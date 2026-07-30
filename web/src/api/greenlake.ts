/** GreenLake inventory summary and workspace actions. */

import { serverMessage } from './core';
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
    const r = await fetch('/api/greenlake/inventory');
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
}

/**
 * POST /api/greenlake/actions/:action, review-confirmed.
 *
 * `outcome` is surfaced verbatim so the caller can distinguish a change the
 * workspace performed from one it merely accepted for asynchronous
 * validation — reporting a 202 as done would overstate what happened.
 */
export async function runGreenLakeAction(
  action: GreenLakeWriteAction,
  fields: Record<string, unknown>,
): Promise<GreenLakeActionCallResult> {
  try {
    const r = await fetch(`/api/greenlake/actions/${encodeURIComponent(action)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields, reviewConfirmed: true }),
    });
    if (!r.ok) {
      return { ok: false, message: await serverMessage(r, `${action} failed — HTTP ${r.status}`) };
    }
    const body = (await r.json()) as GreenLakeWriteResult;
    return { ok: true, message: body.detail, outcome: body.outcome };
  } catch (err) {
    return { ok: false, message: `cannot reach the portal backend: ${(err as Error).message}` };
  }
}
