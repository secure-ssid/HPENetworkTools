/**
 * Device and client actions that change something, plus diagnostics.
 *
 * Every one of these is a write against a production network. None of them
 * report an async acceptance as a completed change — a queued reboot says
 * queued.
 */

import { apiFetch, serverMessage } from './core';
import { DeviceDetailIdentity } from './screens';
import {
  type DiagnosticHistoryRead,
  type DiagnosticEligibilityResponse,
  type DiagnosticJob,
  type DiagnosticReview,
  type DiagnosticReviewRequest,
  type DiagnosticStartRequest,
  type Plane,
} from '@hpe/shared';

// ---------------------------------------------------------------------------
// Device actions — ticket-gated reboot
// ---------------------------------------------------------------------------

export interface RebootResult {
  ok: boolean;
  applied: boolean; // true ONLY on a 202 from the troubleshooting API
  device: string;
  plane: string;
  serial: string | null;
  ticket: string;
  httpCode?: number;
  message: string;
}

/** POST /api/devices/:name/reboot with exact identity when the resolved row has it. */
export async function rebootDevice(
  name: string,
  ticket: string,
  identity: DeviceDetailIdentity = {},
): Promise<RebootResult | { ok: false; applied: false; message: string }> {
  try {
    const r = await apiFetch(`/api/devices/${encodeURIComponent(name)}/reboot`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ticket,
        ...(identity.plane && identity.serial
          ? { plane: identity.plane, serial: identity.serial }
          : {}),
      }),
    });
    if (r.ok) return (await r.json()) as RebootResult;
    return { ok: false, applied: false, message: await serverMessage(r, `reboot failed — HTTP ${r.status}`) };
  } catch (err) {
    return { ok: false, applied: false, message: `cannot reach the portal backend: ${(err as Error).message}` };
  }
}

// ---------------------------------------------------------------------------
// Reviewed active diagnostics — New Central traceroute only
// ---------------------------------------------------------------------------

export async function getDiagnosticEligibility(): Promise<DiagnosticEligibilityResponse> {
  const r = await apiFetch('/api/diagnostics/eligible');
  if (!r.ok) throw new Error(await serverMessage(r, `diagnostic eligibility failed — HTTP ${r.status}`));
  return (await r.json()) as DiagnosticEligibilityResponse;
}

export async function reviewDiagnostic(request: DiagnosticReviewRequest): Promise<DiagnosticReview> {
  const r = await apiFetch('/api/diagnostics/review', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });
  if (!r.ok) throw new Error(await serverMessage(r, `diagnostic review failed — HTTP ${r.status}`));
  return (await r.json()) as DiagnosticReview;
}

/**
 * Confirming a review requires the exact plane+serial identity the review
 * was issued for (the server rejects a mismatch with 409) — never just the
 * reviewId, so a stale confirmation can't be replayed against a device the
 * operator has since navigated away from.
 */
export async function startDiagnostic(
  reviewId: string,
  plane: Plane,
  serial: string,
): Promise<DiagnosticJob> {
  const body: DiagnosticStartRequest = { reviewId, confirmed: true, plane, serial };
  const r = await apiFetch('/api/diagnostics/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(await serverMessage(r, `diagnostic start failed — HTTP ${r.status}`));
  return (await r.json()) as DiagnosticJob;
}

/**
 * Diagnostic job-status fetch failure that preserves the HTTP status, so
 * pollers can tell an honest terminal answer (401/403 auth, 404 job gone)
 * from a transient failure (network error, 5xx) worth retrying.
 */
export class DiagnosticJobStatusError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'DiagnosticJobStatusError';
    this.status = status;
  }
}

export async function getDiagnosticJob(id: string): Promise<DiagnosticJob> {
  const r = await apiFetch(`/api/diagnostics/jobs/${encodeURIComponent(id)}`);
  if (!r.ok) {
    throw new DiagnosticJobStatusError(
      r.status,
      await serverMessage(r, `diagnostic status failed — HTTP ${r.status}`),
    );
  }
  return (await r.json()) as DiagnosticJob;
}

