import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
  saveSystemCredentials,
  testSystem,
} from '../api/client';
import type { LivePlaneState, SystemsData, SystemsState } from '../api/client';
import { PERMISSIONS, SYNC_HISTORY, SYSTEMS } from '@hpe/shared';
import type { SystemRow } from '@hpe/shared';

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
    saveSystemCredentials: vi.fn(),
    testSystem: vi.fn(),
  };
});

const mockGetSystems = vi.mocked(getSystems);
const mockGetSystemsState = vi.mocked(getSystemsState);
const mockGetPortalSettings = vi.mocked(getPortalSettings);
const mockGetChatStatus = vi.mocked(getChatStatus);
const mockGetChatSettings = vi.mocked(getChatSettings);
const mockSaveSystemCredentials = vi.mocked(saveSystemCredentials);
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

function renderSystems(initialEntry = '/') {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <ToastProvider>
        <SettingsProvider>
          <Routes>
            <Route path="/" element={<Systems />} />
            <Route path="/systems" element={<Systems />} />
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

  /* An operator whose Central stopped answering had to open the drawer to
     find out why — the reason the registry had already written sat there in
     the same muted grey as a healthy plane's summary. It belongs on the page. */
  it('names a failing plane and its reason on the page, above the throttle banner', async () => {
    const centralRow: SystemRow = { ...SYSTEMS[0]!, name: 'Central', planeId: 'central' };
    mockGetSystems.mockResolvedValue({
      systems: [centralRow],
      syncHistory: [],
      permissions: PERMISSIONS,
      dataSource: 'live',
    });
    mockGetSystemsState.mockResolvedValue({
      demoMode: false,
      planes: {
        central: {
          id: 'central',
          linked: true,
          health: 'degraded',
          lastSync: null,
          deviceCount: null,
          callsToday: 4,
          note: 'poll failed: auth: neither token endpoint accepted these credentials',
          // A 429 in the ring buffer too: the throttle banner would also fire,
          // and the plane that is not being read at all is the bigger news.
          recentCalls: [{ time: '11:00', path: '/monitoring/v2/aps', ms: 40, code: '429' }],
          consecutiveFailures: 4,
        },
      },
      history: [],
    });
    mockGetPortalSettings.mockResolvedValue(null);
    mockGetChatStatus.mockResolvedValue(null);
    mockGetChatSettings.mockResolvedValue(null);

    renderSystems();

    await waitFor(() => expect(screen.getByText('Central is not being polled successfully')).toBeTruthy());
    expect(screen.getByText(/neither token endpoint accepted these credentials/)).toBeTruthy();
    expect(screen.getByText(/never completed one/)).toBeTruthy();
    expect(screen.queryByText('Central is throttling us')).toBeNull();
  });

  it('collapses the planes that hold no credentials behind one expandable line', async () => {
    const linkedRow: SystemRow = {
      ...SYSTEMS[0]!,
      name: 'SecureSSID-LAB-Central',
      planeId: 'central',
    };
    const darkRow: SystemRow = { ...SYSTEMS[1]!, name: 'Mist', planeId: 'mist' };
    mockGetSystems.mockResolvedValue({
      systems: [linkedRow, darkRow],
      syncHistory: [],
      permissions: PERMISSIONS,
      dataSource: 'live',
    });
    mockGetSystemsState.mockResolvedValue({
      demoMode: false,
      planes: {
        central: {
          id: 'central',
          linked: true,
          health: 'healthy',
          lastSync: new Date().toISOString(),
          deviceCount: 13,
          callsToday: 7,
          note: null,
          recentCalls: [],
        },
        mist: unlinked('mist'),
      },
      history: [],
    });
    mockGetPortalSettings.mockResolvedValue(null);
    mockGetChatStatus.mockResolvedValue(null);
    mockGetChatSettings.mockResolvedValue(null);

    renderSystems();

    // The plane that answers is listed; the one that was never configured is not.
    await waitFor(() => expect(screen.getByText('SecureSSID-LAB-Central')).toBeTruthy());
    expect(screen.queryByText('Mist')).toBeNull();

    const toggle = screen.getByRole('button', { name: /1 system not linked/ });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('Mist')).toBeTruthy();

    // Collapsing puts it away again — the group is a real disclosure, not a filter.
    fireEvent.click(toggle);
    expect(screen.queryByText('Mist')).toBeNull();
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

describe('Systems drawer actions', () => {
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

  it('carries the destructive intent of Retire plane in the button variant', async () => {
    await openConfigTab('HPE Aruba Central');

    const retire = screen.getByRole('button', { name: 'Retire plane' });
    // The nightdesk danger variant, not a ghost button wearing an inline
    // colour: hover/active/focus states come with the variant, and a silent
    // regression back to ghost+inline would drop the destructive signal.
    expect(retire.className.split(/\s+/)).toContain('nd-btn--danger');
    expect(retire.getAttribute('style')).toBeNull();
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
    mockSaveSystemCredentials.mockResolvedValue({ ok: true, message: 'saved' });

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

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Save and index' }).hasAttribute('disabled')).toBe(
        false,
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save and index' }));
    await waitFor(() =>
      expect(mockSaveSystemCredentials).toHaveBeenCalledWith('clearpass', creds),
    );
  });

  /** Drives the drawer to a successful test and clicks Save, for the tests
   *  that only care about what the save reports back. */
  async function saveClearPass() {
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
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Save and index' }).hasAttribute('disabled')).toBe(
        false,
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save and index' }));
  }

  it('does not announce success over a plane that rejected the credentials', async () => {
    mockSaveSystemCredentials.mockResolvedValue({
      ok: true,
      indexed: 'error',
      message: 'credentials saved, but the first poll failed — the plane detail says why',
    });

    await saveClearPass();

    // The save succeeded and the plane did not. The toast title follows the
    // poll, because "Saved" over a plane that answered 401 is the failure this
    // screen exists to surface, dressed as the opposite.
    await waitFor(() =>
      expect(screen.getByText('Saved — but the plane did not answer')).toBeTruthy(),
    );
    expect(screen.getByText(/the first poll failed/)).toBeTruthy();
  });

  it('still says plainly Saved when the plane answered', async () => {
    // Over-application guard: the caution above is earned by a failed poll and
    // by nothing else. A save that worked gets no caveat, because a false
    // caveat is its own dishonesty.
    mockSaveSystemCredentials.mockResolvedValue({
      ok: true,
      indexed: 'ok',
      message: 'credentials saved and the plane indexed',
    });

    await saveClearPass();

    await waitFor(() => expect(screen.getByText('Saved')).toBeTruthy());
    expect(screen.queryByText('Saved — but the plane did not answer')).toBeNull();
    expect(screen.getByText('credentials saved and the plane indexed')).toBeTruthy();
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

  it('does not authorize credentials edited while their test is in flight', async () => {
    mockGetSystems.mockResolvedValue(DEMO_PAYLOAD);
    mockGetSystemsState.mockResolvedValue(registry());
    mockGetPortalSettings.mockResolvedValue(null);
    mockGetChatStatus.mockResolvedValue(null);
    mockGetChatSettings.mockResolvedValue(null);
    let resolveTest!: (result: { ok: boolean; message: string }) => void;
    mockTestSystem.mockReturnValue(
      new Promise((resolve) => {
        resolveTest = resolve;
      }),
    );

    renderSystems();

    await waitFor(() => expect(screen.getByText('Connect a system')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Connect a system' }));
    fireEvent.change(screen.getByLabelText('System type'), { target: { value: 'clearpass' } });
    await waitFor(() => expect(screen.getByText('ClearPass publisher URL')).toBeTruthy());
    fireEvent.change(screen.getByLabelText('ClearPass publisher URL'), {
      target: { value: 'cppm-01.meridian.health' },
    });
    fireEvent.change(screen.getByLabelText('API token'), { target: { value: 'tested-token' } });
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }));
    await waitFor(() => expect(mockTestSystem).toHaveBeenCalled());

    fireEvent.change(screen.getByLabelText('API token'), { target: { value: 'untested-token' } });
    resolveTest({ ok: true, message: 'authenticated' });

    await waitFor(() => expect(screen.getByText('Re-test required')).toBeTruthy());
    const save = screen.getByRole('button', { name: 'Save and index' });
    expect(save.hasAttribute('disabled')).toBe(true);
    fireEvent.click(save);
    expect(mockSaveSystemCredentials).not.toHaveBeenCalled();
  });

  it('prefills the stored endpoint when re-keying another system type', async () => {
    const clearPassRow: SystemRow = {
      ...SYSTEMS.find((row) => row.name === 'ClearPass')!,
      planeId: 'clearpass',
      configText:
        'plane: clearpass\nlinked: true\nhost: https://cppm.custom.example\nscope: read only',
    };
    mockGetSystems.mockResolvedValue({
      systems: [clearPassRow],
      syncHistory: [],
      permissions: PERMISSIONS,
      dataSource: 'live',
    });
    mockGetSystemsState.mockResolvedValue({
      demoMode: false,
      planes: { clearpass: unlinked('clearpass', { linked: true, health: 'healthy' }) },
      history: [],
    });
    mockGetPortalSettings.mockResolvedValue(null);
    mockGetChatStatus.mockResolvedValue(null);
    mockGetChatSettings.mockResolvedValue(null);

    renderSystems();

    await waitFor(() => expect(screen.getByText('ClearPass')).toBeTruthy());
    fireEvent.click(screen.getByText('ClearPass'));
    fireEvent.click(await screen.findByRole('tab', { name: 'Configuration' }));
    fireEvent.click(screen.getByRole('button', { name: 'Re-key credentials' }));

    expect(screen.getByLabelText('ClearPass publisher URL')).toHaveProperty(
      'value',
      'https://cppm.custom.example',
    );
  });
});

describe('Systems connect drawer — SSE (token-only plane)', () => {
  it('hides the shared Client ID/secret pair and saves baseUrl + token under the keys the adapter reads', async () => {
    mockGetSystems.mockResolvedValue(DEMO_PAYLOAD);
    mockGetSystemsState.mockResolvedValue(registry());
    mockGetPortalSettings.mockResolvedValue(null);
    mockGetChatStatus.mockResolvedValue(null);
    mockGetChatSettings.mockResolvedValue(null);
    mockTestSystem.mockResolvedValue({ ok: true, message: 'authenticated' });

    renderSystems();

    await waitFor(() => expect(screen.getByText('Connect a system')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Connect a system' }));
    fireEvent.change(screen.getByLabelText('System type'), { target: { value: 'sse' } });

    await waitFor(() => expect(screen.getByLabelText('Admin API token')).toBeTruthy());
    // Token-only plane: the generic Client ID / Client secret block never renders.
    expect(screen.queryByLabelText('Client ID')).toBeNull();
    expect(screen.queryByLabelText('Client secret')).toBeNull();

    fireEvent.change(screen.getByLabelText('SSE Admin API base — optional'), {
      target: { value: 'admin-api.axissecurity.com' },
    });
    fireEvent.change(screen.getByLabelText('Admin API token'), { target: { value: 'sse-tok-123' } });
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }));

    await waitFor(() => expect(mockTestSystem).toHaveBeenCalled());
    const [plane, creds] = mockTestSystem.mock.calls[0]!;
    expect(plane).toBe('sse');
    expect(creds.baseUrl).toBe('admin-api.axissecurity.com');
    expect(creds.token).toBe('sse-tok-123');
    expect(creds.clientId).toBeUndefined();
    expect(creds.clientSecret).toBeUndefined();
  });

  it('re-keys against the stored custom base URL and saves the tested snapshot', async () => {
    const sseRow: SystemRow = {
      ...SYSTEMS[0]!,
      name: 'HPE Aruba Networking SSE',
      planeId: 'sse',
      configText:
        'plane: sse\nlinked: true\nbaseUrl: https://sse.custom.example/api\nscope: read only',
    };
    mockGetSystems.mockResolvedValue({
      systems: [sseRow],
      syncHistory: [],
      permissions: PERMISSIONS,
      dataSource: 'live',
    });
    mockGetSystemsState.mockResolvedValue({
      demoMode: false,
      planes: { sse: unlinked('sse', { linked: true, health: 'healthy' }) },
      history: [],
    });
    mockGetPortalSettings.mockResolvedValue(null);
    mockGetChatStatus.mockResolvedValue(null);
    mockGetChatSettings.mockResolvedValue(null);
    mockTestSystem.mockResolvedValue({ ok: true, message: 'authenticated' });
    mockSaveSystemCredentials.mockResolvedValue({ ok: true, message: 'saved' });

    renderSystems();

    await waitFor(() => expect(screen.getByText('HPE Aruba Networking SSE')).toBeTruthy());
    fireEvent.click(screen.getByText('HPE Aruba Networking SSE'));
    fireEvent.click(await screen.findByRole('tab', { name: 'Configuration' }));
    fireEvent.click(screen.getByRole('button', { name: 'Re-key credentials' }));

    expect(screen.getByLabelText('SSE Admin API base — optional')).toHaveProperty(
      'value',
      'https://sse.custom.example/api',
    );
    fireEvent.change(screen.getByLabelText('Admin API token'), { target: { value: 'new-token' } });
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }));

    await waitFor(() =>
      expect(mockTestSystem).toHaveBeenCalledWith('sse', {
        displayName: 'HPE Aruba Networking SSE',
        baseUrl: 'https://sse.custom.example/api',
        token: 'new-token',
        scopes: ['read:inventory', 'read:clients-auth', 'read:config-licences'],
      }),
    );
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Save and index' }).hasAttribute('disabled')).toBe(
        false,
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save and index' }));
    await waitFor(() =>
      expect(mockSaveSystemCredentials).toHaveBeenCalledWith(
        'sse',
        mockTestSystem.mock.calls[0]![1],
      ),
    );
  });
});

