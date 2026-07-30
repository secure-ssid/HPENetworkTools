/**
 * web/src/app/AuthGate.test.tsx — the sign-in wall.
 *
 * The distinctions asserted here are the whole point of the component: an
 * unreachable server, a configured-but-signed-out portal, and a portal with no
 * identity provider all look identical to a naive implementation, and
 * conflating any two of them either hides a login the operator needs or shows
 * one that cannot possibly work.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthGate } from './AuthGate';
import { noteResponseStatus } from '../api/core';

const originalFetch = globalThis.fetch;

function answer(body: unknown, ok = true) {
  return vi.fn().mockResolvedValue({
    ok,
    json: async () => body,
  } as unknown as Response);
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

describe('AuthGate', () => {
  it('renders the portal when no identity provider is configured', async () => {
    globalThis.fetch = answer({ configured: false, authenticated: false, principal: null }) as never;
    render(
      <AuthGate>
        <div>portal</div>
      </AuthGate>,
    );
    expect(await screen.findByText('portal')).toBeTruthy();
  });

  it('renders the portal when signed in', async () => {
    globalThis.fetch = answer({
      configured: true,
      authenticated: true,
      principal: { sub: 'u', name: 'alice', email: 'alice@example.com', groups: [] },
    }) as never;
    render(
      <AuthGate>
        <div>portal</div>
      </AuthGate>,
    );
    expect(await screen.findByText('portal')).toBeTruthy();
  });

  it('shows a sign-in wall, and no portal, when configured but signed out', async () => {
    globalThis.fetch = answer({ configured: true, authenticated: false, principal: null }) as never;
    render(
      <AuthGate>
        <div>portal</div>
      </AuthGate>,
    );
    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeTruthy();
    expect(screen.queryByText('portal')).toBeNull();
  });

  it('names the required groups when access is restricted', async () => {
    globalThis.fetch = answer({
      configured: true,
      authenticated: false,
      principal: null,
      groupGate: ['net-admins', 'noc'],
    }) as never;
    render(
      <AuthGate>
        <div>portal</div>
      </AuthGate>,
    );
    expect(await screen.findByText(/net-admins, noc/)).toBeTruthy();
  });

  it('says the server is unreachable rather than offering a sign-in that cannot work', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('boom')) as never;
    render(
      <AuthGate>
        <div>portal</div>
      </AuthGate>,
    );
    expect(await screen.findByText('Server unreachable')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Sign in' })).toBeNull();
    expect(screen.queryByText('portal')).toBeNull();
  });

  it('treats a malformed answer as unreachable, not as "no auth configured"', async () => {
    // A truncated or proxied response must never be read as "the portal is
    // open" — that would silently drop the sign-in wall.
    globalThis.fetch = answer({ something: 'else' }) as never;
    render(
      <AuthGate>
        <div>portal</div>
      </AuthGate>,
    );
    expect(await screen.findByText('Server unreachable')).toBeTruthy();
    expect(screen.queryByText('portal')).toBeNull();
  });

  it('treats a non-OK response as unreachable', async () => {
    globalThis.fetch = answer({}, false) as never;
    render(
      <AuthGate>
        <div>portal</div>
      </AuthGate>,
    );
    expect(await screen.findByText('Server unreachable')).toBeTruthy();
  });

  it('retries on demand and renders the portal once the server answers', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('down'))
      .mockResolvedValueOnce({ ok: true, json: async () => ({ configured: false, authenticated: false }) } as unknown as Response);
    globalThis.fetch = fetchMock as never;
    render(
      <AuthGate>
        <div>portal</div>
      </AuthGate>,
    );
    await screen.findByText('Server unreachable');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('portal')).toBeTruthy();
  });

  it('renders no portal content while it is still checking', async () => {
    let release: (v: unknown) => void = () => {};
    globalThis.fetch = vi.fn().mockReturnValue(new Promise((r) => (release = r))) as never;
    render(
      <AuthGate>
        <div>portal</div>
      </AuthGate>,
    );
    expect(screen.queryByText('portal')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Sign in' })).toBeNull();
    release({ ok: true, json: async () => ({ configured: false, authenticated: false }) });
    await waitFor(() => expect(screen.getByText('portal')).toBeTruthy());
  });

  // A session that ends mid-use is the common case, not the exotic one:
  // sessions are held in the server's memory, so every restart ends all of
  // them. These pin that the gate re-asserts itself, and — just as important —
  // that it does not close over a 401 the server does not stand behind.
  describe('when a session ends while the portal is open', () => {
    it('shows the sign-in wall again, saying the session ended rather than repeating a first-visit prompt', async () => {
      globalThis.fetch = answer({ configured: true, authenticated: true, principal: { sub: 'u' } }) as never;
      render(
        <AuthGate>
          <div>portal</div>
        </AuthGate>,
      );
      await screen.findByText('portal');

      globalThis.fetch = answer({ configured: true, authenticated: false, principal: null }) as never;
      noteResponseStatus(401);

      expect(await screen.findByText('Your session has ended')).toBeTruthy();
      expect(screen.queryByText('portal')).toBeNull();
      expect(screen.getByRole('button', { name: 'Sign in' })).toBeTruthy();
    });

    it('keeps the portal open when the server still says we are signed in', async () => {
      // A 403 from the group gate on one route is not a lost session. Closing
      // the gate here would sign someone out over a permission they never had.
      globalThis.fetch = answer({ configured: true, authenticated: true, principal: { sub: 'u' } }) as never;
      render(
        <AuthGate>
          <div>portal</div>
        </AuthGate>,
      );
      await screen.findByText('portal');

      noteResponseStatus(403);
      await waitFor(() => expect(screen.getByText('portal')).toBeTruthy());
      expect(screen.queryByText('Your session has ended')).toBeNull();
    });

    it('keeps the portal open when the re-check cannot reach the server', async () => {
      globalThis.fetch = answer({ configured: true, authenticated: true, principal: { sub: 'u' } }) as never;
      render(
        <AuthGate>
          <div>portal</div>
        </AuthGate>,
      );
      await screen.findByText('portal');

      globalThis.fetch = vi.fn().mockRejectedValue(new Error('offline')) as never;
      noteResponseStatus(401);

      await waitFor(() => expect(screen.getByText('portal')).toBeTruthy());
      expect(screen.queryByText('Your session has ended')).toBeNull();
    });

    it('asks the server once for a burst of failing screens', async () => {
      globalThis.fetch = answer({ configured: true, authenticated: true, principal: { sub: 'u' } }) as never;
      render(
        <AuthGate>
          <div>portal</div>
        </AuthGate>,
      );
      await screen.findByText('portal');

      let release: (v: unknown) => void = () => {};
      const slow = vi.fn().mockReturnValue(new Promise((r) => (release = r)));
      globalThis.fetch = slow as never;
      for (let i = 0; i < 12; i++) noteResponseStatus(401);
      expect(slow).toHaveBeenCalledTimes(1);

      release({ ok: true, json: async () => ({ configured: true, authenticated: false }) });
      expect(await screen.findByText('Your session has ended')).toBeTruthy();
    });
  });
});
