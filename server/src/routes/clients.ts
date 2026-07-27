/**
 * server/src/routes/clients.ts — client actions.
 *
 *   POST /api/clients/:mac/disconnect   {ticket}   → DisconnectResult
 *   POST /api/clients/:mac/block        {ticket}   → CoaResult
 *
 * Ticket-gated (400 without one), audit-logged, and honest about the outcome:
 * gating problems (unknown client, wrong plane, no serial, plane unlinked)
 * answer 4xx with {error}; a plane answer that is not 202 comes back at 200
 * as {ok:false, applied:false, httpCode, message} — an outcome to report, not
 * a request error (same convention as the write broker's push).
 */

import { Router, type NextFunction, type Request, type Response } from 'express';
import { DisconnectError, disconnectService } from '../services/disconnect';
import { CoaError, coaService } from '../services/coa';

export const clientsRouter = Router();

/** Wrap async handlers so rejections reach the error middleware (Express 4). */
function h(fn: (req: Request, res: Response, next: NextFunction) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res, next).catch(next);
  };
}

clientsRouter.post(
  '/clients/:mac/disconnect',
  h(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    try {
      res.json(await disconnectService.disconnect(req.params.mac, body.ticket));
    } catch (err) {
      if (err instanceof DisconnectError) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      throw err;
    }
  }),
);

clientsRouter.post(
  '/clients/:mac/block',
  h(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    try {
      res.json(await coaService.block(req.params.mac, body.ticket));
    } catch (err) {
      if (err instanceof CoaError) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      throw err;
    }
  }),
);
