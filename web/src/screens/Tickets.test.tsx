import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import Tickets from './Tickets';
import { SettingsProvider } from '../app/SettingsContext';
import { ToastProvider } from '../nightdesk';
import { addTicketNote, getTickets, resolveTicket } from '../api/client';
import { MAX_NOTE_CHARS, TICKETS } from '@hpe/shared';
import type { TicketRow } from '@hpe/shared';
import { downloadApiCsv } from '../lib/downloadApiCsv';

vi.mock('../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/client')>();
  return {
    ...actual,
    getTickets: vi.fn(),
    addTicketNote: vi.fn(),
    resolveTicket: vi.fn(),
  };
});

vi.mock('../lib/downloadApiCsv', () => ({
  downloadApiCsv: vi.fn(),
}));

vi.mock('../components/VisualReferencePanel', () => ({
  VisualReferencePanel: () => <div data-testid="visual-refs">Visual references</div>,
}));

vi.mock('../components/ConfigRecommendationsPanel', () => ({
  ConfigRecommendationsPanel: ({ title }: { title?: string }) => (
    <div data-testid="config-recs">{title ?? 'Recommendations'}</div>
  ),
}));

const mockGetTickets = vi.mocked(getTickets);
const mockAddTicketNote = vi.mocked(addTicketNote);
const mockResolveTicket = vi.mocked(resolveTicket);
const mockDownloadApiCsv = vi.mocked(downloadApiCsv);

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const FIRST: TicketRow = TICKETS[0];

function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="loc">{`${loc.pathname}${loc.search}`}</div>;
}

function renderTickets(initial = '/tickets') {
  mockGetTickets.mockResolvedValue({ tickets: TICKETS, dataSource: 'demo' });
  return render(
    <MemoryRouter
      initialEntries={[initial]}
      future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
    >
      <SettingsProvider>
        <ToastProvider>
          <Routes>
            <Route
              path="/tickets"
              element={
                <>
                  <Tickets />
                  <LocationProbe />
                </>
              }
            />
          </Routes>
        </ToastProvider>
      </SettingsProvider>
    </MemoryRouter>,
  );
}

const noteBox = (): HTMLTextAreaElement =>
  screen.getByPlaceholderText('Log a note — saved to the ticket record in this portal.') as HTMLTextAreaElement;

const logButton = (): HTMLButtonElement => screen.getByRole('button', { name: 'Log note' }) as HTMLButtonElement;

async function typeNote(text: string): Promise<void> {
  await waitFor(() => expect(noteBox()).toBeTruthy());
  fireEvent.change(noteBox(), { target: { value: text } });
}

describe('Tickets — the operator note box', () => {
  it('clears the box once the store has taken the note', async () => {
    mockAddTicketNote.mockResolvedValue({ ticket: { ...FIRST, notes: [] } });
    renderTickets();
    await typeNote('Traced to the uplink on sw-core-a.');
    fireEvent.click(logButton());

    await waitFor(() => expect(noteBox().value).toBe(''));
    expect(mockAddTicketNote).toHaveBeenCalledWith(FIRST.id, 'Traced to the uplink on sw-core-a.', 'note');
  });

  /* Loop 75 — draft notes must not follow the operator onto another ticket. */
  it('clears a draft note when the workspace ticket changes', async () => {
    const second = TICKETS.find((t) => t.id !== FIRST.id && t.state !== 'resolved') ?? TICKETS[1];
    expect(second).toBeTruthy();
    renderTickets(`/tickets?sel=${encodeURIComponent(FIRST.id)}`);
    await typeNote('Half-written root cause for the first ticket only.');
    expect(noteBox().value).toMatch(/Half-written/);

    fireEvent.click(screen.getByRole('button', { name: new RegExp(second!.id) }));
    await waitFor(() => expect(screen.getByTestId('loc').textContent).toContain(`sel=${second!.id}`));
    expect(noteBox().value).toBe('');
  });

  /* The defect. setNote('') ran on submit, before the POST, so a rejected
   * write left the operator with a red toast and an empty box. An incident
   * note is often the longest thing anyone types into this portal and there
   * was no way to get it back. */
  it('keeps the typed note when the write is rejected', async () => {
    mockAddTicketNote.mockResolvedValue({ error: 'ticket store is read-only' });
    renderTickets();
    const typed = 'Root cause: the AP was re-homed to the wrong site on Tuesday.';
    await typeNote(typed);
    fireEvent.click(logButton());

    await waitFor(() => expect(screen.getByText(/not logged — ticket store is read-only/)).toBeTruthy());
    // Still there, still submittable — the operator can retry without retyping.
    expect(noteBox().value).toBe(typed);
    expect(logButton().disabled).toBe(false);
  });

  it('keeps the typed note when the backend is unreachable', async () => {
    mockAddTicketNote.mockResolvedValue({ error: 'backend unreachable', offline: true });
    renderTickets();
    await typeNote('Escalating — pager acknowledged at 02:14.');
    fireEvent.click(logButton());

    await waitFor(() => expect(screen.getByText(/not logged/)).toBeTruthy());
    expect(noteBox().value).toBe('Escalating — pager acknowledged at 02:14.');
  });

  it('does not post a note that is only whitespace', async () => {
    renderTickets();
    await typeNote('   ');
    expect(logButton().disabled).toBe(true);
    expect(mockAddTicketNote).not.toHaveBeenCalled();
  });
});

