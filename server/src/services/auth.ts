/**
 * server/src/services/auth.ts — OIDC single sign-on and session handling.
 *
 * This portal brokers writes to production network gear and bridges SSH to
 * switches. Until now it had no notion of who was doing that: every audit line
 * said `operator`. This module supplies the missing identity, using an
 * Authorization Code + PKCE flow against an OIDC provider (Authentik is the
 * one it was built against, but nothing here is Authentik-specific).
 *
 * Deliberate choices worth knowing before changing anything:
 *
 *  - **Sessions are in memory only.** A restart logs everyone out. That is the
 *    intended trade: persisting sessions means another secret at rest to
 *    protect, and this is a portal an operator signs into, not a service with
 *    uptime obligations.
 *
 *  - **The ID token is verified, not trusted.** Signature (via the provider's
 *    JWKS), issuer, audience, expiry and nonce are all checked. The token is
 *    then discarded — only the resolved principal is kept. The portal never
 *    stores or forwards a provider access token, so there is nothing here to
 *    steal that would grant access to anything else.
 *
 *  - **`state` is bound to a cookie, not just to server memory.** Server-side
 *    state alone proves the flow started, but not that it started *in this
 *    browser*. Without the cookie binding an attacker can start a flow and
 *    feed the victim the callback URL, logging the victim into the attacker's
 *    account (login CSRF).
 *
 *  - **Group membership is an additional gate, never the only one.** When
 *    `allowedGroups` is empty the provider's own application assignment is
 *    doing the gating, which is a legitimate configuration — but it is a
 *    decision, so `capabilities()` reports which one is in force rather than
 *    letting it be invisible.
 */

import * as crypto from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { NextFunction, Request, Response as ExpressResponse } from 'express';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import type { AuthSettings } from '../config/settings';

/** How long a signed-in session lasts before the operator must sign in again. */
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12h

/** How long a started-but-uncompleted login may sit before it is abandoned. */
const PENDING_TTL_MS = 10 * 60 * 1000; // 10m

/**
 * Ceiling on concurrent in-flight logins.
 *
 * `/api/auth/login` has to be open — you cannot require a session in order to
 * get one — so it is the one route an unauthenticated caller can drive at
 * will, and every call parks a PKCE verifier in memory for PENDING_TTL_MS.
 * Sweeping on expiry alone does not help: within a single ten-minute window
 * there was no limit at all, which makes the endpoint that guards everything
 * else the easiest way to exhaust the process.
 *
 * 256 is far above real use of this portal — a person starts one login at a
 * time, and an abandoned one clears itself in ten minutes — and far below any
 * amount of memory worth caring about.
 */
const MAX_PENDING_LOGINS = 256;

/** Outbound budget for provider calls (discovery, token, JWKS). */
const OIDC_TIMEOUT_MS = 10_000;

export const SESSION_COOKIE = 'hpe_sid';
export const STATE_COOKIE = 'hpe_oidc_state';

/** The authenticated human, as resolved from a verified ID token. */
export interface Principal {
  /** Provider-stable subject id. Unique, opaque, never reused. */
  sub: string;
  /** Preferred display handle. Falls back through email to sub — never empty. */
  name: string;
  email: string | null;
  groups: string[];
}

export interface Session {
  id: string;
  principal: Principal;
  createdAt: number;
  expiresAt: number;
}

interface PendingLogin {
  codeVerifier: string;
  nonce: string;
  createdAt: number;
  /** In-app path to land on after a successful callback. Never absolute. */
  returnTo: string;
}

/** The subset of OIDC discovery this module actually uses. */
export interface ProviderMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  scopes_supported?: string[];
  token_endpoint_auth_methods_supported?: string[];
}

export class AuthError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

// ---------------------------------------------------------------------------
// Cookies
// ---------------------------------------------------------------------------

/**
 * Minimal Cookie header parser.
 *
 * Deliberately not `cookie-parser`: this needs to read two known names, and a
 * dependency that runs on every request to do that is not a trade worth making.
 * Values are decoded but never evaluated — both cookies we read are compared
 * against server-side state, so a malformed value simply fails to match.
 */
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 1) continue;
    const key = part.slice(0, eq).trim();
    if (!key) continue;
    const raw = part.slice(eq + 1).trim();
    try {
      out[key] = decodeURIComponent(raw);
    } catch {
      out[key] = raw; // not our encoding; keep it verbatim rather than dropping it
    }
  }
  return out;
}

