/**
 * web/src/screens/Mist.test.tsx — the Mist operational dashboard.
 *
 * getMist is mocked at the module boundary (the ClearPass.test.tsx pattern);
 * the on-demand ops reads (webhook registration, org audit log) go through
 * the REAL apiFetch against a stubbed global fetch routed by URL (the
 * MistSection.test.tsx pattern).
 *
 * Covered:
 *  (a) the demo payload renders every section: the plane header, the stat
 *      row, SLE worst-first with site links, the on-your-wire rogue leading,
 *      AP health sub-groups, WLANs, the behind-target firmware row, licence
 *      usage, and the on-demand ops sections;
 *  (b) navigation: SLE rows open the site drill-down, the firmware row opens
 *      the device page with its plane+serial identity, stat tiles link to
 *      the plane-filtered lists, WLANs point at Configure;
 *  (c) honest states: a live payload with unreported datasets words each
 *      section's not-reported line (never an all-clear), present-and-empty
 *      is a real answer, an unlinked plane says so, and an apiError takes
 *      the ApiErrorState;
 *  (d) the nav wiring: /mist resolves to its view, its path, its crumbs and
 *      its Operate-group nav item.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { ToastProvider } from '../nightdesk';
import Mist from './Mist';
import { getMist } from '../api/client';
import type { MistData } from '../api/client';
import { pathForView, viewForPath } from '../app/nav';
import * as csv from '../lib/csv';
import * as downloadApiCsvMod from '../lib/downloadApiCsv';
import {
  CRUMBS,
  DEVICES,
  MIST_AP_STATS,
  MIST_AUDIT_LOG,
  MIST_LICENSE_USAGES,
  MIST_PLANE_STATUS,
  MIST_ROGUE_APS,
  NAV_GROUPS,
  SITE_SLE,
  SSIDS,
  hhmmLocal,
} from '@hpe/shared';
import type { MistAuditLogLive, MistWebhookRegistrationStatus } from '@hpe/shared';

if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

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
  return { ...actual, getMist: vi.fn() };
});

const mockGetMist = vi.mocked(getMist);

/** The demo payload, composed exactly as the getter's fixture fallback does. */
function demoData(over: Partial<MistData> = {}): MistData {
  return {
    plane: MIST_PLANE_STATUS,
    sleBySiteId: SITE_SLE,
    rogues: MIST_ROGUE_APS,
    apStats: MIST_AP_STATS,
    licenseUsages: MIST_LICENSE_USAGES,
    wlans: SSIDS.filter((s) => s.plane.includes('MIST')),
    devices: DEVICES.filter((d) => d.plane === 'MIST'),
    dataSource: 'demo',
    syncedAt: '09:41',
    ...over,
  };
}

const REGISTERED: MistWebhookRegistrationStatus = {
  demoMode: true,
  linked: true,
  receiverPath: '/api/hooks/mist',
  subscriptions: [
    {
      id: 'wh-demo-1',
      name: 'portal receiver',
      url: 'https://portal.meridian-health.example/api/hooks/mist',
      topics: ['alarms', 'client-sessions', 'device-updowns'],
      enabled: true,
      secretConfigured: true,
    },
  ],
  totalSubscriptions: 1,
  lastReceivedAt: '2026-07-26T11:42:00.000Z',
  demo: true,
};

const AUDIT: MistAuditLogLive = {
  entries: MIST_AUDIT_LOG,
  source: { plane: 'mist', at: '2026-07-26T11:59:00.000Z', sections: { logs: 'ok' } },
};

function jsonResponse(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: vi.fn().mockResolvedValue(body) };
}

/** Route the ops sections' on-demand reads by URL; anything else is a test bug. */
function stubOpsFetch(opts: { statusHttp?: number; audit?: MistAuditLogLive | null } = {}) {
  const fn = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith('/api/hooks/mist/registration')) {
      const status = opts.statusHttp ?? 200;
      return jsonResponse(status === 200 ? REGISTERED : { error: 'registration status blew up' }, status);
    }
    if (url.startsWith('/api/systems/mist/audit-log')) {
      return jsonResponse({ auditLog: opts.audit === undefined ? AUDIT : opts.audit });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

function renderScreen(entry = '/mist') {
  return render(
    <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }} initialEntries={[entry]}>
      <ToastProvider>
        <Mist />
      </ToastProvider>
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  mockGetMist.mockReset();
});

describe('Mist screen — demo payload', () => {
  it('renders the plane header, stats and every section from the authored world', async () => {
    mockGetMist.mockResolvedValue(demoData());
    stubOpsFetch();
    renderScreen();

    // Header + plane strip.
    expect(await screen.findByRole('heading', { name: 'Mist' })).toBeTruthy();
    expect(screen.getByText('healthy')).toBeTruthy();
    expect(
      screen.getByText(
        new RegExp('sync stamp ' + hhmmLocal(MIST_PLANE_STATUS.lastSync!) + ' · DEMO FIXTURE'),
      ),
    ).toBeTruthy();

    // Stats: 128 devices, 1,472 clients, 3 scored sites (worst 55%), 1 on the wire.
    expect(screen.getByText('128')).toBeTruthy();
    expect(screen.getByText('1472')).toBeTruthy();
    expect(screen.getByText('worst 55%')).toBeTruthy();
    expect(screen.getByText('1 rogue BSSID on your infrastructure')).toBeTruthy();

    // SLE worst-first: Southpoint (55%) leads, Campus-02 (96%) trails.
    const sleSection = document.getElementById('mist-section-sle') as HTMLElement;
    const siteLinks = within(sleSection).getAllByRole('link');
    expect(siteLinks.map((a) => a.getAttribute('href'))).toEqual([
      '/sites/southpoint',
      '/sites/northgate',
      '/sites/campus-02',
    ]);
    expect(within(sleSection).getByText('3 SITES SCORED · MIST SLE')).toBeTruthy();

    // Rogues: the on-your-wire finding leads under its danger alert, sites named.
    expect(screen.getByText(/1 rogue BSSID on your wire/)).toBeTruthy();
    expect(screen.getByText('FREE-CLINIC-WIFI')).toBeTruthy();
    expect(screen.getByText(/5c:5b:35:00:0e:77 · Campus-02 Research/)).toBeTruthy();

    // AP health: the constrained AP, the DFS-story radio, the no-env honesty line, LLDP uplinks.
    expect(screen.getByText('constrained')).toBeTruthy();
    expect(screen.getByText(/22% non-Wi-Fi/)).toBeTruthy();
    expect(screen.getByText(/1 AP carried no environment sensor block/)).toBeTruthy();
    expect(screen.getByText(/sw-cam02-1 ge-0\/0\/12 · 1 Gb · Campus-02 Research/)).toBeTruthy();

    // WLANs: the three MIST-badged rows, Central-only MRDN-Guest excluded.
    expect(screen.getByText('3 WLANS · MIST')).toBeTruthy();
    expect(screen.getByText('MRDN-Research')).toBeTruthy();
    expect(screen.queryByText('MRDN-Guest')).toBeNull();
    expect(screen.getByRole('link', { name: 'Edit WLAN MRDN-Research in Configure' }).getAttribute('href')).toBe(
      '/configure?edit=ssid&plane=MIST&name=MRDN-Research&vlan=vlan+822&targets=Campus-02+Research+%C2%B7+enabled',
    );

    // AP rows carry their reported Mist serial identity; rogue rows lead only
    // to their originating site because a rogue BSSID is not an estate device.
    expect(screen.getByRole('link', { name: 'Open device ap-3f-14 — Power' }).getAttribute('href')).toBe(
      '/devices/ap-3f-14?plane=MIST&serial=MST43KF1401',
    );
    expect(screen.getByRole('link', { name: 'Open site Campus-02 Research for rogue 5c:5b:35:00:0e:77' }).getAttribute('href')).toBe('/sites/campus-02');

    // Firmware: ap-3f-14 behind, the plane's state word verbatim, the unreported count.
    expect(screen.getByText('behind → 0.14.29')).toBeTruthy();
    expect(screen.getByText('inprogress')).toBeTruthy();
    expect(screen.getByText(/3 devices carried no recommended-train read/)).toBeTruthy();

    // Licence usage: per-site consumption against fully-loaded demand.
    expect(screen.getByText('3 SITES · USED / FULLY-LOADED · MIST')).toBeTruthy();
    expect(screen.getByText(/SUB-SW 0 \/ 4/)).toBeTruthy();

    // The on-demand ops sections fill in from their own reads.
    expect(await screen.findByText(/portal.meridian-health.example\/api\/hooks\/mist/)).toBeTruthy();
    expect(screen.getByText('DEMO FIXTURE')).toBeTruthy();
    expect(await screen.findByText(/Updated WLAN 'MRDN-Research'/)).toBeTruthy();
  });

  it('links: firmware opens the device with plane+serial, stat tiles filter by plane, WLANs point at Configure', async () => {
    mockGetMist.mockResolvedValue(demoData());
    stubOpsFetch();
    renderScreen();
    const firmwareSection = (await screen.findByText('Firmware')).closest('#mist-section-devices')!;
    expect(firmwareSection).toBeTruthy();
    const behind = await within(firmwareSection as HTMLElement).findByText('ap-3f-14');
    const deviceLink = behind.closest('a')!;
    // The authored fixture carries no serial, so the link is plane-only.
    expect(deviceLink.getAttribute('href')).toBe('/devices/ap-3f-14?plane=MIST');
    const devicesStat = screen.getByText('Devices').closest('a')!;
    expect(devicesStat.getAttribute('href')).toBe('/devices?plane=mist');
    const clientsStat = screen.getByText('Clients').closest('a')!;
    expect(clientsStat.getAttribute('href')).toBe('/clients?plane=mist');
    expect(screen.getByRole('link', { name: "Configure's Mist flow" }).getAttribute('href')).toBe('/configure');
  });
});

