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
 *   (k) SNAPSHOT CONFIG — a `config` block joined from the config-backup store
 *                    renders the same three tabs with its collection channel
 *                    and time named in a caption, in the authored view and the
 *                    live view alike; a fixture block carries no caption, one
 *                    version on file says so on the Drift tab, and the live
 *                    gap note stays exactly as it was when nothing is on file.
 *   (l) PORT COUNTERS — the local AOS-CX detail read carries per-port
 *                    counters; the ports table gains Traffic/Errors columns
 *                    only for rows with a counters block, collapses an
 *                    all-identical fault column, and the authored demo rows
 *                    show the same counters without a switch.
 *
 * These tests caught a real regression: the reboot hooks used to live below
 * the `if (!data)` early return, so React threw "Rendered more hooks than
 * during the previous render" on every async load. Fixed in the source —
 * the hooks now run above the guard; this suite guards against a relapse.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import DeviceDetail from './DeviceDetail';
import { SettingsProvider } from '../app/SettingsContext';
import { ToastProvider } from '../nightdesk';
import {
  getDeviceDetail,
  getDeviceHardwareTrends,
  getDeviceInterfaceTrends,
  getDeviceApTrends,
  getTerminalSession,
  getTerminalSessions,
  getTickets,
  rebootDevice,
} from '../api/client';
import type { TerminalTranscript } from '../api/client';
import { createWsTransport } from '../lib/wsTerminal';
import {
  DEVICE_CLIENT_SETS,
  DEVICE_CONFIGS,
  DEVICES,
  MIST_AP_STATS,
  SWITCH_HARDWARE_TRENDS_DEMO,
  SWITCH_INTERFACE_TRENDS_DEMO,
  TICKETS,
  deviceProfile,
  deviceTerminalKind,
  terminalBanner,
  terminalQuickCommands,
} from '@hpe/shared';
import type {
  DeviceCfg,
  DeviceDetailLive,
  DeviceEvidence,
  DevicePort,
  DeviceRadio,
  DeviceWlan,
} from '@hpe/shared';

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
    // The trend panel's on-demand reads: 'not reported' unless a test says
    // otherwise — the panel's honest sentence, never an unstubbed crash.
    getDeviceHardwareTrends: vi.fn(() => Promise.resolve({ kind: 'not-reported' as const })),
    getDeviceInterfaceTrends: vi.fn(() => Promise.resolve({ kind: 'not-reported' as const })),
    getDeviceApTrends: vi.fn(() => Promise.resolve({ kind: 'not-reported' as const })),
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
const mockRebootDevice = vi.mocked(rebootDevice);
const mockCreateWsTransport = vi.mocked(createWsTransport);
const mockGetDeviceHardwareTrends = vi.mocked(getDeviceHardwareTrends);
const mockGetDeviceInterfaceTrends = vi.mocked(getDeviceInterfaceTrends);
const mockGetDeviceApTrends = vi.mocked(getDeviceApTrends);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderDeviceDetail(name: string) {
  return render(
    <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }} initialEntries={[`/devices/${name}`]}>
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

/** Like renderDeviceDetail, but the caller supplies the full path (with a
 *  `?plane=&serial=` query string) — used to prove the identity a row link
 *  carried reaches getDeviceDetail unchanged. */
