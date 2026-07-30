/**
 * Central webhook management.
 *
 * The largest group here handles one-time secrets. A created or rotated HMAC
 * key is shown exactly once, so a response that is lost in flight leaves an
 * outcome nobody can recover — those cases resolve to an explicit UNKNOWN
 * result rather than a success or a failure, because claiming either would be
 * a guess about a credential that may now exist.
 */

import {
  ApiError,
  ApiResult,
  messageFromBody,
  responseJson,
  serverMessage,
} from './core';
import {
  canonicalizeWebhookCreateForm,
  type WebhookDetail,
  type WebhookForm,
  type WebhookHandoffResolutionResult,
  type WebhookHandoffStatus,
  type WebhookListEnvelope,
  type WebhookMutationResult,
  type WebhookOneTimeSecretResult,
  type WebhookPatchForm,
  type WebhookUnknownOutcomeCode,
} from '@hpe/shared';

// ---------------------------------------------------------------------------
// New Central webhook management — /api/central/webhooks/*
//
// Reads never throw for an unlinked/Classic/permission-denied Central; they
// answer with the envelope's own honest `error` (list) so the panel can
// render "nothing to show, and why" without treating it as a network
// failure. Mutations require `reviewConfirmed: true`; the server's own
// response is always the outcome to render (ok:false is a normal result,
// not a thrown error) — see server/src/services/centralWebhooks.ts.
//
// Create and HMAC-key rotation require two independent confirmations. Their
// successful response is the only client
// contract carrying `hmacKey`; callers must hand it directly to the dedicated
// one-time modal and discard it on close. A separate secretStored:true
// acknowledgement clears the server's durable, secret-free handoff journal.
// The key never enters list/detail state, browser storage, settings, generic
// mutation history, or toast text.
// ---------------------------------------------------------------------------

export function emptyWebhookEnvelope(opts: { limit?: number; offset?: number }, error: string): WebhookListEnvelope {
  return {
    items: [],
    totalCount: 0,
    count: 0,
    limit: opts.limit ?? 10,
    offset: opts.offset ?? 0,
    hasMore: false,
    source: 'unavailable',
    error,
    gatewayBaseUrl: null,
    tenantBinding: null,
  };
}

/** GET /api/central/webhooks — never throws; an unreachable backend or a
 *  non-OK response both answer the same honest envelope shape with `error`
 *  set and `items: []`. */
export async function getCentralWebhooks(
  opts: { limit?: number; offset?: number; q?: string } = {},
): Promise<WebhookListEnvelope> {
  const params = new URLSearchParams();
  if (opts.limit !== undefined) params.set('limit', String(opts.limit));
  if (opts.offset !== undefined) params.set('offset', String(opts.offset));
  if (opts.q?.trim()) params.set('q', opts.q.trim());
  const qs = params.toString();
  try {
    const r = await fetch(`/api/central/webhooks${qs ? `?${qs}` : ''}`);
    if (!r.ok) return emptyWebhookEnvelope(opts, await serverMessage(r, `request failed — HTTP ${r.status}`));
    const body = (await r.json()) as Partial<WebhookListEnvelope>;
    if (!Array.isArray(body.items)) {
      return emptyWebhookEnvelope(opts, 'the portal returned a successful but unrecognized webhook list response');
    }
    return body as WebhookListEnvelope;
  } catch (err) {
    return emptyWebhookEnvelope(opts, `cannot reach the portal backend: ${(err as Error).message}`);
  }
}

/** GET /api/central/webhooks/:id — fresh single-webhook detail, used to
 *  populate the edit drawer's "before" state for the review diff. */
export async function getCentralWebhook(id: string): Promise<ApiResult<WebhookDetail>> {
  try {
    const r = await fetch(`/api/central/webhooks/${encodeURIComponent(id)}`);
    if (r.ok) return (await r.json()) as WebhookDetail;
    return { error: await serverMessage(r, `request failed — HTTP ${r.status}`) };
  } catch (err) {
    return { error: `cannot reach the portal backend: ${(err as Error).message}`, offline: true };
  }
}

export async function getCentralWebhookHandoffStatus(): Promise<ApiResult<WebhookHandoffStatus>> {
  try {
    const r = await fetch('/api/central/webhooks/handoff');
    if (r.ok) return (await r.json()) as WebhookHandoffStatus;
    return { error: await serverMessage(r, `request failed — HTTP ${r.status}`), httpCode: r.status };
  } catch (err) {
    return { error: `cannot reach the portal backend: ${(err as Error).message}`, offline: true };
  }
}

