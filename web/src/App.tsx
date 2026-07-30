import { Component } from 'react';
import type { ReactNode } from 'react';
import { SettingsProvider } from './app/SettingsContext';
import { AuthGate } from './app/AuthGate';
import { AppRoutes } from './app/routes';

/**
 * Last-resort render guard: a throwing screen renders an honest error panel
 * instead of unmounting the whole portal. Deliberately dependency-free (no
 * nightdesk imports) so the panel survives whatever broke the screen.
 */
class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div
        style={{
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'var(--nd-bg-canvas)',
          padding: 32,
        }}
      >
        <div
          style={{
            maxWidth: 520,
            width: '100%',
            border: '1px solid var(--nd-border-default)',
            background: 'var(--nd-bg-raised)',
            padding: '28px 32px',
          }}
        >
          <div
            style={{
              fontFamily: 'var(--nd-font-mono)',
              fontSize: 'var(--nd-text-10)',
              letterSpacing: '.12em',
              textTransform: 'uppercase',
              color: 'var(--nd-danger)',
            }}
          >
            Render error
          </div>
          <div
            style={{
              marginTop: 10,
              fontSize: 'var(--nd-text-14)',
              color: 'var(--nd-text-primary)',
              lineHeight: 1.5,
            }}
          >
            This screen failed to render. The portal itself is still running — reloading returns to
            the last working state.
          </div>
          <div
            style={{
              marginTop: 14,
              paddingTop: 14,
              borderTop: '1px solid var(--nd-border-subtle)',
              fontFamily: 'var(--nd-font-mono)',
              fontSize: 'var(--nd-text-11)',
              color: 'var(--nd-text-muted)',
              overflowWrap: 'anywhere',
            }}
          >
            {error.message}
          </div>
          <button
            type="button"
            onClick={() => window.location.reload()}
            style={{
              marginTop: 18,
              background: 'none',
              border: '1px solid var(--nd-border-strong)',
              padding: '6px 14px',
              cursor: 'pointer',
              fontFamily: 'var(--nd-font-mono)',
              fontSize: 'var(--nd-text-11)',
              color: 'var(--nd-accent-text)',
            }}
          >
            Reload the portal
          </button>
        </div>
      </div>
    );
  }
}

export default function App() {
  return (
    // ErrorBoundary outermost so a crash anywhere below it — including in the
    // sign-in gate itself — still renders an honest panel.
    //
    // AuthGate wraps SettingsProvider rather than the other way round: the
    // provider fetches /api/settings on mount, which is a guarded route. Asking
    // for it before we know whether we are signed in produces a 401 the user
    // never sees and a settings error that is really an auth error.
    <ErrorBoundary>
      <AuthGate>
        <SettingsProvider>
          <AppRoutes />
        </SettingsProvider>
      </AuthGate>
    </ErrorBoundary>
  );
}
