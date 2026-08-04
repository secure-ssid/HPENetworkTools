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
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
    // Loop 127 — Clear filters restores the full feed from the empty state.
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(await screen.findByText('1 of 1 shown')).toBeTruthy();
    expect(screen.getByText('old.user')).toBeTruthy();
  });

  it('an unrecognised range param reads as all — a typo cannot hide the log', async () => {
    mockGetAuthEvents.mockResolvedValue(liveData({ events: twoRows() }));
    renderAt('/auth-events?range=24');

    expect(await screen.findByText('2 of 2 shown')).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'All' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.queryByText(/reaches further back|no timestamp/)).toBeNull();
  });
});

/* Loop 61 — filter share completeness + server q/plane on paged fetches. */
describe('AuthEvents filter share (Loop 61)', () => {
  it('seeds result/service from the URL and Copy view link keeps them', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    mockGetAuthEvents.mockResolvedValue(
      liveData({
        events: [
          { ...EVENT, who: 'ok.user', result: 'accept', service: 'Corp 802.1X' },
          { ...EVENT, who: 'bad.user', result: 'reject', service: 'Guest', tone: 'danger', reason: 'bad' },
        ],
      }),
    );

    function SearchProbe() {
      const loc = useLocation();
      return <div data-testid="search">{loc.search}</div>;
    }

    render(
      <MemoryRouter
        future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
        initialEntries={['/auth-events?result=reject&service=Guest']}
      >
        <ToastProvider>
          <SettingsProvider>
            <AuthEvents />
            <SearchProbe />
          </SettingsProvider>
        </ToastProvider>
      </MemoryRouter>,
    );

    expect(await screen.findByText('bad.user')).toBeTruthy();
    expect(screen.queryByText('ok.user')).toBeNull();
    await waitFor(() => expect(screen.getByTestId('search').textContent).toMatch(/result=reject/));
    expect(screen.getByTestId('search').textContent).toMatch(/service=Guest/);

    fireEvent.click(screen.getByRole('button', { name: 'Copy view link' }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    const copied = String(writeText.mock.calls[0]?.[0] ?? '');
    expect(copied).toMatch(/result=reject/);
    expect(copied).toMatch(/service=Guest/);
  });

  it('passes q and plane into getAuthEvents for paged Load more', async () => {
    const page1 = liveData({
      events: [{ ...EVENT, who: 'p1.user', mac: 'aa:bb:cc:00:00:01' }],
      page: { total: 2, limit: 250, cursor: '0', nextCursor: '1' },
    });
    const page2 = liveData({
      events: [{ ...EVENT, who: 'p2.user', mac: 'aa:bb:cc:00:00:02' }],
      page: { total: 2, limit: 250, cursor: '1', nextCursor: null },
    });
    mockGetAuthEvents.mockImplementation(async (query) => {
      if (query?.cursor === '1') return page2;
      return page1;
    });

    render(
      <MemoryRouter
        future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
        initialEntries={['/auth-events?q=p&plane=CLEARPASS']}
      >
        <ToastProvider>
          <SettingsProvider>
            <AuthEvents />
          </SettingsProvider>
        </ToastProvider>
      </MemoryRouter>,
    );

    expect(await screen.findByText('p1.user')).toBeTruthy();
    await waitFor(() =>
      expect(mockGetAuthEvents).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 250, q: 'p', plane: 'CLEARPASS' }),
      ),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await waitFor(() => expect(screen.getByText('p2.user')).toBeTruthy());
    expect(mockGetAuthEvents).toHaveBeenCalledWith(
      expect.objectContaining({ cursor: '1', q: 'p', plane: 'CLEARPASS' }),
    );
  });

  it('passes result and service into getAuthEvents so Load more stays filtered (Loop 77)', async () => {
    mockGetAuthEvents.mockResolvedValue(
      liveData({
        events: [{ ...EVENT, who: 'bad.user', result: 'reject', service: 'Guest', tone: 'danger' }],
        page: { total: 1, limit: 250, cursor: '0', nextCursor: null },
      }),
    );

    render(
      <MemoryRouter
        future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
        initialEntries={['/auth-events?result=reject&service=Guest']}
      >
        <ToastProvider>
          <SettingsProvider>
            <AuthEvents />
          </SettingsProvider>
        </ToastProvider>
      </MemoryRouter>,
    );

    expect(await screen.findByText('bad.user')).toBeTruthy();
    await waitFor(() =>
      expect(mockGetAuthEvents).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 250, result: 'reject', service: 'Guest' }),
      ),
    );
  });

  it('passes method into getAuthEvents and keeps it on the share link (Loop 107)', async () => {
    mockGetAuthEvents.mockResolvedValue(
      liveData({
        events: [
          { ...EVENT, who: 'tls.user', method: 'EAP-TLS', result: 'accept' },
          { ...EVENT, who: 'mab.user', method: 'MAB', result: 'accept', mac: 'aa:bb:cc:00:00:99' },
        ],
      }),
    );

    function SearchProbe() {
      const loc = useLocation();
      return <div data-testid="search">{loc.search}</div>;
    }

    render(
      <MemoryRouter
        future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
        initialEntries={['/auth-events?method=EAP-TLS']}
      >
        <ToastProvider>
          <SettingsProvider>
            <AuthEvents />
            <SearchProbe />
          </SettingsProvider>
        </ToastProvider>
      </MemoryRouter>,
    );

    expect(await screen.findByText('tls.user')).toBeTruthy();
    expect(screen.queryByText('mab.user')).toBeNull();
    await waitFor(() =>
      expect(mockGetAuthEvents).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 250, method: 'EAP-TLS' }),
      ),
    );
    await waitFor(() => expect(screen.getByTestId('search').textContent).toMatch(/method=EAP-TLS/));
  });

  it('passes role into getAuthEvents and keeps it on the share link (Loop 115)', async () => {
    mockGetAuthEvents.mockResolvedValue(
      liveData({
        events: [
          { ...EVENT, who: 'clin.user', role: 'Clinical staff', result: 'accept' },
          { ...EVENT, who: 'guest.user', role: 'Guest', result: 'accept', mac: 'aa:bb:cc:00:00:88' },
        ],
      }),
    );

    function SearchProbe() {
      const loc = useLocation();
      return <div data-testid="search">{loc.search}</div>;
    }

    render(
      <MemoryRouter
        future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
        initialEntries={['/auth-events?role=Clinical%20staff']}
      >
        <ToastProvider>
          <SettingsProvider>
            <AuthEvents />
            <SearchProbe />
          </SettingsProvider>
        </ToastProvider>
      </MemoryRouter>,
    );

    expect(await screen.findByText('clin.user')).toBeTruthy();
    expect(screen.queryByText('guest.user')).toBeNull();
    await waitFor(() =>
      expect(mockGetAuthEvents).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 250, role: 'Clinical staff' }),
      ),
    );
    await waitFor(() =>
      expect(screen.getByTestId('search').textContent).toMatch(/role=Clinical(\+|%20)staff/),
    );
  });
});

