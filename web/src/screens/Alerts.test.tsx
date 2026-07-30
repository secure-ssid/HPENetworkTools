/**
 * web/src/screens/Alerts.test.tsx — the queue's honesty rules.
 *
 * The api client is mocked at the module boundary (getAlerts / getTickets; the
 * rest stays real so SettingsProvider can use DEFAULT_SETTINGS).
 * Covered:
 *  (a) a live queue derives its danger banner from the rows and never asserts
 *      the prototype's Riverside Clinic / sw-riv-1 / 10.51.0.0/24 sentence;
 *  (b) a row whose source plane is behind reads `unverified`, not a current age;
 *  (c) a live queue with nothing open renders no banner at all;
 *  (d) a demo-sourced queue keeps the authored fixture banner verbatim;
 *  (e) the header stamps the section's source and last sync;
 *  (f) rows the plane already resolved are out of the queue and out of its
 *      count until the operator asks for them;
 *  (g) a device-less alert offers no Inspect action that lands nowhere;
 *  (h) an empty queue says so instead of blaming an unset filter;
 *  (i) rows sharing a title are keyed apart, so both render;
 *  (j) a correlation served by the route wins over the derived one, tone included;
 *  (k) …and its absence leaves the derived banner in place.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Alerts from './Alerts';
import { SettingsProvider } from '../app/SettingsContext';
import { ToastProvider } from '../nightdesk';
import { getAlerts, getTickets } from '../api/client';
import type { AlertsData } from '../api/client';
import type { AlertRow } from '@hpe/shared';

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
  return { ...actual, getAlerts: vi.fn(), getTickets: vi.fn(), ackAlert: vi.fn(), raiseTicket: vi.fn() };
});

const mockGetAlerts = vi.mocked(getAlerts);
const mockGetTickets = vi.mocked(getTickets);

const WORST: AlertRow = {
  sev: 'P1',
  tone: 'danger',
  title: 'gw-edge-1 unreachable',
  detail: 'wan1 down 4m · lte failover did not engage',
  siteId: 'campus-01',
  siteName: 'Campus-01 HQ',
  plane: 'CENTRAL',
  state: 'open',
  age: '4m',
  device: 'gw-edge-1',
};

const STALE_PARTNER: AlertRow = {
  sev: 'P2',
  tone: 'warning',
  title: 'inventory 6h stale',
  detail: 'api 429 rate-limited',
  siteId: 'campus-01',
  siteName: 'Campus-01 HQ',
  plane: 'CLASSIC',
  state: 'open',
  age: '6h',
  device: 'sw-acc-3f-2',
  stale: true,
};

/** Minimal live-mode envelope; per-test overrides go in `over`. */
function liveData(over: Partial<AlertsData> = {}): AlertsData {
  return { alerts: [WORST, STALE_PARTNER], syncedAt: null, dataSource: 'live', ...over };
}

