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
import { DEVICE_CLIENT_SETS, DEVICE_CONFIGS, DEVICES, deviceProfile } from '../../../shared';

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

    // Identity facts come from the reconciled inventory row.
    expect(screen.getByText('LIVE POLLER CACHE')).toBeTruthy();
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
    expect(
      screen.getByText(
        'Live inventory evidence coverage is available; running-configuration drift remains unavailable.',
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
        mockGetTerminalSessions
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([
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
        expect(mockGetTerminalSessions).toHaveBeenCalledTimes(2);
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
