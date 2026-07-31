import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Clients from './Clients';
import { SettingsProvider } from '../app/SettingsContext';
import { ToastProvider } from '../nightdesk';
import { getClientDetail, getClients, getSettings, getSiteTopology, getTickets } from '../api/client';
import type { ClientDetailLive, ClientRow, SiteTopologyLive } from '@hpe/shared';

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
      <MemoryRouter initialEntries={['/clients']}>
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
      <MemoryRouter initialEntries={['/clients']}>
        <ToastProvider>
          <SettingsProvider>
            <Clients />
          </SettingsProvider>
        </ToastProvider>
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText('3 of 3 sampled')).toBeTruthy());
    expect(screen.queryAllByRole('columnheader').map((el) => el.textContent)).toContain('Site');
    expect(screen.queryByText(/Site SecureSSID ·/)).toBeNull();
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

  /* The mobility trail arrives as ONE page. The drawer draws a roam count and
     an event list from it, and both used to be stated as though the page were
     the whole 24h window — a client that roamed 340 times read `100`, which is
     the page size and looks exactly like a real count of 100. */
  it('writes a roam count the plane never stated as the floor it is', async () => {
    mockGetClientDetail.mockResolvedValue({
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
    mockGetClientDetail.mockResolvedValue({
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
    mockGetClientDetail.mockResolvedValue(FULL_DETAIL);
    renderDrawer();

    await waitFor(() => expect(screen.getByText('3')).toBeTruthy());
    expect(screen.queryByText(/at least —/)).toBeNull();
    expect(screen.getByText('1 EVENT · CENTRAL')).toBeTruthy();
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

  /* The average is the shape of every complaint that brings someone to this
     drawer and the one number that hides it: a client that saturated its radio
     for five minutes and did nothing for the next three hours averages out to
     almost nothing. Central sends the buckets; only the average was drawn. */
  it('says how busy the busiest sample was, not only the average', async () => {
    mockGetClientDetail.mockResolvedValue({
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
    mockGetClientDetail.mockResolvedValue({
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
    mockGetClientDetail.mockResolvedValue(FULL_DETAIL);
    renderDrawer();

    await waitFor(() => expect(screen.getByText('avg over 3h')).toBeTruthy());
    expect(screen.queryByText(/busiest/)).toBeNull();
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
    // A stationary client: 0 roams and no signal are answers, not gaps —
    // Central's client schema has no rssi at all, only a roam-event one.
    expect(screen.getAllByText('no roaming in the last 24h').length).toBeGreaterThan(0);
    expect(screen.getByText('CENTRAL reports signal only on a roam')).toBeTruthy();
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
    expect(mockGetClientDetail).not.toHaveBeenCalled();
    expect(mockGetSiteTopology).not.toHaveBeenCalled();
  });

  it('labels a roam-event signal as the plane’s own reading, not as derived', async () => {
    mockGetClientDetail.mockResolvedValue(FULL_DETAIL);
    renderDrawer();

    await waitFor(() => expect(screen.getByText('−58 dBm')).toBeTruthy());
    expect(metricNoteFor('Signal')).toBe('target ≥ −67 dBm');
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
    mockGetClientDetail.mockResolvedValue(JOINED_DETAIL);
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
    mockGetClientDetail.mockResolvedValue(JOINED_DETAIL);
    renderDrawer(KINDLE);

    await waitFor(() => expect(drawer().getByText('CX6300-CORE · 1/1/8')).toBeTruthy());
    expect(drawer().getByText('2.5 Gbps · Good')).toBeTruthy();
  });

  // A verdict without its reason sends the operator hunting for a fault the
  // plane had already named.
  it('names the plane’s own reason for a degraded uplink', async () => {
    mockGetClientDetail.mockResolvedValue({
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
    mockGetClientDetail.mockResolvedValue({
      ...JOINED_DETAIL,
      wiring: { ...JOINED_DETAIL.wiring!, speedBps: null, linkHealth: null },
    });
    renderDrawer(KINDLE);

    await waitFor(() =>
      expect(drawer().getByText(/reported no speed or health for this link/)).toBeTruthy(),
    );
  });

  it('renders retries as the serving radio’s figure, never as the client’s', async () => {
    mockGetClientDetail.mockResolvedValue(JOINED_DETAIL);
    renderDrawer(KINDLE);

    await waitFor(() => expect(drawer().getByText('0.51%')).toBeTruthy());
    expect(metricNoteFor('Retries')).toBe(
      "radio 1 · 2.4 GHz on MBB-515 — the radio's, not this client's",
    );
  });

  it('renders the AP’s uplink switch and port as the wiring', async () => {
    mockGetClientDetail.mockResolvedValue(JOINED_DETAIL);
    renderDrawer(KINDLE);

    await waitFor(() => expect(drawer().getByText('CX6300-CORE · 1/1/8')).toBeTruthy());
  });

  /* One member of a four-member bundle is a quarter of the link. Shutting it
     drops nothing, which reads as the diagnosis being wrong. */
  it('names every member of a bundled uplink and the LAG it belongs to', async () => {
    mockGetClientDetail.mockResolvedValue({
      ...JOINED_DETAIL,
      wiring: { ...JOINED_DETAIL.wiring!, ports: ['1/1/8', '1/1/9'], lag: 'lag24' },
    });
    renderDrawer(KINDLE);

    await waitFor(() =>
      expect(drawer().getByText('CX6300-CORE · 1/1/8, 1/1/9 · lag lag24')).toBeTruthy(),
    );
  });

  it('says an AP has a second uplink rather than describing the first as the cable', async () => {
    mockGetClientDetail.mockResolvedValue({
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
    mockGetClientDetail.mockResolvedValue({
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
      <MemoryRouter>
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