export async function acknowledgeCentralWebhookHandoff(
  operationId: string,
  secretStored: true,
): Promise<ApiResult<WebhookHandoffResolutionResult>> {
  try {
    const r = await fetch('/api/central/webhooks/handoff/acknowledge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ operationId, secretStored }),
    });
    if (r.ok) return (await r.json()) as WebhookHandoffResolutionResult;
    return { error: await serverMessage(r, `request failed — HTTP ${r.status}`), httpCode: r.status };
  } catch (err) {
    return { error: `cannot reach the portal backend: ${(err as Error).message}`, offline: true };
  }
}

export async function resolveCentralWebhookHandoff(input: {
  operationId: string;
  resolution: 'create-located' | 'create-absent' | 'rotate-reconciled';
  reviewConfirmed: true;
  attestations: Record<string, true>;
  matchedWebhookId?: string;
}): Promise<ApiResult<WebhookHandoffResolutionResult>> {
  try {
    const r = await fetch('/api/central/webhooks/handoff/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (r.ok) return (await r.json()) as WebhookHandoffResolutionResult;
    return { error: await serverMessage(r, `request failed — HTTP ${r.status}`), httpCode: r.status };
  } catch (err) {
    return { error: `cannot reach the portal backend: ${(err as Error).message}`, offline: true };
  }
}

export async function webhookMutate(
  path: string,
  method: 'PATCH' | 'DELETE',
  body: unknown,
  secrets: readonly string[] = [],
): Promise<ApiResult<WebhookMutationResult>> {
  try {
    const r = await fetch(path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (r.ok) return (await r.json()) as WebhookMutationResult;
    const responseBody = await responseJson(r);
    if (r.status === 409) {
      const conflict = webhookConflictResult(responseBody, secrets);
      if (conflict) return conflict;
    }
    // `httpCode` lets the caller tell a definite, known failure (400/403/409
    // — safe to let the operator see and retry immediately) apart from a 502
    // "the outcome is unknown" transport answer, which is not (see
    // isUnknownWebhookOutcome below).
    return {
      error: redactWebhookSecrets(messageFromBody(responseBody, `request failed — HTTP ${r.status}`), secrets),
      httpCode: r.status,
    };
  } catch (err) {
    return {
      error: redactWebhookSecrets(`cannot reach the portal backend: ${(err as Error).message}`, secrets),
      offline: true,
    };
  }
}

export function webhookCreateForm(form: WebhookForm): WebhookForm | null {
  if (form.authMechanism === 'API_KEY' || form.authMechanism === 'OIDC') {
    return canonicalizeWebhookCreateForm(form);
  }
  return null;
}

export function parseOneTimeWebhookResult(
  body: unknown,
  expectedAction: 'created' | 'rotated',
): WebhookOneTimeSecretResult | null {
  try {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
    const record = body as Record<string, unknown>;
    if (
      record.ok !== true ||
      record.action !== expectedAction ||
      typeof record.operationId !== 'string' ||
      typeof record.hmacKey !== 'string' ||
      record.hmacKey.trim().length === 0
    ) {
      return null;
    }
    return {
      ok: true,
      action: expectedAction,
      operationId: record.operationId,
      hmacKey: record.hmacKey,
      message:
        expectedAction === 'created'
          ? 'webhook created — copy the one-time HMAC key now'
          : 'webhook HMAC key rotated — copy the one-time key now',
      ...(typeof record.callbackValidatedAt === 'string'
        ? { callbackValidatedAt: record.callbackValidatedAt }
        : {}),
    };
  } catch {
    return null;
  }
}

export function oneTimeUnknownCode(action: 'created' | 'rotated'): WebhookUnknownOutcomeCode {
  return action === 'created'
    ? 'WEBHOOK_CREATE_HMAC_OUTCOME_UNKNOWN'
    : 'WEBHOOK_ROTATE_HMAC_OUTCOME_UNKNOWN';
}

export function oneTimeUnknownMessage(action: 'created' | 'rotated'): string {
  return action === 'created'
    ? 'The webhook create outcome is unknown because the one-time HMAC key response was unavailable. Reconcile the webhook list before another create; retrying blindly may duplicate the webhook.'
    : 'The HMAC rotation outcome is unknown because the one-time key response was unavailable. Reconcile the receiver and key before another rotation; retrying blindly may rotate the key again.';
}

export function parseOneTimeUnknownResult(
  body: unknown,
  expectedAction: 'created' | 'rotated',
  httpCode: number,
): ApiError | null {
  try {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
    const record = body as Record<string, unknown>;
    const code = oneTimeUnknownCode(expectedAction);
    if (
      record.ok !== false ||
      record.action !== 'unknown' ||
      record.outcome !== 'unknown' ||
      record.code !== code
    ) {
      return null;
    }
    return {
      error: oneTimeUnknownMessage(expectedAction),
      httpCode,
      outcome: 'unknown',
      code,
      ...(typeof record.operationId === 'string' ? { operationId: record.operationId } : {}),
    };
  } catch {
    return null;
  }
}

export function parseOneTimeFailureResult(
  body: unknown,
  httpCode: number,
  secrets: readonly string[],
): ApiError | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  if (
    record.ok !== false ||
    record.action !== 'failed' ||
    typeof record.message !== 'string'
  ) {
    return null;
  }
  return {
    error: redactWebhookSecrets(record.message, secrets),
    httpCode,
    ...(typeof record.operationId === 'string' ? { operationId: record.operationId } : {}),
  };
}

export async function webhookSecretMutate(
  path: string,
  body: unknown,
  expectedAction: 'created' | 'rotated',
  secrets: readonly string[] = [],
): Promise<ApiResult<WebhookOneTimeSecretResult>> {
  try {
    const r = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const responseBody = await responseJson(r);
    if (r.ok) {
      const success = parseOneTimeWebhookResult(responseBody, expectedAction);
      if (success) return success;
      const unknown = parseOneTimeUnknownResult(responseBody, expectedAction, r.status);
      if (unknown) return unknown;
      const failure = parseOneTimeFailureResult(responseBody, r.status, secrets);
      if (failure) return failure;
      return {
        error: oneTimeUnknownMessage(expectedAction),
        httpCode: r.status,
        outcome: 'unknown',
        code: oneTimeUnknownCode(expectedAction),
      };
    }
    const unknown = parseOneTimeUnknownResult(responseBody, expectedAction, r.status);
    if (unknown) return unknown;
    return {
      error: redactWebhookSecrets(
        messageFromBody(responseBody, `request failed — HTTP ${r.status}`),
        secrets,
      ),
      httpCode: r.status,
    };
  } catch (err) {
    return {
      error: redactWebhookSecrets(`cannot reach the portal backend: ${(err as Error).message}`, secrets),
      offline: true,
    };
  }
}

export function webhookConflictResult(body: unknown, secrets: readonly string[]): WebhookMutationResult | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  if (
    record.ok !== false ||
    record.action !== 'conflict' ||
    record.httpCode !== 409 ||
    typeof record.message !== 'string'
  ) {
    return null;
  }
  return {
    ok: false,
    action: 'conflict',
    httpCode: 409,
    message: redactWebhookSecrets(record.message, secrets),
    ...(typeof record.callbackValidatedAt === 'string'
      ? { callbackValidatedAt: record.callbackValidatedAt }
      : {}),
  };
}