/**
 * Serialize a Set-Cookie value.
 *
 * `secure` is caller-decided rather than hardcoded: a laptop deployment on
 * http://127.0.0.1 cannot set Secure cookies at all (the browser would drop
 * them and login would silently never work), while any non-loopback deployment
 * must set it or the session cookie can be stripped to plaintext.
 */
export function serializeCookie(
  name: string,
  value: string,
  opts: { maxAgeMs?: number; secure: boolean; sameSite?: 'Lax' | 'Strict'; path?: string },
): string {
  const bits = [`${name}=${encodeURIComponent(value)}`];
  bits.push(`Path=${opts.path ?? '/'}`);
  bits.push('HttpOnly');
  bits.push(`SameSite=${opts.sameSite ?? 'Lax'}`);
  if (opts.secure) bits.push('Secure');
  if (opts.maxAgeMs !== undefined) bits.push(`Max-Age=${Math.floor(opts.maxAgeMs / 1000)}`);
  return bits.join('; ');
}

/** True when the response must carry Secure cookies to be safe. */
export function needsSecureCookie(req: Request): boolean {
  if (req.secure) return true;
  const proto = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0]?.trim();
  if (proto === 'https') return true;
  const host = String(req.headers.host ?? '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  const loopback = host === 'localhost' || host === '::1' || /^127\./.test(host);
  // Anything not served over loopback is reachable off-box, so the cookie must
  // not be allowed to travel in the clear even if this particular hop was http.
  return !loopback;
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export class SessionStore {
  private readonly sessions = new Map<string, Session>();
  private readonly pending = new Map<string, PendingLogin>();
  private evictedLogins = 0;
  private lastEvictionLogAt = 0;

  constructor(private readonly now: () => number = Date.now) {}

  startLogin(state: string, entry: Omit<PendingLogin, 'createdAt'>): void {
    this.sweep();
    // At the ceiling, drop the oldest in-flight logins rather than refuse the
    // new one. Refusing would let anyone who can reach the login route lock
    // every operator out — trading a memory problem for a total lockout of the
    // portal. Evicting only ever discards a login that has already been
    // overtaken by MAX_PENDING_LOGINS others, and an evicted state fails closed
    // at the callback with the same answer a genuinely expired one gets.
    while (this.pending.size >= MAX_PENDING_LOGINS) {
      const oldest = this.pending.keys().next();
      if (oldest.done) break;
      this.pending.delete(oldest.value);
      this.evictedLogins += 1;
      this.noteEviction();
    }
    this.pending.set(state, { ...entry, createdAt: this.now() });
  }

  /**
   * Eviction means either an attack or a misconfiguration, and in both cases
   * some real person's sign-in may have been discarded. Say so — but at most
   * once a minute, so the thing being reported cannot itself flood the log.
   */
  private noteEviction(): void {
    const t = this.now();
    if (t - this.lastEvictionLogAt < 60_000) return;
    this.lastEvictionLogAt = t;
    console.error(
      `auth: ${MAX_PENDING_LOGINS} logins already in flight — discarding the oldest to admit new ones ` +
        `(${this.evictedLogins} discarded so far). A sign-in in progress may have to be restarted.`,
    );
  }

  /** Consume a pending login. Single-use: a replayed callback finds nothing. */
  takeLogin(state: string): PendingLogin | null {
    this.sweep();
    const entry = this.pending.get(state);
    if (!entry) return null;
    this.pending.delete(state);
    if (this.now() - entry.createdAt > PENDING_TTL_MS) return null;
    return entry;
  }

  create(principal: Principal): Session {
    this.sweep();
    const id = crypto.randomBytes(32).toString('base64url');
    const createdAt = this.now();
    const session: Session = { id, principal, createdAt, expiresAt: createdAt + SESSION_TTL_MS };
    this.sessions.set(id, session);
    return session;
  }

  get(id: string | undefined): Session | null {
    if (!id) return null;
    const s = this.sessions.get(id);
    if (!s) return null;
    if (this.now() >= s.expiresAt) {
      this.sessions.delete(id);
      return null;
    }
    return s;
  }

  destroy(id: string | undefined): void {
    if (id) this.sessions.delete(id);
  }

  /** Test/diagnostic view. Never exposed over the API. */
  size(): { sessions: number; pending: number; evictedLogins: number } {
    return { sessions: this.sessions.size, pending: this.pending.size, evictedLogins: this.evictedLogins };
  }

  private sweep(): void {
    const t = this.now();
    for (const [id, s] of this.sessions) if (t >= s.expiresAt) this.sessions.delete(id);
    for (const [state, p] of this.pending) if (t - p.createdAt > PENDING_TTL_MS) this.pending.delete(state);
  }
}

export const sessionStore = new SessionStore();

// ---------------------------------------------------------------------------
// Provider discovery
// ---------------------------------------------------------------------------

const discoveryCache = new Map<string, { at: number; meta: ProviderMetadata }>();
const DISCOVERY_TTL_MS = 60 * 60 * 1000;

/**
 * Validate an operator-supplied issuer.
 *
 * Note this is *not* the webhook SSRF rule: `validateCallbackUrl` rejects
 * private and loopback addresses, which is right for a URL we hand to a vendor
 * but wrong here — a self-hosted Authentik on the LAN is the expected
 * deployment. What matters instead is that the transport is confidential,
 * since the client secret and the authorization code travel over it.
 */
export function validateIssuer(raw: string): { ok: true; url: URL } | { ok: false; reason: string } {
  const value = raw.trim();
  if (!value) return { ok: false, reason: 'issuer URL is required' };
  if (/[\u0000-\u001f\u007f\s]/.test(value)) {
    return { ok: false, reason: 'issuer must not contain whitespace or control characters' };
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, reason: 'issuer must be a valid absolute URL' };
  }
  if (url.username || url.password) {
    return { ok: false, reason: 'issuer must not embed credentials' };
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const loopback = host === 'localhost' || host === '::1' || /^127\./.test(host);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    return { ok: false, reason: 'issuer must use HTTPS (http is allowed only for loopback)' };
  }
  return { ok: true, url };
}

