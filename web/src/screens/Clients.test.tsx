import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Clients from './Clients';
import { SettingsProvider } from '../app/SettingsContext';
import { ToastProvider } from '../nightdesk';
import { getClientDetail, getClients, getSettings, getSiteTopology, getTickets } from '../api/client';
import type { ClientDetailLive, ClientRow, SiteTopologyLive } from '../../../shared';

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
  return {
    ...actual,
    getClients: vi.fn(),
    getSettings: vi.fn(),
    getTickets: vi.fn(),
    blockClient: vi.fn(),
    disconnectClient: vi.fn(),
    /* The on-demand per-object reads the drawer issues while it is open. */
    getClientDetail: vi.fn(),
    getSiteTopology: vi.fn(),
  };
});

const mockGetClients = vi.mocked(getClients);
const mockGetSettings = vi.mocked(getSettings);
const mockGetTickets = vi.mocked(getTickets);
const mockGetClientDetail = vi.mocked(getClientDetail);
const mockGetSiteTopology = vi.mocked(getSiteTopology);

const SPARSE_LIVE_CLIENT: ClientRow = {
  name: '3c:a9:ab:7c:a9:51',
  model: 'unknown',
  type: 'unknown',
  mac: '3c:a9:ab:7c:a9:51',
  ip: '192.168.1.89',
  medium: 'wireless',
  siteId: 'multiple',
  siteName: 'SecureSSID',
  group: '—',
  attach: 'LR655',
  where: 'aruba-home',
  plane: 'CENTRAL',
  planeTone: 'accent',
  auth: '—',
  authBy: '—',
  role: '—',
  vlan: '200',
  health: 'good',
  healthTone: 'success',
  session: '99h 59m',
  problem: false,
  link: '—',
  rssi: '—',
  snr: '—',
  retries: '—',
  tput: '—',
  roams: '—',
  quality: null,
  zone: '—',
  closet: '—',
};

const DETAIL_AT = '2026-07-28T15:00:00';

/** A stationary client: Central answered, and the trail is genuinely empty. */
const EMPTY_TRAIL_DETAIL: ClientDetailLive = {
  mac: '3c:a9:ab:7c:a9:51',
  rssi: null,
  roams: 0,
  roamsWindowSec: 86_400,
  timeline: [],
  source: {
    plane: 'central',
    at: DETAIL_AT,
    sections: { rssi: 'empty', roams: 'empty', timeline: 'empty' },
  },
};

/** A roaming client: every section came back with values. */
const FULL_DETAIL: ClientDetailLive = {
  mac: '3c:a9:ab:7c:a9:51',
  rssi: -58,
  tput: 12_400_000,
  tputWindowSec: 10_800,
  roams: 3,
  roamsWindowSec: 86_400,
  timeline: [
    {
      ts: '2026-07-28T14:05:00',
      kind: 'roam',
      detail: 'roamed LR655 → Office-655, 5 GHz ch 157E',
      device: 'Office-655',
      band: '5 GHz',
      channel: '157E',
      rssiDbm: -58,
      wlan: 'aruba-home',
    },
  ],
  source: {
    plane: 'central',
    at: DETAIL_AT,
    sections: { rssi: 'ok', tput: 'ok', roams: 'ok', timeline: 'ok' },
  },
};

