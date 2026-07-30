/**
 * web/src/api/auth.ts — sign-in state.
 *
 * Deliberately separate from api/client.ts. Every getter there falls back to
 * fixtures when the backend is unreachable, which is exactly the wrong
 * behaviour for authentication: a portal that cannot reach its own server must
 * never decide it is signed in. These two calls have no fallback and no demo
 * mode — they report what the server said, or they fail.
 */

export interface AuthPrincipal {
  sub: string;
  name: string;
  email: string | null;
  groups: string[];
}

export interface AuthState {
  /** Is an identity provider configured at all? */
  configured: boolean;
  authenticated: boolean;
  principal: AuthPrincipal | null;
  /** Groups the portal is restricted to, when it is restricted. */
  groupGate: string[] | null;
}

/**
 * Ask the server who we are.
 *
 * Returns null when the server could not be reached or did not answer with
 * the expected shape — the caller must treat that as "unknown", not as
 * "signed out" and not as "no auth configured". Guessing either way is how a
 * portal ends up showing a login wall it cannot satisfy, or hiding one it
 * needs.
 */
export async function getAuthState(): Promise<AuthState | null> {
  try {
    const res = await fetch('/api/auth/me', { credentials: 'same-origin' });
    if (!res.ok) return null;
    const body = (await res.json()) as Partial<AuthState>;
    if (typeof body.configured !== 'boolean' || typeof body.authenticated !== 'boolean') return null;
    return {
      configured: body.configured,
      authenticated: body.authenticated,
      principal: body.principal ?? null,
      groupGate: body.groupGate ?? null,
    };
  } catch {
    return null;
  }
}

/** Start the OIDC flow, returning here afterwards. A full navigation, not fetch. */
export function startLogin(returnTo: string = window.location.pathname + window.location.search): void {
  window.location.href = `/api/auth/login?returnTo=${encodeURIComponent(returnTo)}`;
}

export async function logout(): Promise<void> {
  await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
  // Full reload rather than a state update: every cached screen in memory was
  // read with the old session, and keeping any of it on screen after signing
  // out would show one operator's data to whoever signs in next.
  window.location.href = '/';
}

// ---------------------------------------------------------------------------
// Configuration — /api/auth/config and /api/auth/test
//
// Same rule as above, for the same reason: no fallback, no demo mode. An
// unreachable backend is reported as unreachable rather than as "no identity
// provider", because those are opposite situations for an operator.
// ---------------------------------------------------------------------------

export interface AuthConfigView {
  /** A provider is recorded in settings. */
  configured: boolean;
  /**
   * This server process is actually enforcing one. Differs from `configured`
   * for as long as it takes to restart after saving the first provider — and
   * during that window every route is still served unauthenticated.
   */
  active: boolean;
  source: 'environment' | 'settings' | 'none';
  /** False when HPE_OIDC_* owns the configuration, so saving here would lie. */
  editable: boolean;
  issuer: string | null;
  clientId: string | null;
  /** Masked when set; never the real value. */
  clientSecret: string | null;
  redirectUri: string | null;
  allowedGroups: string[] | null;
}

export interface AuthConfigInput {
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  allowedGroups?: string[];
}

export interface AuthTestResult {
  ok: boolean;
  message: string;
  ms?: number;
  endpoints?: { authorization: string; token: string; jwks: string };
  /** True things worth saying that are not grounds for failing the test. */
  cautions?: string[];
  hint?: string | null;
}

export interface AuthWriteResult {
  ok: boolean;
  message: string;
  /** The guard is installed at boot, so a save may not be in force yet. */
  restartRequired?: boolean;
  config?: AuthConfigView;
}

const UNREACHABLE = 'cannot reach the portal backend';

/** Read the configured provider. Returns an error string rather than guessing. */
export async function getAuthConfig(): Promise<AuthConfigView | { error: string }> {
  try {
    const res = await fetch('/api/auth/config', { credentials: 'same-origin' });
    if (res.ok) return (await res.json()) as AuthConfigView;
    return { error: await authMessage(res, `could not read the identity provider — HTTP ${res.status}`) };
  } catch (err) {
    return { error: `${UNREACHABLE}: ${(err as Error).message}` };
  }
}

/**
 * POST /api/auth/test. A failed test is a normal result, not an exception: the
 * server answers 502 with the reason it failed, and that reason is precisely
 * what the operator needs to read.
 */
export async function testAuthConfig(input: Partial<AuthConfigInput>): Promise<AuthTestResult> {
  try {
    const res = await fetch('/api/auth/test', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    const body = (await res.json().catch(() => ({}))) as Partial<AuthTestResult> & { error?: string };
    if (typeof body.ok === 'boolean' && typeof body.message === 'string') return body as AuthTestResult;
    return { ok: false, message: body.error ?? `test failed — HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, message: `${UNREACHABLE}: ${(err as Error).message}` };
  }
}

export async function saveAuthConfig(input: AuthConfigInput): Promise<AuthWriteResult> {
  return writeAuthConfig('PUT', input);
}

export async function removeAuthConfig(): Promise<AuthWriteResult> {
  return writeAuthConfig('DELETE');
}

async function writeAuthConfig(method: 'PUT' | 'DELETE', input?: AuthConfigInput): Promise<AuthWriteResult> {
  try {
    const res = await fetch('/api/auth/config', {
      method,
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      ...(input ? { body: JSON.stringify(input) } : {}),
    });
    if (!res.ok) {
      return { ok: false, message: await authMessage(res, `save failed — HTTP ${res.status}`) };
    }
    const body = (await res.json()) as AuthConfigView & { note?: string; restartRequired?: boolean };
    return {
      ok: true,
      // The server's note is the honest one: it distinguishes "saved and in
      // force" from "saved, but this process is still unauthenticated".
      message: body.note ?? 'Saved.',
      restartRequired: body.restartRequired,
      config: body,
    };
  } catch (err) {
    return { ok: false, message: `${UNREACHABLE}: ${(err as Error).message}` };
  }
}

/** Prefer the server's own explanation; fall back only when there is none. */
async function authMessage(res: Response, fallback: string): Promise<string> {
  try {
    const body = (await res.json()) as { error?: unknown; message?: unknown };
    const text = body.error ?? body.message;
    return typeof text === 'string' && text ? text : fallback;
  } catch {
    return fallback;
  }
}
