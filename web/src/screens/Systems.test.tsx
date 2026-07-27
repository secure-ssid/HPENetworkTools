import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Systems from './Systems';
import { SettingsProvider } from '../app/SettingsContext';
import { ToastProvider } from '../nightdesk';
import {
  getChatSettings,
  getChatStatus,
  getPortalSettings,
  getSystems,
  getSystemsState,
  testSystem,
} from '../api/client';
import type { LivePlaneState, SystemsData, SystemsState } from '../api/client';
import { PERMISSIONS, SYNC_HISTORY, SYSTEMS } from '../../../shared';

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
    getSystems: vi.fn(),
    getSystemsState: vi.fn(),
    getPortalSettings: vi.fn(),
    getChatStatus: vi.fn(),
    getChatSettings: vi.fn(),
    testSystem: vi.fn(),
  };
});

const mockGetSystems = vi.mocked(getSystems);
const mockGetSystemsState = vi.mocked(getSystemsState);
const mockGetPortalSettings = vi.mocked(getPortalSettings);
const mockGetChatStatus = vi.mocked(getChatStatus);
const mockGetChatSettings = vi.mocked(getChatSettings);
const mockTestSystem = vi.mocked(testSystem);

/** A registry entry as a stock install reports it: nothing configured. */
function unlinked(id: string, over: Partial<LivePlaneState> = {}): LivePlaneState {
  return {
    id,
    linked: false,
    health: 'unlinked',
    lastSync: null,
    deviceCount: null,
    callsToday: 0,
    note: 'no credentials configured',
    recentCalls: [],
    ...over,
  };
}

function registry(over: Record<string, LivePlaneState> = {}): SystemsState {
  const planes: Record<string, LivePlaneState> = {};
  for (const id of ['central', 'mist', 'classic', 'greenlake', 'aos8', 'local', 'clearpass', 'uxi']) {
    planes[id] = unlinked(id);
  }
  return { demoMode: true, planes: { ...planes, ...over }, history: [] };
}

const DEMO_PAYLOAD: SystemsData = {
  systems: SYSTEMS,
  syncHistory: SYNC_HISTORY,
  permissions: PERMISSIONS,
  dataSource: 'demo',
};

