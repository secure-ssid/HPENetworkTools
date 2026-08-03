/**
 * web/src/screens/GreenLake.test.tsx — GreenLake workspace screen.
 *
 * The screen's job is to be honest about what it could not read and about who
 * is allowed to change things, so that is what is pinned here: a section whose
 * read FAILED must render as a named failure rather than as an empty table
 * (otherwise "denied" and "this workspace has none" look identical), and a
 * read-only credential must not be shown write controls it cannot use.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getGreenLakeInventory, runGreenLakeAction } from '../api/client';
import { SettingsProvider } from '../app/SettingsContext';
import { ToastProvider } from '../nightdesk';
import GreenLake from './GreenLake';

const { mockLabConfigMode } = vi.hoisted(() => ({ mockLabConfigMode: vi.fn(() => ({ lab: false })) }));
vi.mock('../hooks/useLabConfigMode', () => ({ useLabConfigMode: mockLabConfigMode }));

vi.mock('../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/client')>();
  return { ...actual, getGreenLakeInventory: vi.fn(), runGreenLakeAction: vi.fn() };
});

const mockInventory = vi.mocked(getGreenLakeInventory);
const mockAction = vi.mocked(runGreenLakeAction);

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  mockLabConfigMode.mockReturnValue({ lab: false });
});

const USER = {
  id: 'u-1',
  username: 'ops@example.com',
  firstName: 'Ops',
  lastName: 'Person',
  status: 'VERIFIED',
  lastLogin: null,
  createdAt: null,
  roles: ['ccs.operator'],
};

function inventory(over: Partial<Parameters<typeof renderScreen>[0]> = {}) {
  return {
    users: [USER],
    locations: [],
    roleAssignments: [],
    unavailable: [],
    readStatus: {},
    source: 'global.api.greenlake.hpe.com · 3 of 3 sections read',
    canWrite: true,
    ...over,
  };
}

function renderScreen(payload: Record<string, unknown>) {
  mockInventory.mockResolvedValue(payload as never);
  return render(
    <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <ToastProvider>
        <SettingsProvider>
          <GreenLake />
        </SettingsProvider>
      </ToastProvider>
    </MemoryRouter>,
  );
}

describe('GreenLake screen', () => {
  it('renders the workspace directory it could read', async () => {
    renderScreen(inventory());
    expect(await screen.findByText('ops@example.com')).toBeTruthy();
  });

  // The core honesty rule: a failed read is not an authoritative empty list.
  it('renders an unreadable section as a named failure, not as an empty table', async () => {
    renderScreen(
      inventory({
        users: [],
        unavailable: ['users'],
        readStatus: { users: { state: 'failed', reason: 'denied', message: 'HTTP 403' } },
      }),
    );
    await waitFor(() => expect(screen.getByText(/workspace members could not be read/i)).toBeTruthy());
    // The page-level banner counts the gap so the failure is visible without
    // scrolling to the affected section.
    expect(screen.getByText(/1 of 3 greenlake sections could not be read/i)).toBeTruthy();
    // The reason survives to the operator rather than collapsing to "no data".
    expect(screen.getByText(/HTTP 403/)).toBeTruthy();
    // An empty-state that implies the workspace has no members must not appear.
    expect(screen.queryByText(/no members/i)).toBeNull();
  });

  it('hides every write control when the credential is read-only', async () => {
    renderScreen(inventory({ canWrite: false }));
    await screen.findByText('ops@example.com');
    expect(screen.queryByRole('button', { name: /invite/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /create location/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /add device/i })).toBeNull();
  });

  it('offers the write controls when the credential declares a write scope', async () => {
    renderScreen(inventory());
    await screen.findByText('ops@example.com');
    expect(screen.getByRole('button', { name: /create location/i })).toBeTruthy();
  });
});

/**
 * The lists on this screen come from the poller cache, not a live read, so a
 * change the workspace applied is only visible once that cache moves forward.
 * When it does not, "Applied" over an unchanged table is indistinguishable
 * from the write having done nothing — and the obvious operator response to
 * that is to run the action again, which on invite/create actions means a
 * duplicate. So the stale view has to be stated.
 */
