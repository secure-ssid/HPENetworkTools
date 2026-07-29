/**
 * shared/webhooks.ts — New Central webhook management contracts.
 *
 * Source of truth: the New Central "Services" API reference, Webhooks tag
 * (https://developer.arubanetworks.com/new-central/reference/services),
 * confirmed against the live OpenAPI definitions embedded in each reference
 * page (…/reference/{operation}.md):
 *
 *   GET    /network-services/v1/webhooks                      list      (getWebhooksV1)
 *   POST   /network-services/v1/webhooks                      create    (createWebhookV1)
 *   GET    /network-services/v1/webhooks/{id}                 detail    (getWebhookV1)
 *   PUT    /network-services/v1/webhooks/{id}                 replace   (updateWebhookV1; portal-disabled)
 *   PATCH  /network-services/v1/webhooks/{id}                 patch     (patchWebhookV1)
 *   DELETE /network-services/v1/webhooks/{id}                 delete    (deleteWebhookV1)
 *   POST   /network-services/v1/webhooks/{id}/rotate-hmac-key rotate    (rotateWebhookHmacKeyV1)
 *
 * Every one of the above is documented; nothing here invents a path New
 * Central does not publish (there is, in particular, no documented "send a
 * test event now" operation, so this app makes no server-side call to an
 * operator-supplied endpoint — see isPrivateOrReservedHost below for why the
 * SSRF guard still exists).
 *
 * Auth modes are exactly the two the docs define
 * (…/docs/getting-started-with-webhooks, …/docs/webhook-authentication):
 *   API_KEY — a static key Central sends as an `authorization` ****** to
 *             the receiver.
 *   OIDC    — clientId + clientSecret + wellKnownUrl; Central mints its own
 *             token from the receiver's OIDC provider.
 * Central caps a tenant at 10 configured webhooks (same doc).
 *
 * Create and HMAC rotation require both a reviewed-action confirmation and
 * a separate acknowledgement that the returned HMAC key is one-time and
 * must be copied immediately. Full PUT replacement remains disabled;
 * existing webhook edits use the documented PATCH operation with a reviewed
 * expected generation.
 *
 * SECRETS — write-only, always: `apiKey`, `oidcClientSecret`, and the HMAC
 * signing key Central mints/rotates. Central's own single-webhook GET
 * actually echoes `apiKey`/`oidcDetails.clientSecret` back in cleartext
 * (see the WebhookDetailsApiKeyAuth/WebhookDetailsOidcAuth schemas in
 * getwebhookv1.md), and its create/replace/rotate responses carry a fresh
 * `items.hmacKey` (createwebhookv1.md, rotatewebhookhmackeyv1.md). The
 * server redacts credentials returned by GET. The HMAC key appears only in
 * the successful create/rotate response type below; it never enters list or
 * detail contracts, audits, logs, queues, settings, caches, fixtures, or
 * persisted files. Every WebhookDetail below carries only a redacted
 * `*Configured: boolean` marker in a secret's place, never its value.
 */

export type WebhookAuthMechanism = 'API_KEY' | 'OIDC';

/** Exactly what GET /network-services/v1/webhooks reports per row — no
 *  secret-configured flags, because the list endpoint does not report them
 *  (see getwebhooksv1.md's WebhookDetailsList item shape). Claiming a
 *  configured/unconfigured state here would be a guess, not a read. */
export interface WebhookSummary {
  id: string;
  name: string;
  endpoint: string;
  authMechanism: WebhookAuthMechanism;
  generation: number;
  createdAt: string;
  updatedAt: string | null;
}

/** The single-webhook GET's fuller (still secret-free) shape. */
export interface WebhookDetail extends WebhookSummary {
  apiKeyConfigured: boolean;
  oidcClientId?: string;
  oidcWellKnownUrl?: string;
  oidcClientSecretConfigured: boolean;
}

