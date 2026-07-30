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

  const check = useCallback(() => {
    setPhase({ kind: 'checking' });
    void getAuthState().then((state) => {
      setPhase(state ? { kind: 'ready', state } : { kind: 'unreachable' });
    });
  }, []);

  useEffect(check, [check]);

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
            Sign in to continue
          </h1>
          <p style={{ marginTop: 10, fontSize: 'var(--nd-text-13)', color: 'var(--nd-text-secondary)', lineHeight: 1.5 }}>
            This portal brokers changes to production network equipment. Every change it makes is
            recorded against the account you sign in with.
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