describe('Tickets — the queued actions', () => {
  it('logs a next action as an action, not a note', async () => {
    mockAddTicketNote.mockResolvedValue({ ticket: { ...FIRST, notes: [] } });
    renderTickets();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Escalate to HPE support' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Escalate to HPE support' }));

    await waitFor(() =>
      expect(mockAddTicketNote).toHaveBeenCalledWith(FIRST.id, 'Escalate to HPE support', 'action'),
    );
    // 'pending execution' — the portal logged the intent; it did not perform it.
    expect(screen.getByText(/pending execution/)).toBeTruthy();
  });

  /* The action buttons fire the same POST as the note box but were not gated
   * on `busy`, so a double click wrote two escalation notes onto the ticket. */
  it('will not fire a second action while the first is still in flight', async () => {
    let release: (v: { ticket: TicketRow }) => void = () => {};
    mockAddTicketNote.mockReturnValue(
      new Promise<{ ticket: TicketRow }>((resolve) => {
        release = resolve;
      }),
    );
    renderTickets();
    const escalate = () => screen.getByRole('button', { name: 'Escalate to HPE support' }) as HTMLButtonElement;
    await waitFor(() => expect(escalate()).toBeTruthy());
    fireEvent.click(escalate());

    await waitFor(() => expect(escalate().disabled).toBe(true));
    fireEvent.click(escalate());
    expect(mockAddTicketNote).toHaveBeenCalledTimes(1);

    release({ ticket: { ...FIRST, notes: [] } });
    await waitFor(() => expect(escalate().disabled).toBe(false));
  });
});

describe('Tickets — resolve', () => {
  it('refetches the queue so the state badge and open count follow the store', async () => {
    const resolved: TicketRow = { ...FIRST, state: 'resolved' };
    mockResolveTicket.mockResolvedValue({ ticket: resolved });
    renderTickets();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Resolve ticket' })).toBeTruthy());
    mockGetTickets.mockResolvedValue({
      tickets: [resolved, ...TICKETS.slice(1)],
      dataSource: 'demo',
    });
    fireEvent.click(screen.getByRole('button', { name: 'Resolve ticket' }));

    await waitFor(() => expect(mockGetTickets).toHaveBeenCalledTimes(2));
    // A closed ticket has no countdown left to run, and loses its Resolve button.
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Resolve ticket' })).toBeNull());
    expect(screen.getByText('Closed')).toBeTruthy();
  });

  it('leaves the ticket open and says why when the store refuses', async () => {
    mockResolveTicket.mockResolvedValue({ error: 'ticket already closed upstream' });
    renderTickets();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Resolve ticket' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Resolve ticket' }));

    await waitFor(() => expect(screen.getByText(/not resolved — ticket already closed upstream/)).toBeTruthy());
    // No optimistic close: the button is still there because the ticket is.
    expect(screen.getByRole('button', { name: 'Resolve ticket' })).toBeTruthy();
    expect(mockGetTickets).toHaveBeenCalledTimes(1);
  });
});