export async function discover(issuer: string, fetchImpl: typeof fetch = fetch): Promise<ProviderMetadata> {
  const check = validateIssuer(issuer);
  if (!check.ok) throw new AuthError(check.reason, 400);

  const cached = discoveryCache.get(issuer);
  if (cached && Date.now() - cached.at < DISCOVERY_TTL_MS) return cached.meta;

  const base = issuer.replace(/\/+$/, '');
  const url = `${base}/.well-known/openid-configuration`;
  let res: Response;
  try {
    res = await fetchImpl(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(OIDC_TIMEOUT_MS),
    });
  } catch (err) {
    throw new AuthError(`identity provider discovery failed: ${(err as Error).message}`, 502);
  }
  if (!res.ok) {
    throw new AuthError(`identity provider discovery returned HTTP ${res.status}`, 502);
  }
  const meta = (await res.json()) as Partial<ProviderMetadata>;
  for (const key of ['issuer', 'authorization_endpoint', 'token_endpoint', 'jwks_uri'] as const) {
    if (typeof meta[key] !== 'string' || !meta[key]) {
      throw new AuthError(`identity provider discovery is missing ${key}`, 502);
    }
  }
  // Guard against a discovery document that claims to speak for a different
  // issuer than the one configured — the issuer is what jwtVerify pins against.
  if (meta.issuer!.replace(/\/+$/, '') !== base) {
    throw new AuthError(
      `identity provider discovery declares issuer '${meta.issuer}', which does not match the configured '${issuer}'`,
      502,
    );
  }
  const full = meta as ProviderMetadata;
  discoveryCache.set(issuer, { at: Date.now(), meta: full });
  return full;
}

/** Drop cached discovery — used when auth settings change, and by tests. */
export function resetDiscoveryCache(): void {
  discoveryCache.clear();
  jwksCache.clear();
}

// ---------------------------------------------------------------------------
// Authorization request
// ---------------------------------------------------------------------------

function base64url(buf: Buffer): string {
  return buf.toString('base64url');
}

export function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = base64url(crypto.randomBytes(32));
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

/**
 * Only same-site, path-shaped destinations survive. An open redirect here
 * would let a crafted login link bounce an authenticated operator to an
 * attacker's page carrying whatever the portal put in the URL.
 */
export function safeReturnTo(raw: unknown): string {
  if (typeof raw !== 'string' || !raw) return '/';
  if (!raw.startsWith('/')) return '/';
  if (raw.startsWith('//')) return '/'; // protocol-relative → off-site
  if (/[\u0000-\u001f\u007f]/.test(raw)) return '/';
  return raw;
}

