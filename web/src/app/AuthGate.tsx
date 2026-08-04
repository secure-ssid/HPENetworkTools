/**
 * web/src/app/AuthGate.tsx — the sign-in wall.
 *
 * Renders the portal only once the server has said sign-in is either
 * unnecessary or complete. Three distinct states, kept distinct on purpose:
 *
 *   checking      — we have not heard back yet. Render nothing but a quiet
 *                   placeholder. Rendering the portal here and pulling it away
 *                   a moment later is worse than a brief blank.
 *   unreachable   — the server did not answer. This is NOT "signed out" and
 *                   NOT "no auth configured": say the server could not be
 *                   reached and offer a retry, rather than showing a sign-in
 *                   button that cannot possibly work.
 *   signed out    — an identity provider is configured and we have no session.
 *
 * When no identity provider is configured the gate steps aside entirely and
 * says so in the shell, because "anyone can use this" is a fact an operator
 * should be able to see rather than infer from the absence of a login screen.
 */

import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { getAuthState, startLogin, type AuthState } from '../api/auth';
import { onAuthLapse } from '../api/core';
import { Button } from '../nightdesk';

/**
 * The resolved sign-in state, published so the shell can name the signed-in
 * operator without asking the server a second time. Only ever provided below
 * the gate, so consumers can rely on it being resolved.
 */
const AuthContext = createContext<AuthState | null>(null);

export function useAuth(): AuthState | null {
  return useContext(AuthContext);
}

type Phase = { kind: 'checking' } | { kind: 'unreachable' } | { kind: 'ready'; state: AuthState };

export function AuthGate({ children }: { children: ReactNode }) {
  const [phase, setPhase] = useState<Phase>({ kind: 'checking' });
  const [lapsed, setLapsed] = useState(false);

  /**
   * Asks the server where the session stands and settles the gate on the
   * answer. The mount effect runs this directly; the "Try again" button on
   * the unreachable panel wraps it in `check`, which first drops the gate
   * back to the quiet checking placeholder. That setState lives in the
   * click handler, not the effect: a synchronous setState from an effect
   * body is a cascading render, and on mount the placeholder is already
   * the initial state.
   */
  const ask = useCallback(() => {
    void getAuthState().then((state) => {
      setPhase(state ? { kind: 'ready', state } : { kind: 'unreachable' });
    });
  }, []);

  const check = useCallback(() => {
    setPhase({ kind: 'checking' });
    ask();
  }, [ask]);

  useEffect(ask, [ask]);

  /**
   * Catch a session that ends while the portal is open.
   *
   * The check above runs once, at mount. But sessions live in the server's
   * memory, so an ordinary server restart signs every open tab out mid-use.
   * Without this the tab carries on, and each screen reports its 401 through
   * its own data-error path — telling the operator their equipment could not
   * be read when in fact the portal no longer knows who they are, and offering
   * nothing to do about it.
   *
   * The 401 is a prompt to re-ask, never the answer itself. A 403 can be the
   * group gate biting on a single route, and an unreachable server is not the
   * same as a lost session — signing someone out on either would be a
   * fabrication of exactly the kind this codebase refuses elsewhere. Only the
   * server saying "you are not authenticated" closes the gate.
   */
  useEffect(() => {
    let live = true;
    let asking = false;
    const stop = onAuthLapse(() => {
      // Screens fail in a burst; one answer settles all of them.
      if (asking) return;
      asking = true;
      void getAuthState().then((state) => {
        asking = false;
        if (!live || !state) return;
        if (state.configured && !state.authenticated) {
          setLapsed(true);
          setPhase({ kind: 'ready', state });
        }
      });
    });
    return () => {
      live = false;
      stop();
    };
  }, []);

  if (phase.kind === 'checking') {
    return (
      <div className="nt-auth-panel nt-auth-panel--wake nt-war-room-wake" aria-busy="true">
        <div className="nt-auth-card nd-auth-card nt-auth-card--wake nt-panel-glass" aria-hidden>
          <div className="nt-auth-card__eyebrow nd-auth-card__eyebrow">HPE Network Tools · signing in</div>
          <div className="nt-auth-wake-bar" />
          <div className="nt-auth-wake-bar nt-auth-wake-bar--short" />
          <div className="nt-auth-wake-bar nt-auth-wake-bar--mid" />
        </div>
      </div>
    );
  }

  if (phase.kind === 'unreachable') {
    return (
      <div className="nt-auth-panel nt-auth-shell">
        <div className="nt-auth-card nd-auth-card nt-panel-glass">
          <div className="nt-auth-card__eyebrow nt-danger-text">
            HPE Network Tools · server unreachable
          </div>
          <p className="nt-auth-card__body nd-auth-card__body">
            The portal could not ask the server whether you are signed in, so it cannot show you
            anything yet. This usually means the server is not running.
          </p>
          <div className="nt-mt-20">
            <Button variant="primary" onClick={check}>
              Try again
            </Button>
          </div>
        </div>
      </div>
    );
  }

  const { state } = phase;

  if (state.configured && !state.authenticated) {
    return (
      <div className="nt-auth-panel nt-auth-shell">
        <div className="nt-auth-card nd-auth-card nt-panel-glass">
          <div className="nt-auth-panel__brand">
            <div className="nt-logo-mark" aria-hidden="true">HPE</div>
            <div className="nt-auth-card__eyebrow nd-auth-card__eyebrow">HPE Network Tools</div>
          </div>
          <h1 className="nt-auth-card__title nd-auth-card__title">
            {lapsed ? 'Your session has ended' : 'Sign in to continue'}
          </h1>
          <p className="nt-auth-card__body nd-auth-card__body">
            {lapsed
              ? 'The portal was signed out while you were working — usually because the server restarted, ' +
                'which clears every session. Nothing you had open was submitted by this. Sign in again to ' +
                'return to the page you were on.'
              : 'HPE Network Tools brokers changes to production network equipment. Every change is ' +
                'recorded against the account you sign in with.'}
          </p>
          {state.groupGate ? (
            <p className="nt-auth-card__body nd-auth-card__body">Access is restricted to: {state.groupGate.join(', ')}</p>
          ) : null}
          <div className="nt-mt-20">
            <Button variant="primary" onClick={() => startLogin()}>
              Sign in
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return <AuthContext.Provider value={state}>{children}</AuthContext.Provider>;
}