function renderSystems() {
  return render(
    <MemoryRouter>
      <ToastProvider>
        <SettingsProvider>
          <Systems />
        </SettingsProvider>
      </ToastProvider>
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('Systems demo/live merge', () => {
  it('renders a demo payload as authored instead of stamping it with the empty registry', async () => {
    mockGetSystems.mockResolvedValue(DEMO_PAYLOAD);
    mockGetSystemsState.mockResolvedValue(registry());
    mockGetPortalSettings.mockResolvedValue(null);
    mockGetChatStatus.mockResolvedValue(null);
    mockGetChatSettings.mockResolvedValue(null);

    renderSystems();

    await waitFor(() => expect(screen.getByText('HPE Aruba Central')).toBeTruthy());
    // The authored fact strip survives: no row reads "never / 0" beside 164.
    expect(screen.getByText('40s ago')).toBeTruthy();
    expect(screen.getByText('164')).toBeTruthy();
    expect(screen.getByText('9,412 / 50k')).toBeTruthy();
    expect(screen.queryByText('never')).toBeNull();
    expect(screen.getByText('7 LINKED · SELECT ONE FOR DETAIL')).toBeTruthy();
    // Demo keeps the authored Classic incident.
    expect(screen.getByText('Central Classic is throttling us')).toBeTruthy();
  });

  it('drops the authored throttling banner in live mode and derives it from real 429s', async () => {
    mockGetSystems.mockResolvedValue({
      systems: [
        {
          name: 'HPE Aruba Central',
          planeId: 'central',
          kind: 'live plane registry',
          state: 'healthy',
          tone: 'success',
          scope: 'read only',
          scopeTone: 'neutral',
          scopeNote: 'brokered writes where the plane supports them',
          facts: [
            { k: 'Last sync', v: '—' },
            { k: 'Devices', v: '—' },
            { k: 'Calls today', v: '0' },
          ],
          sites: [],
          live: [],
          calls: [],
          events: [],
          pulls: [],
          configText: 'plane: central',
        },
      ],
      syncHistory: [],
      permissions: PERMISSIONS,
      dataSource: 'live',
    });
    mockGetSystemsState.mockResolvedValue(
      registry({
        central: unlinked('central', {
          linked: true,
          health: 'warning',
          lastSync: new Date().toISOString(),
          deviceCount: 41,
          callsToday: 120,
          note: 'rate limited',
          recentCalls: [
            { time: new Date().toISOString(), path: '/monitoring/v2/aps', ms: 210, code: '429' },
            { time: new Date().toISOString(), path: '/monitoring/v2/aps', ms: 190, code: '200' },
          ],
        }),
      }),
    );
    mockGetPortalSettings.mockResolvedValue(null);
    mockGetChatStatus.mockResolvedValue(null);
    mockGetChatSettings.mockResolvedValue(null);

    renderSystems();

    await waitFor(() => expect(screen.getByText('HPE Aruba Central')).toBeTruthy());
    expect(screen.queryByText('Central Classic is throttling us')).toBeNull();
    expect(screen.getByText('HPE Aruba Central is throttling us')).toBeTruthy();
    expect(screen.getByText(/1 of the last 2 calls/)).toBeTruthy();
    // The live fact strip carries the registry values, not '—'.
    expect(screen.getByText('41')).toBeTruthy();
    expect(screen.getByText('120')).toBeTruthy();
    expect(screen.getByText('1 LINKED · SELECT ONE FOR DETAIL')).toBeTruthy();
  });

  it('shows no throttling banner at all when a live registry reports no 429s', async () => {
    mockGetSystems.mockResolvedValue({
      systems: [],
      syncHistory: [],
      permissions: PERMISSIONS,
      dataSource: 'live',
    });
    mockGetSystemsState.mockResolvedValue(registry());
    mockGetPortalSettings.mockResolvedValue(null);
    mockGetChatStatus.mockResolvedValue(null);
    mockGetChatSettings.mockResolvedValue(null);

    renderSystems();

    await waitFor(() => expect(screen.getByText('Connected systems')).toBeTruthy());
    expect(screen.queryByText('Central Classic is throttling us')).toBeNull();
    expect(screen.queryByText(/is throttling us$/)).toBeNull();
  });
});

describe('Systems connect drawer', () => {
  it('saves each credential under the key the chosen adapter reads', async () => {
    mockGetSystems.mockResolvedValue(DEMO_PAYLOAD);
    mockGetSystemsState.mockResolvedValue(registry());
    mockGetPortalSettings.mockResolvedValue(null);
    mockGetChatStatus.mockResolvedValue(null);
    mockGetChatSettings.mockResolvedValue(null);
    mockTestSystem.mockResolvedValue({ ok: true, message: 'authenticated' });

    renderSystems();

    await waitFor(() => expect(screen.getByText('Connect a system')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Connect a system' }));

    // ClearPass: publisher URL under 'host', plus the API token the adapter's
    // isComplete() requires — neither was ever sent before.
    fireEvent.change(screen.getByLabelText('System type'), { target: { value: 'clearpass' } });
    await waitFor(() => expect(screen.getByText('ClearPass publisher URL')).toBeTruthy());
    fireEvent.change(screen.getByLabelText('ClearPass publisher URL'), {
      target: { value: 'cppm-01.meridian.health' },
    });
    fireEvent.change(screen.getByLabelText('API token'), { target: { value: 'tok-123' } });
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }));

    await waitFor(() => expect(mockTestSystem).toHaveBeenCalled());
    const [plane, creds] = mockTestSystem.mock.calls[0]!;
    expect(plane).toBe('clearpass');
    expect(creds.host).toBe('cppm-01.meridian.health');
    expect(creds.token).toBe('tok-123');
    expect(creds.publisher).toBeUndefined();
  });
});