export async function cancelDiagnostic(id: string): Promise<DiagnosticJob> {
  const r = await apiFetch(`/api/diagnostics/jobs/${encodeURIComponent(id)}/cancel`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  if (!r.ok) throw new Error(await serverMessage(r, `diagnostic cancel failed — HTTP ${r.status}`));
  return (await r.json()) as DiagnosticJob;
}

/**
 * The audit history and the holes in it.
 *
 * `discarded` and `unreadable` are absent on an older server, and absent is
 * not the same claim as "no gaps" — but a client cannot invent a disclosure
 * it was not sent, so they default to empty and the panel says nothing. What
 * it must never do is drop them when they ARE sent, which is why they are
 * read here rather than left on the wire.
 */
export async function getDiagnosticHistory(): Promise<DiagnosticHistoryRead> {
  const r = await apiFetch('/api/diagnostics/history');
  if (!r.ok) throw new Error(await serverMessage(r, `diagnostic history failed — HTTP ${r.status}`));
  const body = (await r.json()) as Partial<DiagnosticHistoryRead>;
  return {
    entries: body.entries ?? [],
    discarded: body.discarded ?? [],
    unreadable: body.unreadable ?? [],
    // A server too old to send these is not evidence of a clean read, but it
    // is the only honest default: claiming a gap we were not told about would
    // put a permanent caveat on every panel.
    malformed: body.malformed ?? 0,
    truncated: body.truncated ?? false,
  };
}

// ---------------------------------------------------------------------------
// Client actions — ticket-gated disconnect (CoA-style reauthentication)
// ---------------------------------------------------------------------------

export interface DisconnectResult {
  ok: boolean;
  applied: boolean; // true ONLY on a 202 from the troubleshooting API
  mac: string;
  ticket: string;
  httpCode?: number;
  message: string;
}

/** POST /api/clients/:mac/disconnect — surfaces the server's message verbatim on failure. */
export async function disconnectClient(
  mac: string,
  ticket: string,
): Promise<DisconnectResult | { ok: false; applied: false; message: string }> {
  try {
    const r = await apiFetch(`/api/clients/${encodeURIComponent(mac)}/disconnect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticket }),
    });
    if (r.ok) return (await r.json()) as DisconnectResult;
    return { ok: false, applied: false, message: await serverMessage(r, `disconnect failed — HTTP ${r.status}`) };
  } catch (err) {
    return { ok: false, applied: false, message: `cannot reach the portal backend: ${(err as Error).message}` };
  }
}

/**
 * POST /api/clients/:mac/block — ticket-gated endpoint block via a ClearPass
 * CoA Disconnect-Request (the wired-client path the Central troubleshooting
 * API cannot reach).
 */
export async function blockClient(
  mac: string,
  ticket: string,
): Promise<DisconnectResult | { ok: false; applied: false; message: string }> {
  try {
    const r = await apiFetch(`/api/clients/${encodeURIComponent(mac)}/block`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticket }),
    });
    if (r.ok) return (await r.json()) as DisconnectResult;
    return { ok: false, applied: false, message: await serverMessage(r, `block failed — HTTP ${r.status}`) };
  } catch (err) {
    return { ok: false, applied: false, message: `cannot reach the portal backend: ${(err as Error).message}` };
  }
}

// ---------------------------------------------------------------------------
// Alert actions — ticket-gated acknowledge through Central's notifications API
// ---------------------------------------------------------------------------

/**
 * What the server's re-read of Central found after the acknowledge.
 *
 * 'unknown' is not a milder 'still-open'. A poll that did not complete tells
 * us nothing about the alert, and the screen must not round that down to
 * either outcome.
 */
export type AckVerification = 'cleared' | 'still-open' | 'unknown';

export interface AckAlertResult {
  ok: boolean;
  applied: boolean; // true ONLY on a 202 from the notifications API
  alert: string;
  ticket: string;
  httpCode?: number;
  message: string;
  /** Absent when nothing was pushed, and absent on a server that predates
   *  the re-read — which is why the screen requires 'cleared' explicitly
   *  rather than treating anything that is not 'still-open' as success. */
  cleared?: AckVerification;
}

/** POST /api/alerts/ack — surfaces the server's message verbatim on failure. */
export async function ackAlert(
  alert: { plane: string; alertId?: string; title?: string; device?: string },
  ticket: string,
): Promise<AckAlertResult | { ok: false; applied: false; message: string }> {
  try {
    const r = await apiFetch('/api/alerts/ack', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticket, alert }),
    });
    if (r.ok) return (await r.json()) as AckAlertResult;
    return { ok: false, applied: false, message: await serverMessage(r, `acknowledge failed — HTTP ${r.status}`) };
  } catch (err) {
    return { ok: false, applied: false, message: `cannot reach the portal backend: ${(err as Error).message}` };
  }
}