function renderDeviceDetailAtPath(path: string) {
  return render(
    <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }} initialEntries={[path]}>
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

    // Every number the brief asked for, per radio — which for a long time
    // was every number minus four, silently, because the row only listed the
    // ones someone had thought to name.
    expect(screen.getByText('ch 11 · 20 MHz · 9 dBm · Client Access')).toBeTruthy();
    expect(
      screen.getByText(
        '1 client · util 23% · non-Wi-Fi 5% · airtime rx 18% tx 0% · noise -98 dBm · retries 0.09% · drops 0.09% · quality 97',
      ),
    ).toBeTruthy();
    expect(screen.getByText('ch 157E · 80 MHz · 19 dBm · Client Access')).toBeTruthy();
    expect(screen.getByText('ch 213S · 160 MHz · 15 dBm · Client Access')).toBeTruthy();
    // A zero is a reading, not a missing value — 0 clients / 0% util survive,
    // and so does an airtime split of nothing at all.
    expect(
      screen.getByText(
        '0 clients · util 0% · non-Wi-Fi 0% · airtime rx 0% tx 0% · noise -87 dBm · retries 0% · drops 0% · quality 100',
      ),
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
    // Each fact is its own cell now, so they are asserted per column rather
    // than as one sentence.
    expect(screen.getByText('SS_9004_Gateway-LTE')).toBeTruthy();
    expect(screen.getByText('Poor')).toBeTruthy();
    expect(screen.getByText('1 Gb · full')).toBeTruthy();
    expect(screen.getByText('Access 200')).toBeTruthy();

    // The AP port: PoE++ on a trunk carrying VLANs 5 and 200.
    expect(screen.getByText('Office-655')).toBeTruthy();
    expect(screen.getAllByText('Access Point').length).toBeGreaterThan(0);
    expect(screen.getByText('5 Gb · full')).toBeTruthy();
    expect(screen.getAllByText('Trunk 5 + 5,200').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Drawing Watts · 802.3bt Type 3 (PoE++)').length).toBeGreaterThan(0);

    // 1/1/9 reports no spanning-tree role at all, so STP does NOT read the
    // same on every port and keeps its column. A column is only collapsed
    // when every row genuinely agrees — 'two of three agree' is not agreement.
    expect(screen.queryAllByRole('columnheader').map((el) => el.textContent)).toContain('STP');
    expect(screen.queryByText(/^Same on all/)).toBeNull();
  });

  it('states a fact every port shares once under the table instead of in a column', async () => {
    // Same three ports, but now all of them report the same STP role/state.
    const agreed = SWITCH_PORTS.map((port) => ({
      ...port,
      stpRole: 'Designated',
      stpState: 'Forwarding',
    }));
    mockGetDeviceDetail.mockResolvedValue(
      withDetail(liveBase('sw-core-a'), {
        serial: 'SG30LMR164',
        kind: 'switch',
        ports: agreed,
        source: { plane: 'central', at: '2026-07-28T15:47:00.000Z', sections: { ports: 'ok' } },
      }),
    );
    quietDeps();

    renderDeviceDetail('sw-core-a');

    expect(await screen.findByText('Ports of interest')).toBeTruthy();
    expect(screen.queryAllByRole('columnheader').map((el) => el.textContent)).not.toContain('STP');
    expect(screen.getByText('Same on all 3 ports: STP Designated/Forwarding')).toBeTruthy();

    // The columns that still differ are untouched.
    expect(screen.queryAllByRole('columnheader').map((el) => el.textContent)).toContain('VLAN');
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
    expect(screen.getByText('Office-655')).toBeTruthy();
    expect(screen.getByText('Access Point')).toBeTruthy();
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

  /* Two radios, equally congested, needing opposite work. Central reports
   * which is which and the panel was throwing it away, so both read "util
   * 78%" and the obvious response to that — more APs, more power — makes the
   * interference case worse. */
  it('separates air this AP is losing to interference from air its own estate is using', async () => {
    const congested: DeviceRadio[] = [
      { ...AP_RADIOS[0], number: 0, band: '5 GHz', channelUtilPct: 78, nonWifiInterference: 61, rxUtilPct: 6, txUtilPct: 3, drops: 14, retries: 22 },
      { ...AP_RADIOS[1], number: 1, band: '2.4 GHz', channelUtilPct: 78, nonWifiInterference: 2, rxUtilPct: 41, txUtilPct: 30, drops: 0, retries: 1 },
    ];
    mockGetDeviceDetail.mockResolvedValue(
      withDetail(liveBase('ap-1f-04'), apDetail({ radios: 'ok' }, { radios: congested })),
    );
    quietDeps();

    renderDeviceDetail('ap-1f-04');

    await screen.findByText('Radios');
    // Something else owns the 5 GHz air; this AP is barely on it.
    expect(screen.getByText(/util 78% · non-Wi-Fi 61% · airtime rx 6% tx 3%/)).toBeTruthy();
    // The 2.4 GHz air is busy with this AP's own traffic.
    expect(screen.getByText(/util 78% · non-Wi-Fi 2% · airtime rx 41% tx 30%/)).toBeTruthy();
    // drops was parsed beside retries and only retries was ever printed.
    expect(screen.getByText(/retries 22% · drops 14%/)).toBeTruthy();
  });

  // A counter the plane did not report is absent, not zero, and one reported
  // side of the airtime split is still worth printing.
  it('prints the airtime side a radio did report and omits the one it did not', async () => {
    mockGetDeviceDetail.mockResolvedValue(
      withDetail(
        liveBase('ap-1f-04'),
        apDetail({ radios: 'ok' }, {
          radios: [{ ...AP_RADIOS[0], rxUtilPct: 12, txUtilPct: null, nonWifiInterference: null, drops: null }],
        }),
      ),
    );
    quietDeps();

    renderDeviceDetail('ap-1f-04');

    await screen.findByText('Radios');
    expect(screen.getByText(/airtime rx 12%/)).toBeTruthy();
    expect(screen.queryByText(/tx/)).toBeNull();
    expect(screen.queryByText(/non-Wi-Fi/)).toBeNull();
    expect(screen.queryByText(/drops/)).toBeNull();
  });

  const shutPort = (name: string, extra: Partial<DevicePort> = {}): DevicePort => ({
    name,
    status: 'Down',
    adminStatus: 'Down',
    operStatus: 'Down',
    speedBps: null,
    duplex: '-',
    vlanMode: 'Access',
    nativeVlan: 200,
    ...extra,
  });

  /* Central keeps scoring the neighbour it last saw on a port after the port
   * is shut, so the row for a disabled uplink read "AP-Floor2 … Good" in
   * green — the answer to why the AP is offline presented as proof that
   * nothing is wrong. */
  it('marks a port that was shut in configuration instead of badging its stale health green', async () => {
    mockGetDeviceDetail.mockResolvedValue(
      withDetail(liveBase('sw-core-a'), {
        serial: 'SG30LMR164',
        kind: 'switch',
        ports: [shutPort('1/1/12', { neighbour: 'AP-Floor2', neighbourType: 'Access Point', neighbourHealth: 'Good' })],
        source: { plane: 'central', at: '2026-07-28T15:47:00.000Z', sections: { ports: 'ok' } },
      }),
    );
    quietDeps();

    renderDeviceDetail('sw-core-a');

    expect(await screen.findByText('ADMIN DOWN')).toBeTruthy();
    // The verdict is demoted, not deleted, and the count is in the header.
    expect(screen.getByText('Good')).toBeTruthy();
    expect(screen.getByText('1 OF 1 CONNECTED · 1 ADMIN DOWN')).toBeTruthy();
  });

  /* A shut port with nothing plugged into it does not earn a row. It must
   * still be countable: twenty ports shut by policy and twenty shut by
   * mistake look identical when neither is on the screen. */
  it('counts shut ports it does not list rather than dropping them silently', async () => {
    mockGetDeviceDetail.mockResolvedValue(
      withDetail(liveBase('sw-core-a'), {
        serial: 'SG30LMR164',
        kind: 'switch',
        ports: [SWITCH_PORTS[1], shutPort('1/1/20'), shutPort('1/1/21')],
        source: { plane: 'central', at: '2026-07-28T15:47:00.000Z', sections: { ports: 'ok' } },
      }),
    );
    quietDeps();

    renderDeviceDetail('sw-core-a');

    expect(await screen.findByText('1 OF 3 CONNECTED · 2 ADMIN DOWN')).toBeTruthy();
    expect(
      screen.getByText(
        '2 further ports are administratively down with no neighbour discovered, and are not listed above.',
      ),
    ).toBeTruthy();
  });

  // "Every port is down with no neighbour" names a link fault. Shut ports are not one.
  it('does not describe a switch of shut ports as a switch of dead links', async () => {
    mockGetDeviceDetail.mockResolvedValue(
      withDetail(liveBase('sw-core-a'), {
        serial: 'SG30LMR164',
        kind: 'switch',
        ports: [shutPort('1/1/20')],
        source: { plane: 'central', at: '2026-07-28T15:47:00.000Z', sections: { ports: 'ok' } },
      }),
    );
    quietDeps();

    renderDeviceDetail('sw-core-a');

    expect(
      await screen.findByText(
        'None of the 1 interfaces CENTRAL reported is connected. 1 is administratively down — shut in configuration, not a link fault.',
      ),
    ).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// (l) PORT COUNTERS — the local AOS-CX read carries per-port counters off the
//     interface statistics attribute. The table gains Traffic/Errors columns
//     only when rows carry a counters block, an all-identical fault column
//     collapses into one stated fact, a row without a block reads as
//     not-reported, and the authored demo rows show the same counters with no
//     switch involved.
// ---------------------------------------------------------------------------

describe('DeviceDetail — per-port counters (local AOS-CX)', () => {
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

  /** A local AOS-CX port as the adapter maps it: the plane's own 'up'/'down'
   *  words, counters only when the interface carried a statistics map. */
  const cxPort = (
    name: string,
    counters: DevicePort['counters'] | null,
    over: Partial<DevicePort> = {},
  ): DevicePort => ({
    name,
    status: 'up',
    adminStatus: 'up',
    operStatus: 'up',
    speedBps: 1_000_000_000,
    duplex: 'full',
    vlanMode: 'access',
    nativeVlan: 812,
    allowedVlanIds: [],
    ...over,
    ...(counters ? { counters } : {}),
  });

  const cleanCounters = (rxBytes: number, txBytes: number): NonNullable<DevicePort['counters']> => ({
    rxBytes,
    txBytes,
    rxPackets: 1,
    txPackets: 1,
    rxErrors: 0,
    txErrors: 0,
    rxDropped: 0,
    txDropped: 0,
  });

  const cxDetail = (ports: DevicePort[]): DeviceDetailLive => ({
    serial: 'SG09KLM4X2',
    kind: 'switch',
    ports,
    source: { plane: 'local', at: '2026-07-28T15:47:00.000Z', sections: { ports: 'ok' } },
  });

  it('renders Traffic and Errors columns when the plane reported counters', async () => {
    mockGetDeviceDetail.mockResolvedValue(
      withDetail(
        liveBase('sw-core-a'),
        cxDetail([
          cxPort('1/1/14', cleanCounters(412_000_000_000, 1_280_000_000_000), { nativeVlan: 810 }),
          cxPort('1/1/22', cleanCounters(86_000_000_000, 4_100_000_000), { nativeVlan: 811, speedBps: 2_500_000_000 }),
          cxPort('lag1', {
            rxBytes: 31_482_000_000_000,
            txBytes: 28_913_000_000_000,
            rxPackets: 1,
            txPackets: 1,
            rxErrors: 3,
            txErrors: 0,
            rxDropped: 27,
            txDropped: 0,
          }),
        ]),
      ),
    );
    quietDeps();

    renderDeviceDetail('sw-core-a');

    expect(await screen.findByText('Traffic')).toBeTruthy();
    expect(screen.getByText('Errors')).toBeTruthy();
    expect(screen.getByText('rx 412 GB · tx 1.3 TB')).toBeTruthy();
    expect(screen.getByText('3 err · 27 drop')).toBeTruthy();
    // One row with real faults keeps the column — the clean rows keep cells.
    expect(screen.getAllByText('0 err · 0 drop')).toHaveLength(2);
    expect(screen.queryByText(/Same on all 3 ports: Errors/)).toBeNull();
  });

  it('collapses an all-clean fault column into one fact stated once', async () => {
    mockGetDeviceDetail.mockResolvedValue(
      withDetail(
        liveBase('sw-core-a'),
        cxDetail([
          cxPort('1/1/13', cleanCounters(1_000_000_000, 2_000_000_000), { nativeVlan: 810 }),
          cxPort('1/1/14', cleanCounters(412_000_000_000, 1_280_000_000_000), { nativeVlan: 811, speedBps: 2_500_000_000 }),
          cxPort('1/1/15', cleanCounters(86_000_000_000, 4_100_000_000), { nativeVlan: 812, speedBps: 5_000_000_000 }),
        ]),
      ),
    );
    quietDeps();

    renderDeviceDetail('sw-core-a');

    // Every port answers identically, so the column leaves the grid and is
    // stated once underneath — nothing is hidden.
    expect(await screen.findByText('Same on all 3 ports: Errors 0 err · 0 drop')).toBeTruthy();
    expect(screen.queryByText('Errors')).toBeNull();
    // Traffic differs per row, so that column stays.
    expect(screen.getByText('Traffic')).toBeTruthy();
  });

  it('adds no counter columns at all when no row carried a statistics map', async () => {
    mockGetDeviceDetail.mockResolvedValue(
      withDetail(
        liveBase('sw-core-a'),
        cxDetail([
          cxPort('1/1/13', null, { nativeVlan: 810 }),
          cxPort('1/1/14', null, { nativeVlan: 811, speedBps: 2_500_000_000 }),
          cxPort('1/1/15', null, { nativeVlan: 812, speedBps: 5_000_000_000 }),
        ]),
      ),
    );
    quietDeps();

    renderDeviceDetail('sw-core-a');

    expect(await screen.findByText('Ports of interest')).toBeTruthy();
    expect(screen.queryByText('Traffic')).toBeNull();
    expect(screen.queryByText('Errors')).toBeNull();
  });

  it('reads a row without a counters block as not-reported, never as zero', async () => {
    mockGetDeviceDetail.mockResolvedValue(
      withDetail(
        liveBase('sw-core-a'),
        cxDetail([
          cxPort('1/1/13', null, { nativeVlan: 810 }),
          cxPort('1/1/14', cleanCounters(412_000_000_000, 1_280_000_000_000), { nativeVlan: 811, speedBps: 2_500_000_000 }),
          cxPort('1/1/15', null, { nativeVlan: 812, speedBps: 5_000_000_000 }),
        ]),
      ),
    );
    quietDeps();

    renderDeviceDetail('sw-core-a');

    expect(await screen.findByText('rx 412 GB · tx 1.3 TB')).toBeTruthy();
    // The two unreported rows read '—' in both counter columns — 4 cells,
    // each the same statement the rest of the screen makes: nothing was said.
    expect(screen.getAllByText('—')).toHaveLength(4);
  });

  it('shows the authored counters on the demo CX switch rows — no switch required', async () => {
    const profile = deviceProfile('sw-core-a');
    const device = DEVICES.find((d) => d.name === 'sw-core-a') ?? null;
    mockGetDeviceDetail.mockResolvedValue({
      device,
      profile,
      config: DEVICE_CONFIGS[profile.kind],
      clients: DEVICE_CLIENT_SETS[profile.kind],
      dataSource: 'demo',
    });
    quietDeps();

    renderDeviceDetail('sw-core-a');

    expect(await screen.findByText('rx 31.5 TB · tx 28.9 TB · 0 err · 0 drop')).toBeTruthy();
    expect(screen.getByText(/3 err · 27 drop/)).toBeTruthy();
    // ISL, AP uplink and the frozen sensor port report clean counters; the
    // transit row reports the faults above; psu2 is not an interface and
    // earned no counter line at all.
    expect(screen.getAllByText(/0 err · 0 drop/)).toHaveLength(3);
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
    mockCreateWsTransport.mockImplementationOnce((_name, _identity, opts) => {
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
    mockCreateWsTransport.mockImplementationOnce((_name, _identity, opts) => ({
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
    mockCreateWsTransport.mockImplementationOnce((_name, _identity, opts) => ({
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

// ---------------------------------------------------------------------------
// Exact identity routing (fix-device-detail-identity) — the plane+serial a
// row link carries must reach getDeviceDetail unchanged, and the server's
// honest 409 for an ambiguous bare name must render as an error state, never
// a silently-picked device.
// ---------------------------------------------------------------------------

describe('DeviceDetail — exact plane+serial identity from the URL', () => {
  it('forwards the linked plane+serial query to getDeviceDetail', async () => {
    const device = DEVICES.find((d) => d.name === 'sw-core-a');
    if (!device) throw new Error('fixture missing');
    mockGetDeviceDetail.mockResolvedValue({ device, profile: null, config: null, clients: null, dataSource: 'live' });
    mockGetTerminalSessions.mockResolvedValue([]);
    mockGetTerminalSession.mockResolvedValue(null);
    mockGetTickets.mockResolvedValue({ tickets: [], dataSource: 'demo' });

    renderDeviceDetailAtPath('/devices/ap-dup?plane=MIST&serial=DUP-MIST-002');

    await screen.findByRole('heading', { name: 'sw-core-a' });
    expect(mockGetDeviceDetail).toHaveBeenCalledWith('ap-dup', { plane: 'MIST', serial: 'DUP-MIST-002' });
  });

  it('a legacy bare-name link (no query) still calls getDeviceDetail with no identity hint', async () => {
    const device = DEVICES.find((d) => d.name === 'sw-core-a');
    if (!device) throw new Error('fixture missing');
    mockGetDeviceDetail.mockResolvedValue({ device, profile: null, config: null, clients: null, dataSource: 'live' });
    mockGetTerminalSessions.mockResolvedValue([]);
    mockGetTerminalSession.mockResolvedValue(null);
    mockGetTickets.mockResolvedValue({ tickets: [], dataSource: 'demo' });

    renderDeviceDetail('sw-core-a');

    await screen.findByRole('heading', { name: 'sw-core-a' });
    expect(mockGetDeviceDetail).toHaveBeenCalledWith('sw-core-a', { plane: undefined, serial: undefined });
  });

  it("an ambiguous name renders the honest API error state, never a picked-first device", async () => {
    mockGetDeviceDetail.mockResolvedValue({
      device: null,
      profile: null,
      config: null,
      clients: null,
      dataSource: 'live',
      apiError: "'ap-dup' names 2 devices — pass plane and serial to pick one",
    });
    mockGetTerminalSessions.mockResolvedValue([]);
    mockGetTerminalSession.mockResolvedValue(null);
    mockGetTickets.mockResolvedValue({ tickets: [], dataSource: 'demo' });

    renderDeviceDetail('ap-dup');

    expect(await screen.findByText('The portal API could not load this screen')).toBeTruthy();
    expect(
      screen.getByText("'ap-dup' names 2 devices — pass plane and serial to pick one"),
    ).toBeTruthy();
    // Never a device heading — an ambiguous name must not silently render
    // either candidate.
    expect(screen.queryByRole('heading', { name: 'ap-dup' })).toBeNull();
  });

  it('one plane+serial query resolves the FIRST duplicate row, the other resolves the SECOND', async () => {
    const centralDup = DEVICES.find((d) => d.name === 'sw-core-a')!;
    const mistDup = { ...centralDup, name: 'sw-core-a', plane: 'MIST' as const, serial: 'DUP-MIST-002' };
    mockGetTerminalSessions.mockResolvedValue([]);
    mockGetTerminalSession.mockResolvedValue(null);
    mockGetTickets.mockResolvedValue({ tickets: [], dataSource: 'demo' });

    mockGetDeviceDetail.mockResolvedValueOnce({
      device: { ...centralDup, serial: 'DUP-CENTRAL-001' },
      profile: null,
      config: null,
      clients: null,
      dataSource: 'live',
    });
    renderDeviceDetailAtPath('/devices/sw-core-a?plane=CENTRAL&serial=DUP-CENTRAL-001');
    await screen.findByRole('heading', { name: 'sw-core-a' });
    expect(mockGetDeviceDetail).toHaveBeenLastCalledWith('sw-core-a', {
      plane: 'CENTRAL',
      serial: 'DUP-CENTRAL-001',
    });
    cleanup();

    mockGetDeviceDetail.mockResolvedValueOnce({ device: mistDup, profile: null, config: null, clients: null, dataSource: 'live' });
    renderDeviceDetailAtPath('/devices/sw-core-a?plane=MIST&serial=DUP-MIST-002');
    await screen.findByRole('heading', { name: 'sw-core-a' });
    expect(mockGetDeviceDetail).toHaveBeenLastCalledWith('sw-core-a', { plane: 'MIST', serial: 'DUP-MIST-002' });
    // The diagnostics eligibility target the panel keys on (plane, serial)
    // must reflect whichever duplicate row this render actually resolved.
    expect(screen.getAllByText('MIST').length).toBeGreaterThan(0);
  });

  it('sends the exact resolved plane+serial when rebooting', async () => {
    const base = DEVICES.find((device) => device.name === 'sw-core-a');
    if (!base) throw new Error('fixture missing');
    const device = {
      ...base,
      name: 'shared-name',
      plane: 'CENTRAL' as const,
      serial: 'SERIAL-B',
      localShell: false,
    };
    mockGetDeviceDetail.mockResolvedValue({
      device,
      profile: null,
      config: null,
      clients: null,
      dataSource: 'live',
    });
    mockGetTerminalSessions.mockResolvedValue([]);
    mockGetTerminalSession.mockResolvedValue(null);
    mockGetTickets.mockResolvedValue({ tickets: [TICKETS[0]!], dataSource: 'demo' });
    mockRebootDevice.mockResolvedValue({
      ok: true,
      applied: true,
      device: device.name,
      plane: device.plane,
      serial: device.serial,
      ticket: TICKETS[0]!.id,
      message: 'accepted',
    });

    renderDeviceDetailAtPath('/devices/shared-name?plane=CENTRAL&serial=SERIAL-B');
    await screen.findByRole('heading', { name: 'shared-name' });
    fireEvent.click(screen.getByRole('button', { name: 'Reboot' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Reboot shared-name' }));

    await waitFor(() => expect(mockRebootDevice).toHaveBeenCalledWith(
      'shared-name',
      TICKETS[0]!.id,
      { plane: 'CENTRAL', serial: 'SERIAL-B' },
    ));
  });
});

// ---------------------------------------------------------------------------
// Recorded-sessions identity query (fix-terminal-session-identity) — the
// list/transcript reads for the Device Detail page must carry the same
// plane+serial the URL linked here with, never a name-only lookup, and an
// ambiguous shared name must render as an honest error, never a guess.
// ---------------------------------------------------------------------------

describe('DeviceDetail — recorded sessions use plane+serial, never name-only', () => {
  it('forwards the linked plane+serial to getTerminalSessions', async () => {
    const device = DEVICES.find((d) => d.name === 'sw-core-a');
    if (!device) throw new Error('fixture missing');
    mockGetDeviceDetail.mockResolvedValue({ device, profile: null, config: null, clients: null, dataSource: 'live' });
    mockGetTerminalSessions.mockResolvedValue([]);
    mockGetTerminalSession.mockResolvedValue(null);
    mockGetTickets.mockResolvedValue({ tickets: [], dataSource: 'demo' });

    renderDeviceDetailAtPath('/devices/shared-name?plane=CENTRAL&serial=SERIAL-B');

    await screen.findByRole('heading', { name: 'sw-core-a' });
    expect(mockGetTerminalSessions).toHaveBeenCalledWith('shared-name', { plane: 'CENTRAL', serial: 'SERIAL-B' });
  });

  it('a legacy bare-name link still asks for sessions, with no identity hint (undefined, never guessed)', async () => {
    const device = DEVICES.find((d) => d.name === 'sw-core-a');
    if (!device) throw new Error('fixture missing');
    mockGetDeviceDetail.mockResolvedValue({ device, profile: null, config: null, clients: null, dataSource: 'live' });
    mockGetTerminalSessions.mockResolvedValue([]);
    mockGetTerminalSession.mockResolvedValue(null);
    mockGetTickets.mockResolvedValue({ tickets: [], dataSource: 'demo' });

    renderDeviceDetail('sw-core-a');

    await screen.findByRole('heading', { name: 'sw-core-a' });
    expect(mockGetTerminalSessions).toHaveBeenCalledWith('sw-core-a', { plane: undefined, serial: undefined });
  });

  it('forwards the same identity to getTerminalSession when a transcript is opened', async () => {
    const profile = deviceProfile('sw-core-a');
    mockGetDeviceDetail.mockResolvedValue({
      device: DEVICES.find((d) => d.name === 'sw-core-a') ?? null,
      profile,
      config: DEVICE_CONFIGS[profile.kind],
      clients: DEVICE_CLIENT_SETS[profile.kind],
      dataSource: 'demo',
    });
    mockGetTickets.mockResolvedValue({ tickets: [], dataSource: 'demo' });
    mockGetTerminalSessions.mockResolvedValue([
      { file: 'a.log', device: 'sw-core-a', user: 'r.okafor', target: 'sw-core-a', openedAt: '2026-07-25T09:12:00Z' },
    ]);
    mockGetTerminalSession.mockResolvedValue({ file: 'a.log', events: [], truncated: false });

    renderDeviceDetailAtPath('/devices/sw-core-a?plane=LOCAL&serial=SERIAL-CORE-A');
    const viewButton = await screen.findByRole('button', { name: 'View transcript' });
    fireEvent.click(viewButton);

    await waitFor(() =>
      expect(mockGetTerminalSession).toHaveBeenCalledWith('a.log', 'sw-core-a', { plane: 'LOCAL', serial: 'SERIAL-CORE-A' }),
    );
  });

  it('renders an ambiguous-name failure honestly instead of a misleadingly empty session list', async () => {
    const device = DEVICES.find((d) => d.name === 'sw-core-a');
    if (!device) throw new Error('fixture missing');
    mockGetDeviceDetail.mockResolvedValue({ device, profile: null, config: null, clients: null, dataSource: 'live' });
    mockGetTerminalSessions.mockRejectedValue(
      new Error("'shared-name' names more than one device — recorded sessions need an exact plane and serial to show safely"),
    );
    mockGetTerminalSession.mockResolvedValue(null);
    mockGetTickets.mockResolvedValue({ tickets: [], dataSource: 'demo' });

    renderDeviceDetail('shared-name');

    expect(
      await screen.findByText(/names more than one device — recorded sessions need an exact plane and serial/),
    ).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// (k) SNAPSHOT CONFIG — the config-backup join renders with provenance
// ---------------------------------------------------------------------------

/** A config block as the route builds it from the backup store (ISO times
 *  without a Z suffix, so the hhmm assertions are timezone-independent). */
function snapshotCfg(over: Partial<DeviceCfg> = {}): DeviceCfg {
  return {
    meta: 'SNAPSHOT v2 · 2 VERSIONS ON FILE',
    running: 'hostname sw-core-a\nntp server 10.42.0.21 iburst',
    diff: '  hostname sw-core-a\n- ntp server 10.42.0.20 iburst\n+ ntp server 10.42.0.21 iburst',
    history: [
      { when: '2026-07-25T12:04:00', what: 'Snapshot v2 — 2 lines', who: 'ssh show running-config', tag: 'drift', tone: 'warning' },
      { when: '2026-07-25T06:00:00', what: 'Snapshot v1 — 2 lines', who: 'ssh show running-config', tag: 'snapshot', tone: 'neutral' },
    ],
    provenance: { version: 2, versions: 2, source: 'ssh show running-config', takenAt: '2026-07-25T12:04:00' },
    ...over,
  };
}

describe('DeviceDetail — config snapshot provenance', () => {
  it('renders the joined snapshot in the three tabs with the collection channel named', async () => {
    const profile = deviceProfile('sw-core-a');
    mockGetDeviceDetail.mockResolvedValue({
      device: DEVICES.find((d) => d.name === 'sw-core-a') ?? null,
      profile,
      config: snapshotCfg(),
      clients: DEVICE_CLIENT_SETS[profile.kind],
      dataSource: 'demo',
    });
    mockGetTickets.mockResolvedValue({ tickets: [], dataSource: 'demo' });
    mockGetTerminalSessions.mockResolvedValue([]);
    mockGetTerminalSession.mockResolvedValue(null);

    renderDeviceDetail('sw-core-a');

    // The Running tab opens on the snapshot body, the section meta counts the
    // versions on file, and the caption says where the snapshot CAME FROM —
    // a real collection channel, never implied.
    expect(await screen.findByText(/ntp server 10\.42\.0\.21 iburst/)).toBeTruthy();
    expect(screen.getByText('SNAPSHOT v2 · 2 VERSIONS ON FILE')).toBeTruthy();
    expect(screen.getByText('snapshot v2 · ssh show running-config · 12:04')).toBeTruthy();

    // Drift tab: the diff of the two newest versions, coloured as a diff.
    fireEvent.click(screen.getByRole('tab', { name: 'Drift vs. baseline' }));
    expect(screen.getByText(/^- ntp server 10\.42\.0\.20 iburst/)).toBeTruthy();
    expect(screen.getByText(/^\+ ntp server 10\.42\.0\.21 iburst/)).toBeTruthy();

    // History tab: the real version list, browser-stamped times, drift tagged.
    fireEvent.click(screen.getByRole('tab', { name: 'History' }));
    expect(screen.getByText('Snapshot v2 — 2 lines')).toBeTruthy();
    expect(screen.getByText('Snapshot v1 — 2 lines')).toBeTruthy();
    expect(screen.getByText('12:04')).toBeTruthy();
    expect(screen.getByText('06:00')).toBeTruthy();
    expect(screen.getByText('drift')).toBeTruthy();
    expect(screen.getAllByText('ssh show running-config').length).toBeGreaterThan(0);
  });

  it('says so on the Drift tab when only one snapshot is on file — an empty pane is not "no drift"', async () => {
    const profile = deviceProfile('sw-core-a');
    mockGetDeviceDetail.mockResolvedValue({
      device: DEVICES.find((d) => d.name === 'sw-core-a') ?? null,
      profile,
      config: snapshotCfg({
        meta: 'SNAPSHOT v1 · 1 VERSION ON FILE',
        diff: '',
        history: [snapshotCfg().history[1]!],
        provenance: { version: 1, versions: 1, source: 'demo synthesis', takenAt: '2026-07-25T06:00:00' },
      }),
      clients: DEVICE_CLIENT_SETS[profile.kind],
      dataSource: 'demo',
    });
    mockGetTickets.mockResolvedValue({ tickets: [], dataSource: 'demo' });
    mockGetTerminalSessions.mockResolvedValue([]);
    mockGetTerminalSession.mockResolvedValue(null);

    renderDeviceDetail('sw-core-a');
    fireEvent.click(await screen.findByRole('tab', { name: 'Drift vs. baseline' }));
    expect(
      screen.getByText('Only one snapshot on file — drift appears once a second collection lands.'),
    ).toBeTruthy();
    // Demo synthesis names itself in the caption, same as any other channel.
    expect(screen.getByText('snapshot v1 · demo synthesis · 06:00')).toBeTruthy();
  });

  it('renders no provenance caption for the authored fixture config', async () => {
    const profile = deviceProfile('sw-core-a');
    mockGetDeviceDetail.mockResolvedValue({
      device: DEVICES.find((d) => d.name === 'sw-core-a') ?? null,
      profile,
      config: DEVICE_CONFIGS[profile.kind],
      clients: DEVICE_CLIENT_SETS[profile.kind],
      dataSource: 'demo',
    });
    mockGetTickets.mockResolvedValue({ tickets: [], dataSource: 'demo' });
    mockGetTerminalSessions.mockResolvedValue([]);
    mockGetTerminalSession.mockResolvedValue(null);

    renderDeviceDetail('sw-core-a');
    // The authored meta is the only labelling — nothing claims a collection.
    expect(await screen.findByText('SNAPSHOT 06:00 · 4 CHANGES THIS WEEK')).toBeTruthy();
    expect(screen.queryByText(/snapshot v\d/)).toBeNull();
    // …and the authored history rows keep their pre-formatted text verbatim.
    fireEvent.click(screen.getByRole('tab', { name: 'History' }));
    expect(screen.getByText('25 Jul 09:22')).toBeTruthy();
  });

  it('live view: snapshots on file render the tabs instead of the gap note', async () => {
    mockGetDeviceDetail.mockResolvedValue({
      device: DEVICES.find((d) => d.name === 'sw-core-a') ?? null,
      profile: null,
      config: snapshotCfg(),
      clients: null,
      dataSource: 'live',
      syncedAt: '2026-07-26T09:41:00',
    });
    mockGetTerminalSessions.mockResolvedValue([]);
    mockGetTerminalSession.mockResolvedValue(null);
    mockGetTickets.mockResolvedValue({ tickets: [], dataSource: 'demo' });

    renderDeviceDetail('sw-core-a');

    expect(await screen.findByText(/ntp server 10\.42\.0\.21 iburst/)).toBeTruthy();
    expect(screen.getByText('snapshot v2 · ssh show running-config · 12:04')).toBeTruthy();
    expect(screen.getByText('SNAPSHOT v2 · 2 VERSIONS ON FILE')).toBeTruthy();
    expect(
      screen.queryByText('Not available in live mode — no linked plane reports a running config for this device.'),
    ).toBeNull();

    fireEvent.click(screen.getByRole('tab', { name: 'History' }));
    expect(screen.getByText('Snapshot v2 — 2 lines')).toBeTruthy();
  });

  it('live view: no snapshots keeps the gap note exactly', async () => {
    mockGetDeviceDetail.mockResolvedValue({
      device: DEVICES.find((d) => d.name === 'sw-core-a') ?? null,
      profile: null,
      config: null,
      clients: null,
      dataSource: 'live',
    });
    mockGetTerminalSessions.mockResolvedValue([]);
    mockGetTerminalSession.mockResolvedValue(null);
    mockGetTickets.mockResolvedValue({ tickets: [], dataSource: 'demo' });

    renderDeviceDetail('sw-core-a');
    expect(
      await screen.findByText('Not available in live mode — no linked plane reports a running config for this device.'),
    ).toBeTruthy();
    expect(screen.queryByRole('tab', { name: 'Drift vs. baseline' })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// (m) MIST AP HEALTH & RF — the `mistAp` poll row drives the RF section:
//     per-band tuning with the full airtime split, CPU/mem, env, power and
//     the LLDP uplink. An AP with no env sensor block reads "not reported",
//     and the generic lazy-read radios panel never duplicates the list.
// ---------------------------------------------------------------------------

describe('DeviceDetail — Mist AP health & RF panel', () => {
  const apFixture = (name: string) => {
    const device = DEVICES.find((d) => d.name === name);
    const stats = MIST_AP_STATS.find((r) => r.deviceName === name);
    if (!device || !stats) throw new Error(`fixture missing: ${name}`);
    return { device, stats };
  };
  const quietDeps = () => {
    mockGetTerminalSessions.mockResolvedValue([]);
    mockGetTerminalSession.mockResolvedValue(null);
    mockGetTickets.mockResolvedValue({ tickets: TICKETS, dataSource: 'demo' });
  };

  it('live: renders the RF split, health gauges, env, power and LLDP uplink from the poll row', async () => {
    const { device, stats } = apFixture('ap-3f-12');
    mockGetDeviceDetail.mockResolvedValue({
      device,
      profile: null,
      config: null,
      clients: null,
      mistAp: stats,
      // The lazy per-object read landed too — with radios. The poll row is
      // the fuller RF story, so the generic panel must NOT list them again.
      detail: {
        serial: 'MST43KF1201',
        kind: 'ap',
        radios: [
          {
            number: 0, band: '2.4 GHz', channel: '6', bandwidth: '20 MHz',
            powerDbm: 11, clients: 13, channelUtilPct: 58, rxUtilPct: 18, txUtilPct: 22,
            retries: null, drops: null, noiseFloorDbm: -92, nonWifiInterference: 4,
            channelQuality: null, status: '', mode: '',
          },
        ],
        source: { plane: 'mist', at: '2026-07-26T11:59:00.000Z', sections: { radios: 'ok', ports: 'ok' } },
      },
      dataSource: 'live',
    });
    quietDeps();

    renderDeviceDetail('ap-3f-12');

    expect(await screen.findByText('AP health & RF')).toBeTruthy();
    // Per-band tuning facts and the full airtime split (util_all + its four
    // reported components), straight off the stats row.
    expect(screen.getByText('ch 6 · 20 MHz · 11 dBm · noise -92 dBm · 13 clients')).toBeTruthy();
    expect(screen.getByText('util 58%')).toBeTruthy();
    expect(screen.getByText('tx 22%')).toBeTruthy();
    expect(screen.getByText('rx 18%')).toBeTruthy();
    expect(screen.getByText('other BSS 14%')).toBeTruthy();
    expect(screen.getByText('non-Wi-Fi 4%')).toBeTruthy();
    expect(screen.getByText('ch 36 · 40 MHz · 14 dBm · noise -96 dBm · 28 clients')).toBeTruthy();
    // Health gauges from the same row.
    expect(screen.getByText('23%')).toBeTruthy(); // CPU
    expect(screen.getByText('500 of 974 MB')).toBeTruthy(); // memory
    expect(screen.getByText('46 d')).toBeTruthy(); // uptime
    // Power and environment, as reported.
    expect(screen.getByText('PoE 802.3at')).toBeTruthy();
    expect(screen.queryByText('power constrained')).toBeNull();
    expect(screen.getByText('23.8 °C · 41% RH')).toBeTruthy();
    // The uplink port and the AP's own LLDP report of its neighbour.
    expect(screen.getByText(/1 Gb · full · rx 4\.8 GB/)).toBeTruthy();
    expect(screen.getByText(/sw-cam02-1 ge-0\/0\/12/)).toBeTruthy();
    expect(screen.getByText(/reported by this AP via LLDP/)).toBeTruthy();
    // The generic lazy-read panels stay away — one radio list, not two.
    expect(screen.queryByText('Radios')).toBeNull();
    expect(screen.queryByText('Ports of interest')).toBeNull();
    // The claim code rides the identity rail (the one surface an operator
    // with device-read access already sees).
    expect(screen.getByText('KV4M9Q2X7RND3H1')).toBeTruthy();
  });

  it('live: an AP with no env sensor block reads "not reported", never a fabricated number', async () => {
    const { device, stats } = apFixture('ap-ng-02');
    mockGetDeviceDetail.mockResolvedValue({
      device,
      profile: null,
      config: null,
      clients: null,
      mistAp: stats,
      dataSource: 'live',
    });
    quietDeps();

    renderDeviceDetail('ap-ng-02');

    expect(await screen.findByText('AP health & RF')).toBeTruthy();
    // The AP32 publishes no env_stat block — the honest sentence, no °C.
    expect(screen.getByText('not reported — this AP published no env sensor readings')).toBeTruthy();
    expect(screen.queryByText(/°C/)).toBeNull();
    expect(screen.getByText('PoE 802.3af')).toBeTruthy();
    expect(screen.queryByText('power constrained')).toBeNull();
    // Radios still render from the row that did land.
    expect(screen.getByText('ch 100 · 40 MHz · 14 dBm · noise -95 dBm · 5 clients')).toBeTruthy();
  });

  it('live: a PoE-constrained AP carries the warning badge verbatim', async () => {
    const { device, stats } = apFixture('ap-3f-14');
    mockGetDeviceDetail.mockResolvedValue({
      device,
      profile: null,
      config: null,
      clients: null,
      mistAp: stats,
      dataSource: 'live',
    });
    quietDeps();

    renderDeviceDetail('ap-3f-14');

    expect(await screen.findByText('power constrained')).toBeTruthy();
    // Channel 116 with the non-Wi-Fi spike — the NET-4188 DFS story.
    expect(screen.getByText('ch 116 · 40 MHz · 13 dBm · noise -93 dBm · 12 clients')).toBeTruthy();
    expect(screen.getByText('non-Wi-Fi 22%')).toBeTruthy();
  });

  it('demo: the authored-profile branch renders the same panel ahead of the fixture port list', async () => {
    const { device, stats } = apFixture('ap-3f-12');
    const profile = deviceProfile('ap-3f-12');
    mockGetDeviceDetail.mockResolvedValue({
      device,
      profile,
      config: DEVICE_CONFIGS[profile.kind],
      clients: DEVICE_CLIENT_SETS[profile.kind],
      mistAp: stats,
      dataSource: 'demo',
    });
    quietDeps();

    renderDeviceDetail('ap-3f-12');

    expect(await screen.findByText('AP health & RF')).toBeTruthy();
    expect(screen.getByText('util 58%')).toBeTruthy();
    // The claim code fact rides the authored identity rail too.
    expect(screen.getByText('KV4M9Q2X7RND3H1')).toBeTruthy();
  });

  it('live: a non-Mist device with mistAp null renders no panel at all', async () => {
    const device = DEVICES.find((d) => d.name === 'sw-core-a');
    if (!device) throw new Error('fixture missing');
    mockGetDeviceDetail.mockResolvedValue({
      device,
      profile: null,
      config: null,
      clients: null,
      mistAp: null,
      dataSource: 'live',
    });
    quietDeps();

    renderDeviceDetail('sw-core-a');

    expect(await screen.findByRole('heading', { name: 'sw-core-a' })).toBeTruthy();
    expect(screen.queryByText('AP health & RF')).toBeNull();
    expect(screen.queryByText('KV4M9Q2X7RND3H1')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// (m) HARDWARE TRENDS PANEL — Central's per-device telemetry: mounted only
//     where a claiming plane can answer for the class, fetched on demand for
//     the one device being viewed, in both render branches
// ---------------------------------------------------------------------------

describe('DeviceDetail — hardware trends panel', () => {
  const swCoreA = () => {
    const device = DEVICES.find((d) => d.name === 'sw-core-a');
    if (!device) throw new Error('fixture missing');
    return device;
  };

  const trendMocks = () => {
    mockGetDeviceHardwareTrends.mockResolvedValue({
      kind: 'ok',
      live: SWITCH_HARDWARE_TRENDS_DEMO['sw-core-a']!,
    });
    mockGetDeviceInterfaceTrends.mockResolvedValue({
      kind: 'ok',
      live: SWITCH_INTERFACE_TRENDS_DEMO['sw-core-a']!,
    });
  };

  it('live mode: a Central-claimed switch gets the panel, fetched for this one device', async () => {
    mockGetDeviceDetail.mockResolvedValue({
      device: { ...swCoreA(), plane: 'CENTRAL', planeTone: 'accent' },
      profile: null,
      config: null,
      clients: null,
      dataSource: 'live',
    });
    mockGetTerminalSessions.mockResolvedValue([]);
    mockGetTerminalSession.mockResolvedValue(null);
    mockGetTickets.mockResolvedValue({ tickets: [], dataSource: 'demo' });
    trendMocks();

    renderDeviceDetail('sw-core-a');

    expect(await screen.findByText('Hardware trends')).toBeTruthy();
    // The authored excursion's last bucket, from the trend read — not the
    // profile's authored stat row (this payload carries none).
    expect(await screen.findByText('87%')).toBeTruthy();
    expect(screen.getByText('Interface errors')).toBeTruthy();
    expect(screen.getByText('31 in the window')).toBeTruthy();

    // One on-demand read per dataset, addressed to the row's exact identity.
    expect(mockGetDeviceHardwareTrends).toHaveBeenCalledTimes(1);
    const [name, window, identity] = mockGetDeviceHardwareTrends.mock.calls[0]!;
    expect(name).toBe('sw-core-a');
    expect(identity).toEqual({ plane: 'CENTRAL', serial: undefined });
    expect(Date.parse(window.end) - Date.parse(window.start)).toBe(24 * 60 * 60_000);
    expect(mockGetDeviceInterfaceTrends).toHaveBeenCalledTimes(1);
  });

  it('live mode: a LOCAL-only switch gets no panel at all — no claiming plane can answer', async () => {
    mockGetDeviceDetail.mockResolvedValue({
      device: { ...swCoreA(), plane: 'LOCAL', planeTone: 'neutral', claimedBy: ['LOCAL'] },
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
    expect(screen.queryByText('Hardware trends')).toBeNull();
    expect(mockGetDeviceHardwareTrends).not.toHaveBeenCalled();
    expect(mockGetDeviceInterfaceTrends).not.toHaveBeenCalled();
  });

  it('live mode: a Mist AP gets no Central trend panel — the plane cannot answer it', async () => {
    const device = DEVICES.find((d) => d.name === 'ap-3f-12');
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

    renderDeviceDetail('ap-3f-12');

    expect(await screen.findByRole('heading', { name: 'ap-3f-12' })).toBeTruthy();
    expect(screen.queryByText('Hardware trends')).toBeNull();
    expect(mockGetDeviceApTrends).not.toHaveBeenCalled();
  });

  it('demo mode: the profile view renders the same panel from the authored read', async () => {
    const profile = deviceProfile('sw-core-a');
    mockGetDeviceDetail.mockResolvedValue({
      device: swCoreA(),
      profile,
      config: DEVICE_CONFIGS[profile.kind],
      clients: DEVICE_CLIENT_SETS[profile.kind],
      dataSource: 'demo',
    });
    mockGetTerminalSessions.mockResolvedValue([]);
    mockGetTerminalSession.mockResolvedValue(null);
    mockGetTickets.mockResolvedValue({ tickets: [], dataSource: 'demo' });
    trendMocks();

    renderDeviceDetail('sw-core-a');

    expect(await screen.findByText('Hardware trends')).toBeTruthy();
    expect(await screen.findByText('87%')).toBeTruthy();
    // The gap stays a gap in the demo render too.
    expect(
      (await screen.findAllByRole('img', { name: /line broken where samples are missing/ })).length,
    ).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('31 in the window')).toBeTruthy();
  });
});
