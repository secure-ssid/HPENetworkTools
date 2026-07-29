/**
 * server/src/routes/devices.ts — device actions.
 *
 *   POST /api/devices/:name/reboot   {ticket, plane?, serial?} → RebootResult
 *
 * Ticket-gated (400 without one), audit-logged, and honest about the outcome:
 * gating problems (unknown device, wrong plane, no serial, Central unlinked)
 * answer 4xx with {error}; a plane answer that is not 202 comes back at 200
 * as {ok:false, applied:false, httpCode, message} — an outcome to report, not
 * a request error (same convention as the write broker's push).
 */

import { Router, type NextFunction, type Request, type Response } from 'express';
import { RebootError, RebootService, rebootService } from '../services/reboot';

/** Wrap async handlers so rejections reach the error middleware (Express 4). */
function h(fn: (req: Request, res: Response, next: NextFunction) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res, next).catch(next);
  };
}

export function createDevicesRouter(service: RebootService = rebootService): Router {
  const router = Router();
  router.post(
    '/devices/:name/reboot',
    h(async (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      try {
        res.json(await service.reboot(req.params.name, body.ticket, {
          plane: typeof body.plane === 'string' ? body.plane : undefined,
          serial: typeof body.serial === 'string' ? body.serial : undefined,
        }));
      } catch (err) {
        if (err instanceof RebootError) {
          res.status(err.status).json({ error: err.message, ...err.details });
          return;
        }
        throw err;
      }
    }),
  );
  return router;
}

export const devicesRouter = createDevicesRouter();