describe('Tickets — the note length bound', () => {
  it('refuses an over-length note without sending it or emptying the box', async () => {
    renderTickets();
    const tooLong = 'x'.repeat(MAX_NOTE_CHARS + 1);
    await typeNote(tooLong);

    // The button is gone before the operator can spend a round trip on it.
    expect(logButton().disabled).toBe(true);
    fireEvent.click(logButton());
    await waitFor(() => expect(screen.getByText(/too long to log/i)).toBeTruthy());
    expect(mockAddTicketNote).not.toHaveBeenCalled();
    // And the text is still there. Refusing a note the operator can no longer
    // read is the same loss as accepting a truncated one.
    expect(noteBox().value).toBe(tooLong);
  });

  it('names the count against the limit rather than just saying too long', async () => {
    renderTickets();
    await typeNote('x'.repeat(MAX_NOTE_CHARS + 25));
    await waitFor(() =>
      expect(screen.getByText(new RegExp(`${MAX_NOTE_CHARS + 25} / ${MAX_NOTE_CHARS}`))).toBeTruthy(),
    );
  });

  it('accepts a note of exactly the limit — the bound is not off by one', async () => {
    mockAddTicketNote.mockResolvedValue({ ticket: { ...FIRST, notes: [] } });
    renderTickets();
    await typeNote('x'.repeat(MAX_NOTE_CHARS));
    expect(logButton().disabled).toBe(false);
    fireEvent.click(logButton());
    await waitFor(() => expect(mockAddTicketNote).toHaveBeenCalledTimes(1));
  });

  it('says nothing about length while the note is within the limit', async () => {
    renderTickets();
    await typeNote('Traced to the uplink on sw-core-a.');
    expect(screen.queryByText(/too long to log/i)).toBeNull();
    expect(logButton().disabled).toBe(false);
  });
});

