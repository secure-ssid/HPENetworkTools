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
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import Central from './Central';
import { SettingsProvider } from '../app/SettingsContext';
import { ToastProvider } from '../nightdesk';
import { getCentral, getSiteApplications } from '../api/client';
import type { CentralData } from '../api/client';
import { SITE_APPLICATIONS_DEMO, demoCentralSections } from '@hpe/shared';
import * as csv from '../lib/csv';
import { downloadApiCsv } from '../lib/downloadApiCsv';

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

// jsdom lacks scrollIntoView; section focus effect calls it when ?section= is set.
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

vi.mock('../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/client')>();
  return { ...actual, getCentral: vi.fn(), getSiteApplications: vi.fn() };
});

vi.mock('../lib/downloadApiCsv', () => ({
  downloadApiCsv: vi.fn(async () => ({ ok: true as const })),
}));

const mockGetCentral = vi.mocked(getCentral);
const mockGetApps = vi.mocked(getSiteApplications);
const mockDownloadApiCsv = vi.mocked(downloadApiCsv);

const DEMO_APPS = SITE_APPLICATIONS_DEMO['campus-01']!;

function demoPayload(): CentralData {
  return { ...demoCentralSections(), dataSource: 'demo', syncedAt: '2026-07-26T11:59:00.000Z' };
}

/** Exposes the current path so navigation assertions stay honest. */
function PathProbe() {
  const location = useLocation();
  return <div data-testid="path">{`${location.pathname}${location.search}`}</div>;
}

function renderScreen(entry = '/central') {
  return render(
    <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }} initialEntries={[entry]}>
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

