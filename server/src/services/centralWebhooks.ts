/**
 * server/src/services/centralWebhooks.ts — New Central webhook management.
 *
 * The route-facing layer over CentralAdapter's generic `request()` transport
 * (the same structural transport writeBroker.ts's BrokerTransport and
 * ssidDirectWrite.ts's SsidWritePlane use) — resolves the linked adapter
 * from the registry, requires an explicit review confirmation instead of a
 * ticket (ssidDirectWrite.ts's own pattern; New Central's Webhooks API has
 * no ticket queue of its own), and records ONE audit-log line per mutation
 * (no payload, no secret) into the broker's own change-log.jsonl so the
 * Configure "Change history" drawer stays one place for every direct write
 * in the portal.
 *
 * Endpoints used — every one confirmed against the live OpenAPI definitions
 * on developer.arubanetworks.com/new-central/reference (see shared/
 * webhooks.ts's file header for the full list and doc links). This service
 * never constructs a path New Central does not document, and every id is
 * validated against isWebhookId() AND encodeURIComponent()'d before it is
 * placed on an outbound path segment.
 *
 * SECRETS: apiKey and oidcDetails.clientSecret never reach a portal response,
 * preview, log, or audit. Create/rotate first write an atomic 0600,
 * tenant-fingerprint-bound, secret-free handoff journal. Central's one-time
 * `items.hmacKey` is returned only after that journal durably transitions to
 * secret-issued-awaiting-handoff; it is never logged, audited, cached, queued,
 * or persisted. Full PUT replacement remains disabled.
 *
 * Central Classic does not expose this API (the docs' server list is New
 * Central regional gateways only); this service reuses
 * capabilities().directWrite as the "is this New Central" signal, exactly
 * the fact that capability already encodes (see CentralAdapter.
 * capabilities()'s own doc comment).
 */

import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import * as fs from 'node:fs';
import { isIP } from 'node:net';
import * as path from 'node:path';
import {
  canonicalizeWebhookCreateForm,
  canonicalWebhookCreateCandidate,
  isPrivateOrReservedHost,
  isWebhookId,
  matchesCanonicalWebhookCreateCandidate,
  WEBHOOKS_API_PATH,
  WEBHOOK_LIST_DEFAULT_LIMIT,
  WEBHOOK_LIST_MAX_LIMIT,
  type CanonicalWebhookCreateCandidate,
  type WebhookAuthMechanism,
  type WebhookDetail,
  type WebhookForm,
  type WebhookHandoffOperation,
  type WebhookHandoffResolutionResult,
  type WebhookHandoffState,
  type WebhookHandoffStatus,
  type WebhookListEnvelope,
  type WebhookMutationResult,
  type WebhookOneTimeSecretResult,
  type WebhookPatchForm,
  type WebhookSummary,
  WEBHOOKS_DEMO,
} from '../../../shared';
import type { PlaneCapabilities } from '../planes/types';
import { CentralAdapter, withScheme, type CentralHttpBodyParse } from '../planes/central';
import { PlaneRegistry, registry as defaultRegistry } from '../planes/registry';
import { appendBrokerLog, brokerDataDir } from './writeBroker';
import { effectiveSectionSource, settings } from '../config/settings';

export class CentralWebhooksError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'CentralWebhooksError';
  }
}

/** The Central-adapter surface this service actually needs — structural,
 *  not `instanceof CentralAdapter`, so tests can inject a plain stub without
 *  constructing a real CentralAdapter (token auth, HTTP, the lot). Mirrors
 *  writeBroker.ts's BrokerTransport / ssidDirectWrite.ts's SsidWritePlane. */
export interface CentralWebhooksTransport {
  request(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: unknown; bodyParse?: CentralHttpBodyParse }>;
  capabilities(): PlaneCapabilities;
}

export interface CentralWebhooksOptions {
  registry?: PlaneRegistry; // default: the process-wide singleton
  plane?: CentralWebhooksTransport | null; // test override — undefined resolves the CentralAdapter from the registry
  dataDir?: string; // default: HPE_DATA_DIR or <repo>/data
  nowMs?: () => number;
  effectiveDemoMode?: () => boolean; // default: Configure section override, then global demoMode
  /** Process-side test seam only. Request bodies cannot enable HTTP. */
  allowInsecureCallbackForTests?: boolean;
  /** Injected only by server tests; production uses dns.lookup(all:true). */
  resolveHostname?: WebhookHostnameResolver;
  /** Test seam; production fingerprints the active Central tenant settings. */
  tenantFingerprint?: () => string | null;
  /** Test seam for deterministic journal I/O failures. */
  handoffJournalStore?: WebhookHandoffJournalStore;
}

export interface WebhookResolvedAddress {
  address: string;
  family: number;
}

export type WebhookHostnameResolver = (hostname: string) => Promise<readonly WebhookResolvedAddress[]>;

export interface PersistedWebhookHandoff {
  version: 1;
  operationId: string;
  opType: 'create' | 'rotate';
  tenantFingerprint: string;
  state: WebhookHandoffState;
  candidate?: CanonicalWebhookCreateCandidate;
  webhookId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface WebhookHandoffJournalStore {
  load(): PersistedWebhookHandoff | null;
  save(journal: PersistedWebhookHandoff): void;
  delete(): void;
}

export const WEBHOOK_HANDOFF_JOURNAL_FILE = 'central-webhook-handoff.json';

const defaultResolveHostname: WebhookHostnameResolver = async (hostname) =>
  lookup(hostname, { all: true, verbatim: true });

function isCanonicalCandidate(value: unknown): value is CanonicalWebhookCreateCandidate {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const allowed =
    record.authMechanism === 'OIDC'
      ? new Set(['name', 'endpoint', 'authMechanism', 'oidcClientId', 'oidcWellKnownUrl'])
      : new Set(['name', 'endpoint', 'authMechanism']);
  if (Object.keys(record).some((key) => !allowed.has(key))) return false;
  if (
    typeof record.name !== 'string' ||
    !record.name ||
    record.name !== record.name.trim() ||
    typeof record.endpoint !== 'string' ||
    !record.endpoint ||
    record.endpoint !== record.endpoint.trim()
  ) {
    return false;
  }
  if (record.authMechanism === 'API_KEY') return true;
  return (
    record.authMechanism === 'OIDC' &&
    typeof record.oidcClientId === 'string' &&
    record.oidcClientId.length > 0 &&
    record.oidcClientId === record.oidcClientId.trim() &&
    typeof record.oidcWellKnownUrl === 'string' &&
    record.oidcWellKnownUrl.length > 0 &&
    record.oidcWellKnownUrl === record.oidcWellKnownUrl.trim()
  );
}

function parsePersistedHandoff(value: unknown): PersistedWebhookHandoff {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('journal envelope is invalid');
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set([
    'version',
    'operationId',
    'opType',
    'tenantFingerprint',
    'state',
    'candidate',
    'webhookId',
    'createdAt',
    'updatedAt',
  ]);
  if (Object.keys(record).some((key) => !allowed.has(key))) {
    throw new Error('journal contains an unrecognized field');
  }
  if (
    record.version !== 1 ||
    typeof record.operationId !== 'string' ||
    !isWebhookId(record.operationId) ||
    (record.opType !== 'create' && record.opType !== 'rotate') ||
    typeof record.tenantFingerprint !== 'string' ||
    !/^[a-f0-9]{64}$/.test(record.tenantFingerprint) ||
    !(
      record.state === 'in-flight' ||
      record.state === 'outcome-unknown' ||
      record.state === 'secret-issued-awaiting-handoff'
    ) ||
    typeof record.createdAt !== 'string' ||
    typeof record.updatedAt !== 'string'
  ) {
    throw new Error('journal fields are invalid');
  }
  if (
    (record.opType === 'create' &&
      (!isCanonicalCandidate(record.candidate) || record.webhookId !== undefined)) ||
    (record.opType === 'rotate' &&
      (!isWebhookId(record.webhookId) || record.candidate !== undefined))
  ) {
    throw new Error('journal operation identity is invalid');
  }
  return record as unknown as PersistedWebhookHandoff;
}

class AtomicWebhookHandoffJournalStore implements WebhookHandoffJournalStore {
  private readonly filePath: string;

  constructor(dataDir: string) {
    this.filePath = path.join(dataDir, WEBHOOK_HANDOFF_JOURNAL_FILE);
  }