export function buildAuthorizeUrl(
  meta: ProviderMetadata,
  cfg: AuthSettings,
  args: { state: string; nonce: string; challenge: string },
): string {
  const url = new URL(meta.authorization_endpoint);
  const scopes = ['openid', 'profile', 'email'];
  // Only ask for groups when the provider says it can supply them: requesting
  // an unsupported scope is an error at some providers, and silently getting
  // no groups back would make `allowedGroups` fail closed for everyone with no
  // explanation.
  if (meta.scopes_supported?.includes('groups')) scopes.push('groups');
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', cfg.clientId);
  url.searchParams.set('redirect_uri', cfg.redirectUri);
  url.searchParams.set('scope', scopes.join(' '));
  url.searchParams.set('state', args.state);
  url.searchParams.set('nonce', args.nonce);
  url.searchParams.set('code_challenge', args.challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

// ---------------------------------------------------------------------------
// Token exchange + verification
// ---------------------------------------------------------------------------

export async function exchangeCode(
  meta: ProviderMetadata,
  cfg: AuthSettings,
  args: { code: string; codeVerifier: string },
  fetchImpl: typeof fetch = fetch,
): Promise<{ idToken: string }> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: args.code,
    redirect_uri: cfg.redirectUri,
    code_verifier: args.codeVerifier,
    client_id: cfg.clientId,
  });
  const headers: Record<string, string> = {
    'content-type': 'application/x-www-form-urlencoded',
    accept: 'application/json',
  };
  const methods = meta.token_endpoint_auth_methods_supported;
  // client_secret_post unless the provider only offers basic. Both are
  // equivalent in strength; picking by advertisement avoids a 401 that would
  // otherwise read as "wrong secret".
  if (methods && !methods.includes('client_secret_post') && methods.includes('client_secret_basic')) {
    const cred = Buffer.from(`${encodeURIComponent(cfg.clientId)}:${encodeURIComponent(cfg.clientSecret)}`).toString('base64');
    headers.authorization = `Basic ${cred}`;
  } else {
    body.set('client_secret', cfg.clientSecret);
  }

  let res: Response;
  try {
    res = await fetchImpl(meta.token_endpoint, {
      method: 'POST',
      headers,
      body: body.toString(),
      signal: AbortSignal.timeout(OIDC_TIMEOUT_MS),
    });
  } catch (err) {
    throw new AuthError(`token exchange failed: ${(err as Error).message}`, 502);
  }
  const text = await res.text();
  if (!res.ok) {
    // The provider's error body can echo the code and other flow material, so
    // it is logged, never returned.
    console.error(`oidc: token endpoint returned HTTP ${res.status}`);
    throw new AuthError(`identity provider rejected the login (HTTP ${res.status})`, 502);
  }
  let parsed: { id_token?: unknown };
  try {
    parsed = JSON.parse(text) as { id_token?: unknown };
  } catch {
    throw new AuthError('identity provider returned a non-JSON token response', 502);
  }
  if (typeof parsed.id_token !== 'string' || !parsed.id_token) {
    throw new AuthError('identity provider returned no id_token', 502);
  }
  return { idToken: parsed.id_token };
}

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function jwksFor(meta: ProviderMetadata): ReturnType<typeof createRemoteJWKSet> {
  const existing = jwksCache.get(meta.jwks_uri);
  if (existing) return existing;
  const set = createRemoteJWKSet(new URL(meta.jwks_uri), { timeoutDuration: OIDC_TIMEOUT_MS });
  jwksCache.set(meta.jwks_uri, set);
  return set;
}

/** Read a claim that providers variously supply as a string or a list. */
function claimList(payload: JWTPayload, key: string): string[] {
  const v = payload[key];
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string');
  if (typeof v === 'string' && v) return [v];
  return [];
}

export async function verifyIdToken(
  idToken: string,
  meta: ProviderMetadata,
  cfg: AuthSettings,
  expectedNonce: string,
): Promise<Principal> {
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(idToken, jwksFor(meta), {
      issuer: meta.issuer,
      audience: cfg.clientId,
      clockTolerance: 30,
    }));
  } catch (err) {
    throw new AuthError(`identity token failed verification: ${(err as Error).message}`, 401);
  }
  // Without this an attacker who captures an id_token issued for an earlier
  // login can replay it into a fresh flow.
  if (payload.nonce !== expectedNonce) {
    throw new AuthError('identity token nonce did not match this login attempt', 401);
  }
  const sub = typeof payload.sub === 'string' ? payload.sub : '';
  if (!sub) throw new AuthError('identity token carried no subject', 401);

  const email = typeof payload.email === 'string' ? payload.email : null;
  const name =
    (typeof payload.preferred_username === 'string' && payload.preferred_username) ||
    (typeof payload.name === 'string' && payload.name) ||
    email ||
    sub;
  return { sub, name, email, groups: claimList(payload, 'groups') };
}