describe('Central — subsection export/share (Loop 49)', () => {
  function sectionHeader(label: string): HTMLElement {
    const match = screen
      .getAllByText(label)
      .map((el) => el.closest('.nt-row-between-12') as HTMLElement | null)
      .find((el) => el !== null);
    if (!match) throw new Error(`no section header row for ${label}`);
    return match;
  }

  it('Download server CSV passes part=site when section=sites (Loop 86)', async () => {
    mockGetCentral.mockResolvedValue({
      ...demoPayload(),
      dataSource: 'live',
      plane: { ...demoPayload().plane, linked: true },
    });
    mockGetApps.mockResolvedValue({ kind: 'ok', applications: DEMO_APPS });
    mockDownloadApiCsv.mockClear();
    renderScreen('/central?section=sites');
    await screen.findByText('HPE Aruba Central');
    fireEvent.click(screen.getByRole('button', { name: 'Download server CSV' }));
    await waitFor(() =>
      expect(mockDownloadApiCsv).toHaveBeenCalledWith(
        '/api/central/export?part=site',
        'central-sites.csv',
      ),
    );
  });

  it('Download server CSV passes dedicated parts for firmware/wlans/alerts (Loop 102)', async () => {
    mockGetCentral.mockResolvedValue({
      ...demoPayload(),
      dataSource: 'live',
      plane: { ...demoPayload().plane, linked: true },
    });
    mockGetApps.mockResolvedValue({ kind: 'ok', applications: DEMO_APPS });

    mockDownloadApiCsv.mockClear();
    const { unmount: u1 } = renderScreen('/central?section=firmware');
    await screen.findByText('HPE Aruba Central');
    fireEvent.click(screen.getByRole('button', { name: 'Download server CSV' }));
    await waitFor(() =>
      expect(mockDownloadApiCsv).toHaveBeenCalledWith(
        '/api/central/export?part=firmware',
        'central-firmware.csv',
      ),
    );
    u1();

    mockDownloadApiCsv.mockClear();
    const { unmount: u2 } = renderScreen('/central?section=wlans');
    await screen.findByText('HPE Aruba Central');
    fireEvent.click(screen.getByRole('button', { name: 'Download server CSV' }));
    await waitFor(() =>
      expect(mockDownloadApiCsv).toHaveBeenCalledWith(
        '/api/central/export?part=wlans',
        'central-wlans.csv',
      ),
    );
    u2();

    mockDownloadApiCsv.mockClear();
    renderScreen('/central?section=alerts');
    await screen.findByText('HPE Aruba Central');
    fireEvent.click(screen.getByRole('button', { name: 'Download server CSV' }));
    await waitFor(() =>
      expect(mockDownloadApiCsv).toHaveBeenCalledWith(
        '/api/central/export?part=alerts',
        'central-alerts.csv',
      ),
    );
  });

  it('Sites section Copy section link + Export CSV', async () => {
    mockGetCentral.mockResolvedValue(demoPayload());
    mockGetApps.mockResolvedValue({ kind: 'ok', applications: DEMO_APPS });
    const clipboard = { writeText: vi.fn().mockResolvedValue(undefined) };
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: clipboard });
    const spy = vi.spyOn(csv, 'exportTableCsv').mockReturnValue(1);
    renderScreen();
    await screen.findByText('HPE Aruba Central');
    const header = sectionHeader('Sites');
    fireEvent.click(within(header).getByRole('button', { name: 'Copy section link' }));
    await waitFor(() => expect(clipboard.writeText).toHaveBeenCalled());
    expect(String(clipboard.writeText.mock.calls[0]![0])).toMatch(/\/central\?section=sites/);
    fireEvent.click(within(header).getByRole('button', { name: 'Export CSV' }));
    expect(spy.mock.calls.some((c) => c[0] === 'central-sites.csv')).toBe(true);
    spy.mockRestore();
  });

  it('WLANs and Alerts sections offer section share + CSV when rows exist', async () => {
    mockGetCentral.mockResolvedValue(demoPayload());
    mockGetApps.mockResolvedValue({ kind: 'ok', applications: DEMO_APPS });
    const clipboard = { writeText: vi.fn().mockResolvedValue(undefined) };
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: clipboard });
    const spy = vi.spyOn(csv, 'exportTableCsv').mockReturnValue(2);
    renderScreen();
    await screen.findByText('MRDN-Guest');

    const wlanHeader = sectionHeader('WLANs');
    fireEvent.click(within(wlanHeader).getByRole('button', { name: 'Copy section link' }));
    await waitFor(() =>
      expect(String(clipboard.writeText.mock.calls.at(-1)?.[0])).toMatch(/\/central\?section=wlans/),
    );
    fireEvent.click(within(wlanHeader).getByRole('button', { name: 'Export CSV' }));
    expect(spy.mock.calls.some((c) => c[0] === 'central-wlans.csv')).toBe(true);

    const alertsHeader = sectionHeader('Recent alerts');
    fireEvent.click(within(alertsHeader).getByRole('button', { name: 'Copy section link' }));
    await waitFor(() =>
      expect(String(clipboard.writeText.mock.calls.at(-1)?.[0])).toMatch(/\/central\?section=alerts/),
    );
    fireEvent.click(within(alertsHeader).getByRole('button', { name: 'Export CSV' }));
    expect(spy.mock.calls.some((c) => c[0] === 'central-alerts.csv')).toBe(true);
    spy.mockRestore();
  });

  it('Firmware section always offers Copy section link; Export CSV only when behind rows exist', async () => {
    mockGetCentral.mockResolvedValue(demoPayload());
    mockGetApps.mockResolvedValue({ kind: 'ok', applications: DEMO_APPS });
    const clipboard = { writeText: vi.fn().mockResolvedValue(undefined) };
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: clipboard });
    renderScreen();
    await screen.findByText(/approved firmware train/);
    const header = sectionHeader('Firmware');
    fireEvent.click(within(header).getByRole('button', { name: 'Copy section link' }));
    await waitFor(() =>
      expect(String(clipboard.writeText.mock.calls.at(-1)?.[0])).toMatch(/\/central\?section=firmware/),
    );
    // Demo estate is all on-train — no per-section Export CSV for empty behind list.
    expect(within(header).queryByRole('button', { name: 'Export CSV' })).toBeNull();
  });

  it('Application visibility offers Copy section link (section=applications)', async () => {
    mockGetCentral.mockResolvedValue(demoPayload());
    mockGetApps.mockResolvedValue({ kind: 'ok', applications: DEMO_APPS });
    const clipboard = { writeText: vi.fn().mockResolvedValue(undefined) };
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: clipboard });
    renderScreen();
    await screen.findByText('Application visibility');
    const header = sectionHeader('Application visibility');
    expect(document.getElementById('central-section-applications')).toBeTruthy();
    fireEvent.click(within(header).getByRole('button', { name: 'Copy section link' }));
    await waitFor(() =>
      expect(String(clipboard.writeText.mock.calls.at(-1)?.[0])).toMatch(
        /\/central\?section=applications/,
      ),
    );
  });

  it('Application visibility offers Export CSV of the loaded DPI table (Loop 71)', async () => {
    mockGetCentral.mockResolvedValue(demoPayload());
    mockGetApps.mockResolvedValue({ kind: 'ok', applications: DEMO_APPS });
    const createObjectURL = vi.fn(() => 'blob:central-apps');
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    renderScreen();
    await screen.findByText('Application visibility');
    const header = sectionHeader('Application visibility');
    await waitFor(() => expect(within(header).getByRole('button', { name: 'Export CSV' })).toBeTruthy());
    fireEvent.click(within(header).getByRole('button', { name: 'Export CSV' }));
    await waitFor(() => expect(createObjectURL).toHaveBeenCalled());
    expect(click).toHaveBeenCalled();
    await waitFor(() => expect(screen.getByText(/exported \d+ apps?/i)).toBeTruthy());
    click.mockRestore();
  });
});

