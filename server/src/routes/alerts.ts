/**
 * server/src/routes/alerts.ts — alert actions.
 *
 *   POST /api/alerts/ack   {ticket, alert: {plane, alertId?, title?, device?}}
 *
 * Ticket-gated (400 without one), audit-logged, and honest about the outcome:
 * gating problems (missing target, wrong plane, no plane key, Central
 * unlinked) answer 4xx with {error}; a plane answer that is not 202 comes
 * back at 200 as {ok:false, applied:false, httpCode, message} — an outcome to
 * report, not a request error (same convention as reboot/disconnect).
 */

import { Router, type NextFunction, type Request, type Response } from 'express';
import { AckAlertError, ackAlertService } from '../services/ackAlert';

export const alertsRouter = Router();

/** Wrap async handlers so rejections reach the error middleware (Express 4). */
function h(fn: (req: Request, res: Response, next: NextFunction) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    fn(req, res, next).catch(next);
  };
}

alertsRouter.post(
  '/alerts/ack',
  h(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    try {
      res.json(await ackAlertService.acknowledge(body.alert, body.ticket));
    } catch (err) {
      if (err instanceof AckAlertError) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      throw err;
    }
  }),
);
