import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useParams } from 'react-router-dom';
import SiteDetail from './SiteDetail';
import { SettingsProvider } from '../app/SettingsContext';
import { ToastProvider } from '../nightdesk';
import { getSettings, getSiteDetail } from '../api/client';
import type { SiteDetailData } from '../api/client';
import { SITE_PROFILES } from '@hpe/shared';
import type { SiteRow, SiteTopologyLive, TopologyDeviceNode } from '@hpe/shared';

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

function topologyNode(
  serial: string,
  name: string,
  type: string,
  deviceFunction: string,
): TopologyDeviceNode {
  return {
    serial,
    name,
    type,
    deviceFunction,
    status: 'ONLINE',
    health: 'Good',
    healthReason: null,
    model: type === 'Switch' ? 'CX-6300M' : type === 'Gateway' ? 'A9004' : 'AP-655',
    ipv4: null,
    mac: null,
    internet: false,
  };
}

const LIVE_TOPOLOGY: SiteTopologyLive = {
  siteId: 'SecureSSID',
  nodes: [
    topologyNode('SW', 'CX6300-CORE', 'Switch', 'Access Switch'),
    topologyNode('GW', 'SS_9004_Gateway', 'Gateway', 'Mobility GW'),
    ...Array.from({ length: 7 }, (_, index) =>
      topologyNode(`AP${index}`, `AP-${index + 1}`, 'Access Point', 'Campus Access Point'),
    ),
    { ...topologyNode('U1', 'Room 525', 'Unmanaged', '-'), health: null, model: null, internet: null },
    { ...topologyNode('U2', '20:4c:03:ff:61:e2', 'Unmanaged', '-'), health: null, model: null, internet: null },
  ],
  links: ['GW', 'AP0', 'AP1', 'AP2', 'AP3', 'AP4', 'AP5', 'AP6', 'U1', 'U2'].map(
    (to, index) => ({
      from: 'SW',
      to,
      fromPorts: [{ name: `1/1/${index + 1}` }],
      toPorts: [{ name: to === 'GW' ? 'GE 0/0/1' : 'eth0' }],
      speedBps: index === 0 ? 1_000_000_000 : 5_000_000_000,
      health: 'Good',
    }),
  ),
  source: {
    plane: 'central',
    at: '2026-07-29T06:47:26.761Z',
    sections: { nodes: 'ok', links: 'ok' },
    cached: false,
  },
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
    expect(screen.getAllByText('NOT REPORTED').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/will not substitute the demo site profile/)).toBeTruthy();
    expect(screen.queryByText('No data — plane not linked')).toBeNull();
  });

  it('renders an ok 11-node/10-link live topology instead of NOT REPORTED', async () => {
    mockGetSiteDetail.mockResolvedValue({
      site: LIVE_SITE,
      profile: null,
      dataSource: 'live',
      topology: LIVE_TOPOLOGY,
      devices: [
        {
          name: 'CX6300-CORE',
          model: 'CX-6300M',
          plane: 'CENTRAL',
          planeTone: 'accent',
          role: 'access switch',
          state: 'up',
          stateTone: 'success',
          uptime: '—',
        },
      ],
    } as SiteDetailData);

    renderDetail();

    await waitFor(() => expect(screen.getByText('11 NODES · 10 LINKS · CENTRAL')).toBeTruthy());
    expect(screen.getAllByText('CX6300-CORE').length).toBeGreaterThan(0);
    expect(screen.getAllByText('SS_9004_Gateway').length).toBeGreaterThan(0);
    expect(screen.getByText('Reported physical links')).toBeTruthy();
    expect(screen.getAllByText(/1\/1\/1 ↔ GE 0\/0\/1 · 1.0 Gbps/).length).toBeGreaterThan(0);
    expect(screen.getByText(/physical adjacency, not traffic direction or internet routing/)).toBeTruthy();
    expect(screen.queryByText('READ FAILED')).toBeNull();
    expect(screen.queryByText('EMPTY')).toBeNull();
  });

  /* Everything the diagram said about a device it said in red: the status dot
     is aria-hidden and the card border is a colour. A screen reader got
     nothing, and neither did anyone who cannot tell that red from the green
     on the card beside it. */
  it('gives a down device words, not only a colour', async () => {
    mockGetSiteDetail.mockResolvedValue({
      site: LIVE_SITE,
      profile: null,
      dataSource: 'live',
      topology: {
        ...LIVE_TOPOLOGY,
        nodes: [
          { ...topologyNode('SW', 'CX6300-CORE', 'Switch', 'Access Switch'), status: 'OFFLINE', health: 'Poor' },
          topologyNode('AP0', 'AP-1', 'Access Point', 'Campus Access Point'),
        ],
        links: [],
      },
      devices: [
        {
          name: 'CX6300-CORE',
          model: 'CX-6300M',
          plane: 'CENTRAL',
          planeTone: 'accent',
          role: 'access switch',
          state: 'down',
          stateTone: 'danger',
          uptime: '—',
        },
      ],
    } as unknown as SiteDetailData);

    renderDetail();

    await waitFor(() => expect(screen.getAllByText('CX6300-CORE').length).toBeGreaterThan(0));
    // On the card, beside the dot that was carrying this alone.
    expect(screen.getAllByText('offline').length).toBeGreaterThan(0);
    // And in the name the button gives a screen reader.
    expect(screen.getAllByLabelText('Open device CX6300-CORE, offline').length).toBeGreaterThan(0);
    // An ONLINE device is the ordinary case and still says nothing.
    expect(screen.queryByText('online')).toBeNull();
  });

  /* A drawn graph is read as "this is the site". Central volunteers
   * `isolatedDevicesCount` — devices it holds for the site and could not place
   * — and the adapter has always parsed it; nothing rendered it, so a site
   * whose plane said twelve were unplaced drew the rest and called it the
   * topology. */
  it('says when the plane could not place devices on the graph', async () => {
    mockGetSiteDetail.mockResolvedValue({
      site: LIVE_SITE,
      profile: null,
      dataSource: 'live',
      topology: { ...LIVE_TOPOLOGY, isolatedDevicesCount: 12, isolatedHealth: 'Poor' },
      devices: [],
    } as unknown as SiteDetailData);

    renderDetail();

    await waitFor(() =>
      expect(screen.getByText('This diagram is not the whole graph the plane reported')).toBeTruthy(),
    );
    expect(screen.getByText(/could not place 12 devices on this graph/)).toBeTruthy();
    expect(screen.getByText(/reported health poor/)).toBeTruthy();
    // Not "a site with no such devices" — the counts above the diagram stop
    // reading as an inventory of the estate.
    expect(screen.getByText(/PARTIAL · 11 NODES · 10 LINKS · CENTRAL/)).toBeTruthy();
  });

  it('says when a reported link could not be drawn because an endpoint is missing', async () => {
    mockGetSiteDetail.mockResolvedValue({
      site: LIVE_SITE,
      profile: null,
      dataSource: 'live',
      topology: {
        ...LIVE_TOPOLOGY,
        links: [
          ...(LIVE_TOPOLOGY.links ?? []),
          {
            from: 'SW',
            to: 'GHOST',
            fromPorts: [{ name: '1/1/48' }],
            toPorts: [{ name: 'uplink' }],
            speedBps: 10_000_000_000,
            health: 'Good',
          },
        ],
      },
      devices: [],
    } as unknown as SiteDetailData);

    renderDetail();

    // The link table below the diagram lists this link, so silently omitting
    // it from the picture had one read contradicting itself across two panels.
    await waitFor(() => expect(screen.getByText(/1 reported link is not drawn/)).toBeTruthy());
    expect(screen.getByText(/\(GHOST\)/)).toBeTruthy();
  });

  it('says nothing about omissions when the diagram is the whole graph', async () => {
    mockGetSiteDetail.mockResolvedValue({
      site: LIVE_SITE,
      profile: null,
      dataSource: 'live',
      topology: { ...LIVE_TOPOLOGY, isolatedDevicesCount: 0 },
      devices: [],
    } as unknown as SiteDetailData);

    renderDetail();

    await waitFor(() => expect(screen.getByText('11 NODES · 10 LINKS · CENTRAL')).toBeTruthy());
    expect(screen.queryByText('This diagram is not the whole graph the plane reported')).toBeNull();
  });

  it('keeps empty, failed, and cached topology outcomes distinct', async () => {
    mockGetSiteDetail.mockResolvedValue({
      site: LIVE_SITE,
      profile: null,
      dataSource: 'live',
      topology: {
        siteId: 'SecureSSID',
        nodes: [],
        links: [],
        source: {
          plane: 'central',
          at: '2026-07-29T06:47:26.761Z',
          sections: { nodes: 'empty', links: 'empty' },
        },
      },
    } as SiteDetailData);
    const first = renderDetail();
    await waitFor(() => expect(screen.getByText('EMPTY')).toBeTruthy());
    expect(screen.getByText(/answered for this site and reported no topology nodes or links/)).toBeTruthy();

    first.unmount();
    mockGetSiteDetail.mockResolvedValue({
      site: LIVE_SITE,
      profile: null,
      dataSource: 'live',
      topology: {
        siteId: 'SecureSSID',
        source: {
          plane: 'central',
          at: '2026-07-29T06:47:26.761Z',
          sections: { nodes: 'failed', links: 'failed' },
          note: 'topology: HTTP 503',
        },
      },
    } as SiteDetailData);
    renderDetail();
    await waitFor(() => expect(screen.getByText('READ FAILED')).toBeTruthy());
    expect(screen.getByText(/topology: HTTP 503/)).toBeTruthy();

    cleanup();
    mockGetSiteDetail.mockResolvedValue({
      site: LIVE_SITE,
      profile: null,
      dataSource: 'live',
      topology: { ...LIVE_TOPOLOGY, source: { ...LIVE_TOPOLOGY.source, cached: true } },
    } as SiteDetailData);
    renderDetail();
    await waitFor(() => expect(screen.getByText('11 NODES · 10 LINKS · CACHED')).toBeTruthy());
    expect(screen.getByText(/Cached read from/)).toBeTruthy();
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

  it('renders the derived Local reachability block when the route sends one', async () => {
    mockGetSiteDetail.mockResolvedValue({
      site: LIVE_SITE,
      profile: null,
      dataSource: 'live',
      reachability: {
        collector: 'healthy',
        collectorTone: 'success',
        reachValue: 64,
        collectorNote: '9 of 14 devices at this site are claimed by the collector.',
        core: 'sw-edge-3',
      },
    } as SiteDetailData);

    renderDetail();

    await waitFor(() => expect(screen.getByText('Local reachability')).toBeTruthy());
    expect(screen.getByText('SSH collector')).toBeTruthy();
    expect(screen.getByText('healthy')).toBeTruthy();
    expect(screen.getByText('64%')).toBeTruthy();
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('64');
    expect(screen.getByText('9 of 14 devices at this site are claimed by the collector.')).toBeTruthy();
    // Reachability is now reported, so only topology stays unreported.
    expect(screen.queryByText(/collector reachability for this site/)).toBeNull();
    expect(screen.getByText('Topology')).toBeTruthy();
    // The route's own LOCAL-claimed target drives the terminal, even though no
    // device row was sent for the name heuristic to match.
    fireEvent.click(screen.getByRole('button', { name: 'Local terminal' }));
    await waitFor(() => expect(screen.getByText('device page sw-edge-3')).toBeTruthy());
  });

  it('reads an unknown answering share as — rather than drawing a 0% bar', async () => {
    mockGetSiteDetail.mockResolvedValue({
      site: LIVE_SITE,
      profile: null,
      dataSource: 'live',
      reachability: {
        collector: 'not linked',
        collectorTone: 'neutral',
        reachValue: null,
        collectorNote: 'No local collector is linked, so no device answers directly.',
      },
    } as SiteDetailData);

    renderDetail();

    await waitFor(() => expect(screen.getByText('Local reachability')).toBeTruthy());
    expect(screen.getByText('not linked')).toBeTruthy();
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(screen.queryByText('0%')).toBeNull();
    // No target was sent, so no terminal is offered against a guess.
    expect(screen.queryByRole('button', { name: /^Open terminal on / })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Local terminal' })).toBeNull();
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

  it('offers no Local terminal on an authored profile whose core was hidden', async () => {
    // withoutHiddenDemoDevices() blanks profile.core when the authored core is
    // one of the operator's hidden demo devices. A button pointing at it would
    // open a device page the demo inventory no longer serves.
    const profile = SITE_PROFILES['campus-01']!;
    mockGetSiteDetail.mockResolvedValue({
      site: { ...LIVE_SITE, id: 'campus-01', name: 'Campus-01 — Meridian HQ' },
      profile: { ...profile, core: '', devices: profile.devices.filter((d) => d.name !== profile.core) },
      dataSource: 'demo',
    });

    renderDetail('/sites/campus-01');

    await waitFor(() => expect(screen.getByText('Site facts')).toBeTruthy());
    expect(screen.queryByRole('button', { name: 'Local terminal' })).toBeNull();
    // The reachability panel drops its own hand-off for the same reason.
    expect(screen.queryByRole('button', { name: /^Open terminal on / })).toBeNull();
    // The rest of the panel still renders — only the dead control is gone.
    expect(screen.getByText('Local reachability')).toBeTruthy();
    expect(screen.getByText('SSH collector')).toBeTruthy();
  });

  it('keeps the Local terminal hand-off while the authored profile still names a core', async () => {
    const profile = SITE_PROFILES['campus-01']!;
    mockGetSiteDetail.mockResolvedValue({
      site: { ...LIVE_SITE, id: 'campus-01', name: 'Campus-01 — Meridian HQ' },
      profile,
      dataSource: 'demo',
    });

    renderDetail('/sites/campus-01');

    await waitFor(() => expect(screen.getByText('Site facts')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Local terminal' }));
    await waitFor(() => expect(screen.getByText(`device page ${profile.core}`)).toBeTruthy());
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