/* Loop 166 — LIVE badge honesty (pure live + central blend). */
describe('Central Loop 166 residuals', () => {
  it('stamps LIVE on pure live Central', async () => {
    mockGetCentral.mockResolvedValue({
      ...demoPayload(),
      dataSource: 'live',
      plane: { ...demoPayload().plane, linked: true },
    });
    mockGetApps.mockResolvedValue({ kind: 'ok', applications: DEMO_APPS });
    renderScreen();
    expect(await screen.findByText('HPE Aruba Central')).toBeTruthy();
    expect(screen.getByText('LIVE')).toBeTruthy();
  });

  it('stamps LIVE when Central arrives via blend', async () => {
    mockGetCentral.mockResolvedValue({
      ...demoPayload(),
      dataSource: 'demo',
      blended: ['central'],
      plane: { ...demoPayload().plane, linked: true },
    });
    mockGetApps.mockResolvedValue({ kind: 'ok', applications: DEMO_APPS });
    renderScreen();
    expect(await screen.findByText('HPE Aruba Central')).toBeTruthy();
    expect(screen.getByText('LIVE')).toBeTruthy();
  });

  it('hides LIVE on demo fixtures without blend', async () => {
    mockGetCentral.mockResolvedValue(demoPayload());
    mockGetApps.mockResolvedValue({ kind: 'ok', applications: DEMO_APPS });
    renderScreen();
    expect(await screen.findByText('HPE Aruba Central')).toBeTruthy();
    expect(screen.getByText(/DEMO FIXTURE · LAST SYNC/)).toBeTruthy();
    expect(screen.queryByText('LIVE')).toBeNull();
  });
});

/* Loop 174 — sites multi-select Export selected + Copy names bulk bar. */
describe('Central sites bulk selection (Loop 174)', () => {
  it('shows bulk bar for selection: Export selected, Copy names, Clear', async () => {
    const createObjectURL = vi.fn(() => 'blob:central-sites-selected');
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    const payload = demoPayload();
    expect(payload.sites.length).toBeGreaterThan(0);
    const firstName = payload.sites[0]!.siteName;
    mockGetCentral.mockResolvedValue(payload);
    mockGetApps.mockResolvedValue({ kind: 'ok', applications: DEMO_APPS });

    const { container } = renderScreen();
    /* Site names can also appear in stats/chips — assert plural + sites table. */
    expect(await screen.findAllByText(firstName)).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Central site selection actions' })).toBeNull();

    const table = await waitFor(() => {
      const el = container.querySelector('[aria-label="Central sites"]') as HTMLElement | null;
      if (!el) throw new Error('Central sites table missing');
      return el;
    });
    const first = table.querySelector('tbody tr') as HTMLElement;
    expect(first).toBeTruthy();
    first.focus();
    fireEvent.keyDown(first, { key: 'x' });

    const bar = await screen.findByRole('region', { name: 'Central site selection actions' });
    expect(within(bar).getByText('1 SELECTED')).toBeTruthy();

    fireEvent.click(within(bar).getByRole('button', { name: 'Export selected' }));
    expect(await screen.findByText(/Exported 1 selected site/)).toBeTruthy();
    expect(createObjectURL).toHaveBeenCalled();

    fireEvent.click(within(bar).getByRole('button', { name: 'Copy names' }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(String(writeText.mock.calls[0]![0])).toContain(firstName);
    expect(await screen.findByText(/Copied 1 name/)).toBeTruthy();

    fireEvent.click(within(bar).getByRole('button', { name: 'Clear' }));
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: 'Central site selection actions' })).toBeNull(),
    );
  });
});