/** The live tenant's own graph, trimmed to the three nodes on this path. */
const SITE_TOPOLOGY: SiteTopologyLive = {
  siteId: 'multiple',
  nodes: [
    {
      serial: 'PHQHKZ21HK', name: 'LR655', type: 'Access Point',
      deviceFunction: 'Campus Access Point', status: 'ONLINE', health: 'Good',
      healthReason: null, model: 'AP-655', ipv4: '10.11.154.51', mac: '54:d7:e3:c5:ba:47',
      internet: false,
    },
    {
      serial: 'SG30LMR164', name: 'CX6300-CORE', type: 'Switch',
      deviceFunction: 'Access Switch', status: 'ONLINE', health: 'Good',
      healthReason: null, model: 'CX-6300M', ipv4: '10.11.154.1', mac: '4c:d5:87:32:c0:80',
      internet: false,
    },
    {
      serial: 'CNJDKLB03G', name: 'SS_9004_Gateway', type: 'Gateway',
      deviceFunction: 'Mobility GW', status: 'ONLINE', health: 'Good',
      healthReason: null, model: 'A9004', ipv4: '192.168.1.7', mac: '20:4c:03:82:04:c2',
      internet: false,
    },
  ],
  links: [
    {
      from: 'SG30LMR164', to: 'PHQHKZ21HK',
      fromPorts: [{ name: '1/1/16' }], toPorts: [{ name: 'eth0' }],
      speedBps: 5_000_000_000, health: 'Good',
    },
    {
      from: 'SG30LMR164', to: 'CNJDKLB03G',
      fromPorts: [{ name: '1/1/20' }], toPorts: [{ name: 'GE 0/0/1' }],
      speedBps: 1_000_000_000, health: 'Good',
    },
  ],
  source: { plane: 'central', at: DETAIL_AT, sections: { nodes: 'ok', links: 'ok' } },
};

/** The drawer only — the table behind it repeats Site/Group/LR655 as columns. */
function drawer() {
  return within(screen.getByRole('dialog'));
}

/** The muted line under one Experience metric — label, value, then note. */
function metricNoteFor(label: string): string {
  return drawer().getByText(label).parentElement?.lastElementChild?.textContent ?? '';
}

function renderDrawer(mac = '3c:a9:ab:7c:a9:51') {
  return render(
    <MemoryRouter initialEntries={[`/clients?mac=${encodeURIComponent(mac)}`]}>
      <ToastProvider>
        <SettingsProvider>
          <Clients />
        </SettingsProvider>
      </ToastProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  /* Nothing fetched unless a test says so — the drawer must be honest about
     an absent detail read, not silently blank. */
  mockGetClientDetail.mockResolvedValue(null);
  mockGetSiteTopology.mockResolvedValue(null);
  mockGetSettings.mockResolvedValue({
    density: 'compact',
    inventoryView: 'Unified table',
    showPlatformTags: true,
    workspaceName: 'SecureSSID',
    pollIntervalSec: 60,
  });
  mockGetTickets.mockResolvedValue({ tickets: [], dataSource: 'live' });
  mockGetClients.mockResolvedValue({
    stats: [],
    clients: [SPARSE_LIVE_CLIENT],
    dataSource: 'live',
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('Clients live sparse detail', () => {
  it('shows unavailable metrics honestly instead of a zero failure score or demo derivations', async () => {
    render(
      <MemoryRouter initialEntries={['/clients?mac=3c%3Aa9%3Aab%3A7c%3Aa9%3A51']}>
        <ToastProvider>
          <SettingsProvider>
            <Clients />
          </SettingsProvider>
        </ToastProvider>
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText('PARTIAL PLANE METRICS')).toBeTruthy());
    expect(screen.getByText('NOT REPORTED')).toBeTruthy();
    expect(screen.getByText(/CENTRAL reports health as “good” but did not provide a numeric experience score/)).toBeTruthy();
    expect(screen.queryByText('0 / 100')).toBeNull();
    expect(screen.queryByText(/effectively unusable/)).toBeNull();
    expect(screen.getByText('VLAN 200')).toBeTruthy();
    expect(screen.getByText(/will not substitute the demo topology/)).toBeTruthy();
    expect(screen.getByText(/will not substitute the demo timeline/)).toBeTruthy();
  });

  it('counts only the sessions the poller returned — no fixture estate total', async () => {
    render(
      <MemoryRouter initialEntries={['/clients']}>
        <ToastProvider>
          <SettingsProvider>
            <Clients />
          </SettingsProvider>
        </ToastProvider>
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText('1 of 1 sampled')).toBeTruthy());
    expect(screen.queryByText(/4,982 live sessions/)).toBeNull();
  });

  it('marks a session whose source plane is behind as unverified, not as health', async () => {
    mockGetClients.mockResolvedValue({
      stats: [],
      clients: [{ ...SPARSE_LIVE_CLIENT, health: 'unverified', healthTone: 'neutral' }],
      syncedAt: '2026-07-26T09:05:00',
      dataSource: 'live',
    });
    render(
      <MemoryRouter initialEntries={['/clients?mac=3c%3Aa9%3Aab%3A7c%3Aa9%3A51']}>
        <ToastProvider>
          <SettingsProvider>
            <Clients />
          </SettingsProvider>
        </ToastProvider>
      </MemoryRouter>,
    );

    // Row-level marker, count line, and the drawer all name the behind plane.
    await waitFor(() => expect(screen.getByText('CENTRAL behind')).toBeTruthy());
    expect(screen.getByText('1 of 1 sampled · 1 unverified')).toBeTruthy();
    expect(screen.getByText(/CENTRAL is behind, so this session was not re-confirmed/)).toBeTruthy();
    // …and the freshness stamp says when the rows were pulled.
    expect(screen.getByText('SYNCED 09:05')).toBeTruthy();
  });

  it('prints one VLAN label for a demo row that already carries the prefix', async () => {
    mockGetClients.mockResolvedValue({
      stats: [],
      clients: [{ ...SPARSE_LIVE_CLIENT, vlan: 'vlan 820' }],
      dataSource: 'demo',
    });
    render(
      <MemoryRouter initialEntries={['/clients?mac=3c%3Aa9%3Aab%3A7c%3Aa9%3A51']}>
        <ToastProvider>
          <SettingsProvider>
            <Clients />
          </SettingsProvider>
        </ToastProvider>
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText('VLAN 820')).toBeTruthy());
    expect(screen.queryByText('VLAN vlan 820')).toBeNull();
  });

  it('keeps the authored estate total for a demo-sourced section', async () => {
    mockGetClients.mockResolvedValue({
      stats: [],
      clients: [SPARSE_LIVE_CLIENT],
      dataSource: 'demo',
    });
    render(
      <MemoryRouter initialEntries={['/clients']}>
        <ToastProvider>
          <SettingsProvider>
            <Clients />
          </SettingsProvider>
        </ToastProvider>
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText('1 of 1 sampled · 4,982 live sessions')).toBeTruthy());
  });
});

