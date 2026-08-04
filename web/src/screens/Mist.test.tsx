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
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../nightdesk';
import Mist from './Mist';
import { getMist } from '../api/client';
import type { MistData } from '../api/client';
import { pathForView, viewForPath } from '../app/nav';
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

function renderScreen() {
  return render(
    <MemoryRouter>
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
    const sleSection = screen.getByText('Wireless experience across sites').closest('div')!.parentElement!;
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
    const firmwareLabel = await screen.findByText('Firmware');
    const firmwareSection = firmwareLabel.closest('div')!.parentElement!;
    const behind = await within(firmwareSection).findByText('ap-3f-14');
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
