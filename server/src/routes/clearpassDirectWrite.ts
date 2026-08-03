/**
 * server/src/routes/clearpassDirectWrite.ts — ClearPass reviewed direct writes.
 *
 *   POST /api/clearpass/endpoints          {form, reviewConfirmed} → ClearPassWriteResult
 *   PUT  /api/clearpass/endpoints/:id      {form, reviewConfirmed} → ClearPassWriteResult
 *   POST /api/clearpass/local-users        {form, reviewConfirmed} → ClearPassWriteResult
 *   PUT  /api/clearpass/local-users/:id    {form, reviewConfirmed} → ClearPassWriteResult
 *
 * The same reviewed direct-write pattern routes/configure.ts exposes for
 * SSIDs (see services/ssidDirectWrite.ts for why this is not the ticketed
 * broker): `reviewConfirmed: true` stands in for a ticket this plane has
 * none of (400 without it), the service validates → applies → verifies →
 * audits one line per attempt, and a refused or failed write answers 200
 * with the honest result object — an outcome to report, not a request error.
 * Request/gating problems (validation, review gate, not-linked, an unknown
 * role) are ClearPassDirectWriteError 4xx with a fixed, secret-free message;
 * a write the plane never answered is a 502 whose message is likewise fixed
 * — the route surfaces both itself rather than letting a 5xx collapse to
 * 'internal error' in the shared middleware.
 *
 * Local-user passwords are write-only: accepted in the request body, handed
 * to the adapter, and never present in anything this router answers or logs.
 */

import { Router, type Response } from 'express';
import { h } from './handler';
import {
  ClearPassDirectWriteError,
  clearpassDirectWrite,
  type ClearPassDirectWriteService,
} from '../services/clearpassDirectWrite';

/** ClearPassDirectWriteError carries its own HTTP status and a fixed,
 *  secret-free message; anything else is a real bug for the shared error
 *  middleware (index.ts), not something to swallow silently here. */
function reportOrThrow(err: unknown, res: Response): void {
  if (err instanceof ClearPassDirectWriteError) {
    if (err.status >= 500) console.error(`error: ${err.message}`);
    res.status(err.status).json({ error: err.message });
    return;
  }
  throw err;
}

export function makeClearPassDirectWriteRouter(
  service: ClearPassDirectWriteService = clearpassDirectWrite,
): Router {
  const router = Router();

  /** Register one endpoint (POST /api/endpoint on the plane). */
  router.post(
    '/clearpass/endpoints',
    h(async (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      try {
        res.json(await service.registerEndpoint(body.form, body.reviewConfirmed));
      } catch (err) {
        reportOrThrow(err, res);
      }
    }),
  );

  /** Update one endpoint's status and/or operator note (PATCH /api/endpoint/{id}). */
  router.put(
    '/clearpass/endpoints/:id',
    h(async (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      try {
        res.json(await service.updateEndpoint(req.params.id, body.form, body.reviewConfirmed));
      } catch (err) {
        reportOrThrow(err, res);
      }
    }),
  );

  /** Create one local user (POST /api/local-user). */
  router.post(
    '/clearpass/local-users',
    h(async (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      try {
        res.json(await service.createLocalUser(body.form, body.reviewConfirmed));
      } catch (err) {
        reportOrThrow(err, res);
      }
    }),
  );

  /** Update one local user (PUT /api/local-user/{id}). */
  router.put(
    '/clearpass/local-users/:id',
    h(async (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      try {
        res.json(await service.updateLocalUser(req.params.id, body.form, body.reviewConfirmed));
      } catch (err) {
        reportOrThrow(err, res);
      }
    }),
  );

  return router;
}

/** Process router, bound to the singleton direct-write service. */
export const clearpassDirectWriteRouter = makeClearPassDirectWriteRouter();
