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
