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

/** Dependency-free styling, matching the ErrorBoundary: this must render even if the shell cannot. */
const panel: React.CSSProperties = {
  minHeight: '100vh',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: 'var(--nd-bg-canvas)',
  padding: 32,
};

const card: React.CSSProperties = {
  maxWidth: 460,
  width: '100%',
  border: '1px solid var(--nd-border-default)',
  background: 'var(--nd-bg-raised)',
  padding: '28px 32px',
};

const eyebrow: React.CSSProperties = {
  fontFamily: 'var(--nd-font-mono)',
  fontSize: 'var(--nd-text-10)',
  letterSpacing: '.12em',
  textTransform: 'uppercase',
  color: 'var(--nd-text-secondary)',
};

const button: React.CSSProperties = {
  marginTop: 20,
  padding: '9px 16px',
  border: '1px solid var(--nd-border-strong)',
  background: 'var(--nd-accent)',
  color: 'var(--nd-bg-canvas)',
  fontSize: 'var(--nd-text-13)',
  cursor: 'pointer',
};

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
    return <div style={panel} aria-busy="true" />;
  }

  if (phase.kind === 'unreachable') {
    return (
      <div style={panel}>
        <div style={card}>
          <div style={{ ...eyebrow, color: 'var(--nd-danger)' }}>Server unreachable</div>
          <p style={{ marginTop: 10, fontSize: 'var(--nd-text-14)', color: 'var(--nd-text-primary)', lineHeight: 1.5 }}>
            The portal could not ask the server whether you are signed in, so it cannot show you
            anything yet. This usually means the server is not running.
          </p>
          <button type="button" style={button} onClick={check}>
            Try again
          </button>
        </div>
      </div>
    );
  }

  const { state } = phase;

  if (state.configured && !state.authenticated) {
    return (
      <div style={panel}>
        <div style={card}>
          <div style={eyebrow}>HPE Network Tools</div>
          <h1 style={{ margin: '10px 0 0', fontSize: 'var(--nd-text-18)', color: 'var(--nd-text-primary)' }}>
            {lapsed ? 'Your session has ended' : 'Sign in to continue'}
          </h1>
          <p style={{ marginTop: 10, fontSize: 'var(--nd-text-13)', color: 'var(--nd-text-secondary)', lineHeight: 1.5 }}>
            {lapsed
              ? 'The portal was signed out while you were working — usually because the server restarted, ' +
                'which clears every session. Nothing you had open was submitted by this. Sign in again to ' +
                'return to the page you were on.'
              : 'This portal brokers changes to production network equipment. Every change it makes is ' +
                'recorded against the account you sign in with.'}
          </p>
          {state.groupGate ? (
            <p style={{ marginTop: 10, fontSize: 'var(--nd-text-12)', color: 'var(--nd-text-secondary)' }}>
              Access is restricted to: {state.groupGate.join(', ')}
            </p>
          ) : null}
          <button type="button" style={button} onClick={() => startLogin()}>
            Sign in
          </button>
        </div>
      </div>
    );
  }

  return <AuthContext.Provider value={state}>{children}</AuthContext.Provider>;
}
