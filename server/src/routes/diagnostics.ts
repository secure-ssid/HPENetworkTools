/**
 * Reviewed active diagnostics API.
 *
 * GET  /api/diagnostics/eligible
 * POST /api/diagnostics/review
 * POST /api/diagnostics/start
 * GET  /api/diagnostics/jobs/:id
 * POST /api/diagnostics/jobs/:id/cancel
 * GET  /api/diagnostics/history
 */

import { Router, type NextFunction, type Request, type Response } from 'express';
import {
  DiagnosticsError,
  DiagnosticsService,
  diagnosticsService,
} from '../services/diagnostics';

function h(fn: (req: Request, res: Response, next: NextFunction) => Promise<void> | void) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

export function createDiagnosticsRouter(service: DiagnosticsService = diagnosticsService): Router {
  const router = Router();

  router.get('/diagnostics/eligible', (_req, res) => res.json(service.eligibility()));
  router.get('/diagnostics/history', (_req, res) => res.json({ entries: service.history() }));

  router.post('/diagnostics/review', h((req, res) => {
    res.json(service.review((req.body ?? {}) as Record<string, unknown>));
  }));

  router.post('/diagnostics/start', h(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    res.status(202).json(await service.start(body.reviewId, body.confirmed, body.plane, body.serial));
  }));

  router.get('/diagnostics/jobs/:id', h((req, res) => {
    res.json(service.status(req.params.id));
  }));

  router.post('/diagnostics/jobs/:id/cancel', h((req, res) => {
    res.json(service.cancel(req.params.id));
  }));

  router.use((err: Error, _req: Request, res: Response, next: NextFunction) => {
    if (err instanceof DiagnosticsError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    next(err);
  });

  return router;
}

export const diagnosticsRouter = createDiagnosticsRouter();
