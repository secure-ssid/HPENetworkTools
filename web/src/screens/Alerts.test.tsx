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
 *  (k) …and its absence leaves the derived banner in place;
 *  (l) repeat firings collapse into one row with a ×N badge, counted in firings;
 *  (m) a silenced group is benched from the table and listed WITH its reason,
 *      never invisible — and an all-silenced queue reads hushed, not quiet;
 *  (n) Unsilence deletes the silence and refreshes the queue;
 *  (o) the Silence drawer requires a reason and posts the group's matchers.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Alerts from './Alerts';
import { SettingsProvider } from '../app/SettingsContext';
import { ToastProvider } from '../nightdesk';
import { ackAlert, createSilence, deleteSilence, getAlerts, getTickets } from '../api/client';
import type { AlertsData } from '../api/client';
import type { AlertGroup, AlertRow, SilencedAlertGroup } from '@hpe/shared';

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
  return {
    ...actual,
    getAlerts: vi.fn(),
    getTickets: vi.fn(),
    ackAlert: vi.fn(),
    raiseTicket: vi.fn(),
    createSilence: vi.fn(),
    deleteSilence: vi.fn(),
  };
});

const mockGetAlerts = vi.mocked(getAlerts);
const mockGetTickets = vi.mocked(getTickets);
const mockCreateSilence = vi.mocked(createSilence);
const mockDeleteSilence = vi.mocked(deleteSilence);

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
    <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
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

/* An empty device list looks odd. An empty alert queue looks like good news —
 * it is the one empty state in the portal an operator is glad to see, which
 * makes it the one that must never be reachable by accident. A linked plane
 * whose alert read did not come back contributes no rows, so its P1s are
 * simply absent from a queue that otherwise reads all-clear. */
describe('Alerts missing sources', () => {
  it('names every plane the queue is missing before the queue itself', async () => {
    mockGetAlerts.mockResolvedValue(liveData({ missingSources: ['CENTRAL', 'MIST'] }));
    renderAlerts();

    expect(
      await screen.findByText('This queue is missing 2 linked sources: CENTRAL, MIST'),
    ).toBeTruthy();
    expect(screen.getByText(/A short queue here is not a quiet estate/)).toBeTruthy();
  });

  it('refuses to call an empty queue an all-clear when a plane did not answer', async () => {
    mockGetAlerts.mockResolvedValue(liveData({ alerts: [], missingSources: ['SSE'] }));
    renderAlerts();

    expect(await screen.findByText('No alerts from the planes that answered')).toBeTruthy();
    expect(screen.getByText(/SSE did not answer, so this is not an all-clear\./)).toBeTruthy();
    // The old wording spoke for planes that never spoke.
    expect(screen.queryByText(/Nothing is open across the linked planes/)).toBeNull();
  });

  it('keeps the plain all-clear when every linked plane did answer', async () => {
    mockGetAlerts.mockResolvedValue(liveData({ alerts: [], missingSources: [], syncedAt: '2024-05-01T09:41:00Z' }));
    renderAlerts();

    expect(await screen.findByText('No alerts in the queue')).toBeTruthy();
    expect(screen.getByText('Nothing is open across the linked planes as of the last poll.')).toBeTruthy();
    expect(screen.queryByText(/is missing/)).toBeNull();
  });

  it('says nothing when the route never reported on missing sources', async () => {
    // Absent field, not an empty one: an older server that never looked must
    // not be rendered as one that looked and found every plane reporting.
    mockGetAlerts.mockResolvedValue(liveData({ alerts: [], syncedAt: '2024-05-01T09:41:00Z' }));
    renderAlerts();

    expect(await screen.findByText('No alerts in the queue')).toBeTruthy();
    expect(screen.queryByText(/is missing/)).toBeNull();
  });
});

/* A 202 from Central is Central agreeing to consider the clear request. The
 * screen used to rewrite the row to 'acked' on the strength of that alone and
 * raise a success toast, so an acknowledge that Central accepted and never
 * acted on looked identical to one that worked — while the alert it named sat
 * open in the same table. `cleared` is the server's re-read, and it is the
 * only thing that licenses saying the alert was acknowledged. */
