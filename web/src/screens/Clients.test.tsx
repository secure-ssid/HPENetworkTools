import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Clients from './Clients';
import { SettingsProvider } from '../app/SettingsContext';
import { ToastProvider } from '../nightdesk';
import { getClientDetailBlock, getClients, getSettings, getSiteApplications, getSiteTopology, getTickets } from '../api/client';
import type { ClientDetailBlock } from '../api/client';
import { CLIENTS, SITE_APPLICATIONS_DEMO } from '@hpe/shared';
import type { ClientDetailLive, ClientPlaneSection, ClientRow, SiteApplicationsLive, SiteTopologyLive } from '@hpe/shared';

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
    getClientDetailBlock: vi.fn(),
    getSiteTopology: vi.fn(),
    getSiteApplications: vi.fn(),
  };
});

const mockGetClients = vi.mocked(getClients);
const mockGetSettings = vi.mocked(getSettings);
const mockGetTickets = vi.mocked(getTickets);
const mockGetClientDetailBlock = vi.mocked(getClientDetailBlock);
const mockGetSiteTopology = vi.mocked(getSiteTopology);
const mockGetSiteApplications = vi.mocked(getSiteApplications);

/**
 * Resolve the block mock as though the route attached only this detail
 * payload (or planes block) — the 360 sections a test does not exercise read
 * as "the route did not say", never as an empty array.
 */
function mockBlock(
  detail: ClientDetailLive | null,
  clientPlanes: ClientDetailBlock['clientPlanes'] = null,
): void {
  mockGetClientDetailBlock.mockResolvedValue(detail === null && clientPlanes === null ? null : { detail, clientPlanes });
}

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