/* Loop 178 — sites bulk Copy selection link (?ids=) + clearable chip. */
describe('Central sites selection link (Loop 178)', () => {
  it('Copy selection link writes ids= and section=sites', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    const payload = demoPayload();
    expect(payload.sites.length).toBeGreaterThan(0);
    const firstId = payload.sites[0]!.siteId;
    mockGetCentral.mockResolvedValue(payload);
    mockGetApps.mockResolvedValue({ kind: 'ok', applications: DEMO_APPS });

    const { container } = renderScreen();
    const table = await waitFor(() => {
      const el = container.querySelector('[aria-label="Central sites"]') as HTMLElement | null;
      if (!el) throw new Error('Central sites table missing');
      return el;
    });
    const first = table.querySelector('tbody tr') as HTMLElement;
    expect(first).toBeTruthy();
    first.focus();
    fireEvent.keyDown(first, { key: 'x' });

    const bar = await screen.findByRole('region', { name: 'Central site selection actions' });
    fireEvent.click(within(bar).getByRole('button', { name: 'Copy selection link' }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    const url = String(writeText.mock.calls[0]![0]);
    expect(url).toMatch(/ids=/);
    expect(url).toContain(firstId);
    expect(url).toMatch(/section=sites/);
    expect(await screen.findByText(/Selection link copied/)).toBeTruthy();
  });

  it('deep-links ?ids= and shows a clearable selection chip', async () => {
    const payload = demoPayload();
    /* Need two sites so the filter visibly drops one. */
    const twoSites: CentralData = {
      ...payload,
      sites: [
        payload.sites[0]!,
        {
          ...payload.sites[0]!,
          siteId: 'branch-99' as (typeof payload.sites)[number]['siteId'],
          siteName: 'Branch-99 Remote',
        },
      ],
    };
    mockGetCentral.mockResolvedValue(twoSites);
    mockGetApps.mockResolvedValue({ kind: 'ok', applications: DEMO_APPS });

    const { container } = renderScreen(`/central?section=sites&ids=${encodeURIComponent(twoSites.sites[0]!.siteId)}`);
    expect(await screen.findAllByText(twoSites.sites[0]!.siteName)).toBeTruthy();
    const table = await waitFor(() => {
      const el = container.querySelector('[aria-label="Central sites"]') as HTMLElement | null;
      if (!el) throw new Error('Central sites table missing');
      return el;
    });
    /* Filter dropdown still lists the full estate — assert the grid body only. */
    expect(within(table).queryByText('Branch-99 Remote')).toBeNull();
    const chip = screen.getByRole('group', { name: 'Selection deep link' });
    expect(within(chip).getByText(/1 selected site/)).toBeTruthy();
    fireEvent.click(within(chip).getByRole('button'));
    await waitFor(() => expect(screen.getByTestId('path').textContent).not.toMatch(/ids=/));
    expect(await within(table).findByText('Branch-99 Remote')).toBeTruthy();
  });
});

/* Loop 177 — firmware multi-select Export selected + Copy serials bulk bar. */
describe('Central firmware bulk selection (Loop 177)', () => {
  it('shows bulk bar for selection: Export selected, Copy serials, Clear', async () => {
    const createObjectURL = vi.fn(() => 'blob:central-firmware-selected');
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    const payload: CentralData = {
      ...demoPayload(),
      firmware: [
        {
          name: 'ap-behind-1',
          model: 'AP-635',
          type: 'ap' as const,
          siteId: 'campus-01' as CentralData['firmware'][number]['siteId'],
          siteName: 'Campus-01 HQ',
          serial: 'SN-BEHIND-1',
          firmware: '10.5.0.0',
          target: '10.6.0.2',
          update: 'scheduled',
        },
        {
          name: 'ap-behind-2',
          model: 'AP-635',
          type: 'ap' as const,
          siteId: 'campus-01' as CentralData['firmware'][number]['siteId'],
          siteName: 'Campus-01 HQ',
          serial: 'SN-BEHIND-2',
          firmware: '10.5.0.0',
          target: '10.6.0.2',
          update: null,
        },
      ],
    };
    mockGetCentral.mockResolvedValue(payload);
    mockGetApps.mockResolvedValue({ kind: 'ok', applications: DEMO_APPS });

    const { container } = renderScreen('/central?section=firmware');
    expect(await screen.findByText('ap-behind-1')).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Central firmware selection actions' })).toBeNull();

    const table = await waitFor(() => {
      const el = container.querySelector(
        '[aria-label="Central firmware behind approved trains"]',
      ) as HTMLElement | null;
      if (!el) throw new Error('Central firmware table missing');
      return el;
    });
    const first = table.querySelector('tbody tr') as HTMLElement;
    expect(first).toBeTruthy();
    first.focus();
    fireEvent.keyDown(first, { key: 'x' });

    const bar = await screen.findByRole('region', { name: 'Central firmware selection actions' });
    expect(within(bar).getByText('1 SELECTED')).toBeTruthy();

    fireEvent.click(within(bar).getByRole('button', { name: 'Export selected' }));
    expect(await screen.findByText(/Exported 1 selected firmware row/)).toBeTruthy();
    expect(createObjectURL).toHaveBeenCalled();

    fireEvent.click(within(bar).getByRole('button', { name: 'Copy serials' }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(String(writeText.mock.calls[0]![0])).toContain('SN-BEHIND-1');
    expect(await screen.findByText(/Copied 1 serial/)).toBeTruthy();

    fireEvent.click(within(bar).getByRole('button', { name: 'Clear' }));
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: 'Central firmware selection actions' })).toBeNull(),
    );
  });
});

