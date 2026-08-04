/**
 * Ticket queue routes: list, CSV export, raise, notes, resolve.
 * Extracted from screens.ts so the god-route can shrink without contract drift.
 *
 * List honesty: optional `?limit=&cursor=` (via listQuery) pages a growing
 * raised+fixture queue without changing the default full-envelope contract.
 * Optional `?q=` narrows id/title/site/owner/reporter/state/planes only —
 * never invents tickets. Optional `?pri=` (P1|P2|P3), `?state=` (exact
 * state or `openish` = not resolved), and `?site=` (exact siteName or siteId,
 * case-insensitive) match the Tickets screen filter row so API consumers and
 * the UI share one slice. Unknown pri/state values 400 rather than silently
 * returning the full queue. Export always ships the full filtered queue (no
 * page slice) so CSV stays complete for operators.
 */

import type { Request, Router } from 'express';
import { MAX_NOTE_CHARS, TICKETS, type AlertRow } from '@hpe/shared';
import { sendCsv } from '../../lib/csv';
import { queryString } from '../../lib/query';
import { ticketStore } from '../../services/tickets';
import { dataSource, envelope } from './context';
import { applyListFilters, applyListPaging, sendCachedJson } from './listQuery';

/** Fields `?q=` may match on the ticket queue (operator-visible only). */
export const TICKET_LIST_FIELDS = [
  'id',
  'title',
  'state',
  'siteName',
  'site',
  'owner',
  'reporter',
  'planes',
  'plane',
  'pri',
  'sev',
] as const;

const TICKET_PRI = new Set(['P1', 'P2', 'P3']);
const TICKET_STATES = new Set(['open', 'in progress', 'waiting', 'resolved', 'openish']);

function ticketsList(): Array<Record<string, unknown>> {
  // Raised tickets are real user data — they lead the queue in both modes.
  // A fixture ticket noted by an operator is promoted into the store, so the
  // fixture copy with that id drops out of the merged queue (no duplicates).
  const raised = ticketStore.list();
  const base = dataSource() === 'demo' ? TICKETS.filter((t) => !raised.some((r) => r.id === t.id)) : [];
  return [...raised, ...base] as unknown as Array<Record<string, unknown>>;
}

/**
 * Honest pri/state/site filters for the ticket queue. Returns `{ error }` when
 * the operator (or deep-link) named a pri/state this route does not understand
 * — better than pretending the filter matched everything. Unknown `site=` is
 * an honest empty match (no 400) so a stale share link does not fail the page.
 */
export function applyTicketQueueFilters(
  req: Request,
  body: Record<string, unknown>,
): { body: Record<string, unknown> } | { error: string } {
  const list = body.tickets;
  if (!Array.isArray(list)) return { body };

  // Loop 116: shared queryString (trim; non-string → '') — same parser as OpenAPI/docs.
  const priRaw = queryString(req, 'pri');
  const stateRaw = queryString(req, 'state');
  const siteRaw = queryString(req, 'site').toLowerCase();

  if (priRaw && !TICKET_PRI.has(priRaw)) {
    return { error: "pri must be 'P1', 'P2', or 'P3'" };
  }
  if (stateRaw && !TICKET_STATES.has(stateRaw)) {
    return {
      error: "state must be 'open', 'in progress', 'waiting', 'resolved', or 'openish'",
    };
  }
  if (!priRaw && !stateRaw && !siteRaw) return { body };

  const filtered = (list as Record<string, unknown>[]).filter((row) => {
    if (priRaw) {
      const p = String(row.pri ?? row.sev ?? '');
      if (p !== priRaw) return false;
    }
    if (stateRaw) {
      const s = String(row.state ?? '');
      if (stateRaw === 'openish') {
        if (s === 'resolved') return false;
      } else if (s !== stateRaw) {
        return false;
      }
    }
    if (siteRaw) {
      const name = String(row.siteName ?? row.site ?? '')
        .trim()
        .toLowerCase();
      const id = String(row.siteId ?? '')
        .trim()
        .toLowerCase();
      if (name !== siteRaw && id !== siteRaw) return false;
    }
    return true;
  });
  return { body: { ...body, tickets: filtered } };
}

function filteredTicketsBody(req: Request): { body: Record<string, unknown> } | { error: string } {
  const base = envelope({ tickets: ticketsList() }) as Record<string, unknown>;
  const textFiltered = applyListFilters(req, base, 'tickets', [...TICKET_LIST_FIELDS]);
  return applyTicketQueueFilters(req, textFiltered);
}

