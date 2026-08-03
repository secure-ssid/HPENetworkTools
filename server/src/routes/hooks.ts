/**
 * server/src/routes/hooks.ts — the inbound webhook receiver API.
 *
 * Two routers, deliberately separated by the trust that authenticates them:
 *
 *   hooksReceiverRouter — mounts AHEAD of the session guard (index.ts):
 *     POST /api/hooks/mist      a Mist delivery; the HMAC signature in its
 *     POST /api/hooks/central   X-Mist-Signature(-v2) / Signature headers IS
 *                             the authentication — a delivery from Mist or
 *                             Central holds no operator session, the same
 *                             reason /api/auth mounts ahead of the guard.
 *                             Both paths get the raw body (the scoped raw
 *                             parser in index.ts) because the signature
 *                             covers the exact bytes received.
 *
 *   hooksRouter — mounts with the other guarded routers:
 *     GET    /api/hooks/receivers               per-source receiver status
 *     GET    /api/hooks/events                  recent received events (?limit=)
 *     POST   /api/hooks/receivers/:source/secret  store a signing secret (write-only)
 *     DELETE /api/hooks/receivers/:source/secret  clear it
 *     POST   /api/hooks/simulate                demo-only: sign a fixture payload
 *                                               and run it through the REAL
 *                                               verify→normalize→record pipeline
 *                                               (?topic= picks the Mist topic:
 *                                               alarms | client-sessions |
 *                                               device-updowns)
 *     GET    /api/hooks/mist/registration       the Mist webhook subscription
 *     POST   /api/hooks/mist/registration       auto-registration: direct in
 *                                               lab mode, review-confirmed in
 *                                               hardened mode
 *                                               create/update of the org
 *                                               subscription pointing at this
 *                                               receiver (+ secret rotation
 *                                               and re-read verification) —
 *                                               services/mistWebhooks.ts
 *
 * Ingest outcomes come straight from the receiver (401 bad signature, 400
 * malformed, 503 unconfigured, 202 accepted) — the route adds nothing to
 * them, because the pipeline's vocabulary is the honest answer already.
 */

import { Router } from 'express';
import { h } from './handler';
import {
  MIST_WEBHOOK_TOPICS,
  centralDemoAlertPayload,
  isMistWebhookTopic,
  isWebhookReceiverSource,
  mistDemoAlarmPayload,
  mistDemoClientSessionPayload,
  mistDemoDeviceUpdownPayload,
  type MistWebhookRegistrationForm,
  type WebhookEventsEnvelope,
  type WebhookReceiverStatusEnvelope,
} from '@hpe/shared';
import { settings } from '../config/settings';
import { allowsLabDirectWrites } from '../services/labWritePolicy';
import {
  WEBHOOK_SECRET_MAX_CHARS,
  WEBHOOK_SECRET_MIN_CHARS,
  signCentralDelivery,
  signMistDelivery,
  webhookReceiver,
  type ReceiverRequestContext,
  type WebhookReceiver,
} from '../services/webhookReceiver';
import { mistWebhookRegistrationStatus, registerMistWebhook } from '../services/mistWebhooks';

/** The request facts signature verification needs, taken from the ORIGINAL
 *  url (the router mount strips nothing Central could have signed). */
function requestContext(req: { method: string; originalUrl: string; protocol: string; get(name: string): string | undefined }): ReceiverRequestContext {
  const qIndex = req.originalUrl.indexOf('?');
  return {
    method: req.method,
    path: qIndex === -1 ? req.originalUrl : req.originalUrl.slice(0, qIndex),
    query: qIndex === -1 ? '' : req.originalUrl.slice(qIndex),
    protocol: req.protocol,
    host: req.get('host') ?? 'localhost',
  };
}

/** Factory so tests can inject an isolated receiver (same shape as
 *  makeCentralWebhooksRouter) — the process router below binds the singleton. */