describe('Systems connect drawer — credential hygiene', () => {
  it('never sends a hidden stale client secret after switching Central → SSE', async () => {
    mockGetSystems.mockResolvedValue(DEMO_PAYLOAD);
    mockGetSystemsState.mockResolvedValue(registry());
    mockGetPortalSettings.mockResolvedValue(null);
    mockGetChatStatus.mockResolvedValue(null);
    mockGetChatSettings.mockResolvedValue(null);
    mockTestSystem.mockResolvedValue({ ok: true, message: 'authenticated' });

    renderSystems();

    await waitFor(() => expect(screen.getByText('Connect a system')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Connect a system' }));

    // Default type is Central, which shows the shared Client ID/secret pair —
    // fill both in before switching to a token-only plane.
    await waitFor(() => expect(screen.getByLabelText('Client ID')).toBeTruthy());
    fireEvent.change(screen.getByLabelText('Client ID'), { target: { value: 'a41f-central' } });
    fireEvent.change(screen.getByLabelText('Client secret'), { target: { value: 'shh-central-secret' } });

    fireEvent.change(screen.getByLabelText('System type'), { target: { value: 'sse' } });
    await waitFor(() => expect(screen.getByLabelText('Admin API token')).toBeTruthy());
    // The now-irrelevant pair must not still render, hidden, with the old
    // plane's values trapped inside it.
    expect(screen.queryByLabelText('Client ID')).toBeNull();
    expect(screen.queryByLabelText('Client secret')).toBeNull();

    fireEvent.change(screen.getByLabelText('Admin API token'), { target: { value: 'sse-tok-999' } });
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }));

    await waitFor(() => expect(mockTestSystem).toHaveBeenCalled());
    const [plane, creds] = mockTestSystem.mock.calls[0]!;
    expect(plane).toBe('sse');
    expect(creds.token).toBe('sse-tok-999');
    expect(creds.clientId).toBeUndefined();
    expect(creds.clientSecret).toBeUndefined();
  });

  it('clears the prior plane endpoint, extra fields and scope selection on a type switch', async () => {
    mockGetSystems.mockResolvedValue(DEMO_PAYLOAD);
    mockGetSystemsState.mockResolvedValue(registry());
    mockGetPortalSettings.mockResolvedValue(null);
    mockGetChatStatus.mockResolvedValue(null);
    mockGetChatSettings.mockResolvedValue(null);
    mockTestSystem.mockResolvedValue({ ok: true, message: 'authenticated' });

    renderSystems();

    await waitFor(() => expect(screen.getByText('Connect a system')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Connect a system' }));

    // Central: set an endpoint, uncheck a default-on read scope, and check the
    // write scope — all of this belongs to Central and must not survive.
    fireEvent.change(screen.getByLabelText('Central region / base URL'), {
      target: { value: 'us4.api.central.arubanetworks.com' },
    });
    fireEvent.click(
      screen.getByLabelText('Read configuration and licences'),
    );
    fireEvent.click(
      screen.getByLabelText('Brokered write — config push, requires a ticket reference'),
    );
    expect(
      screen.getByLabelText('Brokered write — config push, requires a ticket reference'),
    ).toHaveProperty('checked', true);

    fireEvent.change(screen.getByLabelText('System type'), { target: { value: 'clearpass' } });
    await waitFor(() => expect(screen.getByText('ClearPass publisher URL')).toBeTruthy());

    // Endpoint is the clearpass variant, blank — not Central's leftover value.
    expect(screen.getByLabelText('ClearPass publisher URL')).toHaveProperty('value', '');
    // Scopes reset to the connect-drawer defaults: read flags back on, write off.
    expect(
      screen.getByLabelText('Read configuration and licences'),
    ).toHaveProperty('checked', true);
    expect(
      screen.getByLabelText('Brokered write — config push, requires a ticket reference'),
    ).toHaveProperty('checked', false);

    fireEvent.change(screen.getByLabelText('ClearPass publisher URL'), {
      target: { value: 'cppm-01.meridian.health' },
    });
    fireEvent.change(screen.getByLabelText('API token'), { target: { value: 'tok-123' } });
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }));

    await waitFor(() => expect(mockTestSystem).toHaveBeenCalled());
    const [, creds] = mockTestSystem.mock.calls[0]!;
    expect(creds.scopes).toEqual(['read:inventory', 'read:clients-auth', 'read:config-licences']);
  });

  it('re-keys a writable SSE plane with its write scope prefilled and preserved', async () => {
    const sseRow: SystemRow = {
      ...SYSTEMS[0]!,
      name: 'HPE Aruba Networking SSE',
      planeId: 'sse',
      configText:
        'plane: sse\nlinked: true\nbaseUrl: https://sse.custom.example/api\nscope: read only',
    };
    mockGetSystems.mockResolvedValue({
      systems: [sseRow],
      syncHistory: [],
      permissions: PERMISSIONS,
      dataSource: 'live',
    });
    mockGetSystemsState.mockResolvedValue({
      demoMode: false,
      planes: {
        sse: unlinked('sse', {
          linked: true,
          health: 'healthy',
          capabilities: { localShell: false, brokeredWrite: false, configRead: false, directWrite: true },
        }),
      },
      history: [],
    });
    mockGetPortalSettings.mockResolvedValue(null);
    mockGetChatStatus.mockResolvedValue(null);
    mockGetChatSettings.mockResolvedValue(null);
    mockTestSystem.mockResolvedValue({ ok: true, message: 'authenticated' });

    renderSystems();

    await waitFor(() => expect(screen.getByText('HPE Aruba Networking SSE')).toBeTruthy());
    fireEvent.click(screen.getByText('HPE Aruba Networking SSE'));
    fireEvent.click(await screen.findByRole('tab', { name: 'Configuration' }));
    fireEvent.click(screen.getByRole('button', { name: 'Re-key credentials' }));

    // Token rotation must not silently downgrade directWrite: the write
    // checkbox comes in already checked, reflecting the plane's real grant.
    expect(
      screen.getByLabelText(
        'Direct write — reviewed SSE object mutations followed by tenant-wide Commit',
      ),
    ).toHaveProperty('checked', true);

    fireEvent.change(screen.getByLabelText('Admin API token'), { target: { value: 'rotated-token' } });
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }));

    await waitFor(() =>
      expect(mockTestSystem).toHaveBeenCalledWith('sse', {
        displayName: 'HPE Aruba Networking SSE',
        baseUrl: 'https://sse.custom.example/api',
        token: 'rotated-token',
        scopes: [
          'read:inventory',
          'read:clients-auth',
          'read:config-licences',
          'write:brokered',
        ],
      }),
    );
  });

  it('lets the operator explicitly downgrade a writable SSE plane by unchecking write', async () => {
    const sseRow: SystemRow = {
      ...SYSTEMS[0]!,
      name: 'HPE Aruba Networking SSE',
      planeId: 'sse',
      configText:
        'plane: sse\nlinked: true\nbaseUrl: https://sse.custom.example/api\nscope: read only',
    };
    mockGetSystems.mockResolvedValue({
      systems: [sseRow],
      syncHistory: [],
      permissions: PERMISSIONS,
      dataSource: 'live',
    });
    mockGetSystemsState.mockResolvedValue({
      demoMode: false,
      planes: {
        sse: unlinked('sse', {
          linked: true,
          health: 'healthy',
          capabilities: { localShell: false, brokeredWrite: false, configRead: false, directWrite: true },
        }),
      },
      history: [],
    });
    mockGetPortalSettings.mockResolvedValue(null);
    mockGetChatStatus.mockResolvedValue(null);
    mockGetChatSettings.mockResolvedValue(null);
    mockTestSystem.mockResolvedValue({ ok: true, message: 'authenticated' });

    renderSystems();

    await waitFor(() => expect(screen.getByText('HPE Aruba Networking SSE')).toBeTruthy());
    fireEvent.click(screen.getByText('HPE Aruba Networking SSE'));
    fireEvent.click(await screen.findByRole('tab', { name: 'Configuration' }));
    fireEvent.click(screen.getByRole('button', { name: 'Re-key credentials' }));

    const writeCheckbox = screen.getByLabelText(
      'Direct write — reviewed SSE object mutations followed by tenant-wide Commit',
    );
    expect(writeCheckbox).toHaveProperty('checked', true);
    // An explicit operator toggle — not the rotation itself — is what may
    // downgrade directWrite.
    fireEvent.click(writeCheckbox);
    expect(writeCheckbox).toHaveProperty('checked', false);

    fireEvent.change(screen.getByLabelText('Admin API token'), { target: { value: 'rotated-token' } });
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }));

    await waitFor(() =>
      expect(mockTestSystem).toHaveBeenCalledWith('sse', {
        displayName: 'HPE Aruba Networking SSE',
        baseUrl: 'https://sse.custom.example/api',
        token: 'rotated-token',
        scopes: ['read:inventory', 'read:clients-auth', 'read:config-licences'],
      }),
    );
  });

  it('tests and saves an exact empty scope array when every writable SSE scope is revoked', async () => {
    const sseRow: SystemRow = {
      ...SYSTEMS[0]!,
      name: 'HPE Aruba Networking SSE',
      planeId: 'sse',
      configText:
        'plane: sse\nlinked: true\nbaseUrl: https://sse.custom.example/api\nscopes: read:inventory,read:clients-auth,read:config-licences,write:brokered\nscope: read only',
    };
    const revokedRow: SystemRow = {
      ...sseRow,
      configText:
        'plane: sse\nlinked: true\nbaseUrl: https://sse.custom.example/api\nscopes: \nscope: read only',
    };
    mockGetSystems.mockResolvedValueOnce({
      systems: [sseRow],
      syncHistory: [],
      permissions: PERMISSIONS,
      dataSource: 'live',
    }).mockResolvedValue({
      systems: [revokedRow],
      syncHistory: [],
      permissions: PERMISSIONS,
      dataSource: 'live',
    });
    mockGetSystemsState.mockResolvedValueOnce({
      demoMode: false,
      planes: {
        sse: unlinked('sse', {
          linked: true,
          health: 'healthy',
          capabilities: {
            localShell: false,
            brokeredWrite: false,
            configRead: false,
            directWrite: true,
          },
        }),
      },
      history: [],
    }).mockResolvedValue({
      demoMode: false,
      planes: {
        sse: unlinked('sse', {
          linked: true,
          health: 'healthy',
          capabilities: {
            localShell: false,
            brokeredWrite: false,
            configRead: false,
            directWrite: false,
          },
        }),
      },
      history: [],
    });
    mockGetPortalSettings.mockResolvedValue(null);
    mockGetChatStatus.mockResolvedValue(null);
    mockGetChatSettings.mockResolvedValue(null);
    mockTestSystem.mockResolvedValue({ ok: true, message: 'authenticated' });
    mockSaveSystemCredentials.mockResolvedValue({ ok: true, message: 'saved' });

    renderSystems();

    await waitFor(() => expect(screen.getByText('HPE Aruba Networking SSE')).toBeTruthy());
    fireEvent.click(screen.getByText('HPE Aruba Networking SSE'));
    fireEvent.click(await screen.findByRole('tab', { name: 'Configuration' }));
    fireEvent.click(screen.getByRole('button', { name: 'Re-key credentials' }));

    for (const label of [
      'Read inventory, sites and topology',
      'Read clients, sessions and auth events',
      'Read configuration and licences',
      'Direct write — reviewed SSE object mutations followed by tenant-wide Commit',
    ]) {
      const checkbox = screen.getByLabelText(label);
      expect(checkbox).toHaveProperty('checked', true);
      fireEvent.click(checkbox);
    }
    fireEvent.change(screen.getByLabelText('Admin API token'), {
      target: { value: 'rotated-token' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }));

    await waitFor(() => expect(mockTestSystem).toHaveBeenCalledTimes(1));
    const testedPayload = mockTestSystem.mock.calls[0]![1];
    expect(testedPayload).toEqual({
      displayName: 'HPE Aruba Networking SSE',
      baseUrl: 'https://sse.custom.example/api',
      token: 'rotated-token',
      scopes: [],
    });

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Save and index' }).hasAttribute('disabled')).toBe(
        false,
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save and index' }));
    await waitFor(() => expect(mockSaveSystemCredentials).toHaveBeenCalledTimes(1));
    expect(mockSaveSystemCredentials.mock.calls[0]![1]).toBe(testedPayload);

    await waitFor(() => expect(mockGetSystemsState).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByText('HPE Aruba Networking SSE'));
    fireEvent.click(await screen.findByRole('tab', { name: 'Configuration' }));
    fireEvent.click(screen.getByRole('button', { name: 'Re-key credentials' }));
    for (const label of [
      'Read inventory, sites and topology',
      'Read clients, sessions and auth events',
      'Read configuration and licences',
      'Direct write — reviewed SSE object mutations followed by tenant-wide Commit',
    ]) {
      expect(screen.getByLabelText(label)).toHaveProperty('checked', false);
    }
  });

  it('defaults a brand-new SSE connection to read-only (write off)', async () => {
    mockGetSystems.mockResolvedValue(DEMO_PAYLOAD);
    mockGetSystemsState.mockResolvedValue(registry());
    mockGetPortalSettings.mockResolvedValue(null);
    mockGetChatStatus.mockResolvedValue(null);
    mockGetChatSettings.mockResolvedValue(null);
    mockTestSystem.mockResolvedValue({ ok: true, message: 'authenticated' });

    renderSystems();

    await waitFor(() => expect(screen.getByText('Connect a system')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Connect a system' }));
    fireEvent.change(screen.getByLabelText('System type'), { target: { value: 'sse' } });
    await waitFor(() => expect(screen.getByLabelText('Admin API token')).toBeTruthy());

    expect(
      screen.getByLabelText(
        'Direct write — reviewed SSE object mutations followed by tenant-wide Commit',
      ),
    ).toHaveProperty('checked', false);
    expect(
      screen.getByText(
        'Each reviewed mutation is sent directly to SSE, then the portal runs tenant-wide Commit.',
      ),
    ).toBeTruthy();
    expect(
      screen.queryByLabelText('Brokered write — config push, requires a ticket reference'),
    ).toBeNull();

    fireEvent.change(screen.getByLabelText('Admin API token'), { target: { value: 'new-tok' } });
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }));

    await waitFor(() => expect(mockTestSystem).toHaveBeenCalled());
    const [, creds] = mockTestSystem.mock.calls[0]!;
    expect(creds.scopes).toEqual(['read:inventory', 'read:clients-auth', 'read:config-licences']);
  });
});