export function registerTicketsRoutes(router: Router): void {
  router.get('/tickets', (req, res) => {
    const filtered = filteredTicketsBody(req);
    if ('error' in filtered) {
      res.status(400).json({ error: filtered.error });
      return;
    }
    const paged = applyListPaging(req, filtered.body, 'tickets');
    if ('error' in paged) {
      res.status(400).json({ error: paged.error });
      return;
    }
    sendCachedJson(req, res, paged.body);
  });

  /**
   * GET /api/tickets/export — CSV of the operator ticket queue.
   * Honour the same q/pri/state/site filters as the list (full filtered set, no
   * page slice). `noteCount` only (no note bodies) — admits a log exists without
   * shipping note text.
   */
  router.get('/tickets/export', (req, res) => {
    const filtered = filteredTicketsBody(req);
    if ('error' in filtered) {
      res.status(400).json({ error: filtered.error });
      return;
    }
    const rows = (filtered.body.tickets as Array<Record<string, unknown>>) ?? [];
    sendCsv(
      res,
      'tickets.csv',
      [
        'id',
        'pri',
        'title',
        'state',
        'site',
        'age',
        'owner',
        'reporter',
        'planes',
        'sla',
        'inc',
        'noteCount',
      ],
      rows.map((t) => [
        t.id,
        t.pri ?? t.sev,
        t.title,
        t.state,
        t.siteName ?? t.site,
        t.age,
        t.owner,
        t.reporter,
        t.planes ?? t.plane,
        t.sla,
        t.inc,
        Array.isArray(t.notes) ? t.notes.length : 0,
      ]),
    );
  });

  /**
   * Raise a ticket from an alert row {alert: AlertRow} — idempotent per
   * title+device.
   *
   * `detail` and `device` are OPTIONAL: real plane payloads legitimately leave
   * them blank (a WAN/tenant/subscription alert names no device, and several
   * feeds carry no summary line), and those are exactly the P1s an operator
   * most wants ticketed. They default to '' / '—' rather than 400-ing.
   */
  router.post('/tickets/raise', (req, res) => {
    const alert = (req.body ?? {}) as Record<string, unknown>;
    const required = ['title', 'sev', 'siteName', 'plane', 'age', 'state'] as const;
    if (
      required.some((field) => typeof alert[field] !== 'string' || !(alert[field] as string).trim()) ||
      (alert.sev !== 'P1' && alert.sev !== 'P2' && alert.sev !== 'P3')
    ) {
      res.status(400).json({
        error: 'non-empty alert fields required: title, sev (P1|P2|P3), siteName, plane, age, state',
      });
      return;
    }
    const detail = typeof alert.detail === 'string' && alert.detail.trim() ? alert.detail : '';
    const device = typeof alert.device === 'string' && alert.device.trim() ? alert.device : '—';
    res.json({ ticket: ticketStore.raiseFromAlert({ ...alert, detail, device } as unknown as AlertRow) });
  });

  /**
   * POST /api/tickets/:id/notes {text, kind?} — persist an operator note or a
   * requested next action to the ticket's log. 400 on empty text or a bad
   * kind, 404 on a ticket id the merged queue does not know.
   */
  router.post('/tickets/:id/notes', (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (!text) {
      res.status(400).json({ error: 'text required — an empty note is not logged' });
      return;
    }
    if (text.length > MAX_NOTE_CHARS) {
      res.status(400).json({
        error:
          `note is ${text.length} characters — the limit is ${MAX_NOTE_CHARS}. ` +
          'Nothing was logged; shorten it and send again, or attach the detail to the change record. ' +
          'The portal refuses an over-length note rather than filing a truncated one.',
      });
      return;
    }
    if (body.kind !== undefined && body.kind !== 'note' && body.kind !== 'action') {
      res.status(400).json({ error: "kind must be 'note' or 'action'" });
      return;
    }
    if (dataSource() === 'live' && !ticketStore.list().some((ticket) => ticket.id === req.params.id)) {
      res.status(404).json({ error: `unknown ticket '${req.params.id}'` });
      return;
    }
    const ticket = ticketStore.addNote(req.params.id, text, body.kind === 'action' ? 'action' : 'note');
    if (!ticket) {
      res.status(404).json({ error: `unknown ticket '${req.params.id}'` });
      return;
    }
    res.json({ ticket });
  });

  /**
   * POST /api/tickets/:id/resolve — close a ticket: state 'resolved' plus an
   * action note in its operator log. Idempotent (an already-resolved ticket
   * comes back unchanged); 404 on an id the merged queue does not know.
   */
  router.post('/tickets/:id/resolve', (req, res) => {
    if (dataSource() === 'live' && !ticketStore.list().some((ticket) => ticket.id === req.params.id)) {
      res.status(404).json({ error: `unknown ticket '${req.params.id}'` });
      return;
    }
    const ticket = ticketStore.resolve(req.params.id);
    if (!ticket) {
      res.status(404).json({ error: `unknown ticket '${req.params.id}'` });
      return;
    }
    res.json({ ticket });
  });
}
