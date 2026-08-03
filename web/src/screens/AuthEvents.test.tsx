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
 *      first successful poll;
 *  (g) an empty feed reads as a missing feed, never as "zero rejects, healthy".
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import AuthEvents from './AuthEvents';
import { SettingsProvider } from '../app/SettingsContext';
import { ToastProvider } from '../nightdesk';
import { getAuthEvents } from '../api/client';
import type { AuthEventsData } from '../api/client';
import type { AuthEventRow } from '@hpe/shared';

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
    <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
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

  /* The row used to carry only hh:mm:ss, rendered by the SERVER — which is
   * the reader's clock only while the two are the same machine. It sat in the
   * same table as a header stamp the browser renders itself, in the same
   * shape, with nothing saying they were different zones. */
  it('renders a live event on the reader\u2019s clock, not the server\u2019s', async () => {
    const at = new Date(2026, 6, 26, 14, 7, 3);
    mockGetAuthEvents.mockResolvedValue(
      liveData({ events: [{ ...EVENT, time: '22:07:03', at: at.toISOString() }] }),
    );
    renderAuthEvents();

    await waitFor(() => expect(screen.getByText('14:07:03')).toBeTruthy());
    // The server's own rendering of the same instant must not also appear.
    expect(screen.queryByText('22:07:03')).toBeNull();
  });

  it('keeps an authored row\u2019s time exactly as written when no instant rides with it', async () => {
    // Fixtures carry no `at`, and '09:41:02' is already the thing to display.
    mockGetAuthEvents.mockResolvedValue(liveData({ dataSource: 'demo' }));
    renderAuthEvents();

    await waitFor(() => expect(screen.getByText('09:41:02')).toBeTruthy());
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

  it('(d) an empty live feed names the missing policy plane, not the filter', async () => {
    mockGetAuthEvents.mockResolvedValue(liveData({ events: [] }));
    renderAuthEvents();

    expect(await screen.findByText('No auth events from any policy plane')).toBeTruthy();
    expect(
      screen.getByText(
        'ClearPass has not returned decisions for this window — check Connected systems.',
      ),
    ).toBeTruthy();
    expect(screen.queryByText('Nothing matches that filter')).toBeNull();
  });

  it('(e) a ?plane= deep-link with no rows stays visible and clearable in the Select', async () => {
    mockGetAuthEvents.mockResolvedValue(liveData({ events: [] }));
    render(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }} initialEntries={['/auth-events?plane=clearpass']}>
        <ToastProvider>
          <SettingsProvider>
            <AuthEvents />
          </SettingsProvider>
        </ToastProvider>
      </MemoryRouter>,
    );

    // The filter that is hiding everything names itself rather than rendering blank.
    expect(await screen.findByText('CLEARPASS (no events)')).toBeTruthy();
  });

  it('(g) an empty feed reads as a missing feed, not as zero rejects', async () => {
    mockGetAuthEvents.mockResolvedValue(
      // The server's liveAuthStats emits '—' / neutral for an empty feed; the
      // breakdown beneath it must not contradict that with a clean bill.
      liveData({
        events: [],
        stats: [
          { label: 'Rejects / hour', value: '—', delta: 'no auth feed in this window', tone: 'neutral' },
        ],
      }),
    );
    renderAuthEvents();

    expect(
      await screen.findByText(
        'No policy plane reported a decision, so there are no rejects to break down — a missing feed, not a clean one.',
      ),
    ).toBeTruthy();
    expect(
      screen.queryByText('No rejected authentications in this window — nothing to break down.'),
    ).toBeNull();

    // A feed that DID answer and simply held no rejects keeps the quiet reading.
    cleanup();
    mockGetAuthEvents.mockResolvedValue(liveData());
    renderAuthEvents();
    expect(
      await screen.findByText('No rejected authentications in this window — nothing to break down.'),
    ).toBeTruthy();
  });

  it('(f) labels the failure breakdown by the window it actually measured', async () => {
    const reasons = [{ label: 'Certificate expired', value: 12, note: '12 rejects' }];
    mockGetAuthEvents.mockResolvedValue(liveData({ failReasons: reasons }));
    renderAuthEvents();

    expect(await screen.findByText('CURRENT POLLER SNAPSHOT')).toBeTruthy();
    expect(screen.queryByText('LAST 24 HOURS')).toBeNull();

    cleanup();
    mockGetAuthEvents.mockResolvedValue(liveData({ failReasons: reasons, dataSource: 'demo' }));
    renderAuthEvents();
    expect(await screen.findByText('LAST 24 HOURS')).toBeTruthy();
  });
});

/* The TimeRangeControl narrows the feed client-side and lives in the URL as
 * ?range=, so a narrowed view is shareable. It can only narrow what the feed
 * holds — a live feed is the current poller snapshot — so when a range
 * reaches further back than the snapshot, or rows carry no timestamp at all,
 * the filter row says so instead of letting the range label overclaim. */