export interface WebhookListEnvelope {
  items: WebhookSummary[];
  totalCount: number;
  count: number;
  limit: number;
  offset: number;
  hasMore: boolean;
  /** Free-text provenance, e.g. 'central live' | 'demo fixture'. */
  source: string;
  /** Present for an honest successful empty read, so consumers never infer
   *  "none configured" from a malformed or provenance-free response. */
  note?: string;
  /** Present only when the list could NOT be read live — an honest reason
   *  (not linked, Classic gateway, permission denied, transport failure,
   *  malformed response). `items` is always [] when this is set — a
   *  partial-but-unlabelled list is never returned. */
  error?: string;
  /** The Central gateway base URL a write would target, or null when Central
   *  is not linked / not New Central. NOT a secret (the operator already
   *  chose it from a fixed regional-cluster list when linking Central — see
   *  Systems.tsx CENTRAL_REGIONS) — carried here purely so the review UI can
   *  show the exact outbound target URL before a mutation, with no extra
   *  round trip. */
  gatewayBaseUrl: string | null;
  /** Process-local opaque binding for the exact Central credentials that
   *  supplied this review data. A server restart or credential change makes
   *  an open review stale instead of allowing it to target another tenant. */
  tenantBinding: string | null;
}

/** Create review form. Full PUT replacement remains server-disabled. */
export interface WebhookForm {
  name: string;
  endpoint: string;
  authMechanism: WebhookAuthMechanism;
  apiKey?: string;
  oidcClientId?: string;
  oidcClientSecret?: string;
  oidcWellKnownUrl?: string;
  /** @deprecated Request bodies cannot weaken callback validation. */
  allowInsecureCallback?: boolean;
}

/** Secret-free identity used for create review, durable handoff recovery, and
 * reconciliation. Every field is canonicalized before a create is issued. */
export interface CanonicalWebhookCreateCandidate {
  name: string;
  endpoint: string;
  authMechanism: WebhookAuthMechanism;
  oidcClientId?: string;
  oidcWellKnownUrl?: string;
}

/** Canonicalize all non-secret create fields once. Secret bytes are preserved
 * exactly because leading/trailing whitespace can be significant to a
 * receiver credential. */
export function canonicalizeWebhookCreateForm(form: WebhookForm): WebhookForm {
  const common = {
    name: form.name.trim(),
    endpoint: form.endpoint.trim(),
    authMechanism: form.authMechanism,
  };
  if (form.authMechanism === 'OIDC') {
    return {
      ...common,
      authMechanism: 'OIDC',
      oidcClientId: form.oidcClientId?.trim(),
      oidcClientSecret: form.oidcClientSecret,
      oidcWellKnownUrl: form.oidcWellKnownUrl?.trim(),
    };
  }
  return {
    ...common,
    authMechanism: 'API_KEY',
    apiKey: form.apiKey,
  };
}

export function canonicalWebhookCreateCandidate(
  form: WebhookForm,
): CanonicalWebhookCreateCandidate {
  const canonical = canonicalizeWebhookCreateForm(form);
  return canonical.authMechanism === 'OIDC'
    ? {
        name: canonical.name,
        endpoint: canonical.endpoint,
        authMechanism: 'OIDC',
        oidcClientId: canonical.oidcClientId,
        oidcWellKnownUrl: canonical.oidcWellKnownUrl,
      }
    : {
        name: canonical.name,
        endpoint: canonical.endpoint,
        authMechanism: 'API_KEY',
      };
}

export function matchesCanonicalWebhookCreateCandidate(
  webhook: WebhookSummary | WebhookDetail,
  candidate: CanonicalWebhookCreateCandidate,
): boolean {
  if (
    webhook.name.trim() !== candidate.name ||
    webhook.endpoint.trim() !== candidate.endpoint ||
    webhook.authMechanism !== candidate.authMechanism
  ) {
    return false;
  }
  if (candidate.authMechanism !== 'OIDC') return true;
  if (!('oidcClientId' in webhook)) return false;
  return (
    webhook.oidcClientId?.trim() === candidate.oidcClientId &&
    webhook.oidcWellKnownUrl?.trim() === candidate.oidcWellKnownUrl
  );
}