export function makeHooksReceiverRouter(receiver: WebhookReceiver = webhookReceiver): Router {
  const router = Router();

  for (const source of ['mist', 'central'] as const) {
    router.post(
      `/hooks/${source}`,
      h((req, res) => {
        // The scoped raw parser (index.ts) is what makes the exact signed
        // bytes available; without it there is nothing honest to verify.
        if (!Buffer.isBuffer(req.body)) {
          res.status(400).json({ error: 'raw request body required for signature verification' });
          return;
        }
        const headers = (name: string): string | undefined => {
          const value = req.get(name);
          return typeof value === 'string' ? value : undefined;
        };
        const outcome = receiver.ingest(source, req.body, headers, requestContext(req));
        res.status(outcome.status).json(outcome.body);
      }),
    );
  }

  return router;
}

export function makeHooksRouter(receiver: WebhookReceiver = webhookReceiver): Router {
  const router = Router();

  router.get(
    '/hooks/receivers',
    h((_req, res) => {
      const envelope: WebhookReceiverStatusEnvelope = {
        demoMode: settings.get().demoMode,
        receivers: receiver.status(),
      };
      res.json(envelope);
    }),
  );

  router.get(
    '/hooks/events',
    h((req, res) => {
      const limitRaw = typeof req.query.limit === 'string' ? Number(req.query.limit) : undefined;
      const limit = limitRaw !== undefined && Number.isSafeInteger(limitRaw) && limitRaw > 0 ? limitRaw : undefined;
      const events = receiver.recent(limit);
      const envelope: WebhookEventsEnvelope = {
        events,
        ...(events.length === 0
          ? {
              note:
                'nothing received yet — register the receiver URL as a webhook target with Mist or New Central, ' +
                'or use the demo simulate path to see a signed delivery end to end',
            }
          : {}),
      };
      res.json(envelope);
    }),
  );

  router.post(
    '/hooks/receivers/:source/secret',
    h((req, res) => {
      if (!isWebhookReceiverSource(req.params.source)) {
        res.status(400).json({ error: 'source must be mist or central' });
        return;
      }
      const body = (req.body ?? {}) as Record<string, unknown>;
      const secret = typeof body.secret === 'string' ? body.secret.trim() : '';
      if (secret.length < WEBHOOK_SECRET_MIN_CHARS || secret.length > WEBHOOK_SECRET_MAX_CHARS) {
        res.status(400).json({
          error:
            `secret must be ${WEBHOOK_SECRET_MIN_CHARS}–${WEBHOOK_SECRET_MAX_CHARS} characters — ` +
            'a shorter secret cannot meaningfully authenticate a delivery, and nothing was stored',
        });
        return;
      }
      receiver.setSecret(req.params.source, secret);
      // Write-only: the answer confirms the state change, never the secret.
      res.json({ ok: true, source: req.params.source, secret: 'operator' });
    }),
  );

  router.delete(
    '/hooks/receivers/:source/secret',
    h((req, res) => {
      if (!isWebhookReceiverSource(req.params.source)) {
        res.status(400).json({ error: 'source must be mist or central' });
        return;
      }
      if (!receiver.clearSecret(req.params.source)) {
        res.status(404).json({ error: `no operator signing secret is configured for ${req.params.source}` });
        return;
      }
      res.json({ ok: true, source: req.params.source });
    }),
  );

  /**
   * The demo path: build the fixture payload for a source, sign it with the
   * EFFECTIVE secret (the public demo secret, or the operator's own when one
   * is stored in demo mode), and run it through receiver.ingest — the same
   * verify→normalize→record pipeline a real Mist/Central delivery takes,
   * signature check included. The accepted events are labelled demo. Outside
   * demo mode the route says so rather than simulating anything.
   *
   * For Mist, `topic` picks the fixture: 'alarms' (the default) or the
   * newer 'client-sessions' / 'device-updowns' topics the receiver has
   * dedicated mappers for — so the demo exercises those mappers through the
   * same signed path, not a shortcut.
   */
  router.post(
    '/hooks/simulate',
    h((req, res) => {
      if (!settings.get().demoMode) {
        res.status(403).json({ error: 'the simulate path is only available in demo mode' });
        return;
      }
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (!isWebhookReceiverSource(body.source)) {
        res.status(400).json({ error: 'source must be mist or central' });
        return;
      }
      const source = body.source;
      const topic = typeof body.topic === 'string' ? body.topic : 'alarms';
      if (source === 'mist' && !isMistWebhookTopic(topic)) {
        res.status(400).json({ error: `topic must be one of ${MIST_WEBHOOK_TOPICS.join(', ')}` });
        return;
      }
      const effective = receiver.effectiveSecret(source);
      if (!effective) {
        res.status(503).json({ error: `no ${source} signing secret is available to sign the demo delivery` });
        return;
      }
      const payload =
        source === 'mist'
          ? topic === 'client-sessions'
            ? mistDemoClientSessionPayload()
            : topic === 'device-updowns'
              ? mistDemoDeviceUpdownPayload()
              : mistDemoAlarmPayload()
          : centralDemoAlertPayload();
      const raw = Buffer.from(JSON.stringify(payload), 'utf8');
      // A fabricated but self-consistent request context: the signature is
      // computed over it and verified against it, exactly as a real
      // delivery's context would be. `demo` marks the accepted event.
      const ctx: ReceiverRequestContext = {
        method: 'POST',
        path: `/api/hooks/${source}`,
        query: '',
        protocol: 'https',
        host: 'demo-receiver.invalid',
        demo: true,
      };
      const signed =
        source === 'mist' ? signMistDelivery(effective.secret, raw) : signCentralDelivery(effective.secret, ctx);
      const headers = (name: string): string | undefined => signed[name.toLowerCase()];
      const outcome = receiver.ingest(source, raw, headers, ctx);
      res.status(outcome.status).json({ ...outcome.body, demo: true });
    }),
  );

  /**
   * The Mist webhook auto-registration: which of the org's subscriptions
   * point at this receiver, and when a delivery last arrived. The status
   * read is also the "verify" action — it re-reads the org fresh every
   * call. Demo mode serves the authored fixture (the Systems Mist drawer
   * demonstrates the registered state without credentials).
   */
  router.get(
    '/hooks/mist/registration',
    h(async (_req, res) => {
      res.json(await mistWebhookRegistrationStatus());
    }),
  );

  /**
   * Register/rotate is direct in lab mode and review-confirmed in hardened
   * mode because a subscription changes the org's configuration. The result body
   * is the service's own vocabulary (created/updated/unchanged/failed,
   * verified only when the re-read confirmed); the secret, when the form
   * rotates one, is write-only end to end.
   */
  router.post(
    '/hooks/mist/registration',
    h(async (req, res) => {
      // The scoped raw parser (index.ts) mounts on the '/api/hooks/mist'
      // PREFIX — which includes this path — so the JSON body may arrive as
      // the raw Buffer the receiver needs. Parse it either way; a body that
      // is neither an object nor parseable JSON is a 400, same class as the
      // other validation refusals.
      let body: Record<string, unknown>;
      try {
        body = (
          Buffer.isBuffer(req.body) ? JSON.parse(req.body.toString('utf8')) : (req.body ?? {})
        ) as Record<string, unknown>;
      } catch {
        res.status(400).json({ ok: false, action: 'failed', message: 'malformed JSON body' });
        return;
      }
      if (!allowsLabDirectWrites() && body.reviewConfirmed !== true) {
        res.status(400).json({
          ok: false,
          action: 'failed',
          message: 'review confirmation is required — registering a webhook changes the org configuration',
        });
        return;
      }
      if (
        body.topics !== undefined &&
        (!Array.isArray(body.topics) || body.topics.some((topic) => !isMistWebhookTopic(topic)))
      ) {
        res.status(400).json({
          ok: false,
          action: 'failed',
          message: `topics must contain only ${MIST_WEBHOOK_TOPICS.join(', ')}`,
        });
        return;
      }
      const form: MistWebhookRegistrationForm = {
        url: typeof body.url === 'string' ? body.url : '',
        topics: Array.isArray(body.topics) ? body.topics : [...MIST_WEBHOOK_TOPICS],
        ...(typeof body.secret === 'string' ? { secret: body.secret } : {}),
      };
      const result = await registerMistWebhook(form);
      // The write answering an upstream error is a 502 from the portal's
      // side; a validation refusal is a 400. Either way the body says why.
      res.status(result.ok ? 200 : result.httpCode !== undefined ? 502 : 400).json(result);
    }),
  );

  return router;
}

export const hooksReceiverRouter = makeHooksReceiverRouter();
export const hooksRouter = makeHooksRouter();