  load(): PersistedWebhookHandoff | null {
    if (!fs.existsSync(this.filePath)) return null;
    fs.chmodSync(this.filePath, 0o600);
    return parsePersistedHandoff(JSON.parse(fs.readFileSync(this.filePath, 'utf8')));
  }

  save(journal: PersistedWebhookHandoff): void {
    const checked = parsePersistedHandoff(journal);
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tempPath = `${this.filePath}.${process.pid}.tmp`;
    let fd: number | null = null;
    try {
      fd = fs.openSync(tempPath, 'w', 0o600);
      fs.fchmodSync(fd, 0o600);
      fs.writeFileSync(fd, JSON.stringify(checked, null, 2) + '\n', 'utf8');
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = null;
      fs.renameSync(tempPath, this.filePath);
      fs.chmodSync(this.filePath, 0o600);
      const dirFd = fs.openSync(dir, 'r');
      try {
        fs.fsyncSync(dirFd);
      } finally {
        fs.closeSync(dirFd);
      }
    } finally {
      if (fd !== null) fs.closeSync(fd);
      try {
        fs.unlinkSync(tempPath);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
    }
  }

  delete(): void {
    try {
      fs.unlinkSync(this.filePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    const dir = path.dirname(this.filePath);
    const dirFd = fs.openSync(dir, 'r');
    try {
      fs.fsyncSync(dirFd);
    } finally {
      fs.closeSync(dirFd);
    }
  }
}

const webhookPatchLocks = new Map<string, Promise<void>>();

/**
 * Central's documented webhook PATCH does not provide a conditional request
 * header, so this closes the read/compare/write race only within this server
 * process. Multiple portal server processes still require provider-side
 * compare-and-swap support to prevent cross-process stale writes.
 */
async function withWebhookPatchLock<T>(id: string, operation: () => Promise<T>): Promise<T> {
  const previous = webhookPatchLocks.get(id) ?? Promise.resolve();
  let release = (): void => undefined;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  webhookPatchLocks.set(id, current);

  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (webhookPatchLocks.get(id) === current) webhookPatchLocks.delete(id);
  }
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function generation(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : undefined;
}

function clampLimit(raw: unknown): number {
  const n = Number(Array.isArray(raw) ? raw[0] : raw);
  if (!Number.isFinite(n) || n < 1) return WEBHOOK_LIST_DEFAULT_LIMIT;
  return Math.min(WEBHOOK_LIST_MAX_LIMIT, Math.trunc(n));
}

function clampOffset(raw: unknown): number {
  const n = Number(Array.isArray(raw) ? raw[0] : raw);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.trunc(n);
}

/** Central's own {httpStatusCode, errorCode, message, debugId} error shape.
 * Only the bounded errorCode is surfaced: a provider-supplied message might
 * echo submitted credentials. */
function centralErrorSuffix(body: unknown): string {
  if (!body || typeof body !== 'object') return '';
  const r = body as Record<string, unknown>;
  const errorCode = str(r.errorCode);
  if (errorCode && /^[A-Za-z0-9_.:-]{1,128}$/.test(errorCode)) return ` — ${errorCode}`;
  return '';
}

/** GET /network-services/v1/webhooks list-row shape only — no secret-
 *  configured flags, because the list endpoint does not report them. */
function parseWebhookSummary(raw: unknown): WebhookSummary | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const id = str(r.id);
  const name = str(r.name);
  const endpoint = str(r.endpoint);
  const authMechanism = r.authMechanism === 'API_KEY' || r.authMechanism === 'OIDC' ? r.authMechanism : undefined;
  const createdAt = str(r.createdAt);
  const parsedGeneration = generation(r.generation);
  if (!id || !name || !endpoint || !authMechanism || !createdAt || parsedGeneration === undefined) return null;
  return {
    id,
    name,
    endpoint,
    authMechanism,
    generation: parsedGeneration,
    createdAt,
    updatedAt: str(r.updatedAt) ?? null,
  };
}

/**
 * GET /network-services/v1/webhooks/{id} single-detail shape. Central's own
 * schema for this endpoint echoes `apiKey` / `oidcDetails.clientSecret`
 * back in cleartext (getwebhookv1.md) — both are read here ONLY to compute
 * a boolean "configured" flag and are never assigned anywhere else, so they
 * never escape this function.
 */
function parseWebhookDetail(raw: unknown): WebhookDetail | null {
  const summary = parseWebhookSummary(raw);
  if (!summary) return null;
  const r = raw as Record<string, unknown>;
  if (summary.authMechanism === 'API_KEY') {
    const apiKey = r.apiKey; // read once, for a length check only — never stored
    return {
      ...summary,
      apiKeyConfigured: typeof apiKey === 'string' && apiKey.length > 0,
      oidcClientSecretConfigured: false,
    };
  }
  const oidc = r.oidcDetails && typeof r.oidcDetails === 'object' ? (r.oidcDetails as Record<string, unknown>) : {};
  const clientSecret = oidc.clientSecret; // read once, for a length check only — never stored
  return {
    ...summary,
    apiKeyConfigured: false,
    oidcClientId: str(oidc.clientId),
    oidcWellKnownUrl: str(oidc.wellKnownUrl),
    oidcClientSecretConfigured: typeof clientSecret === 'string' && clientSecret.length > 0,
  };
}

/** Build the wire body for PATCH (patchWebhookV1) — either the "Payload"
 *  variant (name/endpoint only, no auth fields) or the "Authentication
 *  Update" variant (authMechanism + its matching secret, name/endpoint
 *  optional) — the two shapes the docs allow; never a mix of both. */
function wirePatchBody(partial: WebhookPatchForm): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  if (partial.name !== undefined) input.name = partial.name.trim();
  if (partial.endpoint !== undefined) input.endpoint = partial.endpoint.trim();
  if (partial.authMechanism === 'API_KEY') {
    input.authMechanism = 'API_KEY';
    input.apiKey = partial.apiKey;
  } else if (partial.authMechanism === 'OIDC') {
    input.authMechanism = 'OIDC';
    input.oidcDetails = {
      clientId: partial.oidcClientId,
      clientSecret: partial.oidcClientSecret,
      wellKnownUrl: partial.oidcWellKnownUrl,
    };
  }
  return { input };
}

function asWebhookCreateForm(raw: unknown): WebhookForm {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new CentralWebhooksError(400, 'form must be an object');
  }
  const rec = raw as Record<string, unknown>;
  if (rec.authMechanism !== 'API_KEY' && rec.authMechanism !== 'OIDC') {
    throw new CentralWebhooksError(400, 'authMechanism must be exactly API_KEY or OIDC');
  }
  const allowed =
    rec.authMechanism === 'API_KEY'
      ? new Set(['name', 'endpoint', 'authMechanism', 'apiKey'])
      : new Set(['name', 'endpoint', 'authMechanism', 'oidcClientId', 'oidcClientSecret', 'oidcWellKnownUrl']);
  for (const key of Object.keys(rec)) {
    if (!allowed.has(key)) {
      throw new CentralWebhooksError(400, `field '${key}' is not allowed for ${rec.authMechanism} webhook creation`);
    }
  }
  if (typeof rec.name !== 'string' || !rec.name.trim()) {
    throw new CentralWebhooksError(400, 'name is required');
  }
  if (rec.name.trim().length > 64) {
    throw new CentralWebhooksError(400, 'name must be 64 characters or fewer');
  }
  if (typeof rec.endpoint !== 'string') {
    throw new CentralWebhooksError(400, 'endpoint must be a string');
  }
  if (rec.authMechanism === 'API_KEY') {
    if (typeof rec.apiKey !== 'string' || !rec.apiKey.trim()) {
      throw new CentralWebhooksError(400, 'a non-empty apiKey is required with authMechanism API_KEY');
    }
    if (rec.apiKey.length > 1024) {
      throw new CentralWebhooksError(400, 'API key must be 1024 characters or fewer');
    }
    return canonicalizeWebhookCreateForm({
      name: rec.name,
      endpoint: rec.endpoint,
      authMechanism: 'API_KEY',
      apiKey: rec.apiKey,
    });
  }
  if (typeof rec.oidcClientId !== 'string' || !rec.oidcClientId.trim()) {
    throw new CentralWebhooksError(400, 'a non-empty oidcClientId is required with authMechanism OIDC');
  }
  if (typeof rec.oidcClientSecret !== 'string' || !rec.oidcClientSecret.trim()) {
    throw new CentralWebhooksError(400, 'a non-empty oidcClientSecret is required with authMechanism OIDC');
  }
  if (typeof rec.oidcWellKnownUrl !== 'string' || !rec.oidcWellKnownUrl.trim()) {
    throw new CentralWebhooksError(400, 'a non-empty oidcWellKnownUrl is required with authMechanism OIDC');
  }
  if (rec.oidcClientId.length > 512) {
    throw new CentralWebhooksError(400, 'OIDC client ID must be 512 characters or fewer');
  }
  if (rec.oidcClientSecret.length > 512) {
    throw new CentralWebhooksError(400, 'OIDC client secret must be 512 characters or fewer');
  }
  if (rec.oidcWellKnownUrl.length > 512) {
    throw new CentralWebhooksError(400, 'OIDC well-known URL must be 512 characters or fewer');
  }
  return canonicalizeWebhookCreateForm({
    name: rec.name,
    endpoint: rec.endpoint,
    authMechanism: 'OIDC',
    oidcClientId: rec.oidcClientId,
    oidcClientSecret: rec.oidcClientSecret,
    oidcWellKnownUrl: rec.oidcWellKnownUrl,
  });
}

function wireCreateBody(form: WebhookForm): Record<string, unknown> {
  const input: Record<string, unknown> = {
    name: form.name,
    endpoint: form.endpoint,
    authMechanism: form.authMechanism,
  };
  if (form.authMechanism === 'API_KEY') {
    input.apiKey = form.apiKey;
  } else {
    input.oidcDetails = {
      clientId: form.oidcClientId,
      clientSecret: form.oidcClientSecret,
      wellKnownUrl: form.oidcWellKnownUrl,
    };
  }
  return { input };
}

type DocumentedMutationEnvelope =
  | { kind: 'success'; items: Record<string, unknown> }
  | { kind: 'failure'; items: Record<string, unknown> }
  | { kind: 'malformed' };

function documentedMutationEnvelope(body: unknown): DocumentedMutationEnvelope {
  try {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return { kind: 'malformed' };
    const items = (body as Record<string, unknown>).items;
    if (!items || typeof items !== 'object' || Array.isArray(items)) return { kind: 'malformed' };
    const record = items as Record<string, unknown>;
    if (record.success === true) return { kind: 'success', items: record };
    if (record.success === false) return { kind: 'failure', items: record };
  } catch {
    return { kind: 'malformed' };
  }
  return { kind: 'malformed' };
}

function safeProviderFailureDetail(
  body: unknown,
  secrets: readonly string[],
): string {
  const envelope = documentedMutationEnvelope(body);
  if (envelope.kind !== 'failure') return '';
  const code =
    typeof envelope.items.errorCode === 'string' &&
    /^[A-Za-z0-9_.:-]{1,128}$/.test(envelope.items.errorCode)
      ? envelope.items.errorCode
      : typeof envelope.items.code === 'string' &&
          /^[A-Za-z0-9_.:-]{1,128}$/.test(envelope.items.code)
        ? envelope.items.code
        : null;
  const rawMessage =
    typeof envelope.items.message === 'string' ? envelope.items.message : null;
  const providerSecrets = [
    envelope.items.hmacKey,
    envelope.items.apiKey,
    envelope.items.clientSecret,
  ].filter((value): value is string => typeof value === 'string' && value.length > 0);
  const redacted = [...secrets, ...providerSecrets].reduce(
    (safe, secret) => (secret ? safe.split(secret).join('[redacted]') : safe),
    rawMessage ?? '',
  );
  const message = redacted.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 256);
  if (code && message) return ` — ${code}: ${message}`;
  if (code) return ` — ${code}`;
  return message ? ` — ${message}` : '';
}

