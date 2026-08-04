/**
 * web/src/screens/GreenLake.test.tsx — GreenLake workspace screen.
 *
 * The screen's job is to be honest about what it could not read and about who
 * is allowed to change things, so that is what is pinned here: a section whose
 * read FAILED must render as a named failure rather than as an empty table
 * (otherwise "denied" and "this workspace has none" look identical), and a
 * read-only credential must not be shown write controls it cannot use.
 */

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getGreenLakeInventory, runGreenLakeAction } from '../api/client';
import { SettingsProvider } from '../app/SettingsContext';
import { ToastProvider } from '../nightdesk';
import GreenLake, {
  buildGreenLakeShareUrl,
  matchesGreenLakeQ,
  matchesGreenLakeUserStatus,
  sectionDomId,
  sectionFromParam,
  sectionToExportPart,
  sectionToParam,
} from './GreenLake';
import { downloadApiCsv } from '../lib/downloadApiCsv';

const { mockLabConfigMode } = vi.hoisted(() => ({ mockLabConfigMode: vi.fn(() => ({ lab: false })) }));
vi.mock('../hooks/useLabConfigMode', () => ({ useLabConfigMode: mockLabConfigMode }));

vi.mock('../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/client')>();
  return { ...actual, getGreenLakeInventory: vi.fn(), runGreenLakeAction: vi.fn() };
});

vi.mock('../lib/downloadApiCsv', () => ({
  downloadApiCsv: vi.fn(),
}));

const mockInventory = vi.mocked(getGreenLakeInventory);
const mockAction = vi.mocked(runGreenLakeAction);
const mockDownloadApiCsv = vi.mocked(downloadApiCsv);

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  mockLabConfigMode.mockReturnValue({ lab: false });
});

// jsdom lacks a working scrollIntoView; section focus effect calls it when ?section= is set.
Element.prototype.scrollIntoView = vi.fn();

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

function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="loc">{`${loc.pathname}${loc.search}`}</div>;
}