describe('Mist screen — honest states', () => {
  it('an unlinked live plane says so, and every unreported dataset words its own line', async () => {
    mockGetMist.mockResolvedValue({
      plane: { linked: false, health: 'unlinked', lastSync: null, deviceCount: null, clientCount: null, note: null },
      licenseUsages: null,
      wlans: null,
      devices: [],
      dataSource: 'live',
      syncedAt: null,
    });
    stubOpsFetch();
    renderScreen();

    expect(await screen.findByText('Mist is not linked')).toBeTruthy();
    expect(screen.getByText('not linked')).toBeTruthy();
    expect(screen.getByText(/The SLE walk was not reported this cycle/)).toBeTruthy();
    expect(screen.getByText(/The rogue\/neighbor walk was not reported this cycle/)).toBeTruthy();
    expect(screen.getByText(/The AP-stats walk was not reported this cycle/)).toBeTruthy();
    expect(screen.getByText(/The WLAN inventory was not read this cycle/)).toBeTruthy();
    expect(screen.getByText(/No Mist-claimed devices in the inventory this cycle/)).toBeTruthy();
    expect(screen.getByText(/Mist reported no licence usage this cycle/)).toBeTruthy();
    // Unreported stats read '—', never a fabricated zero.
    expect(screen.getByText('SLE not reported this cycle')).toBeTruthy();
    expect(screen.getByText('rogue report not read this cycle')).toBeTruthy();
  });

  it('present-and-empty is a real answer, worded differently from not-reported', async () => {
    mockGetMist.mockResolvedValue(
      demoData({ rogues: [], apStats: [], wlans: [], licenseUsages: [], sleBySiteId: {}, dataSource: 'live' }),
    );
    stubOpsFetch();
    renderScreen();

    expect(await screen.findByText(/Mist reported no rogue or neighbor BSSIDs at any site this cycle/)).toBeTruthy();
    expect(screen.getByText(/The AP-stats walk reported no rows this cycle/)).toBeTruthy();
    expect(screen.getByText(/Mist reported no WLANs — a real answer/)).toBeTruthy();
    expect(screen.getByText(/no per-site rows — a real answer/)).toBeTruthy();
    expect(screen.getByText(/an unscored window is "not reported", never a 0%/)).toBeTruthy();
    expect(screen.queryByText(/was not reported this cycle/)).toBeNull();
  });

  it('an apiError takes the ApiErrorState instead of the dashboard', async () => {
    mockGetMist.mockResolvedValue({
      plane: { linked: false, health: 'unlinked', lastSync: null, deviceCount: null, clientCount: null, note: null },
      devices: [],
      dataSource: 'live',
      syncedAt: null,
      apiError: 'mist read blew up',
    });
    stubOpsFetch();
    renderScreen();
    expect(await screen.findByText(/mist read blew up/)).toBeTruthy();
    expect(screen.queryByText('Wireless experience across sites')).toBeNull();
  });

  it('a failed ops read is an honest sentence, never a fabricated roster', async () => {
    mockGetMist.mockResolvedValue(demoData());
    stubOpsFetch({ statusHttp: 500, audit: null });
    renderScreen();
    expect(await screen.findByText(/The registration status could not be read — registration status blew up/)).toBeTruthy();
    expect(await screen.findByText(/No linked Mist plane can read the org audit log/)).toBeTruthy();
    // The poll-time sections around the failed on-demand reads still render.
    expect(screen.getByText('Wireless experience across sites')).toBeTruthy();
  });
});

describe('Mist section share helpers (Loop 74)', () => {
  it('parses section tokens and builds share URLs for every section', async () => {
    const { parseMistSection, buildMistShareUrl, mistSectionDomId, MIST_SECTIONS } = await import('./mist/share');
    expect(MIST_SECTIONS).toEqual(['sle', 'rogues', 'ap-health', 'wlans', 'devices', 'licenses', 'audit']);
    expect(parseMistSection('ap')).toBe('ap-health');
    expect(parseMistSection('firmware')).toBe('devices');
    expect(parseMistSection('mist-section-rogues')).toBe('rogues');
    expect(mistSectionDomId('wlans')).toBe('mist-section-wlans');
    expect(buildMistShareUrl('sle', 'http://x', '/mist')).toBe(
      'http://x/mist?section=sle#mist-section-sle',
    );
    expect(buildMistShareUrl(null, 'http://x', '/mist')).toBe('http://x/mist');
  });
});