/** The only supported edit contract. `expectedGeneration` is copied from
 * the detail used for review; the server re-reads the webhook immediately
 * before PATCH and returns HTTP 409 if it no longer matches. Auth changes
 * are allowed because the documented PATCH response does not issue an HMAC
 * key, but each credential variant must be exact and complete. */
export interface WebhookPatchForm {
  expectedGeneration: number;
  name?: string;
  endpoint?: string;
  authMechanism?: WebhookAuthMechanism;
  apiKey?: string;
  oidcClientId?: string;
  oidcClientSecret?: string;
  oidcWellKnownUrl?: string;
}

export interface WebhookPatchRequest {
  form: WebhookPatchForm;
  reviewConfirmed: true;
}

export interface WebhookCreateRequest {
  form: WebhookForm;
  reviewConfirmed: true;
  oneTimeSecretAcknowledged: true;
}

export interface WebhookRotateHmacRequest {
  reviewConfirmed: true;
  oneTimeSecretAcknowledged: true;
}

export type WebhookMutationAction =
  | 'created'
  | 'updated'
  | 'patched'
  | 'deleted'
  | 'rotated'
  | 'unknown'
  | 'conflict'
  | 'unsupported'
  | 'failed';

export type WebhookUnknownOutcomeCode =
  | 'WEBHOOK_CREATE_HMAC_OUTCOME_UNKNOWN'
  | 'WEBHOOK_ROTATE_HMAC_OUTCOME_UNKNOWN';

export interface WebhookMutationResult {
  ok: boolean;
  action: WebhookMutationAction;
  /** Present for create/rotate after the durable preflight journal exists. */
  operationId?: string;
  /** Present when Central answered the mutation but the one-time result
   * could not be safely recovered, so success versus failure is unknowable. */
  outcome?: 'unknown';
  code?: WebhookUnknownOutcomeCode;
  /** Optional secret-free detail only; one-time HMAC results use the
   * dedicated ephemeral contract below. */
  webhook?: WebhookDetail;
  /** When an endpoint edit was checked at the server boundary. DNS can
   * change after this time and Central—not this portal—is the caller, so
   * this timestamp is evidence of a point-in-time check, not an SSRF-proof
   * guarantee. */
  callbackValidatedAt?: string;
  httpCode?: number;
  message: string;
}

/** Ephemeral success response for the reviewed create/rotate call.
 * `hmacKey` must be copied immediately and discarded by the caller; it is
 * intentionally absent from every generic mutation/list/detail contract. */
export interface WebhookOneTimeSecretResult {
  ok: true;
  action: 'created' | 'rotated';
  operationId: string;
  hmacKey: string;
  message: string;
  callbackValidatedAt?: string;
}

export type WebhookHandoffState =
  | 'in-flight'
  | 'outcome-unknown'
  | 'secret-issued-awaiting-handoff';

export interface WebhookHandoffOperation {
  operationId: string;
  opType: 'create' | 'rotate';
  state: WebhookHandoffState;
  candidate?: CanonicalWebhookCreateCandidate;
  webhookId?: string;
  createdAt: string;
  updatedAt: string;
  /** False means credentials/base URL changed outside the guarded API. */
  fingerprintMatches: boolean;
}

export interface WebhookHandoffStatus {
  pending: boolean;
  operation?: WebhookHandoffOperation;
}

export interface WebhookHandoffResolutionResult {
  ok: true;
  operationId: string;
  resolution: 'secret-stored' | 'create-located' | 'create-absent' | 'rotate-reconciled';
  webhookId?: string;
  message: string;
}