/**
 * The distinction the whole pass turns on: a field the plane HAS NO CONCEPT OF
 * versus a field the plane models and did not report this poll. Central places
 * a client by SITE — its client schema has siteId/siteName and no zone and no
 * per-client config group — so a Zone row showing "—" reads as "Central failed
 * to tell us", which is a lie about the plane's data model.
 */
describe('Clients drawer — plane field support', () => {
  it('shows the site and drops the zone/group rows Central does not model', async () => {
    renderDrawer();

    await waitFor(() => expect(screen.getByText('Where it is')).toBeTruthy());
    const d = drawer();
    // The site is what Central actually places a client by, and it is rendered.
    expect(d.getByText('Site')).toBeTruthy();
    expect(d.getAllByText('SecureSSID').length).toBeGreaterThan(0);
    // No Zone/Group row at all — and therefore no dash implying a failed read.
    expect(d.queryByText('Zone')).toBeNull();
    expect(d.queryByText('Group')).toBeNull();
    // Exactly the rows Central can answer — zone and group are gone, so nothing
    // in this section blames Central for a field it never had.
    expect(
      d.getAllByText(/^(Site|Zone|Group|Attached to|Wiring)$/).map((el) => el.textContent),
    ).toEqual(['Site', 'Attached to', 'Wiring']);
    // Said once, in the plane's own terms, underneath the rows.
    expect(d.getByText('Central places clients by site, not zone.')).toBeTruthy();
    expect(
      d.getByText('Central places clients by site — a client carries no config group.'),
    ).toBeTruthy();
  });

  it('keeps the row and says "not reported" for a plane that does model the field', async () => {
    mockGetClients.mockResolvedValue({
      stats: [],
      clients: [{ ...SPARSE_LIVE_CLIENT, plane: 'AOS-8', planeTone: 'info' }],
      dataSource: 'live',
    });
    renderDrawer();

    // AOS-8 has zones and groups, so a blank one is a poll-level absence and
    // the row must stay — naming the plane is honest here, not a smear.
    await waitFor(() => expect(screen.getByText('Zone')).toBeTruthy());
    const d = drawer();
    expect(d.getByText('Zone')).toBeTruthy();
    expect(d.getByText('Group')).toBeTruthy();
    expect(d.getAllByText('not reported by AOS-8').length).toBeGreaterThan(0);
    expect(d.queryByText(/places clients by site/)).toBeNull();
  });

  it('explains a wired session’s radio metrics instead of blaming the plane', async () => {
    mockGetClients.mockResolvedValue({
      stats: [],
      clients: [{ ...SPARSE_LIVE_CLIENT, medium: 'wired', attach: 'CX6300-CORE', where: '1/1/17' }],
      dataSource: 'live',
    });
    renderDrawer();

    // A wired link has no radio: signal, SNR, retries and roams are not things
    // Central failed to report, they are things the link cannot have.
    await waitFor(() => expect(drawer().getByText('wired link')).toBeTruthy());
    expect(metricNoteFor('Signal')).toBe('wired link');
    expect(metricNoteFor('SNR')).toBe('not applicable to wired links');
    expect(metricNoteFor('Retries')).toBe('not applicable to wired links');
    expect(metricNoteFor('Roams')).toBe('not applicable to wired links');
    // Throughput is a figure Central does model for a wired client, so its
    // absence stays "not reported" — the distinction is the whole point.
    expect(metricNoteFor('Throughput')).toBe('not reported by CENTRAL');
  });

  it('renders an authored demo zone and group verbatim — demo parity is not provenance', async () => {
    mockGetClients.mockResolvedValue({
      stats: [],
      clients: [{ ...SPARSE_LIVE_CLIENT, zone: 'Ward 3B', group: 'ward-clinical', closet: 'IDF 3-B' }],
      dataSource: 'demo',
    });
    renderDrawer();

    await waitFor(() => expect(screen.getByText('Ward 3B')).toBeTruthy());
    const d = drawer();
    expect(d.getByText('Zone')).toBeTruthy();
    expect(d.getByText('ward-clinical — config group')).toBeTruthy();
    expect(d.queryByText(/places clients by site/)).toBeNull();
  });
});