describe('Mist screen — export and share (Loop 49)', () => {
  it('header Export CSV includes Mist-claimed devices (not only rogues/APs)', async () => {
    mockGetMist.mockResolvedValue(demoData());
    stubOpsFetch();
    const spy = vi.spyOn(csv, 'exportTableCsv').mockReturnValue(4);
    renderScreen();
    await screen.findByRole('heading', { name: 'Mist' });
    const headerExport = screen
      .getAllByRole('button', { name: 'Export CSV' })
      .find((b) => !b.closest('[id^="mist-section-"]'));
    expect(headerExport).toBeTruthy();
    fireEvent.click(headerExport!);
    expect(spy).toHaveBeenCalled();
    const deviceCall = spy.mock.calls.find((c) => c[0] === 'mist-devices.csv');
    expect(deviceCall).toBeTruthy();
    expect(deviceCall![1]).toEqual(
      expect.arrayContaining(['name', 'type', 'model', 'site', 'state', 'firmware', 'serial']),
    );
    spy.mockRestore();
  });

  it('live header Download SLE CSV hits part=sle (Loop 98)', async () => {
    mockGetMist.mockResolvedValue(demoData({ dataSource: 'live' }));
    stubOpsFetch();
    const dlSpy = vi.spyOn(downloadApiCsvMod, 'downloadApiCsv').mockResolvedValue({ ok: true });
    renderScreen();
    await screen.findByRole('heading', { name: 'Mist' });
    fireEvent.click(screen.getByRole('button', { name: 'Download SLE CSV' }));
    await waitFor(() =>
      expect(dlSpy).toHaveBeenCalledWith('/api/mist/export?part=sle', 'mist-sle.csv'),
    );
    dlSpy.mockRestore();
  });

  it('live header Download WLANs/licences CSV hits part=wlans|licenses (Loop 104)', async () => {
    mockGetMist.mockResolvedValue(demoData({ dataSource: 'live' }));
    stubOpsFetch();
    const dlSpy = vi.spyOn(downloadApiCsvMod, 'downloadApiCsv').mockResolvedValue({ ok: true });
    renderScreen();
    await screen.findByRole('heading', { name: 'Mist' });
    fireEvent.click(screen.getByRole('button', { name: 'Download WLANs CSV' }));
    await waitFor(() =>
      expect(dlSpy).toHaveBeenCalledWith('/api/mist/export?part=wlans', 'mist-wlans.csv'),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Download licences CSV' }));
    await waitFor(() =>
      expect(dlSpy).toHaveBeenCalledWith('/api/mist/export?part=licenses', 'mist-licenses.csv'),
    );
    dlSpy.mockRestore();
  });

  it('Firmware section offers inventory CSV, compliance CSV for behind rows, + section link', async () => {
    mockGetMist.mockResolvedValue(demoData());
    stubOpsFetch();
    const clipboard = { writeText: vi.fn().mockResolvedValue(undefined) };
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: clipboard });
    const spy = vi.spyOn(csv, 'exportTableCsv').mockReturnValue(4);
    renderScreen();
    await screen.findByText('behind → 0.14.29');
    const firmwareLabel = screen.getByText('Firmware');
    const firmwareHeader = firmwareLabel.closest('.nt-row-between-12') ?? firmwareLabel.parentElement!;
    fireEvent.click(within(firmwareHeader as HTMLElement).getByRole('button', { name: 'Copy section link' }));
    await waitFor(() => expect(clipboard.writeText).toHaveBeenCalled());
    expect(String(clipboard.writeText.mock.calls[0]![0])).toMatch(/\/mist\?section=devices/);
    fireEvent.click(within(firmwareHeader as HTMLElement).getByRole('button', { name: 'Export compliance CSV' }));
    expect(spy.mock.calls.some((c) => c[0] === 'mist-firmware-compliance.csv')).toBe(true);
    fireEvent.click(within(firmwareHeader as HTMLElement).getByRole('button', { name: 'Export CSV' }));
    expect(spy.mock.calls.some((c) => c[0] === 'mist-devices.csv')).toBe(true);
    spy.mockRestore();
  });

  it('Org audit log offers Export CSV, server CSV, and section share link', async () => {
    mockGetMist.mockResolvedValue(demoData());
    stubOpsFetch();
    const clipboard = { writeText: vi.fn().mockResolvedValue(undefined) };
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: clipboard });
    const exportSpy = vi.spyOn(csv, 'exportTableCsv').mockReturnValue(3);
    const dlSpy = vi.spyOn(downloadApiCsvMod, 'downloadApiCsv').mockResolvedValue({ ok: true });
    renderScreen();
    expect(await screen.findByText(/Updated WLAN 'MRDN-Research'/)).toBeTruthy();
    const auditLabel = screen.getByText('Org audit log');
    const auditHeader = auditLabel.closest('.nt-row-between-12') ?? auditLabel.parentElement!;
    fireEvent.click(within(auditHeader as HTMLElement).getByRole('button', { name: 'Copy section link' }));
    await waitFor(() => expect(clipboard.writeText).toHaveBeenCalled());
    expect(String(clipboard.writeText.mock.calls[0]![0])).toMatch(/\/mist\?section=audit/);
    fireEvent.click(within(auditHeader as HTMLElement).getByRole('button', { name: 'Export CSV' }));
    expect(exportSpy.mock.calls.some((c) => c[0] === 'mist-audit-log.csv')).toBe(true);
    fireEvent.click(within(auditHeader as HTMLElement).getByRole('button', { name: 'Download server CSV' }));
    await waitFor(() => expect(dlSpy).toHaveBeenCalledWith('/api/mist/audit-log/export', 'mist-audit-log.csv'));
    exportSpy.mockRestore();
    dlSpy.mockRestore();
  });

  it('every poll-time section offers Copy section link (Loop 74)', async () => {
    mockGetMist.mockResolvedValue(demoData());
    stubOpsFetch();
    const clipboard = { writeText: vi.fn().mockResolvedValue(undefined) };
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: clipboard });
    renderScreen();
    await screen.findByRole('heading', { name: 'Mist' });

    const cases: Array<{ label: string | RegExp; section: string }> = [
      { label: 'Wireless experience across sites', section: 'sle' },
      { label: 'Rogue & neighbor APs', section: 'rogues' },
      { label: 'AP health', section: 'ap-health' },
      { label: 'WLANs', section: 'wlans' },
      { label: 'Licence usage per site', section: 'licenses' },
    ];
    for (const c of cases) {
      clipboard.writeText.mockClear();
      const labelEl = screen.getByText(c.label);
      const header = labelEl.closest('.nt-row-between-12') ?? labelEl.parentElement!;
      fireEvent.click(within(header as HTMLElement).getByRole('button', { name: 'Copy section link' }));
      await waitFor(() => expect(clipboard.writeText).toHaveBeenCalled());
      expect(String(clipboard.writeText.mock.calls[0]![0])).toMatch(
        new RegExp(`/mist\\?section=${c.section.replace('-', '\\-')}`),
      );
      expect(String(clipboard.writeText.mock.calls[0]![0])).toMatch(
        new RegExp(`#mist-section-${c.section.replace('-', '\\-')}`),
      );
    }
    expect(document.getElementById('mist-section-sle')).toBeTruthy();
    expect(document.getElementById('mist-section-rogues')).toBeTruthy();
    expect(document.getElementById('mist-section-ap-health')).toBeTruthy();
    expect(document.getElementById('mist-section-wlans')).toBeTruthy();
    expect(document.getElementById('mist-section-licenses')).toBeTruthy();
  });
});