describe('Alerts acknowledge verification', () => {
  const OPEN_CENTRAL: AlertRow = { ...WORST, alertId: 'K1' };

  async function ackWith(result: Record<string, unknown>) {
    mockGetAlerts.mockResolvedValue(liveData({ alerts: [OPEN_CENTRAL] }));
    mockGetTickets.mockResolvedValue({
      tickets: [{ id: 'NET-1', title: 'wan down', state: 'open' } as never],
      dataSource: 'live',
    });
    vi.mocked(ackAlert).mockResolvedValue(result as never);

    renderAlerts();
    fireEvent.click(await screen.findByRole('button', { name: 'Acknowledge' }));
    await act(async () => Promise.resolve());
    // The toolbar button and the dialog's confirm share a label; the dialog
    // opens below it, so the confirm is the last one rendered.
    const buttons = screen.getAllByRole('button', { name: 'Acknowledge' });
    fireEvent.click(buttons[buttons.length - 1]);
    await act(async () => Promise.resolve());
  }

  it('marks the row acknowledged only when the re-read confirms it cleared', async () => {
    await ackWith({ ok: true, applied: true, cleared: 'cleared', message: 'the alert has cleared', alert: 'a', ticket: 'NET-1' });

    expect(screen.getByText(/Acknowledged —/)).toBeTruthy();
  });

  it('does not present an accepted-but-uncleared acknowledge as done', async () => {
    await ackWith({ ok: true, applied: true, cleared: 'still-open', message: 'still open', alert: 'a', ticket: 'NET-1' });

    expect(screen.getByText(/Accepted, not yet cleared/)).toBeTruthy();
    expect(screen.queryByText(/^Acknowledged —/)).toBeNull();
  });

  // A poll that did not complete is not evidence the clear worked.
  it('does not claim success when the re-read could not be completed', async () => {
    await ackWith({ ok: true, applied: true, cleared: 'unknown', message: 'could not re-read', alert: 'a', ticket: 'NET-1' });

    expect(screen.getByText(/Accepted, not yet cleared/)).toBeTruthy();
  });

  // An older server sends no `cleared` at all, and absent is not confirmation.
  it('treats a server that reports no verification as unconfirmed', async () => {
    await ackWith({ ok: true, applied: true, message: 'accepted', alert: 'a', ticket: 'NET-1' });

    expect(screen.getByText(/Accepted, not yet cleared/)).toBeTruthy();
  });
});

/* Fingerprint grouping (shared/alertEngine.ts) is the queue's noise control:
 * a flapping alert is one row with a count, and a time-boxed silence benches
 * a group WITHOUT hiding it — the Silenced section always says what is hushed,
 * why, and until when. */