/* Loop 181 — firmware bulk Copy selection link (?serials=) + clearable chip. */
describe('Central firmware selection link (Loop 181)', () => {
  it('Copy selection link writes serials= and section=firmware', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    const payload: CentralData = {
      ...demoPayload(),
      firmware: [
        {
          name: 'ap-behind-1',
          model: 'AP-635',
          type: 'ap' as const,
          siteId: 'campus-01' as CentralData['firmware'][number]['siteId'],
          siteName: 'Campus-01 HQ',
          serial: 'SN-BEHIND-1',
          firmware: '10.5.0.0',
          target: '10.6.0.2',
          update: 'scheduled',
        },
        {
          name: 'ap-behind-2',
          model: 'AP-635',
          type: 'ap' as const,
          siteId: 'campus-01' as CentralData['firmware'][number]['siteId'],
          siteName: 'Campus-01 HQ',
          serial: 'SN-BEHIND-2',
          firmware: '10.5.0.0',
          target: '10.6.0.2',
          update: null,
        },
      ],
    };
    mockGetCentral.mockResolvedValue(payload);
    mockGetApps.mockResolvedValue({ kind: 'ok', applications: DEMO_APPS });

    const { container } = renderScreen('/central?section=firmware');
    expect(await screen.findByText('ap-behind-1')).toBeTruthy();

    const table = await waitFor(() => {
      const el = container.querySelector(
        '[aria-label="Central firmware behind approved trains"]',
      ) as HTMLElement | null;
      if (!el) throw new Error('Central firmware table missing');
      return el;
    });
    const first = table.querySelector('tbody tr') as HTMLElement;
    first.focus();
    fireEvent.keyDown(first, { key: 'x' });

    const bar = await screen.findByRole('region', { name: 'Central firmware selection actions' });
    fireEvent.click(within(bar).getByRole('button', { name: 'Copy selection link' }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    const url = String(writeText.mock.calls[0]![0]);
    expect(url).toMatch(/serials=/);
    expect(url).toContain('SN-BEHIND-1');
    expect(url).toMatch(/section=firmware/);
    expect(await screen.findByText(/Selection link copied/)).toBeTruthy();
  });

  it('deep-links ?serials= and shows a clearable selection chip', async () => {
    const payload: CentralData = {
      ...demoPayload(),
      firmware: [
        {
          name: 'ap-behind-1',
          model: 'AP-635',
          type: 'ap' as const,
          siteId: 'campus-01' as CentralData['firmware'][number]['siteId'],
          siteName: 'Campus-01 HQ',
          serial: 'SN-BEHIND-1',
          firmware: '10.5.0.0',
          target: '10.6.0.2',
          update: 'scheduled',
        },
        {
          name: 'ap-behind-2',
          model: 'AP-635',
          type: 'ap' as const,
          siteId: 'campus-01' as CentralData['firmware'][number]['siteId'],
          siteName: 'Campus-01 HQ',
          serial: 'SN-BEHIND-2',
          firmware: '10.5.0.0',
          target: '10.6.0.2',
          update: null,
        },
      ],
    };
    mockGetCentral.mockResolvedValue(payload);
    mockGetApps.mockResolvedValue({ kind: 'ok', applications: DEMO_APPS });

    const { container } = renderScreen(
      `/central?section=firmware&serials=${encodeURIComponent('SN-BEHIND-1')}`,
    );
    expect(await screen.findByText('ap-behind-1')).toBeTruthy();
    const table = await waitFor(() => {
      const el = container.querySelector(
        '[aria-label="Central firmware behind approved trains"]',
      ) as HTMLElement | null;
      if (!el) throw new Error('Central firmware table missing');
      return el;
    });
    expect(within(table).queryByText('ap-behind-2')).toBeNull();
    const chip = screen.getByRole('group', { name: 'Selection deep link' });
    expect(within(chip).getByText(/1 selected serial/)).toBeTruthy();
    fireEvent.click(within(chip).getByRole('button'));
    await waitFor(() => expect(screen.getByTestId('path').textContent).not.toMatch(/serials=/));
    expect(await within(table).findByText('ap-behind-2')).toBeTruthy();
  });
});

/* Loop 183 — WLANs multi-select Export selected + Copy names + selection link. */
describe('Central WLANs bulk selection (Loop 183)', () => {
  it('shows bulk bar for selection: Export selected, Copy names, Clear', async () => {
    const createObjectURL = vi.fn(() => 'blob:central-wlans-selected');
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    const payload = demoPayload();
    expect(payload.wlans.length).toBeGreaterThan(0);
    const firstName = payload.wlans[0]!.name;
    mockGetCentral.mockResolvedValue(payload);
    mockGetApps.mockResolvedValue({ kind: 'ok', applications: DEMO_APPS });

    const { container } = renderScreen('/central?section=wlans');
    expect(await screen.findAllByText(firstName)).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Central WLAN selection actions' })).toBeNull();

    const table = await waitFor(() => {
      const el = container.querySelector('[aria-label="Central WLANs"]') as HTMLElement | null;
      if (!el) throw new Error('Central WLANs table missing');
      return el;
    });
    const first = table.querySelector('tbody tr') as HTMLElement;
    expect(first).toBeTruthy();
    first.focus();
    fireEvent.keyDown(first, { key: 'x' });

    const bar = await screen.findByRole('region', { name: 'Central WLAN selection actions' });
    expect(within(bar).getByText('1 SELECTED')).toBeTruthy();

    fireEvent.click(within(bar).getByRole('button', { name: 'Export selected' }));
    expect(await screen.findByText(/Exported 1 selected WLAN/)).toBeTruthy();
    expect(createObjectURL).toHaveBeenCalled();

    fireEvent.click(within(bar).getByRole('button', { name: 'Copy names' }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(String(writeText.mock.calls[0]![0])).toContain(firstName);
    expect(await screen.findByText(/Copied 1 name/)).toBeTruthy();

    fireEvent.click(within(bar).getByRole('button', { name: 'Clear' }));
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: 'Central WLAN selection actions' })).toBeNull(),
    );
  });

  it('Copy selection link writes names= and section=wlans; deep-link chip clears', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    const base = demoPayload();
    const twoWlans: CentralData = {
      ...base,
      wlans: [
        base.wlans[0]!,
        {
          ...base.wlans[0]!,
          name: 'MRDN-Loop183-Extra',
          vlan: 'vlan 999',
          targets: 'branch-only',
        },
      ],
    };
    mockGetCentral.mockResolvedValue(twoWlans);
    mockGetApps.mockResolvedValue({ kind: 'ok', applications: DEMO_APPS });

    const { container } = renderScreen('/central?section=wlans');
    const table = await waitFor(() => {
      const el = container.querySelector('[aria-label="Central WLANs"]') as HTMLElement | null;
      if (!el) throw new Error('Central WLANs table missing');
      return el;
    });
    const first = table.querySelector('tbody tr') as HTMLElement;
    first.focus();
    fireEvent.keyDown(first, { key: 'x' });

    const bar = await screen.findByRole('region', { name: 'Central WLAN selection actions' });
    fireEvent.click(within(bar).getByRole('button', { name: 'Copy selection link' }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    const url = String(writeText.mock.calls[0]![0]);
    expect(url).toMatch(/names=/);
    expect(url).toContain(twoWlans.wlans[0]!.name);
    expect(url).toMatch(/section=wlans/);
    expect(await screen.findByText(/Selection link copied/)).toBeTruthy();

    cleanup();
    mockGetCentral.mockResolvedValue(twoWlans);
    mockGetApps.mockResolvedValue({ kind: 'ok', applications: DEMO_APPS });
    const second = renderScreen(
      `/central?section=wlans&names=${encodeURIComponent(twoWlans.wlans[0]!.name)}`,
    );
    expect(await screen.findAllByText(twoWlans.wlans[0]!.name)).toBeTruthy();
    const table2 = await waitFor(() => {
      const el = second.container.querySelector('[aria-label="Central WLANs"]') as HTMLElement | null;
      if (!el) throw new Error('Central WLANs table missing');
      return el;
    });
    expect(within(table2).queryByText('MRDN-Loop183-Extra')).toBeNull();
    const chip = screen.getByRole('group', { name: 'Selection deep link' });
    expect(within(chip).getByText(/1 selected WLAN/)).toBeTruthy();
    fireEvent.click(within(chip).getByRole('button'));
    await waitFor(() => expect(screen.getByTestId('path').textContent).not.toMatch(/names=/));
    expect(await within(table2).findByText('MRDN-Loop183-Extra')).toBeTruthy();
  });
});