describe('Mist screen — nav wiring', () => {
  it('/mist resolves to the mist view, its path, crumbs and Operate-group item', async () => {
    expect(viewForPath('/mist')).toBe('mist');
    expect(pathForView('mist')).toBe('/mist');
    expect(CRUMBS.mist).toEqual([{ label: 'Platforms' }, { label: 'Mist' }]);
    const platforms = NAV_GROUPS.find((g) => g.label === 'Platforms')!;
    const item = platforms.items.find((i) => i.view === 'mist');
    expect(item).toEqual({ label: 'Mist', view: 'mist' });
    // Plane consoles live under Platforms (object-first IA).
    const views = platforms.items.map((i) => i.view);
    expect(views.indexOf('mist')).toBeGreaterThan(views.indexOf('central'));
    expect(views.indexOf('mist')).toBeLessThan(views.indexOf('clearpass'));
  });

  it('waits for the payload before rendering, then replaces the spinner', async () => {
    let resolve!: (d: MistData) => void;
    mockGetMist.mockReturnValue(new Promise((r) => (resolve = r)));
    stubOpsFetch();
    renderScreen();
    expect(screen.queryByText('Wireless experience across sites')).toBeNull();
    resolve(demoData());
    await waitFor(() => expect(screen.getByText('Wireless experience across sites')).toBeTruthy());
  });
});

/* Loop 140 — Enabled chip row toggles the same enabled= filter as the Select. */
describe('Mist WLAN enabled chips (Loop 140)', () => {
  it('enabled chips filter WLANs and write enabled back to the URL', async () => {
    Element.prototype.scrollIntoView = vi.fn();
    mockGetMist.mockResolvedValue(
      demoData({
        wlans: [
          {
            kind: 'ssid',
            name: 'Enabled-SSID',
            vlan: 'vlan 1',
            security: 'WPA2',
            targets: 'site-a',
            plane: 'MIST',
            tone: 'info',
            enabled: true,
          },
          {
            kind: 'ssid',
            name: 'Disabled-SSID',
            vlan: 'vlan 2',
            security: 'WPA2',
            targets: 'site-b',
            plane: 'MIST',
            tone: 'info',
            enabled: false,
          },
        ],
      }),
    );
    stubOpsFetch();

    function SearchProbe() {
      const loc = useLocation();
      return <div data-testid="search">{loc.search}</div>;
    }

    render(
      <MemoryRouter
        future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
        initialEntries={['/mist?section=wlans']}
      >
        <ToastProvider>
          <Mist />
          <SearchProbe />
        </ToastProvider>
      </MemoryRouter>,
    );

    expect(await screen.findByText('Enabled-SSID')).toBeTruthy();
    expect(screen.getByText('Disabled-SSID')).toBeTruthy();

    const chips = screen.getByRole('group', { name: 'WLAN enabled' });
    const disabledChip = within(chips).getByRole('button', { name: /Disabled/i });
    expect(disabledChip.getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(disabledChip);
    await waitFor(() => expect(screen.getByText('Disabled-SSID')).toBeTruthy());
    expect(screen.queryByText('Enabled-SSID')).toBeNull();
    expect(screen.getByTestId('search').textContent).toMatch(/enabled=0/);
    expect(disabledChip.getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(disabledChip);
    await waitFor(() => expect(screen.getByText('Enabled-SSID')).toBeTruthy());
    expect(screen.getByText('Disabled-SSID')).toBeTruthy();
    expect(screen.getByTestId('search').textContent).not.toMatch(/enabled=/);
  });
});


/* Loop 165 — LIVE badge honesty (pure live + mist blend). */
describe('Mist Loop 165 residuals', () => {
  it('stamps LIVE on pure live Mist estate', async () => {
    mockGetMist.mockResolvedValue(demoData({ dataSource: 'live' }));
    stubOpsFetch();
    renderScreen();
    expect(await screen.findByText('LIVE')).toBeTruthy();
  });

  it('stamps LIVE when mist arrives via blend', async () => {
    mockGetMist.mockResolvedValue(demoData({ dataSource: 'demo', blended: ['mist'] }));
    stubOpsFetch();
    renderScreen();
    expect(await screen.findByText('LIVE')).toBeTruthy();
  });

  it('hides LIVE on demo fixtures without blend', async () => {
    mockGetMist.mockResolvedValue(demoData({ dataSource: 'demo' }));
    stubOpsFetch();
    renderScreen();
    await screen.findByText(/DEMO FIXTURE/i);
    expect(screen.queryByText('LIVE')).toBeNull();
  });
});

/* Loop 180 — Mist firmware multi-select Export selected + Copy serials bulk bar. */
describe('Mist firmware bulk selection (Loop 180)', () => {
  it('shows bulk bar for selection: Export selected, Copy serials, Clear', async () => {
    const createObjectURL = vi.fn(() => 'blob:mist-firmware-selected');
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    const devices = DEVICES.filter((d) => d.plane === 'MIST').map((d, i) =>
      d.name === 'ap-3f-14'
        ? { ...d, serial: 'MST-BEHIND-1' }
        : i === 0
          ? { ...d, serial: d.serial ?? 'MST-OTHER-1' }
          : d,
    );
    // Ensure at least one behind row with a known serial for Copy serials.
    const withBehind = devices.some((d) => d.firmwareApproved === false && d.firmwareTarget)
      ? devices
      : [
          {
            ...DEVICES.find((d) => d.plane === 'MIST')!,
            name: 'ap-behind-loop180',
            serial: 'MST-BEHIND-1',
            firmware: '0.13.18',
            firmwareApproved: false as const,
            firmwareTarget: '0.14.29',
            firmwareUpdate: 'inprogress',
          },
          ...devices,
        ];

    mockGetMist.mockResolvedValue(demoData({ devices: withBehind }));
    stubOpsFetch();
    const { container } = renderScreen();

    expect(await screen.findByText('behind → 0.14.29')).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Mist firmware selection actions' })).toBeNull();

    const table = await waitFor(() => {
      const el = container.querySelector(
        '[aria-label="Mist firmware behind recommended trains"]',
      ) as HTMLElement | null;
      if (!el) throw new Error('Mist firmware table missing');
      return el;
    });
    const first = table.querySelector('tbody tr') as HTMLElement;
    expect(first).toBeTruthy();
    first.focus();
    fireEvent.keyDown(first, { key: 'x' });

    const bar = await screen.findByRole('region', { name: 'Mist firmware selection actions' });
    expect(within(bar).getByText('1 SELECTED')).toBeTruthy();

    fireEvent.click(within(bar).getByRole('button', { name: 'Export selected' }));
    expect(await screen.findByText(/Exported 1 selected firmware row/)).toBeTruthy();
    expect(createObjectURL).toHaveBeenCalled();

    fireEvent.click(within(bar).getByRole('button', { name: 'Copy serials' }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(String(writeText.mock.calls[0]![0])).toContain('MST-BEHIND-1');
    expect(await screen.findByText(/Copied 1 serial/)).toBeTruthy();

    fireEvent.click(within(bar).getByRole('button', { name: 'Clear' }));
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: 'Mist firmware selection actions' })).toBeNull(),
    );
  });
});

