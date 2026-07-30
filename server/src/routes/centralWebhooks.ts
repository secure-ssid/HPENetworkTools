/**
 * server/src/routes/centralWebhooks.ts — New Central webhook management API.
 *
 *   GET    /api/central/webhooks                       ?limit=&offset=&q=  → WebhookListEnvelope
 *   GET    /api/central/webhooks/:id                                       → WebhookDetail
 *   GET    /api/central/webhooks/handoff                                   → durable pending status
 *   POST   /api/central/webhooks/handoff/acknowledge                        secretStored:true
 *   POST   /api/central/webhooks/handoff/resolve                            reviewed manual reconciliation
 *   POST   /api/central/webhooks                        reviewed create
 *   PUT    /api/central/webhooks/:id                    disabled (501; no Central call)
 *   PATCH  /api/central/webhooks/:id                    {form: {expectedGeneration, ...}, reviewConfirmed}
 *   DELETE /api/central/webhooks/:id                     {reviewConfirmed}                → WebhookMutationResult
 *   POST   /api/central/webhooks/:id/rotate-hmac-key    reviewed rotation
 *
 * Every :id is checked against isWebhookId() (a bounded, URL-safe character
 * set) before it is ever placed on an outbound path segment, on top of
 * encodeURIComponent() — the same allowlist-then-encode discipline
 * server/src/routes/sse.ts's `:kind` allowlist follows. There is no route
 * here that accepts an arbitrary path or forwards a caller-supplied URL to
 * Central.
 *
 * Reads never throw for an unlinked/Classic/denied Central — they answer
 * 200 with the honest reason named (list: `error`; single-object read: a
 * distinct 502, never collapsed into 404 — see CentralWebhooksService.get's
 * own doc comment). Mutations require a real CentralWebhooksError-status
 * response (400 missing review confirmation, 409 not linked/unsupported
 * gateway is instead reported as an ok:false result — see the service) for
 * genuine request errors; a plane answer that is not 2xx is itself reported
 * as {ok:false, action:'failed', ...} at 200, not a 4xx/5xx.
 */

import { Router, type Response } from 'express';
import { h } from './handler';
import type { WebhookMutationResult, WebhookOneTimeSecretResult } from '@hpe/shared';
import { CentralWebhooksError, centralWebhooks, type CentralWebhooksService } from '../services/centralWebhooks';

/** CentralWebhooksError carries its own HTTP status; anything else is a
 *  real bug and goes to the shared error middleware (index.ts). */
function reportOrThrow(err: unknown, res: Response): void {
  if (err instanceof CentralWebhooksError) {
    if (err.status >= 500) console.error(`error: ${err.message}`);
    res.status(err.status).json({ error: err.message });
    return;
  }
  throw err;
}

function sendMutation(res: Response, result: WebhookMutationResult | WebhookOneTimeSecretResult): void {
  const status =
    result.action === 'conflict'
      ? 409
      : result.action === 'unknown' && result.httpCode === 502
        ? 502
      : result.action === 'unsupported'
        ? 501
        : 200;
  res.status(status).json(result);
}

/** Factory so tests can inject a CentralWebhooksService built with a stub
 *  plane (same shape as server/src/routes/configure.ts's makeConfigureRouter
 *  taking an injectable ssidService) — the process router below binds the
 *  singleton. */
export function makeCentralWebhooksRouter(service: CentralWebhooksService = centralWebhooks): Router {
  const router = Router();

  router.get(
    '/central/webhooks',
    h(async (req, res) => {
      try {
        res.json(await service.list(req.query.limit, req.query.offset, req.query.q));
      } catch (err) {
        reportOrThrow(err, res);
      }
    }),
  );

  router.get(
    '/central/webhooks/handoff',
    h(async (_req, res) => {
      try {
        res.json(await service.getPendingHandoff());
      } catch (err) {
        reportOrThrow(err, res);
      }
    }),
  );

  router.post(
    '/central/webhooks/handoff/acknowledge',
    h(async (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      try {
        res.json(await service.acknowledgeHandoff(body.operationId, body.secretStored));
      } catch (err) {
        reportOrThrow(err, res);
      }
    }),
  );

  router.post(
    '/central/webhooks/handoff/resolve',
    h(async (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      try {
        res.json(
          await service.resolveHandoff(
            body.operationId,
            body.resolution,
            body.reviewConfirmed,
            body.attestations,
            body.matchedWebhookId,
          ),
        );
      } catch (err) {
        reportOrThrow(err, res);
      }
    }),
  );

  router.get(
    '/central/webhooks/:id',
    h(async (req, res) => {
      try {
        res.json(await service.get(req.params.id));
      } catch (err) {
        reportOrThrow(err, res);
      }
    }),
  );

  router.post(
    '/central/webhooks',
    h(async (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      try {
        if (typeof body.reviewedTenantBinding !== 'string') {
          throw new CentralWebhooksError(
            409,
            'the reviewed Central tenant binding is missing; refresh the webhook list and review again',
          );
        }
        sendMutation(
          res,
          await service.create(
            body.form,
            body.reviewConfirmed,
            body.oneTimeSecretAcknowledged,
            body.reviewedTenantBinding,
          ),
        );
      } catch (err) {
        reportOrThrow(err, res);
      }
    }),
  );

  router.put(
    '/central/webhooks/:id',
    h(async (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      try {
        sendMutation(res, await service.replace(req.params.id, body.form, body.reviewConfirmed));
      } catch (err) {
        reportOrThrow(err, res);
      }
    }),
  );

  router.patch(
    '/central/webhooks/:id',
    h(async (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      try {
        sendMutation(res, await service.patch(req.params.id, body.form, body.reviewConfirmed));
      } catch (err) {
        reportOrThrow(err, res);
      }
    }),
  );

  router.delete(
    '/central/webhooks/:id',
    h(async (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      try {
        sendMutation(res, await service.remove(req.params.id, body.reviewConfirmed));
      } catch (err) {
        reportOrThrow(err, res);
      }
    }),
  );

  router.post(
    '/central/webhooks/:id/rotate-hmac-key',
    h(async (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      try {
        if (typeof body.reviewedTenantBinding !== 'string') {
          throw new CentralWebhooksError(
            409,
            'the reviewed Central tenant binding is missing; refresh the webhook list and review again',
          );
        }
        sendMutation(
          res,
          await service.rotateHmacKey(
            req.params.id,
            body.reviewConfirmed,
            body.oneTimeSecretAcknowledged,
            body.reviewedTenantBinding,
          ),
        );
      } catch (err) {
        reportOrThrow(err, res);
      }
    }),
  );

  return router;
}

/** Process router, bound to the singleton service. */
export const centralWebhooksRouter = makeCentralWebhooksRouter(centralWebhooks);
