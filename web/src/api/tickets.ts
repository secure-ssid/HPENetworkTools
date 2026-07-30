/** Ticket raise, note and resolve. */

import {
  type AlertRow,
  type TicketRow,
} from '@hpe/shared';

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Tickets — raising from the alert queue
// ---------------------------------------------------------------------------

/** POST /api/tickets/raise — creates (or finds) the ticket for an alert. */
export async function raiseTicket(alert: AlertRow): Promise<{ ticket: TicketRow } | { error: string; offline?: boolean }> {
  try {
    const r = await fetch('/api/tickets/raise', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(alert),
    });
    const body = (await r.json().catch(() => ({}))) as { ticket?: TicketRow; error?: string };
    if (r.ok && body.ticket) return { ticket: body.ticket };
    return { error: body.error ?? `HTTP ${r.status}` };
  } catch {
    return { error: 'backend unreachable', offline: true };
  }
}

/** POST /api/tickets/:id/notes — persist an operator note or requested action. */
export async function addTicketNote(
  id: string,
  text: string,
  kind: 'note' | 'action' = 'note',
): Promise<{ ticket: TicketRow } | { error: string; offline?: boolean }> {
  try {
    const r = await fetch(`/api/tickets/${encodeURIComponent(id)}/notes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, kind }),
    });
    const body = (await r.json().catch(() => ({}))) as { ticket?: TicketRow; error?: string };
    if (r.ok && body.ticket) return { ticket: body.ticket };
    return { error: body.error ?? `HTTP ${r.status}` };
  } catch {
    return { error: 'backend unreachable', offline: true };
  }
}

/** POST /api/tickets/:id/resolve — close the ticket (idempotent on the server). */
export async function resolveTicket(id: string): Promise<{ ticket: TicketRow } | { error: string; offline?: boolean }> {
  try {
    const r = await fetch(`/api/tickets/${encodeURIComponent(id)}/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    const body = (await r.json().catch(() => ({}))) as { ticket?: TicketRow; error?: string };
    if (r.ok && body.ticket) return { ticket: body.ticket };
    return { error: body.error ?? `HTTP ${r.status}` };
  } catch {
    return { error: 'backend unreachable', offline: true };
  }
}
