import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useParams } from 'react-router-dom';
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

/** Stands in for DeviceDetail so a terminal hand-off is observable by target. */
function DeviceStub() {
  const { name } = useParams();
  return <div>device page {name}</div>;
}

function renderDetail(path = '/sites/SecureSSID') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <ToastProvider>
        <SettingsProvider>
          <Routes>
            <Route path="/sites/:siteId" element={<SiteDetail />} />
            <Route path="/devices/:name" element={<DeviceStub />} />
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

  it('keeps the fifth Config drift tile and says why it is unavailable', async () => {
    renderDetail();

    await waitFor(() => expect(screen.getByText('Live site facts')).toBeTruthy());
    // README §7 specifies five tiles; live mode must not silently drop one.
    expect(screen.getByText('Config drift')).toBeTruthy();
    expect(screen.getByText('no running-config baseline source')).toBeTruthy();
  });

  it('derives the header hand-off from the claiming plane and omits it when none claims', async () => {
    renderDetail();

    await waitFor(() => expect(screen.getByText('Live site facts')).toBeTruthy());
    expect(screen.getByRole('button', { name: 'Open in CENTRAL' })).toBeTruthy();
    // No switch-like device row was sent, so no terminal target is invented.
    expect(screen.queryByRole('button', { name: 'Local terminal' })).toBeNull();

    cleanup();
    mockGetSiteDetail.mockResolvedValue({
      site: { ...LIVE_SITE, planes: [] },
      profile: null,
      dataSource: 'live',
    });
    renderDetail();

    await waitFor(() => expect(screen.getByText('Live site facts')).toBeTruthy());
    expect(screen.queryByRole('button', { name: /^Open in / })).toBeNull();
  });

  it('offers Local terminal only against a switch-like row the plane actually reported', async () => {
    mockGetSiteDetail.mockResolvedValue({
      site: LIVE_SITE,
      profile: null,
      dataSource: 'live',
      devices: [
        {
          name: 'ap-live-1',
          model: 'AP-635',
          plane: 'CENTRAL',
          planeTone: 'accent',
          role: 'access point',
          state: 'up',
          stateTone: 'success',
          uptime: '—',
        },
        {
          name: 'sw-edge-3',
          model: 'CX 6300',
          plane: 'LOCAL',
          planeTone: 'neutral',
          role: 'access switch',
          state: 'up',
          stateTone: 'success',
          uptime: '—',
        },
      ],
    } as SiteDetailData);

    renderDetail();

    await waitFor(() => expect(screen.getByText('Devices at this site')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Local terminal' }));
    await waitFor(() => expect(screen.getByText('device page sw-edge-3')).toBeTruthy());
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
