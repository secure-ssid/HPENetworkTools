import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import Tickets from './Tickets';
import { SettingsProvider } from '../app/SettingsContext';
import { ToastProvider } from '../nightdesk';
import { addTicketNote, getTickets, resolveTicket } from '../api/client';
import { MAX_NOTE_CHARS, TICKETS } from '@hpe/shared';
import type { TicketRow } from '@hpe/shared';

vi.mock('../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/client')>();
  return {
    ...actual,
    getTickets: vi.fn(),
    addTicketNote: vi.fn(),
    resolveTicket: vi.fn(),
  };
});

const mockGetTickets = vi.mocked(getTickets);
const mockAddTicketNote = vi.mocked(addTicketNote);
const mockResolveTicket = vi.mocked(resolveTicket);

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const FIRST: TicketRow = TICKETS[0];

function renderTickets() {
  mockGetTickets.mockResolvedValue({ tickets: TICKETS, dataSource: 'demo' });
  return render(
    <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <SettingsProvider>
        <ToastProvider>
          <Tickets />
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
