/**
 * Reviewed active diagnostics API.
 *
 * GET  /api/diagnostics/eligible
 * POST /api/diagnostics/review
 * POST /api/diagnostics/start
 * GET  /api/diagnostics/jobs/:id
 * POST /api/diagnostics/jobs/:id/cancel
 * GET  /api/diagnostics/history
 * GET  /api/diagnostics/history/export   CSV of audit entries (target always redacted)
 */

import { Router, type NextFunction, type Request, type Response } from 'express';
import type { DiagnosticAuditEntry } from '@hpe/shared';
import { sendCsv } from '../lib/csv';
import { queryString } from '../lib/query';
import { h } from './handler';
import {
  DiagnosticsError,
  DiagnosticsService,
  diagnosticsService,
} from '../services/diagnostics';

/**
 * Optional device / plane / state / q filters on diagnostics history list + CSV.
 * Empty tokens are ignored (honest no-op). Exact filters use shared queryString:
 *   `device=` — case-insensitive exact on device name or serial
 *   `plane=` — case-insensitive exact (compared uppercased)
 *   `state=` — case-insensitive exact on job state
 *   `q=` — case-insensitive substring on device / serial / plane / operation / state / id
 */
export function filterDiagnosticHistoryEntries(
  req: Request,
  entries: readonly DiagnosticAuditEntry[],
): DiagnosticAuditEntry[] {
  const device = queryString(req, 'device').toLowerCase();
  const plane = queryString(req, 'plane').toUpperCase();
  const state = queryString(req, 'state').toLowerCase();
  const q = queryString(req, 'q').toLowerCase();
  if (!device && !plane && !state && !q) return [...entries];
  return entries.filter((e) => {
    if (device && e.device.toLowerCase() !== device && e.serial.toLowerCase() !== device) {
      return false;
    }
    if (plane && String(e.plane).toUpperCase() !== plane) return false;
    if (state && e.state.toLowerCase() !== state) return false;
    if (q) {
      const hay = [e.id, e.device, e.serial, e.plane, e.operation, e.state]
        .map((v) => String(v ?? '').toLowerCase())
        .join(' ');
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

export function createDiagnosticsRouter(service: DiagnosticsService = diagnosticsService): Router {
  const router = Router();

  router.get('/diagnostics/eligible', (_req, res) => res.json(service.eligibility()));
  router.get('/diagnostics/history', (req, res) => {
    const read = service.history();
    res.json({
      ...read,
      entries: filterDiagnosticHistoryEntries(req, read.entries),
    });
  });

  /**
   * GET /api/diagnostics/history/export — CSV of audit history entries.
   * Target is always the redacted sentinel; no hop bodies or secrets.
   * Optional `device=` (name or serial), `plane=`, `state=`, `q=`.
   */
  router.get('/diagnostics/history/export', (req, res) => {
    const read = service.history();
    const entries = filterDiagnosticHistoryEntries(req, read.entries);
    sendCsv(
      res,
      'diagnostics-history.csv',
      ['at', 'id', 'device', 'serial', 'plane', 'operation', 'state', 'target', 'httpCode'],
      entries.map((e) => [
        e.at,
        e.id,
        e.device,
        e.serial,
        e.plane,
        e.operation,
        e.state,
        e.target,
        e.httpCode ?? '',
      ]),
    );
  });

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
