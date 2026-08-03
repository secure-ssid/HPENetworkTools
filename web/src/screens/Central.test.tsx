/**
 * web/src/screens/Central.test.tsx — the Central plane screen.
 *
 * The api client is mocked at the module boundary (getCentral for the
 * payload, getSiteApplications for the DPI section's on-demand read; the
 * rest stays real so SettingsProvider can use DEFAULT_SETTINGS).
 * Covered:
 *  (a) the demo composition renders — plane status off the SYSTEMS row,
 *      fleet tiles, the per-site summary, the all-on-train firmware answer,
 *      the WLAN scope rows and the Central-cut alert queue with its
 *      /alerts?plane=CENTRAL hand-off;
 *  (b) the application-visibility picker drives the SAME on-demand DPI read
 *      the site page uses and renders the shared risk strip;
 *  (c) honest states: datasets the pull did not carry are named per section
 *      ("not reported"), never rendered as an empty estate;
 *  (d) an unlinked live plane banners instead of painting quiet sections;
 *  (e) navigation: a site row clicks through to its site page, the systems
 *      hand-off goes to /systems;
 *  (f) an API failure renders the error state, never the fixtures.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import Central from './Central';
import { SettingsProvider } from '../app/SettingsContext';
import { ToastProvider } from '../nightdesk';
import { getCentral, getSiteApplications } from '../api/client';
import type { CentralData } from '../api/client';
import { SITE_APPLICATIONS_DEMO, demoCentralSections } from '@hpe/shared';

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

if (typeof globalThis.ResizeObserver === 'undefined') {
  class ResizeObserverStub {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
}

vi.mock('../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/client')>();
  return { ...actual, getCentral: vi.fn(), getSiteApplications: vi.fn() };
});

const mockGetCentral = vi.mocked(getCentral);
const mockGetApps = vi.mocked(getSiteApplications);

const DEMO_APPS = SITE_APPLICATIONS_DEMO['campus-01']!;

function demoPayload(): CentralData {
  return { ...demoCentralSections(), dataSource: 'demo', syncedAt: '2026-07-26T11:59:00.000Z' };
}

/** Exposes the current path so navigation assertions stay honest. */
function PathProbe() {
  const location = useLocation();
  return <div data-testid="path">{`${location.pathname}${location.search}`}</div>;
}

