import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useParams } from 'react-router-dom';
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
          <Routes>
            <Route path="/" element={<Systems />} />
            <Route path="/sites/:siteId" element={<SiteStub />} />
          </Routes>
        </SettingsProvider>
      </ToastProvider>
    </MemoryRouter>,
  );
}

/** Stands in for SiteDetail so a drill-down is observable by its param. */
function SiteStub() {
  const { siteId } = useParams();
  return <div>site page {siteId}</div>;
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
    // The meta line counts the rows actually rendered — the authored set is
    // eight planes, so the design's '7 LINKED' literal was a stale claim.
    expect(screen.getByText(`${SYSTEMS.length} LINKED · SELECT ONE FOR DETAIL`)).toBeTruthy();
    expect(screen.queryByText('7 LINKED · SELECT ONE FOR DETAIL')).toBeNull();
    // An authored payload says so rather than borrowing a live sync stamp.
    expect(screen.getByText('DEMO FIXTURE')).toBeTruthy();
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

describe('Systems live registry facts', () => {
  /** A single live Central row whose registry entry the test parameterises. */
  function liveCentral(state: Partial<LivePlaneState>): void {
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
          scopeNote: 'no write path from the portal to this plane',
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
      registry({ central: unlinked('central', { linked: true, ...state }) }),
    );
    mockGetPortalSettings.mockResolvedValue(null);
    mockGetChatStatus.mockResolvedValue(null);
    mockGetChatSettings.mockResolvedValue(null);
  }

  it('reads "Calls today" against the served daily budget, not as a bare count', async () => {
    liveCentral({
      health: 'healthy',
      lastSync: new Date().toISOString(),
      callsToday: 1204,
      callBudget: 20000,
    });

    renderSystems();

    await waitFor(() => expect(screen.getByText('HPE Aruba Central')).toBeTruthy());
    // The denominator the registry serves is what makes the count mean
    // anything — the client merge must not overwrite it with '1204'.
    expect(screen.getByText('1,204 / 20,000')).toBeTruthy();
    expect(screen.queryByText('1204')).toBeNull();
  });

  it('keeps the bare count when the plane publishes no budget', async () => {
    liveCentral({ health: 'healthy', lastSync: new Date().toISOString(), callsToday: 88 });

    renderSystems();

    await waitFor(() => expect(screen.getByText('HPE Aruba Central')).toBeTruthy());
    expect(screen.getByText('88')).toBeTruthy();
    // No tier is known, so no limit is invented.
    expect(screen.queryByText(/88 \//)).toBeNull();
  });

  it('marks a plane the registry reports stale as unverified, and names its retry state', async () => {
    liveCentral({
      health: 'degraded',
      lastSync: new Date(Date.now() - 6 * 3600_000).toISOString(),
      deviceCount: 41,
      callsToday: 12,
      note: 'poll failed: 503',
      stale: true,
      ageSec: 6 * 3600,
      consecutiveFailures: 3,
      nextAttemptAt: new Date(Date.now() + 120_000).toISOString(),
    });

    renderSystems();

    await waitFor(() => expect(screen.getByText('HPE Aruba Central')).toBeTruthy());
    // The row's own count is last-good, not current — say so.
    expect(screen.getByText('unverified')).toBeTruthy();

    fireEvent.click(screen.getByText('HPE Aruba Central'));
    await waitFor(() => expect(screen.getByText('Sites on this plane')).toBeTruthy());
    expect(screen.getAllByText('unverified').length).toBeGreaterThan(1);
    expect(screen.getByText(/^3 consecutive failed polls · next attempt \d\d:\d\d$/)).toBeTruthy();
  });

  it('leaves a fresh live plane unmarked', async () => {
    liveCentral({
      health: 'healthy',
      lastSync: new Date().toISOString(),
      deviceCount: 41,
      callsToday: 12,
      stale: false,
      ageSec: 12,
      consecutiveFailures: 0,
    });

    renderSystems();

    await waitFor(() => expect(screen.getByText('HPE Aruba Central')).toBeTruthy());
    expect(screen.queryByText('unverified')).toBeNull();
    expect(screen.queryByText(/consecutive failed poll/)).toBeNull();
  });
});

describe('Systems plane drawer', () => {
  it('drills into a site the plane names and closes the drawer first', async () => {
    mockGetSystems.mockResolvedValue(DEMO_PAYLOAD);
    mockGetSystemsState.mockResolvedValue(registry());
    mockGetPortalSettings.mockResolvedValue(null);
    mockGetChatStatus.mockResolvedValue(null);
    mockGetChatSettings.mockResolvedValue(null);

    renderSystems();

    await waitFor(() => expect(screen.getByText('HPE Aruba Central')).toBeTruthy());
    fireEvent.click(screen.getByText('HPE Aruba Central'));
    await waitFor(() => expect(screen.getByText('Sites on this plane')).toBeTruthy());

    // Every fixture site row here carries a siteId; a 'Workspace-wide' row
    // (siteId null) stays inert, so only real sites are clickable.
    fireEvent.click(screen.getByRole('button', { name: 'Campus-01 — Meridian HQ' }));

    await waitFor(() => expect(screen.getByText('site page campus-01')).toBeTruthy());
    expect(screen.queryByText('Sites on this plane')).toBeNull();
  });

  it('stamps a live payload with its own sync time rather than a demo label', async () => {
    mockGetSystems.mockResolvedValue({
      systems: [],
      syncHistory: [],
      permissions: PERMISSIONS,
      dataSource: 'live',
      syncedAt: '2026-03-04T09:05:00.000Z',
    });
    mockGetSystemsState.mockResolvedValue(registry());
    mockGetPortalSettings.mockResolvedValue(null);
    mockGetChatStatus.mockResolvedValue(null);
    mockGetChatSettings.mockResolvedValue(null);

    renderSystems();

    await waitFor(() => expect(screen.getByText('Connected systems')).toBeTruthy());
    expect(screen.getByText(/^LIVE · SYNCED /)).toBeTruthy();
    expect(screen.queryByText('DEMO FIXTURE')).toBeNull();
    // No plane rows means no linked planes — the meta must not claim seven.
    expect(screen.getByText('0 LINKED · SELECT ONE FOR DETAIL')).toBeTruthy();
  });
});

describe('Systems console hand-off', () => {
  /** Open a plane's drawer and switch to the Configuration tab. */
  async function openConfigTab(planeName: string) {
    mockGetSystems.mockResolvedValue(DEMO_PAYLOAD);
    mockGetSystemsState.mockResolvedValue(registry());
    mockGetPortalSettings.mockResolvedValue(null);
    mockGetChatStatus.mockResolvedValue(null);
    mockGetChatSettings.mockResolvedValue(null);

    renderSystems();

    await waitFor(() => expect(screen.getByText(planeName)).toBeTruthy());
    fireEvent.click(screen.getByText(planeName));
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Configuration' })).toBeTruthy());
    fireEvent.click(screen.getByRole('tab', { name: 'Configuration' }));
    await waitFor(() => expect(screen.getByText('Credential & connection')).toBeTruthy());
  }

  it('opens the plane console the row actually records', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue({} as Window);
    await openConfigTab('HPE Aruba Central');

    const button = screen.getByRole('button', { name: 'Open console ↗' });
    expect(button).toHaveProperty('disabled', false);
    fireEvent.click(button);

    expect(open).toHaveBeenCalledWith(
      'https://app-us4.central.arubanetworks.com',
      '_blank',
      'noopener',
    );
    open.mockRestore();
  });

  it('stays inert for the local collector, which deliberately has no console', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue({} as Window);
    await openConfigTab('Local switch collector');

    const button = screen.getByRole('button', { name: 'Open console ↗' });
    // Disabled, not a toast claiming a hand-off — and no invented URL.
    expect(button).toHaveProperty('disabled', true);
    fireEvent.click(button);
    expect(open).not.toHaveBeenCalled();
    expect(
      screen.getByText('no console URL recorded for Local switch collector — nothing to hand off to'),
    ).toBeTruthy();
    open.mockRestore();
  });

  it('reports a blocked popup instead of letting the click look successful', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    await openConfigTab('HPE Aruba Central');

    fireEvent.click(screen.getByRole('button', { name: 'Open console ↗' }));

    await waitFor(() =>
      expect(screen.getByText('Could not open the HPE Aruba Central console')).toBeTruthy(),
    );
    open.mockRestore();
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
    // The optional CoA enforcement profile is rendered but left blank here,
    // and a blank optional field is NOT sent — the adapter then uses the
    // publisher default rather than a wrong profile name that fails the CoA.
    expect(screen.getByLabelText('CoA enforcement profile — optional')).toBeTruthy();
    expect(creds.coaEnforcementProfile).toBeUndefined();
  });

  it('sends the optional CoA enforcement profile under the key the adapter honours', async () => {
    mockGetSystems.mockResolvedValue(DEMO_PAYLOAD);
    mockGetSystemsState.mockResolvedValue(registry());
    mockGetPortalSettings.mockResolvedValue(null);
    mockGetChatStatus.mockResolvedValue(null);
    mockGetChatSettings.mockResolvedValue(null);
    mockTestSystem.mockResolvedValue({ ok: true, message: 'authenticated' });

    renderSystems();

    await waitFor(() => expect(screen.getByText('Connect a system')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Connect a system' }));
    fireEvent.change(screen.getByLabelText('System type'), { target: { value: 'clearpass' } });
    await waitFor(() => expect(screen.getByText('ClearPass publisher URL')).toBeTruthy());

    fireEvent.change(screen.getByLabelText('ClearPass publisher URL'), {
      target: { value: 'cppm-01.meridian.health' },
    });
    fireEvent.change(screen.getByLabelText('API token'), { target: { value: 'tok-123' } });
    fireEvent.change(screen.getByLabelText('CoA enforcement profile — optional'), {
      target: { value: 'Quarantine-Profile' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }));

    await waitFor(() => expect(mockTestSystem).toHaveBeenCalled());
    const [, creds] = mockTestSystem.mock.calls[0]!;
    expect(creds.coaEnforcementProfile).toBe('Quarantine-Profile');
    expect(creds.host).toBe('cppm-01.meridian.health');
    expect(creds.token).toBe('tok-123');
  });
});