describe('Clients drawer — on-demand detail read', () => {
  it('renders signal, throughput and roams from the detail read, labelled as the plane means them', async () => {
    mockGetClientDetail.mockResolvedValue(FULL_DETAIL);
    renderDrawer();

    await waitFor(() => expect(screen.getByText('−58 dBm')).toBeTruthy());
    expect(screen.getByText('12.4 Mbps')).toBeTruthy();
    // Central reports usage over a window, never an instantaneous rate.
    expect(screen.getByText('avg over 3h')).toBeTruthy();
    expect(screen.getByText('3')).toBeTruthy();
    expect(screen.getByText('in the last 24h')).toBeTruthy();
    expect(screen.queryByText('current rate')).toBeNull();
    // …and the event the trail carried.
    expect(screen.getByText('roamed LR655 → Office-655, 5 GHz ch 157E')).toBeTruthy();
    expect(screen.getByText('1 EVENT · CENTRAL')).toBeTruthy();
    expect(screen.getByText(/ROAM · Office-655 · aruba-home · 5 GHz · ch 157E · −58 dBm/)).toBeTruthy();
  });

  it('labels the window the plane actually sampled, not a rounded fiction', async () => {
    // The live tenant returns 37 five-minute samples = 11,100s of usage.
    mockGetClientDetail.mockResolvedValue({
      ...FULL_DETAIL,
      tput: 26.757_477_477_477_476,
      tputWindowSec: 11_100,
    });
    renderDrawer();

    await waitFor(() => expect(screen.getByText('avg over 3h 5m')).toBeTruthy());
    expect(screen.getByText('27 bps')).toBeTruthy();
  });

  it('says an empty trail is empty, not that no source reported events', async () => {
    mockGetClientDetail.mockResolvedValue(EMPTY_TRAIL_DETAIL);
    renderDrawer();

    await waitFor(() => expect(screen.getByText('NO EVENTS IN 24H')).toBeTruthy());
    expect(
      screen.getByText(
        /CENTRAL answered for this client and reported no roaming or session events in the last 24h\. That is an empty result, not a failed read\./,
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/will not substitute the demo timeline/)).toBeNull();
    // A stationary client: 0 roams and no signal sample are answers, not gaps.
    expect(screen.getAllByText('no roaming in the last 24h').length).toBeGreaterThan(0);
    expect(screen.getByText('no signal sample in the last 24h')).toBeTruthy();
  });

  it('keeps the honest empty state when the read fails', async () => {
    mockGetClientDetail.mockResolvedValue({
      mac: '3c:a9:ab:7c:a9:51',
      source: {
        plane: 'central',
        at: DETAIL_AT,
        sections: { timeline: 'failed' },
        note: 'Central token refresh failed',
      },
    });
    renderDrawer();

    await waitFor(() => expect(screen.getByText('SESSION READ FAILED')).toBeTruthy());
    expect(
      screen.getByText(/The session read did not complete — Central token refresh failed\./),
    ).toBeTruthy();
  });

  it('draws the path to the internet from the plane’s own site graph', async () => {
    mockGetSiteTopology.mockResolvedValue(SITE_TOPOLOGY);
    renderDrawer();

    await waitFor(() => expect(drawer().getByText('CX6300-CORE')).toBeTruthy());
    const d = drawer();
    expect(d.getByText('LR655')).toBeTruthy();
    expect(d.getByText('SS_9004_Gateway')).toBeTruthy();
    expect(d.getByText('4 HOPS · ALL HEALTHY · CENTRAL TOPOLOGY')).toBeTruthy();
    // Segment facts are the link's own ports and speed, not invented wiring.
    expect(d.getByText(/eth0 → 1\/1\/16 · 5.0 Gbps/)).toBeTruthy();
    expect(d.getByText(/1\/1\/20 → GE 0\/0\/1 · 1.0 Gbps/)).toBeTruthy();
    // Central reports internet=false on every node, so the chain stops at the
    // gateway and says so instead of drawing an internet hop nobody reported.
    expect(
      screen.getByText(
        "CENTRAL's site graph ends at SS_9004_Gateway — it does not report the upstream internet path.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText('Internet')).toBeNull();
  });

  it('will not guess an uplink for a client the site graph does not place', async () => {
    mockGetSiteTopology.mockResolvedValue({
      ...SITE_TOPOLOGY,
      nodes: SITE_TOPOLOGY.nodes?.filter((n) => n.name !== 'LR655'),
    });
    renderDrawer();

    await waitFor(() => expect(screen.getByText('ATTACH POINT NOT ON GRAPH')).toBeTruthy());
    expect(
      screen.getByText(
        /CENTRAL returned the site graph but does not place LR655 on it, so the portal will not guess this client's uplink\./,
      ),
    ).toBeTruthy();
  });

  it('does not issue a detail read for a demo-sourced drawer', async () => {
    mockGetClients.mockResolvedValue({
      stats: [],
      clients: [SPARSE_LIVE_CLIENT],
      dataSource: 'demo',
    });
    renderDrawer();

    await waitFor(() => expect(screen.getByText('Where it is')).toBeTruthy());
    expect(mockGetClientDetail).not.toHaveBeenCalled();
    expect(mockGetSiteTopology).not.toHaveBeenCalled();
  });

  it('reads each object once per drawer visit, not once per render', async () => {
    mockGetClientDetail.mockResolvedValue(FULL_DETAIL);
    mockGetSiteTopology.mockResolvedValue(SITE_TOPOLOGY);
    renderDrawer();

    await waitFor(() => expect(screen.getByText('12.4 Mbps')).toBeTruthy());
    await waitFor(() => expect(drawer().getByText('CX6300-CORE')).toBeTruthy());
    // One read per object per drawer visit — never on the 60s poll timer.
    expect(mockGetClientDetail).toHaveBeenCalledTimes(1);
    expect(mockGetClientDetail).toHaveBeenCalledWith('3c:a9:ab:7c:a9:51');
    expect(mockGetSiteTopology).toHaveBeenCalledTimes(1);
    expect(mockGetSiteTopology).toHaveBeenCalledWith('multiple');
  });
});
