/**
 * web/src/app/AppShell.test.tsx — component tests for the app shell
 * (AppShellLayout): breadcrumb behaviour on site drill-down routes.
 *
 * Regression guard: router params arrive already decoded, so a site id whose
 * decoded form contains a literal '%' (URL '/sites/foo%25') must NOT be fed
 * through decodeURIComponent again — that used to throw URIError and blank
 * the app. Unknown ids render verbatim; known ids render their display name.
 *
 * The api client module is mocked at the boundary — no real fetch ever runs.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AppShellLayout } from './AppShell';
import { noteBackendReachable, resetBackendReachability } from '../api/core';
import { SettingsProvider } from './SettingsContext';

// ---------------------------------------------------------------------------
// Module-boundary mock: no network. Only the members the shell subtree
// (AppShellLayout, SearchPanel, ChatPanel, SettingsContext) actually imports.
// ---------------------------------------------------------------------------

vi.mock('../api/client', () => ({
  DEFAULT_SETTINGS: {
    density: 'comfortable',
    inventoryView: 'Unified table',
    showPlatformTags: true,
    workspaceName: 'Meridian Health',
    pollIntervalSec: 60,
  },
  SETTINGS_STORAGE_KEY: 'nt-settings',
  saveSettings: vi.fn().mockResolvedValue(undefined),
  getSettings: vi.fn().mockResolvedValue({
    density: 'comfortable',
    inventoryView: 'Unified table',
    showPlatformTags: true,
    workspaceName: 'Meridian Health',
    pollIntervalSec: 60,
  }),
  getSystemsState: vi.fn().mockResolvedValue(null), // backend absent → fixture label
  getSearchIndex: vi.fn().mockResolvedValue({ entries: [], dataSource: 'demo' }),
  getInventoryTree: vi.fn().mockResolvedValue({
    parentId: null,
    nodes: [],
    total: 0,
    nextCursor: null,
    query: '',
  }),
  getChatStatus: vi.fn().mockResolvedValue(null),
  postChat: vi.fn(),
}));

// The notification bell's own module boundary — no real fetch here either.
// Defaults are set at creation: the bell mounts (and polls) in EVERY shell
// render, including tests that never touch it.
const mockCenter = {
  getNotificationCenter: vi.fn().mockResolvedValue({ entries: [], unread: 0 }),
  markNotificationCenterRead: vi.fn().mockResolvedValue({ unread: 0 }),
};
vi.mock('../api/notificationCenter', () => ({
  getNotificationCenter: (...args: unknown[]) => mockCenter.getNotificationCenter(...args),
  markNotificationCenterRead: (...args: unknown[]) => mockCenter.markNotificationCenterRead(...args),
}));

afterEach(() => {
  cleanup();
  resetBackendReachability();
  mockCenter.getNotificationCenter.mockReset().mockResolvedValue({ entries: [], unread: 0 });
  mockCenter.markNotificationCenterRead.mockReset().mockResolvedValue({ unread: 0 });
});

/** Renders the shell at a site drill-down route, with a stub content outlet. */
function renderShellAtSite(path: string) {
  return render(
    <SettingsProvider>
      <MemoryRouter initialEntries={[path]} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <Routes>
          <Route element={<AppShellLayout />}>
            <Route path="/sites/:siteId" element={<div>site content stub</div>} />
          </Route>
        </Routes>
      </MemoryRouter>
    </SettingsProvider>,
  );
}

describe('AppShellLayout site-route breadcrumbs', () => {
  it('opens the primary navigation in a focus-managed drawer', () => {
    renderShellAtSite('/sites/campus-01');

    fireEvent.click(screen.getByRole('button', { name: 'Open navigation' }));

    expect(screen.getByRole('dialog', { name: 'Navigation' })).toBeTruthy();
    expect(screen.getByRole('navigation', { name: 'Primary navigation' })).toBeTruthy();
  });

  it('renders without throwing when the decoded site param contains a literal %', async () => {
    // react-router decodes '/sites/foo%25' to the param 'foo%'; the shell must
    // show that raw text, not re-decode it (decodeURIComponent('foo%') throws).
    renderShellAtSite('/sites/foo%25');

    // The shell itself rendered (wordmark + breadcrumb nav + routed outlet).
    expect(screen.getByText('NightDesk')).toBeTruthy();
    expect(screen.getByText('site content stub')).toBeTruthy();

    const crumbs = screen.getByRole('navigation', { name: 'Breadcrumbs' });
    expect(within(crumbs).getByText('Meridian Health')).toBeTruthy();
    expect(within(crumbs).getByText('Sites')).toBeTruthy();
    // Raw decoded text verbatim — no URIError, no mangled output.
    expect(within(crumbs).getByText('foo%')).toBeTruthy();
  });

  it("renders the display name for a known site id", async () => {
    renderShellAtSite('/sites/campus-01');

    const crumbs = screen.getByRole('navigation', { name: 'Breadcrumbs' });
    expect(within(crumbs).getByText('Meridian Health')).toBeTruthy();
    expect(within(crumbs).getByText('Sites')).toBeTruthy();
    // SITE_DISPLAY_NAMES['campus-01'] — the canonical display name, not the id.
    expect(within(crumbs).getByText('Campus-01 — Meridian HQ')).toBeTruthy();
    expect(within(crumbs).queryByText('campus-01')).toBeNull();
  });
});

/**
 * The screens substitute authored demo fixtures whenever no backend answers,
 * and that payload is indistinguishable from a portal deliberately serving
 * demo data. So a tab left open on live data, whose backend then dies, quietly
 * re-renders a complete and plausible estate that does not exist. The shell
 * carries the correction because the substitution is global — the operator
 * could be on any screen when it happens.
 */