/* Loop 184 — Mist firmware bulk Copy selection link (?serials=) + clearable chip. */
describe('Mist firmware selection link (Loop 184)', () => {
  it('Copy selection link writes serials= and section=devices', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    const devices = [
      {
        ...DEVICES.find((d) => d.plane === 'MIST')!,
        name: 'ap-behind-loop184',
        serial: 'MST-BEHIND-184',
        firmware: '0.13.18',
        firmwareApproved: false as const,
        firmwareTarget: '0.14.29',
        firmwareUpdate: 'inprogress',
      },
      ...DEVICES.filter((d) => d.plane === 'MIST'),
    ];
    mockGetMist.mockResolvedValue(demoData({ devices }));
    stubOpsFetch();
    const { container } = renderScreen();

    const table = await waitFor(() => {
      const el = container.querySelector(
        '[aria-label="Mist firmware behind recommended trains"]',
      ) as HTMLElement | null;
      if (!el) throw new Error('Mist firmware table missing');
      return el;
    });
    expect(await within(table).findByText('ap-behind-loop184')).toBeTruthy();
    const marks = await within(table).findAllByText('behind → 0.14.29');
    expect(marks.length).toBeGreaterThan(0);
    const first = table.querySelector('tbody tr') as HTMLElement;
    first.focus();
    fireEvent.keyDown(first, { key: 'x' });

    const bar = await screen.findByRole('region', { name: 'Mist firmware selection actions' });
    fireEvent.click(within(bar).getByRole('button', { name: 'Copy selection link' }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    const url = decodeURIComponent(String(writeText.mock.calls[0]![0]));
    expect(url).toMatch(/serials=/);
    expect(url).toContain('MST-BEHIND-184');
    expect(url).toMatch(/section=devices/);
    expect(await screen.findByText(/Selection link copied/)).toBeTruthy();
  });

  it('deep-links ?serials= and shows a clearable selection chip', async () => {
    const devices = [
      {
        ...DEVICES.find((d) => d.plane === 'MIST')!,
        name: 'ap-behind-a',
        serial: 'MST-BEHIND-A',
        firmware: '0.13.18',
        firmwareApproved: false as const,
        firmwareTarget: '0.14.29',
      },
      {
        ...DEVICES.find((d) => d.plane === 'MIST')!,
        name: 'ap-behind-b',
        serial: 'MST-BEHIND-B',
        firmware: '0.13.18',
        firmwareApproved: false as const,
        firmwareTarget: '0.14.29',
      },
    ];
    mockGetMist.mockResolvedValue(demoData({ devices }));
    stubOpsFetch();
    const { container } = renderScreen(
      `/mist?section=devices&serials=${encodeURIComponent('MST-BEHIND-A')}`,
    );

    expect(await screen.findByText('ap-behind-a')).toBeTruthy();
    const table = await waitFor(() => {
      const el = container.querySelector(
        '[aria-label="Mist firmware behind recommended trains"]',
      ) as HTMLElement | null;
      if (!el) throw new Error('Mist firmware table missing');
      return el;
    });
    expect(within(table).queryByText('ap-behind-b')).toBeNull();
    const chip = screen.getByRole('group', { name: 'Selection deep link' });
    expect(within(chip).getByText(/1 selected serial/)).toBeTruthy();
    fireEvent.click(within(chip).getByRole('button'));
    await waitFor(() => expect(screen.queryByRole('group', { name: 'Selection deep link' })).toBeNull());
    expect(await within(table).findByText('ap-behind-b')).toBeTruthy();
  });
});

/* Loop 187 — Mist WLANs multi-select Export selected + Copy names + selection link. */
describe('Mist WLANs bulk selection (Loop 187)', () => {
  it('shows bulk bar for selection: Export selected, Copy names, Clear', async () => {
    const createObjectURL = vi.fn(() => 'blob:mist-wlans-selected');
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    const payload = demoData();
    expect(payload.wlans && payload.wlans.length).toBeGreaterThan(0);
    const firstName = payload.wlans![0]!.name;
    mockGetMist.mockResolvedValue(payload);
    stubOpsFetch();
    const { container } = renderScreen('/mist?section=wlans');

    expect(await screen.findAllByText(firstName)).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Mist WLAN selection actions' })).toBeNull();

    const table = await waitFor(() => {
      const el = container.querySelector('[aria-label="Mist WLANs"]') as HTMLElement | null;
      if (!el) throw new Error('Mist WLANs table missing');
      return el;
    });
    const first = table.querySelector('tbody tr') as HTMLElement;
    expect(first).toBeTruthy();
    first.focus();
    fireEvent.keyDown(first, { key: 'x' });

    const bar = await screen.findByRole('region', { name: 'Mist WLAN selection actions' });
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
      expect(screen.queryByRole('region', { name: 'Mist WLAN selection actions' })).toBeNull(),
    );
  });

  it('Copy selection link writes names= and section=wlans; deep-link chip clears', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    const base = demoData();
    const two = {
      ...base,
      wlans: [
        base.wlans![0]!,
        {
          ...base.wlans![0]!,
          name: 'MRDN-Loop187-Extra',
          vlan: 'vlan 999',
          targets: 'branch-only',
        },
      ],
    };
    mockGetMist.mockResolvedValue(two);
    stubOpsFetch();
    const { container } = renderScreen('/mist?section=wlans');
    const table = await waitFor(() => {
      const el = container.querySelector('[aria-label="Mist WLANs"]') as HTMLElement | null;
      if (!el) throw new Error('Mist WLANs table missing');
      return el;
    });
    const first = table.querySelector('tbody tr') as HTMLElement;
    first.focus();
    fireEvent.keyDown(first, { key: 'x' });

    const bar = await screen.findByRole('region', { name: 'Mist WLAN selection actions' });
    fireEvent.click(within(bar).getByRole('button', { name: 'Copy selection link' }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    const url = decodeURIComponent(String(writeText.mock.calls[0]![0]));
    expect(url).toMatch(/names=/);
    expect(url).toContain(two.wlans![0]!.name);
    expect(url).toMatch(/section=wlans/);
    expect(await screen.findByText(/Selection link copied/)).toBeTruthy();

    cleanup();
    mockGetMist.mockResolvedValue(two);
    stubOpsFetch();
    const second = renderScreen(
      `/mist?section=wlans&names=${encodeURIComponent(two.wlans![0]!.name)}`,
    );
    expect(await screen.findAllByText(two.wlans![0]!.name)).toBeTruthy();
    const table2 = await waitFor(() => {
      const el = second.container.querySelector('[aria-label="Mist WLANs"]') as HTMLElement | null;
      if (!el) throw new Error('Mist WLANs table missing');
      return el;
    });
    expect(within(table2).queryByText('MRDN-Loop187-Extra')).toBeNull();
    const chip = screen.getByRole('group', { name: 'Selection deep link' });
    expect(within(chip).getByText(/1 selected WLAN/)).toBeTruthy();
    fireEvent.click(within(chip).getByRole('button'));
    await waitFor(() => expect(screen.queryByRole('group', { name: 'Selection deep link' })).toBeNull());
    expect(await within(table2).findByText('MRDN-Loop187-Extra')).toBeTruthy();
  });
});

/* Loop 187 — Mist licence usage multi-select Export selected + Copy site ids + selection link. */
describe('Mist licences bulk selection (Loop 187)', () => {
  it('shows bulk bar for selection: Export selected, Copy site ids, Clear', async () => {
    const createObjectURL = vi.fn(() => 'blob:mist-licenses-selected');
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    const payload = demoData();
    expect(payload.licenseUsages && payload.licenseUsages.length).toBeGreaterThan(0);
    const firstId = payload.licenseUsages![0]!.siteId;
    mockGetMist.mockResolvedValue(payload);
    stubOpsFetch();
    const { container } = renderScreen('/mist?section=licenses');

    const table = await waitFor(() => {
      const el = container.querySelector('[aria-label="Mist licence usage"]') as HTMLElement | null;
      if (!el) throw new Error('Mist licence table missing');
      return el;
    });
    expect(within(table).getByText(payload.licenseUsages![0]!.siteName)).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Mist licence selection actions' })).toBeNull();
    const first = table.querySelector('tbody tr') as HTMLElement;
    expect(first).toBeTruthy();
    first.focus();
    fireEvent.keyDown(first, { key: 'x' });

    const bar = await screen.findByRole('region', { name: 'Mist licence selection actions' });
    expect(within(bar).getByText('1 SELECTED')).toBeTruthy();

    fireEvent.click(within(bar).getByRole('button', { name: 'Export selected' }));
    expect(await screen.findByText(/Exported 1 selected site/)).toBeTruthy();
    expect(createObjectURL).toHaveBeenCalled();

    fireEvent.click(within(bar).getByRole('button', { name: 'Copy site ids' }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(String(writeText.mock.calls[0]![0])).toContain(firstId);
    expect(await screen.findByText(/Copied 1 site id/)).toBeTruthy();

    fireEvent.click(within(bar).getByRole('button', { name: 'Clear' }));
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: 'Mist licence selection actions' })).toBeNull(),
    );
  });

  /* Loop 231 — licence bulk Copy names (site names) beside Copy site ids. */
  it('Loop 231 Copy names joins unique site names from the selection', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    const base = demoData();
    const two = {
      ...base,
      licenseUsages: [
        base.licenseUsages![0]!,
        {
          ...base.licenseUsages![0]!,
          siteId: 'southpoint' as const,
          siteName: 'Loop231 Extra Site',
        },
        {
          ...base.licenseUsages![0]!,
          siteId: 'northgate' as const,
          siteName: base.licenseUsages![0]!.siteName,
        },
      ],
    };
    mockGetMist.mockResolvedValue(two);
    stubOpsFetch();
    const { container } = renderScreen('/mist?section=licenses');

    const table = await waitFor(() => {
      const el = container.querySelector('[aria-label="Mist licence usage"]') as HTMLElement | null;
      if (!el) throw new Error('Mist licence table missing');
      return el;
    });
    /* Base site name appears twice (site 0 + northpoint alias) — assert plural. */
    expect(within(table).getAllByText(two.licenseUsages[0]!.siteName).length).toBeGreaterThanOrEqual(2);
    expect(within(table).getByText('Loop231 Extra Site')).toBeTruthy();

    const rows = table.querySelectorAll('tbody tr');
    expect(rows.length).toBeGreaterThanOrEqual(3);
    for (let i = 0; i < 3; i++) {
      (rows[i] as HTMLElement).focus();
      fireEvent.keyDown(rows[i] as HTMLElement, { key: 'x' });
    }

    const bar = await screen.findByRole('region', { name: 'Mist licence selection actions' });
    expect(within(bar).getByRole('button', { name: 'Copy names' })).toBeTruthy();
    fireEvent.click(within(bar).getByRole('button', { name: 'Copy names' }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    const text = String(writeText.mock.calls[0]![0]);
    expect(text.split('\n').sort()).toEqual(
      [two.licenseUsages[0]!.siteName, 'Loop231 Extra Site'].sort(),
    );
    expect(await screen.findByText(/Copied 2 names/)).toBeTruthy();
  });

  it('Copy selection link writes siteIds= and section=licenses; deep-link chip clears', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    const base = demoData();
    const two = {
      ...base,
      licenseUsages: [
        base.licenseUsages![0]!,
        {
          ...base.licenseUsages![0]!,
          siteId: 'southpoint' as const,
          siteName: 'Loop187 Extra Site',
        },
      ],
    };
    mockGetMist.mockResolvedValue(two);
    stubOpsFetch();
    const { container } = renderScreen('/mist?section=licenses');
    const table = await waitFor(() => {
      const el = container.querySelector('[aria-label="Mist licence usage"]') as HTMLElement | null;
      if (!el) throw new Error('Mist licence table missing');
      return el;
    });
    const first = table.querySelector('tbody tr') as HTMLElement;
    first.focus();
    fireEvent.keyDown(first, { key: 'x' });

    const bar = await screen.findByRole('region', { name: 'Mist licence selection actions' });
    fireEvent.click(within(bar).getByRole('button', { name: 'Copy selection link' }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    const url = decodeURIComponent(String(writeText.mock.calls[0]![0]));
    expect(url).toMatch(/siteIds=/);
    expect(url).toContain(two.licenseUsages![0]!.siteId);
    expect(url).toMatch(/section=licenses/);
    expect(await screen.findByText(/Selection link copied/)).toBeTruthy();

    cleanup();
    mockGetMist.mockResolvedValue(two);
    stubOpsFetch();
    const second = renderScreen(
      `/mist?section=licenses&siteIds=${encodeURIComponent(two.licenseUsages![0]!.siteId)}`,
    );
    const table2 = await waitFor(() => {
      const el = second.container.querySelector('[aria-label="Mist licence usage"]') as HTMLElement | null;
      if (!el) throw new Error('Mist licence table missing');
      return el;
    });
    expect(within(table2).getByText(two.licenseUsages![0]!.siteName)).toBeTruthy();
    expect(within(table2).queryByText('Loop187 Extra Site')).toBeNull();
    const chip = screen.getByRole('group', { name: 'Selection deep link' });
    expect(within(chip).getByText(/1 selected site/)).toBeTruthy();
    fireEvent.click(within(chip).getByRole('button'));
    await waitFor(() => expect(screen.queryByRole('group', { name: 'Selection deep link' })).toBeNull());
    expect(await within(table2).findByText('Loop187 Extra Site')).toBeTruthy();
  });
});



/* Loop 193 — Mist estate rogues + audit multi-select bulk bars. */
describe('Mist estate rogues bulk (Loop 193)', () => {
  it('shows bulk bar: Export selected, Copy BSSIDs, Copy selection link, Clear', async () => {
    const createObjectURL = vi.fn(() => 'blob:mist-rogues-selected');
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });

    mockGetMist.mockResolvedValue(demoData());
    stubOpsFetch();
    renderScreen();

    const table = await screen.findByRole('grid', { name: 'Mist rogue and neighbor APs' });
    expect(screen.queryByRole('region', { name: 'Mist rogue selection actions' })).toBeNull();

    const first = table.querySelector('tbody tr') as HTMLElement;
    expect(first).toBeTruthy();
    first.focus();
    fireEvent.keyDown(first, { key: 'x' });

    const bar = await screen.findByRole('region', { name: 'Mist rogue selection actions' });
    expect(within(bar).getByText('1 SELECTED')).toBeTruthy();

    fireEvent.click(within(bar).getByRole('button', { name: 'Export selected' }));
    expect(await screen.findByText(/Exported 1 selected rogue/)).toBeTruthy();
    expect(createObjectURL).toHaveBeenCalled();

    fireEvent.click(within(bar).getByRole('button', { name: 'Copy BSSIDs' }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(String(writeText.mock.calls[0]![0])).toMatch(/:/);

    writeText.mockClear();
    fireEvent.click(within(bar).getByRole('button', { name: 'Copy selection link' }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    const url = decodeURIComponent(String(writeText.mock.calls[0]![0]));
    expect(url).toMatch(/bssids=/);
    expect(url).toMatch(/section=rogues/);

    fireEvent.click(within(bar).getByRole('button', { name: 'Clear' }));
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: 'Mist rogue selection actions' })).toBeNull(),
    );
  });
});

