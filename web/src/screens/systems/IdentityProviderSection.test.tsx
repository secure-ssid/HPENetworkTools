/**
 * web/src/screens/systems/IdentityProviderSection.test.tsx
 *
 * The assertions worth having here are all about the same thing: the portal
 * must never claim more protection than it has. A saved provider is not an
 * enforced one until the server restarts, and a provider that answered
 * discovery is not one that accepted the client credentials. Both distinctions
 * are invisible to a test that only checks the happy path, so both are pinned
 * below.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { IdentityProviderSection } from './IdentityProviderSection';
import { ToastProvider } from '../../nightdesk';
import { getAuthConfig, removeAuthConfig, saveAuthConfig, testAuthConfig } from '../../api/auth';
import type { AuthConfigView } from '../../api/auth';

vi.mock('../../api/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/auth')>();
  return {
    ...actual,
    getAuthConfig: vi.fn(),
    testAuthConfig: vi.fn(),
    saveAuthConfig: vi.fn(),
    removeAuthConfig: vi.fn(),
  };
});

const CONFIGURED: AuthConfigView = {
  configured: true,
  active: true,
  source: 'settings',
  editable: true,
  issuer: 'https://id.securessid.com/application/o/portal/',
  clientId: 'portal-client',
  clientSecret: '••••••',
  redirectUri: 'http://127.0.0.1:5173/api/auth/callback',
  allowedGroups: ['net-admins'],
};

const NONE: AuthConfigView = {
  configured: false,
  active: false,
  source: 'none',
  editable: true,
  issuer: null,
  clientId: null,
  clientSecret: null,
  redirectUri: null,
  allowedGroups: null,
};

function mount() {
  return render(
    <ToastProvider>
      <IdentityProviderSection />
    </ToastProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('identity provider section', () => {
  it('shows the configured provider with the secret still masked', async () => {
    vi.mocked(getAuthConfig).mockResolvedValue(CONFIGURED);
    mount();
    await waitFor(() => expect((screen.getByLabelText('OIDC client ID') as HTMLInputElement).value).toBe('portal-client'));
    expect((screen.getByLabelText('OIDC issuer') as HTMLInputElement).value).toBe(CONFIGURED.issuer);
    expect((screen.getByLabelText('OIDC client secret') as HTMLInputElement).value).toBe('••••••');
    expect(screen.getByText('enforced')).toBeTruthy();
  });

  it('says every route is open when no provider is configured', async () => {
    vi.mocked(getAuthConfig).mockResolvedValue(NONE);
    mount();
    await waitFor(() =>
      expect(screen.getByText(/no identity provider — every route is open/)).toBeTruthy(),
    );
    expect(screen.getByText(/attributed to/)).toBeTruthy();
  });

  it('refuses to call a saved-but-unenforced provider protection', async () => {
    // The window after saving into a process that booted without auth. The
    // configuration is real; the protection is not. Saying "enforced" here
    // would tell an operator their portal is closed while it is wide open.
    vi.mocked(getAuthConfig).mockResolvedValue({ ...CONFIGURED, active: false });
    mount();
    await waitFor(() =>
      expect(screen.getByText('configured — not in force until restart')).toBeTruthy(),
    );
    expect(screen.getByText('Saved, but not yet enforced')).toBeTruthy();
    expect(screen.queryByText('enforced')).toBeNull();
  });

  it('reports a rejected client as a failure, not as a reachable provider', async () => {
    vi.mocked(getAuthConfig).mockResolvedValue(CONFIGURED);
    vi.mocked(testAuthConfig).mockResolvedValue({
      ok: false,
      message: 'discovery succeeded at https://id — the provider rejected the client id or secret',
    });
    mount();
    await waitFor(() => expect(screen.getByLabelText('OIDC client ID')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Test provider' }));
    await waitFor(() => expect(screen.getByText('Test failed')).toBeTruthy());
    expect(screen.getByText(/rejected the client id or secret/)).toBeTruthy();
  });

  it('shows the endpoints and cautions a passing test came back with', async () => {
    vi.mocked(getAuthConfig).mockResolvedValue(CONFIGURED);
    vi.mocked(testAuthConfig).mockResolvedValue({
      ok: true,
      message: 'discovery succeeded — the provider accepted the client id and secret',
      ms: 42,
      endpoints: {
        authorization: 'https://id/authorize',
        token: 'https://id/token',
        jwks: 'https://id/jwks',
      },
      cautions: ['this must match a redirect URI registered on the provider exactly'],
    });
    mount();
    await waitFor(() => expect(screen.getByLabelText('OIDC client ID')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Test provider' }));
    await waitFor(() => expect(screen.getByText('Provider answered')).toBeTruthy());
    // Scoped to the result alert: the same wording appears as help text on the
    // redirect URI field, and matching that instead would prove nothing.
    const result = screen.getByRole('alert');
    expect(within(result).getByText(/jwks: https:\/\/id\/jwks/)).toBeTruthy();
    expect(within(result).getByText(/registered on the provider exactly/)).toBeTruthy();
  });

  it('sends the edited values, splitting the group list', async () => {
    vi.mocked(getAuthConfig).mockResolvedValue(CONFIGURED);
    vi.mocked(saveAuthConfig).mockResolvedValue({ ok: true, message: 'Saved.', restartRequired: false });
    mount();
    await waitFor(() => expect(screen.getByLabelText('OIDC client ID')).toBeTruthy());
    fireEvent.change(screen.getByLabelText('OIDC allowed groups'), {
      target: { value: ' net-admins , noc ,' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save provider' }));
    await waitFor(() => expect(saveAuthConfig).toHaveBeenCalled());
    expect(vi.mocked(saveAuthConfig).mock.calls[0][0]).toMatchObject({
      clientId: 'portal-client',
      allowedGroups: ['net-admins', 'noc'],
    });
  });

  it('round-trips the mask rather than blanking a secret it never received', async () => {
    // The real secret never reaches the browser. Submitting the mask untouched
    // is what tells the server "unchanged"; sending an empty string would
    // silently clear it.
    vi.mocked(getAuthConfig).mockResolvedValue(CONFIGURED);
    vi.mocked(saveAuthConfig).mockResolvedValue({ ok: true, message: 'Saved.' });
    mount();
    await waitFor(() => expect(screen.getByLabelText('OIDC client ID')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Save provider' }));
    await waitFor(() => expect(saveAuthConfig).toHaveBeenCalled());
    expect(vi.mocked(saveAuthConfig).mock.calls[0][0].clientSecret).toBe('••••••');
  });

  it('locks the form when the environment owns the configuration', async () => {
    vi.mocked(getAuthConfig).mockResolvedValue({ ...CONFIGURED, source: 'environment', editable: false });
    mount();
    await waitFor(() => expect(screen.getByText('Configured through the environment')).toBeTruthy());
    expect((screen.getByLabelText('OIDC issuer') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Save provider' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole('button', { name: 'Remove provider' })).toBeNull();
  });

  it('says the backend was unreachable rather than showing no provider', async () => {
    // These are opposite situations: one is "set up your identity provider",
    // the other is "your portal backend is down". Collapsing them would send
    // an operator to reconfigure something that was never broken.
    vi.mocked(getAuthConfig).mockResolvedValue({ error: 'cannot reach the portal backend: failed to fetch' });
    mount();
    await waitFor(() =>
      expect(screen.getByText(/cannot reach the portal backend/)).toBeTruthy(),
    );
    expect(screen.queryByText(/no identity provider/)).toBeNull();
  });

  it('re-reads after removing so the badge cannot go stale', async () => {
    vi.mocked(getAuthConfig).mockResolvedValueOnce(CONFIGURED).mockResolvedValueOnce(NONE);
    vi.mocked(removeAuthConfig).mockResolvedValue({ ok: true, message: 'Removed.', restartRequired: true });
    mount();
    await waitFor(() => expect(screen.getByText('enforced')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Remove provider' }));
    await waitFor(() =>
      expect(screen.getByText(/no identity provider — every route is open/)).toBeTruthy(),
    );
  });
});