describe('AuthEvents time range', () => {
  const RECENT = () => new Date(Date.now() - 5 * 60_000).toISOString(); // 5m ago
  const OLD = () => new Date(Date.now() - 2 * 60 * 60_000).toISOString(); // 2h ago

  function twoRows(): AuthEventRow[] {
    return [
      { ...EVENT, who: 'recent.user', at: RECENT() },
      { ...EVENT, who: 'old.user', at: OLD() },
    ];
  }

  /** Exposes the query string so the range's URL sync is asserted, not assumed. */
  function SearchProbe() {
    const location = useLocation();
    return <div data-testid="search">{location.search}</div>;
  }

  function renderAt(entry: string) {
    return render(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }} initialEntries={[entry]}>
        <ToastProvider>
          <SettingsProvider>
            <AuthEvents />
            <SearchProbe />
          </SettingsProvider>
        </ToastProvider>
      </MemoryRouter>,
    );
  }

  it('a ?range= deep link lands pre-selected and narrows the log to the window', async () => {
    mockGetAuthEvents.mockResolvedValue(liveData({ events: twoRows() }));
    renderAt('/auth-events?range=15m');

    expect(await screen.findByText('1 of 2 shown')).toBeTruthy();
    expect(screen.getByText('recent.user')).toBeTruthy();
    expect(screen.queryByText('old.user')).toBeNull();
    expect(screen.getByRole('tab', { name: '15m' }).getAttribute('aria-selected')).toBe('true');
  });

  it('picking a range writes ?range= and All drops the param again', async () => {
    mockGetAuthEvents.mockResolvedValue(liveData({ events: twoRows() }));
    renderAt('/auth-events');

    fireEvent.click(await screen.findByRole('tab', { name: '1h' }));
    expect(screen.getByTestId('search').textContent).toBe('?range=1h');
    // The 2h-old row falls outside the picked hour.
    expect(await screen.findByText('1 of 2 shown')).toBeTruthy();

    fireEvent.click(screen.getByRole('tab', { name: 'All' }));
    expect(screen.getByTestId('search').textContent).toBe('');
    expect(await screen.findByText('2 of 2 shown')).toBeTruthy();
  });

  it('says so when the range reaches further back than the poller snapshot holds', async () => {
    mockGetAuthEvents.mockResolvedValue(liveData({ events: twoRows() }));
    renderAt('/auth-events?range=24h');

    // Both rows are inside 24h — nothing is hidden — but the feed itself is
    // minutes old, so "24h" must not read as a day of history.
    expect(await screen.findByText('2 of 2 shown')).toBeTruthy();
    expect(
      screen.getByText(/current poller snapshot — a 24h range reaches further back than the snapshot holds/),
    ).toBeTruthy();
  });

  it('keeps undated rows under any range and counts them in the caveat', async () => {
    mockGetAuthEvents.mockResolvedValue(
      liveData({ events: [{ ...EVENT, who: 'undated.row' }, { ...EVENT, who: 'recent.user', at: RECENT() }] }),
    );
    renderAt('/auth-events?range=15m');

    expect(await screen.findByText('2 of 2 shown')).toBeTruthy();
    expect(screen.getByText('undated.row')).toBeTruthy();
    expect(
      screen.getByText(/1 row carries no timestamp and stays shown whatever the range\./),
    ).toBeTruthy();
  });

  it('demo fixtures carry no timestamp, so a range keeps them and explains — without a snapshot claim', async () => {
    mockGetAuthEvents.mockResolvedValue(liveData({ dataSource: 'demo', events: [EVENT] }));
    renderAt('/auth-events?range=15m');

    expect(await screen.findByText('1 of 1 shown · 1,904 events indexed today')).toBeTruthy();
    expect(
      screen.getByText(/1 row carries no timestamp and stays shown whatever the range\./),
    ).toBeTruthy();
    // The snapshot caveat belongs to a live feed; demo never borrows it.
    expect(screen.queryByText(/current poller snapshot — a/)).toBeNull();
  });

  it('a window no event falls in reads as the filter, never as a missing feed', async () => {
    mockGetAuthEvents.mockResolvedValue(liveData({ events: [{ ...EVENT, who: 'old.user', at: OLD() }] }));
    renderAt('/auth-events?range=15m');

    expect(await screen.findByText('Nothing matches that filter')).toBeTruthy();
    expect(
      screen.getByText(
        'Loosen the result, service or plane filter — or widen the time range — to see more of the log.',
      ),
    ).toBeTruthy();
    expect(screen.queryByText('No auth events from any policy plane')).toBeNull();
  });

  it('an unrecognised range param reads as all — a typo cannot hide the log', async () => {
    mockGetAuthEvents.mockResolvedValue(liveData({ events: twoRows() }));
    renderAt('/auth-events?range=24');

    expect(await screen.findByText('2 of 2 shown')).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'All' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.queryByText(/reaches further back|no timestamp/)).toBeNull();
  });
});