function renderScreen() {
  return render(
    <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }} initialEntries={['/central']}>
      <SettingsProvider>
        <ToastProvider>
          <Central />
          <PathProbe />
        </ToastProvider>
      </SettingsProvider>
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('Central — the demo composition', () => {
  it('renders the plane header, fleet tiles and every section', async () => {
    mockGetCentral.mockResolvedValue(demoPayload());
    mockGetApps.mockResolvedValue({ kind: 'ok', applications: DEMO_APPS });
    renderScreen();

    expect(await screen.findByText('HPE Aruba Central')).toBeTruthy();
    // The plane status strip: the authored health word and the demo clock.
    expect(screen.getByText('healthy')).toBeTruthy();
    expect(screen.getByText(/DEMO FIXTURE · LAST SYNC/)).toBeTruthy();

    // Fleet tiles: the demo estate's two Central APs, four sessions, two
    // open alerts, one site.
    expect(screen.getByText('2 up · 0 down')).toBeTruthy();
    expect(screen.getByText('active sessions reported')).toBeTruthy();
    expect(screen.getByText('sourced from this plane')).toBeTruthy();
    expect(screen.getByText('managed by this plane')).toBeTruthy();
    // The fleet line under the tiles: types then states, verbatim.
    expect(screen.getByText('2 ap — 2 up')).toBeTruthy();

    // Sites summary: the one Central-badged site, all devices up (the name
    // also rides the alert rows below — the table cell is the one in a row).
    expect(screen.getAllByText('Campus-01 HQ').some((el) => el.closest('tr') !== null)).toBe(true);
    expect(screen.getByText('100%')).toBeTruthy();

    // Firmware: both APs on their approved train — a real answer, not an
    // absent section.
    expect(
      screen.getByText('Every one of the 2 devices Central manages is on its approved firmware train.'),
    ).toBeTruthy();

    // WLANs: the scope text rides verbatim, edits handed off to Configure.
    expect(screen.getByText('MRDN-Guest')).toBeTruthy();
    expect(screen.getByText(/guest-lobby, northgate-public · 96 APs/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Edit WLAN MRDN-Guest in Configure' }).getAttribute('href')).toBe(
      '/configure?edit=ssid&plane=CENTRAL&name=MRDN-Guest&vlan=vlan+812&targets=guest-lobby%2C+northgate-public+%C2%B7+96+APs',
    );

    // Recent alerts, cut to Central, with the filtered-queue hand-off.
    expect(screen.getAllByText('DHCP pool 92% used on vlan 812')).toHaveLength(2);
    const handoff = screen.getByText('full queue, filtered to Central');
    expect(handoff.closest('a')?.getAttribute('href')).toBe('/alerts?plane=CENTRAL');

    // The management hand-off stays in Connected systems.
    expect(
      screen.getByText('Scope, credentials and webhooks in Connected systems').closest('a')?.getAttribute('href'),
    ).toBe('/systems');
  });

  it('drives the on-demand DPI read from the site picker and renders the shared table', async () => {
    mockGetCentral.mockResolvedValue(demoPayload());
    mockGetApps.mockResolvedValue({ kind: 'ok', applications: DEMO_APPS });
    renderScreen();

    // The default pick is the payload's first Central site; the read fires
    // once for it.
    await waitFor(() => expect(mockGetApps).toHaveBeenCalledWith('campus-01'));
    expect(screen.getByLabelText('Site for the application read')).toBeTruthy();
    expect(await screen.findByText('12 APPS · CENTRAL DPI')).toBeTruthy();
    // The shared risk strip, worst-first with zeros included.
    expect(screen.getByText('2 suspicious')).toBeTruthy();
    expect(screen.getByText('0 unknown')).toBeTruthy();
  });

  it('words a DPI read failure as a failure, never an empty table', async () => {
    mockGetCentral.mockResolvedValue(demoPayload());
    mockGetApps.mockResolvedValue({ kind: 'failed', message: 'HTTP 502' });
    renderScreen();
    expect(await screen.findByText('The application read failed — HTTP 502')).toBeTruthy();
  });
});

describe('Central — the honest states', () => {
  it('names every dataset the pull did not carry, per section', async () => {
    const payload: CentralData = {
      ...demoPayload(),
      dataSource: 'live',
      syncedAt: null,
      stats: [
        { label: 'Devices', value: '—', delta: 'no device inventory reported', tone: 'neutral' },
        { label: 'Clients', value: '—', delta: 'no client roster reported', tone: 'neutral' },
        { label: 'Open alerts', value: '—', delta: 'no alert feed reported', tone: 'neutral' },
        { label: 'Sites', value: '0', delta: 'sites of the reported rows only', tone: 'neutral' },
      ],
      fleet: { total: 0, byType: {}, byState: {} },
      sites: [],
      firmware: [],
      wlans: [],
      alerts: [],
      notReported: ['devices', 'sites', 'clients', 'alerts', 'wlans'],
    };
    mockGetCentral.mockResolvedValue(payload);
    renderScreen();

    expect(await screen.findByText('HPE Aruba Central')).toBeTruthy();
    expect(screen.getByText('no device inventory reported')).toBeTruthy();
    expect(screen.getByText(/No site counts can be asserted/)).toBeTruthy();
    expect(screen.getByText(/no site can be named for the DPI read/)).toBeTruthy();
    expect(screen.getByText(/no firmware verdict can be asserted/)).toBeTruthy();
    expect(screen.getByText(/The WLAN inventory was not read this cycle/)).toBeTruthy();
    expect(screen.getByText(/did not report its alert feed/)).toBeTruthy();
    // No site list, no picker — the DPI section says why instead of guessing.
    expect(screen.queryByLabelText('Site for the application read')).toBeNull();
    expect(mockGetApps).not.toHaveBeenCalled();
  });

  it('still offers the picker when the site list is unreported but device rows name sites', async () => {
    // 'sites' notReported means the plane's site LIST was not read — but the
    // device roster still evidences sites, and the DPI route resolves them.
    const payload: CentralData = {
      ...demoPayload(),
      dataSource: 'live',
      sites: [
        {
          siteId: 'campus-01',
          siteName: 'Campus-01 HQ',
          devices: 2,
          clients: 4,
          healthPct: 100,
          openAlerts: 2,
        },
      ],
      notReported: ['sites'],
    };
    mockGetCentral.mockResolvedValue(payload);
    mockGetApps.mockResolvedValue({ kind: 'ok', applications: DEMO_APPS });
    renderScreen();

    await waitFor(() => expect(mockGetApps).toHaveBeenCalledWith('campus-01'));
    expect(screen.getByLabelText('Site for the application read')).toBeTruthy();
    expect(await screen.findByText('12 APPS · CENTRAL DPI')).toBeTruthy();
  });

  it('banners an unlinked live plane rather than painting quiet sections', async () => {
    const payload: CentralData = {
      ...demoPayload(),
      dataSource: 'live',
      syncedAt: null,
      plane: { linked: false, health: 'unlinked', tone: 'neutral', lastSync: null, note: null },
      stats: [
        { label: 'Devices', value: '—', delta: 'no device inventory reported', tone: 'neutral' },
        { label: 'Clients', value: '—', delta: 'no client roster reported', tone: 'neutral' },
        { label: 'Open alerts', value: '—', delta: 'no alert feed reported', tone: 'neutral' },
        { label: 'Sites', value: '0', delta: 'sites of the reported rows only', tone: 'neutral' },
      ],
      fleet: { total: 0, byType: {}, byState: {} },
      sites: [],
      firmware: [],
      wlans: [],
      alerts: [],
      notReported: ['devices', 'sites', 'clients', 'alerts', 'wlans'],
    };
    mockGetCentral.mockResolvedValue(payload);
    renderScreen();

    expect(await screen.findByText(/not linked — no credentials stored/)).toBeTruthy();
    expect(screen.getByText('LIVE')).toBeTruthy();
    fireEvent.click(screen.getByText('Connected systems'));
    expect(screen.getByTestId('path').textContent).toBe('/systems');
  });

  it('renders an API failure as the error state, never the fixtures', async () => {
    mockGetCentral.mockResolvedValue({
      ...demoPayload(),
      dataSource: 'live',
      syncedAt: null,
      apiError: 'HTTP 500',
    });
    renderScreen();
    expect(await screen.findByText('The portal API could not load this screen')).toBeTruthy();
    expect(screen.getByText('HTTP 500')).toBeTruthy();
    expect(screen.queryByText('healthy')).toBeNull();
  });
});

describe('Central — navigation', () => {
  it('clicks a site row through to its site page', async () => {
    mockGetCentral.mockResolvedValue(demoPayload());
    mockGetApps.mockResolvedValue({ kind: 'ok', applications: DEMO_APPS });
    renderScreen();
    const siteCell = (await screen.findAllByText('Campus-01 HQ')).find((el) => el.closest('tr'));
    expect(siteCell).toBeTruthy();
    fireEvent.click(siteCell!.closest('tr')!);
    expect(screen.getByTestId('path').textContent).toBe('/sites/campus-01');
  });
});