describe('Mist audit log bulk (Loop 193)', () => {
  it('shows bulk bar: Export selected, Copy admins, Copy selection link, Clear', async () => {
    const createObjectURL = vi.fn(() => 'blob:mist-audit-selected');
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });

    mockGetMist.mockResolvedValue(demoData());
    stubOpsFetch({ audit: AUDIT });
    renderScreen();

    const table = await screen.findByRole('grid', { name: 'Mist org audit log' });
    expect(screen.queryByRole('region', { name: 'Mist audit selection actions' })).toBeNull();

    const first = table.querySelector('tbody tr') as HTMLElement;
    expect(first).toBeTruthy();
    first.focus();
    fireEvent.keyDown(first, { key: 'x' });

    const bar = await screen.findByRole('region', { name: 'Mist audit selection actions' });
    expect(within(bar).getByText('1 SELECTED')).toBeTruthy();

    fireEvent.click(within(bar).getByRole('button', { name: 'Export selected' }));
    expect(await screen.findByText(/Exported 1 selected audit entry/)).toBeTruthy();
    expect(createObjectURL).toHaveBeenCalled();

    fireEvent.click(within(bar).getByRole('button', { name: 'Copy admins' }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(String(writeText.mock.calls[0]![0])).toMatch(/@/);

    writeText.mockClear();
    fireEvent.click(within(bar).getByRole('button', { name: 'Copy selection link' }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    const url = decodeURIComponent(String(writeText.mock.calls[0]![0]));
    expect(url).toMatch(/auditIds=/);
    expect(url).toMatch(/section=audit/);

    fireEvent.click(within(bar).getByRole('button', { name: 'Clear' }));
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: 'Mist audit selection actions' })).toBeNull(),
    );
  });

  /* Loop 235 — audit bulk Copy messages beside Copy admins. */
  it('Loop 235 Copy messages joins unique audit messages from the selection', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });

    const entries = [
      AUDIT.entries![0]!,
      {
        ...AUDIT.entries![0]!,
        id: 'log-loop235-dup',
        admin: 'other@example.com',
      },
      AUDIT.entries![1]!,
    ];
    mockGetMist.mockResolvedValue(demoData());
    stubOpsFetch({ audit: { ...AUDIT, entries } });
    renderScreen();

    const table = await screen.findByRole('grid', { name: 'Mist org audit log' });
    const rows = table.querySelectorAll('tbody tr');
    expect(rows.length).toBeGreaterThanOrEqual(3);
    for (let i = 0; i < 3; i++) {
      (rows[i] as HTMLElement).focus();
      fireEvent.keyDown(rows[i] as HTMLElement, { key: 'x' });
    }

    const bar = await screen.findByRole('region', { name: 'Mist audit selection actions' });
    expect(within(bar).getByRole('button', { name: 'Copy messages' })).toBeTruthy();
    fireEvent.click(within(bar).getByRole('button', { name: 'Copy messages' }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    const text = String(writeText.mock.calls[0]![0]);
    expect(text.split('\n').sort()).toEqual(
      [AUDIT.entries![0]!.message, AUDIT.entries![1]!.message].sort(),
    );
    expect(await screen.findByText(/Copied 2 messages/)).toBeTruthy();
  });
});