export const WEBHOOK_AUTH_OPTIONS: { value: WebhookAuthMechanism; label: string }[] = [
  { value: 'API_KEY', label: 'API key' },
  { value: 'OIDC', label: 'OIDC' },
];

/** getting-started-with-webhooks.md: "you can create up to 10 configured
 *  Webhooks." Used only to phrase an honest "at the limit" message — never
 *  enforced client-side as the authoritative check (Central's own 400 is). */
export const WEBHOOK_MAX_PER_TENANT = 10;

export const WEBHOOK_LIST_DEFAULT_LIMIT = 10;
export const WEBHOOK_LIST_MAX_LIMIT = 50;

/** Central's id is `format: uuid` in every reference page's Id parameter,
 *  but this allows any short hex/uuid-shaped token so a differently-shaped
 *  (but still safe) id is not rejected as a portal bug. Rejects anything
 *  that is not a bounded set of URL-safe characters BEFORE it is ever
 *  placed on an outbound path segment — the allowlist half of "allowlisted
 *  paths and encoded IDs" (the path itself is always the fixed literal
 *  above; encodeURIComponent(id) still runs on top of this check). */
export function isWebhookId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(value);
}

// ---------------------------------------------------------------------------
// Callback URL validation (HTTPS-by-default) + SSRF defense-in-depth
// ---------------------------------------------------------------------------

export interface CallbackUrlCheck {
  ok: boolean;
  reason?: string;
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0']);

function parseCanonicalIpv4(value: string): number[] | null {
  const parts = value.split('.');
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^(0|[1-9]\d{0,2})$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    octets.push(octet);
  }
  return octets;
}

function parseIpv6(value: string): number[] | null {
  let input = value.toLowerCase();
  if (input.startsWith('[') && input.endsWith(']')) input = input.slice(1, -1);
  if (!input || input.includes('%') || input.split('::').length > 2) return null;

  const ipv4Match = input.match(/(?:^|:)(\d+\.\d+\.\d+\.\d+)$/);
  if (ipv4Match) {
    const ipv4 = parseCanonicalIpv4(ipv4Match[1]);
    if (!ipv4) return null;
    input =
      input.slice(0, -ipv4Match[1].length) +
      `${((ipv4[0] << 8) | ipv4[1]).toString(16)}:${((ipv4[2] << 8) | ipv4[3]).toString(16)}`;
  }

  const halves = input.split('::');
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  if ([...left, ...right].some((part) => !/^[0-9a-f]{1,4}$/.test(part))) return null;
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return null;
  return [...left, ...Array.from({ length: missing }, () => '0'), ...right].map((part) => parseInt(part, 16));
}

function ipv6InCidr(words: number[], cidrWords: number[], prefix: number): boolean {
  const fullWords = Math.floor(prefix / 16);
  const remaining = prefix % 16;
  for (let i = 0; i < fullWords; i += 1) {
    if (words[i] !== cidrWords[i]) return false;
  }
  if (remaining === 0) return true;
  const mask = (0xffff << (16 - remaining)) & 0xffff;
  return (words[fullWords] & mask) === (cidrWords[fullWords] & mask);
}

function ipv6Cidr(value: string, prefix: number): [number[], number] {
  return [parseIpv6(value) ?? [], prefix];
}

const NON_PUBLIC_IPV6_CIDRS: [number[], number][] = [
  ipv6Cidr('::', 96),
  ipv6Cidr('::', 128),
  ipv6Cidr('::1', 128),
  ipv6Cidr('::ffff:0:0', 96),
  ipv6Cidr('64:ff9b::', 96),
  ipv6Cidr('64:ff9b:1::', 48),
  ipv6Cidr('100::', 64),
  ipv6Cidr('2001::', 32),
  ipv6Cidr('2001:2::', 48),
  ipv6Cidr('2001:10::', 28),
  ipv6Cidr('2001:20::', 28),
  ipv6Cidr('2001:db8::', 32),
  ipv6Cidr('2002::', 16),
  ipv6Cidr('3fff::', 20),
  ipv6Cidr('fc00::', 7),
  ipv6Cidr('fe80::', 10),
  ipv6Cidr('fec0::', 10),
  ipv6Cidr('ff00::', 8),
];