describe('Alerts grouping and silences', () => {
  const FLAP_OLD: AlertRow = {
    ...WORST,
    sev: 'P2',
    tone: 'warning',
    title: 'gw-edge-1 tunnel flap ×14 in an hour',
    detail: 'ipsec to dc1 · mtu blackhole suspected',
    plane: 'AOS-10',
    age: '55m',
    device: 'gw-edge-1',
  };
  const FLAP_NEW: AlertRow = { ...FLAP_OLD, detail: 'ipsec to dc1 · ddos guard throttled ike', age: '12m' };

  const FLAP_GROUP: AlertGroup = {
    fingerprint: 'aos-10|gw-edge-1|gw-edge-1 tunnel flap ×14 in an hour',
    latest: FLAP_NEW,
    count: 2,
    firstSeen: '55m',
    lastSeen: '12m',
  };

  const SILENCED: SilencedAlertGroup = {
    group: FLAP_GROUP,
    silence: {
      id: 'sil-1',
      device: 'gw-edge-1',
      reason: 'ISP maintenance window',
      createdAt: '2026-08-01T00:00:00.000Z',
      until: new Date(Date.now() + 3_600_000).toISOString(),
    },
  };

  it('(l) collapses repeat firings into one row with a ×N badge, counted in firings', async () => {
    mockGetAlerts.mockResolvedValue(liveData({ alerts: [FLAP_OLD, FLAP_NEW] }));
    renderAlerts();

    // One row, not two — and the badge carries the noise level.
    expect(await screen.findByText('×2')).toBeTruthy();
    await waitFor(() =>
      expect(screen.getAllByRole('button', { name: 'Silence' })).toHaveLength(1),
    );
    // The latest firing's detail, with the storm bracket next to it.
    expect(screen.getByText(/ddos guard throttled ike · 2 firings, first seen 55m ago/)).toBeTruthy();
    // The count line counts firings, not rows.
    expect(screen.getByText('2 of 2 alerts · live')).toBeTruthy();
  });

  it('(m) benches a silenced group WITH its reason — and an all-silenced queue reads hushed, not quiet', async () => {
    mockGetAlerts.mockResolvedValue(liveData({ alerts: [], groups: [], silenced: [SILENCED] }));
    renderAlerts();

    // Queue is honest about hush; the benched group lives on Silences.
    expect(await screen.findByText('Everything firing is silenced')).toBeTruthy();
    expect(screen.getByText(/hushed, not quiet/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Inspect' })).toBeNull();

    fireEvent.click(screen.getByRole('tab', { name: /Silences/ }));
    expect(await screen.findByText('SILENCED (1)')).toBeTruthy();
    expect(screen.getByText(/ISP maintenance window · until /)).toBeTruthy();
    expect(screen.getByText('×2')).toBeTruthy();
  });

  it('(n) Unsilence deletes the silence and refreshes the queue', async () => {
    mockGetAlerts.mockResolvedValue(liveData({ alerts: [], groups: [], silenced: [SILENCED] }));
    mockDeleteSilence.mockResolvedValue({ ok: true });
    renderAlerts();

    fireEvent.click(await screen.findByRole('tab', { name: /Silences/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Unsilence' }));
    await waitFor(() => expect(mockDeleteSilence).toHaveBeenCalledWith('sil-1'));
    await waitFor(() => expect(mockGetAlerts).toHaveBeenCalledTimes(2));
  });

  it('(o) the Silence drawer requires a reason and posts the group matchers', async () => {
    mockGetAlerts.mockResolvedValue(liveData({ alerts: [FLAP_OLD, FLAP_NEW] }));
    mockCreateSilence.mockResolvedValue({ silence: SILENCED.silence });
    renderAlerts();

    fireEvent.click(await screen.findByRole('button', { name: 'Silence' }));
    const dialog = await screen.findByRole('dialog');
    const confirm = within(dialog).getByRole('button', { name: 'Silence' });
    // A reason is required before anything is filed.
    expect(confirm).toHaveProperty('disabled', true);

    fireEvent.change(within(dialog).getByLabelText('Silence duration'), { target: { value: '1440' } });
    fireEvent.change(within(dialog).getByLabelText('Silence reason'), {
      target: { value: 'ISP maintenance window' },
    });
    fireEvent.click(confirm);

    await waitFor(() =>
      expect(mockCreateSilence).toHaveBeenCalledWith({
        plane: 'AOS-10',
        device: 'gw-edge-1',
        titleContains: 'gw-edge-1 tunnel flap ×14 in an hour',
        reason: 'ISP maintenance window',
        durationMinutes: 1440,
      }),
    );
    await waitFor(() => expect(mockGetAlerts).toHaveBeenCalledTimes(2));
  });

  it('(p) a failed silence create says so instead of looking filed', async () => {
    mockGetAlerts.mockResolvedValue(liveData({ alerts: [FLAP_NEW] }));
    mockCreateSilence.mockResolvedValue({ error: 'backend unreachable', offline: true });
    renderAlerts();

    fireEvent.click(await screen.findByRole('button', { name: 'Silence' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Silence reason'), { target: { value: 'x' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Silence' }));

    expect(await screen.findByText(/Silence not created/)).toBeTruthy();
    // The queue was not re-read on a failure, and the drawer stays open.
    expect(mockGetAlerts).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('dialog')).toBeTruthy();
  });
});

/* The queue table is the nightdesk DataTable's second integration: the column
 * manager persists through SettingsContext under the 'alerts' table id, the
 * rows are a keyboard grid (Enter opens the group's timeline drawer) and '?'
 * lists the commands. These tests pin the wiring, not the mechanics — those
 * live in nightdesk/DataTable.test.tsx. */
describe('Alerts DataTable superpowers', () => {
  beforeEach(() => {
    // Plain localStorage is not reliable in this environment — stub it the
    // SettingsContext.test.tsx way, fresh per test so no config leaks.
    const values = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
      clear: () => values.clear(),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function bodyRows(container: HTMLElement): HTMLTableRowElement[] {
    return Array.from(container.querySelectorAll('tbody tr'));
  }

  it('hides and restores a column from View options, persisted under the alerts table id', async () => {
    mockGetAlerts.mockResolvedValue(liveData());
    const { container } = renderAlerts();
    await screen.findByText('2 of 2 alerts · live');
    expect(container.querySelector('th[data-column-key="site"]')).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'View options' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Site' }));
    expect(container.querySelector('th[data-column-key="site"]')).toBeNull();
    expect(JSON.parse(localStorage.getItem('nt-table-columns') ?? '{}')).toEqual({
      alerts: { hidden: ['site'] },
    });

    fireEvent.click(screen.getByRole('checkbox', { name: 'Site' }));
    expect(container.querySelector('th[data-column-key="site"]')).not.toBeNull();
  });

  it('keeps the primary alert column out of the hideable set', async () => {
    mockGetAlerts.mockResolvedValue(liveData());
    renderAlerts();
    await screen.findByText('2 of 2 alerts · live');

    fireEvent.click(screen.getByRole('button', { name: 'View options' }));
    expect(screen.getByRole('checkbox', { name: 'Alert' })).toHaveProperty('disabled', true);
  });

  it('moves the focused row with j/k and opens the timeline drawer on Enter', async () => {
    mockGetAlerts.mockResolvedValue(liveData());
    const { container } = renderAlerts();
    await screen.findByText('2 of 2 alerts · live');
    const [first, second] = bodyRows(container);

    expect(first.getAttribute('tabindex')).toBe('0');
    fireEvent.keyDown(first, { key: 'j' });
    expect(document.activeElement).toBe(second);
    fireEvent.keyDown(second, { key: 'k' });
    expect(document.activeElement).toBe(first);

    fireEvent.keyDown(first, { key: 'Enter' });
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Occurrence timeline')).toBeTruthy();
    expect(within(dialog).getByText(/gw-edge-1 unreachable/)).toBeTruthy();
  });

  it("lists the row commands on '?'", async () => {
    mockGetAlerts.mockResolvedValue(liveData());
    renderAlerts();
    await screen.findByText('2 of 2 alerts · live');

    fireEvent.keyDown(document.body, { key: '?' });
    expect(await screen.findByRole('dialog')).toBeTruthy();
    expect(screen.getByText('Move to the next row')).toBeTruthy();
    expect(screen.getByText("Run the focused row's primary action")).toBeTruthy();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

/* The faceted filters (severity / plane / site): OR within a facet, AND
 * across facets, counts computed over the OTHER active facets — and always
 * composed with the free text and switches, never instead of them. */
describe('Alerts facets', () => {
  const P3_CENTRAL: AlertRow = {
    ...WORST,
    sev: 'P3',
    tone: 'info',
    title: 'Config Out of Sync',
    detail: 'template drift',
    device: 'sw-acc-3f-1',
    alertId: 'K9',
  };

  it('narrows the queue by facet with honest live counts', async () => {
    mockGetAlerts.mockResolvedValue(liveData({ alerts: [WORST, STALE_PARTNER, P3_CENTRAL] }));
    renderAlerts();
    await screen.findByText('3 of 3 alerts · live');

    // Every severity is offered, counted over the whole (unfaceted) queue.
    fireEvent.click(screen.getByRole('button', { name: 'Severity' }));
    const sevPanel = screen.getByRole('group', { name: 'Severity filter' });
    for (const sev of ['P1', 'P2', 'P3']) {
      expect(within(sevPanel).getByRole('checkbox', { name: sev }).closest('li')!.textContent).toContain('1');
    }

    // Ticking P1 narrows to exactly the P1 group, counted in firings.
    fireEvent.click(within(sevPanel).getByRole('checkbox', { name: 'P1' }));
    expect(screen.getByText('1 of 3 alerts · live')).toBeTruthy();
    expect(screen.getByText('gw-edge-1 unreachable')).toBeTruthy();
    expect(screen.queryByText('inventory 6h stale')).toBeNull();
    fireEvent.keyDown(document, { key: 'Escape' });

    // The OTHER facet's counts now reflect the severity selection: of the
    // planes, only CENTRAL still has a row in view — but CLASSIC stays listed
    // at 0 rather than vanishing with its row.
    fireEvent.click(screen.getByRole('button', { name: 'Plane' }));
    const planePanel = screen.getByRole('group', { name: 'Plane filter' });
    expect(within(planePanel).getByRole('checkbox', { name: 'CENTRAL' }).closest('li')!.textContent).toContain('1');
    expect(within(planePanel).getByRole('checkbox', { name: 'CLASSIC' }).closest('li')!.textContent).toContain('0');
    fireEvent.keyDown(document, { key: 'Escape' });

    // AND across facets: plane CLASSIC + severity P1 is honestly empty, and
    // the empty state blames the filter, not the estate.
    fireEvent.click(screen.getByRole('button', { name: 'Plane' }));
    fireEvent.click(within(screen.getByRole('group', { name: 'Plane filter' })).getByRole('checkbox', { name: 'CLASSIC' }));
    expect(screen.getByText('0 of 3 alerts · live')).toBeTruthy();
    expect(screen.getByText('Nothing matches that filter')).toBeTruthy();

    // The clear-all chip restores the queue.
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: '2 facet values — clear' }));
    expect(screen.getByText('3 of 3 alerts · live')).toBeTruthy();
  });

  it('facets compose with the free-text filter (AND), counts following the text', async () => {
    mockGetAlerts.mockResolvedValue(liveData({ alerts: [WORST, STALE_PARTNER, P3_CENTRAL] }));
    renderAlerts();
    await screen.findByText('3 of 3 alerts · live');

    fireEvent.change(screen.getByLabelText('Filter alerts'), { target: { value: 'config' } });
    expect(screen.getByText('1 of 3 alerts · live')).toBeTruthy();

    // The facet universe is the text-filtered set: only P3 remains countable.
    fireEvent.click(screen.getByRole('button', { name: 'Severity' }));
    const sevPanel = screen.getByRole('group', { name: 'Severity filter' });
    expect(within(sevPanel).getByRole('checkbox', { name: 'P3' }).closest('li')!.textContent).toContain('1');
    expect(within(sevPanel).queryByRole('checkbox', { name: 'P1' })).toBeNull();
  });

  it('offers the site facet labelled by site name, keyed on the site id', async () => {
    mockGetAlerts.mockResolvedValue(liveData({ alerts: [WORST, STALE_PARTNER] }));
    renderAlerts();
    await screen.findByText('2 of 2 alerts · live');

    fireEvent.click(screen.getByRole('button', { name: 'Site' }));
    const sitePanel = screen.getByRole('group', { name: 'Site filter' });
    fireEvent.click(within(sitePanel).getByRole('checkbox', { name: 'Campus-01 HQ' }));
    // Both fixture rows share the one site — ticking it changes nothing but
    // proves the facet is wired through siteId.
    expect(screen.getByText('2 of 2 alerts · live')).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: '1 facet value — clear' }));
    expect(screen.getByText('2 of 2 alerts · live')).toBeTruthy();
  });
});

/* A `?plane=` deep link (the Central screen's queue hand-off) seeds the
 * plane facet once, on mount — after that the selection is the operator's. */
describe('Alerts ?plane= deep link', () => {
  it('seeds the plane facet so the queue opens already filtered', async () => {
    // Two acked rows on different planes: nothing open, so no correlation
    // banner competes with the assertion.
    const centralRow = { ...WORST, state: 'acked' } as AlertRow;
    const classicRow = { ...STALE_PARTNER, state: 'acked', stale: undefined } as AlertRow;
    mockGetAlerts.mockResolvedValue(liveData({ alerts: [centralRow, classicRow] }));
    render(
      <MemoryRouter
        future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
        initialEntries={['/alerts?plane=CENTRAL']}
      >
        <ToastProvider>
          <SettingsProvider>
            <Alerts />
          </SettingsProvider>
        </ToastProvider>
      </MemoryRouter>,
    );

    // The CENTRAL row renders; the CLASSIC row is filtered out on mount.
    expect(await screen.findByText('gw-edge-1 unreachable')).toBeTruthy();
    expect(screen.queryByText('inventory 6h stale')).toBeNull();
    expect(screen.getByText('1 of 2 alerts · live')).toBeTruthy();
  });

  it('no param opens the unfiltered queue, exactly as before', async () => {
    const centralRow = { ...WORST, state: 'acked' } as AlertRow;
    const classicRow = { ...STALE_PARTNER, state: 'acked', stale: undefined } as AlertRow;
    mockGetAlerts.mockResolvedValue(liveData({ alerts: [centralRow, classicRow] }));
    renderAlerts();

    expect(await screen.findByText('gw-edge-1 unreachable')).toBeTruthy();
    expect(screen.getByText('inventory 6h stale')).toBeTruthy();
    expect(screen.getByText('2 of 2 alerts · live')).toBeTruthy();
  });
});

/* A row that arrived through the inbound webhook receiver carries
 * source:'webhook' (shared/webhooks.ts WebhookAlertRow) — the queue badges it
 * subtly, next to the dedup count, and only ever when the marker is present. */
describe('Alerts webhook badge', () => {
  it('badges a webhook-sourced row and leaves polled rows unbadged', async () => {
    const WEBHOOK_ROW = {
      ...WORST,
      title: 'mist device-down event',
      detail: 'delivered by the inbound receiver',
      plane: 'MIST',
      device: 'ap-3f-12',
      source: 'webhook',
    } as AlertRow;
    mockGetAlerts.mockResolvedValue(liveData({ alerts: [WORST, WEBHOOK_ROW] }));
    renderAlerts();

    await screen.findByText('mist device-down event');
    const badge = screen.getByText('webhook');
    expect(badge.closest('span[title]')?.getAttribute('title')).toBe(
      'received through an inbound webhook, not a plane poll',
    );
    // Exactly one badge: the polled row carries no marker.
    expect(screen.getAllByText('webhook')).toHaveLength(1);
    // The badge is provenance, not a filter change — both rows still count.
    expect(screen.getByText('2 of 2 alerts · live')).toBeTruthy();
  });
});