function renderScreen(payload: Record<string, unknown>, initialPath = '/greenlake') {
  mockInventory.mockResolvedValue(payload as never);
  return render(
    <MemoryRouter
      initialEntries={[initialPath]}
      future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
    >
      <ToastProvider>
        <SettingsProvider>
          <Routes>
            <Route
              path="/greenlake"
              element={
                <>
                  <GreenLake />
                  <LocationProbe />
                </>
              }
            />
          </Routes>
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

  /* Loop 78 — hardened mode never auto-sends reviewConfirmed without a tick. */
  it('keeps write actions disarmed until the review checkbox is ticked (hardened)', async () => {
    renderScreen(inventory());
    await screen.findByText('ops@example.com');
    const invite = screen.getByRole('button', { name: /send invite/i });
    // Empty email already disables; fill it and the review gate still holds.
    fireEvent.change(screen.getByPlaceholderText('person@example.com'), {
      target: { value: 'new@example.com' },
    });
    expect((invite as HTMLButtonElement).disabled).toBe(true);
    expect(
      screen.getByLabelText(/I have reviewed this write/i),
    ).toBeTruthy();
    fireEvent.click(screen.getByLabelText(/I have reviewed this write/i));
    expect((invite as HTMLButtonElement).disabled).toBe(false);
  });

  it('lab mode skips the review checkbox and sends without reviewConfirmed', async () => {
    mockLabConfigMode.mockReturnValue({ lab: true });
    mockAction.mockResolvedValue({ ok: true, message: 'invitation sent', outcome: 'applied' } as never);
    renderScreen(inventory());
    await screen.findByText('ops@example.com');
    expect(screen.queryByLabelText(/I have reviewed this write/i)).toBeNull();
    fireEvent.change(screen.getByPlaceholderText('person@example.com'), {
      target: { value: 'new@example.com' },
    });
    fireEvent.click(screen.getByRole('button', { name: /send invite/i }));
    await waitFor(() =>
      expect(mockAction).toHaveBeenCalledWith('inviteUser', expect.any(Object), undefined),
    );
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
    // Hardened mode: arm the review gate before the write is allowed.
    const review = screen.queryByLabelText(/I have reviewed this write/i);
    if (review) fireEvent.click(review);
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

describe('GreenLake share + server CSV', () => {
  it('offers Download server CSV and Copy view link', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    renderScreen(inventory({ canWrite: false }));
    expect(await screen.findByRole('button', { name: 'Download server CSV' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Copy view link' }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
  });

  it('Download server CSV defaults to part=users when no section focus (Loop 96)', async () => {
    mockDownloadApiCsv.mockResolvedValue({ ok: true });
    renderScreen(inventory({ canWrite: false }));
    fireEvent.click(await screen.findByRole('button', { name: 'Download server CSV' }));
    await waitFor(() =>
      expect(mockDownloadApiCsv).toHaveBeenCalledWith(
        '/api/greenlake/export?part=users',
        'greenlake-users.csv',
      ),
    );
  });

  it('Download server CSV follows ?section= into part= (Loop 96)', async () => {
    // jsdom lacks scrollIntoView; section focus effect calls it when ?section= is set.
    Element.prototype.scrollIntoView = vi.fn();
    mockDownloadApiCsv.mockResolvedValue({ ok: true });
    renderScreen(inventory({ canWrite: false }), '/greenlake?section=locations');
    fireEvent.click(await screen.findByRole('button', { name: 'Download server CSV' }));
    await waitFor(() =>
      expect(mockDownloadApiCsv).toHaveBeenCalledWith(
        '/api/greenlake/export?part=locations',
        'greenlake-locations.csv',
      ),
    );

    cleanup();
    mockDownloadApiCsv.mockClear();
    mockDownloadApiCsv.mockResolvedValue({ ok: true });
    renderScreen(inventory({ canWrite: false }), '/greenlake?section=roles');
    fireEvent.click(await screen.findByRole('button', { name: 'Download server CSV' }));
    await waitFor(() =>
      expect(mockDownloadApiCsv).toHaveBeenCalledWith(
        '/api/greenlake/export?part=roles',
        'greenlake-roles.csv',
      ),
    );
  });

  it('Copy section link shares each section with ?section= + hash (Loop 72)', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    renderScreen(inventory({ canWrite: false }));
    await screen.findByText('ops@example.com');

    const sectionButtons = screen.getAllByRole('button', { name: 'Copy section link' });
    expect(sectionButtons).toHaveLength(3);

    fireEvent.click(sectionButtons[0]!);
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(String(writeText.mock.calls[0]![0])).toMatch(/section=users/);
    expect(String(writeText.mock.calls[0]![0])).toMatch(/#greenlake-section-users/);

    fireEvent.click(sectionButtons[1]!);
    await waitFor(() => expect(writeText.mock.calls.length).toBeGreaterThanOrEqual(2));
    expect(String(writeText.mock.calls[1]![0])).toMatch(/section=roles/);
    expect(String(writeText.mock.calls[1]![0])).toMatch(/#greenlake-section-roles/);

    fireEvent.click(sectionButtons[2]!);
    await waitFor(() => expect(writeText.mock.calls.length).toBeGreaterThanOrEqual(3));
    expect(String(writeText.mock.calls[2]![0])).toMatch(/section=locations/);
    expect(String(writeText.mock.calls[2]![0])).toMatch(/#greenlake-section-locations/);
  });
});

describe('GreenLake section helpers', () => {
  it('round-trips section param tokens and builds share URLs', () => {
    expect(sectionFromParam('users')).toBe('users');
    expect(sectionFromParam('roles')).toBe('roleAssignments');
    expect(sectionFromParam('roleAssignments')).toBe('roleAssignments');
    expect(sectionFromParam('nope')).toBeNull();
    expect(sectionToParam('roleAssignments')).toBe('roles');
    expect(sectionDomId('roleAssignments')).toBe('greenlake-section-roles');
    expect(buildGreenLakeShareUrl('users', 'http://x', '/greenlake')).toBe(
      'http://x/greenlake?section=users#greenlake-section-users',
    );
    expect(buildGreenLakeShareUrl(null, 'http://x', '/greenlake')).toBe('http://x/greenlake');
  });

  it('maps focused section onto greenlake export part (Loop 96)', () => {
    expect(sectionToExportPart(null)).toBe('users');
    expect(sectionToExportPart('users')).toBe('users');
    expect(sectionToExportPart('locations')).toBe('locations');
    expect(sectionToExportPart('roleAssignments')).toBe('roles');
  });

  it('buildGreenLakeShareUrl carries optional q (Loop 95)', () => {
    expect(buildGreenLakeShareUrl('users', 'http://x', '/greenlake', 'ops')).toBe(
      'http://x/greenlake?section=users&q=ops#greenlake-section-users',
    );
    expect(buildGreenLakeShareUrl(null, 'http://x', '/greenlake', 'ops')).toBe(
      'http://x/greenlake?q=ops',
    );
  });

  it('matchesGreenLakeQ is case-insensitive substring', () => {
    expect(matchesGreenLakeQ(['Ops@Example.com', 'VERIFIED'], 'ops@')).toBe(true);
    expect(matchesGreenLakeQ(['Ops@Example.com'], 'zzz')).toBe(false);
    expect(matchesGreenLakeQ(['a'], '')).toBe(true);
  });

  it('buildGreenLakeShareUrl + status match (Loop 107)', () => {
    expect(buildGreenLakeShareUrl('users', 'http://x', '/greenlake', 'ops', 'VERIFIED')).toBe(
      'http://x/greenlake?section=users&q=ops&status=VERIFIED#greenlake-section-users',
    );
    expect(matchesGreenLakeUserStatus('VERIFIED', 'verified')).toBe(true);
    expect(matchesGreenLakeUserStatus('PENDING', 'VERIFIED')).toBe(false);
    expect(matchesGreenLakeUserStatus('x', 'all')).toBe(true);
  });
});

describe('GreenLake q filter share + server CSV (Loop 95)', () => {
  it('Download server CSV passes q= when filter is set', async () => {
    mockDownloadApiCsv.mockResolvedValue({ ok: true });
    renderScreen(inventory({ canWrite: false }), '/greenlake?q=ops');
    expect(await screen.findByDisplayValue('ops')).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: 'Download server CSV' }));
    await waitFor(() => expect(mockDownloadApiCsv).toHaveBeenCalled());
    const path = String(mockDownloadApiCsv.mock.calls[0]![0]);
    expect(path).toContain('/api/greenlake/export?');
    const qs = new URLSearchParams(path.split('?')[1]);
    expect(qs.get('part')).toBe('users');
    expect(qs.get('q')).toBe('ops');
  });

  it('Download server CSV passes status= for users (Loop 107)', async () => {
    mockDownloadApiCsv.mockClear();
    mockDownloadApiCsv.mockResolvedValue({ ok: true });
    renderScreen(inventory({ canWrite: false }), '/greenlake?status=VERIFIED');
    fireEvent.click(await screen.findByRole('button', { name: 'Download server CSV' }));
    await waitFor(() => expect(mockDownloadApiCsv).toHaveBeenCalled());
    const path = String(mockDownloadApiCsv.mock.calls[0]![0]);
    const qs = new URLSearchParams(path.split('?')[1]);
    expect(qs.get('part')).toBe('users');
    expect(qs.get('status')).toBe('VERIFIED');
  });
});

/* Loop 136 — Status chip row toggles the same status= filter as the Select. */
describe('GreenLake member status chips (Loop 136)', () => {
  it('status chips filter members and write status back to the URL', async () => {
    renderScreen(
      inventory({
        canWrite: false,
        users: [
          { ...USER, id: 'u-1', username: 'ops@example.com', status: 'VERIFIED' },
          {
            ...USER,
            id: 'u-2',
            username: 'pending@example.com',
            firstName: 'Pending',
            lastName: 'Person',
            status: 'PENDING',
          },
        ],
      }),
    );
    expect(await screen.findByText('ops@example.com')).toBeTruthy();
    expect(screen.getByText('pending@example.com')).toBeTruthy();

    const chips = screen.getByRole('group', { name: 'Member status' });
    const pending = within(chips).getByRole('button', { name: /PENDING/i });
    expect(pending.getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(pending);
    await waitFor(() => expect(screen.getByText('pending@example.com')).toBeTruthy());
    expect(screen.queryByText('ops@example.com')).toBeNull();
    expect(screen.getByTestId('loc').textContent).toMatch(/status=PENDING/i);
    expect(pending.getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(pending);
    await waitFor(() => expect(screen.getByText('ops@example.com')).toBeTruthy());
    expect(screen.getByText('pending@example.com')).toBeTruthy();
    expect(screen.getByTestId('loc').textContent).not.toMatch(/status=/i);
  });
});

/* Loop 168 — LIVE badge on plane-sourced workspace inventory. */
describe('GreenLake Loop 168 residuals', () => {
  it('stamps LIVE when workspace inventory loads from the plane', async () => {
    renderScreen(inventory());
    expect(await screen.findByText('ops@example.com')).toBeTruthy();
    expect(screen.getByText('LIVE')).toBeTruthy();
    expect(screen.getByText(/GLOBAL\.API\.GREENLAKE/)).toBeTruthy();
  });

  it('keeps LIVE beside the provenance stamp after a partial read', async () => {
    renderScreen(
      inventory({
        users: [],
        unavailable: ['users'],
        readStatus: { users: { state: 'failed', reason: 'denied', message: 'HTTP 403' } },
        source: 'global.api.greenlake.hpe.com · 2 of 3 sections read',
      }),
    );
    await waitFor(() => expect(screen.getByText(/workspace members could not be read/i)).toBeTruthy());
    expect(screen.getByText('LIVE')).toBeTruthy();
  });
});

/* Loop 172 — members bulk Export selected + Copy emails. */
describe('GreenLake Loop 172 residuals', () => {
  it('shows bulk bar for selection: Export selected, Copy emails, Clear', async () => {
    const createObjectURL = vi.fn(() => 'blob:gl-members-selected');
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    const { container } = renderScreen(
      inventory({
        users: [
          USER,
          {
            id: 'u-2',
            username: 'pending@example.com',
            firstName: 'Pending',
            lastName: 'User',
            status: 'PENDING',
            lastLogin: null,
            createdAt: null,
            roles: [],
          },
        ],
      }),
    );
    expect(await screen.findByText('ops@example.com')).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Workspace member selection actions' })).toBeNull();

    const first = container.querySelector('tbody tr') as HTMLElement;
    expect(first).toBeTruthy();
    first.focus();
    fireEvent.keyDown(first, { key: 'x' });

    const bar = await screen.findByRole('region', { name: 'Workspace member selection actions' });
    expect(within(bar).getByText('1 SELECTED')).toBeTruthy();

    fireEvent.click(within(bar).getByRole('button', { name: 'Export selected' }));
    expect(await screen.findByText(/Exported 1 selected member/)).toBeTruthy();
    expect(createObjectURL).toHaveBeenCalled();

    fireEvent.click(within(bar).getByRole('button', { name: 'Copy emails' }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(String(writeText.mock.calls[0]![0])).toContain('ops@example.com');
    expect(await screen.findByText(/Copied 1 email/)).toBeTruthy();

    fireEvent.click(within(bar).getByRole('button', { name: 'Clear' }));
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: 'Workspace member selection actions' })).toBeNull(),
    );
  });
});

/* Loop 231 — members bulk Copy names (display names) beside Copy emails. */
describe('GreenLake Loop 231 residuals', () => {
  it('Copy names joins unique member display names from the selection', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    const { container } = renderScreen(
      inventory({
        users: [
          USER,
          {
            id: 'u-2',
            username: 'pending@example.com',
            firstName: 'Pending',
            lastName: 'User',
            status: 'PENDING',
            lastLogin: null,
            createdAt: null,
            roles: [],
          },
          {
            id: 'u-3',
            username: 'ops.alias@example.com',
            firstName: 'Ops',
            lastName: 'Person',
            status: 'VERIFIED',
            lastLogin: null,
            createdAt: null,
            roles: [],
          },
        ],
      }),
    );
    expect(await screen.findByText('ops@example.com')).toBeTruthy();
    expect(await screen.findByText('pending@example.com')).toBeTruthy();

    const rows = container.querySelectorAll('tbody tr');
    expect(rows.length).toBeGreaterThanOrEqual(3);
    for (let i = 0; i < 3; i++) {
      (rows[i] as HTMLElement).focus();
      fireEvent.keyDown(rows[i] as HTMLElement, { key: 'x' });
    }

    const bar = await screen.findByRole('region', { name: 'Workspace member selection actions' });
    expect(within(bar).getByRole('button', { name: 'Copy names' })).toBeTruthy();
    fireEvent.click(within(bar).getByRole('button', { name: 'Copy names' }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    /* Ops Person appears twice (u-1 + u-3) — unique set is two display names. */
    expect(String(writeText.mock.calls[0]![0])).toBe('Ops Person\nPending User');
    expect(await screen.findByText(/Copied 2 names/)).toBeTruthy();
  });
});

/* Loop 178 — members bulk Copy selection link (?ids=) + clearable chip. */
describe('GreenLake Loop 178 residuals', () => {
  it('Copy selection link writes ids= and the deep link filters members', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    const { container } = renderScreen(
      inventory({
        users: [
          USER,
          {
            id: 'u-2',
            username: 'pending@example.com',
            firstName: 'Pending',
            lastName: 'User',
            status: 'PENDING',
            lastLogin: null,
            createdAt: null,
            roles: [],
          },
        ],
      }),
    );
    expect(await screen.findByText('ops@example.com')).toBeTruthy();
    expect(await screen.findByText('pending@example.com')).toBeTruthy();

    const first = container.querySelector('tbody tr') as HTMLElement;
    expect(first).toBeTruthy();
    first.focus();
    fireEvent.keyDown(first, { key: 'x' });

    const bar = await screen.findByRole('region', { name: 'Workspace member selection actions' });
    fireEvent.click(within(bar).getByRole('button', { name: 'Copy selection link' }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(String(writeText.mock.calls[0]![0])).toMatch(/ids=/);
    expect(String(writeText.mock.calls[0]![0])).toContain('u-1');
    expect(await screen.findByText(/Selection link copied/)).toBeTruthy();
  });

  it('deep-links ?ids= and shows a clearable selection chip', async () => {
    renderScreen(
      inventory({
        users: [
          USER,
          {
            id: 'u-2',
            username: 'pending@example.com',
            firstName: 'Pending',
            lastName: 'User',
            status: 'PENDING',
            lastLogin: null,
            createdAt: null,
            roles: [],
          },
        ],
      }),
      '/greenlake?ids=u-1',
    );
    expect(await screen.findByText('ops@example.com')).toBeTruthy();
    expect(screen.queryByText('pending@example.com')).toBeNull();
    const chip = screen.getByRole('group', { name: 'Selection deep link' });
    expect(within(chip).getByText(/1 selected member/)).toBeTruthy();
    fireEvent.click(within(chip).getByRole('button'));
    await waitFor(() => expect(screen.getByTestId('loc').textContent).not.toMatch(/ids=/));
    expect(await screen.findByText('pending@example.com')).toBeTruthy();
  });
});

/* Loop 177 — members bulk Copy selection link (?ids=) + clearable chip. */
describe('GreenLake Loop 177 residuals', () => {
  it('Copy selection link writes ids= and the deep link filters members', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    const { container } = renderScreen(
      inventory({
        users: [
          USER,
          {
            id: 'u-2',
            username: 'pending@example.com',
            firstName: 'Pending',
            lastName: 'User',
            status: 'PENDING',
            lastLogin: null,
            createdAt: null,
            roles: [],
          },
        ],
      }),
    );
    expect(await screen.findByText('ops@example.com')).toBeTruthy();
    expect(await screen.findByText('pending@example.com')).toBeTruthy();

    const first = container.querySelector('tbody tr') as HTMLElement;
    expect(first).toBeTruthy();
    first.focus();
    fireEvent.keyDown(first, { key: 'x' });

    const bar = await screen.findByRole('region', { name: 'Workspace member selection actions' });
    fireEvent.click(within(bar).getByRole('button', { name: 'Copy selection link' }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    const url = String(writeText.mock.calls[0]![0]);
    expect(url).toMatch(/ids=/);
    expect(url).toContain('u-1');
    expect(await screen.findByText(/Selection link copied/)).toBeTruthy();
  });

  it('deep-links ?ids= and shows a clearable selection chip', async () => {
    renderScreen(
      inventory({
        users: [
          USER,
          {
            id: 'u-2',
            username: 'pending@example.com',
            firstName: 'Pending',
            lastName: 'User',
            status: 'PENDING',
            lastLogin: null,
            createdAt: null,
            roles: [],
          },
        ],
      }),
      `/greenlake?ids=${encodeURIComponent('u-1')}`,
    );
    expect(await screen.findByText('ops@example.com')).toBeTruthy();
    expect(screen.queryByText('pending@example.com')).toBeNull();
    const chip = screen.getByRole('group', { name: 'Selection deep link' });
    expect(within(chip).getByText(/1 selected member/)).toBeTruthy();
    fireEvent.click(within(chip).getByRole('button'));
    await waitFor(() => expect(screen.getByTestId('loc').textContent).not.toMatch(/ids=/));
    expect(await screen.findByText('pending@example.com')).toBeTruthy();
  });
});

const ROLE_A = {
  id: 'ra-1',
  principal: 'user:u-1',
  principalType: 'USER',
  principalName: 'Grant Principal A',
  role: 'ccs.operator',
  roleGrn: 'grn:glp/providers/authorization/roles/ccs.operator',
  scope: ['/workspaces/ws-1'],
  source: 'workspace',
};

const ROLE_B = {
  id: 'ra-2',
  principal: 'user:u-2',
  principalType: 'USER',
  principalName: 'Grant Principal B',
  role: 'ccs.observer',
  roleGrn: 'grn:glp/providers/authorization/roles/ccs.observer',
  scope: ['/workspaces/ws-1'],
  source: 'workspace',
};

const LOC_A = {
  id: 'loc-1',
  name: 'Campus-01',
  type: 'SITE',
  address: '1 Example Way',
  country: 'US',
  deviceCount: 12,
};

const LOC_B = {
  id: 'loc-2',
  name: 'Campus-02',
  type: 'SITE',
  address: '2 Example Way',
  country: 'US',
  deviceCount: 4,
};

/* Loop 196 — role grants + locations bulk. */
describe('GreenLake Loop 196 residuals', () => {
  it('shows role-grant bulk bar: Export selected, Copy principals, Clear', async () => {
    const createObjectURL = vi.fn(() => 'blob:gl-roles-selected');
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    renderScreen(
      inventory({
        roleAssignments: [ROLE_A, ROLE_B],
      }),
    );
    const table = await screen.findByRole('grid', { name: 'Role grants' });
    expect(within(table).getByText('Grant Principal A')).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Role grant selection actions' })).toBeNull();

    const first = table.querySelector('tbody tr') as HTMLElement;
    expect(first).toBeTruthy();
    first.focus();
    fireEvent.keyDown(first, { key: 'x' });

    const bar = await screen.findByRole('region', { name: 'Role grant selection actions' });
    expect(within(bar).getByText('1 SELECTED')).toBeTruthy();

    fireEvent.click(within(bar).getByRole('button', { name: 'Export selected' }));
    expect(await screen.findByText(/Exported 1 selected role grant/)).toBeTruthy();
    expect(createObjectURL).toHaveBeenCalled();

    fireEvent.click(within(bar).getByRole('button', { name: 'Copy principals' }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(String(writeText.mock.calls[0]![0])).toContain('Grant Principal A');
    expect(await screen.findByText(/Copied 1 principal/)).toBeTruthy();

    fireEvent.click(within(bar).getByRole('button', { name: 'Clear' }));
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: 'Role grant selection actions' })).toBeNull(),
    );
  });

  /* Loop 235 — role-grant bulk Copy names (role labels) beside Copy principals. */
  it('Loop 235 Copy names joins unique role labels from the selection', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    const ROLE_DUP = {
      ...ROLE_A,
      id: 'ra-1-dup',
      principal: 'user:u-9',
      principalName: 'Grant Principal Dup',
    };
    renderScreen(
      inventory({
        roleAssignments: [ROLE_A, ROLE_DUP, ROLE_B],
      }),
    );
    const table = await screen.findByRole('grid', { name: 'Role grants' });
    const rows = table.querySelectorAll('tbody tr');
    expect(rows.length).toBeGreaterThanOrEqual(3);
    for (let i = 0; i < 3; i++) {
      (rows[i] as HTMLElement).focus();
      fireEvent.keyDown(rows[i] as HTMLElement, { key: 'x' });
    }

    const bar = await screen.findByRole('region', { name: 'Role grant selection actions' });
    expect(within(bar).getByRole('button', { name: 'Copy names' })).toBeTruthy();
    fireEvent.click(within(bar).getByRole('button', { name: 'Copy names' }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    const text = String(writeText.mock.calls[0]![0]);
    expect(text.split('\n').sort()).toEqual(['ccs.observer', 'ccs.operator'].sort());
    expect(await screen.findByText(/Copied 2 names/)).toBeTruthy();
  });

  it('Copy selection link writes roleIds= and the deep link filters grants', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    renderScreen(
      inventory({
        roleAssignments: [ROLE_A, ROLE_B],
      }),
    );
    const table = await screen.findByRole('grid', { name: 'Role grants' });
    expect(within(table).getByText('Grant Principal A')).toBeTruthy();
    expect(within(table).getByText('Grant Principal B')).toBeTruthy();

    const first = table.querySelector('tbody tr') as HTMLElement;
    first.focus();
    fireEvent.keyDown(first, { key: 'x' });

    const bar = await screen.findByRole('region', { name: 'Role grant selection actions' });
    fireEvent.click(within(bar).getByRole('button', { name: 'Copy selection link' }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    const url = String(writeText.mock.calls[0]![0]);
    expect(url).toMatch(/roleIds=/);
    expect(url).toContain('ra-1');
    expect(url).toMatch(/section=roles/);
    expect(await screen.findByText(/Selection link copied/)).toBeTruthy();
  });

  it('deep-links ?roleIds= and shows a clearable role grant chip', async () => {
    renderScreen(
      inventory({
        roleAssignments: [ROLE_A, ROLE_B],
      }),
      '/greenlake?section=roles&roleIds=ra-1',
    );
    const table = await screen.findByRole('grid', { name: 'Role grants' });
    expect(within(table).getByText('Grant Principal A')).toBeTruthy();
    expect(within(table).queryByText('Grant Principal B')).toBeNull();
    const chip = screen.getByRole('group', { name: 'Role grant selection deep link' });
    expect(within(chip).getByText(/1 selected role grant/)).toBeTruthy();
    fireEvent.click(within(chip).getByRole('button'));
    await waitFor(() => expect(screen.getByTestId('loc').textContent).not.toMatch(/roleIds=/));
    const tableAfter = await screen.findByRole('grid', { name: 'Role grants' });
    expect(within(tableAfter).getByText('Grant Principal B')).toBeTruthy();
  });

  it('shows location bulk bar: Export selected, Copy names, Clear', async () => {
    const createObjectURL = vi.fn(() => 'blob:gl-locs-selected');
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    renderScreen(
      inventory({
        locations: [LOC_A, LOC_B],
      }),
    );
    const table = await screen.findByRole('grid', { name: 'Locations' });
    expect(within(table).getByText('Campus-01')).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Location selection actions' })).toBeNull();

    const first = table.querySelector('tbody tr') as HTMLElement;
    expect(first).toBeTruthy();
    first.focus();
    fireEvent.keyDown(first, { key: 'x' });

    const bar = await screen.findByRole('region', { name: 'Location selection actions' });
    expect(within(bar).getByText('1 SELECTED')).toBeTruthy();

    fireEvent.click(within(bar).getByRole('button', { name: 'Export selected' }));
    expect(await screen.findByText(/Exported 1 selected location/)).toBeTruthy();
    expect(createObjectURL).toHaveBeenCalled();

    fireEvent.click(within(bar).getByRole('button', { name: 'Copy names' }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(String(writeText.mock.calls[0]![0])).toContain('Campus-01');
    expect(await screen.findByText(/Copied 1 location name/)).toBeTruthy();

    fireEvent.click(within(bar).getByRole('button', { name: 'Clear' }));
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: 'Location selection actions' })).toBeNull(),
    );
  });

  it('Copy selection link writes locationIds= and the deep link filters locations', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    renderScreen(
      inventory({
        locations: [LOC_A, LOC_B],
      }),
    );
    const table = await screen.findByRole('grid', { name: 'Locations' });
    expect(within(table).getByText('Campus-01')).toBeTruthy();
    expect(within(table).getByText('Campus-02')).toBeTruthy();

    const first = table.querySelector('tbody tr') as HTMLElement;
    first.focus();
    fireEvent.keyDown(first, { key: 'x' });

    const bar = await screen.findByRole('region', { name: 'Location selection actions' });
    fireEvent.click(within(bar).getByRole('button', { name: 'Copy selection link' }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    const url = String(writeText.mock.calls[0]![0]);
    expect(url).toMatch(/locationIds=/);
    expect(url).toContain('loc-1');
    expect(url).toMatch(/section=locations/);
    expect(await screen.findByText(/Selection link copied/)).toBeTruthy();
  });

  it('deep-links ?locationIds= and shows a clearable location chip', async () => {
    renderScreen(
      inventory({
        locations: [LOC_A, LOC_B],
      }),
      '/greenlake?section=locations&locationIds=loc-1',
    );
    const table = await screen.findByRole('grid', { name: 'Locations' });
    expect(within(table).getByText('Campus-01')).toBeTruthy();
    expect(within(table).queryByText('Campus-02')).toBeNull();
    const chip = screen.getByRole('group', { name: 'Location selection deep link' });
    expect(within(chip).getByText(/1 selected location/)).toBeTruthy();
    fireEvent.click(within(chip).getByRole('button'));
    await waitFor(() => expect(screen.getByTestId('loc').textContent).not.toMatch(/locationIds=/));
    const tableAfter = await screen.findByRole('grid', { name: 'Locations' });
    expect(within(tableAfter).getByText('Campus-02')).toBeTruthy();
  });
});

/* Loop 195 — keyboard shortcuts help + filtered empty Clear filters CTA. */
describe('GreenLake Loop 195 residuals', () => {
  it('exposes keyboard shortcuts help beside workspace members', async () => {
    renderScreen(inventory());
    expect(await screen.findByText('ops@example.com')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Keyboard shortcuts' })).toBeTruthy();
  });

  it('offers Clear filters when members match nothing', async () => {
    renderScreen(inventory(), '/greenlake?q=zzz-no-match');
    /* q= empties members (and any non-empty roles/locations) — filtered EmptyState. */
    const empties = await screen.findAllByText('Nothing matches that filter');
    expect(empties.length).toBeGreaterThanOrEqual(1);
    const members = document.getElementById(sectionDomId('users'));
    expect(members).toBeTruthy();
    fireEvent.click(within(members as HTMLElement).getByRole('button', { name: 'Clear filters' }));
    await waitFor(() => expect(screen.getByTestId('loc').textContent).not.toMatch(/q=/));
    expect(await screen.findByText('ops@example.com')).toBeTruthy();
  });
});

/* Loop 216 — members/roles/locations selection-empty Clear selection filter CTAs. */
describe('GreenLake Loop 216 residuals', () => {
  it('offers Clear selection filter when member ids deep link matches nothing', async () => {
    renderScreen(
      inventory({
        users: [USER, { ...USER, id: 'u-2', username: 'pending@example.com', status: 'UNVERIFIED' }],
      }),
      `/greenlake?ids=${encodeURIComponent('member-missing-zzz')}`,
    );
    expect(await screen.findByText('No members match this selection')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Clear selection filter' }));
    await waitFor(() => expect(screen.getByTestId('loc').textContent).not.toMatch(/ids=/));
    expect(await screen.findByText('ops@example.com')).toBeTruthy();
    expect(screen.getByText('pending@example.com')).toBeTruthy();
    expect(screen.queryByText('No members match this selection')).toBeNull();
  });

  it('offers Clear selection filter when roleIds deep link matches nothing', async () => {
    renderScreen(
      inventory({
        roleAssignments: [ROLE_A, ROLE_B],
      }),
      `/greenlake?section=roles&roleIds=${encodeURIComponent('role-missing-zzz')}`,
    );
    expect(await screen.findByText('No role grants match this selection')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Clear selection filter' }));
    await waitFor(() => expect(screen.getByTestId('loc').textContent).not.toMatch(/roleIds=/));
    const table = await screen.findByRole('grid', { name: 'Role grants' });
    expect(within(table).getByText('Grant Principal A')).toBeTruthy();
    expect(within(table).getByText('Grant Principal B')).toBeTruthy();
    expect(screen.queryByText('No role grants match this selection')).toBeNull();
  });

  it('offers Clear selection filter when locationIds deep link matches nothing', async () => {
    renderScreen(
      inventory({
        locations: [LOC_A, LOC_B],
      }),
      `/greenlake?section=locations&locationIds=${encodeURIComponent('loc-missing-zzz')}`,
    );
    expect(await screen.findByText('No locations match this selection')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Clear selection filter' }));
    await waitFor(() => expect(screen.getByTestId('loc').textContent).not.toMatch(/locationIds=/));
    const table = await screen.findByRole('grid', { name: 'Locations' });
    expect(within(table).getByText('Campus-01')).toBeTruthy();
    expect(within(table).getByText('Campus-02')).toBeTruthy();
    expect(screen.queryByText('No locations match this selection')).toBeNull();
  });
});