function oneTimeHmacResult(
  body: unknown,
  action: 'created' | 'rotated',
  operationId: string,
  callbackValidatedAt?: string,
): WebhookOneTimeSecretResult | null {
  try {
    const envelope = documentedMutationEnvelope(body);
    if (envelope.kind !== 'success') return null;
    const record = envelope.items;
    if (typeof record.hmacKey !== 'string' || record.hmacKey.trim().length === 0) return null;
    return {
      ok: true,
      action,
      operationId,
      hmacKey: record.hmacKey,
      message:
        action === 'created'
          ? 'webhook created — copy the one-time HMAC key now'
          : 'webhook HMAC key rotated — copy the one-time key now',
      ...(callbackValidatedAt ? { callbackValidatedAt } : {}),
    };
  } catch {
    return null;
  }
}

/** Strictly parse one of the two documented PATCH variants. No field is
 * silently ignored: unknown fields, unknown mechanisms, and credentials
 * that do not exactly match their mechanism are request errors. Auth PATCH
 * is permitted because its documented response does not return or rotate an
 * HMAC key; credential values remain input-only and never enter audit data. */
function asWebhookPatchForm(raw: unknown): WebhookPatchForm {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new CentralWebhooksError(400, 'form must be an object');
  }
  const rec = raw as Record<string, unknown>;
  if (
    rec.authMechanism !== undefined &&
    rec.authMechanism !== 'API_KEY' &&
    rec.authMechanism !== 'OIDC'
  ) {
    throw new CentralWebhooksError(400, 'authMechanism must be exactly API_KEY or OIDC');
  }
  const authMechanism = rec.authMechanism as WebhookAuthMechanism | undefined;
  const common = ['expectedGeneration', 'name', 'endpoint'];
  const allowed =
    authMechanism === 'API_KEY'
      ? new Set([...common, 'authMechanism', 'apiKey'])
      : authMechanism === 'OIDC'
        ? new Set([...common, 'authMechanism', 'oidcClientId', 'oidcClientSecret', 'oidcWellKnownUrl'])
        : new Set(common);
  for (const key of Object.keys(rec)) {
    if (!allowed.has(key)) {
      throw new CentralWebhooksError(
        400,
        `field '${key}' is not allowed for ${authMechanism ?? 'a non-authentication'} webhook PATCH`,
      );
    }
  }

  const expectedGeneration = generation(rec.expectedGeneration);
  if (expectedGeneration === undefined) {
    throw new CentralWebhooksError(400, 'expectedGeneration must be a non-negative safe integer');
  }
  const partial: WebhookPatchForm = { expectedGeneration };
  if (rec.name !== undefined) {
    if (typeof rec.name !== 'string') throw new CentralWebhooksError(400, 'name must be a string');
    const name = rec.name.trim();
    if (!name) throw new CentralWebhooksError(400, 'name is required when supplied');
    if (name.length > 64) throw new CentralWebhooksError(400, 'name must be 64 characters or fewer');
    partial.name = rec.name;
  }
  if (rec.endpoint !== undefined) {
    if (typeof rec.endpoint !== 'string') throw new CentralWebhooksError(400, 'endpoint must be a string');
    partial.endpoint = rec.endpoint;
  }
  if (!authMechanism && partial.name === undefined && partial.endpoint === undefined) {
    throw new CentralWebhooksError(400, 'at least one reviewed PATCH field is required');
  }

  if (authMechanism === 'API_KEY') {
    if (typeof rec.apiKey !== 'string' || !rec.apiKey.trim()) {
      throw new CentralWebhooksError(400, 'a non-empty apiKey is required with authMechanism API_KEY');
    }
    if (rec.apiKey.length > 1024) throw new CentralWebhooksError(400, 'API key must be 1024 characters or fewer');
    partial.authMechanism = authMechanism;
    partial.apiKey = rec.apiKey;
  } else if (authMechanism === 'OIDC') {
    if (typeof rec.oidcClientId !== 'string' || !rec.oidcClientId.trim()) {
      throw new CentralWebhooksError(400, 'a non-empty oidcClientId is required with authMechanism OIDC');
    }
    if (typeof rec.oidcClientSecret !== 'string' || !rec.oidcClientSecret.trim()) {
      throw new CentralWebhooksError(400, 'a non-empty oidcClientSecret is required with authMechanism OIDC');
    }
    if (typeof rec.oidcWellKnownUrl !== 'string' || !rec.oidcWellKnownUrl.trim()) {
      throw new CentralWebhooksError(400, 'a non-empty oidcWellKnownUrl is required with authMechanism OIDC');
    }
    if (rec.oidcClientId.length > 512) throw new CentralWebhooksError(400, 'OIDC client ID must be 512 characters or fewer');
    if (rec.oidcClientSecret.length > 512) {
      throw new CentralWebhooksError(400, 'OIDC client secret must be 512 characters or fewer');
    }
    if (rec.oidcWellKnownUrl.length > 512) {
      throw new CentralWebhooksError(400, 'OIDC well-known URL must be 512 characters or fewer');
    }
    partial.authMechanism = authMechanism;
    partial.oidcClientId = rec.oidcClientId;
    partial.oidcClientSecret = rec.oidcClientSecret;
    partial.oidcWellKnownUrl = rec.oidcWellKnownUrl;
  }
  return partial;
}

