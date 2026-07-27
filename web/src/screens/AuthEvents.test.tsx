/**
 * web/src/screens/AuthEvents.test.tsx — provenance of the RADIUS log.
 *
 * The api client is mocked at the module boundary (getAuthEvents only; the rest
 * stays real so SettingsProvider can use DEFAULT_SETTINGS).
 * Covered:
 *  (a) a live feed counts only the decisions it holds — the fixture's
 *      "1,904 events indexed today" tail never renders over live rows;
 *  (b) a demo-sourced feed keeps that authored tail verbatim;
 *  (c) the header stamps the last sync so a degraded ClearPass's last-good
 *      cache cannot pass for current, and an em-dash stands in before the
 *      first successful poll.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import AuthEvents from './AuthEvents';
import { SettingsProvider } from '../app/SettingsContext';
import { ToastProvider } from '../nightdesk';
import { getAuthEvents } from '../api/client';
import type { AuthEventsData } from '../api/client';
import type { AuthEventRow } from '../../../shared';

if (!window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
}

if (typeof globalThis.ResizeObserver === 'undefined') {
  class ResizeObserverStub {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
}

vi.mock('../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/client')>();
  return { ...actual, getAuthEvents: vi.fn() };
});

const mockGetAuthEvents = vi.mocked(getAuthEvents);

const EVENT: AuthEventRow = {
  time: '09:41:02',
  who: 'a.rivera',
  mac: '3c:a9:ab:7c:a9:51',
  service: 'Corp 802.1X',
  method: 'EAP-TLS',
  result: 'accept',
  tone: 'success',
  reason: 'Machine + user certificate valid',
  role: 'corp-employee',
  nas: 'sw-acc-3f-2',
  plane: 'CLEARPASS',
};

/** Minimal live-mode envelope; per-test overrides go in `over`. */
function liveData(over: Partial<AuthEventsData> = {}): AuthEventsData {
  return {
    stats: [],
    events: [EVENT],
    failReasons: [],
    policyServices: [],
    syncedAt: null,
    dataSource: 'live',
    ...over,
  };
}

function renderAuthEvents() {
  return render(
    <MemoryRouter>
      <ToastProvider>
        <SettingsProvider>
          <AuthEvents />
        </SettingsProvider>
      </ToastProvider>
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('AuthEvents', () => {
  it('(a) a live feed counts only the decisions it holds', async () => {
    mockGetAuthEvents.mockResolvedValue(liveData());
    renderAuthEvents();

    await waitFor(() => expect(screen.getByText('1 of 1 shown')).toBeTruthy());
    expect(screen.queryByText(/1,904 events indexed today/)).toBeNull();
  });

  it('(b) a demo-sourced feed keeps the authored indexed-today tail', async () => {
    mockGetAuthEvents.mockResolvedValue(liveData({ dataSource: 'demo' }));
    renderAuthEvents();

    await waitFor(() =>
      expect(screen.getByText('1 of 1 shown · 1,904 events indexed today')).toBeTruthy(),
    );
  });

  it('(c) the header stamps the last sync, em-dash before the first poll', async () => {
    mockGetAuthEvents.mockResolvedValue(liveData({ syncedAt: '2026-07-26T09:05:00' }));
    const view = renderAuthEvents();

    expect(await screen.findByText('SYNCED 09:05')).toBeTruthy();
    expect(screen.queryByText(/2026-07-26/)).toBeNull();

    view.unmount();
    mockGetAuthEvents.mockResolvedValue(liveData({ syncedAt: null }));
    renderAuthEvents();
    const stamp = await screen.findByText('SYNCED —');
    expect(stamp.textContent).not.toContain('null');
  });
});
