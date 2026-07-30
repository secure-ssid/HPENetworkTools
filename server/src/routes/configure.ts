/**
 * server/src/routes/configure.ts — the brokered-write API.
 *
 *   POST /api/configure/render   {kind, form}           → {rendered, meta, blastRadius} (no ticket — pure render)
 *   POST /api/configure/dry-run  {kind, form, ticket}   → DryRunResult (400 without a ticket)
 *   POST /api/configure/queue    {kind, form, ticket}   → BrokeredChange (400 without a ticket)
 *   GET  /api/configure/queue                           → {changes: BrokeredChange[]}
 *   GET  /api/configure/history  ?limit=50              → {events: BrokerAuditEvent[]}
 *   POST /api/configure/push     {changeId}             → PushResult (404 unknown, 409 not-ready / lease expired)
 *   POST /api/configure/discard  {changeId}             → {ok, changeId} (404 unknown)
 *
 *   GET  /api/configure/ssids/catalog                    → SsidCatalog (live scope/dependency choices)
 *   POST /api/configure/ssids/apply {form, reviewConfirmed} → SsidApplyResult (400 without reviewConfirmed:true)
 *
 * SSIDs are the one config kind that does NOT go through the ticketed
 * queue/push above — see server/src/services/ssidDirectWrite.ts for why
 * (New Central's real config surface is a WLAN profile upsert plus separate
 * scope-map assignments, not a single ticketed PUT). Every other kind
 * (port, vlan) is unaffected.
 *
 * 4xx answers are always {error}. Attempted pushes/dry-runs answer 200 with
 * the honest result object (ok/applied flags) — a plane answering 404/500 is
 * an outcome to report, not a request error. BrokerError statuses map
 * through the app's error middleware.
 */

import { Router } from 'express';
import { h } from './handler';
import { writeBroker, type WriteBroker } from '../services/writeBroker';
import { ssidDirectWrite, type SsidDirectWriteService } from '../services/ssidDirectWrite';
import type { BrokerAuditEvent } from '@hpe/shared';

/** Audit-log page size: what the drawer asks for, clamped to what the log tail
 *  can sensibly answer. A missing/garbage `limit` is the default, never 0. */
const HISTORY_DEFAULT = 50;
const HISTORY_MAX = 200;

function historyLimit(raw: unknown): number {
  const n = Number(Array.isArray(raw) ? raw[0] : raw);
  if (!Number.isFinite(n) || n < 1) return HISTORY_DEFAULT;
  return Math.min(HISTORY_MAX, Math.trunc(n));
}

export function makeConfigureRouter(broker: WriteBroker, ssidService: SsidDirectWriteService = ssidDirectWrite): Router {
  const router = Router();

  router.post('/configure/render', (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    res.json(broker.renderPayload(body.kind, body.form));
  });

  router.post(
    '/configure/dry-run',
    h(async (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      res.json(await broker.dryRun(body.kind, body.form, body.ticket));
    }),
  );

  router.post('/configure/queue', (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    res.json(broker.queue(body.kind, body.form, body.ticket));
  });

  router.get('/configure/queue', (_req, res) => {
    res.json({ changes: broker.list() });
  });

  /**
   * The write broker's own audit log (data/change-log.jsonl), newest first —
   * the real "Change history" the Configure header offers. Mirrors the queue
   * endpoint's envelope shape ({events} rather than {changes}).
   *
   * SECURITY: BrokerAuditEvent is {ts, event, changeId, ticket, kind, result,
   * who} — what happened to a change and who did it, never what was in it.
   * Rendered payload bodies stay out of this response and must not be added.
   *
   * A missing log is an empty list, not an error: nothing has been brokered
   * on this install yet, which the drawer states as its own empty state.
   */
  router.get('/configure/history', (req, res) => {
    const events: BrokerAuditEvent[] = broker.recentEvents(historyLimit(req.query.limit));
    res.json({ events });
  });

  router.post(
    '/configure/push',
    h(async (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      res.json(await broker.push(body.changeId));
    }),
  );

  router.post('/configure/discard', (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    res.json(broker.discard(body.changeId));
  });

  /**
   * Live scope choices (sites, site collections, AP device groups, APs) and
   * live security dependencies (roles, authentication server groups, captive-portal
   * profiles) for the SSID editor. Never 4xx on its own — an unlinked/Classic
   * plane answers 200 with every section named in `unavailable` so the
   * screen can disable Apply for what it cannot offer, the same honesty rule
   * every other "not reported by this plane" surface follows.
   */
  router.get(
    '/configure/ssids/catalog',
    h(async (_req, res) => {
      res.json(await ssidService.catalog());
    }),
  );

  /**
   * Apply a reviewed direct SSID change. `reviewConfirmed` stands in for the
   * ticketed broker's ticket reference — the direct-write path's own audit
   * gate (400 without it). The result is always 200: a partial or failed
   * apply is an outcome to report, not a request error.
   */
  router.post(
    '/configure/ssids/apply',
    h(async (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      res.json(await ssidService.apply(body.form, body.reviewConfirmed));
    }),
  );

  return router;
}

/** Process router, bound to the singleton broker + SSID direct-write service. */
export const configureRouter = makeConfigureRouter(writeBroker, ssidDirectWrite);