/* Loop 198 — keyboard shortcuts help on Central plane tables. */
describe('Central Loop 198 residuals', () => {
  it('exposes keyboard shortcuts help on the Central header', async () => {
    mockGetCentral.mockResolvedValue(demoPayload());
    mockGetApps.mockResolvedValue({ kind: 'ok', applications: DEMO_APPS });
    renderScreen();
    expect(await screen.findByText('HPE Aruba Central')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Keyboard shortcuts' })).toBeTruthy();
  });
});

/* Loop 207 — sites/WLANs selection-empty Clear selection filter CTAs. */
describe('Central Loop 207 residuals', () => {
  it('offers Clear selection filter when sites ids deep link matches nothing', async () => {
    const payload = demoPayload();
    expect(payload.sites.length).toBeGreaterThan(0);
    mockGetCentral.mockResolvedValue(payload);
    mockGetApps.mockResolvedValue({ kind: 'ok', applications: DEMO_APPS });
    renderScreen(`/central?section=sites&ids=${encodeURIComponent('missing-site-id')}`);
    expect(await screen.findByText('No sites match this selection')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Clear selection filter' }));
    await waitFor(() => {
      expect(screen.queryByText('No sites match this selection')).toBeNull();
      expect(screen.getByTestId('path').textContent).not.toMatch(/ids=/);
    });
    expect(
      await waitFor(() => {
        const el = document.querySelector('[aria-label="Central sites"]');
        if (!el) throw new Error('Central sites table missing');
        return el;
      }),
    ).toBeTruthy();
  });

  it('offers Clear selection filter when WLANs names deep link matches nothing', async () => {
    const payload = demoPayload();
    expect(payload.wlans.length).toBeGreaterThan(0);
    mockGetCentral.mockResolvedValue(payload);
    mockGetApps.mockResolvedValue({ kind: 'ok', applications: DEMO_APPS });
    renderScreen(`/central?section=wlans&names=${encodeURIComponent('missing-ssid')}`);
    expect(await screen.findByText('No WLANs match this selection')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Clear selection filter' }));
    await waitFor(() => {
      expect(screen.queryByText('No WLANs match this selection')).toBeNull();
      expect(screen.getByTestId('path').textContent).not.toMatch(/names=/);
    });
    expect(
      await waitFor(() => {
        const el = document.querySelector('[aria-label="Central WLANs"]');
        if (!el) throw new Error('Central WLANs table missing');
        return el;
      }),
    ).toBeTruthy();
  });
});
