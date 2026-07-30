/**
 * web/src/screens/GreenLake.test.tsx — GreenLake workspace screen.
 *
 * The screen's job is to be honest about what it could not read and about who
 * is allowed to change things, so that is what is pinned here: a section whose
 * read FAILED must render as a named failure rather than as an empty table
 * (otherwise "denied" and "this workspace has none" look identical), and a
 * read-only credential must not be shown write controls it cannot use.
 */

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getGreenLakeInventory } from '../api/client';
import { SettingsProvider } from '../app/SettingsContext';
import { ToastProvider } from '../nightdesk';
import GreenLake from './GreenLake';

vi.mock('../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/client')>();
  return { ...actual, getGreenLakeInventory: vi.fn(), runGreenLakeAction: vi.fn() };
});

const mockInventory = vi.mocked(getGreenLakeInventory);

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
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
    <MemoryRouter>
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