/**
 * True for a hostname/IP literal that is loopback, link-local, the common
 * cloud metadata address, or a private RFC1918/ULA range — the standard
 * SSRF blocklist. This app makes no server-side call to an operator-
 * supplied endpoint today (Central, not this tool, delivers to the
 * receiver — see the file header), so this guard is not currently in an
 * outbound call path. It exists so validateCallbackUrl's policy is
 * enforced once, in one place, and so that ANY future server-side
 * reachability/test call against a webhook endpoint inherits the same
 * protection immediately instead of needing its own ad hoc check.
 */
export function isPrivateOrReservedHost(hostname: string): boolean {
  let h = hostname.toLowerCase();
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  if (!h || h.includes('%') || h.endsWith('.')) return true;
  if (LOOPBACK_HOSTS.has(h)) return true;
  if (h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.localhost')) return true;
  if (/^\d+(?:\.\d+){0,3}$/.test(h) && !parseCanonicalIpv4(h)) return true;
  const ipv4 = parseCanonicalIpv4(h);
  if (ipv4) {
    const [a, b, c] = ipv4;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 0 && c === 0) return true;
    if (a === 192 && b === 0 && c === 2) return true;
    if (a === 192 && b === 88 && c === 99) return true;
    if (a === 192 && b === 168) return true;
    if (a === 198 && (b === 18 || b === 19)) return true;
    if (a === 198 && b === 51 && c === 100) return true;
    if (a === 203 && b === 0 && c === 113) return true;
    if (a >= 224) return true;
    return false;
  }
  const ipv6 = parseIpv6(h);
  if (ipv6) return NON_PUBLIC_IPV6_CIDRS.some(([cidr, prefix]) => ipv6InCidr(ipv6, cidr, prefix));
  // A bare hostname with no dot (no public DNS suffix) is treated as an
  // internal-only name, same policy class as *.local/*.internal above.
  if (!h.includes('.')) return true;
  return false;
}

/**
 * Minimal, dependency-free URL parse — this module intentionally avoids the
 * DOM/Node `URL` global so it type-checks under shared/tsconfig.json's
 * lib-less config and behaves identically in the browser and the server.
 * Returns null for anything that is not an absolute `scheme://host[...]` URL.
 */