function renderDrawer(mac = '3c:a9:ab:7c:a9:51', diagnostics = true) {
  return render(
    <MemoryRouter
      future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
      initialEntries={[`/clients?mac=${encodeURIComponent(mac)}${diagnostics ? '&diagnostics=1' : ''}`]}
    >
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
  mockBlock(null);
  mockGetSiteTopology.mockResolvedValue(null);
  /* The 360's Central site-DPI line: a test that does not exercise it gets
     the straight "not reported" answer, never a fabricated table. */
  mockGetSiteApplications.mockResolvedValue({ kind: 'not-reported' });
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

afterEach(async () => {
  cleanup();
  // Drain the mocked detail/topology promise chain before the next test
  // installs fresh implementations.
  await Promise.resolve();
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

describe('Clients live sparse detail', () => {
  it('shows unavailable metrics honestly instead of a zero failure score or demo derivations', async () => {
    render(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }} initialEntries={['/clients?mac=3c%3Aa9%3Aab%3A7c%3Aa9%3A51&diagnostics=1']}>
        <ToastProvider>
          <SettingsProvider>
            <Clients />
          </SettingsProvider>
        </ToastProvider>
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText('PARTIAL PLANE METRICS')).toBeTruthy());
    // The quality score AND the 360 panel (whose read this mock leaves
    // unanswered) both honestly say NOT REPORTED here.
    expect(screen.getAllByText('NOT REPORTED').length).toBeGreaterThan(0);
    expect(screen.getByText(/CENTRAL reports health as “good” but did not provide a numeric experience score/)).toBeTruthy();
    expect(screen.queryByText('0 / 100')).toBeNull();
    expect(screen.queryByText(/effectively unusable/)).toBeNull();
    expect(screen.getByText('VLAN 200')).toBeTruthy();
    expect(screen.getByText(/will not substitute the demo topology/)).toBeTruthy();
    expect(screen.getByText(/will not substitute the demo timeline/)).toBeTruthy();
  });

  it('counts only the sessions the poller returned — no fixture estate total', async () => {
    render(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }} initialEntries={['/clients']}>
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
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }} initialEntries={['/clients?mac=3c%3Aa9%3Aab%3A7c%3Aa9%3A51&diagnostics=1']}>
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

  it('states a fact every session shares once, and keeps the column as soon as one differs', async () => {
    // Three sessions on one site, one plane, all connected: those three columns
    // would be the same word thirty-nine times on a real workspace.
    const base = { ...SPARSE_LIVE_CLIENT, siteName: 'SecureSSID', plane: 'CENTRAL' as const };
    mockGetClients.mockResolvedValue({
      stats: [],
      clients: [
        { ...base, mac: 'aa:00:00:00:00:01', name: 'one' },
        { ...base, mac: 'aa:00:00:00:00:02', name: 'two' },
        { ...base, mac: 'aa:00:00:00:00:03', name: 'three' },
      ],
      dataSource: 'live',
    });
    const { unmount } = render(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }} initialEntries={['/clients']}>
        <ToastProvider>
          <SettingsProvider>
            <Clients />
          </SettingsProvider>
        </ToastProvider>
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText('3 of 3 sampled')).toBeTruthy());
    const heads = () => screen.queryAllByRole('columnheader').map((el) => el.textContent);
    expect(heads()).not.toContain('Site');
    expect(screen.getByText(/^Same on all 3 sessions:/)).toBeTruthy();
    expect(screen.getByText(/Site SecureSSID/)).toBeTruthy();
    unmount();

    // Move one session to another site and the column earns its width back.
    mockGetClients.mockResolvedValue({
      stats: [],
      clients: [
        { ...base, mac: 'aa:00:00:00:00:01', name: 'one' },
        { ...base, mac: 'aa:00:00:00:00:02', name: 'two' },
        { ...base, mac: 'aa:00:00:00:00:03', name: 'three', siteName: 'Riverside' },
      ],
      dataSource: 'live',
    });
    render(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }} initialEntries={['/clients']}>
        <ToastProvider>
          <SettingsProvider>
            <Clients />
          </SettingsProvider>
        </ToastProvider>
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText('3 of 3 sampled')).toBeTruthy());
    // Sortable headers carry the sort mark — strip it for the label check.
    const headerLabels = screen
      .queryAllByRole('columnheader')
      .map((el) => (el.textContent ?? '').replace(/[↕▲▼]/g, ''));
    expect(headerLabels).toContain('Site');
    expect(screen.queryByText(/Site SecureSSID ·/)).toBeNull();
  });

  it('prints one VLAN label for a demo row that already carries the prefix', async () => {
    mockGetClients.mockResolvedValue({
      stats: [],
      clients: [{ ...SPARSE_LIVE_CLIENT, vlan: 'vlan 820' }],
      dataSource: 'demo',
    });
    render(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }} initialEntries={['/clients?mac=3c%3Aa9%3Aab%3A7c%3Aa9%3A51&diagnostics=1']}>
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
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }} initialEntries={['/clients']}>
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

  it('shows Ethernet session facts instead of wireless radio metrics for a wired client', async () => {
    mockGetSiteTopology.mockResolvedValue(SITE_TOPOLOGY);
    mockGetClients.mockResolvedValue({
      stats: [],
      clients: [{
        ...SPARSE_LIVE_CLIENT,
        medium: 'wired',
        attach: 'CX6300-CORE',
        where: '1/1/17',
        auth: '802.1X',
      }],
      dataSource: 'live',
    });
    renderDrawer();

    await waitFor(() => expect(drawer().getByText('Switch port')).toBeTruthy());
    const d = drawer();
    expect(d.getByText('1/1/17')).toBeTruthy();
    expect(d.getByText('VLAN')).toBeTruthy();
    expect(d.getByText('200')).toBeTruthy();
    expect(d.getByText('Session')).toBeTruthy();
    expect(d.getByText('Authentication')).toBeTruthy();
    expect(d.getByText('802.1X')).toBeTruthy();
    expect(d.queryByText('Signal')).toBeNull();
    expect(d.queryByText('SNR')).toBeNull();
    expect(d.queryByText('Retries')).toBeNull();
    expect(d.queryByText('Roams')).toBeNull();
    expect(d.queryByText('Session timeline')).toBeNull();
    expect(metricNoteFor('Throughput')).toBe('not reported by CENTRAL');
    // The site graph physically connects this switch to an Aruba gateway, but
    // that does not prove this wired session routes through it. Preserve the
    // separately known third-party physical wording instead of inventing an
    // internet path through the nearest managed gateway.
    // The switch name is already present as the Switch port note. Wait for the
    // distinct topology control instead of racing getByText between one and
    // two legitimate matches as the async site graph lands.
    await waitFor(() =>
      expect(d.getByRole('button', { name: 'CX6300-CORE' })).toBeTruthy(),
    );
    expect(d.getAllByText('CX6300-CORE')).toHaveLength(2);
    expect(d.queryByText('SS_9004_Gateway')).toBeNull();
    expect(
      d.getByText(/does not infer that this session routes through a managed gateway/),
    ).toBeTruthy();
    expect(d.getByText(/9400 → 6300 → OPNsense/)).toBeTruthy();
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
    mockBlock(FULL_DETAIL);
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

  /* The mobility trail arrives as ONE page. The drawer draws a roam count and
     an event list from it, and both used to be stated as though the page were
     the whole 24h window — a client that roamed 340 times read `100`, which is
     the page size and looks exactly like a real count of 100. */
  it('writes a roam count the plane never stated as the floor it is', async () => {
    mockBlock({
      ...FULL_DETAIL,
      roams: 100,
      roamsAtLeast: true,
      timelineTruncated: true,
    });
    renderDrawer();

    await waitFor(() => expect(screen.getByText('100+')).toBeTruthy());
    expect(screen.getByText(/at least — CENTRAL stated no total, so one page was counted/)).toBeTruthy();
    // The list carries the same caveat in its own words: its length is a fact
    // about the page, not about the window.
    expect(screen.getByText('NEWEST 1 EVENT · CENTRAL')).toBeTruthy();
  });

  it('leaves an exact count unqualified even when the list beside it is short', async () => {
    // The two claims are independent: a stated total fixes the count and still
    // proves the list is missing rows. Qualifying the count here would be its
    // own dishonesty.
    mockBlock({
      ...FULL_DETAIL,
      roams: 340,
      roamsAtLeast: false,
      timelineTruncated: true,
    });
    renderDrawer();

    await waitFor(() => expect(screen.getByText('340')).toBeTruthy());
    expect(screen.queryByText('340+')).toBeNull();
    expect(screen.queryByText(/at least —/)).toBeNull();
    expect(screen.getByText('NEWEST 1 EVENT · CENTRAL')).toBeTruthy();
  });

  it('says nothing extra when nothing was cut off', async () => {
    mockBlock(FULL_DETAIL);
    renderDrawer();

    await waitFor(() => expect(screen.getByText('3')).toBeTruthy());
    expect(screen.queryByText(/at least —/)).toBeNull();
    expect(screen.getByText('1 EVENT · CENTRAL')).toBeTruthy();
  });

  it('labels the window the plane actually sampled, not a rounded fiction', async () => {
    // The live tenant returns 37 five-minute samples = 11,100s of usage.
    mockBlock({
      ...FULL_DETAIL,
      tput: 26.757_477_477_477_476,
      tputWindowSec: 11_100,
    });
    renderDrawer();

    await waitFor(() => expect(screen.getByText('avg over 3h 5m')).toBeTruthy());
    expect(screen.getByText('27 bps')).toBeTruthy();
  });

  /* The average is the shape of every complaint that brings someone to this
     drawer and the one number that hides it: a client that saturated its radio
     for five minutes and did nothing for the next three hours averages out to
     almost nothing. Central sends the buckets; only the average was drawn. */
  it('says how busy the busiest sample was, not only the average', async () => {
    mockBlock({
      ...FULL_DETAIL,
      tputWindowSec: 900, // three 5-minute buckets
      usageSeries: [
        { ts: '2026-07-28T14:00:00Z', txBytes: 1_000, rxBytes: 1_000 },
        { ts: '2026-07-28T14:05:00Z', txBytes: 10_000_000, rxBytes: 90_000_000 },
        { ts: '2026-07-28T14:10:00Z', txBytes: 2_000, rxBytes: 2_000 },
      ],
    });
    renderDrawer();

    // 100 MB in one 300s bucket = 2.7 Mbps, against an average two orders
    // smaller. Worded as the busiest sample, because a bucket rate is itself
    // an average and Central never measured an instantaneous peak.
    await waitFor(() => expect(screen.getByText(/busiest 5m 2\.7 Mbps/)).toBeTruthy());
    // tx and rx as the plane words them — asserting up/down would claim a
    // perspective the usage endpoint does not state.
    expect(screen.getByText(/tx 10\.0 MB \/ rx 90\.0 MB/)).toBeTruthy();
  });

  /* A bucket the plane reported with neither figure is a reading that is not
     there, and counting it as a zero would drag the busiest sample down. */
  it('skips a bucket the plane put no numbers in rather than reading it as idle', async () => {
    mockBlock({
      ...FULL_DETAIL,
      tputWindowSec: 600,
      usageSeries: [
        { ts: '2026-07-28T14:00:00Z', txBytes: null, rxBytes: null },
        { ts: '2026-07-28T14:05:00Z', txBytes: null, rxBytes: 30_000_000 },
      ],
    });
    renderDrawer();

    // 30 MB over the 300s bucket that reported, not over both.
    await waitFor(() => expect(screen.getByText(/busiest 5m 800 kbps/)).toBeTruthy());
  });

  it('adds nothing to the average when the plane sent no buckets at all', async () => {
    mockBlock(FULL_DETAIL);
    renderDrawer();

    await waitFor(() => expect(screen.getByText('avg over 3h')).toBeTruthy());
    expect(screen.queryByText(/busiest/)).toBeNull();
  });

  it('says an empty trail is empty, not that no source reported events', async () => {
    mockBlock(EMPTY_TRAIL_DETAIL);
    renderDrawer();

    await waitFor(() => expect(screen.getByText('NO EVENTS IN 24H')).toBeTruthy());
    expect(
      screen.getByText(
        /CENTRAL answered for this client and reported no roaming or session events in the last 24h\. That is an empty result, not a failed read\./,
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/will not substitute the demo timeline/)).toBeNull();
    // A stationary client: 0 roams and no signal are answers, not gaps —
    // Central's client schema has no rssi at all, only a roam-event one.
    expect(screen.getAllByText('no roaming in the last 24h').length).toBeGreaterThan(0);
    expect(screen.getByText('CENTRAL reports signal only on a roam')).toBeTruthy();
  });

  it('keeps the honest empty state when the read fails', async () => {
    mockBlock({
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

  it('renders plane topology as physical adjacency without claiming an internet path', async () => {
    mockGetSiteTopology.mockResolvedValue(SITE_TOPOLOGY);
    renderDrawer();

    await waitFor(() => expect(drawer().getByText('CX6300-CORE')).toBeTruthy());
    const d = drawer();
    expect(d.getByText('Reported network topology')).toBeTruthy();
    expect(d.getByText('LR655')).toBeTruthy();
    expect(d.getByText('SS_9004_Gateway')).toBeTruthy();
    expect(d.getByText('4 NODES · ALL HEALTHY · CENTRAL TOPOLOGY')).toBeTruthy();
    // Bidirectional connectors report physical adjacency, not traffic flow.
    expect(d.getByText(/eth0 ↔ 1\/1\/16 · 5.0 Gbps/)).toBeTruthy();
    expect(d.getByText(/1\/1\/20 ↔ GE 0\/0\/1 · 1.0 Gbps/)).toBeTruthy();
    expect(
      screen.getByText(
        'CENTRAL reports these managed-device links as physical adjacency, not traffic direction. The internet egress is not identified, and third-party routers may be absent.',
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
    expect(mockGetClientDetailBlock).not.toHaveBeenCalled();
    expect(mockGetSiteTopology).not.toHaveBeenCalled();
  });

  it('labels a roam-event signal as the plane’s own reading, not as derived', async () => {
    mockBlock(FULL_DETAIL);
    renderDrawer();

    await waitFor(() => expect(screen.getByText('−58 dBm')).toBeTruthy());
    expect(metricNoteFor('Signal')).toBe('target ≥ −67 dBm');
  });

  it('reads each object once per drawer visit, not once per render', async () => {
    mockBlock(FULL_DETAIL);
    mockGetSiteTopology.mockResolvedValue(SITE_TOPOLOGY);
    renderDrawer();

    await waitFor(() => expect(screen.getByText('12.4 Mbps')).toBeTruthy());
    await waitFor(() => expect(drawer().getByText('CX6300-CORE')).toBeTruthy());
    // One read per object per drawer visit — never on the 60s poll timer.
    expect(mockGetClientDetailBlock).toHaveBeenCalledTimes(1);
    expect(mockGetClientDetailBlock).toHaveBeenCalledWith('3c:a9:ab:7c:a9:51');
    expect(mockGetSiteTopology).toHaveBeenCalledTimes(1);
    expect(mockGetSiteTopology).toHaveBeenCalledWith('multiple');
  });
});

/**
 * The three rows Central cannot answer with a field lookup, only with a join:
 * SIGNAL (SNR + the serving radio's noise floor), RETRIES (a PER-RADIO figure —
 * Central has no per-client retries at all) and WIRING (the AP's uplink off the
 * site topology). Live evidence, tenant SecureSSID, client 00:23:a7:3d:a0:42 on
 * MBB-515: snr 48, radio 1 noise floor −97 / retries 0.51, link SG30LMR164 →
 * USHBKD50J4 on port 1/1/8.
 */
const KINDLE = '00:23:a7:3d:a0:42';

const KINDLE_CLIENT: ClientRow = {
  ...SPARSE_LIVE_CLIENT,
  name: KINDLE,
  mac: KINDLE,
  attach: 'MBB-515',
  snr: '48 dB',
  link: '2.4 GHz · 6 (20 MHz)',
};

const JOINED_DETAIL: ClientDetailLive = {
  mac: KINDLE,
  rssi: -49,
  roams: 0,
  roamsWindowSec: 86_400,
  timeline: [],
  servingRadio: {
    serial: 'USHBKD50J4',
    apName: 'MBB-515',
    radioNumber: 1,
    band: '2.4 GHz',
    channel: '6',
    noiseFloorDbm: -97,
    retries: 0.51,
    channelQuality: 98,
    channelUtilPct: null,
    clients: 5,
  },
  wiring: {
    apName: 'MBB-515',
    apSerial: 'USHBKD50J4',
    switchName: 'CX6300-CORE',
    switchSerial: 'SG30LMR164',
    port: '1/1/8',
    speedBps: 2_500_000_000,
    linkHealth: 'Good',
  },
  source: {
    plane: 'central',
    at: DETAIL_AT,
    sections: { rssi: 'ok', roams: 'empty', timeline: 'empty', servingRadio: 'ok', wiring: 'ok' },
  },
};

describe('Clients drawer — the serving-radio and topology joins', () => {
  beforeEach(() => {
    mockGetClients.mockResolvedValue({ stats: [], clients: [KINDLE_CLIENT], dataSource: 'live' });
  });

  it('renders the derived signal and says it is derived, not a plane reading', async () => {
    mockBlock(JOINED_DETAIL);
    renderDrawer(KINDLE);

    await waitFor(() => expect(drawer().getByText('−49 dBm')).toBeTruthy());
    // 48 dB SNR over a −97 dBm noise floor. One short label, no banner.
    expect(metricNoteFor('Signal')).toBe('derived from SNR + noise floor');
    expect(drawer().queryByText('CENTRAL reports signal only on a roam')).toBeNull();
  });

  /**
   * The switch and port say where the AP is patched; they say nothing about
   * whether that patch is any good. Both figures were already on the wire and
   * the drawer was dropping them, so the one screen an operator opens when a
   * corner of the building is slow withheld the plane's answer to exactly
   * that question.
   */
  it('renders the uplink speed and the plane’s verdict on the AP link', async () => {
    mockBlock(JOINED_DETAIL);
    renderDrawer(KINDLE);

    await waitFor(() => expect(drawer().getByText('CX6300-CORE · 1/1/8')).toBeTruthy());
    expect(drawer().getByText('2.5 Gbps · Good')).toBeTruthy();
  });

  // A verdict without its reason sends the operator hunting for a fault the
  // plane had already named.
  it('names the plane’s own reason for a degraded uplink', async () => {
    mockBlock({
      ...JOINED_DETAIL,
      wiring: {
        ...JOINED_DETAIL.wiring!,
        speedBps: 100_000_000,
        linkHealth: 'Poor',
        linkHealthReason: 'PORT_SPEED_MISMATCH',
      },
    });
    renderDrawer(KINDLE);

    await waitFor(() =>
      expect(drawer().getByText('100.0 Mbps · Poor (PORT_SPEED_MISMATCH)')).toBeTruthy(),
    );
  });

  // Silence would read as "the link is fine". The plane said nothing, and the
  // row says that instead of implying a verdict nobody gave.
  it('says the plane reported no uplink figures rather than leaving the row blank', async () => {
    mockBlock({
      ...JOINED_DETAIL,
      wiring: { ...JOINED_DETAIL.wiring!, speedBps: null, linkHealth: null },
    });
    renderDrawer(KINDLE);

    await waitFor(() =>
      expect(drawer().getByText(/reported no speed or health for this link/)).toBeTruthy(),
    );
  });

  it('renders retries as the serving radio’s figure, never as the client’s', async () => {
    mockBlock(JOINED_DETAIL);
    renderDrawer(KINDLE);

    await waitFor(() => expect(drawer().getByText('0.51%')).toBeTruthy());
    expect(metricNoteFor('Retries')).toBe(
      "radio 1 · 2.4 GHz on MBB-515 — the radio's, not this client's",
    );
  });

  it('renders the AP’s uplink switch and port as the wiring', async () => {
    mockBlock(JOINED_DETAIL);
    renderDrawer(KINDLE);

    await waitFor(() => expect(drawer().getByText('CX6300-CORE · 1/1/8')).toBeTruthy());
  });

  /* One member of a four-member bundle is a quarter of the link. Shutting it
     drops nothing, which reads as the diagnosis being wrong. */
  it('names every member of a bundled uplink and the LAG it belongs to', async () => {
    mockBlock({
      ...JOINED_DETAIL,
      wiring: { ...JOINED_DETAIL.wiring!, ports: ['1/1/8', '1/1/9'], lag: 'lag24' },
    });
    renderDrawer(KINDLE);

    await waitFor(() =>
      expect(drawer().getByText('CX6300-CORE · 1/1/8, 1/1/9 · lag lag24')).toBeTruthy(),
    );
  });

  it('says an AP has a second uplink rather than describing the first as the cable', async () => {
    mockBlock({
      ...JOINED_DETAIL,
      wiring: { ...JOINED_DETAIL.wiring!, otherUplinks: 1 },
    });
    renderDrawer(KINDLE);

    await waitFor(() =>
      expect(
        drawer().getByText('CX6300-CORE · 1/1/8 · +1 further uplink on the site graph'),
      ).toBeTruthy(),
    );
  });

  it('keeps the honest blank rows when the joins found nothing', async () => {
    // Same client, but no radio matched and no topology link for the AP.
    mockBlock({
      ...JOINED_DETAIL,
      rssi: null,
      servingRadio: undefined,
      wiring: undefined,
      source: {
        plane: 'central',
        at: DETAIL_AT,
        sections: { rssi: 'empty', servingRadio: 'empty', wiring: 'empty' },
      },
    });
    renderDrawer(KINDLE);

    // The read has to land first — before it does, the row is honestly blank
    // for the poll-level reason instead of the detail-level one.
    await waitFor(() =>
      expect(metricNoteFor('Signal')).toBe('CENTRAL reports signal only on a roam'),
    );
    expect(drawer().queryByText('0.51%')).toBeNull();
    expect(drawer().queryByText('CX6300-CORE · 1/1/8')).toBeNull();
    expect(metricNoteFor('Retries')).toBe('not reported by CENTRAL');
  });
});

/* A roster short by a whole plane's estate is indistinguishable from a quiet
 * one: `liveClients()` skips a plane whose pull carries no `clients` key, so
 * the rows, the counts and the Stat tiles all silently describe a smaller
 * network than the operator actually runs. */
describe('Clients missing sources', () => {
  const renderClients = () =>
    render(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <ToastProvider>
          <SettingsProvider>
            <Clients />
          </SettingsProvider>
        </ToastProvider>
      </MemoryRouter>,
    );

  it('names the planes that contributed no sessions', async () => {
    mockGetClients.mockResolvedValue({
      stats: [],
      clients: [SPARSE_LIVE_CLIENT],
      dataSource: 'live',
      missingSources: ['MIST', 'CLASSIC'],
    });
    renderClients();

    await waitFor(() =>
      expect(screen.getByText('2 linked planes contributed no sessions: MIST, CLASSIC')).toBeTruthy(),
    );
    // The counts above the table are derived from the short roster too.
    expect(screen.getByText(/absent from the roster and from the counts above/)).toBeTruthy();
  });

  it('will not present an empty roster as an empty network', async () => {
    mockGetClients.mockResolvedValue({
      stats: [],
      clients: [],
      dataSource: 'live',
      missingSources: ['CENTRAL'],
    });
    renderClients();

    await waitFor(() => expect(screen.getByText('No sessions from the planes that answered')).toBeTruthy());
    expect(screen.getByText(/CENTRAL did not answer, so sessions there are unknown rather than absent\./)).toBeTruthy();
  });

  it('stays quiet when every linked plane answered, empty or not', async () => {
    mockGetClients.mockResolvedValue({ stats: [], clients: [], dataSource: 'live', missingSources: [] });
    renderClients();

    await waitFor(() => expect(screen.getByText('No sessions from any linked plane')).toBeTruthy());
    expect(screen.queryByText(/contributed no sessions/)).toBeNull();
  });

  it('stays quiet when the route said nothing about missing sources at all', async () => {
    // An older server that never looked is not a server that looked and found
    // nothing missing; absent must not render as an empty array.
    mockGetClients.mockResolvedValue({ stats: [], clients: [], dataSource: 'live' });
    renderClients();

    await waitFor(() => expect(screen.getByText('No sessions from any linked plane')).toBeTruthy());
    expect(screen.queryByText(/contributed no sessions/)).toBeNull();
  });
});

describe('Clients unified source provenance and compact drawer', () => {
  it('shows every contributing source on demand and keeps diagnostics closed initially', async () => {
    const grouped: ClientRow = {
      ...SPARSE_LIVE_CLIENT,
      sources: [
        { plane: 'central', observedAt: '2026-08-02T10:00:00Z', stale: false, row: SPARSE_LIVE_CLIENT },
        {
          plane: 'mist',
          observedAt: '2026-08-02T09:00:00Z',
          stale: true,
          row: { ...SPARSE_LIVE_CLIENT, plane: 'MIST', health: 'unverified', healthTone: 'neutral' },
        },
      ],
    };
    mockGetClients.mockResolvedValue({ stats: [], clients: [grouped], dataSource: 'live' });
    renderDrawer('3c:a9:ab:7c:a9:51', false);

    const sources = await screen.findByRole('button', { name: /Central.*Mist.*show 2 sources/i });
    fireEvent.click(sources);
    expect(screen.getByText(/Central.*current/i)).toBeTruthy();
    expect(screen.getByText(/Mist.*unverified/i)).toBeTruthy();
    expect(screen.queryByText('Client 360')).toBeNull();
    expect(screen.queryByText('Session timeline')).toBeNull();
  });
});


/**
 * Client 360 — the cross-plane panel. Live sections ride the same ?mac=
 * envelope as the detail read; in demo mode the drawer derives them from the
 * fixtures through the SAME shared correlation the server runs, so both modes
 * are exercised here against the one implementation.
 */
describe('Clients drawer — Client 360', () => {
  const CLEARPASS_OK: ClientPlaneSection = {
    plane: 'clearpass',
    label: 'CLEARPASS',
    state: 'ok',
    endpoint: {
      id: 'ep-live-1',
      mac: '3c:a9:ab:7c:a9:51',
      description: 'Front door camera',
      ip: '192.168.1.89',
      hostname: 'cam-front-door',
      status: 'Known',
      category: 'IoT',
      family: 'Embedded',
      os: null,
      profile: 'Cameras',
      updatedAt: '2 minutes ago',
    },
    authEvents: [
      {
        time: '09:41:22',
        who: 'cam-front-door',
        mac: '3c:a9:ab:7c:a9:51',
        service: 'MRDN Wireless 802.1X',
        method: 'EAP-TLS',
        result: 'accept',
        tone: 'success',
        reason: 'Certificate valid',
        role: 'role employee',
        nas: 'LR655',
        plane: 'CLEARPASS',
      },
    ],
  };

  const LIVE_SECTIONS: ClientPlaneSection[] = [
    { plane: 'central', label: 'CENTRAL', state: 'ok', session: SPARSE_LIVE_CLIENT },
    CLEARPASS_OK,
    { plane: 'mist', label: 'MIST', state: 'empty', reason: 'no session reported for this MAC' },
    { plane: 'aos8', label: 'AOS-8', state: 'not-fetched', reason: 'plane not linked' },
    {
      plane: 'uxi',
      label: 'UXI',
      state: 'not-fetched',
      reason: 'UXI tests experience synthetically from its own sensors — it has no per-client session view',
    },
  ];

  it('renders each plane’s own answer, present sections and honest reasons alike', async () => {
    mockGetClientDetailBlock.mockResolvedValue({ detail: null, clientPlanes: LIVE_SECTIONS });
    renderDrawer();

    await waitFor(() => expect(drawer().getByText('Client 360')).toBeTruthy());
    const d = drawer();
    /* The per-plane read lands after the drawer shell does — while it is in
       flight the header says so (meta "CONTACTING PLANES…"), never a false
       NOT REPORTED. Wait for the answer itself; the remaining assertions
       read the same settled render. */
    expect(await d.findByText('2 OF 5 PLANES REPORT THIS MAC')).toBeTruthy();
    // The reporting plane's session, in its own words.
    expect(d.getByText('good · on LR655 · aruba-home · session 99h 59m')).toBeTruthy();
    // The ClearPass pair: endpoint profile, then the recent decisions list.
    expect(d.getByText(/endpoint known · cam-front-door · Embedded · profile Cameras/)).toBeTruthy();
    expect(d.getByText('recent auth decisions')).toBeTruthy();
    expect(d.getByText('09:41:22')).toBeTruthy();
    expect(d.getByText('accept')).toBeTruthy();
    expect(d.getByText(/EAP-TLS · Certificate valid/)).toBeTruthy();
    // Absent planes say why — each in its own sentence, muted rather than missing.
    expect(d.getAllByText('no session reported for this MAC').length).toBeGreaterThan(0);
    expect(d.getByText('plane not linked')).toBeTruthy();
    expect(d.getByText(/tests experience synthetically/)).toBeTruthy();
  });

  it('says the cross-plane read is in flight instead of flashing NOT REPORTED, then settles honestly', async () => {
    let resolveBlock: ((block: ClientDetailBlock | null) => void) | null = null;
    mockGetClientDetailBlock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveBlock = resolve;
        }),
    );
    renderDrawer();

    await waitFor(() => expect(drawer().getByText('Client 360')).toBeTruthy());
    const d = drawer();
    // While the read is out the header says the planes are being asked — a
    // verdict (NOT REPORTED, or a plane count) would be a claim nobody made.
    expect(d.getByText('CONTACTING PLANES…')).toBeTruthy();
    expect(d.queryByText(/No cross-plane read came back/)).toBeNull();
    expect(d.queryByText(/PLANES REPORT THIS MAC/)).toBeNull();

    // A read that comes back with nothing settles into the honest NOT
    // REPORTED — and stays there; the loading label is gone.
    await act(async () => {
      resolveBlock?.(null);
    });
    await waitFor(() => expect(d.getByText(/No cross-plane read came back/)).toBeTruthy());
    expect(d.queryByText('CONTACTING PLANES…')).toBeNull();
  });

  it('says the cross-plane read is missing when the route attached none — the rest of the drawer stands', async () => {
    // An older server (or a failed block read) attaches no clientPlanes: that
    // is "not reported", never an empty estate.
    mockGetClientDetailBlock.mockResolvedValue({ detail: null, clientPlanes: null });
    renderDrawer();

    await waitFor(() => expect(drawer().getByText('Client 360')).toBeTruthy());
    const d = drawer();
    expect(d.getAllByText('NOT REPORTED').length).toBeGreaterThan(0);
    // The block read lands a tick after the shell (the sister test above
    // waits for exactly this message) — assert the settled state, not a
    // lucky instant.
    await waitFor(() => expect(d.getByText(/No cross-plane read came back for this client/)).toBeTruthy());
    // The panel's absence does not take the rest of the drawer with it.
    expect(d.getByText('Where it is')).toBeTruthy();
    expect(d.getAllByText('SecureSSID').length).toBeGreaterThan(0);
  });

  it('demonstrates fully in demo mode from the fixtures themselves — no detail read issued', async () => {
    mockGetClients.mockResolvedValue({ stats: [], clients: CLIENTS, dataSource: 'demo' });
    renderDrawer('3c:22:fb:41:0a:19'); // the fixtures' m.okonjo

    await waitFor(() => expect(drawer().getByText('Client 360')).toBeTruthy());
    const d = drawer();
    // m.okonjo is visible from three feeds: her Mist session, Mist's SLE for
    // Campus-02, and ClearPass (endpoint record + two recent decisions).
    expect(d.getByText('2 OF 12 PLANES REPORT THIS MAC · DEMO FEED')).toBeTruthy();
    expect(d.getByText(/endpoint known · m-okonjo-ipad · iOS 17\.5 · profile Clinical staff/)).toBeTruthy();
    expect(d.getByText('site SLE 96% · Campus-02 Research')).toBeTruthy();
    expect(d.getByText(/coverage 97% · capacity 95% · roaming 96% · AP health 98% · WAN 94%/)).toBeTruthy();
    expect(d.getByText('09:41:22')).toBeTruthy();
    expect(d.getByText('08:12:03')).toBeTruthy();
    // The absent planes carry their reasons in demo too.
    expect(d.getAllByText('no session reported for this MAC').length).toBeGreaterThan(0);
    expect(d.getByText(/tests experience synthetically/)).toBeTruthy();
    // Demo fixtures are authored and complete — the 360 is derived from them,
    // never fetched.
    expect(mockGetClientDetailBlock).not.toHaveBeenCalled();
    expect(mockGetSiteTopology).not.toHaveBeenCalled();
  });
});

/**
 * The 360's Central applications line: for a Central client the drawer lazily
 * reads the SITE's DPI table (the same on-demand route the site page uses)
 * and shows its top applications inside the Central section — labelled
 * site-wide, because Central's table is not filtered to one MAC and
 * attributing it would be fabrication. Every read outcome words its own
 * sentence; a non-Central client gets no line and spends no call.
 */
describe('Clients drawer — Client 360 site applications line', () => {
  const CENTRAL_ONLY: ClientPlaneSection[] = [
    { plane: 'central', label: 'CENTRAL', state: 'ok', session: SPARSE_LIVE_CLIENT },
  ];

  async function render360() {
    mockGetClientDetailBlock.mockResolvedValue({ detail: null, clientPlanes: CENTRAL_ONLY });
    renderDrawer();
    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy());
    return drawer();
  }

  it('shows the site table’s top applications for a Central client — site-wide, and says so', async () => {
    mockGetSiteApplications.mockResolvedValue({ kind: 'ok', applications: SITE_APPLICATIONS_DEMO['campus-01']! });
    const d = await render360();
    expect(
      await d.findByText(/top applications at SecureSSID: Microsoft 365 · Epic Hyperspace · YouTube · \+9 more/),
    ).toBeTruthy();
    expect(d.getByText('site-wide DPI — Central does not filter this table to one client')).toBeTruthy();
    // Lazy on drawer open, once, keyed by the client's site.
    expect(mockGetSiteApplications).toHaveBeenCalledTimes(1);
    expect(mockGetSiteApplications).toHaveBeenCalledWith('multiple');
  });

  it('an empty site table is an honest empty, not a failure', async () => {
    const empty: SiteApplicationsLive = {
      siteId: 'multiple',
      window: { start: '2026-07-27T12:00:00.000Z', end: '2026-07-28T12:00:00.000Z' },
      apps: [],
      source: { plane: 'central', at: '2026-07-28T12:00:00.000Z', sections: { apps: 'empty' } },
    };
    mockGetSiteApplications.mockResolvedValue({ kind: 'ok', applications: empty });
    const d = await render360();
    expect(
      await d.findByText('Central reported no application traffic at SecureSSID in the window'),
    ).toBeTruthy();
    expect(d.queryByText(/top applications/)).toBeNull();
  });

  it('a failed read says so — never an empty table', async () => {
    mockGetSiteApplications.mockResolvedValue({ kind: 'failed', message: 'HTTP 500' });
    const d = await render360();
    expect(await d.findByText('the application read failed — HTTP 500')).toBeTruthy();
  });

  it('a 404 words the line as "not reported"', async () => {
    const d = await render360(); // the beforeEach default: kind 'not-reported'
    expect(await d.findByText('no application table reported for SecureSSID')).toBeTruthy();
  });

  it('a non-Central client has no line and spends no call', async () => {
    const mistClient: ClientRow = { ...SPARSE_LIVE_CLIENT, plane: 'MIST', planeTone: 'info' };
    mockGetClients.mockResolvedValue({ stats: [], clients: [mistClient], dataSource: 'live' });
    mockGetClientDetailBlock.mockResolvedValue({
      detail: null,
      clientPlanes: [{ plane: 'mist', label: 'MIST', state: 'ok', session: mistClient }],
    });
    renderDrawer();
    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy());
    const d = drawer();
    await waitFor(() => expect(d.getByText('1 OF 1 PLANES REPORT THIS MAC')).toBeTruthy());
    expect(d.queryByText(/top applications/)).toBeNull();
    expect(mockGetSiteApplications).not.toHaveBeenCalled();
  });
});


// ---------------------------------------------------------------------------
// The sessions table is a nightdesk DataTable: the column manager persists
// through SettingsContext (localStorage key 'nt-table-columns' under the
// 'clients' table id) and the rows are a keyboard grid — j/k move, Enter
// opens the client drawer (the row's one primary action), x selects, Esc
// clears, '?' lists the commands. These tests pin the wiring, not the
// mechanics — the mechanics live in nightdesk/DataTable.test.tsx.
// ---------------------------------------------------------------------------
describe('Clients table superpowers', () => {
  beforeEach(() => {
    // Plain localStorage is not reliable in this environment — stub it the
    // SettingsContext.test.tsx way, fresh per test so no config leaks.
    const values = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
      clear: () => values.clear(),
    });
  });

  function renderClients() {
    return render(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }} initialEntries={['/clients']}>
        <ToastProvider>
          <SettingsProvider>
            <Clients />
          </SettingsProvider>
        </ToastProvider>
      </MemoryRouter>,
    );
  }

  function bodyRows(container: HTMLElement): HTMLTableRowElement[] {
    return Array.from(container.querySelectorAll('tbody tr'));
  }

  it('hides and restores a column from View options, persisted to localStorage', async () => {
    const { container } = renderClients();
    await screen.findByText('1 of 1 sampled');
    expect(container.querySelector('th[data-column-key="model"]')).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'View options' }));
    // The primary identifier is not offered for hiding.
    expect(screen.getByRole('checkbox', { name: 'Client' }).hasAttribute('disabled')).toBe(true);

    fireEvent.click(screen.getByRole('checkbox', { name: 'Model' }));
    expect(container.querySelector('th[data-column-key="model"]')).toBeNull();
    expect(JSON.parse(localStorage.getItem('nt-table-columns') ?? '{}')).toEqual({
      clients: { hidden: ['model'] },
    });

    fireEvent.click(screen.getByRole('checkbox', { name: 'Model' }));
    expect(container.querySelector('th[data-column-key="model"]')).not.toBeNull();
    expect(JSON.parse(localStorage.getItem('nt-table-columns') ?? '{}')).toEqual({
      clients: { hidden: [] },
    });
  });

  it('seeds the table from the persisted column config on mount', async () => {
    localStorage.setItem(
      'nt-table-columns',
      JSON.stringify({ clients: { hidden: ['model'], order: ['health', 'client', 'model', 'type'] } }),
    );
    const { container } = renderClients();
    await screen.findByText('1 of 1 sampled');
    expect(container.querySelector('th[data-column-key="model"]')).toBeNull();
    const keys = Array.from(container.querySelectorAll('th')).map((th) => th.getAttribute('data-column-key'));
    expect(keys[0]).toBe('health');
    expect(keys[1]).toBe('client');
  });

  it('moves the focused row with j/k and opens the client drawer on Enter', async () => {
    mockGetClients.mockResolvedValue({
      stats: [],
      clients: [
        { ...SPARSE_LIVE_CLIENT, mac: 'aa:00:00:00:00:01', name: 'alpha-one' },
        { ...SPARSE_LIVE_CLIENT, mac: 'aa:00:00:00:00:02', name: 'beta-two' },
      ],
      dataSource: 'live',
    });
    const { container } = renderClients();
    await screen.findByText('2 of 2 sampled');
    const [first, second] = bodyRows(container);

    expect(first.getAttribute('tabindex')).toBe('0');
    fireEvent.keyDown(first, { key: 'j' });
    expect(document.activeElement).toBe(second);
    fireEvent.keyDown(second, { key: 'k' });
    expect(document.activeElement).toBe(first);

    // Enter runs the row's primary action: the Client 360 drawer, addressed
    // by the row's MAC — the same ?mac= deep link a row click sets.
    fireEvent.keyDown(first, { key: 'Enter' });
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('alpha-one')).toBeTruthy();
  });

  it('sorts by any header — Session by real duration, Type alphabetically', async () => {
    mockGetClients.mockResolvedValue({
      stats: [],
      clients: [
        { ...SPARSE_LIVE_CLIENT, mac: 'aa:00:00:00:00:01', name: 'c-one', type: 'laptop', session: '19m' },
        { ...SPARSE_LIVE_CLIENT, mac: 'aa:00:00:00:00:02', name: 'c-two', type: 'phone', session: '2h 14m' },
        { ...SPARSE_LIVE_CLIENT, mac: 'aa:00:00:00:00:03', name: 'c-three', type: 'tablet', session: '41d' },
      ],
      dataSource: 'live',
    });
    const { container } = renderClients();
    await screen.findByText('3 of 3 sampled');
    const firstNames = () => bodyRows(container).map((tr) => tr.textContent ?? '');

    fireEvent.click(screen.getByRole('button', { name: /Session/ })); // asc: 19m < 2h < 41d
    expect(firstNames()[0]).toContain('c-one');
    fireEvent.click(screen.getByRole('button', { name: /Session/ })); // desc: real duration, never alphabetical
    expect(firstNames()[0]).toContain('c-three');

    fireEvent.click(screen.getByRole('button', { name: /^Type/ })); // asc: laptop < phone < tablet
    expect(firstNames()[0]).toContain('c-one');
    expect(firstNames()[2]).toContain('c-three');
  });

  it('toggles row selection with x and clears it with Escape', async () => {
    const { container } = renderClients();
    await screen.findByText('1 of 1 sampled');
    const [first] = bodyRows(container);

    fireEvent.keyDown(first, { key: 'x' });
    expect(first.getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(first, { key: 'x' });
    expect(first.getAttribute('aria-selected')).toBe('false');

    fireEvent.keyDown(first, { key: 'x' });
    fireEvent.keyDown(first, { key: 'Escape' });
    expect(first.getAttribute('aria-selected')).toBe('false');
  });

  it("lists the row commands on '?'", async () => {
    renderClients();
    await screen.findByText('1 of 1 sampled');

    fireEvent.keyDown(document.body, { key: '?' });
    expect(await screen.findByRole('dialog')).toBeTruthy();
    expect(screen.getByText('Move to the next row')).toBeTruthy();
    expect(screen.getByText("Run the focused row's primary action")).toBeTruthy();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  /* Deliberate, and pinned so it stays deliberate: a session's health already
     wears its tone as a Badge and no other column has an honest threshold, so
     nothing on this table tints (the same call Devices made). */
  it('tints no cell', async () => {
    const { container } = renderClients();
    await screen.findByText('1 of 1 sampled');
    expect(container.querySelector('td[class*="nd-table__td--tint"]')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The two wired MIST clients (rsch-ws-07, bench-daq-02 — the demo answer to
// the adapter's wired_clients/search read). A wired Mist row is switch+port
// attachment, not radio telemetry: the table carries it like any session, and
// the drawer renders the Ethernet metric set with no wireless Experience
// block, no roam timeline, and the wired path out of the site chain.
// ---------------------------------------------------------------------------
describe('Clients — wired Mist rows', () => {
  const DEMO_ROSTER = { stats: [], clients: CLIENTS, dataSource: 'demo' as const };

  function renderTable() {
    return render(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }} initialEntries={['/clients']}>
        <ToastProvider>
          <SettingsProvider>
            <Clients />
          </SettingsProvider>
        </ToastProvider>
      </MemoryRouter>,
    );
  }

  it('lists the wired Mist sessions with their switch and port', async () => {
    mockGetClients.mockResolvedValue(DEMO_ROSTER);
    renderTable();

    expect(await screen.findByText('rsch-ws-07')).toBeTruthy();
    expect(screen.getByText('bench-daq-02')).toBeTruthy();
    expect(screen.getByText('port ge-0/0/8')).toBeTruthy();
    expect(screen.getByText('port ge-0/0/11')).toBeTruthy();
    // Both rows wear the Mist badge and name the switch they attach to.
    expect(screen.getAllByText('MIST').length).toBeGreaterThan(0);
    expect(screen.getAllByText('sw-cam02-1').length).toBeGreaterThan(0);
    // The medium filter offers the wired slice these rows belong to.
    expect(screen.getByLabelText('Medium')).toBeTruthy();
  });

  it('opens the demo drawer on the Ethernet facts, with nothing wireless drawn', async () => {
    mockGetClients.mockResolvedValue(DEMO_ROSTER);
    renderDrawer('3c:52:82:1e:07:a1');

    await waitFor(() => expect(drawer().getByText('Switch port')).toBeTruthy());
    const d = drawer();
    expect(d.getByText('port ge-0/0/8')).toBeTruthy();
    expect(d.getByText('VLAN')).toBeTruthy();
    expect(d.getByText('822')).toBeTruthy();
    expect(d.getByText('Authentication')).toBeTruthy();
    expect(d.getByText('802.1X')).toBeTruthy();
    // No wireless Experience block when there is nothing wireless to report.
    expect(d.queryByText('Signal')).toBeNull();
    expect(d.queryByText('SNR')).toBeNull();
    expect(d.queryByText('Retries')).toBeNull();
    expect(d.queryByText('Roams')).toBeNull();
    expect(d.queryByText('Session timeline')).toBeNull();
    expect(d.getByText('WIRED · sw-cam02-1 · port ge-0/0/8')).toBeTruthy();
    expect(d.getByText('Wired session health is within target.')).toBeTruthy();
    // The wired path leaves from the attaching switch (campus-02's core), and
    // the Client 360 panel reports Mist's own session line for this MAC.
    expect(d.getByText('Path to the internet')).toBeTruthy();
    expect(d.getByText('DC1 border')).toBeTruthy();
    expect(d.getByText('good · on sw-cam02-1 · port ge-0/0/8 · session 6d 4h')).toBeTruthy();
    // Demo mode issues no per-object reads — the fixtures ARE the estate.
    expect(mockGetClientDetailBlock).not.toHaveBeenCalled();
    expect(mockGetSiteTopology).not.toHaveBeenCalled();
  });

  it('keeps a live wired Mist row on the same honesty rules as any wired session', async () => {
    mockGetClients.mockResolvedValue({
      stats: [],
      clients: [{
        ...SPARSE_LIVE_CLIENT,
        medium: 'wired',
        plane: 'MIST',
        planeTone: 'info',
        attach: 'sw-cam02-1',
        where: 'port ge-0/0/8',
        link: '1 Gb full duplex',
        auth: '802.1X',
      }],
      dataSource: 'live',
    });
    renderDrawer();

    await waitFor(() => expect(drawer().getByText('Switch port')).toBeTruthy());
    const d = drawer();
    expect(d.getByText('port ge-0/0/8')).toBeTruthy();
    expect(d.getByText('802.1X')).toBeTruthy();
    expect(d.queryByText('Signal')).toBeNull();
    expect(d.queryByText('Roams')).toBeNull();
    // Mist published no usage figure for this session — said, never zeroed.
    expect(metricNoteFor('Throughput')).toBe('not reported by MIST');
  });
});