describe('Systems Configuration tab — SSE object inventory', () => {
  it('opens the exact plane requested by an inventory deep link', async () => {
    const sseRow: SystemRow = {
      name: 'HPE Aruba Networking SSE',
      planeId: 'sse',
      kind: 'live plane registry',
      state: 'healthy',
      tone: 'success',
      scope: 'read only',
      scopeTone: 'neutral',
      scopeNote: 'read only',
      facts: [{ k: 'Last sync', v: '5s ago' }],
      sites: [],
      live: [],
      calls: [],
      events: [],
      pulls: [],
      configText: 'plane: sse',
    };
    mockGetSystems.mockResolvedValue({
      systems: [sseRow],
      syncHistory: [],
      permissions: PERMISSIONS,
      dataSource: 'live',
    });
    mockGetSystemsState.mockResolvedValue({
      demoMode: false,
      planes: {
        sse: unlinked('sse', {
          linked: true,
          health: 'healthy',
          capabilities: { directWrite: false },
        }),
      },
      history: [],
    });
    mockGetPortalSettings.mockResolvedValue(null);
    mockGetChatStatus.mockResolvedValue(null);
    mockGetChatSettings.mockResolvedValue(null);

    renderSystems('/systems?plane=sse');

    expect(await screen.findByText('Object inventory')).toBeTruthy();
  });

  it('renders the SSE inventory panel for a linked plane with a declared write scope', async () => {
    const sseRow: SystemRow = {
      name: 'HPE Aruba Networking SSE',
      planeId: 'sse',
      kind: 'live plane registry',
      state: 'healthy',
      tone: 'success',
      scope: 'read only',
      scopeTone: 'neutral',
      scopeNote: 'no write path from the portal to this plane',
      facts: [{ k: 'Last sync', v: '5s ago' }],
      sites: [],
      live: [],
      calls: [],
      events: [],
      pulls: [{ what: 'poll()', every: 'every 60s', mode: 'read', tone: 'neutral' }],
      configText: 'plane: sse\nlinked: true',
    };
    mockGetSystems.mockResolvedValue({
      systems: [sseRow],
      syncHistory: [],
      permissions: PERMISSIONS,
      dataSource: 'live',
    });
    mockGetSystemsState.mockResolvedValue({
      demoMode: false,
      planes: {
        sse: unlinked('sse', {
          linked: true,
          health: 'healthy',
          deviceCount: 37,
          capabilities: { localShell: false, brokeredWrite: false, configRead: false, directWrite: true },
        }),
      },
      history: [],
    });
    mockGetPortalSettings.mockResolvedValue(null);
    mockGetChatStatus.mockResolvedValue(null);
    mockGetChatSettings.mockResolvedValue(null);

    renderSystems();

    await waitFor(() => expect(screen.getByText('HPE Aruba Networking SSE')).toBeTruthy());
    const sseSystemRow = screen.getByText('HPE Aruba Networking SSE').closest('button');
    expect(sseSystemRow).not.toBeNull();
    // The count carries its own noun: SSE indexes objects, never devices.
    expect(within(sseSystemRow!).getByText('objects')).toBeTruthy();
    expect(within(sseSystemRow!).getByText('37')).toBeTruthy();
    expect(within(sseSystemRow!).queryByText('devices')).toBeNull();

    fireEvent.click(screen.getByText('HPE Aruba Networking SSE'));
    // SSE is object inventory, so selecting it opens Configuration directly.
    await waitFor(() => expect(screen.getByText('Object inventory')).toBeTruthy());
    // A write-capable token gets the auto-commit badge, not the read-only one.
    expect(screen.getByText('reviewed writes · auto-commit')).toBeTruthy();
  });

  it('shows a "connect to browse" message instead of the panel when SSE is not linked', async () => {
    const sseRow: SystemRow = {
      name: 'HPE Aruba Networking SSE',
      planeId: 'sse',
      kind: 'not linked',
      state: 'warning',
      tone: 'warning',
      scope: 'read only',
      scopeTone: 'neutral',
      scopeNote: 'no credentials stored',
      facts: [{ k: 'Last sync', v: 'never' }],
      sites: [],
      live: [],
      calls: [],
      events: [],
      pulls: [{ what: 'poll()', every: 'every 60s', mode: 'read', tone: 'neutral' }],
      configText: 'plane: sse\nlinked: false',
    };
    mockGetSystems.mockResolvedValue({ systems: [sseRow], syncHistory: [], permissions: PERMISSIONS, dataSource: 'live' });
    mockGetSystemsState.mockResolvedValue({
      demoMode: false,
      planes: { sse: unlinked('sse') },
      history: [],
    });
    mockGetPortalSettings.mockResolvedValue(null);
    mockGetChatStatus.mockResolvedValue(null);
    mockGetChatSettings.mockResolvedValue(null);

    renderSystems();

    // A plane with no credentials sits behind the collapsed 'not linked' group.
    fireEvent.click(await screen.findByRole('button', { name: /1 system not linked/ }));
    await waitFor(() => expect(screen.getByText('HPE Aruba Networking SSE')).toBeTruthy());
    fireEvent.click(screen.getByText('HPE Aruba Networking SSE'));
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Configuration' })).toBeTruthy());
    fireEvent.click(screen.getByRole('tab', { name: 'Configuration' }));

    await waitFor(() =>
      expect(screen.getByText('connect this plane with an Admin API token to browse its object inventory')).toBeTruthy(),
    );
    // The not-linked message renders instead of the panel's own controls.
    expect(screen.queryByText('reviewed writes · auto-commit')).toBeNull();
    expect(screen.queryByLabelText('Object kind')).toBeNull();
  });
});
