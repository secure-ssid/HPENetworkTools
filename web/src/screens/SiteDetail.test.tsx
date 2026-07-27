import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import SiteDetail from './SiteDetail';
import { SettingsProvider } from '../app/SettingsContext';
import { ToastProvider } from '../nightdesk';
import { getSettings, getSiteDetail } from '../api/client';
import type { SiteDetailData } from '../api/client';
import { SITE_PROFILES } from '../../../shared';
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

function renderDetail(path = '/sites/SecureSSID') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <ToastProvider>
        <SettingsProvider>
          <Routes>
            <Route path="/sites/:siteId" element={<SiteDetail />} />
          </Routes>
        </SettingsProvider>
      </ToastProvider>
    </MemoryRouter>,
  );
}

describe('SiteDetail live summary', () => {
  it('renders the available site row and marks unsupported profile fields unavailable', async () => {
    renderDetail();

    await waitFor(() => expect(screen.getByText('Live site facts')).toBeTruthy());
    expect(screen.getByText('SecureSSID')).toBeTruthy();
    expect(screen.getByText('device state not reported')).toBeTruthy();
    expect(screen.getByText('alert feed not reported')).toBeTruthy();
    expect(screen.getByText('NOT REPORTED')).toBeTruthy();
    expect(screen.getByText(/will not substitute the demo site profile/)).toBeTruthy();
    expect(screen.queryByText('No data — plane not linked')).toBeNull();
  });

  it('renders the per-site device table and Open here alerts the live envelope carries', async () => {
    mockGetSiteDetail.mockResolvedValue({
      site: LIVE_SITE,
      profile: null,
      dataSource: 'live',
      syncedAt: '2026-03-04T09:41:00.000Z',
      devices: [
        {
          name: 'ap-live-1',
          model: 'AP-635',
          plane: 'CENTRAL',
          planeTone: 'accent',
          role: '—',
          state: 'unverified',
          stateTone: 'warning',
          uptime: '—',
        },
      ],
      alerts: [
        { sev: 'P2', tone: 'warning', title: 'Radio down on ap-live-1', meta: 'central · 12m' },
      ],
    } as SiteDetailData);

    renderDetail();

    await waitFor(() => expect(screen.getByText('Devices at this site')).toBeTruthy());
    expect(screen.getByText('ap-live-1')).toBeTruthy();
    expect(screen.getByText('AP-635')).toBeTruthy();
    expect(screen.getByText('unverified')).toBeTruthy();
    expect(screen.getByText('Open here')).toBeTruthy();
    expect(screen.getByText('Radio down on ap-live-1')).toBeTruthy();
    expect(screen.getByText('central · 12m')).toBeTruthy();
    expect(screen.queryByText('no device claimed this site in the last pull')).toBeNull();
  });

  it('states the source and freshness, and says so when the live sections are empty', async () => {
    renderDetail();

    await waitFor(() => expect(screen.getByText('Devices at this site')).toBeTruthy());
    expect(screen.getByText(/^LIVE · SYNCED /)).toBeTruthy();
    expect(screen.getByText('no device claimed this site in the last pull')).toBeTruthy();
    expect(screen.getByText('nothing open here')).toBeTruthy();
  });

  it('labels an authored profile as demo rather than stamping it with a sync time', async () => {
    mockGetSiteDetail.mockResolvedValue({
      site: { ...LIVE_SITE, id: 'campus-01', name: 'Campus-01 — Meridian HQ' },
      profile: SITE_PROFILES['campus-01']!,
      dataSource: 'demo',
      syncedAt: new Date().toISOString(),
    });

    renderDetail('/sites/campus-01');

    await waitFor(() => expect(screen.getByText('Site facts')).toBeTruthy());
    expect(screen.getByText('DEMO FIXTURE')).toBeTruthy();
    expect(screen.queryByText(/^LIVE · SYNCED /)).toBeNull();
    expect(screen.getAllByText('sw-core-a').length).toBeGreaterThan(0);
  });

  it('treats a profile without an inventory row as not found', async () => {
    // The offline fallback answers pseudo-site ids ('core-services') with the
    // authored local-only profile and no site row — a fabricated page.
    mockGetSiteDetail.mockResolvedValue({
      site: null,
      profile: SITE_PROFILES['campus-01']!,
      dataSource: 'demo',
    });

    renderDetail('/sites/core-services');

    await waitFor(() => expect(screen.getByText('Site not found')).toBeTruthy());
    expect(screen.queryByText('Devices at this site')).toBeNull();
    expect(screen.queryByText('sw-core-a')).toBeNull();
  });
});