/* Loop 198 — keyboard shortcuts help on Mist estate tables. */
describe('Mist Loop 198 residuals', () => {
  it('exposes keyboard shortcuts help on the Mist header', async () => {
    mockGetMist.mockResolvedValue(demoData());
    stubOpsFetch();
    renderScreen();
    expect(await screen.findByRole('heading', { name: 'Mist' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Keyboard shortcuts' })).toBeTruthy();
  });
});

/* Loop 204 — Mist WLANs filtered empty Clear filters CTA. */
describe('Mist Loop 204 residuals', () => {
  it('offers Clear filters when the WLANs q filter matches nothing', async () => {
    const payload = demoData();
    expect(payload.wlans && payload.wlans.length).toBeGreaterThan(0);
    const firstName = payload.wlans![0]!.name;
    mockGetMist.mockResolvedValue(payload);
    stubOpsFetch();
    renderScreen('/mist?section=wlans&q=zzzz-no-match');

    expect(
      await screen.findByText(/Nothing matches this WLAN filter/i),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(await screen.findAllByText(firstName)).toBeTruthy();
  });
});

/* Loop 211 — Mist rogues/WLANs selection-empty Clear selection filter CTAs. */
describe('Mist Loop 211 residuals', () => {
  it('offers Clear selection filter when rogues bssids deep link matches nothing', async () => {
    const payload = demoData();
    expect(payload.rogues && payload.rogues.length).toBeGreaterThan(0);
    const firstSsid = payload.rogues!.find((r) => r.ssid)?.ssid ?? 'FREE-CLINIC-WIFI';
    mockGetMist.mockResolvedValue(payload);
    stubOpsFetch();
    renderScreen(`/mist?section=rogues&bssids=${encodeURIComponent('aa:bb:cc:dd:ee:ff')}`);

    expect(
      await screen.findByText(/No rogue BSSIDs match the selection deep link/i),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Clear selection filter' }));
    expect(await screen.findByRole('grid', { name: 'Mist rogue and neighbor APs' })).toBeTruthy();
    expect(await screen.findAllByText(firstSsid)).toBeTruthy();
  });

  it('offers Clear selection filter when WLANs names deep link matches nothing', async () => {
    const payload = demoData();
    expect(payload.wlans && payload.wlans.length).toBeGreaterThan(0);
    const firstName = payload.wlans![0]!.name;
    mockGetMist.mockResolvedValue(payload);
    stubOpsFetch();
    renderScreen(`/mist?section=wlans&names=${encodeURIComponent('missing-ssid')}`);

    expect(
      await screen.findByText(/No Mist WLANs match the selection deep link/i),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Clear selection filter' }));
    expect(await screen.findByRole('grid', { name: 'Mist WLANs' })).toBeTruthy();
    expect(await screen.findAllByText(firstName)).toBeTruthy();
  });
});

/* Loop 213 — Mist audit selection-empty Clear selection filter CTA. */
describe('Mist Loop 213 residuals', () => {
  it('offers Clear selection filter when auditIds deep link matches nothing', async () => {
    mockGetMist.mockResolvedValue(demoData());
    stubOpsFetch({ audit: AUDIT });
    const entries = AUDIT.entries ?? [];
    expect(entries.length).toBeGreaterThan(0);
    const firstMessage = entries[0]!.message;
    renderScreen(`/mist?section=audit&auditIds=${encodeURIComponent('log-missing-zzz')}`);

    expect(
      await screen.findByText(/No audit entries match the selection deep link/i),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Clear selection filter' }));
    expect(await screen.findByRole('grid', { name: 'Mist org audit log' })).toBeTruthy();
    expect(await screen.findByText(firstMessage)).toBeTruthy();
    expect(screen.queryByText(/No audit entries match the selection deep link/i)).toBeNull();
  });
});

/* Loop 217 — Mist firmware/licences selection-empty Clear selection filter CTAs. */
describe('Mist Loop 217 residuals', () => {
  it('offers Clear selection filter when firmware serials deep link matches nothing', async () => {
    const devices = [
      {
        ...DEVICES.find((d) => d.plane === 'MIST')!,
        name: 'ap-behind-a',
        serial: 'MST-BEHIND-A',
        firmware: '0.13.18',
        firmwareApproved: false as const,
        firmwareTarget: '0.14.29',
      },
      {
        ...DEVICES.find((d) => d.plane === 'MIST')!,
        name: 'ap-behind-b',
        serial: 'MST-BEHIND-B',
        firmware: '0.13.18',
        firmwareApproved: false as const,
        firmwareTarget: '0.14.29',
      },
    ];
    mockGetMist.mockResolvedValue(demoData({ devices }));
    stubOpsFetch();
    const { container } = renderScreen(
      `/mist?section=devices&serials=${encodeURIComponent('serial-missing-zzz')}`,
    );
    expect(await screen.findByText('No firmware rows match this selection')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Clear selection filter' }));
    const table = await waitFor(() => {
      const el = container.querySelector(
        '[aria-label="Mist firmware behind recommended trains"]',
      ) as HTMLElement | null;
      if (!el) throw new Error('Mist firmware table missing');
      return el;
    });
    expect(await within(table).findByText('ap-behind-a')).toBeTruthy();
    expect(within(table).getByText('ap-behind-b')).toBeTruthy();
    expect(screen.queryByText('No firmware rows match this selection')).toBeNull();
    expect(screen.queryByRole('group', { name: 'Selection deep link' })).toBeNull();
  });

  it('offers Clear selection filter when licence siteIds deep link matches nothing', async () => {
    const payload = demoData();
    expect(payload.licenseUsages && payload.licenseUsages.length).toBeGreaterThan(0);
    mockGetMist.mockResolvedValue(payload);
    stubOpsFetch();
    const { container } = renderScreen(
      `/mist?section=licenses&siteIds=${encodeURIComponent('site-missing-zzz')}`,
    );
    expect(await screen.findByText('No licence rows match this selection')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Clear selection filter' }));
    const table = await waitFor(() => {
      const el = container.querySelector('[aria-label="Mist licence usage"]') as HTMLElement | null;
      if (!el) throw new Error('Mist licence table missing');
      return el;
    });
    expect(within(table).getByText(payload.licenseUsages![0]!.siteName)).toBeTruthy();
    expect(screen.queryByText('No licence rows match this selection')).toBeNull();
    expect(screen.queryByRole('group', { name: 'Selection deep link' })).toBeNull();
  });
});

/* Loop 225 — firmware bulk Copy names (non-selection-empty residual). */
describe('Mist Loop 225 residuals', () => {
  it('Copy names joins unique firmware device names from the selection', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    const devices = DEVICES.filter((d) => d.plane === 'MIST').map((d) =>
      d.name === 'ap-3f-14' ? { ...d, serial: 'MST-BEHIND-1' } : d,
    );
    const withBehind = devices.some((d) => d.firmwareApproved === false && d.firmwareTarget)
      ? devices
      : [
          {
            ...DEVICES.find((d) => d.plane === 'MIST')!,
            name: 'ap-behind-loop225',
            serial: 'MST-BEHIND-225',
            firmware: '0.13.18',
            firmwareApproved: false as const,
            firmwareTarget: '0.14.29',
            firmwareUpdate: 'inprogress',
          },
          ...devices,
        ];

    mockGetMist.mockResolvedValue(demoData({ devices: withBehind }));
    stubOpsFetch();
    const { container } = renderScreen();

    expect(await screen.findByText('behind → 0.14.29')).toBeTruthy();

    const table = await waitFor(() => {
      const el = container.querySelector(
        '[aria-label="Mist firmware behind recommended trains"]',
      ) as HTMLElement | null;
      if (!el) throw new Error('Mist firmware table missing');
      return el;
    });
    const first = table.querySelector('tbody tr') as HTMLElement;
    expect(first).toBeTruthy();
    first.focus();
    fireEvent.keyDown(first, { key: 'x' });

    const bar = await screen.findByRole('region', { name: 'Mist firmware selection actions' });
    fireEvent.click(within(bar).getByRole('button', { name: 'Copy names' }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    const text = String(writeText.mock.calls[0]![0] ?? '');
    expect(text.trim().length).toBeGreaterThan(0);
    expect(text).not.toMatch(/serials=/);
    expect(await screen.findByText(/Copied \d+ name/)).toBeTruthy();
  });
});

/* Loop 234 — estate rogues bulk Copy names (SSIDs beside Copy BSSIDs). */
describe('Mist Loop 234 residuals', () => {
  it('Copy names joins unique rogue SSIDs from the selection', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    mockGetMist.mockResolvedValue(demoData());
    stubOpsFetch();
    renderScreen();

    const table = await screen.findByRole('grid', { name: 'Mist rogue and neighbor APs' });
    const first = table.querySelector('tbody tr') as HTMLElement;
    expect(first).toBeTruthy();
    first.focus();
    fireEvent.keyDown(first, { key: 'x' });

    const bar = await screen.findByRole('region', { name: 'Mist rogue selection actions' });
    expect(within(bar).getByRole('button', { name: 'Copy names' })).toBeTruthy();
    fireEvent.click(within(bar).getByRole('button', { name: 'Copy names' }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    const text = String(writeText.mock.calls[0]![0] ?? '');
    expect(text.trim().length).toBeGreaterThan(0);
    expect(text).not.toMatch(/bssids=/);
    expect(text).not.toMatch(/5c:5b:35/i);
    expect(await screen.findByText(/Copied \d+ name/)).toBeTruthy();
  });
});
