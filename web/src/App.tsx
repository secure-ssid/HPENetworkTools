import { Component } from 'react';
import type { ReactNode } from 'react';
import { SettingsProvider } from './app/SettingsContext';
import { IncidentProvider } from './app/IncidentContext';
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
        className="nt-boot-error"
      >
        <div
          className="nt-boot-error__card"
        >
          <div
            className="nt-boot-error__kicker"
          >
            HPE Network Tools · render fault
          </div>
          <div
            className="nt-boot-error__title"
          >
            This screen failed to render. HPE Network Tools is still running — reload returns to the last
            working state.
          </div>
          <div
            className="nt-boot-error__detail"
          >
            {error.message}
          </div>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="nt-boot-error__reload"
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
          <IncidentProvider>
            <AppRoutes />
          </IncidentProvider>
        </SettingsProvider>
      </AuthGate>
    </ErrorBoundary>
  );
}