export function redactWebhookSecrets(message: string, secrets: readonly string[]): string {
  return secrets.reduce(
    (safe, secret) => (secret ? safe.split(secret).join('[redacted]') : safe),
    message,
  );
}

export function webhookPatchForm(form: WebhookForm, expectedGeneration: number): WebhookPatchForm | null {
  const common = {
    expectedGeneration,
    name: form.name,
    endpoint: form.endpoint,
  };
  if (form.authMechanism === 'OIDC') {
    return {
      ...common,
      authMechanism: 'OIDC',
      oidcClientId: form.oidcClientId,
      oidcClientSecret: form.oidcClientSecret,
      oidcWellKnownUrl: form.oidcWellKnownUrl,
    };
  }
  if (form.authMechanism === 'API_KEY') {
    return {
      ...common,
      authMechanism: 'API_KEY',
      apiKey: form.apiKey,
    };
  }
  return null;
}

/**
 * PATCH /api/central/webhooks/:id — the only edit path this app exposes,
 * review-confirmed. `expectedGeneration` (the generation the operator's
 * reviewed diff was built from) rides along on every request as an
 * optimistic-concurrency check; a stale generation is expected to come back
 * as an `ok:false` result with `httpCode: 409` (see
 * isWebhookGenerationConflict below) rather than silently applying over a
 * change the operator never saw.
 */
