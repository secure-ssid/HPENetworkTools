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

afterEach(() => {
  cleanup();
  resetBackendReachability();
});

/** Renders the shell at a site drill-down route, with a stub content outlet. */
function renderShellAtSite(path: string) {
  return render(
    <SettingsProvider>
      <MemoryRouter initialEntries={[path]}>
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
    expect(screen.getByText('Network Tools')).toBeTruthy();
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