/**
 * The group gate. Separate from verification because "the provider vouches for
 * you" and "you may use this portal" are different questions, and conflating
 * them is how an authorization bug gets written.
 */
export function isPermitted(principal: Principal, cfg: AuthSettings): boolean {
  const allowed = cfg.allowedGroups ?? [];
  if (allowed.length === 0) return true;
  return principal.groups.some((g) => allowed.includes(g));
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

declare module 'express-serve-static-core' {
  interface Request {
    /** Set by requireAuth. Absent when the portal runs without an IdP. */
    principal?: Principal;
  }
}

/** The identity recorded when the portal is deliberately running unauthenticated. */
export const ANONYMOUS_OPERATOR = 'operator';

/**
 * Request-scoped actor, propagated implicitly.
 *
 * Nine services append to the shared change log from roughly eighteen call
 * sites, several of them several frames deep inside a write pipeline. Passing
 * an actor down every one of those paths would mean changing every service
 * signature and every route — and, more importantly, one missed call site
 * would silently write an unattributed audit line, which is precisely the
 * defect this is meant to remove. Implicit propagation makes "every audit line
 * names someone" true by construction rather than by diligence.
 *
 * It is deliberately scoped to this one use. Nothing else should read it, and
 * it is never an input to an authorization decision — only to the record of
 * what happened.
 */
const actorStore = new AsyncLocalStorage<string>();

/** The actor for the request in flight, or the anonymous operator. */
export function currentActor(): string {
  return actorStore.getStore() ?? ANONYMOUS_OPERATOR;
}

/** Run `fn` with an explicit actor. Used by the WebSocket bridge and by tests. */
export function withActor<T>(who: string, fn: () => T): T {
  return actorStore.run(who, fn);
}

/**
 * Bind the authenticated principal to the request for audit purposes.
 *
 * Mounted after requireAuth so req.principal is populated. When no identity
 * provider is configured this still runs and still records `operator` — the
 * audit trail keeps saying something true rather than nothing at all.
 */
export function actorContext(): AuthGuard {
  return (req, _res, next) => {
    actorStore.run(actorFor(req), () => next());
  };
}

/**
 * Who to attribute a change to. Used by every audit call site, so that the
 * change log says `alice@example.com` when SSO is on and keeps saying
 * `operator` when it is not — rather than inventing a name it cannot support.
 */
export function actorFor(req: Pick<Request, 'principal'> | undefined): string {
  return req?.principal?.email || req?.principal?.name || ANONYMOUS_OPERATOR;
}

/**
 * Is this Origin one the portal is willing to accept a request from?
 *
 * Used by both the CSRF check below and the terminal WebSocket upgrade, which
 * is why it lives here rather than in either caller.
 *
 * A **missing** Origin is ALLOWED. Browsers always send it on state-changing
 * requests and on WebSocket upgrades, so absence means the caller is not a
 * browser — curl, a script, a health probe. Rejecting those would break
 * tooling while adding nothing, because anything that can omit the header can
 * equally set it to whatever passes. Origin bounds *browsers*; sessions bound
 * everything else.
 *
 * The rules, in order:
 *   - no Origin            → allow (not a browser; see above)
 *   - listed in HPE_ALLOWED_ORIGINS → allow (deliberate remote exposure)
 *   - loopback origin      → allow. A page served from this machine already
 *                            implies local code execution, and this keeps the
 *                            optional Vite dev server (a different port, see
 *                            web/vite.config.ts) working without configuration.
 *   - same host as the request → allow (the normal single-port deployment)
 *   - anything else        → reject
 */
export function isAllowedOrigin(
  origin: string | undefined,
  host: string | undefined,
  allowList: string | undefined = process.env.HPE_ALLOWED_ORIGINS,
): boolean {
  if (origin === undefined || origin === '') return true;

  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false; // an unparseable Origin is never a legitimate browser
  }

  const configured = (allowList ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
  if (configured.includes(origin)) return true;

  const hostname = parsed.hostname.toLowerCase();
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') return true;

  return host !== undefined && parsed.host.toLowerCase() === host.toLowerCase();
}

/**
 * Reject cross-site state-changing requests.
 *
 * This runs whether or not an identity provider is configured, and the
 * unauthenticated case is the one that needs it most: with no session cookie
 * there is no ambient authority for SameSite to protect, so any page in the
 * operator's browser can POST to http://127.0.0.1:5173 and change production
 * configuration. SameSite=Lax covers the authenticated case; this covers both.
 *
 * Worth stating plainly because it is easy to assume otherwise:
 * `reviewConfirmed: true` is **not** an access control. It is misclick
 * protection. An attacker composing a request simply includes the field.
 */
export function requireSameOrigin(allowList?: string): AuthGuard {
  return (req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
      next();
      return;
    }
    // Referer is the fallback for the rare client that suppresses Origin but
    // still identifies its page; only its origin is used, never its path.
    let origin = req.headers.origin;
    if (!origin && typeof req.headers.referer === 'string') {
      try {
        origin = new URL(req.headers.referer).origin;
      } catch {
        // A malformed Referer tells us nothing; fall through to the
        // no-origin case rather than inventing a verdict from garbage.
      }
    }
    if (isAllowedOrigin(origin, req.headers.host, allowList)) {
      next();
      return;
    }
    console.error(`refused cross-site ${req.method} ${req.path} from origin ${origin}`);
    res.status(403).json({ error: 'cross-site requests are not accepted' });
  };
}