describe('GreenLake screen — post-write freshness', () => {
  async function invite(result: Record<string, unknown>) {
    mockAction.mockResolvedValue(result as never);
    renderScreen(inventory());
    const field = await screen.findByPlaceholderText('person@example.com');
    fireEvent.change(field, { target: { value: 'new@example.com' } });
    fireEvent.click(screen.getByText('Send invite'));
  }

  it('uses the direct lab request while retaining the server outcome display', async () => {
    mockLabConfigMode.mockReturnValue({ lab: true });
    await invite({ ok: true, message: 'invitation sent', outcome: 'applied' });
    await waitFor(() => expect(mockAction).toHaveBeenCalledWith('inviteUser', expect.any(Object), undefined));
    expect(await screen.findByText('Applied in GreenLake')).toBeTruthy();
  });

  it('says the lists are behind when the workspace could not be re-read', async () => {
    await invite({
      ok: true,
      message: 'invitation sent',
      outcome: 'applied',
      cacheRefresh: { attempted: true, ok: false, message: 'the workspace could not be re-read' },
    });
    expect(await screen.findByText(/the lists below are behind/i)).toBeTruthy();
    // It must also say what to do, because the instinct is to try again.
    expect(await screen.findByText(/Do not repeat it/i)).toBeTruthy();
  });

  it('reports a plain applied result when the re-read landed', async () => {
    await invite({
      ok: true,
      message: 'invitation sent',
      outcome: 'applied',
      cacheRefresh: { attempted: true, ok: true },
    });
    expect(await screen.findByText('Applied in GreenLake')).toBeTruthy();
    expect(screen.queryByText(/the lists below are behind/i)).toBeNull();
  });

  // An older server that never refreshed at all is not the same as one whose
  // refresh was tried and failed, and the screen must not invent the claim.
  it('stays quiet about freshness when the server did not report any', async () => {
    await invite({ ok: true, message: 'invitation sent', outcome: 'applied' });
    expect(await screen.findByText('Applied in GreenLake')).toBeTruthy();
    expect(screen.queryByText(/the lists below are behind/i)).toBeNull();
  });

  // A 202 already explains why the row is missing. Adding a staleness warning
  // on top would blame the cache for an absence the workspace intends.
  it('does not add a staleness warning to an accepted 202', async () => {
    await invite({
      ok: true,
      message: 'key submitted',
      outcome: 'accepted',
      cacheRefresh: { attempted: false, ok: false },
    });
    expect(await screen.findByText('Submitted to GreenLake')).toBeTruthy();
    expect(screen.queryByText(/the lists below are behind/i)).toBeNull();
  });

  /**
   * A 202 is the one outcome the operator cannot verify from this screen: the
   * row will not appear, and whether it ever does is decided in GreenLake.
   * Saying "not applied yet" without the workspace's handle for it leaves them
   * with a warning and no way to act on it.
   */
  it('gives the operator the transaction handle for an accepted change', async () => {
    await invite({
      ok: true,
      message: 'key submitted',
      outcome: 'accepted',
      transactionId: 'txn-7',
    });
    expect(await screen.findByText(/Workspace transaction txn-7/)).toBeTruthy();
  });

  // Not every 202 carries one. Silence would read as "there was nothing to
  // tell you"; the screen says the handle is missing instead of implying the
  // change can be traced when it cannot.
  it('says so when an accepted change came back without a handle', async () => {
    await invite({ ok: true, message: 'key submitted', outcome: 'accepted' });
    expect(await screen.findByText(/no transaction id/i)).toBeTruthy();
    expect(screen.queryByText(/Workspace transaction/)).toBeNull();
  });

  // The lists cannot show the new object, so its id is the only thing the
  // operator can check the change against while the view is behind.
  it('gives the created id when the change applied but the lists are behind', async () => {
    await invite({
      ok: true,
      message: 'invitation sent',
      outcome: 'applied',
      cacheRefresh: { attempted: true, ok: false, message: 'the workspace could not be re-read' },
      id: 'usr-42',
    });
    expect(await screen.findByText(/GreenLake id usr-42/)).toBeTruthy();
  });

  it('reports a refused change as a failure and never as applied', async () => {
    await invite({ ok: false, message: 'HTTP 403 — not permitted' });
    expect(await screen.findByText('GreenLake refused the change')).toBeTruthy();
    expect(screen.queryByText(/Applied in GreenLake/)).toBeNull();
  });
});