export async function updateCentralWebhook(
  id: string,
  form: WebhookForm,
  reviewConfirmed: boolean,
  expectedGeneration?: number,
): Promise<ApiResult<WebhookMutationResult>> {
  if (typeof expectedGeneration !== 'number' || !Number.isSafeInteger(expectedGeneration) || expectedGeneration < 0) {
    return { error: 'expectedGeneration must be a non-negative safe integer' };
  }
  const patchForm = webhookPatchForm(form, expectedGeneration);
  if (!patchForm) return { error: 'authMechanism must be exactly API_KEY or OIDC' };
  const secrets = [patchForm.apiKey, patchForm.oidcClientSecret].filter(
    (value): value is string => typeof value === 'string' && value.length > 0,
  );
  return webhookMutate(
    `/api/central/webhooks/${encodeURIComponent(id)}`,
    'PATCH',
    { form: patchForm, reviewConfirmed },
    secrets,
  );
}

/** POST /api/central/webhooks — reviewed create with a second
 * one-time-secret acknowledgement. The success result must be discarded as
 * soon as its dedicated modal closes. */
export async function createCentralWebhook(
  form: WebhookForm,
  reviewConfirmed: boolean,
  oneTimeSecretAcknowledged: boolean,
  reviewedTenantBinding: string | null,
): Promise<ApiResult<WebhookOneTimeSecretResult>> {
  if (reviewConfirmed !== true) {
    return { error: 'webhook creation requires an explicit review confirmation' };
  }
  if (oneTimeSecretAcknowledged !== true) {
    return { error: 'acknowledge that the returned HMAC key is one-time and must be copied now' };
  }
  if (!reviewedTenantBinding) {
    return { error: 'the reviewed Central tenant binding is missing; refresh the webhook list and review again' };
  }
  const createForm = webhookCreateForm(form);
  if (!createForm) return { error: 'authMechanism must be exactly API_KEY or OIDC' };
  const secrets = [createForm.apiKey, createForm.oidcClientSecret].filter(
    (value): value is string => typeof value === 'string' && value.length > 0,
  );
  return webhookSecretMutate(
    '/api/central/webhooks',
    { form: createForm, reviewConfirmed, oneTimeSecretAcknowledged, reviewedTenantBinding },
    'created',
    secrets,
  );
}

/** POST /api/central/webhooks/:id/rotate-hmac-key — reviewed
 * rotation with the same one-time-secret acknowledgement. */
export async function rotateCentralWebhookHmacKey(
  id: string,
  reviewConfirmed: boolean,
  oneTimeSecretAcknowledged: boolean,
  reviewedTenantBinding: string | null,
): Promise<ApiResult<WebhookOneTimeSecretResult>> {
  if (reviewConfirmed !== true) {
    return { error: 'HMAC rotation requires an explicit review confirmation' };
  }
  if (oneTimeSecretAcknowledged !== true) {
    return { error: 'acknowledge that the returned HMAC key is one-time and must be copied now' };
  }
  if (!reviewedTenantBinding) {
    return { error: 'the reviewed Central tenant binding is missing; refresh the webhook list and review again' };
  }
  return webhookSecretMutate(
    `/api/central/webhooks/${encodeURIComponent(id)}/rotate-hmac-key`,
    { reviewConfirmed, oneTimeSecretAcknowledged, reviewedTenantBinding },
    'rotated',
  );
}

/** DELETE /api/central/webhooks/:id — review-confirmed. */
export async function deleteCentralWebhook(id: string, reviewConfirmed: boolean): Promise<ApiResult<WebhookMutationResult>> {
  return webhookMutate(`/api/central/webhooks/${encodeURIComponent(id)}`, 'DELETE', { reviewConfirmed });
}

/**
 * True when a webhook mutation's failure means Central never confirmed the
 * outcome — a fetch-level exception (`offline`), or the server's own 502
 * "the outcome is unknown" answer for a transport failure it caught (see
 * CentralWebhooksError(502, ...) in server/src/services/centralWebhooks.ts)
 * — as opposed to a definite, known failure (400 validation, 409 not
 * linked/conflict, or an ok:false result). The caller must refetch/
 * reconcile the real state before trying again; retrying blindly risks
 * double-applying a mutation that may already have gone through.
 */
export function isUnknownWebhookOutcome(err: ApiError): boolean {
  return err.outcome === 'unknown' || err.offline === true || err.httpCode === 502;
}

/**
 * True when a PATCH's ok:false result reports a generation conflict — the
 * webhook changed since this operator's copy was loaded and reviewed.
 * Server-side enforcement of `expectedGeneration` is a follow-up outside
 * this client; this checks the httpCode:409 convention the client is ready
 * to interpret as soon as that lands, so the UI never silently overwrites a
 * change it never showed the operator.
 */
export function isWebhookGenerationConflict(result: WebhookMutationResult): boolean {
  return result.ok === false && result.httpCode === 409;
}