function renderAlerts() {
  return render(
    <MemoryRouter>
      <ToastProvider>
        <SettingsProvider>
          <Alerts />
        </SettingsProvider>
      </ToastProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  mockGetTickets.mockResolvedValue({ tickets: [], dataSource: 'live' });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('Alerts', () => {
  it('(a) derives the danger banner from the live queue, never the fixture sentence', async () => {
    mockGetAlerts.mockResolvedValue(liveData());
    renderAlerts();

    expect(await screen.findByText('gw-edge-1 unreachable — and CLASSIC is stale')).toBeTruthy();
    expect(screen.getByText(/wan1 down 4m · lte failover did not engage · Campus-01 HQ · CENTRAL · 4m\./)).toBeTruthy();
    expect(screen.getByText(/Second finding: inventory 6h stale/)).toBeTruthy();
    expect(screen.queryByText(/Riverside Clinic is dark/)).toBeNull();
    expect(screen.queryByText(/10\.51\.0\.0\/24/)).toBeNull();
    expect(screen.queryByText(/sw-riv-1/)).toBeNull();
  });

  it('(b) marks a row from a plane that is behind as unverified, not current', async () => {
    mockGetAlerts.mockResolvedValue(liveData());
    renderAlerts();

    expect(await screen.findByText('6h · unverified')).toBeTruthy();
    expect(screen.getByText('stale')).toBeTruthy();
    // The fresh row keeps its plain age.
    expect(screen.getByText('4m')).toBeTruthy();
  });

  it('(c) renders no banner when the live queue holds nothing open', async () => {
    mockGetAlerts.mockResolvedValue(liveData({ alerts: [] }));
    renderAlerts();

    await waitFor(() => expect(screen.getByText('0 of 0 alerts · live')).toBeTruthy());
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('(d) keeps the authored banner for a demo-sourced queue', async () => {
    mockGetAlerts.mockResolvedValue(liveData({ dataSource: 'demo' }));
    renderAlerts();

    expect(await screen.findByText('Riverside Clinic is dark — and its plane is stale')).toBeTruthy();
    expect(screen.getByText(/inspect sw-riv-1 over SSH instead\./)).toBeTruthy();
    expect(screen.getByText('2 of 2 alerts · demo fixtures')).toBeTruthy();
  });

  it('(e) stamps the section source and last sync in the header', async () => {
    mockGetAlerts.mockResolvedValue(liveData({ syncedAt: '2026-07-26T09:05:00' }));
    renderAlerts();

    expect(await screen.findByText('SYNCED 09:05')).toBeTruthy();
    expect(screen.queryByText(/2026-07-26/)).toBeNull();
  });

  it('(f) keeps rows the plane resolved out of the queue and out of its count', async () => {
    const CLEARED: AlertRow = {
      sev: 'P3',
      tone: 'info',
      title: 'Config Out of Sync',
      detail: 'resolved by Central 2h ago',
      siteId: 'campus-01',
      siteName: 'Campus-01 HQ',
      plane: 'CENTRAL',
      state: 'cleared',
      age: '2h',
      device: 'sw-acc-3f-1',
    };
    mockGetAlerts.mockResolvedValue(liveData({ alerts: [WORST, CLEARED] }));
    renderAlerts();

    // The resolved row is neither shown nor counted, and the queue says why.
    await waitFor(() =>
      expect(screen.getByText('1 of 1 alerts · 1 cleared hidden · live')).toBeTruthy(),
    );
    expect(screen.queryByText('resolved by Central 2h ago')).toBeNull();

    fireEvent.click(screen.getByRole('switch', { name: 'Include cleared' }));
    await waitFor(() => expect(screen.getByText('2 of 2 alerts · live')).toBeTruthy());
    expect(screen.getByText('resolved by Central 2h ago')).toBeTruthy();
  });

  it('(g) offers no Inspect on an alert that names no device', async () => {
    const SITE_ALERT: AlertRow = { ...WORST, title: 'WAN degraded', device: '' };
    mockGetAlerts.mockResolvedValue(liveData({ alerts: [SITE_ALERT] }));
    renderAlerts();

    expect(await screen.findByText('no device')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Inspect' })).toBeNull();
  });

  it('(h) an empty live queue reads as empty, never as a filter hiding rows', async () => {
    mockGetAlerts.mockResolvedValue(liveData({ alerts: [], syncedAt: null }));
    renderAlerts();

    expect(await screen.findByText('No alerts in the queue')).toBeTruthy();
    expect(
      screen.getByText('No plane has reported yet — link one under Connected systems.'),
    ).toBeTruthy();
    expect(screen.queryByText('Nothing matches that filter')).toBeNull();
  });

  it('(j) renders a served correlation, with its own tone, ahead of the derived one', async () => {
    // The route may compute the banner from facts no row carries (plane sync
    // ages, call budgets) and state its own severity. When it does, the screen
    // must show that one instead of re-deriving a weaker banner beside it.
    mockGetAlerts.mockResolvedValue({
      ...liveData(),
      correlation: {
        title: 'Two planes are behind and one site is dark',
        body: 'Central last answered 6h ago; the local collector still reaches 10.51.0.0/24.',
        tone: 'warning',
      },
    } as AlertsData);
    const { container } = renderAlerts();

    expect(await screen.findByText('Two planes are behind and one site is dark')).toBeTruthy();
    // The row-derived banner is not rendered alongside it.
    expect(screen.queryByText('gw-edge-1 unreachable — and CLASSIC is stale')).toBeNull();
    expect(container.querySelector('.nd-alert--warning')).toBeTruthy();
    expect(container.querySelector('.nd-alert--danger')).toBeNull();
  });

  it('(k) falls back to the derived banner when no correlation is served', async () => {
    mockGetAlerts.mockResolvedValue({ ...liveData(), correlation: null } as AlertsData);
    renderAlerts();

    expect(await screen.findByText('gw-edge-1 unreachable — and CLASSIC is stale')).toBeTruthy();
  });

  it('(i) keys rows on the plane identity, so two rows sharing a title do not collide', async () => {
    const drift = (device: string, alertId: string): AlertRow => ({
      ...WORST,
      sev: 'P3',
      tone: 'info',
      title: 'Config Out of Sync',
      detail: `${device} drift`,
      device,
      alertId,
    });
    mockGetAlerts.mockResolvedValue(
      liveData({ alerts: [drift('sw-a', 'k1'), drift('sw-b', 'k2')] }),
    );
    const errors: unknown[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...args) => errors.push(args[0]));
    renderAlerts();

    await waitFor(() => expect(screen.getByText('sw-a drift')).toBeTruthy());
    expect(screen.getByText('sw-b drift')).toBeTruthy();
    expect(errors.some((e) => typeof e === 'string' && /same key/i.test(e))).toBe(false);
    spy.mockRestore();
  });
});
