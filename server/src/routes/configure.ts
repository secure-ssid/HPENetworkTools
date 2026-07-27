/**
 * server/src/routes/configure.ts — the brokered-write API.
 *
 *   POST /api/configure/render   {kind, form}           → {rendered, meta, blastRadius} (no ticket — pure render)
 *   POST /api/configure/dry-run  {kind, form, ticket}   → DryRunResult (400 without a ticket)
 *   POST /api/configure/queue    {kind, form, ticket}   → BrokeredChange (400 without a ticket)
 *   GET  /api/configure/queue                           → {changes: BrokeredChange[]}
 *   POST /api/configure/push     {changeId}             → PushResult (404 unknown, 409 not-ready / lease expired)
 *   POST /api/configure/discard  {changeId}             → {ok, changeId} (404 unknown)
 *
 * 4xx answers are always {error}. Attempted pushes/dry-runs answer 200 with
 * the honest result object (ok/applied flags) — a plane answering 404/500 is
 * an outcome to report, not a request error. BrokerError statuses map
 * through the app's error middleware.
 */

import { Router, type NextFunction, type Request, type Response } from 'express';
import { writeBroker, type WriteBroker } from '../services/writeBroker';

/** Wrap async handlers so rejections reach the error middleware (Express 4). */
function h(fn: (req: Request, res: Response, next: NextFunction) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    fn(req, res, next).catch(next);
  };
}

export function makeConfigureRouter(broker: WriteBroker): Router {
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

  return router;
}

/** Process router, bound to the singleton broker. */
export const configureRouter = makeConfigureRouter(writeBroker);
