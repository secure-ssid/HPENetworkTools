/**
 * web/src/screens/DeviceDetail.test.tsx — component tests for DeviceDetail.
 *
 * The api client (../api/client) and the recorded-SSH transport
 * (../lib/wsTerminal) are mocked at the module boundary — no real fetch and
 * no real WebSocket. Coverage:
 *   (a) LIVE-GAP   — live mode with only the reconciled inventory row renders
 *                    the real device facts plus honest "not available in live
 *                    mode" notes (this previously white-screened on
 *                    profile.kind).
 *   (b) LIVE 404   — device null in live mode renders the
 *                    "Device not in the live cache" empty state.
 *   (c) TRANSCRIPT RACE — clicking session A then B while A's transcript
 *                    resolves LATE leaves B's transcript shown, never A's.
 *   (d) RECONCILED IDENTITY — the inventory row the API ships alongside the
 *                    authored profile wins the header, and a flagged row says
 *                    so on both the demo and the live render.
 *   (e) LIVE RECORDINGS — recorded transcripts (and their load error) reach
 *                    the live branch, not just the demo one.
 *   (f) TERMINAL LIFECYCLE — server prompt, dead transport, recording refresh
 *                    and the reconnect affordance.
 *   (g) SERVED TERMINAL — the envelope's `terminal` banner/quickCommands are
 *                    preferred over local re-derivation, with the shared
 *                    helpers still covering a route that sent none.
 *   (h) SERVED EVIDENCE — the Compliance panel renders the route's own
 *                    per-device verdicts in both modes, and an 'unavailable'
 *                    or absent block renders a named empty state rather than
 *                    a clean scorecard.
 *   (i) SESSION ATTRIBUTION — the titlebar names the account, target and jump
 *                    host from the bridge's own 'ready' frame, outranking the
 *                    recorded-transcript match (which can lag, or belong to
 *                    another operator).
 *   (j) CLASS-AWARE PANELS — the right column's class block follows the device
 *                    CLASS, not one hardcoded panel: an AP renders Radios +
 *                    SSIDs (and never a ports panel), a switch renders Ports
 *                    with the worst far-end health first, and a class the
 *                    route served nothing for renders no panel at all. The
 *                    four read outcomes (ok / empty / failed / not-fetched)
 *                    print four different sentences, and only the last two
 *                    may mention the plane at all.
 *
 * These tests caught a real regression: the reboot hooks used to live below
 * the `if (!data)` early return, so React threw "Rendered more hooks than
 * during the previous render" on every async load. Fixed in the source —
 * the hooks now run above the guard; this suite guards against a relapse.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import DeviceDetail from './DeviceDetail';
import { SettingsProvider } from '../app/SettingsContext';
import { ToastProvider } from '../nightdesk';
import {
  getDeviceDetail,
  getTerminalSession,
  getTerminalSessions,
  getTickets,
} from '../api/client';
import type { TerminalTranscript } from '../api/client';
import { createWsTransport } from '../lib/wsTerminal';
import {
  DEVICE_CLIENT_SETS,
  DEVICE_CONFIGS,
  DEVICES,
  deviceProfile,
  deviceTerminalKind,
  terminalBanner,
  terminalQuickCommands,
} from '../../../shared';
import type {
  DeviceDetailLive,
  DeviceEvidence,
  DevicePort,
  DeviceRadio,
  DeviceWlan,
} from '../../../shared';

// ---------------------------------------------------------------------------
// jsdom shims (kept local to this file)
// ---------------------------------------------------------------------------

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

if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

// ---------------------------------------------------------------------------
// Module mocks — network at the boundary, never real fetch/WebSocket
// ---------------------------------------------------------------------------

vi.mock('../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/client')>();
  return {
    ...actual,
    getDeviceDetail: vi.fn(),
    getTerminalSession: vi.fn(),
    getTerminalSessions: vi.fn(),
    getTickets: vi.fn(),
    rebootDevice: vi.fn(),
  };
});

// The recorded-SSH bridge: always "unreachable" so the screen falls back to
// the canned transport / the live-gap note, with no real WebSocket or timers.
vi.mock('../lib/wsTerminal', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/wsTerminal')>();
  return {
    ...actual,
    createWsTransport: vi.fn(() => ({
      transport: {
        banner: () => [],
        respond: () => [],
        respondAsync: () => Promise.resolve([]),
      },
      connect: () => Promise.resolve(false),
      close: () => {},
    })),
  };
});

const mockGetDeviceDetail = vi.mocked(getDeviceDetail);
const mockGetTerminalSession = vi.mocked(getTerminalSession);
const mockGetTerminalSessions = vi.mocked(getTerminalSessions);
const mockGetTickets = vi.mocked(getTickets);
const mockCreateWsTransport = vi.mocked(createWsTransport);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderDeviceDetail(name: string) {
  return render(
    <MemoryRouter initialEntries={[`/devices/${name}`]}>
      <SettingsProvider>
        <ToastProvider>
          <Routes>
            <Route path="/devices/:name" element={<DeviceDetail />} />
          </Routes>
        </ToastProvider>
      </SettingsProvider>
    </MemoryRouter>,
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// (a) LIVE-GAP — live mode, inventory row only, no authored profile
// ---------------------------------------------------------------------------

describe('DeviceDetail — live mode with profile/config/clients gaps', () => {
  it('renders the real device facts and honest live-gap notes without throwing', async () => {
    const device = DEVICES.find((d) => d.name === 'sw-core-a');
    if (!device) throw new Error('fixture missing');
    mockGetDeviceDetail.mockResolvedValue({
      device,
      profile: null,
      config: null,
      clients: null,
      dataSource: 'live',
    });
    mockGetTerminalSessions.mockResolvedValue([]);
    mockGetTerminalSession.mockResolvedValue(null);
    mockGetTickets.mockResolvedValue({ tickets: [], dataSource: 'demo' });

    renderDeviceDetail('sw-core-a');

    // Header = the real device name (the screen used to crash before this).
    expect(await screen.findByRole('heading', { name: 'sw-core-a' })).toBeTruthy();

    // Identity facts come from the reconciled inventory row. The envelope in
    // this payload carries no syncedAt, so the header says so rather than
    // implying a fresh poll.
    expect(screen.getByText('LIVE POLLER CACHE · NO SYNC STAMP')).toBeTruthy();
    expect(screen.getAllByText('CX 8325-48Y8C').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Campus-01 HQ').length).toBeGreaterThan(0);
    expect(screen.getByText('yes — via collector')).toBeTruthy();

    // Honest notes — never fixture stand-ins. Exact strings from the source.
    expect(
      screen.getByText(
        'Not available in live mode — no linked plane reports a running config for this device.',
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(
        'Not available in live mode — no linked plane reported client sessions.',
      ),
    ).toBeTruthy();
    // This payload carried no evidence block at all, so Compliance says so —
    // an empty scorecard would read as "everything passes".
    expect(screen.getByText('No evidence for this device')).toBeTruthy();
    expect(
      screen.getByText(
        'No plane supplied evidence alongside this device, so there is nothing to score. An empty list is not a pass.',
      ),
    ).toBeTruthy();
    // localShell device, bridge mocked unreachable → the shell gap note.
    expect(
      await screen.findByText(
        'No recorded shell feed right now — the collector bridge is unreachable from this portal.',
      ),
    ).toBeTruthy();
  });

  it('renders active sessions attached to the live device', async () => {
    const device = DEVICES.find((d) => d.name === 'sw-core-a');
    if (!device) throw new Error('fixture missing');
    mockGetDeviceDetail.mockResolvedValue({
      device,
      profile: null,
      config: null,
      clients: {
        meta: '1 active session',
        rows: [
          {
            name: 'printer-3f',
            detail: 'Printer · aa:bb:cc:dd:ee:ff · 10.42.3.19 · port 1/1/8',
            state: 'good',
            tone: 'success',
          },
        ],
      },
      dataSource: 'live',
    });
    mockGetTerminalSessions.mockResolvedValue([]);
    mockGetTerminalSession.mockResolvedValue(null);
    mockGetTickets.mockResolvedValue({ tickets: [], dataSource: 'demo' });

    renderDeviceDetail('sw-core-a');

    expect(await screen.findByText('printer-3f')).toBeTruthy();
    expect(screen.getByText('1 active session')).toBeTruthy();
    expect(screen.getByText(/aa:bb:cc:dd:ee:ff/)).toBeTruthy();
    // The 'Clients now' Stat counts the same rows the section lists.
    expect(screen.getByText('from the poller snapshot')).toBeTruthy();
  });

  it('renders the cloud-claimed shell note for a device without a local shell', async () => {
    const device = DEVICES.find((d) => d.name === 'ap-3f-12');
    if (!device) throw new Error('fixture missing');
    if (device.localShell) throw new Error('fixture expected to be cloud-claimed');
    mockGetDeviceDetail.mockResolvedValue({
      device,
      profile: null,
      config: null,
      clients: null,
      dataSource: 'live',
    });
    mockGetTerminalSessions.mockResolvedValue([]);
    mockGetTerminalSession.mockResolvedValue(null);
    mockGetTickets.mockResolvedValue({ tickets: [], dataSource: 'demo' });

    renderDeviceDetail('ap-3f-12');

    expect(await screen.findByRole('heading', { name: 'ap-3f-12' })).toBeTruthy();
    expect(
      screen.getByText(
        'Cloud-claimed device — no local shell; the owning plane serves read-only telemetry only.',
      ),
    ).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// (b) LIVE 404 — device not in any linked plane's cache
// ---------------------------------------------------------------------------

describe('DeviceDetail — live mode, device not in the cache', () => {
  it('renders the "Device not in the live cache" empty state', async () => {
    mockGetDeviceDetail.mockResolvedValue({
      device: null,
      profile: null,
      config: null,
      clients: null,
      dataSource: 'live',
    });
    mockGetTerminalSessions.mockResolvedValue([]);
    mockGetTerminalSession.mockResolvedValue(null);
    mockGetTickets.mockResolvedValue({ tickets: [], dataSource: 'demo' });

    renderDeviceDetail('ghost-sw-1');

    expect(await screen.findByText('Device not in the live cache')).toBeTruthy();
    expect(
      screen.getByText(
        "No linked plane has reported 'ghost-sw-1'. It may be unmanaged, or the plane that owns it is not linked.",
      ),
    ).toBeTruthy();
    // The empty state offers a path to Connected systems.
    expect(screen.getByRole('button', { name: 'Connected systems' })).toBeTruthy();
  });

  it('blames the fixtures, not the planes, when the portal is running offline on demo data', async () => {
    // The offline fallback answers dataSource 'demo' with a null device: the
    // backend was never reached, so nothing may be attributed to a plane.
    mockGetDeviceDetail.mockResolvedValue({
      device: null,
      profile: null,
      config: null,
      clients: null,
      dataSource: 'demo',
    });
    mockGetTerminalSessions.mockResolvedValue([]);
    mockGetTerminalSession.mockResolvedValue(null);
    mockGetTickets.mockResolvedValue({ tickets: [], dataSource: 'demo' });

    renderDeviceDetail('ghost-sw-1');

    expect(await screen.findByText('Device not in the demo inventory')).toBeTruthy();
    expect(screen.queryByText(/No linked plane has reported/)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// (g) LIVE VIEW COMPLETENESS — the sections README §9 requires, each backed by
//     a field the payload really carried
// ---------------------------------------------------------------------------

describe('DeviceDetail — live view completeness', () => {
  const liveDevice = () => {
    const base = DEVICES.find((d) => d.name === 'sw-core-a');
    if (!base) throw new Error('fixture missing');
    return base;
  };

  it('renders the Stat row, the console hand-off, the class-block gap and the freshness stamp', async () => {
    mockGetDeviceDetail.mockResolvedValue({
      device: {
        ...liveDevice(),
        plane: 'CENTRAL',
        planeTone: 'accent',
        firmware: '10.09.1010',
        firmwareApproved: false,
      },
      profile: null,
      config: null,
      clients: null,
      dataSource: 'live',
      syncedAt: '2026-07-26T09:41:00',
    });
    mockGetTerminalSessions.mockResolvedValue([]);
    mockGetTerminalSession.mockResolvedValue(null);
    mockGetTickets.mockResolvedValue({ tickets: [], dataSource: 'demo' });

    renderDeviceDetail('sw-core-a');

    // Freshness: the stamp is the envelope's, rendered hhmm like every other
    // live screen (no 'Z' in the fixture, so this is timezone-independent).
    expect(await screen.findByText('LIVE POLLER CACHE · 09:41')).toBeTruthy();

    // Five Stats, all derived from the row.
    expect(screen.getByText('Claimed by')).toBeTruthy();
    expect(screen.getByText('Recorded shells')).toBeTruthy();
    expect(screen.getByText('off approved train')).toBeTruthy();

    // Firmware fact agrees with the inventory table's amber verdict.
    expect(screen.getByText('10.09.1010 — off the approved train')).toBeTruthy();

    // Design rule 4: a read-only plane still gets a console hand-off.
    expect(screen.getByRole('button', { name: 'Open in CENTRAL' })).toBeTruthy();

    // The class block declares itself missing instead of vanishing — and says
    // the portal has not read it, never that CENTRAL withheld it (Central
    // models switch interfaces; the portal simply had not asked yet).
    expect(
      screen.getByText(
        'Per-port state has not been read for this device — the portal fetches interfaces on demand, for the one device being viewed.',
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/no linked plane reports per-port state/)).toBeNull();

    // …and the clients section keeps its route out to the full list.
    expect(screen.getByRole('button', { name: 'All clients →' })).toBeTruthy();
  });

  it('offers no console hand-off for a collector-only device — there is no console', async () => {
    mockGetDeviceDetail.mockResolvedValue({
      device: { ...liveDevice(), plane: 'LOCAL', planeTone: 'neutral', claimedBy: ['LOCAL'] },
      profile: null,
      config: null,
      clients: null,
      dataSource: 'live',
    });
    mockGetTerminalSessions.mockResolvedValue([]);
    mockGetTerminalSession.mockResolvedValue(null);
    mockGetTickets.mockResolvedValue({ tickets: [], dataSource: 'demo' });

    renderDeviceDetail('sw-core-a');

    expect(await screen.findByRole('heading', { name: 'sw-core-a' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Open in / })).toBeNull();
  });

  it('marks an approved firmware train as approved', async () => {
    mockGetDeviceDetail.mockResolvedValue({
      device: { ...liveDevice(), firmware: 'FL.10.13.1005', firmwareApproved: true },
      profile: null,
      config: null,
      clients: null,
      dataSource: 'live',
    });
    mockGetTerminalSessions.mockResolvedValue([]);
    mockGetTerminalSession.mockResolvedValue(null);
    mockGetTickets.mockResolvedValue({ tickets: [], dataSource: 'demo' });

    renderDeviceDetail('sw-core-a');

    expect(await screen.findByText('FL.10.13.1005 (approved)')).toBeTruthy();
    expect(screen.queryByText(/off the approved train/)).toBeNull();
  });

  it('passes no firmware verdict when the plane reported no version', async () => {
    mockGetDeviceDetail.mockResolvedValue({
      device: { ...liveDevice(), firmware: 'unknown', firmwareApproved: false },
      profile: null,
      config: null,
      clients: null,
      dataSource: 'live',
    });
    mockGetTerminalSessions.mockResolvedValue([]);
    mockGetTerminalSession.mockResolvedValue(null);
    mockGetTickets.mockResolvedValue({ tickets: [], dataSource: 'demo' });

    renderDeviceDetail('sw-core-a');

    expect(await screen.findByRole('heading', { name: 'sw-core-a' })).toBeTruthy();
    expect(screen.queryByText(/off the approved train/)).toBeNull();
    expect(screen.getByText('no version reported')).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// (j) CLASS-AWARE DETAIL PANELS — an AP gets Radios + SSIDs, a switch gets
//     Ports, and a class with no served subresource gets no panel at all
//
//     Payloads below are the shapes verified live on the user's tenant:
//     AP735-LR (PHT5M520SZ) radios/WLANs and CX6300-CORE (SG30LMR164)
//     interfaces, normalized to the shared DeviceDetailLive contract.
// ---------------------------------------------------------------------------

describe('DeviceDetail — class-aware detail panels', () => {
  /** Attach the route's per-device detail block to an envelope — the optional
   *  field the screen reads. Payloads WITHOUT it exercise the 'not fetched'
   *  path, which is the state every device is in until the read lands. */
  const withDetail = <T extends object>(base: T, detail: DeviceDetailLive) => ({
    ...base,
    detail,
  });

  const liveBase = (deviceName: string) => {
    const device = DEVICES.find((d) => d.name === deviceName);
    if (!device) throw new Error(`fixture missing: ${deviceName}`);
    return {
      device,
      profile: null,
      config: null,
      clients: null,
      dataSource: 'live' as const,
    };
  };

  const quietDeps = () => {
    mockGetTerminalSessions.mockResolvedValue([]);
    mockGetTerminalSession.mockResolvedValue(null);
    mockGetTickets.mockResolvedValue({ tickets: [], dataSource: 'demo' });
  };

  const AP_RADIOS: DeviceRadio[] = [
    {
      number: 0,
      band: '5 GHz',
      channel: '157E',
      bandwidth: '80 MHz',
      powerDbm: 19,
      clients: 1,
      channelUtilPct: 11,
      rxUtilPct: 5,
      txUtilPct: 1,
      retries: 0,
      drops: 0,
      noiseFloorDbm: -93,
      nonWifiInterference: 5,
      channelQuality: 97,
      status: 'UP',
      mode: 'Client Access',
      macAddress: '48:00:20:27:0c:a0',
    },
    {
      number: 1,
      band: '2.4 GHz',
      channel: '11',
      bandwidth: '20 MHz',
      powerDbm: 9,
      clients: 1,
      channelUtilPct: 23,
      rxUtilPct: 18,
      txUtilPct: 0,
      retries: 0.09,
      drops: 0.09,
      noiseFloorDbm: -98,
      nonWifiInterference: 5,
      channelQuality: 97,
      status: 'UP',
      mode: 'Client Access',
      macAddress: '48:00:20:27:0c:80',
    },
    {
      number: 2,
      band: '6 GHz',
      channel: '213S',
      bandwidth: '160 MHz',
      powerDbm: 15,
      clients: 0,
      channelUtilPct: 0,
      rxUtilPct: 0,
      txUtilPct: 0,
      retries: 0,
      drops: 0,
      noiseFloorDbm: -87,
      nonWifiInterference: 0,
      channelQuality: 100,
      status: 'UP',
      mode: 'Client Access',
      macAddress: '48:00:20:27:0c:90',
    },
  ];

  const AP_WLANS: DeviceWlan[] = [
    {
      name: 'Air Pass',
      status: 'ENABLED',
      security: 'WPA3 Enterprise (CCM 128)',
      securityLevel: 'Enterprise',
      band: '5 GHz, 6 GHz',
      vlan: '200',
      clients: 0,
    },
    {
      name: 'aruba-home',
      status: 'ENABLED',
      security: 'WPA2 Personal',
      securityLevel: 'Personal',
      band: '2.4 GHz, 5 GHz',
      vlan: '200',
      clients: 25,
    },
    {
      name: 'SecureSSID',
      status: 'ENABLED',
      security: 'WPA3 Personal',
      securityLevel: 'Personal',
      band: '5 GHz, 6 GHz',
      vlan: '200',
      clients: 1,
    },
  ];

  const SWITCH_PORTS: DevicePort[] = [
    {
      name: '1/1/1',
      status: 'Not Connected',
      adminStatus: 'Up',
      operStatus: 'Down',
      speedBps: null,
      duplex: '-',
      connector: 'RJ45',
      mtu: 1500,
      vlanMode: 'Access',
      nativeVlan: 200,
      allowedVlanIds: [],
      poeStatus: 'Not Used',
    },
    {
      name: '1/1/2',
      status: 'Connected',
      adminStatus: 'Up',
      operStatus: 'Up',
      speedBps: 1_000_000_000,
      duplex: 'Full',
      connector: 'RJ45',
      mtu: 1500,
      vlanMode: 'Access',
      nativeVlan: 200,
      allowedVlanIds: [],
      poeStatus: 'Not Used',
      stpRole: 'Designated',
      stpState: 'Forwarding',
      neighbour: 'SS_9004_Gateway-LTE',
      neighbourSerial: 'CNP6L2H038',
      neighbourType: 'Gateway',
      neighbourHealth: 'Poor',
    },
    {
      name: '1/1/3',
      status: 'Connected',
      adminStatus: 'Up',
      operStatus: 'Up',
      speedBps: 5_000_000_000,
      duplex: 'Full',
      connector: 'RJ45',
      mtu: 1500,
      vlanMode: 'Trunk',
      nativeVlan: 5,
      allowedVlanIds: [5, 200],
      poeStatus: 'Drawing Watts',
      poeClass: '802.3bt Type 3 (PoE++)',
      stpRole: 'Designated',
      stpState: 'Forwarding',
      neighbour: 'Office-655',
      neighbourPort: 'eth0',
      neighbourSerial: 'PHQHKZ22X5',
      neighbourType: 'Access Point',
      neighbourHealth: 'Good',
    },
    {
      // Central answers 'Unknown' on a link it has not scored. That is not an
      // adverse verdict and must not sort next to the Poor one.
      name: '1/1/9',
      status: 'Connected',
      adminStatus: 'Up',
      operStatus: 'Up',
      speedBps: 2_500_000_000,
      duplex: 'Full',
      vlanMode: 'Trunk',
      nativeVlan: 5,
      allowedVlanIds: [5, 200],
      poeStatus: 'Drawing Watts',
      poeClass: '802.3bt Type 3 (PoE++)',
      neighbour: 'Room 525',
      neighbourType: 'Unmanaged',
      neighbourHealth: 'Unknown',
    },
  ];

  const apDetail = (
    sections: DeviceDetailLive['source']['sections'],
    rows: Partial<Pick<DeviceDetailLive, 'radios' | 'wlans'>> = {},
    note?: string,
  ): DeviceDetailLive => ({
    serial: 'PHT5M520SZ',
    kind: 'ap',
    ...rows,
    source: {
      plane: 'central',
      at: '2026-07-28T15:47:00.000Z',
      sections,
      ...(note ? { note } : {}),
    },
  });

  it('renders an AP as radios and SSIDs — never a ports panel it has no ports for', async () => {
    mockGetDeviceDetail.mockResolvedValue(
      withDetail(
        liveBase('ap-1f-04'),
        apDetail({ radios: 'ok', wlans: 'ok' }, { radios: AP_RADIOS, wlans: AP_WLANS }),
      ),
    );
    quietDeps();

    renderDeviceDetail('ap-1f-04');

    expect(await screen.findByText('Radios')).toBeTruthy();
    expect(screen.getByText('3 ON AIR')).toBeTruthy();
    expect(screen.getByText('SSIDs broadcast')).toBeTruthy();
    expect(screen.getByText('3 WLANS')).toBeTruthy();

    // An access point has no ports. The old build rendered one anyway and told
    // the operator no plane reported per-port state for it.
    expect(screen.queryByText('Ports of interest')).toBeNull();
    expect(screen.queryByText(/per-port state/i)).toBeNull();

    // Radios read lowest band first, not in Central's 1/0/2 radio order.
    const bands = screen.getAllByText(/^(2\.4|5|6) GHz$/).map((el) => el.textContent);
    expect(bands).toEqual(['2.4 GHz', '5 GHz', '6 GHz']);

    // Every number the brief asked for, per radio.
    expect(screen.getByText('ch 11 · 20 MHz · 9 dBm · Client Access')).toBeTruthy();
    expect(
      screen.getByText('1 client · util 23% · noise -98 dBm · retries 0.09% · quality 97'),
    ).toBeTruthy();
    expect(screen.getByText('ch 157E · 80 MHz · 19 dBm · Client Access')).toBeTruthy();
    expect(screen.getByText('ch 213S · 160 MHz · 15 dBm · Client Access')).toBeTruthy();
    // A zero is a reading, not a missing value — 0 clients / 0% util survive.
    expect(
      screen.getByText('0 clients · util 0% · noise -87 dBm · retries 0% · quality 100'),
    ).toBeTruthy();

    // SSIDs: name / security / band / VLAN / clients.
    expect(screen.getByText('Air Pass')).toBeTruthy();
    expect(screen.getByText('WPA3 Enterprise (CCM 128) · 5 GHz, 6 GHz · VLAN 200')).toBeTruthy();
    expect(screen.getByText('WPA2 Personal · 2.4 GHz, 5 GHz · VLAN 200')).toBeTruthy();
    expect(screen.getByText('25 clients')).toBeTruthy();
    expect(screen.getByText('1 client')).toBeTruthy();
  });

  it('renders a switch as ports, worst far-end health first, and no radio panels', async () => {
    mockGetDeviceDetail.mockResolvedValue(
      withDetail(liveBase('sw-core-a'), {
        serial: 'SG30LMR164',
        kind: 'switch',
        ports: SWITCH_PORTS,
        source: { plane: 'central', at: '2026-07-28T15:47:00.000Z', sections: { ports: 'ok' } },
      }),
    );
    quietDeps();

    renderDeviceDetail('sw-core-a');

    expect(await screen.findByText('Ports of interest')).toBeTruthy();
    // A switch has no radios and broadcasts no SSIDs.
    expect(screen.queryByText('Radios')).toBeNull();
    expect(screen.queryByText('SSIDs broadcast')).toBeNull();

    // The filter shows connected ports, and the header names the total so it
    // can never read as "this switch has three ports".
    expect(screen.getByText('3 OF 4 CONNECTED')).toBeTruthy();
    expect(screen.queryByText('1/1/1')).toBeNull();

    // The physical link to the gateway that is down sorts FIRST and carries
    // Central's own health word — this is the correlation the screen exists
    // for. An UNSCORED link ('Unknown') is not urgency and stays in port order.
    const portNames = screen.getAllByText(/^1\/1\/[0-9]$/).map((el) => el.textContent);
    expect(portNames).toEqual(['1/1/2', '1/1/3', '1/1/9']);
    expect(screen.getByText('SS_9004_Gateway-LTE · Gateway')).toBeTruthy();
    expect(screen.getByText('Poor')).toBeTruthy();
    expect(screen.getByText('1 Gb · full · Access 200 · STP Designated/Forwarding')).toBeTruthy();

    // The AP port: PoE++ on a trunk carrying VLANs 5 and 200.
    expect(screen.getByText('Office-655 eth0 · Access Point')).toBeTruthy();
    expect(
      screen.getByText(
        '5 Gb · full · Trunk 5 + 5,200 · PoE Drawing Watts · 802.3bt Type 3 (PoE++) · STP Designated/Forwarding',
      ),
    ).toBeTruthy();
  });

  it('keeps the honest empty state when the detail read failed, and names the reason', async () => {
    mockGetDeviceDetail.mockResolvedValue(
      withDetail(
        liveBase('ap-1f-04'),
        apDetail({ radios: 'failed', wlans: 'failed' }, {}, 'Central token refresh failed'),
      ),
    );
    quietDeps();

    renderDeviceDetail('ap-1f-04');

    expect(
      await screen.findByText(
        'Per-radio state could not be read from CENTRAL — Central token refresh failed',
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(
        'Broadcast SSIDs could not be read from CENTRAL — Central token refresh failed',
      ),
    ).toBeTruthy();
    // Nothing was invented to fill the panel.
    expect(screen.queryByText(/^ch \d/)).toBeNull();
  });

  it('says the plane answered with nothing when the read came back empty — that is not an error', async () => {
    mockGetDeviceDetail.mockResolvedValue(
      withDetail(
        liveBase('ap-1f-04'),
        apDetail({ radios: 'empty', wlans: 'empty' }, { radios: [], wlans: [] }),
      ),
    );
    quietDeps();

    renderDeviceDetail('ap-1f-04');

    expect(await screen.findByText('CENTRAL answered with no radios for this AP.')).toBeTruthy();
    expect(screen.getByText('CENTRAL reports no WLAN broadcast by this AP.')).toBeTruthy();
    // An empty answer is never dressed up as a failure or a missing source.
    expect(screen.queryByText(/could not be read/)).toBeNull();
    expect(screen.queryByText(/has not been read/)).toBeNull();
  });

  it('tells an AP with no detail payload that the portal has not read it — not that CENTRAL withheld it', async () => {
    mockGetDeviceDetail.mockResolvedValue(liveBase('ap-1f-04'));
    quietDeps();

    renderDeviceDetail('ap-1f-04');

    expect(
      await screen.findByText(
        'Per-radio state has not been read for this AP — the portal fetches radios on demand, for the one device being viewed.',
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(
        'Broadcast SSIDs have not been read for this AP — the portal fetches them on demand, for the one device being viewed.',
      ),
    ).toBeTruthy();
    // Rule 4: never blame the plane for a read the portal did not make.
    expect(screen.queryByText(/no linked plane reports per-port/)).toBeNull();
    expect(screen.queryByText('Ports of interest')).toBeNull();
  });

  it('gives a gateway no class block at all until the route serves one', async () => {
    mockGetDeviceDetail.mockResolvedValue(liveBase('gw-edge-1'));
    quietDeps();

    renderDeviceDetail('gw-edge-1');

    expect(await screen.findByRole('heading', { name: 'gw-edge-1' })).toBeTruthy();
    // Central serves no gateway subresource through the switch endpoint, so a
    // ports panel here would be a claim about a device class that has none.
    expect(screen.queryByText('Ports of interest')).toBeNull();
    expect(screen.queryByText('Radios')).toBeNull();
    expect(screen.queryByText('SSIDs broadcast')).toBeNull();
  });

  it('renders whatever the route DID read for a gateway, payload-driven', async () => {
    mockGetDeviceDetail.mockResolvedValue(
      withDetail(liveBase('gw-edge-1'), {
        serial: 'CNJDKLB03G',
        kind: 'gateway',
        ports: [SWITCH_PORTS[2]],
        source: { plane: 'central', at: '2026-07-28T15:47:00.000Z', sections: { ports: 'ok' } },
      }),
    );
    quietDeps();

    renderDeviceDetail('gw-edge-1');

    expect(await screen.findByText('Ports of interest')).toBeTruthy();
    expect(screen.getByText('1 OF 1 CONNECTED')).toBeTruthy();
    expect(screen.getByText('Office-655 eth0 · Access Point')).toBeTruthy();
  });

  it('reports a switch whose ports all came back down without calling it a failure', async () => {
    mockGetDeviceDetail.mockResolvedValue(
      withDetail(liveBase('sw-core-a'), {
        serial: 'SG30LMR164',
        kind: 'switch',
        ports: [SWITCH_PORTS[0]],
        source: { plane: 'central', at: '2026-07-28T15:47:00.000Z', sections: { ports: 'ok' } },
      }),
    );
    quietDeps();

    renderDeviceDetail('sw-core-a');

    expect(
      await screen.findByText(
        'None of the 1 interfaces CENTRAL reported is connected — every port is down with no neighbour discovered.',
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/could not be read/)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// (c) TRANSCRIPT RACE — stale transcript resolutions are ignored
// ---------------------------------------------------------------------------

describe('DeviceDetail — recorded session transcript race', () => {
  it('keeps the latest-clicked transcript when an earlier request resolves late', async () => {
    const profile = deviceProfile('sw-core-a');
    const device = DEVICES.find((d) => d.name === 'sw-core-a') ?? null;
    mockGetDeviceDetail.mockResolvedValue({
      device,
      profile,
      config: DEVICE_CONFIGS[profile.kind],
      clients: DEVICE_CLIENT_SETS[profile.kind],
      dataSource: 'demo',
    });
    mockGetTickets.mockResolvedValue({ tickets: [], dataSource: 'demo' });

    mockGetTerminalSessions.mockResolvedValue([
      { file: 'a.log', device: 'sw-core-a', user: 'r.okafor', target: 'sw-core-a', openedAt: '2026-07-25T09:12:00Z' },
      { file: 'b.log', device: 'sw-core-a', user: 'j.alvarez', target: 'sw-core-a', openedAt: '2026-07-25T10:40:00Z' },
    ]);

    // A's transcript resolves LATE; B's resolves immediately.
    const lateA = deferred<TerminalTranscript>();
    mockGetTerminalSession.mockImplementation((file: string) => {
      if (file === 'a.log') return lateA.promise;
      if (file === 'b.log') {
        return Promise.resolve({
          file: 'b.log',
          events: [{ type: 'out', at: '2026-07-25T10:40:01Z', text: 'B-TRANSCRIPT-OUTPUT' }],
          truncated: false,
        });
      }
      return Promise.resolve(null);
    });

    renderDeviceDetail('sw-core-a');

    // Wait for the recorded-sessions list (demo profile → shell-capable).
    const viewButtons = await screen.findAllByRole('button', { name: 'View transcript' });
    expect(viewButtons).toHaveLength(2);

    // Click A, then quickly click B — before A's transcript has resolved.
    act(() => {
      viewButtons[0].click();
      viewButtons[1].click();
    });

    // B's transcript appears.
    expect(await screen.findByText('B-TRANSCRIPT-OUTPUT')).toBeTruthy();

    // Now A's stale request resolves — it must be ignored.
    await act(async () => {
      lateA.resolve({
        file: 'a.log',
        events: [{ type: 'out', at: '2026-07-25T09:12:01Z', text: 'A-TRANSCRIPT-OUTPUT' }],
        truncated: false,
      });
    });

    await waitFor(() => {
      expect(screen.queryByText('A-TRANSCRIPT-OUTPUT')).toBeNull();
    });
    expect(screen.getByText('B-TRANSCRIPT-OUTPUT')).toBeTruthy();
    // B's row is the one offering to hide its transcript.
    expect(screen.getByRole('button', { name: 'Hide transcript' })).toBeTruthy();
  });
});

describe('DeviceDetail — live terminal lifecycle', () => {
  it('uses the server prompt, clears a dead transport, refreshes recordings, and offers reconnect', async () => {
    const profile = deviceProfile('sw-core-a');
    const device = DEVICES.find((d) => d.name === 'sw-core-a') ?? null;
    mockGetDeviceDetail.mockResolvedValue({
      device,
      profile,
      config: DEVICE_CONFIGS[profile.kind],
      clients: DEVICE_CLIENT_SETS[profile.kind],
      dataSource: 'demo',
    });
    mockGetTickets.mockResolvedValue({ tickets: [], dataSource: 'demo' });
    mockGetTerminalSession.mockResolvedValue(null);
    // Mount sees nothing on file; every refresh after that (connect, then
    // disconnect) sees the recording the bridge opened.
    mockGetTerminalSessions.mockResolvedValueOnce([]).mockResolvedValue([
      {
        file: 'new-recording.jsonl',
        device: 'sw-core-a',
        user: 'netops',
        target: '10.42.8.11',
        openedAt: '2026-07-26T22:00:00Z',
      },
    ]);

    let disconnect: ((reason: string) => void) | undefined;
    mockCreateWsTransport.mockImplementationOnce((_name, opts) => {
      disconnect = opts?.onDisconnect;
      return {
        transport: {
          banner: () => [],
          respond: () => [],
          respondAsync: () => Promise.resolve([]),
        },
        connect: async () => {
          opts?.onPrompt?.('actual-sw-core-a#');
          return true;
        },
        close: () => {},
      };
    });

    renderDeviceDetail('sw-core-a');

    expect(await screen.findByText('actual-sw-core-a#')).toBeTruthy();
    await act(async () => {
      disconnect?.('shell closed');
    });

    expect(await screen.findByRole('button', { name: 'Reconnect live terminal' })).toBeTruthy();
    expect(await screen.findByText('netops@10.42.8.11')).toBeTruthy();
    // Mount, the live connect (so the pane can name the real session), and the
    // disconnect that closes the recording.
    expect(mockGetTerminalSessions).toHaveBeenCalledTimes(3);
  });
});

describe('DeviceDetail — live session attribution', () => {
  it('names the account the live session really ran under, never the fixture operator', async () => {
    const profile = deviceProfile('sw-core-a');
    const device = DEVICES.find((d) => d.name === 'sw-core-a') ?? null;
    mockGetDeviceDetail.mockResolvedValue({
      device,
      profile,
      config: DEVICE_CONFIGS[profile.kind],
      clients: DEVICE_CLIENT_SETS[profile.kind],
      dataSource: 'demo',
    });
    mockGetTickets.mockResolvedValue({ tickets: [], dataSource: 'demo' });
    mockGetTerminalSession.mockResolvedValue(null);
    // First load: only an OLD transcript from another operator. After the
    // bridge connects, the store has the session the portal just opened.
    mockGetTerminalSessions
      .mockResolvedValueOnce([
        {
          file: 'old.jsonl',
          device: 'sw-core-a',
          user: 'someone.else',
          target: '10.42.8.11',
          openedAt: '2020-01-01T00:00:00Z',
        },
      ])
      .mockResolvedValue([
        {
          file: 'old.jsonl',
          device: 'sw-core-a',
          user: 'someone.else',
          target: '10.42.8.11',
          openedAt: '2020-01-01T00:00:00Z',
        },
        {
          file: 'now.jsonl',
          device: 'sw-core-a',
          user: 'netops',
          target: '10.42.9.7',
          openedAt: new Date().toISOString(),
        },
      ]);

    mockCreateWsTransport.mockImplementationOnce(() => ({
      transport: {
        banner: () => [],
        respond: () => [],
        respondAsync: () => Promise.resolve([]),
      },
      connect: () => Promise.resolve(true),
      close: () => {},
    }));

    renderDeviceDetail('sw-core-a');

    expect(await screen.findByText('ssh netops@10.42.9.7 — via collector')).toBeTruthy();
    // The authored demo operator and the fixture IP are gone once live…
    expect(screen.queryByText(/r\.okafor@/)).toBeNull();
    // …and the older transcript is never presented as the current connection.
    expect(screen.queryByText(/ssh someone\.else@/)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// (d) RECONCILED IDENTITY — the row is authoritative, the flag is visible
// ---------------------------------------------------------------------------

describe('DeviceDetail — reconciled identity', () => {
  it('renders the inventory row identity in the demo header, not the name-prefix fixture', async () => {
    const device = DEVICES.find((d) => d.name === 'sw-riv-2');
    if (!device) throw new Error('fixture missing');
    const profile = deviceProfile('sw-riv-2');
    // The name-prefix heuristic falls through to the CX-switch profile, which
    // is a different model, site, plane and state from the row.
    expect(profile.model).toBe('CX 8325-48Y8C');
    mockGetDeviceDetail.mockResolvedValue({
      device,
      profile,
      config: DEVICE_CONFIGS[profile.kind],
      clients: DEVICE_CLIENT_SETS[profile.kind],
      dataSource: 'demo',
    });
    mockGetTerminalSessions.mockResolvedValue([]);
    mockGetTerminalSession.mockResolvedValue(null);
    mockGetTickets.mockResolvedValue({ tickets: [], dataSource: 'demo' });

    renderDeviceDetail('sw-riv-2');

    expect(await screen.findByText(/CX 6200F-24G · Riverside Clinic/)).toBeTruthy();
    expect(screen.queryByText(/CX 8325-48Y8C · Campus-01 HQ/)).toBeNull();
    // Header badges follow the row, and the Managed-by fact follows it too.
    expect(screen.getByText('double-claimed')).toBeTruthy();
    expect(screen.getAllByText('CLASSIC').length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByText('No cloud plane — local SSH only')).toBeNull();
    expect(
      screen.getByText('Double-claimed — more than one inventory reports this device'),
    ).toBeTruthy();
  });

  it('names every claiming plane, the management IP and the identity evidence in live mode', async () => {
    const base = DEVICES.find((d) => d.name === 'sw-core-a');
    if (!base) throw new Error('fixture missing');
    mockGetDeviceDetail.mockResolvedValue({
      device: {
        ...base,
        plane: 'CENTRAL',
        planeTone: 'accent',
        claimedBy: ['CENTRAL', 'CLASSIC'],
        reconciliationIssue: true,
        ip: '10.42.8.11',
        serial: 'SG09KLM4X2',
      },
      profile: null,
      config: null,
      clients: null,
      dataSource: 'live',
    });
    mockGetTerminalSessions.mockResolvedValue([]);
    mockGetTerminalSession.mockResolvedValue(null);
    mockGetTickets.mockResolvedValue({ tickets: [], dataSource: 'demo' });

    renderDeviceDetail('sw-core-a');

    // Named in the Managed-by fact and again as the 'Claimed by' Stat delta.
    expect((await screen.findAllByText('CENTRAL + CLASSIC')).length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('2 planes')).toBeTruthy();
    expect(screen.getAllByText('10.42.8.11').length).toBeGreaterThan(0);
    expect(screen.getByText('SG09KLM4X2')).toBeTruthy();
    expect(
      screen.getByText('Double-claimed — more than one inventory reports this device'),
    ).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// (e) LIVE RECORDINGS — fetched for every device, so they must render there
// ---------------------------------------------------------------------------

describe('DeviceDetail — recorded sessions in live mode', () => {
  it('lists recorded transcripts on a live device', async () => {
    const device = DEVICES.find((d) => d.name === 'sw-core-a');
    if (!device) throw new Error('fixture missing');
    mockGetDeviceDetail.mockResolvedValue({
      device,
      profile: null,
      config: null,
      clients: null,
      dataSource: 'live',
    });
    mockGetTerminalSessions.mockResolvedValue([
      {
        file: 'live.jsonl',
        device: 'sw-core-a',
        user: 'netops',
        target: '10.42.8.11',
        openedAt: '2026-07-26T22:00:00Z',
      },
    ]);
    mockGetTerminalSession.mockResolvedValue(null);
    mockGetTickets.mockResolvedValue({ tickets: [], dataSource: 'demo' });

    renderDeviceDetail('sw-core-a');

    expect(await screen.findByText('netops@10.42.8.11')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'View transcript' })).toBeTruthy();
  });

  it('surfaces a recorded-session load failure instead of swallowing it', async () => {
    const device = DEVICES.find((d) => d.name === 'sw-core-a');
    if (!device) throw new Error('fixture missing');
    mockGetDeviceDetail.mockResolvedValue({
      device,
      profile: null,
      config: null,
      clients: null,
      dataSource: 'live',
    });
    mockGetTerminalSessions.mockRejectedValue(new Error('shell-log store unreadable'));
    mockGetTerminalSession.mockResolvedValue(null);
    mockGetTickets.mockResolvedValue({ tickets: [], dataSource: 'demo' });

    renderDeviceDetail('sw-core-a');

    expect(
      await screen.findByText(
        'Recorded sessions could not be loaded: shell-log store unreadable',
      ),
    ).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// (g) SERVED TERMINAL PAYLOAD — the route's banner/chips win over local
//     re-derivation, and the shared helpers still cover a route that sent none
// ---------------------------------------------------------------------------

describe('DeviceDetail — served terminal payload', () => {
  it('renders the banner and quick commands the route sent, not the locally derived pair', async () => {
    const profile = deviceProfile('sw-core-a');
    const device = DEVICES.find((d) => d.name === 'sw-core-a') ?? null;
    mockGetDeviceDetail.mockResolvedValue({
      device,
      profile,
      config: DEVICE_CONFIGS[profile.kind],
      clients: DEVICE_CLIENT_SETS[profile.kind],
      terminal: {
        banner: [{ text: 'SSH session opened by netops via collector-07', tone: 'muted' }],
        quickCommands: ['show running-config'],
      },
      dataSource: 'demo',
    });
    mockGetTerminalSessions.mockResolvedValue([]);
    mockGetTerminalSession.mockResolvedValue(null);
    mockGetTickets.mockResolvedValue({ tickets: [], dataSource: 'demo' });

    renderDeviceDetail('sw-core-a');

    expect(await screen.findByText('SSH session opened by netops via collector-07')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'show running-config' })).toBeTruthy();
    // The shared-helper pair for this kind is the FALLBACK, not the render.
    expect(screen.queryByText(terminalBanner(profile.kind)[0].text)).toBeNull();
    expect(screen.queryByRole('button', { name: 'show lldp neighbor' })).toBeNull();
  });

  it('falls back to the shared helpers when the route sent no terminal block', async () => {
    const device = DEVICES.find((d) => d.name === 'sw-core-a');
    if (!device) throw new Error('fixture missing');
    mockGetDeviceDetail.mockResolvedValue({
      device,
      profile: null,
      config: null,
      clients: null,
      dataSource: 'live',
    });
    mockGetTerminalSessions.mockResolvedValue([]);
    mockGetTerminalSession.mockResolvedValue(null);
    mockGetTickets.mockResolvedValue({ tickets: [], dataSource: 'demo' });
    // Live branch only mounts the pane once the recorded-SSH bridge is up.
    mockCreateWsTransport.mockImplementationOnce(() => ({
      transport: {
        banner: () => [],
        respond: () => [],
        respondAsync: () => Promise.resolve([]),
      },
      connect: () => Promise.resolve(true),
      close: () => {},
    }));

    renderDeviceDetail('sw-core-a');

    // Chips derive from the inventory row's class (switch), never from an
    // empty list — the fallback is the shared allow-listed command set.
    for (const cmd of terminalQuickCommands(deviceTerminalKind(device, device.name))) {
      expect(await screen.findByRole('button', { name: cmd })).toBeTruthy();
    }
  });
});

// ---------------------------------------------------------------------------
// (h) SERVED EVIDENCE — the Compliance panel reads the route's own block, and
//     an empty one can never read as a clean scorecard
// ---------------------------------------------------------------------------

describe('DeviceDetail — served compliance evidence', () => {
  const liveEvidencePayload = (evidence?: DeviceEvidence) => {
    const device = DEVICES.find((d) => d.name === 'sw-core-a');
    if (!device) throw new Error('fixture missing');
    mockGetDeviceDetail.mockResolvedValue({
      device,
      profile: null,
      config: null,
      clients: null,
      dataSource: 'live',
      ...(evidence ? { evidence } : {}),
    });
    mockGetTerminalSessions.mockResolvedValue([]);
    mockGetTerminalSession.mockResolvedValue(null);
    mockGetTickets.mockResolvedValue({ tickets: [], dataSource: 'demo' });
  };

  it('renders the live verdicts the route served instead of pointing at a screen that recomputes them', async () => {
    liveEvidencePayload({
      mode: 'live',
      checks: [
        { mark: 'pass', tone: 'success', label: 'Serial and MAC on record', rule: 'scan.coverage.identity' },
        { mark: 'fail', tone: 'warning', label: "Firmware 10.09.1010 is off the approved train", rule: 'scan.coverage.firmware' },
      ],
    });

    renderDeviceDetail('sw-core-a');

    expect(await screen.findByText('Serial and MAC on record')).toBeTruthy();
    expect(screen.getByText('Firmware 10.09.1010 is off the approved train')).toBeTruthy();
    expect(screen.getByText('pass')).toBeTruthy();
    expect(screen.getByText('fail')).toBeTruthy();
    // What the verdicts do NOT cover still says so — but the panel no longer
    // claims coverage "is available" while showing none of it.
    expect(
      screen.getByText(
        'Live inventory evidence only — running-configuration drift remains unavailable.',
      ),
    ).toBeTruthy();
    expect(screen.queryByText('No evidence for this device')).toBeNull();
  });

  it("renders mode 'unavailable' as a named empty state carrying the route's reason, not a clean scorecard", async () => {
    liveEvidencePayload({
      mode: 'unavailable',
      checks: [],
      note: 'No linked plane reported this device in the last pull, so nothing was checked.',
    });

    renderDeviceDetail('sw-core-a');

    expect(await screen.findByText('No evidence for this device')).toBeTruthy();
    expect(
      screen.getByText(
        'No linked plane reported this device in the last pull, so nothing was checked.',
      ),
    ).toBeTruthy();
    // An 'unavailable' block is never dressed up as a pass.
    expect(screen.queryByText('pass')).toBeNull();
    // The hand-off to the full report stays reachable.
    expect(screen.getByRole('button', { name: 'View evidence coverage →' })).toBeTruthy();
  });

  it('prefers the served demo evidence over the authored profile checks', async () => {
    const device = DEVICES.find((d) => d.name === 'sw-core-a');
    const profile = deviceProfile('sw-core-a');
    if (!device) throw new Error('fixture missing');
    mockGetDeviceDetail.mockResolvedValue({
      device,
      profile,
      config: DEVICE_CONFIGS[profile.kind],
      clients: DEVICE_CLIENT_SETS[profile.kind],
      dataSource: 'demo',
      evidence: {
        mode: 'demo',
        checks: [{ mark: 'fail', tone: 'danger', label: 'Served demo verdict', rule: 'served.only' }],
      },
    });
    mockGetTerminalSessions.mockResolvedValue([]);
    mockGetTerminalSession.mockResolvedValue(null);
    mockGetTickets.mockResolvedValue({ tickets: [], dataSource: 'demo' });

    renderDeviceDetail('sw-core-a');

    expect(await screen.findByText('Served demo verdict')).toBeTruthy();
    // The authored checks are the fallback, not a second copy rendered beside it.
    for (const check of profile.checks) {
      expect(screen.queryByText(check.label)).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// (i) SESSION ATTRIBUTION — the bridge's own 'ready' frame names the titlebar
// ---------------------------------------------------------------------------

describe('DeviceDetail — session identity from the ready frame', () => {
  it('names the account, the dialled target and the jump host the bridge reported', async () => {
    const device = DEVICES.find((d) => d.name === 'sw-core-a');
    if (!device) throw new Error('fixture missing');
    mockGetDeviceDetail.mockResolvedValue({
      device,
      profile: null,
      config: null,
      clients: null,
      dataSource: 'live',
    });
    // The store still holds only ANOTHER operator's older transcript: the
    // socket's own claim must win, with no poll to wait for.
    mockGetTerminalSessions.mockResolvedValue([
      {
        file: 'old.jsonl',
        device: 'sw-core-a',
        user: 'someone.else',
        target: '10.42.8.11',
        openedAt: '2020-01-01T00:00:00Z',
      },
    ]);
    mockGetTerminalSession.mockResolvedValue(null);
    mockGetTickets.mockResolvedValue({ tickets: [], dataSource: 'demo' });
    mockCreateWsTransport.mockImplementationOnce((_name, opts) => ({
      transport: {
        banner: () => [],
        respond: () => [],
        respondAsync: () => Promise.resolve([]),
      },
      connect: () => {
        opts?.onSession?.({
          user: 'netops',
          target: '10.42.9.7',
          via: 'bastion-hq',
          note: null,
        });
        return Promise.resolve(true);
      },
      close: () => {},
    }));

    renderDeviceDetail('sw-core-a');

    expect(await screen.findByText('ssh netops@10.42.9.7 — via bastion-hq')).toBeTruthy();
    // The older transcript stays listed under Recorded sessions, but it is
    // never presented as the connection this pane is holding.
    expect(screen.queryByText(/^ssh someone\.else@/)).toBeNull();
  });

  it('reads a direct dial as via collector rather than inventing a jump host', async () => {
    const device = DEVICES.find((d) => d.name === 'sw-core-a');
    if (!device) throw new Error('fixture missing');
    mockGetDeviceDetail.mockResolvedValue({
      device,
      profile: null,
      config: null,
      clients: null,
      dataSource: 'live',
    });
    mockGetTerminalSessions.mockResolvedValue([]);
    mockGetTerminalSession.mockResolvedValue(null);
    mockGetTickets.mockResolvedValue({ tickets: [], dataSource: 'demo' });
    mockCreateWsTransport.mockImplementationOnce((_name, opts) => ({
      transport: {
        banner: () => [],
        respond: () => [],
        respondAsync: () => Promise.resolve([]),
      },
      connect: () => {
        opts?.onSession?.({ user: 'netops', target: '10.42.9.7', via: null, note: null });
        return Promise.resolve(true);
      },
      close: () => {},
    }));

    renderDeviceDetail('sw-core-a');

    expect(await screen.findByText('ssh netops@10.42.9.7 — via collector')).toBeTruthy();
  });
});