describe('Tickets — export, share, panels', () => {
  it('offers Copy view link for the selected ticket and active filters', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    renderTickets(
      `/tickets?sel=${encodeURIComponent(FIRST.id)}&q=${encodeURIComponent(FIRST.id.slice(0, 3))}&pri=${FIRST.pri}&state=openish`,
    );
    await waitFor(() => expect(screen.getByRole('button', { name: 'Copy view link' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Copy view link' }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    const url = String(writeText.mock.calls[0]![0]);
    expect(url).toContain(`sel=${encodeURIComponent(FIRST.id)}`);
    expect(url).toContain(`q=${encodeURIComponent(FIRST.id.slice(0, 3))}`);
    expect(url).toContain(`pri=${FIRST.pri}`);
    expect(url).toContain('state=openish');
    expect(screen.getByText(/View link copied/i)).toBeTruthy();
  });

  it('seeds pri/state filters from the URL and writes them back', async () => {
    renderTickets('/tickets?pri=P1&state=openish');
    const p1 = TICKETS.find((t) => t.pri === 'P1' && t.state !== 'resolved')!;
    const p2 = TICKETS.find((t) => t.pri === 'P2' && t.state !== 'resolved')!;
    // Title can appear in queue + detail spine simultaneously.
    await waitFor(() => expect(screen.getAllByText(p1.title).length).toBeGreaterThan(0));
    // Other priorities drop out of the filtered queue.
    expect(screen.queryByText(p2.title)).toBeNull();
    expect(screen.getByTestId('loc').textContent).toContain('pri=P1');
    expect(screen.getByTestId('loc').textContent).toContain('state=openish');

    fireEvent.change(screen.getByRole('combobox', { name: 'Filter by priority' }), {
      target: { value: 'P2' },
    });
    await waitFor(() => expect(screen.getByTestId('loc').textContent).toContain('pri=P2'));
    expect(screen.getAllByText(p2.title).length).toBeGreaterThan(0);
    expect(screen.queryByText(p1.title)).toBeNull();
  });
});

/* Loop 59 — list envelope nextCursor drives Load more (Sites pattern). */
describe('Tickets load-more page cursor', () => {
  it('Load more appends the next cursor page without dropping prior rows', async () => {
    const page1: TicketRow = { ...TICKETS[0], id: 'NET-PAGE-1', title: 'ticket-page-one' };
    const page2: TicketRow = { ...TICKETS[1] ?? TICKETS[0], id: 'NET-PAGE-2', title: 'ticket-page-two' };
    mockGetTickets.mockImplementation(async (query) => {
      if (query?.cursor === 'page-2') {
        return {
          tickets: [page2],
          dataSource: 'live' as const,
          page: { total: 2, limit: 50, cursor: 'page-2', nextCursor: null },
        };
      }
      return {
        tickets: [page1],
        dataSource: 'live' as const,
        page: { total: 2, limit: 50, cursor: '', nextCursor: 'page-2' },
      };
    });

    render(
      <MemoryRouter
        initialEntries={['/tickets']}
        future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
      >
        <SettingsProvider>
          <ToastProvider>
            <Routes>
              <Route path="/tickets" element={<Tickets />} />
            </Routes>
          </ToastProvider>
        </SettingsProvider>
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getAllByText('ticket-page-one').length).toBeGreaterThan(0));
    expect(screen.getByText('Loaded 1 of 2')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await waitFor(() => expect(screen.getAllByText('ticket-page-two').length).toBeGreaterThan(0));
    expect(screen.getAllByText('ticket-page-one').length).toBeGreaterThan(0);
    expect(
      mockGetTickets.mock.calls.some((c) => {
        const arg = c[0];
        return typeof arg === 'object' && arg !== null && arg.cursor === 'page-2';
      }),
    ).toBe(true);
  });

  it('passes pri/state into getTickets so server paging matches the filter row', async () => {
    mockGetTickets.mockResolvedValue({
      tickets: TICKETS.filter((t) => t.pri === 'P1'),
      dataSource: 'live',
      page: { total: 1, limit: 50, cursor: '', nextCursor: null },
    });
    renderTickets('/tickets?pri=P1&state=openish');
    await waitFor(() => expect(mockGetTickets).toHaveBeenCalled());
    expect(
      mockGetTickets.mock.calls.some((c) => {
        const q = c[0];
        return (
          typeof q === 'object' &&
          q !== null &&
          q.pri === 'P1' &&
          q.state === 'openish' &&
          q.limit === 50
        );
      }),
    ).toBe(true);
  });

  it('passes q into getTickets so server paging matches search (Loop 89)', async () => {
    mockGetTickets.mockResolvedValue({
      tickets: TICKETS.filter((t) => t.id.includes('NET')),
      dataSource: 'live',
      page: { total: 1, limit: 50, cursor: '', nextCursor: null },
    });
    renderTickets('/tickets?q=NET&pri=P1');
    await waitFor(() => expect(mockGetTickets).toHaveBeenCalled());
    expect(
      mockGetTickets.mock.calls.some((c) => {
        const arg = c[0];
        return (
          typeof arg === 'object' &&
          arg !== null &&
          arg.q === 'NET' &&
          arg.pri === 'P1' &&
          arg.limit === 50
        );
      }),
    ).toBe(true);
  });
});

describe('Tickets — export, share, panels (live CSV)', () => {
  it('shows Download server CSV only on a live queue and hits /api/tickets/export', async () => {
    mockDownloadApiCsv.mockResolvedValue({ ok: true });
    mockGetTickets.mockResolvedValue({ tickets: TICKETS, dataSource: 'live' });
    render(
      <MemoryRouter
        initialEntries={['/tickets']}
        future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
      >
        <SettingsProvider>
          <ToastProvider>
            <Routes>
              <Route path="/tickets" element={<Tickets />} />
            </Routes>
          </ToastProvider>
        </SettingsProvider>
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByRole('button', { name: 'Download server CSV' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Download server CSV' }));
    await waitFor(() =>
      expect(mockDownloadApiCsv).toHaveBeenCalledWith('/api/tickets/export', 'tickets.csv'),
    );
    expect(screen.getByText(/Server CSV downloaded/i)).toBeTruthy();
  });

  /* Loop 75 — server CSV must carry the same pri/state slice as the filter row. */
  it('passes pri/state into Download server CSV path', async () => {
    mockDownloadApiCsv.mockResolvedValue({ ok: true });
    mockGetTickets.mockResolvedValue({
      tickets: TICKETS.filter((t) => t.pri === 'P1'),
      dataSource: 'live',
    });
    render(
      <MemoryRouter
        initialEntries={['/tickets?pri=P1&state=openish']}
        future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
      >
        <SettingsProvider>
          <ToastProvider>
            <Routes>
              <Route path="/tickets" element={<Tickets />} />
            </Routes>
          </ToastProvider>
        </SettingsProvider>
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByRole('button', { name: 'Download server CSV' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Download server CSV' }));
    await waitFor(() => expect(mockDownloadApiCsv).toHaveBeenCalled());
    const path = String(mockDownloadApiCsv.mock.calls[0]?.[0] ?? '');
    expect(path.startsWith('/api/tickets/export?')).toBe(true);
    expect(path).toMatch(/pri=P1/);
    expect(path).toMatch(/state=openish/);
  });

  /* Loop 89 — q rides the same export path as the search box / list GET. */
  it('passes q into Download server CSV path', async () => {
    mockDownloadApiCsv.mockResolvedValue({ ok: true });
    mockGetTickets.mockResolvedValue({
      tickets: TICKETS,
      dataSource: 'live',
    });
    // Use a fragment of a real fixture id so the queue is non-empty (header
    // actions including Download server CSV only render when a workspace ticket exists).
    const needle = FIRST.id.slice(0, 3);
    render(
      <MemoryRouter
        initialEntries={[`/tickets?q=${encodeURIComponent(needle)}&state=openish`]}
        future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
      >
        <SettingsProvider>
          <ToastProvider>
            <Routes>
              <Route path="/tickets" element={<Tickets />} />
            </Routes>
          </ToastProvider>
        </SettingsProvider>
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByRole('button', { name: 'Download server CSV' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Download server CSV' }));
    await waitFor(() => expect(mockDownloadApiCsv).toHaveBeenCalled());
    const path = String(mockDownloadApiCsv.mock.calls[0]?.[0] ?? '');
    expect(path.startsWith('/api/tickets/export?')).toBe(true);
    expect(path).toMatch(new RegExp(`q=${needle}`));
    expect(path).toMatch(/state=openish/);
  });

  /* Loop 100 — site exact filter write-back + list/export parity. */
  it('seeds site filter from the URL and passes site into list + Download server CSV', async () => {
    mockDownloadApiCsv.mockResolvedValue({ ok: true });
    const siteName = FIRST.siteName;
    mockGetTickets.mockResolvedValue({
      tickets: TICKETS.filter((t) => t.siteName === siteName),
      dataSource: 'live',
    });
    render(
      <MemoryRouter
        initialEntries={[`/tickets?site=${encodeURIComponent(siteName)}`]}
        future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
      >
        <SettingsProvider>
          <ToastProvider>
            <Routes>
              <Route path="/tickets" element={<Tickets />} />
            </Routes>
          </ToastProvider>
        </SettingsProvider>
      </MemoryRouter>,
    );
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: 'Filter by site' })).toBeTruthy(),
    );
    await waitFor(() =>
      expect(mockGetTickets).toHaveBeenCalledWith(
        expect.objectContaining({ site: siteName }),
      ),
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Download server CSV' }));
    await waitFor(() => expect(mockDownloadApiCsv).toHaveBeenCalled());
    const path = String(mockDownloadApiCsv.mock.calls[0]?.[0] ?? '');
    expect(path.startsWith('/api/tickets/export?')).toBe(true);
    // Parse query only — avoid `new URL()` so single-fork suites can't poison
    // global URL via createObjectURL stubs from sibling tests.
    const qs = path.includes('?') ? path.slice(path.indexOf('?') + 1) : '';
    expect(new URLSearchParams(qs).get('site')).toBe(siteName);
  });

  it('hides Download server CSV on demo fixtures', async () => {
    renderTickets();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Export CSV' })).toBeTruthy());
    expect(screen.queryByRole('button', { name: 'Download server CSV' })).toBeNull();
  });

  it('mounts VisualReference and ConfigRecommendations panels', async () => {
    renderTickets();
    await waitFor(() => expect(screen.getByTestId('visual-refs')).toBeTruthy());
    expect(screen.getByTestId('config-recs').textContent).toMatch(/Ticket workflow recommendations/i);
  });
});

describe('Tickets — the retention marker', () => {
  it('marks a dropped-entry notice as retention, not as something an operator did', async () => {
    mockGetTickets.mockResolvedValue({
      tickets: [
        {
          ...FIRST,
          notes: [
            {
              ts: '2024-01-01T00:00:00.000Z',
              kind: 'retention',
              text: '412 earlier entries discarded — this ticket keeps the most recent 199.',
              discarded: 412,
            },
            { ts: '2024-01-02T00:00:00.000Z', kind: 'note', text: 'still watching' },
          ],
        },
        ...TICKETS.slice(1),
      ],
      dataSource: 'demo',
    });
    render(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <SettingsProvider>
          <ToastProvider>
            <Tickets />
          </ToastProvider>
        </SettingsProvider>
      </MemoryRouter>,
    );

    // A retention marker rendered bare would read as an operator's own words.
    await waitFor(() => expect(screen.getByText('DISCARDED')).toBeTruthy());
    expect(screen.getByText(/412 earlier entries discarded/)).toBeTruthy();
    // And it must not borrow the ACTION label, which asserts a person acted.
    expect(screen.queryByText('ACTION')).toBeNull();
    // The label was RETAINED, sitting directly above prose saying the entries
    // were discarded. A marker exists to admit a hole in the log; a badge
    // asserting the opposite of the line it introduces undoes the admission,
    // and this test asserted the label was present without asking whether it
    // was true.
    expect(screen.queryByText('RETAINED')).toBeNull();
  });
});

/* Loop 133 — Priority chip row toggles the same pri= filter as the Select. */
describe('Tickets priority chips (Loop 133)', () => {
  it('priority chips filter the queue and write pri back to the URL', async () => {
    renderTickets('/tickets');
    const p1 = TICKETS.find((t) => t.pri === 'P1')!;
    const p2 = TICKETS.find((t) => t.pri === 'P2' && t.state !== 'resolved')!;
    await waitFor(() => expect(screen.getAllByText(p1.title).length).toBeGreaterThan(0));
    const chips = screen.getByRole('group', { name: 'Ticket priority' });
    const p1Chip = within(chips).getByRole('button', { name: /P1/i });
    expect(p1Chip.getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(p1Chip);
    await waitFor(() => expect(screen.getByTestId('loc').textContent).toContain('pri=P1'));
    expect(screen.getAllByText(p1.title).length).toBeGreaterThan(0);
    expect(screen.queryByText(p2.title)).toBeNull();
    expect(p1Chip.getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(p1Chip);
    await waitFor(() => expect(screen.getByTestId('loc').textContent).not.toContain('pri='));
    expect(screen.getAllByText(p2.title).length).toBeGreaterThan(0);
  });

  it('Clear filters on empty restores the queue', async () => {
    renderTickets('/tickets?pri=P1&q=zzz-no-match');
    await waitFor(() => expect(screen.getByText('No tickets match that filter')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    await waitFor(() => expect(screen.getByTestId('loc').textContent).not.toContain('pri='));
    await waitFor(() => expect(screen.getAllByText(FIRST.title).length).toBeGreaterThan(0));
  });
});

/* Loop 140 — State chip row toggles the same state= filter as the Select. */
describe('Tickets state chips (Loop 140)', () => {
  it('state chips filter the queue and write state back to the URL', async () => {
    renderTickets('/tickets');
    const waiting = TICKETS.find((t) => t.state === 'waiting')!;
    const open = TICKETS.find((t) => t.state === 'open')!;
    await waitFor(() => expect(screen.getAllByText(open.title).length).toBeGreaterThan(0));
    const chips = screen.getByRole('group', { name: 'Ticket state' });
    const waitingChip = within(chips).getByRole('button', { name: /Waiting/i });
    expect(waitingChip.getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(waitingChip);
    await waitFor(() => expect(screen.getByTestId('loc').textContent).toContain('state=waiting'));
    expect(screen.getAllByText(waiting.title).length).toBeGreaterThan(0);
    expect(screen.queryByText(open.title)).toBeNull();
    expect(waitingChip.getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(waitingChip);
    await waitFor(() => expect(screen.getByTestId('loc').textContent).not.toContain('state='));
    expect(screen.getAllByText(open.title).length).toBeGreaterThan(0);
  });
});

/* Loop 148 — Site chip row toggles the same site= filter as the Select. */
describe('Tickets site chips (Loop 148)', () => {
  it('site chips filter the queue and write site back to the URL', async () => {
    renderTickets('/tickets');
    const siteName = FIRST.siteName;
    expect(siteName).toBeTruthy();
    const other = TICKETS.find(
      (t) => String(t.siteName ?? '').trim() && t.siteName !== siteName && t.state !== 'resolved',
    );
    await waitFor(() => expect(screen.getAllByText(FIRST.title).length).toBeGreaterThan(0));
    const chips = screen.getByRole('group', { name: 'Ticket site' });
    const siteChip = within(chips).getByRole('button', {
      name: new RegExp(siteName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'),
    });
    expect(siteChip.getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(siteChip);
    await waitFor(() => {
      const qs = (screen.getByTestId('loc').textContent ?? '').split('?')[1] ?? '';
      expect(new URLSearchParams(qs).get('site')).toBe(siteName);
    });
    expect(screen.getAllByText(FIRST.title).length).toBeGreaterThan(0);
    if (other) {
      expect(screen.queryByText(other.title)).toBeNull();
    }
    expect(siteChip.getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(siteChip);
    await waitFor(() => expect(screen.getByTestId('loc').textContent).not.toMatch(/[?&]site=/));
    expect(screen.getAllByText(FIRST.title).length).toBeGreaterThan(0);
  });
});



/* Loop 159 — LIVE badge honesty + Copy filter link (queue slice without sel). */
describe('Tickets Loop 159 residuals', () => {
  it('stamps LIVE on pure live queue (not only blend mode)', async () => {
    mockGetTickets.mockResolvedValue({ tickets: TICKETS, dataSource: 'live' });
    render(
      <MemoryRouter
        initialEntries={['/tickets']}
        future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
      >
        <SettingsProvider>
          <ToastProvider>
            <Tickets />
          </ToastProvider>
        </SettingsProvider>
      </MemoryRouter>,
    );
    expect(await screen.findByText('LIVE')).toBeTruthy();
  });

  it('stamps LIVE when tickets arrive via blend', async () => {
    mockGetTickets.mockResolvedValue({
      tickets: TICKETS,
      dataSource: 'demo',
      blended: ['tickets'],
    });
    render(
      <MemoryRouter
        initialEntries={['/tickets']}
        future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
      >
        <SettingsProvider>
          <ToastProvider>
            <Tickets />
          </ToastProvider>
        </SettingsProvider>
      </MemoryRouter>,
    );
    expect(await screen.findByText('LIVE')).toBeTruthy();
  });

  it('Copy filter link shares q/pri/state/site without locking sel', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    renderTickets(
      `/tickets?sel=${encodeURIComponent(FIRST.id)}&q=${encodeURIComponent(FIRST.id.slice(0, 3))}&pri=${FIRST.pri}&state=openish`,
    );
    await waitFor(() => expect(screen.getByRole('button', { name: 'Copy filter link' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Copy filter link' }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    const url = String(writeText.mock.calls[0]![0]);
    expect(url).not.toMatch(/[?&]sel=/);
    expect(url).toContain(`q=${encodeURIComponent(FIRST.id.slice(0, 3))}`);
    expect(url).toContain(`pri=${FIRST.pri}`);
    expect(url).toContain('state=openish');
    expect(screen.getByText(/Filter link copied/i)).toBeTruthy();
  });
});

/* Loop 171 — Tickets bulk Export selected + Copy IDs. */
describe('Tickets Loop 171 residuals', () => {
  it('raises bulk bar with Export selected and Copy IDs for marked queue rows', async () => {
    const createObjectURL = vi.fn(() => 'blob:tickets-selected');
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    renderTickets('/tickets');
    await waitFor(() => expect(screen.getAllByText(FIRST.title).length).toBeGreaterThan(0));

    const second = TICKETS.find((t) => t.id !== FIRST.id && t.state !== 'resolved') ?? TICKETS[1];
    expect(second).toBeTruthy();

    fireEvent.click(screen.getByLabelText(`Select ticket ${FIRST.id}`));
    fireEvent.click(screen.getByLabelText(`Select ticket ${second!.id}`));

    const bar = await screen.findByRole('region', { name: 'Ticket selection actions' });
    expect(within(bar).getByText('2 SELECTED')).toBeTruthy();

    fireEvent.click(within(bar).getByRole('button', { name: 'Copy IDs' }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    const text = String(writeText.mock.calls[0]![0]);
    expect(text.split('\n').sort()).toEqual([FIRST.id, second!.id].sort());
    expect(screen.getByText(/Copied 2 ticket ids/i)).toBeTruthy();

    fireEvent.click(within(bar).getByRole('button', { name: 'Export selected' }));
    expect(await screen.findByText(/Exported 2 selected tickets/i)).toBeTruthy();
    expect(createObjectURL).toHaveBeenCalled();

    fireEvent.click(within(bar).getByRole('button', { name: 'Clear' }));
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: 'Ticket selection actions' })).toBeNull(),
    );
  });
});

/* Loop 175 — bulk Copy selection link (?ids=) + clearable chip. */
describe('Tickets Loop 175 residuals', () => {
  it('Copy selection link writes ids= and the deep link filters the queue', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    renderTickets('/tickets');
    await waitFor(() => expect(screen.getAllByText(FIRST.title).length).toBeGreaterThan(0));

    fireEvent.click(screen.getByLabelText(`Select ticket ${FIRST.id}`));
    const bar = await screen.findByRole('region', { name: 'Ticket selection actions' });
    fireEvent.click(within(bar).getByRole('button', { name: 'Copy selection link' }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(String(writeText.mock.calls[0]![0])).toMatch(/ids=/);
    expect(String(writeText.mock.calls[0]![0])).toContain(FIRST.id);
    expect(await screen.findByText(/Selection link copied/)).toBeTruthy();
  });

  it('deep-links ?ids= and shows a clearable selection chip', async () => {
    const second = TICKETS.find((t) => t.id !== FIRST.id) ?? TICKETS[1]!;
    renderTickets(`/tickets?ids=${encodeURIComponent(FIRST.id)}`);
    await waitFor(() => expect(screen.getAllByText(FIRST.title).length).toBeGreaterThan(0));
    expect(screen.queryByText(second.title)).toBeNull();
    const chip = screen.getByRole('group', { name: 'Selection deep link' });
    expect(within(chip).getByText(/1 selected ticket/)).toBeTruthy();
    fireEvent.click(within(chip).getByRole('button'));
    await waitFor(() => expect(screen.getByTestId('loc').textContent).not.toMatch(/ids=/));
    expect(await screen.findByText(second.title)).toBeTruthy();
  });
});

/* Loop 196 — keyboard shortcuts help on the queue. */
describe('Tickets Loop 196 residuals', () => {
  it('exposes keyboard shortcuts help on the ticket queue', async () => {
    renderTickets('/tickets');
    await waitFor(() => expect(screen.getAllByText(FIRST.title).length).toBeGreaterThan(0));
    expect(screen.getByRole('button', { name: 'Keyboard shortcuts' })).toBeTruthy();
  });
});

/* Loop 210 — queue selection-empty Clear selection filter CTA. */
describe('Tickets Loop 210 residuals', () => {
  it('offers Clear selection filter when ids deep link matches nothing', async () => {
    renderTickets(`/tickets?ids=${encodeURIComponent('TICKET-MISSING-ZZZ')}`);
    expect(await screen.findByText('No tickets match this selection')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Clear selection filter' }));
    await waitFor(() => expect(screen.getByTestId('loc').textContent).not.toMatch(/ids=/));
    await waitFor(() => expect(screen.getAllByText(FIRST.title).length).toBeGreaterThan(0));
    expect(screen.queryByText('No tickets match this selection')).toBeNull();
  });
});

/* Loop 229 — queue bulk Copy titles (non-selection-empty residual). */
describe('Tickets Loop 229 residuals', () => {
  it('Copy titles joins unique ticket titles from the selection', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    renderTickets('/tickets');
    await waitFor(() => expect(screen.getAllByText(FIRST.title).length).toBeGreaterThan(0));

    const second = TICKETS.find((t) => t.id !== FIRST.id && t.state !== 'resolved') ?? TICKETS[1];
    expect(second).toBeTruthy();

    fireEvent.click(screen.getByLabelText(`Select ticket ${FIRST.id}`));
    fireEvent.click(screen.getByLabelText(`Select ticket ${second!.id}`));

    const bar = await screen.findByRole('region', { name: 'Ticket selection actions' });
    expect(within(bar).getByRole('button', { name: 'Copy titles' })).toBeTruthy();
    fireEvent.click(within(bar).getByRole('button', { name: 'Copy titles' }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(String(writeText.mock.calls[0]![0]).split('\n').sort()).toEqual(
      [FIRST.title, second!.title].sort(),
    );
    expect(await screen.findByText(/Copied 2 titles/i)).toBeTruthy();
  });
});