/* Loop 127 — Live badge honesty, filter chips, bulk export, subtable CSVs. */
describe('AuthEvents Loop 127 residuals', () => {
  it('stamps LIVE on pure live feeds (not only blend mode)', async () => {
    mockGetAuthEvents.mockResolvedValue(liveData());
    renderAuthEvents();
    expect(await screen.findByText('LIVE')).toBeTruthy();
  });

  it('shows removable filter chips and Clear all restores the full feed', async () => {
    mockGetAuthEvents.mockResolvedValue(
      liveData({
        events: [
          { ...EVENT, who: 'ok.user', result: 'accept' },
          { ...EVENT, who: 'bad.user', result: 'reject', tone: 'danger', reason: 'bad' },
        ],
      }),
    );
    render(
      <MemoryRouter
        future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
        initialEntries={['/auth-events?result=reject']}
      >
        <ToastProvider>
          <SettingsProvider>
            <AuthEvents />
          </SettingsProvider>
        </ToastProvider>
      </MemoryRouter>,
    );

    expect(await screen.findByText('bad.user')).toBeTruthy();
    expect(screen.queryByText('ok.user')).toBeNull();
    const chips = screen.getByRole('group', { name: 'Active auth filters' });
    expect(within(chips).getByText(/result: reject/)).toBeTruthy();
    fireEvent.click(within(chips).getByRole('button', { name: 'Clear all' }));
    expect(await screen.findByText('ok.user')).toBeTruthy();
    expect(screen.queryByRole('group', { name: 'Active auth filters' })).toBeNull();
  });

  it('exports selected events from the bulk bar and clears selection', async () => {
    const createObjectURL = vi.fn(() => 'blob:auth-selected');
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL });

    mockGetAuthEvents.mockResolvedValue(
      liveData({
        events: [
          { ...EVENT, who: 'a.user', mac: 'aa:00:00:00:00:01' },
          { ...EVENT, who: 'b.user', mac: 'aa:00:00:00:00:02' },
        ],
      }),
    );
    const { container } = renderAuthEvents();
    await screen.findByText('2 of 2 shown');
    expect(screen.queryByRole('region', { name: 'Auth event selection actions' })).toBeNull();

    const first = container.querySelector('tbody tr') as HTMLElement;
    first.focus();
    fireEvent.keyDown(first, { key: 'x' });

    const bar = await screen.findByRole('region', { name: 'Auth event selection actions' });
    expect(within(bar).getByText('1 SELECTED')).toBeTruthy();
    fireEvent.click(within(bar).getByRole('button', { name: 'Export selected' }));
    expect(await screen.findByText(/Exported 1 selected event/)).toBeTruthy();
    expect(createObjectURL).toHaveBeenCalled();

    fireEvent.click(within(bar).getByRole('button', { name: 'Clear' }));
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: 'Auth event selection actions' })).toBeNull(),
    );
  });

  /* Loop 140 — Result chip row toggles the same result= filter as the Select. */
  it('result chips filter the feed and write result back to the URL', async () => {
    mockGetAuthEvents.mockResolvedValue(
      liveData({
        events: [
          { ...EVENT, who: 'ok.user', result: 'accept', tone: 'success' },
          { ...EVENT, who: 'bad.user', result: 'reject', tone: 'danger', reason: 'bad' },
          {
            ...EVENT,
            who: 'slow.user',
            result: 'timeout',
            tone: 'warning',
            reason: 'NAS silent',
            mac: 'aa:bb:cc:00:00:77',
          },
        ],
      }),
    );

    function SearchProbe() {
      const loc = useLocation();
      return <div data-testid="search">{loc.search}</div>;
    }

    render(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <ToastProvider>
          <SettingsProvider>
            <AuthEvents />
            <SearchProbe />
          </SettingsProvider>
        </ToastProvider>
      </MemoryRouter>,
    );

    await screen.findByText('ok.user');
    const chips = screen.getByRole('group', { name: 'Auth result' });
    const rejected = within(chips).getByRole('button', { name: /Rejected/i });
    expect(rejected.getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(rejected);
    await waitFor(() => expect(screen.getByText('bad.user')).toBeTruthy());
    expect(screen.queryByText('ok.user')).toBeNull();
    expect(screen.queryByText('slow.user')).toBeNull();
    await waitFor(() => expect(screen.getByTestId('search').textContent).toMatch(/result=reject/));
    expect(rejected.getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(rejected);
    await waitFor(() => expect(screen.getByText('ok.user')).toBeTruthy());
    expect(screen.getByText('bad.user')).toBeTruthy();
    expect(screen.getByTestId('search').textContent).not.toMatch(/result=/);
  });

  /* Loop 143 — Method chip row toggles the same method= filter as the Select. */
  it('method chips filter the feed and write method back to the URL', async () => {
    mockGetAuthEvents.mockResolvedValue(
      liveData({
        events: [
          { ...EVENT, who: 'tls.user', method: 'EAP-TLS', result: 'accept' },
          { ...EVENT, who: 'mab.user', method: 'MAB', result: 'accept', mac: 'aa:bb:cc:00:00:88' },
        ],
      }),
    );

    function SearchProbe() {
      const loc = useLocation();
      return <div data-testid="search">{loc.search}</div>;
    }

    render(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <ToastProvider>
          <SettingsProvider>
            <AuthEvents />
            <SearchProbe />
          </SettingsProvider>
        </ToastProvider>
      </MemoryRouter>,
    );

    await screen.findByText('tls.user');
    const chips = screen.getByRole('group', { name: 'Auth method' });
    const mab = within(chips).getByRole('button', { name: /MAB/i });
    expect(mab.getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(mab);
    await waitFor(() => expect(screen.getByText('mab.user')).toBeTruthy());
    expect(screen.queryByText('tls.user')).toBeNull();
    await waitFor(() => expect(screen.getByTestId('search').textContent).toMatch(/method=MAB/));
    expect(mab.getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(mab);
    await waitFor(() => expect(screen.getByText('tls.user')).toBeTruthy());
    expect(screen.getByText('mab.user')).toBeTruthy();
    expect(screen.getByTestId('search').textContent).not.toMatch(/method=/);
  });

  /* Loop 148 — Service chip row toggles the same service= filter as the Select. */
  it('service chips filter the feed and write service back to the URL', async () => {
    mockGetAuthEvents.mockResolvedValue(
      liveData({
        events: [
          { ...EVENT, who: 'corp.user', service: 'Corp 802.1X', result: 'accept' },
          {
            ...EVENT,
            who: 'guest.user',
            service: 'Guest Portal',
            result: 'accept',
            mac: 'aa:bb:cc:00:00:99',
          },
        ],
      }),
    );

    function SearchProbe() {
      const loc = useLocation();
      return <div data-testid="search">{loc.search}</div>;
    }

    render(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <ToastProvider>
          <SettingsProvider>
            <AuthEvents />
            <SearchProbe />
          </SettingsProvider>
        </ToastProvider>
      </MemoryRouter>,
    );

    await screen.findByText('corp.user');
    const chips = screen.getByRole('group', { name: 'Auth service' });
    const guest = within(chips).getByRole('button', { name: /Guest Portal/i });
    expect(guest.getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(guest);
    await waitFor(() => expect(screen.getByText('guest.user')).toBeTruthy());
    expect(screen.queryByText('corp.user')).toBeNull();
    await waitFor(() =>
      expect(screen.getByTestId('search').textContent).toMatch(/service=Guest(\+|%20| )Portal/),
    );
    expect(guest.getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(guest);
    await waitFor(() => expect(screen.getByText('corp.user')).toBeTruthy());
    expect(screen.getByText('guest.user')).toBeTruthy();
    expect(screen.getByTestId('search').textContent).not.toMatch(/service=/);
  });

  /* Loop 134 — bulk Copy MACs for NAC paste. */
  it('Copy MACs writes unique newline-joined endpoint MACs', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    mockGetAuthEvents.mockResolvedValue(
      liveData({
        events: [
          { ...EVENT, who: 'a.user', mac: 'aa:00:00:00:00:01' },
          { ...EVENT, who: 'b.user', mac: 'aa:00:00:00:00:02' },
          { ...EVENT, who: 'a.user-again', mac: 'aa:00:00:00:00:01' },
        ],
      }),
    );
    const { container } = renderAuthEvents();
    await screen.findByText('3 of 3 shown');

    const rows = container.querySelectorAll('tbody tr');
    expect(rows.length).toBeGreaterThanOrEqual(3);
    for (let i = 0; i < 3; i++) {
      (rows[i] as HTMLElement).focus();
      fireEvent.keyDown(rows[i] as HTMLElement, { key: 'x' });
    }

    const bar = await screen.findByRole('region', { name: 'Auth event selection actions' });
    fireEvent.click(within(bar).getByRole('button', { name: 'Copy MACs' }));
    expect(await screen.findByText(/Copied 2 MACs/i)).toBeTruthy();
    expect(writeText).toHaveBeenCalledWith('aa:00:00:00:00:01\naa:00:00:00:00:02');
  });

  /* Loop 160 — Copy selection link writes ?macs= and deep-link filters the feed. */
  it('Copy selection link writes macs= and the deep link filters the feed', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    mockGetAuthEvents.mockResolvedValue(
      liveData({
        events: [
          { ...EVENT, who: 'a.user', mac: 'aa:00:00:00:00:01' },
          { ...EVENT, who: 'b.user', mac: 'aa:00:00:00:00:02' },
        ],
      }),
    );
    const { container } = renderAuthEvents();
    await screen.findByText('2 of 2 shown');

    const first = container.querySelector('tbody tr') as HTMLElement;
    first.focus();
    fireEvent.keyDown(first, { key: 'x' });

    const bar = await screen.findByRole('region', { name: 'Auth event selection actions' });
    fireEvent.click(within(bar).getByRole('button', { name: 'Copy selection link' }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    const url = String(writeText.mock.calls[0]![0]);
    expect(url).toMatch(/macs=/);
    expect(decodeURIComponent(url).toLowerCase()).toMatch(/aa:00:00:00:00:01/);

    cleanup();
    const qs = url.includes('?') ? url.slice(url.indexOf('?')) : '';
    mockGetAuthEvents.mockResolvedValue(
      liveData({
        events: [
          { ...EVENT, who: 'a.user', mac: 'aa:00:00:00:00:01' },
          { ...EVENT, who: 'b.user', mac: 'aa:00:00:00:00:02' },
        ],
      }),
    );
    render(
      <MemoryRouter
        initialEntries={[`/auth-events${qs}`]}
        future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
      >
        <ToastProvider>
          <SettingsProvider>
            <AuthEvents />
          </SettingsProvider>
        </ToastProvider>
      </MemoryRouter>,
    );
    await screen.findByText(/1 of 2 shown/);
    expect(screen.getByText('a.user')).toBeTruthy();
    expect(screen.queryByText('b.user')).toBeNull();
    expect(screen.getByLabelText('Clear MAC selection filter')).toBeTruthy();
  });

  it('offers Export CSV on fail-reasons and policy-services subtables', async () => {
    const createObjectURL = vi.fn(() => 'blob:auth-sub');
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL });

    mockGetAuthEvents.mockResolvedValue(
      liveData({
        failReasons: [{ label: 'Certificate expired', value: 12, note: '12 rejects' }],
        policyServices: [
          {
            name: 'Corp 802.1X',
            detail: 'Machine + user',
            rate: '420/h',
            state: 'healthy',
            tone: 'success',
          },
        ],
      }),
    );
    renderAuthEvents();
    expect(await screen.findByText('Certificate expired')).toBeTruthy();

    const exportButtons = screen.getAllByRole('button', { name: 'Export CSV' });
    // Header log export + fail reasons + policy services
    expect(exportButtons.length).toBeGreaterThanOrEqual(3);
    fireEvent.click(exportButtons[1]!);
    expect(await screen.findByText(/Exported 1 fail reason/)).toBeTruthy();
    fireEvent.click(exportButtons[2]!);
    expect(await screen.findByText(/Exported 1 policy service/)).toBeTruthy();
    expect(createObjectURL).toHaveBeenCalled();
  });
});

/* Loop 149 — Role chip row toggles the same role= filter as the Select. */
describe('AuthEvents role chips (Loop 149)', () => {
  it('role chips filter the feed and write role back to the URL', async () => {
    mockGetAuthEvents.mockResolvedValue(
      liveData({
        events: [
          { ...EVENT, who: 'clin.user', role: 'Clinical staff', result: 'accept' },
          { ...EVENT, who: 'guest.user', role: 'Guest', result: 'accept', mac: 'aa:bb:cc:00:00:88' },
        ],
      }),
    );

    function SearchProbe() {
      const loc = useLocation();
      return <div data-testid="search">{loc.search}</div>;
    }

    render(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <ToastProvider>
          <SettingsProvider>
            <AuthEvents />
            <SearchProbe />
          </SettingsProvider>
        </ToastProvider>
      </MemoryRouter>,
    );

    await screen.findByText('clin.user');
    const chips = screen.getByRole('group', { name: 'Auth role' });
    const guest = within(chips).getByRole('button', { name: /Guest/i });
    expect(guest.getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(guest);
    await waitFor(() => expect(screen.getByText('guest.user')).toBeTruthy());
    expect(screen.queryByText('clin.user')).toBeNull();
    await waitFor(() => expect(screen.getByTestId('search').textContent).toMatch(/role=Guest/));
    expect(guest.getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(guest);
    await waitFor(() => expect(screen.getByText('clin.user')).toBeTruthy());
    expect(screen.getByText('guest.user')).toBeTruthy();
    expect(screen.getByTestId('search').textContent).not.toMatch(/role=/);
  });
});

/* Loop 152 — Plane chip row toggles the same plane= filter as the Select. */
describe('AuthEvents plane chips (Loop 152)', () => {
  it('plane chips filter the feed and write plane back to the URL', async () => {
    mockGetAuthEvents.mockResolvedValue(
      liveData({
        events: [
          { ...EVENT, who: 'cp.user', plane: 'CLEARPASS', result: 'accept' },
          { ...EVENT, who: 'mist.user', plane: 'MIST', result: 'accept', mac: 'aa:bb:cc:00:00:99' },
        ],
      }),
    );

    function SearchProbe() {
      const loc = useLocation();
      return <div data-testid="search">{loc.search}</div>;
    }

    render(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <ToastProvider>
          <SettingsProvider>
            <AuthEvents />
            <SearchProbe />
          </SettingsProvider>
        </ToastProvider>
      </MemoryRouter>,
    );

    await screen.findByText('cp.user');
    const chips = screen.getByRole('group', { name: 'Auth plane' });
    const mist = within(chips).getByRole('button', { name: /MIST/i });
    expect(mist.getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(mist);
    await waitFor(() => expect(screen.getByText('mist.user')).toBeTruthy());
    expect(screen.queryByText('cp.user')).toBeNull();
    await waitFor(() => expect(screen.getByTestId('search').textContent).toMatch(/plane=MIST/));
    expect(mist.getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(mist);
    await waitFor(() => expect(screen.getByText('cp.user')).toBeTruthy());
    expect(screen.getByText('mist.user')).toBeTruthy();
    expect(screen.getByTestId('search').textContent).not.toMatch(/plane=/);
  });
});

/* Loop 156 — Range chip row toggles the same range= filter as TimeRangeControl. */
describe('AuthEvents range chips (Loop 156)', () => {
  const RECENT = () => new Date(Date.now() - 5 * 60_000).toISOString(); // 5m ago
  const OLD = () => new Date(Date.now() - 2 * 60 * 60_000).toISOString(); // 2h ago

  function SearchProbe() {
    const loc = useLocation();
    return <div data-testid="search">{loc.search}</div>;
  }

  it('range chips filter the feed and write range back to the URL', async () => {
    mockGetAuthEvents.mockResolvedValue(
      liveData({
        events: [
          { ...EVENT, who: 'recent.user', at: RECENT() },
          { ...EVENT, who: 'old.user', at: OLD(), mac: 'aa:bb:cc:00:00:02' },
        ],
      }),
    );

    render(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <ToastProvider>
          <SettingsProvider>
            <AuthEvents />
            <SearchProbe />
          </SettingsProvider>
        </ToastProvider>
      </MemoryRouter>,
    );

    await screen.findByText('recent.user');
    expect(screen.getByText('old.user')).toBeTruthy();

    const chips = screen.getByRole('group', { name: 'Auth time range' });
    const fifteen = within(chips).getByRole('button', { name: /15m/i });
    expect(fifteen.getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(fifteen);
    await waitFor(() => expect(screen.getByText('recent.user')).toBeTruthy());
    expect(screen.queryByText('old.user')).toBeNull();
    await waitFor(() => expect(screen.getByTestId('search').textContent).toMatch(/range=15m/));
    expect(fifteen.getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(fifteen);
    await waitFor(() => expect(screen.getByText('old.user')).toBeTruthy());
    expect(screen.getByText('recent.user')).toBeTruthy();
    expect(screen.getByTestId('search').textContent).not.toMatch(/range=/);
  });
});