function rawUrlHostname(raw: string): string | null {
  const match = raw.match(/^[A-Za-z][A-Za-z0-9+.-]*:\/\/([^/?#]+)/);
  if (!match || match[1].includes('@')) return null;
  const authority = match[1];
  if (authority.startsWith('[')) {
    const close = authority.indexOf(']');
    return close > 0 ? authority.slice(1, close) : null;
  }
  const colon = authority.lastIndexOf(':');
  return colon >= 0 ? authority.slice(0, colon) : authority;
}

function hashTenantIdentity(parts: Record<string, string>): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

export class CentralWebhooksService {
  private readonly registry: PlaneRegistry;
  private readonly planeOverride: CentralWebhooksTransport | null | undefined;
  private readonly dataDir: string;
  private readonly nowMs: () => number;
  private readonly effectiveDemoMode: () => boolean;
  private readonly allowInsecureCallbackForTests: boolean;
  private readonly resolveHostname: WebhookHostnameResolver;
  private readonly tenantFingerprint: () => string | null;
  private readonly reviewBindingSecret = randomBytes(32);
  private readonly handoffJournal: WebhookHandoffJournalStore;
  private handoffTail: Promise<void> = Promise.resolve();

  constructor(opts: CentralWebhooksOptions = {}) {
    this.registry = opts.registry ?? defaultRegistry;
    this.planeOverride = opts.plane;
    this.dataDir = opts.dataDir ?? brokerDataDir();
    this.nowMs = opts.nowMs ?? (() => Date.now());
    this.effectiveDemoMode =
      opts.effectiveDemoMode ?? (() => effectiveSectionSource(settings.get(), 'configure') === 'demo');
    this.allowInsecureCallbackForTests =
      process.env.NODE_ENV === 'test' && opts.allowInsecureCallbackForTests === true;
    this.resolveHostname = opts.resolveHostname ?? defaultResolveHostname;
    this.tenantFingerprint =
      opts.tenantFingerprint ??
      (() => {
        const creds = settings.get().planes.central;
        if (creds?.gatewayBaseUrl && creds.clientId && creds.clientSecret) {
          return hashTenantIdentity({
            gatewayBaseUrl: withScheme(creds.gatewayBaseUrl.trim()).replace(/\/+$/, ''),
            clientId: creds.clientId.trim(),
            clientSecret: creds.clientSecret,
          });
        }
        return this.planeOverride !== undefined
          ? hashTenantIdentity({ testPlaneOverride: 'central-webhooks' })
          : null;
      });
    this.handoffJournal =
      opts.handoffJournalStore ?? new AtomicWebhookHandoffJournalStore(this.dataDir);
  }

  private async withHandoffLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.handoffTail;
    let release = (): void => undefined;
    this.handoffTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private loadHandoff(): PersistedWebhookHandoff | null {
    try {
      return this.handoffJournal.load();
    } catch {
      throw new CentralWebhooksError(
        503,
        'the webhook handoff journal could not be read safely; create, rotation, and Central credential changes are blocked',
      );
    }
  }

  private saveHandoff(journal: PersistedWebhookHandoff, preflight = false): void {
    try {
      this.handoffJournal.save(journal);
    } catch {
      throw new CentralWebhooksError(
        503,
        preflight
          ? 'the webhook handoff journal could not be saved safely; no Central request was issued'
          : 'the webhook handoff journal could not be saved safely; the operation remains blocked for manual reconciliation',
      );
    }
  }

  private deleteHandoff(): void {
    try {
      this.handoffJournal.delete();
    } catch {
      throw new CentralWebhooksError(
        503,
        'the webhook handoff journal could not be cleared safely; create, rotation, and Central credential changes remain blocked',
      );
    }
  }

  private currentFingerprint(): string {
    const fingerprint = this.tenantFingerprint();
    if (!fingerprint || !/^[a-f0-9]{64}$/.test(fingerprint)) {
      throw new CentralWebhooksError(
        409,
        'Central tenant credentials are incomplete; webhook handoff identity cannot be verified',
      );
    }
    return fingerprint;
  }

  private currentReviewBinding(): string {
    return this.reviewBinding(this.currentFingerprint());
  }

  private reviewBinding(fingerprint: string): string {
    return createHmac('sha256', this.reviewBindingSecret)
      .update(fingerprint)
      .digest('hex');
  }

  private requireReviewedTenantBinding(raw: unknown): string {
    const binding = typeof raw === 'string' && /^[a-f0-9]{64}$/.test(raw) ? raw : null;
    const current = this.currentReviewBinding();
    if (
      !binding ||
      !timingSafeEqual(Buffer.from(binding, 'hex'), Buffer.from(current, 'hex'))
    ) {
      throw new CentralWebhooksError(
        409,
        'the Central tenant changed after this webhook review; refresh the list and review the operation again',
      );
    }
    return binding;
  }

  private requireMatchingFingerprint(journal: PersistedWebhookHandoff): void {
    if (journal.tenantFingerprint !== this.currentFingerprint()) {
      throw new CentralWebhooksError(
        409,
        'the active Central credentials do not match the pending webhook handoff tenant; restore the original credentials before reconciliation',
      );
    }
  }

  private beginHandoff(
    opType: 'create' | 'rotate',
    identity: { candidate: CanonicalWebhookCreateCandidate } | { webhookId: string },
  ): PersistedWebhookHandoff {
    const existing = this.loadHandoff();
    if (existing) {
      throw new CentralWebhooksError(
        409,
        `webhook create/rotation is blocked by pending handoff operation '${existing.operationId}'`,
      );
    }
    const now = new Date(this.nowMs()).toISOString();
    const journal: PersistedWebhookHandoff = {
      version: 1,
      operationId: randomUUID(),
      opType,
      tenantFingerprint: this.currentFingerprint(),
      state: 'in-flight',
      ...identity,
      createdAt: now,
      updatedAt: now,
    };
    this.saveHandoff(journal, true);
    return journal;
  }

  private transitionHandoff(
    journal: PersistedWebhookHandoff,
    state: WebhookHandoffState,
  ): PersistedWebhookHandoff {
    const next = {
      ...journal,
      state,
      updatedAt: new Date(this.nowMs()).toISOString(),
    };
    this.saveHandoff(next);
    return next;
  }

  private retainUnknownHandoff(journal: PersistedWebhookHandoff): void {
    try {
      this.transitionHandoff(journal, 'outcome-unknown');
    } catch {
      // The already-durable in-flight journal remains a fail-closed block.
    }
  }

  private handoffStatus(journal: PersistedWebhookHandoff): WebhookHandoffOperation {
    let fingerprintMatches = false;
    try {
      fingerprintMatches = journal.tenantFingerprint === this.currentFingerprint();
    } catch {
      fingerprintMatches = false;
    }
    return {
      operationId: journal.operationId,
      opType: journal.opType,
      state: journal.state,
      ...(journal.candidate ? { candidate: journal.candidate } : {}),
      ...(journal.webhookId ? { webhookId: journal.webhookId } : {}),
      createdAt: journal.createdAt,
      updatedAt: journal.updatedAt,
      fingerprintMatches,
    };
  }

  async getPendingHandoff(): Promise<WebhookHandoffStatus> {
    return this.withHandoffLock(async () => {
      const journal = this.loadHandoff();
      return journal
        ? { pending: true, operation: this.handoffStatus(journal) }
        : { pending: false };
    });
  }

  assertCentralCredentialsMutable(): void {
    const journal = this.loadHandoff();
    if (journal) {
      throw new CentralWebhooksError(
        409,
        `Central credentials and gateway base URL cannot change while webhook handoff operation '${journal.operationId}' is pending`,
      );
    }
  }

  async acknowledgeHandoff(
    operationIdRaw: unknown,
    secretStoredRaw: unknown,
  ): Promise<WebhookHandoffResolutionResult> {
    return this.withHandoffLock(async () => {
      if (secretStoredRaw !== true) {
        throw new CentralWebhooksError(400, 'secretStored must be exactly true');
      }
      const operationId = this.requireId(operationIdRaw);
      const journal = this.loadHandoff();
      if (!journal || journal.operationId !== operationId) {
        throw new CentralWebhooksError(409, 'the pending webhook handoff operation does not match');
      }
      this.requireMatchingFingerprint(journal);
      if (journal.state !== 'secret-issued-awaiting-handoff') {
        throw new CentralWebhooksError(
          409,
          'the one-time secret was not confirmed as issued; use manual reconciliation instead',
        );
      }
      this.deleteHandoff();
      return {
        ok: true,
        operationId,
        resolution: 'secret-stored',
        message: 'one-time HMAC key storage acknowledged; handoff journal cleared',
      };
    });
  }

  async resolveHandoff(
    operationIdRaw: unknown,
    resolutionRaw: unknown,
    reviewConfirmedRaw: unknown,
    attestationsRaw: unknown,
    matchedWebhookIdRaw?: unknown,
  ): Promise<WebhookHandoffResolutionResult> {
    return this.withHandoffLock(async () => {
      this.requireReview(reviewConfirmedRaw);
      const operationId = this.requireId(operationIdRaw);
      const journal = this.loadHandoff();
      if (!journal || journal.operationId !== operationId) {
        throw new CentralWebhooksError(409, 'the pending webhook handoff operation does not match');
      }
      this.requireMatchingFingerprint(journal);
      const attestations =
        attestationsRaw && typeof attestationsRaw === 'object' && !Array.isArray(attestationsRaw)
          ? (attestationsRaw as Record<string, unknown>)
          : {};

      if (journal.opType === 'create' && resolutionRaw === 'create-located') {
        if (attestations.candidateLocated !== true) {
          throw new CentralWebhooksError(400, 'candidateLocated must be exactly true');
        }
        const matchedWebhookId = this.requireId(matchedWebhookIdRaw);
        const adapter = this.adapter();
        if (!adapter || !this.supportsWebhooks(adapter)) {
          throw new CentralWebhooksError(409, 'Central must be linked to verify the located webhook');
        }
        const detail = await this.getLive(adapter, matchedWebhookId);
        if (
          !journal.candidate ||
          !matchesCanonicalWebhookCreateCandidate(detail, journal.candidate)
        ) {
          throw new CentralWebhooksError(
            409,
            'the located webhook does not match the canonical pending create candidate',
          );
        }
        this.deleteHandoff();
        return {
          ok: true,
          operationId,
          resolution: 'create-located',
          webhookId: matchedWebhookId,
          message: 'created webhook located; review a replacement HMAC rotation before issuing a new key',
        };
      }

      if (journal.opType === 'create' && resolutionRaw === 'create-absent') {
        if (
          attestations.candidateAbsent !== true ||
          attestations.eventualConsistencyRiskAccepted !== true
        ) {
          throw new CentralWebhooksError(
            400,
            'candidateAbsent and eventualConsistencyRiskAccepted must be exactly true',
          );
        }
        this.deleteHandoff();
        return {
          ok: true,
          operationId,
          resolution: 'create-absent',
          message: 'create absence attested; handoff journal cleared for a newly reviewed operation',
        };
      }

      if (journal.opType === 'rotate' && resolutionRaw === 'rotate-reconciled') {
        if (
          attestations.receiverReconciled !== true ||
          attestations.centralReconciled !== true
        ) {
          throw new CentralWebhooksError(
            400,
            'receiverReconciled and centralReconciled must be exactly true',
          );
        }
        this.deleteHandoff();
        return {
          ok: true,
          operationId,
          resolution: 'rotate-reconciled',
          webhookId: journal.webhookId,
          message: 'rotation reconciliation attested; handoff journal cleared for a newly reviewed rotation',
        };
      }

      throw new CentralWebhooksError(
        400,
        'the requested handoff resolution does not match the pending operation',
      );
    });
  }

  private adapter(): CentralWebhooksTransport | null {
    if (this.planeOverride !== undefined) return this.planeOverride;
    const a = this.registry.get('central');
    return a instanceof CentralAdapter ? a : null;
  }

  /** Display-only base URL for the review UI's "target URL" line — read
   *  straight from settings (never masked: gatewayBaseUrl is not secret-
   *  shaped), not from the adapter (whose baseUrl field is private). Absent
   *  when Central has no complete credentials saved. */
  private gatewayBaseUrlForDisplay(): string | null {
    const creds = settings.get().planes.central;
    const raw = creds?.gatewayBaseUrl?.trim();
    return raw ? withScheme(raw).replace(/\/+$/, '') : null;
  }

  private requireReview(reviewConfirmedRaw: unknown): void {
    if (reviewConfirmedRaw !== true) {
      throw new CentralWebhooksError(400, 'webhook writes require an explicit review confirmation');
    }
  }

  private requireOneTimeSecretAcknowledgement(acknowledgedRaw: unknown): void {
    if (acknowledgedRaw !== true) {
      throw new CentralWebhooksError(
        400,
        'confirm that the returned HMAC key is one-time and must be copied immediately',
      );
    }
  }

  private requireId(idRaw: unknown): string {
    if (typeof idRaw !== 'string' || !isWebhookId(idRaw)) {
      throw new CentralWebhooksError(400, 'a valid webhook id is required');
    }
    return idRaw;
  }

  /** True when the linked Central plane is New Central (the only gateway
   *  generation the Webhooks API exists on) — reusing capabilities().
   *  directWrite, which already encodes exactly this fact for this adapter. */
  private supportsWebhooks(adapter: CentralWebhooksTransport): boolean {
    return adapter.capabilities().directWrite === true;
  }

  /** Point-in-time server-boundary validation only. Central remains the
   * callback caller, and DNS may change after this check, so this is not
   * described or treated as SSRF-proof. */
  private async validateCallbackEndpoint(endpoint: string): Promise<string> {
    const value = endpoint.trim();
    if (!value || /[\u0000-\u001f\u007f\s]/.test(value)) {
      throw new CentralWebhooksError(400, 'endpoint must be a valid absolute URL without whitespace');
    }
    const rawHostname = rawUrlHostname(value);
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      throw new CentralWebhooksError(400, 'endpoint must be a valid absolute URL');
    }
    if (!rawHostname || parsed.username || parsed.password || parsed.hash) {
      throw new CentralWebhooksError(400, 'endpoint must not contain credentials, a fragment, or ambiguous authority syntax');
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new CentralWebhooksError(400, 'endpoint must use http or https');
    }
    if (parsed.protocol !== 'https:' && !this.allowInsecureCallbackForTests) {
      throw new CentralWebhooksError(400, 'endpoint must use HTTPS');
    }
    const hostname =
      parsed.hostname.startsWith('[') && parsed.hostname.endsWith(']')
        ? parsed.hostname.slice(1, -1)
        : parsed.hostname;
    if (rawHostname.includes('%')) {
      throw new CentralWebhooksError(400, 'endpoint IPv6 zone identifiers are not allowed');
    }
    if (rawHostname.endsWith('.') || hostname.endsWith('.')) {
      throw new CentralWebhooksError(400, 'endpoint hostnames with a trailing dot are not allowed');
    }
    const literalFamily = isIP(hostname);
    if (literalFamily === 4 && rawHostname !== hostname) {
      throw new CentralWebhooksError(400, 'endpoint IPv4 literals must use canonical dotted-decimal notation');
    }
    if (isPrivateOrReservedHost(hostname)) {
      throw new CentralWebhooksError(400, 'endpoint may not target a private, loopback, link-local, or reserved address');
    }
    if (literalFamily === 0) {
      let addresses: readonly WebhookResolvedAddress[];
      try {
        addresses = await this.resolveHostname(hostname);
      } catch {
        throw new CentralWebhooksError(400, 'endpoint hostname could not be resolved for public-address validation');
      }
      if (addresses.length === 0) {
        throw new CentralWebhooksError(400, 'endpoint hostname resolved to no addresses');
      }
      if (
        addresses.some(
          ({ address }) => isIP(address) === 0 || isPrivateOrReservedHost(address),
        )
      ) {
        throw new CentralWebhooksError(
          400,
          'endpoint hostname resolved to a private, loopback, link-local, reserved, or invalid address',
        );
      }
    }
    return new Date(this.nowMs()).toISOString();
  }

  private log(event: string, result: WebhookMutationResult): void {
    appendBrokerLog(this.dataDir, {
      ts: new Date(this.nowMs()).toISOString(),
      event,
      changeId: `direct-webhook-${randomUUID()}`,
      ticket: '(none — direct apply, review-confirmed)',
      kind: 'webhook',
      result:
        result.action === 'conflict' || result.action === 'unsupported' || result.action === 'unknown'
          ? result.action
          : result.ok
            ? result.action
            : 'failed',
      ...(result.httpCode !== undefined ? { httpCode: result.httpCode } : {}),
      ...(result.callbackValidatedAt ? { callbackValidatedAt: result.callbackValidatedAt } : {}),
    });
  }

  private unsupported(event: string, operation: string): WebhookMutationResult {
    const result: WebhookMutationResult = {
      ok: false,
      action: 'unsupported',
      httpCode: 501,
      message: `${operation} is disabled`,
    };
    this.log(event, result);
    return result;
  }

  /** Central's response never arrived (timeout/transport fault) — the
   *  outcome on Central is unknown, audited distinctly from a structured
   *  'failed' result (never fabricated as one), matching ssidDirectWrite.ts's
   *  logTransportFailure(). */
  private logTransportFailure(event: string, callbackValidatedAt?: string): void {
    appendBrokerLog(this.dataDir, {
      ts: new Date(this.nowMs()).toISOString(),
      event,
      changeId: `direct-webhook-${randomUUID()}`,
      ticket: '(none — direct apply, review-confirmed)',
      kind: 'webhook',
      result: 'error (transport failure — outcome unknown)',
      ...(callbackValidatedAt ? { callbackValidatedAt } : {}),
    });
  }

  // -- reads ----------------------------------------------------------------

  async list(limitRaw: unknown, offsetRaw: unknown, queryRaw: unknown): Promise<WebhookListEnvelope> {
    const limit = clampLimit(limitRaw);
    const offset = clampOffset(offsetRaw);
    const q = typeof queryRaw === 'string' ? queryRaw.trim().toLowerCase() : '';
    const gatewayBaseUrl = this.gatewayBaseUrlForDisplay();
    let tenantFingerprint: string | null = null;
    let tenantBinding: string | null = null;
    try {
      tenantFingerprint = this.currentFingerprint();
      tenantBinding = this.reviewBinding(tenantFingerprint);
    } catch {
      tenantFingerprint = null;
      tenantBinding = null;
    }
    const filterAndPage = (items: WebhookSummary[], source: string, note?: string): WebhookListEnvelope => {
      const filtered = q
        ? items.filter((w) => w.name.toLowerCase().includes(q) || w.endpoint.toLowerCase().includes(q))
        : items;
      const page = filtered.slice(offset, offset + limit);
      return {
        items: page,
        totalCount: filtered.length,
        count: page.length,
        limit,
        offset,
        hasMore: offset + page.length < filtered.length,
        source,
        ...(note ? { note } : {}),
        gatewayBaseUrl,
        tenantBinding,
      };
    };
    const emptyResult = (error: string, bindable = true): WebhookListEnvelope => ({
      items: [],
      totalCount: 0,
      count: 0,
      limit,
      offset,
      hasMore: false,
      source: 'unavailable',
      error,
      gatewayBaseUrl,
      tenantBinding: bindable ? tenantBinding : null,
    });

    if (this.effectiveDemoMode()) {
      return filterAndPage(WEBHOOKS_DEMO, 'demo fixture');
    }
    const adapter = this.adapter();
    if (!adapter) return emptyResult('Central is not linked');
    if (!this.supportsWebhooks(adapter)) {
      return emptyResult('Central Classic — webhook management requires the New Central gateway');
    }
    let res: { status: number; body: unknown; bodyParse?: CentralHttpBodyParse };
    try {
      res = await adapter.request('GET', WEBHOOKS_API_PATH);
    } catch {
      return emptyResult('central did not answer while listing webhooks; the outcome is unknown');
    }
    try {
      if (!tenantFingerprint || this.currentFingerprint() !== tenantFingerprint) {
        return emptyResult(
          'Central credentials changed while listing webhooks; refresh before reviewing any operation',
          false,
        );
      }
    } catch {
      return emptyResult(
        'Central credentials changed while listing webhooks; refresh before reviewing any operation',
        false,
      );
    }
    if (res.status === 401 || res.status === 403) {
      return emptyResult(`central denied the request listing webhooks (HTTP ${res.status})${centralErrorSuffix(res.body)}`);
    }
    if (res.status < 200 || res.status >= 300) {
      return emptyResult(`central answered HTTP ${res.status} listing webhooks${centralErrorSuffix(res.body)}`);
    }
    if (
      res.status === 200 &&
      (res.bodyParse === 'empty' || res.bodyParse === 'whitespace' || res.bodyParse === 'json-null')
    ) {
      const note =
        res.bodyParse === 'empty'
          ? 'Central returned no webhook rows (HTTP 200 empty response body).'
          : res.bodyParse === 'whitespace'
            ? 'Central returned no webhook rows (HTTP 200 whitespace-only response body).'
            : 'Central returned no webhook rows (HTTP 200 JSON null response).';
      return filterAndPage([], 'central live', note);
    }
    if (res.bodyParse === 'malformed-json') {
      return emptyResult('central answered successfully with malformed JSON while listing webhooks');
    }
    if (res.bodyParse === 'non-json') {
      return emptyResult('central answered successfully with a non-JSON response while listing webhooks');
    }
    if (res.bodyParse === 'unreadable') {
      return emptyResult('central answered successfully but its webhook list response body could not be read');
    }
    const body = res.body && typeof res.body === 'object' ? (res.body as Record<string, unknown>) : null;
    const rawItems = body && Array.isArray(body.items) ? body.items : null;
    if (!rawItems) {
      return emptyResult('central answered successfully but the webhook list response was not recognized');
    }
    const items: WebhookSummary[] = [];
    for (const raw of rawItems) {
      const parsed = parseWebhookSummary(raw);
      if (!parsed) {
        return emptyResult('central answered successfully but one or more webhook rows could not be parsed');
      }
      items.push(parsed);
    }
    return filterAndPage(
      items,
      'central live',
      items.length === 0 ? 'Central returned no webhook rows (recognized empty envelope).' : undefined,
    );
  }

  /** Fresh single-webhook detail read — used to populate the edit drawer's
   *  "before" state for the review diff. 404 is reserved for a genuine
   *  not-found; a denied/unreachable/malformed read is a distinct 502 (same
   *  rule server/src/services/sseObjects.ts's getObject() documents). */
  async get(idRaw: unknown): Promise<WebhookDetail> {
    const id = this.requireId(idRaw);
    if (this.effectiveDemoMode()) {
      const found = WEBHOOKS_DEMO.find((w) => w.id === id);
      if (!found) throw new CentralWebhooksError(404, `webhook '${id}' was not found`);
      return found;
    }
    const adapter = this.adapter();
    if (!adapter) throw new CentralWebhooksError(409, 'central is not linked — cannot read webhooks');
    if (!this.supportsWebhooks(adapter)) {
      throw new CentralWebhooksError(409, 'Central Classic — webhook management requires the New Central gateway');
    }
    return this.getLive(adapter, id);
  }

  private async getLive(adapter: CentralWebhooksTransport, id: string): Promise<WebhookDetail> {
    let res: { status: number; body: unknown };
    try {
      res = await adapter.request('GET', `${WEBHOOKS_API_PATH}/${encodeURIComponent(id)}`);
    } catch {
      throw new CentralWebhooksError(502, `webhook '${id}' could not be read from Central (transport error)`);
    }
    if (res.status === 404) throw new CentralWebhooksError(404, `webhook '${id}' was not found`);
    if (res.status === 401 || res.status === 403) {
      throw new CentralWebhooksError(
        502,
        `central denied the request reading webhook '${id}' (HTTP ${res.status})${centralErrorSuffix(res.body)} — check the token's granted scope`,
      );
    }
    if (res.status < 200 || res.status >= 300) {
      throw new CentralWebhooksError(502, `webhook '${id}' could not be read from Central (HTTP ${res.status})${centralErrorSuffix(res.body)}`);
    }
    const parsed = parseWebhookDetail(res.body);
    if (!parsed) {
      throw new CentralWebhooksError(502, `central answered successfully but webhook '${id}' could not be parsed`);
    }
    return parsed;
  }

  // -- mutations --------------------------------------------------------------

  /** Shared non-2xx mapping for enabled PATCH and DELETE operations. A plane
   * answer that is not 2xx is an outcome to report, not a request error. */
  private outcomeFromNon2xx(res: { status: number; body: unknown }, verb: string): WebhookMutationResult {
    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        action: 'failed',
        httpCode: res.status,
        message: `central denied the request ${verb} (HTTP ${res.status})${centralErrorSuffix(res.body)} — check the token's granted scope`,
      };
    }
    if (res.status === 404) {
      return { ok: false, action: 'failed', httpCode: res.status, message: `webhook not found (HTTP 404)${centralErrorSuffix(res.body)}` };
    }
    return {
      ok: false,
      action: 'failed',
      httpCode: res.status,
      message: `central answered HTTP ${res.status} ${verb}${centralErrorSuffix(res.body)}`,
    };
  }

  async create(
    formRaw: unknown,
    reviewConfirmedRaw: unknown,
    oneTimeSecretAcknowledgedRaw: unknown,
    reviewedTenantBindingRaw?: unknown,
  ): Promise<WebhookMutationResult | WebhookOneTimeSecretResult> {
    this.requireReview(reviewConfirmedRaw);
    this.requireOneTimeSecretAcknowledgement(oneTimeSecretAcknowledgedRaw);
    const form = asWebhookCreateForm(formRaw);
    const reviewedTenantBinding =
      reviewedTenantBindingRaw === undefined
        ? this.currentReviewBinding()
        : this.requireReviewedTenantBinding(reviewedTenantBindingRaw);
    return this.withHandoffLock(async () => {
      this.requireReviewedTenantBinding(reviewedTenantBinding);
      const adapter = this.adapter();
      if (!adapter) throw new CentralWebhooksError(409, 'central is not linked — cannot create a webhook');
      if (!this.supportsWebhooks(adapter)) {
        const result: WebhookMutationResult = {
          ok: false,
          action: 'failed',
          message: 'Central Classic is not writable via this path — webhook management requires the New Central gateway',
        };
        this.log('webhook-create', result);
        return result;
      }
      const journal = this.beginHandoff('create', {
        candidate: canonicalWebhookCreateCandidate(form),
      });
      let callbackValidatedAt: string;
      try {
        callbackValidatedAt = await this.validateCallbackEndpoint(form.endpoint);
        this.requireReviewedTenantBinding(reviewedTenantBinding);
        this.requireMatchingFingerprint(journal);
      } catch (err) {
        this.deleteHandoff();
        throw err;
      }
      const secrets = [form.apiKey, form.oidcClientSecret].filter(
        (value): value is string => typeof value === 'string' && value.length > 0,
      );
      let res: { status: number; body: unknown };
      try {
        res = await adapter.request('POST', WEBHOOKS_API_PATH, wireCreateBody(form));
      } catch {
        this.retainUnknownHandoff(journal);
        this.logTransportFailure('webhook-create', callbackValidatedAt);
        return {
          ok: false,
          action: 'unknown',
          outcome: 'unknown',
          code: 'WEBHOOK_CREATE_HMAC_OUTCOME_UNKNOWN',
          operationId: journal.operationId,
          httpCode: 502,
          callbackValidatedAt,
          message:
            'central did not answer creating the webhook; outcome unknown — use the pending handoff reconciliation before any new request',
        };
      }
      if (res.status !== 200) {
        const result = this.outcomeFromNon2xx(res, 'creating the webhook');
        result.operationId = journal.operationId;
        result.callbackValidatedAt = callbackValidatedAt;
        this.deleteHandoff();
        this.log('webhook-create', result);
        return result;
      }
      const envelope = documentedMutationEnvelope(res.body);
      if (envelope.kind === 'failure') {
        const result: WebhookMutationResult = {
          ok: false,
          action: 'failed',
          operationId: journal.operationId,
          httpCode: res.status,
          callbackValidatedAt,
          message: `central rejected webhook creation${safeProviderFailureDetail(res.body, secrets)}`,
        };
        this.deleteHandoff();
        this.log('webhook-create', result);
        return result;
      }
      const result = oneTimeHmacResult(
        res.body,
        'created',
        journal.operationId,
        callbackValidatedAt,
      );
      if (!result) {
        this.retainUnknownHandoff(journal);
        const unknown: WebhookMutationResult = {
          ok: false,
          action: 'unknown',
          outcome: 'unknown',
          code: 'WEBHOOK_CREATE_HMAC_OUTCOME_UNKNOWN',
          operationId: journal.operationId,
          httpCode: res.status,
          callbackValidatedAt,
          message:
            'central returned HTTP 200 without the exact documented successful one-time HMAC envelope; outcome unknown — reconcile the canonical create candidate before any new create',
        };
        this.log('webhook-create', unknown);
        return unknown;
      }
      try {
        this.transitionHandoff(journal, 'secret-issued-awaiting-handoff');
      } catch {
        const unknown: WebhookMutationResult = {
          ok: false,
          action: 'unknown',
          outcome: 'unknown',
          code: 'WEBHOOK_CREATE_HMAC_OUTCOME_UNKNOWN',
          operationId: journal.operationId,
          httpCode: 503,
          callbackValidatedAt,
          message:
            'central issued a one-time HMAC key but the durable handoff transition failed; the key cannot be returned and manual reconciliation is required',
        };
        this.log('webhook-create', unknown);
        return unknown;
      }
      this.log('webhook-create', {
        ok: true,
        action: 'created',
        operationId: journal.operationId,
        httpCode: res.status,
        callbackValidatedAt,
        message: 'webhook created',
      });
      return result;
    });
  }

  async replace(idRaw: unknown, _formRaw: unknown, _reviewConfirmedRaw: unknown): Promise<WebhookMutationResult> {
    this.requireId(idRaw);
    return this.unsupported(
      'webhook-update',
      'full webhook replacement (PUT may replace the one-time HMAC key)',
    );
  }

  /** PATCH is the only enabled edit path. Per-id serialization covers
   * validation (including point-in-time DNS validation), the current-object
   * reread and generation comparison, PATCH, and secret-free audit/result
   * handling. */
  async patch(idRaw: unknown, partialRaw: unknown, reviewConfirmedRaw: unknown): Promise<WebhookMutationResult> {
    this.requireReview(reviewConfirmedRaw);
    const id = this.requireId(idRaw);
    return withWebhookPatchLock(id, async () => {
      const partial = asWebhookPatchForm(partialRaw);
      const callbackValidatedAt =
        partial.endpoint !== undefined
          ? await this.validateCallbackEndpoint(partial.endpoint)
          : undefined;

      if (this.effectiveDemoMode()) {
        const current = WEBHOOKS_DEMO.find((webhook) => webhook.id === id);
        if (!current) throw new CentralWebhooksError(404, `webhook '${id}' was not found`);
        if (current.generation !== partial.expectedGeneration) {
          const conflict: WebhookMutationResult = {
            ok: false,
            action: 'conflict',
            httpCode: 409,
            callbackValidatedAt,
            message: `webhook generation conflict: reviewed ${partial.expectedGeneration}, current ${current.generation}; re-read and review again`,
          };
          this.log('webhook-patch', conflict);
          return conflict;
        }
        const result: WebhookMutationResult = {
          ok: true,
          action: 'patched',
          callbackValidatedAt,
          message: `demo webhook '${id}' patched — no live tenant was written`,
        };
        this.log('webhook-patch', result);
        return result;
      }
      const adapter = this.adapter();
      if (!adapter) throw new CentralWebhooksError(409, 'central is not linked — cannot patch a webhook');
      if (!this.supportsWebhooks(adapter)) {
        const result: WebhookMutationResult = {
          ok: false,
          action: 'failed',
          message: 'Central Classic is not writable via this path — webhook management requires the New Central gateway',
        };
        this.log('webhook-patch', result);
        return result;
      }

      let current: WebhookDetail;
      try {
        current = await this.getLive(adapter, id);
      } catch (err) {
        if (err instanceof CentralWebhooksError) {
          this.log('webhook-patch', {
            ok: false,
            action: 'failed',
            httpCode: err.status,
            callbackValidatedAt,
            message: err.message,
          });
        }
        throw err;
      }
      if (current.generation !== partial.expectedGeneration) {
        const conflict: WebhookMutationResult = {
          ok: false,
          action: 'conflict',
          httpCode: 409,
          callbackValidatedAt,
          message: `webhook generation conflict: reviewed ${partial.expectedGeneration}, current ${current.generation}; re-read and review again`,
        };
        this.log('webhook-patch', conflict);
        return conflict;
      }

      let res: { status: number; body: unknown };
      try {
        res = await adapter.request('PATCH', `${WEBHOOKS_API_PATH}/${encodeURIComponent(id)}`, wirePatchBody(partial));
      } catch {
        this.logTransportFailure('webhook-patch', callbackValidatedAt);
        throw new CentralWebhooksError(502, 'central did not answer patching the webhook; the outcome is unknown');
      }
      if (res.status < 200 || res.status >= 300) {
        const result = this.outcomeFromNon2xx(res, 'patching the webhook');
        result.callbackValidatedAt = callbackValidatedAt;
        this.log('webhook-patch', result);
        return result;
      }
      const envelope = documentedMutationEnvelope(res.body);
      const patchSecrets = [partial.apiKey, partial.oidcClientSecret].filter(
        (value): value is string => typeof value === 'string' && value.length > 0,
      );
      const result: WebhookMutationResult =
        envelope.kind === 'success'
          ? {
              ok: true,
              action: 'patched',
              httpCode: res.status,
              callbackValidatedAt,
              message: 'webhook patched',
            }
          : envelope.kind === 'failure'
            ? {
                ok: false,
                action: 'failed',
                httpCode: res.status,
                callbackValidatedAt,
                message: `central rejected the webhook PATCH${safeProviderFailureDetail(res.body, patchSecrets)}`,
              }
            : {
                ok: false,
                action: 'failed',
                httpCode: res.status,
                callbackValidatedAt,
                message:
                  'central answered HTTP 200 without items.success === true; the PATCH response was not a documented success',
              };
      this.log('webhook-patch', result);
      return result;
    });
  }

  async remove(idRaw: unknown, reviewConfirmedRaw: unknown): Promise<WebhookMutationResult> {
    this.requireReview(reviewConfirmedRaw);
    const id = this.requireId(idRaw);

    if (this.effectiveDemoMode()) {
      const result: WebhookMutationResult = { ok: true, action: 'deleted', message: `demo webhook '${id}' deleted — no live tenant was written` };
      this.log('webhook-delete', result);
      return result;
    }
    const adapter = this.adapter();
    if (!adapter) throw new CentralWebhooksError(409, 'central is not linked — cannot delete a webhook');
    if (!this.supportsWebhooks(adapter)) {
      const result: WebhookMutationResult = {
        ok: false,
        action: 'failed',
        message: 'Central Classic is not writable via this path — webhook management requires the New Central gateway',
      };
      this.log('webhook-delete', result);
      return result;
    }
    let res: { status: number; body: unknown };
    try {
      res = await adapter.request('DELETE', `${WEBHOOKS_API_PATH}/${encodeURIComponent(id)}`);
    } catch {
      this.logTransportFailure('webhook-delete');
      throw new CentralWebhooksError(502, 'central did not answer deleting the webhook; the outcome is unknown');
    }
    const result: WebhookMutationResult =
      res.status === 204
        ? { ok: true, action: 'deleted', httpCode: res.status, message: 'webhook deleted' }
        : this.outcomeFromNon2xx(res, 'deleting the webhook');
    this.log('webhook-delete', result);
    return result;
  }

  async rotateHmacKey(
    idRaw: unknown,
    reviewConfirmedRaw: unknown,
    oneTimeSecretAcknowledgedRaw: unknown,
    reviewedTenantBindingRaw?: unknown,
  ): Promise<WebhookMutationResult | WebhookOneTimeSecretResult> {
    this.requireReview(reviewConfirmedRaw);
    this.requireOneTimeSecretAcknowledgement(oneTimeSecretAcknowledgedRaw);
    const id = this.requireId(idRaw);
    const reviewedTenantBinding =
      reviewedTenantBindingRaw === undefined
        ? this.currentReviewBinding()
        : this.requireReviewedTenantBinding(reviewedTenantBindingRaw);
    return this.withHandoffLock(async () => {
      this.requireReviewedTenantBinding(reviewedTenantBinding);
      const adapter = this.adapter();
      if (!adapter) throw new CentralWebhooksError(409, 'central is not linked — cannot rotate a webhook HMAC key');
      if (!this.supportsWebhooks(adapter)) {
        const result: WebhookMutationResult = {
          ok: false,
          action: 'failed',
          message: 'Central Classic is not writable via this path — webhook management requires the New Central gateway',
        };
        this.log('webhook-rotate-hmac-key', result);
        return result;
      }
      const journal = this.beginHandoff('rotate', { webhookId: id });
      let res: { status: number; body: unknown };
      try {
        res = await adapter.request(
          'POST',
          `${WEBHOOKS_API_PATH}/${encodeURIComponent(id)}/rotate-hmac-key`,
        );
      } catch {
        this.retainUnknownHandoff(journal);
        this.logTransportFailure('webhook-rotate-hmac-key');
        return {
          ok: false,
          action: 'unknown',
          outcome: 'unknown',
          code: 'WEBHOOK_ROTATE_HMAC_OUTCOME_UNKNOWN',
          operationId: journal.operationId,
          httpCode: 502,
          message:
            'central did not answer rotating the webhook HMAC key; outcome unknown — reconcile the receiver and Central before any new rotation',
        };
      }
      if (res.status !== 200) {
        const result = this.outcomeFromNon2xx(res, 'rotating the webhook HMAC key');
        result.operationId = journal.operationId;
        this.deleteHandoff();
        this.log('webhook-rotate-hmac-key', result);
        return result;
      }
      const envelope = documentedMutationEnvelope(res.body);
      if (envelope.kind === 'failure') {
        const result: WebhookMutationResult = {
          ok: false,
          action: 'failed',
          operationId: journal.operationId,
          httpCode: res.status,
          message: `central rejected HMAC rotation${safeProviderFailureDetail(res.body, [])}`,
        };
        this.deleteHandoff();
        this.log('webhook-rotate-hmac-key', result);
        return result;
      }
      const result = oneTimeHmacResult(res.body, 'rotated', journal.operationId);
      if (!result) {
        this.retainUnknownHandoff(journal);
        const unknown: WebhookMutationResult = {
          ok: false,
          action: 'unknown',
          outcome: 'unknown',
          code: 'WEBHOOK_ROTATE_HMAC_OUTCOME_UNKNOWN',
          operationId: journal.operationId,
          httpCode: res.status,
          message:
            'central returned HTTP 200 without the exact documented successful one-time HMAC envelope; outcome unknown — reconcile the receiver and Central before any new rotation',
        };
        this.log('webhook-rotate-hmac-key', unknown);
        return unknown;
      }
      try {
        this.transitionHandoff(journal, 'secret-issued-awaiting-handoff');
      } catch {
        const unknown: WebhookMutationResult = {
          ok: false,
          action: 'unknown',
          outcome: 'unknown',
          code: 'WEBHOOK_ROTATE_HMAC_OUTCOME_UNKNOWN',
          operationId: journal.operationId,
          httpCode: 503,
          message:
            'central issued a one-time HMAC key but the durable handoff transition failed; the key cannot be returned and manual reconciliation is required',
        };
        this.log('webhook-rotate-hmac-key', unknown);
        return unknown;
      }
      this.log('webhook-rotate-hmac-key', {
        ok: true,
        action: 'rotated',
        operationId: journal.operationId,
        httpCode: res.status,
        message: 'webhook HMAC key rotated',
      });
      return result;
    });
  }
}

/** Process-wide singleton, matching writeBroker.ts / ssidDirectWrite.ts's
 *  own pattern. */
export const centralWebhooks = new CentralWebhooksService();
