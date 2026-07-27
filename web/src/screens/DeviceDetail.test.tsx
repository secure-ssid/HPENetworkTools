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
import type { DeviceEvidence } from '../../../shared';

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

    // The class block declares itself missing instead of vanishing.
    expect(
      screen.getByText(
        'Not available in live mode — no linked plane reports per-port state for this device.',
      ),
    ).toBeTruthy();

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
