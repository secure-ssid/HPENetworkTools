import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import SiteDetail from './SiteDetail';
import { SettingsProvider } from '../app/SettingsContext';
import { ToastProvider } from '../nightdesk';
import { getSettings, getSiteDetail } from '../api/client';
import type { SiteRow } from '../../../shared';

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

vi.mock('../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/client')>();
  return {
    ...actual,
    getSettings: vi.fn(),
    getSiteDetail: vi.fn(),
  };
});

const mockGetSettings = vi.mocked(getSettings);
const mockGetSiteDetail = vi.mocked(getSiteDetail);

const LIVE_SITE: SiteRow = {
  id: 'multiple',
  name: 'SecureSSID',
  subnet: '—',
  planes: [{ name: 'CENTRAL', tone: 'accent' }],
  mix: '1 ap',
  devices: 1,
  clients: '—',
  health: null,
  healthPct: '—',
  tone: 'stale',
  alerts: '—',
  alertTone: 'neutral',
  sync: '2m ago',
};

beforeEach(() => {
  mockGetSettings.mockResolvedValue({
    density: 'compact',
    inventoryView: 'Unified table',
    showPlatformTags: true,
    workspaceName: 'SecureSSID',
    pollIntervalSec: 60,
  });
  mockGetSiteDetail.mockResolvedValue({
    site: LIVE_SITE,
    profile: null,
    dataSource: 'live',
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('SiteDetail live summary', () => {
  it('renders the available site row and marks unsupported profile fields unavailable', async () => {
    render(
      <MemoryRouter initialEntries={['/sites/SecureSSID']}>
        <ToastProvider>
          <SettingsProvider>
            <Routes>
              <Route path="/sites/:siteId" element={<SiteDetail />} />
            </Routes>
          </SettingsProvider>
        </ToastProvider>
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText('Live site facts')).toBeTruthy());
    expect(screen.getByText('SecureSSID')).toBeTruthy();
    expect(screen.getByText('device state not reported')).toBeTruthy();
    expect(screen.getByText('alert feed not reported')).toBeTruthy();
    expect(screen.getByText('NOT REPORTED')).toBeTruthy();
    expect(screen.getByText(/will not substitute the demo site profile/)).toBeTruthy();
    expect(screen.queryByText('No data — plane not linked')).toBeNull();
  });
});