export type AuthGuard = (req: Request, res: ExpressResponse, next: NextFunction) => void;

/**
 * Session check for a WebSocket upgrade, which never runs Express middleware
 * and so is not covered by requireAuth. Returns the actor name on success so
 * the caller can attribute the shell session it is about to open.
 */
export function authenticateUpgrade(
  store: SessionStore = sessionStore,
): (req: { headers: { cookie?: string } }) => { ok: true; who: string } | { ok: false } {
  return (req) => {
    const session = store.get(parseCookies(req.headers.cookie)[SESSION_COOKIE]);
    if (!session) return { ok: false };
    return { ok: true, who: actorFor({ principal: session.principal }) };
  };
}

/** Paths that must stay reachable without a session, or login is impossible. */
const OPEN_PATHS = new Set([
  '/api/health',
  '/api/auth/login',
  '/api/auth/callback',
  '/api/auth/me',
  '/api/auth/logout',
]);

/**
 * Open-path test that works wherever the guard is mounted.
 *
 * Express strips the mount prefix from `req.path`, so the same request is
 * `/api/auth/login` to a top-level middleware and `/auth/login` to one mounted
 * on '/api'. Normalising here means the guard cannot be accidentally weakened
 * (or accidentally lock login out) by moving where it is mounted.
 */
export function isOpenPath(path: string): boolean {
  let p = path.replace(/\/+$/, '') || '/';
  if (p !== '/api' && !p.startsWith('/api/')) p = `/api${p}`;
  return OPEN_PATHS.has(p);
}

/**
 * Whether this process actually installed the guard.
 *
 * The guard is chosen once, in `createApp`, from whether an identity provider
 * was configured at boot. Configuration written afterwards is therefore real
 * but not yet *in force*, and the difference matters enormously to an
 * operator: a portal that says "authentication enabled" while still serving
 * every route unauthenticated is precisely the green-badge-over-a-failure this
 * codebase refuses everywhere else. Recorded here so the config endpoint can
 * report the running truth rather than the intended one.
 */
let guardInstalled = false;

export function setAuthGuardInstalled(installed: boolean): void {
  guardInstalled = installed;
}

export function isAuthGuardInstalled(): boolean {
  return guardInstalled;
}

/**
 * Reject any API request without a live session.
 *
 * `/api/auth/me` is open on purpose: the web app calls it before it knows
 * whether it is signed in, and it answers `{ authenticated: false }` rather
 * than 401 so that a signed-out client renders a login screen instead of an
 * error.
 */
export function requireAuth(store: SessionStore = sessionStore): AuthGuard {
  return (req, res, next) => {
    if (isOpenPath(req.path)) return next();
    const cookies = parseCookies(req.headers.cookie);
    const session = store.get(cookies[SESSION_COOKIE]);
    if (!session) {
      res.status(401).json({ error: 'authentication required', login: '/api/auth/login' });
      return;
    }
    req.principal = session.principal;
    next();
  };
}