function parseUrlBasic(value: string): { protocol: string; hostname: string } | null {
  const m = value.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/([^/?#]+)/);
  if (!m) return null;
  const protocol = `${m[1].toLowerCase()}:`;
  let authority = m[2];
  if (authority.includes('@')) return null;
  let hostname: string;
  if (authority.startsWith('[')) {
    // IPv6 literal, e.g. [::1]:8080
    const end = authority.indexOf(']');
    hostname = end !== -1 ? authority.slice(1, end) : authority.slice(1);
  } else {
    const colonIdx = authority.indexOf(':');
    hostname = colonIdx !== -1 ? authority.slice(0, colonIdx) : authority;
  }
  if (!hostname) return null;
  return { protocol, hostname };
}

/**
 * Validate an operator-submitted webhook endpoint URL. New Central's own
 * docs say only "The HTTP or HTTPS endpoint on the receiver's server"
 * (getting-started-with-webhooks.md); this app tightens that to HTTPS by
 * default as its own security policy, because Central delivers signed
 * alert payloads (including the HMAC signature) to this URL and an
 * unencrypted target leaks that signature in transit.
 * The shared request contract has no insecure override. The server has a
 * process-side, NODE_ENV=test-only seam for focused tests; request bodies
 * cannot opt out of HTTPS.
 */
export function validateCallbackUrl(raw: string): CallbackUrlCheck {
  const value = raw.trim();
  if (!value) return { ok: false, reason: 'endpoint URL is required' };
  if (/[\u0000-\u001f\u007f\s]/.test(value)) {
    return { ok: false, reason: 'endpoint must not contain whitespace, credentials, or control characters' };
  }
  const parsed = parseUrlBasic(value);
  if (!parsed) return { ok: false, reason: 'endpoint must be a valid absolute URL' };
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { ok: false, reason: 'endpoint must use http or https' };
  }
  if (parsed.protocol === 'http:') {
    return { ok: false, reason: 'endpoint must use HTTPS' };
  }
  if (isPrivateOrReservedHost(parsed.hostname)) {
    return { ok: false, reason: 'endpoint may not target a private, loopback, or reserved network address' };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Form validation
// ---------------------------------------------------------------------------

/** Field-level errors for a create/replace form. Empty = ready to preview. */
export function validateWebhookForm(form: WebhookForm): string[] {
  const errors: string[] = [];
  const name = form.name?.trim() ?? '';
  if (!name) errors.push('name is required');
  else if (name.length > 64) errors.push('name must be 64 characters or fewer');

  const urlCheck = validateCallbackUrl(form.endpoint ?? '');
  if (!urlCheck.ok) errors.push(urlCheck.reason ?? 'endpoint is invalid');

  if (form.authMechanism === 'API_KEY') {
    if (typeof form.apiKey === 'string' && form.apiKey.length > 1024) {
      errors.push('API key must be 1024 characters or fewer');
    }
  } else if (form.authMechanism === 'OIDC') {
    const clientId = form.oidcClientId?.trim() ?? '';
    const wellKnown = form.oidcWellKnownUrl?.trim() ?? '';
    if (!clientId) errors.push('OIDC client ID is required');
    else if (clientId.length > 512) errors.push('OIDC client ID must be 512 characters or fewer');
    if (!wellKnown) errors.push('OIDC well-known URL is required');
    else if (wellKnown.length > 512) errors.push('OIDC well-known URL must be 512 characters or fewer');
    if (typeof form.oidcClientSecret === 'string' && form.oidcClientSecret.length > 512) {
      errors.push('OIDC client secret must be 512 characters or fewer');
    }
  } else {
    errors.push('authMechanism must be API_KEY or OIDC');
  }
  return errors;
}

/** A brand-new webhook has no existing secret to keep — create requires the
 *  matching secret to be freshly supplied. */
export function isCreateFormComplete(form: WebhookForm): boolean {
  if (validateWebhookForm(form).length > 0) return false;
  if (form.authMechanism === 'API_KEY') return !!form.apiKey?.trim();
  return !!(form.oidcClientId?.trim() && form.oidcClientSecret?.trim() && form.oidcWellKnownUrl?.trim());
}

// ---------------------------------------------------------------------------
// Review-confirmation diff — exact, non-secret
// ---------------------------------------------------------------------------

function diffLine(label: string, was: string | undefined, now: string): string[] {
  if (was === undefined) return [`+ ${label}: ${now}`];
  if (was !== now) return [`- ${label}: ${was}`, `+ ${label}: ${now}`];
  return [`  ${label}: ${now}`];
}

/**
 * Build the exact before/after lines the review-confirmation gate shows.
 * Secret fields (apiKey, oidcClientSecret) NEVER appear as values — only
 * whether they are being set, replaced, or left unchanged — so a reviewer
 * sees precisely what will change without a secret ever rendering in the
 * UI, a screenshot, or a copy/paste.
 */
export function buildWebhookReviewDiff(existing: WebhookDetail | null, form: WebhookForm): string[] {
  const reviewed = existing ? form : canonicalizeWebhookCreateForm(form);
  const lines: string[] = [
    ...(existing ? [`  expected generation: ${existing.generation}`] : []),
    ...diffLine('name', existing?.name, reviewed.name),
    ...diffLine('endpoint', existing?.endpoint, reviewed.endpoint),
    ...diffLine('authMechanism', existing?.authMechanism, reviewed.authMechanism),
  ];
  if (reviewed.authMechanism === 'API_KEY') {
    const willSet = !!reviewed.apiKey?.trim();
    const hadApiKeyAuth = existing?.authMechanism === 'API_KEY';
    lines.push(
      hadApiKeyAuth
        ? `  apiKey: ${willSet ? '(replaced — write-only, never shown)' : '(unchanged — write-only, never shown)'}`
        : `+ apiKey: ${willSet ? '(set — write-only, never shown)' : '(missing)'}`,
    );
  } else {
    const hadOidcAuth = existing?.authMechanism === 'OIDC';
    lines.push(
      ...diffLine('oidcClientId', hadOidcAuth ? existing?.oidcClientId : undefined, reviewed.oidcClientId ?? ''),
      ...diffLine('oidcWellKnownUrl', hadOidcAuth ? existing?.oidcWellKnownUrl : undefined, reviewed.oidcWellKnownUrl ?? ''),
    );
    const willSet = !!reviewed.oidcClientSecret?.trim();
    lines.push(
      hadOidcAuth
        ? `  oidcClientSecret: ${willSet ? '(replaced — write-only, never shown)' : '(unchanged — write-only, never shown)'}`
        : `+ oidcClientSecret: ${willSet ? '(set — write-only, never shown)' : '(missing)'}`,
    );
  }
  return lines;
}

export const WEBHOOKS_API_PATH = '/network-services/v1/webhooks';

/** Build the exact outbound target URL a webhook write would hit, for the
 *  review UI's "target URL" line. Pure formatting only — never used to make
 *  a call itself. `gatewayBaseUrl` is whatever WebhookListEnvelope reported
 *  (already scheme-normalized server-side); a null base (Central not linked)
 *  renders a placeholder instead of a real URL. */
export function webhookTargetUrl(
  gatewayBaseUrl: string | null,
  id?: string,
  suffix?: 'rotate-hmac-key',
): string {
  const base = gatewayBaseUrl ?? '<Central gateway not linked>';
  const idPart = id ? `/${id}` : '';
  const suffixPart = suffix ? `/${suffix}` : '';
  return `${base}${WEBHOOKS_API_PATH}${idPart}${suffixPart}`;
}

// ---------------------------------------------------------------------------
// Demo fixtures — canned data for the 'configure' section's demo mode
// ---------------------------------------------------------------------------

/** What "Manage webhooks" lists instead of a live Central read when the
 *  Configure section is in demo mode. Covers both auth mechanisms so the
 *  demo table and detail drawer exercise every field. */
export const WEBHOOKS_DEMO: WebhookDetail[] = [
  {
    id: 'a5e6f0a0-2a4b-4d9a-9d5e-8f1c2b3a4d5e',
    name: 'servicenow-incidents',
    endpoint: 'https://meridian.service-now.com/api/hpe/webhooks/central-alerts',
    authMechanism: 'API_KEY',
    generation: 3,
    createdAt: '2025-11-02T14:05:00Z',
    updatedAt: '2026-01-14T09:22:00Z',
    apiKeyConfigured: true,
    oidcClientSecretConfigured: false,
  },
  {
    id: 'c1d2e3f4-5a6b-4c7d-8e9f-0a1b2c3d4e5f',
    name: 'noc-event-bus',
    endpoint: 'https://noc.meridian-health.example/hooks/central',
    authMechanism: 'OIDC',
    generation: 1,
    createdAt: '2026-02-20T18:30:00Z',
    updatedAt: null,
    apiKeyConfigured: false,
    oidcClientId: 'meridian-noc-bridge',
    oidcWellKnownUrl: 'https://auth.meridian-health.example/.well-known/openid-configuration',
    oidcClientSecretConfigured: true,
  },
];