describe('AppShellLayout backend-unreachable banner', () => {
  it('says nothing while the backend is answering', () => {
    renderShellAtSite('/sites/campus-01');
    expect(screen.queryByText('The portal backend is not answering')).toBeNull();
  });

  it('states that the estate on screen is fixtures once the backend stops answering', () => {
    renderShellAtSite('/sites/campus-01');

    act(() => {
      noteBackendReachable(false);
    });

    expect(screen.getByText('The portal backend is not answering')).toBeTruthy();
    // The point is not that something failed — it is that what remains on
    // screen is not the network, which is the part an operator would
    // otherwise read as an all-clear.
    expect(screen.getByText(/Nothing below is your estate/)).toBeTruthy();
    // The routed content is still rendered underneath; the banner corrects it
    // rather than replacing it.
    expect(screen.getByText('site content stub')).toBeTruthy();
  });

  it('withdraws the warning when the backend answers again', () => {
    renderShellAtSite('/sites/campus-01');

    act(() => {
      noteBackendReachable(false);
    });
    expect(screen.getByText('The portal backend is not answering')).toBeTruthy();

    act(() => {
      noteBackendReachable(true);
    });
    expect(screen.queryByText('The portal backend is not answering')).toBeNull();
  });
});


/**
 * The notification bell: unread badge, the dropdown's entries, mark-read on
 * click-through (with navigation to the entry's url), mark-all, and the
 * honest unavailable state when the backend does not answer. The bell's API
 * module is mocked above; the unread number rendered is always the server's
 * own answer, never a client-side guess.
 */
describe('AppShellLayout notification bell', () => {
  function renderShellWithDevices(path = '/sites/campus-01') {
    return render(
      <SettingsProvider>
        <MemoryRouter initialEntries={[path]} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
          <Routes>
            <Route element={<AppShellLayout />}>
              <Route path="/sites/:siteId" element={<div>site content stub</div>} />
              <Route path="/devices/:name" element={<div>device content stub</div>} />
            </Route>
          </Routes>
        </MemoryRouter>
      </SettingsProvider>,
    );
  }

  const entries = [
    {
      id: 'nce-1',
      title: 'ap-1f-04 offline',
      body: 'ap-1f-04 (ap) at Campus-01 HQ has been offline for 6m',
      severity: 'danger' as const,
      deviceSerial: 'SER-1',
      url: '/devices/ap-1f-04',
      createdAt: '2026-08-01T00:05:00.000Z',
      read: false,
    },
    {
      id: 'nce-2',
      title: 'demo-ap-watch1 back online',
      body: 'demo-ap-watch1 is back online after 3m offline.',
      severity: 'success' as const,
      deviceSerial: 'DEMO-AP-WATCH1',
      url: '/devices/demo-ap-watch1',
      createdAt: '2026-08-01T00:02:00.000Z',
      read: true,
      demo: true,
    },
  ];

  it('shows the unread count on the bell and lists entries with severity and demo labels', async () => {
    mockCenter.getNotificationCenter.mockResolvedValue({ entries, unread: 1 });
    renderShellWithDevices();

    const bell = await screen.findByRole('button', { name: 'Notifications, 1 unread' });
    fireEvent.click(bell);

    const dialog = await screen.findByRole('dialog', { name: 'Notifications' });
    expect(within(dialog).getByText('ap-1f-04 offline')).toBeTruthy();
    expect(within(dialog).getByText(/has been offline for 6m/)).toBeTruthy();
    expect(within(dialog).getByText('demo-ap-watch1 back online')).toBeTruthy();
    // The demo showcase is labelled, never mistaken for the estate.
    expect(within(dialog).getByText('demo')).toBeTruthy();
  });

  it('is badge-less with nothing unread — no fabricated count', async () => {
    mockCenter.getNotificationCenter.mockResolvedValue({ entries: [], unread: 0 });
    renderShellWithDevices();

    const bell = await screen.findByRole('button', { name: 'Notifications' });
    fireEvent.click(bell);
    expect(await screen.findByText(/No notifications yet/)).toBeTruthy();
  });

  it('marks an entry read on click-through and navigates to its url', async () => {
    mockCenter.getNotificationCenter.mockResolvedValue({ entries, unread: 1 });
    mockCenter.markNotificationCenterRead.mockResolvedValue({ unread: 0 });
    renderShellWithDevices();

    fireEvent.click(await screen.findByRole('button', { name: 'Notifications, 1 unread' }));
    fireEvent.click(await screen.findByText('ap-1f-04 offline'));

    expect(mockCenter.markNotificationCenterRead).toHaveBeenCalledWith({ ids: ['nce-1'] });
    expect(await screen.findByText('device content stub')).toBeTruthy();
    // The badge takes the server's own new count.
    expect(await screen.findByRole('button', { name: 'Notifications' })).toBeTruthy();
  });

  it('marks everything read from the dropdown header', async () => {
    mockCenter.getNotificationCenter.mockResolvedValue({ entries, unread: 2 });
    mockCenter.markNotificationCenterRead.mockResolvedValue({ unread: 0 });
    renderShellWithDevices();

    fireEvent.click(await screen.findByRole('button', { name: 'Notifications, 2 unread' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Mark all read' }));

    expect(mockCenter.markNotificationCenterRead).toHaveBeenCalledWith({ all: true });
    expect(await screen.findByRole('button', { name: 'Notifications' })).toBeTruthy();
  });

  it('says why the center is empty when the backend does not answer', async () => {
    mockCenter.getNotificationCenter.mockResolvedValue({ error: 'backend unreachable', offline: true });
    renderShellWithDevices();

    const bell = await screen.findByRole('button', { name: 'Notifications' });
    fireEvent.click(bell);

    expect(await screen.findByText(/Notifications are unavailable/)).toBeTruthy();
  });
});
