import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation, useParams } from 'react-router-dom';
import Systems, {
  buildSystemsExportQuery,
  parseSystemsHealthFilter,
  parseSystemsLinkedFilter,
  systemsPlaneKey,
  systemsViewMatchesFilters,
} from './Systems';
import { SettingsProvider } from '../app/SettingsContext';
import { ToastProvider } from '../nightdesk';
import {
  getChatSettings,
  getChatStatus,
  getPortalSettings,
  saveChatSettings,
  getSystems,
  getSystemsState,
  saveSystemCredentials,
  testChatProvider,
  testSystem,
} from '../api/client';
import type { LivePlaneState, SystemsData, SystemsState } from '../api/client';
import { CONNECTOR_CATALOG, hhmmLocal, PERMISSIONS, SYNC_HISTORY, SYSTEMS } from '@hpe/shared';
import type { ConnectorConfig, SystemRow } from '@hpe/shared';
import { downloadApiCsv } from '../lib/downloadApiCsv';

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
    saveChatSettings: vi.fn(),
    testChatProvider: vi.fn(),
    saveSystemCredentials: vi.fn(),
    testSystem: vi.fn(),
  };
});

vi.mock('../lib/downloadApiCsv', () => ({
  downloadApiCsv: vi.fn(async () => ({ ok: true as const })),
}));

const mockGetSystems = vi.mocked(getSystems);
const mockGetSystemsState = vi.mocked(getSystemsState);
const mockGetPortalSettings = vi.mocked(getPortalSettings);
const mockGetChatStatus = vi.mocked(getChatStatus);
const mockGetChatSettings = vi.mocked(getChatSettings);
const mockSaveChatSettings = vi.mocked(saveChatSettings);
const mockTestChatProvider = vi.mocked(testChatProvider);
const mockSaveSystemCredentials = vi.mocked(saveSystemCredentials);
const mockTestSystem = vi.mocked(testSystem);
const mockDownloadApiCsv = vi.mocked(downloadApiCsv);

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
    <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }} initialEntries={[initialEntry]}>
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

beforeEach(() => {
  // Runtime debug / notifications / health deep use apiFetch (no timeout).
  // Without a stub, jsdom fetch hangs and catalog loops blow the 5s budget.
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/debug/runtime')) {
        return new Response(
          JSON.stringify({
            ok: true,
            at: new Date().toISOString(),
            process: {
              pid: 1,
              node: 'v22',
              platform: 'test',
              uptimeSec: 1,
              memory: { rss: 1, heapUsed: 1, heapTotal: 1, external: 0 },
            },
            portal: {
              demoMode: true,
              blendLive: false,
              auth: 'none',
              pollIntervalSec: 60,
              configMode: false,
            },
            dataDir: { path: 'data/', writable: true },
            poller: { running: null, contributionPlanes: [] },
            notifier: {
              sampling: { running: false, lastSampleAt: null, trackedGroups: 0 },
              deliveryLogSize: 0,
              outboxSize: 0,
            },
            terminal: { openSessions: 0 },
            integrity: { devices: 0, doubleClaimed: 0, unclaimed: 0 },
            planes: [],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (url.includes('/api/health')) {
        return new Response(
          JSON.stringify({
            ok: true,
            status: 'ok',
            uptimeSec: 1,
            auth: 'none',
            demoMode: true,
            degradedPlanes: [],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify({ error: 'unmocked' }), { status: 404 });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('Systems assistant providers', () => {
  const settings = {
    activeProvider: 'codex' as const,
    mcp: { enabled: true, endpoint: 'http://centralmcp.test/mcp', authToken: '••••••••' },
    chatWriteMode: 'enabled' as const,
    providers: {
      codex: { enabled: true, model: 'gpt-5.3-spark' as const, reasoningEffort: 'auto' as const },
      claude: { enabled: false, model: 'sonnet', reasoningEffort: 'low' as const },
      kimi: { enabled: false, model: 'kimi-code/kimi-for-coding-highspeed', thinking: false },
      copilot: { enabled: false, model: 'auto', effort: 'adaptive' as const },
      ollama: { enabled: false, baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen2.5-coder:7b' },
      openrouter: { enabled: false, baseUrl: 'https://openrouter.ai/api/v1', model: 'openai/gpt-4.1-mini', apiKey: '••••••••' },
    },
  };

  const providerStatus = {
    installed: true,
    authenticated: true,
    mcpReady: true,
    modelReady: true,
    selected: true,
    resolvedModel: 'gpt-5.3-spark',
    latencyMs: 18,
    message: 'Provider is ready.',
  };

  function assistantSetup() {
    mockGetSystems.mockResolvedValue(DEMO_PAYLOAD);
    mockGetSystemsState.mockResolvedValue(registry());
    mockGetPortalSettings.mockResolvedValue(null);
    mockGetChatSettings.mockResolvedValue({ assistant: settings });
    mockGetChatStatus.mockResolvedValue({
      configured: { mcp: true, llm: true },
      writeMode: 'enabled',
      mcpReachable: true,
      activeProvider: 'codex',
      providers: [
        { id: 'codex', ...providerStatus },
        { id: 'claude', ...providerStatus, selected: false, resolvedModel: 'sonnet' },
        { id: 'kimi', ...providerStatus, selected: false, resolvedModel: null },
        { id: 'copilot', ...providerStatus, selected: false, resolvedModel: null },
        { id: 'ollama', ...providerStatus, selected: false, resolvedModel: null },
        { id: 'openrouter', ...providerStatus, selected: false, resolvedModel: null },
      ],
    });
    mockSaveChatSettings.mockResolvedValue({ ok: true, message: 'saved' });
  }

  it('renders the shared Codex model selector and only the selected provider fields', async () => {
    assistantSetup();
    renderSystems();

    await screen.findByLabelText('Model');
    expect(screen.getByLabelText('Model')).toHaveProperty('value', 'gpt-5.3-spark');
    expect(screen.getByRole('option', { name: /Spark.*fastest/i })).toBeTruthy();
    expect(screen.getByRole('option', { name: /Luna/i })).toBeTruthy();
    expect(screen.getByRole('option', { name: /Terra/i })).toBeTruthy();
    expect(screen.getByRole('option', { name: /GPT-5\.4 Mini/i })).toBeTruthy();
    expect(screen.getByRole('option', { name: /Auto.*normal/i })).toBeTruthy();
    expect(screen.getByLabelText('Reasoning')).toHaveProperty('value', 'auto');
    expect(screen.queryByLabelText('Provider endpoint')).toBeNull();
    expect(screen.queryByLabelText('API key')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /OpenRouter/i }));
    expect(screen.getByLabelText('Provider endpoint')).toHaveProperty('value', 'https://openrouter.ai/api/v1');
    expect(screen.getByLabelText('Model')).toHaveProperty('value', 'openai/gpt-4.1-mini');
    expect(screen.getByLabelText('API key')).toHaveProperty('value', '');
    expect(screen.queryByLabelText('Reasoning')).toBeNull();
  });

  it('restores the persisted active provider after a failed save', async () => {
    assistantSetup();
    mockSaveChatSettings.mockResolvedValue({ ok: false, message: 'save rejected' });
    renderSystems();

    await screen.findByLabelText('Model');
    fireEvent.click(screen.getByRole('button', { name: /Claude/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Save assistant' }));

    await waitFor(() => expect(mockSaveChatSettings).toHaveBeenCalled());
    expect(screen.getByRole('button', { name: /Codex.*selected/i })).toBeTruthy();
  });

  it('enables the selected provider and centralmcp when a valid selection saves', async () => {
    assistantSetup();
    mockSaveChatSettings.mockResolvedValue({ ok: true, message: 'saved' });
    renderSystems();

    await screen.findByLabelText('Model');
    fireEvent.click(screen.getByRole('button', { name: 'Save assistant' }));

    await waitFor(() => expect(mockSaveChatSettings).toHaveBeenCalledWith(expect.objectContaining({
      assistant: expect.objectContaining({
        activeProvider: 'codex',
        mcp: expect.objectContaining({ enabled: true }),
        providers: expect.objectContaining({ codex: expect.objectContaining({ enabled: true }) }),
      }),
    })));
  });

  it('keeps the saved Codex model selectable in the compact provider form', async () => {
    assistantSetup();
    renderSystems();

    const model = await screen.findByLabelText('Model');
    expect(model).toHaveProperty('value', 'gpt-5.3-spark');
    expect(screen.queryByText('Advanced')).toBeNull();
    fireEvent.change(model, { target: { value: 'gpt-5.6-terra' } });
    expect(screen.getByLabelText('Model')).toHaveProperty('value', 'gpt-5.6-terra');
    expect(screen.getByText('Lab assistant access')).toBeTruthy();
  });

  it('marks a locally edited Codex model as a draft instead of showing stale green readiness', async () => {
    assistantSetup();
    renderSystems();

    const model = await screen.findByLabelText('Model');
    fireEvent.change(model, { target: { value: 'gpt-5.6-luna' } });

    const codex = screen.getByRole('button', { name: /Codex.*selected/i });
    expect(within(codex).getByText('draft')).toBeTruthy();
    expect(within(codex).getByText('gpt-5.6-luna')).toBeTruthy();
    expect(within(codex).queryByText('ready')).toBeNull();
  });

  it('shows served readiness rather than claiming configured state', async () => {
    assistantSetup();
    renderSystems();

    await screen.findByLabelText('Model');
    expect(screen.getAllByText('gpt-5.3-spark').length).toBeGreaterThan(1);
    expect(within(screen.getByRole('button', { name: /Codex.*selected/i })).getByText('gpt-5.3-spark')).toBeTruthy();
  });

  it('runs the read-only provider test and reports its returned result', async () => {
    assistantSetup();
    mockTestChatProvider.mockResolvedValue(providerStatus);
    renderSystems();

    await screen.findByLabelText('Model');
    fireEvent.click(screen.getAllByRole('button', { name: /Test provider/i }).at(-1)!);
    await waitFor(() => expect(mockTestChatProvider).toHaveBeenCalledWith('codex'));
    expect(screen.getByText(/18 ms.*gpt-5.3-spark/i)).toBeTruthy();
  });

  it('saves a changed Codex model before testing that exact persisted selection', async () => {
    assistantSetup();
    mockSaveChatSettings.mockResolvedValue({ ok: true, message: 'saved' });
    mockTestChatProvider.mockResolvedValue({ ...providerStatus, resolvedModel: 'gpt-5.6-luna' });
    renderSystems();

    const model = await screen.findByLabelText('Model');
    fireEvent.change(model, { target: { value: 'gpt-5.6-luna' } });
    fireEvent.click(screen.getAllByRole('button', { name: /Test provider/i }).at(-1)!);

    await waitFor(() => expect(mockSaveChatSettings).toHaveBeenCalledWith(expect.objectContaining({
      assistant: expect.objectContaining({
        activeProvider: 'codex',
        providers: expect.objectContaining({
          codex: expect.objectContaining({ model: 'gpt-5.6-luna', enabled: true }),
        }),
      }),
    })));
    await waitFor(() => expect(mockTestChatProvider).toHaveBeenCalledWith('codex'));
    expect(screen.getByText(/18 ms.*gpt-5.6-luna/i)).toBeTruthy();
  });

  it('does not test an unsaved selection when saving it fails', async () => {
    assistantSetup();
    mockSaveChatSettings.mockResolvedValue({ ok: false, message: 'save rejected' });
    renderSystems();

    const model = await screen.findByLabelText('Model');
    fireEvent.change(model, { target: { value: 'gpt-5.6-luna' } });
    fireEvent.click(screen.getAllByRole('button', { name: /Test provider/i }).at(-1)!);

    await waitFor(() => expect(mockSaveChatSettings).toHaveBeenCalled());
    expect(mockTestChatProvider).not.toHaveBeenCalled();
  });
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

  it('exports a plane health summary CSV from the drawer summary tab', async () => {
    mockGetSystems.mockResolvedValue(DEMO_PAYLOAD);
    mockGetSystemsState.mockResolvedValue(registry());
    mockGetPortalSettings.mockResolvedValue(null);
    mockGetChatStatus.mockResolvedValue(null);
    mockGetChatSettings.mockResolvedValue(null);
    const createObjectURL = vi.fn(() => 'blob:plane-health');
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL });

    renderSystems();
    await waitFor(() => expect(screen.getByText('HPE Aruba Central')).toBeTruthy());
    fireEvent.click(screen.getByText('HPE Aruba Central'));
    await waitFor(() => expect(screen.getByText('Sites on this plane')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'Export health summary' }));
    expect(await screen.findByText(/Exported health summary/)).toBeTruthy();
    expect(createObjectURL).toHaveBeenCalled();
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
  it(
    'renders every configurable product from the catalog without a standalone AOS-10 connector',
    async () => {
      mockGetSystems.mockResolvedValue(DEMO_PAYLOAD);
      mockGetSystemsState.mockResolvedValue(registry());
      mockGetPortalSettings.mockResolvedValue(null);
      mockGetChatStatus.mockResolvedValue(null);
      mockGetChatSettings.mockResolvedValue(null);

      renderSystems();

      await waitFor(() => expect(screen.getByText('Connect a system')).toBeTruthy());
      fireEvent.click(screen.getByRole('button', { name: 'Connect a system' }));

      const selector = screen.getByLabelText('System type');
      expect(screen.queryByRole('option', { name: /AOS-10/i })).toBeNull();

      for (const entry of CONNECTOR_CATALOG) {
        fireEvent.change(selector, { target: { value: entry.id } });
        await waitFor(
          () => expect(screen.getByLabelText(entry.endpoint.label)).toBeTruthy(),
          { timeout: 3000 },
        );
        for (const auth of entry.auth) {
          if (entry.auth.length > 1) {
            fireEvent.change(screen.getByLabelText('Authentication'), { target: { value: auth.kind } });
          }
          for (const field of auth.fields) {
            expect(screen.getByLabelText(field.label)).toBeTruthy();
          }
        }
      }
    },
    20_000,
  );

  it('keeps advanced policy collapsed until the operator opens it', async () => {
    mockGetSystems.mockResolvedValue(DEMO_PAYLOAD);
    mockGetSystemsState.mockResolvedValue(registry());
    mockGetPortalSettings.mockResolvedValue(null);
    mockGetChatStatus.mockResolvedValue(null);
    mockGetChatSettings.mockResolvedValue(null);

    renderSystems();

    await waitFor(() => expect(screen.getByText('Connect a system')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Connect a system' }));
    expect(screen.getByText('Advanced policy').closest('details')?.hasAttribute('open')).toBe(false);
  });

  it('tests a typed connector draft and clears a completed probe when policy changes', async () => {
    mockGetSystems.mockResolvedValue(DEMO_PAYLOAD);
    mockGetSystemsState.mockResolvedValue(registry());
    mockGetPortalSettings.mockResolvedValue(null);
    mockGetChatStatus.mockResolvedValue(null);
    mockGetChatSettings.mockResolvedValue(null);
    mockTestSystem.mockResolvedValue({
      ok: true,
      authenticated: true,
      dataset: 'devices',
      message: 'authenticated devices read',
    });

    renderSystems();

    await waitFor(() => expect(screen.getByText('Connect a system')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Connect a system' }));
    fireEvent.change(screen.getByLabelText('System type'), { target: { value: 'opsramp' } });
    await waitFor(() => expect(screen.getByLabelText('Tenant ID')).toBeTruthy());
    expect(screen.getByDisplayValue('https://app.opsramp.net')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Tenant ID'), { target: { value: 'tenant-a' } });
    fireEvent.change(screen.getByLabelText('Client ID'), { target: { value: 'client-a' } });
    fireEvent.change(screen.getByLabelText('Client secret'), { target: { value: 'secret-a' } });
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }));

    await waitFor(() => expect(mockTestSystem).toHaveBeenCalled());
    expect(mockTestSystem.mock.calls[0]![0]).toBe('opsramp');
    expect(mockTestSystem.mock.calls[0]![1]).toMatchObject({
      id: 'opsramp',
      enabled: true,
      endpoint: 'https://app.opsramp.net',
      auth: {
        kind: 'oauth_client_credentials',
        tenantId: 'tenant-a',
        clientId: 'client-a',
        clientSecret: 'secret-a',
      },
      verifyTls: true,
    } satisfies Partial<ConnectorConfig>);
    await waitFor(() => expect(screen.getByText(/authenticated probe: devices/i)).toBeTruthy());

    fireEvent.click(screen.getByLabelText('Verify TLS certificate'));
    expect(screen.getByText('Re-test required')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Save and index' })).toHaveProperty('disabled', true);
  });

  it('requires a new probe when an uncontrolled secret changes after testing', async () => {
    mockGetSystems.mockResolvedValue(DEMO_PAYLOAD);
    mockGetSystemsState.mockResolvedValue(registry());
    mockGetPortalSettings.mockResolvedValue(null);
    mockGetChatStatus.mockResolvedValue(null);
    mockGetChatSettings.mockResolvedValue(null);
    mockTestSystem.mockResolvedValue({ ok: true, authenticated: true, dataset: 'sse', message: 'accepted' });
    mockSaveSystemCredentials.mockResolvedValue({ ok: true, message: 'saved' });

    renderSystems();

    await waitFor(() => expect(screen.getByText('Connect a system')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Connect a system' }));
    fireEvent.change(screen.getByLabelText('System type'), { target: { value: 'sse' } });
    const token = await screen.findByLabelText('Admin API token') as HTMLInputElement;
    fireEvent.change(token, { target: { value: 'tested-token' } });
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save and index' })).not.toHaveProperty('disabled', true));

    token.value = 'different-token-without-react-state';
    fireEvent.click(screen.getByRole('button', { name: 'Save and index' }));

    await waitFor(() => expect(screen.getAllByText('Re-test required').length).toBeGreaterThan(0));
    expect(mockSaveSystemCredentials).not.toHaveBeenCalled();
  });

  it('submits ClearPass static-token authentication as its declared typed auth shape', async () => {
    mockGetSystems.mockResolvedValue(DEMO_PAYLOAD);
    mockGetSystemsState.mockResolvedValue(registry());
    mockGetPortalSettings.mockResolvedValue(null);
    mockGetChatStatus.mockResolvedValue(null);
    mockGetChatSettings.mockResolvedValue(null);
    mockTestSystem.mockResolvedValue({ ok: true, authenticated: true, dataset: 'endpoints', message: 'accepted' });

    renderSystems();

    await waitFor(() => expect(screen.getByText('Connect a system')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Connect a system' }));
    fireEvent.change(screen.getByLabelText('System type'), { target: { value: 'clearpass' } });
    fireEvent.change(screen.getByLabelText('Authentication'), { target: { value: 'token' } });
    fireEvent.change(screen.getByLabelText('API token'), { target: { value: 'clearpass-token' } });
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }));

    await waitFor(() => expect(mockTestSystem).toHaveBeenCalled());
    expect(mockTestSystem.mock.calls[0]![1]).toMatchObject({
      id: 'clearpass',
      auth: { kind: 'token', token: 'clearpass-token' },
    } satisfies Partial<ConnectorConfig>);
  });

  it('saves the exact typed ClearPass connector that passed its authenticated probe', async () => {
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

    fireEvent.change(screen.getByLabelText('System type'), { target: { value: 'clearpass' } });
    await waitFor(() => expect(screen.getByText('ClearPass publisher URL')).toBeTruthy());
    fireEvent.change(screen.getByLabelText('ClearPass publisher URL'), {
      target: { value: 'cppm-01.meridian.health' },
    });
    fireEvent.change(screen.getByLabelText('Client ID'), { target: { value: 'client-123' } });
    fireEvent.change(screen.getByLabelText('Client secret'), { target: { value: 'secret-123' } });
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }));

    await waitFor(() => expect(mockTestSystem).toHaveBeenCalled());
    const [plane, creds] = mockTestSystem.mock.calls[0]!;
    expect(plane).toBe('clearpass');
    expect(creds).toMatchObject({
      id: 'clearpass',
      endpoint: 'cppm-01.meridian.health',
      auth: { kind: 'oauth_client_credentials', clientId: 'client-123', clientSecret: 'secret-123' },
    });
    expect(screen.getByLabelText('CoA enforcement profile')).toBeTruthy();

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
    fireEvent.change(screen.getByLabelText('Client ID'), { target: { value: 'client-123' } });
    fireEvent.change(screen.getByLabelText('Client secret'), { target: { value: 'secret-123' } });
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

  it('sends the optional CoA enforcement profile inside the selected auth shape', async () => {
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
    fireEvent.change(screen.getByLabelText('Client ID'), { target: { value: 'client-123' } });
    fireEvent.change(screen.getByLabelText('Client secret'), { target: { value: 'secret-123' } });
    fireEvent.change(screen.getByLabelText('CoA enforcement profile'), {
      target: { value: 'Quarantine-Profile' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }));

    await waitFor(() => expect(mockTestSystem).toHaveBeenCalled());
    const [, creds] = mockTestSystem.mock.calls[0]!;
    expect(creds).toMatchObject({
      endpoint: 'cppm-01.meridian.health',
      auth: { coaEnforcementProfile: 'Quarantine-Profile' },
    });
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
    fireEvent.change(screen.getByLabelText('Client ID'), { target: { value: 'client-123' } });
    fireEvent.change(screen.getByLabelText('Client secret'), { target: { value: 'tested-secret' } });
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }));
    await waitFor(() => expect(mockTestSystem).toHaveBeenCalled());

    fireEvent.change(screen.getByLabelText('Client secret'), { target: { value: 'untested-secret' } });
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

describe('Systems connect drawer — token authentication', () => {
  it('renders only SSE token authentication and submits its typed config', async () => {
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
    expect(screen.queryByLabelText('Client ID')).toBeNull();
    expect(screen.queryByLabelText('Client secret')).toBeNull();

    fireEvent.change(screen.getByLabelText('SSE Admin API base'), {
      target: { value: 'admin-api.axissecurity.com' },
    });
    fireEvent.change(screen.getByLabelText('Admin API token'), { target: { value: 'sse-tok-123' } });
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }));

    await waitFor(() => expect(mockTestSystem).toHaveBeenCalled());
    const [plane, creds] = mockTestSystem.mock.calls[0]!;
    expect(plane).toBe('sse');
    expect(creds).toMatchObject({
      id: 'sse', endpoint: 'admin-api.axissecurity.com', auth: { kind: 'token', token: 'sse-tok-123' },
    });
  });

  it('renders Mist org token authentication and submits its typed config', async () => {
    mockGetSystems.mockResolvedValue(DEMO_PAYLOAD);
    mockGetSystemsState.mockResolvedValue(registry());
    mockGetPortalSettings.mockResolvedValue(null);
    mockGetChatStatus.mockResolvedValue(null);
    mockGetChatSettings.mockResolvedValue(null);
    mockTestSystem.mockResolvedValue({ ok: true, message: 'authenticated' });

    renderSystems();

    await waitFor(() => expect(screen.getByText('Connect a system')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Connect a system' }));
    fireEvent.change(screen.getByLabelText('System type'), { target: { value: 'mist' } });

    await waitFor(() => expect(screen.getByLabelText('Org ID')).toBeTruthy());
    expect(screen.queryByLabelText('Client ID')).toBeNull();
    expect(screen.queryByLabelText('Client secret')).toBeNull();

    fireEvent.change(screen.getByLabelText('Mist cloud region'), { target: { value: 'https://api.mist.com' } });
    fireEvent.change(screen.getByLabelText('Org ID'), { target: { value: 'org-uuid-1' } });
    fireEvent.change(screen.getByLabelText('API token'), { target: { value: 'mist-tok-1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }));

    await waitFor(() => expect(mockTestSystem).toHaveBeenCalled());
    const [plane, creds] = mockTestSystem.mock.calls[0]!;
    expect(plane).toBe('mist');
    expect(creds).toMatchObject({
      id: 'mist', endpoint: 'https://api.mist.com', auth: { kind: 'token', orgId: 'org-uuid-1', token: 'mist-tok-1' },
    });
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

    expect(screen.getByLabelText('SSE Admin API base')).toHaveProperty(
      'value',
      'https://sse.custom.example/api',
    );
    fireEvent.change(screen.getByLabelText('Admin API token'), { target: { value: 'new-token' } });
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }));

    await waitFor(() =>
      expect(mockTestSystem).toHaveBeenCalledWith('sse', expect.objectContaining({
        id: 'sse',
        endpoint: 'https://sse.custom.example/api',
        auth: { kind: 'token', token: 'new-token' },
      })),
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
    expect(creds).toMatchObject({ auth: { kind: 'token', token: 'sse-tok-999' } });
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

    fireEvent.change(screen.getByLabelText('Central region / base URL'), {
      target: { value: 'https://us4.api.central.arubanetworks.com' },
    });
    fireEvent.click(screen.getByLabelText('Configuration and licences'));
    fireEvent.click(screen.getByLabelText('Brokered configuration'));
    expect(screen.getByLabelText('Brokered configuration')).toHaveProperty('checked', true);

    fireEvent.change(screen.getByLabelText('System type'), { target: { value: 'clearpass' } });
    await waitFor(() => expect(screen.getByText('ClearPass publisher URL')).toBeTruthy());

    expect(screen.getByLabelText('ClearPass publisher URL')).toHaveProperty('value', 'https://cppm.example.com');
    expect(screen.getByLabelText('Reviewed direct write')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('ClearPass publisher URL'), {
      target: { value: 'cppm-01.meridian.health' },
    });
    fireEvent.change(screen.getByLabelText('Client ID'), { target: { value: 'client-123' } });
    fireEvent.change(screen.getByLabelText('Client secret'), { target: { value: 'secret-123' } });
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }));

    await waitFor(() => expect(mockTestSystem).toHaveBeenCalled());
    const [, creds] = mockTestSystem.mock.calls[0]!;
    expect(creds).toMatchObject({
      id: 'clearpass',
      scopes: ['read:inventory', 'read:clients-auth', 'read:config-licences'],
    });
  });

  it('offers Mist its declared direct-write scope', async () => {
    mockGetSystems.mockResolvedValue(DEMO_PAYLOAD);
    mockGetSystemsState.mockResolvedValue(registry());
    mockGetPortalSettings.mockResolvedValue(null);
    mockGetChatStatus.mockResolvedValue(null);
    mockGetChatSettings.mockResolvedValue(null);

    renderSystems();

    await waitFor(() => expect(screen.getByText('Connect a system')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Connect a system' }));
    fireEvent.change(screen.getByLabelText('System type'), { target: { value: 'mist' } });

    await waitFor(() =>
      expect(screen.getByLabelText('Reviewed direct write')).toBeTruthy(),
    );
    expect(screen.queryByLabelText('Brokered configuration')).toBeNull();
  });

  it('re-keys a writable SSE plane with its write scope prefilled and preserved', async () => {
    const sseRow: SystemRow = {
      ...SYSTEMS[0]!,
      name: 'HPE Aruba Networking SSE',
      planeId: 'sse',
      configText:
        'plane: sse\nlinked: true\nbaseUrl: https://sse.custom.example/api\nscopes: read:config-licences,write:direct\nscope: read only',
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

    expect(screen.getByLabelText('Reviewed direct write')).toHaveProperty('checked', true);

    fireEvent.change(screen.getByLabelText('Admin API token'), { target: { value: 'rotated-token' } });
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }));

    await waitFor(() =>
      expect(mockTestSystem).toHaveBeenCalledWith('sse', expect.objectContaining({
        endpoint: 'https://sse.custom.example/api',
        auth: { kind: 'token', token: 'rotated-token' },
        scopes: ['read:config-licences', 'write:direct'],
      })),
    );
  });

  it('lets the operator explicitly downgrade a writable SSE plane by unchecking write', async () => {
    const sseRow: SystemRow = {
      ...SYSTEMS[0]!,
      name: 'HPE Aruba Networking SSE',
      planeId: 'sse',
      configText:
        'plane: sse\nlinked: true\nbaseUrl: https://sse.custom.example/api\nscopes: read:config-licences,write:direct\nscope: read only',
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

    const writeCheckbox = screen.getByLabelText('Reviewed direct write');
    expect(writeCheckbox).toHaveProperty('checked', true);
    fireEvent.click(writeCheckbox);
    expect(writeCheckbox).toHaveProperty('checked', false);

    fireEvent.change(screen.getByLabelText('Admin API token'), { target: { value: 'rotated-token' } });
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }));

    await waitFor(() =>
      expect(mockTestSystem).toHaveBeenCalledWith('sse', expect.objectContaining({
        endpoint: 'https://sse.custom.example/api',
        auth: { kind: 'token', token: 'rotated-token' },
        scopes: ['read:config-licences'],
      })),
    );
  });

  it('tests and saves an exact empty scope array when every writable SSE scope is revoked', async () => {
    const sseRow: SystemRow = {
      ...SYSTEMS[0]!,
      name: 'HPE Aruba Networking SSE',
      planeId: 'sse',
      configText:
        'plane: sse\nlinked: true\nbaseUrl: https://sse.custom.example/api\nscopes: read:config-licences,write:direct\nscope: read only',
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

    for (const label of ['Configuration and licences', 'Reviewed direct write']) {
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
    expect(testedPayload).toMatchObject({
      id: 'sse',
      endpoint: 'https://sse.custom.example/api',
      auth: { kind: 'token', token: 'rotated-token' },
      scopes: [],
    });

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Save and index' }).hasAttribute('disabled')).toBe(
        false,
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save and index' }));
    await waitFor(() => expect(mockSaveSystemCredentials).toHaveBeenCalledTimes(1));
    expect(mockSaveSystemCredentials.mock.calls[0]![1]).toStrictEqual(testedPayload);

    await waitFor(() => expect(mockGetSystemsState).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByText('HPE Aruba Networking SSE'));
    fireEvent.click(await screen.findByRole('tab', { name: 'Configuration' }));
    fireEvent.click(screen.getByRole('button', { name: 'Re-key credentials' }));
    for (const label of ['Configuration and licences', 'Reviewed direct write']) {
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

    expect(screen.getByLabelText('Reviewed direct write')).toHaveProperty('checked', false);
    expect(screen.queryByLabelText('Brokered configuration')).toBeNull();

    fireEvent.change(screen.getByLabelText('Admin API token'), { target: { value: 'new-tok' } });
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }));

    await waitFor(() => expect(mockTestSystem).toHaveBeenCalled());
    const [, creds] = mockTestSystem.mock.calls[0]!;
    expect(creds).toMatchObject({ id: 'sse', scopes: ['read:config-licences'] });
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

  it('honours ?tab=config on a Central plane deep-link (webhooks share target)', async () => {
    const centralRow: SystemRow = {
      name: 'HPE Aruba Central',
      planeId: 'central',
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
      configText: 'plane: central',
    };
    mockGetSystems.mockResolvedValue({
      systems: [centralRow],
      syncHistory: [],
      permissions: PERMISSIONS,
      dataSource: 'live',
    });
    mockGetSystemsState.mockResolvedValue({
      demoMode: false,
      planes: {
        central: unlinked('central', {
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

    // Webhooks panel mounts on the Configuration tab; summary would not show it.
    renderSystems('/systems?plane=central&tab=config');

    expect(await screen.findByText('Webhooks')).toBeTruthy();
    // Configuration tab chrome — not the Summary default for non-SSE planes.
    expect(screen.getByRole('button', { name: 'New webhook' })).toBeTruthy();
    expect(screen.queryByText('Object inventory')).toBeNull();
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

describe('Systems polling', () => {
  /* The header stamps LIVE · SYNCED hh:mm, so the screen must re-read on the
     settings cadence — a NOC tab cannot sit on a mount-time snapshot under a
     freshness claim (design rule 1). */
  const LIVE_EMPTY: SystemsData = {
    systems: [],
    syncHistory: [],
    permissions: PERMISSIONS,
    dataSource: 'live',
    syncedAt: '2026-03-04T09:41:00.000Z',
  };

  function mockLiveApis() {
    mockGetSystems.mockResolvedValue(LIVE_EMPTY);
    mockGetSystemsState.mockResolvedValue(registry());
    mockGetPortalSettings.mockResolvedValue(null);
    mockGetChatStatus.mockResolvedValue(null);
    mockGetChatSettings.mockResolvedValue(null);
  }

  it('re-reads the systems envelope on the settings cadence', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      mockLiveApis();
      renderSystems();
      await waitFor(() => expect(screen.getByText(/^LIVE · SYNCED /)).toBeTruthy());
      expect(mockGetSystems).toHaveBeenCalledTimes(1);

      await act(async () => {
        vi.advanceTimersByTime(60_000);
      });
      expect(mockGetSystems).toHaveBeenCalledTimes(2);

      await act(async () => {
        vi.advanceTimersByTime(60_000);
      });
      expect(mockGetSystems).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('never stacks a second read behind a slow one', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      let resolveSlow: ((d: SystemsData) => void) | null = null;
      mockGetSystems.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveSlow = resolve;
          }),
      );
      mockGetSystems.mockResolvedValue(LIVE_EMPTY);
      mockGetSystemsState.mockResolvedValue(registry());
      mockGetPortalSettings.mockResolvedValue(null);
      mockGetChatStatus.mockResolvedValue(null);
      mockGetChatSettings.mockResolvedValue(null);
      renderSystems();
      // The mount read is still out when two interval ticks pass: neither
      // may queue another read behind it.
      await act(async () => {
        vi.advanceTimersByTime(120_000);
      });
      expect(mockGetSystems).toHaveBeenCalledTimes(1);

      await act(async () => {
        resolveSlow?.(LIVE_EMPTY);
      });
      await act(async () => {
        vi.advanceTimersByTime(60_000);
      });
      expect(mockGetSystems).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('suspends polling while the connect drawer is open, and resumes when it closes', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      mockLiveApis();
      renderSystems();
      await waitFor(() => expect(screen.getByText(/^LIVE · SYNCED /)).toBeTruthy());
      await act(async () => {
        vi.advanceTimersByTime(60_000);
      });
      expect(mockGetSystems).toHaveBeenCalledTimes(2);

      // A refresh landing mid-entry could tear down credential input or a
      // connection test — while the drawer is open, no tick may fire one.
      fireEvent.click(screen.getByRole('button', { name: 'Connect a system' }));
      await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy());
      await act(async () => {
        vi.advanceTimersByTime(180_000);
      });
      expect(mockGetSystems).toHaveBeenCalledTimes(2);

      fireEvent.click(screen.getByLabelText('Close dialog'));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      await act(async () => {
        vi.advanceTimersByTime(60_000);
      });
      expect(mockGetSystems).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('moves the LIVE · SYNCED stamp when a poll returns a newer sync', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      mockGetSystems
        .mockResolvedValueOnce(LIVE_EMPTY)
        .mockResolvedValue({ ...LIVE_EMPTY, syncedAt: '2026-03-04T10:05:00.000Z' });
      mockGetSystemsState.mockResolvedValue(registry());
      mockGetPortalSettings.mockResolvedValue(null);
      mockGetChatStatus.mockResolvedValue(null);
      mockGetChatSettings.mockResolvedValue(null);
      renderSystems();
      await waitFor(() =>
        expect(
          screen.getByText(`LIVE · SYNCED ${hhmmLocal('2026-03-04T09:41:00.000Z')}`),
        ).toBeTruthy(),
      );

      await act(async () => {
        vi.advanceTimersByTime(60_000);
      });
      expect(
        screen.getByText(`LIVE · SYNCED ${hhmmLocal('2026-03-04T10:05:00.000Z')}`),
      ).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('offers Download server CSV on live payloads and hits /api/systems/export (Loop 100)', async () => {
    mockLiveApis();
    mockDownloadApiCsv.mockClear();
    renderSystems();
    await waitFor(() => expect(screen.getByText(/^LIVE · SYNCED /)).toBeTruthy());
    // Distinct aria-label — NotificationsSection also exposes "Download server CSV".
    fireEvent.click(await screen.findByRole('button', { name: 'Download systems roster CSV' }));
    await waitFor(() =>
      expect(mockDownloadApiCsv).toHaveBeenCalledWith('/api/systems/export', 'systems-roster.csv'),
    );
  });

  it('hides systems roster Download server CSV on demo fixtures', async () => {
    mockGetSystems.mockResolvedValue({
      systems: SYSTEMS,
      syncHistory: SYNC_HISTORY,
      permissions: PERMISSIONS,
      dataSource: 'demo',
    });
    mockGetSystemsState.mockResolvedValue(null);
    mockGetPortalSettings.mockResolvedValue(null);
    mockGetChatStatus.mockResolvedValue(null);
    mockGetChatSettings.mockResolvedValue(null);
    renderSystems();
    await waitFor(() => expect(screen.getByText('DEMO FIXTURE')).toBeTruthy());
    expect(screen.queryByRole('button', { name: 'Download systems roster CSV' })).toBeNull();
  });
});

describe('Systems roster filters (Loop 107)', () => {
  it('parse + export query + match helpers', () => {
    expect(parseSystemsHealthFilter('Degraded')).toBe('degraded');
    expect(parseSystemsHealthFilter('nope')).toBe('all');
    expect(parseSystemsLinkedFilter('true')).toBe('1');
    expect(parseSystemsLinkedFilter('0')).toBe('0');
    expect(buildSystemsExportQuery({ q: 'uxi', health: 'degraded', linked: '1' })).toBe(
      '?q=uxi&health=degraded&linked=1',
    );
    expect(buildSystemsExportQuery({})).toBe('');
    const healthy = {
      row: { name: 'Central', kind: 'cloud', scope: 'read', state: 'healthy' },
      planeId: 'central',
      stateLabel: 'healthy',
      live: { linked: true },
    };
    const unlinked = {
      row: { name: 'Mist', kind: 'cloud', scope: 'read', state: 'unlinked' },
      planeId: 'mist',
      stateLabel: 'unlinked',
      live: { linked: false },
    };
    expect(systemsViewMatchesFilters(healthy, { health: 'healthy' })).toBe(true);
    expect(systemsViewMatchesFilters(unlinked, { linked: '0' })).toBe(true);
    expect(systemsViewMatchesFilters(healthy, { linked: '0' })).toBe(false);
    expect(systemsViewMatchesFilters(healthy, { q: 'cent' })).toBe(true);
  });

  it('Download server CSV forwards q/health/linked from the filter bar', async () => {
    mockGetSystems.mockResolvedValue({
      systems: [],
      syncHistory: [],
      permissions: PERMISSIONS,
      dataSource: 'live',
      syncedAt: '2026-03-04T09:41:00.000Z',
    });
    mockGetSystemsState.mockResolvedValue(registry());
    mockGetPortalSettings.mockResolvedValue(null);
    mockGetChatStatus.mockResolvedValue(null);
    mockGetChatSettings.mockResolvedValue(null);
    mockDownloadApiCsv.mockClear();
    renderSystems('/systems?q=central&health=healthy&linked=1');
    await waitFor(() => expect(screen.getByText(/^LIVE · SYNCED /)).toBeTruthy());
    fireEvent.click(await screen.findByRole('button', { name: 'Download systems roster CSV' }));
    await waitFor(() => expect(mockDownloadApiCsv).toHaveBeenCalled());
    const path = String(mockDownloadApiCsv.mock.calls[0]![0]);
    expect(path.startsWith('/api/systems/export?')).toBe(true);
    const qs = new URLSearchParams(path.split('?')[1]);
    expect(qs.get('q')).toBe('central');
    expect(qs.get('health')).toBe('healthy');
    expect(qs.get('linked')).toBe('1');
  });

  /* Loop 140 — Health chip row toggles the same health= filter as the Select. */
  it('health chips filter the roster and write health back to the URL', async () => {
    const healthyRow = SYSTEMS.find((s) => s.state === 'healthy');
    const degradedRow = SYSTEMS.find((s) => s.state === 'degraded');
    expect(healthyRow && degradedRow).toBeTruthy();
    mockGetSystems.mockResolvedValue({
      systems: [healthyRow!, degradedRow!],
      syncHistory: SYNC_HISTORY,
      permissions: PERMISSIONS,
      dataSource: 'demo',
    });
    mockGetSystemsState.mockResolvedValue(null);
    mockGetPortalSettings.mockResolvedValue(null);
    mockGetChatStatus.mockResolvedValue(null);
    mockGetChatSettings.mockResolvedValue(null);

    function SearchProbe() {
      const loc = useLocation();
      return <div data-testid="search">{loc.search}</div>;
    }

    render(
      <MemoryRouter
        future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
        initialEntries={['/systems']}
      >
        <ToastProvider>
          <SettingsProvider>
            <Routes>
              <Route
                path="/systems"
                element={
                  <>
                    <Systems />
                    <SearchProbe />
                  </>
                }
              />
            </Routes>
          </SettingsProvider>
        </ToastProvider>
      </MemoryRouter>,
    );

    expect(await screen.findByText(healthyRow!.name)).toBeTruthy();
    expect(screen.getByText(degradedRow!.name)).toBeTruthy();
    const chips = screen.getByRole('group', { name: 'Systems health' });
    const degradedChip = within(chips).getByRole('button', { name: /Degraded/i });
    expect(degradedChip.getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(degradedChip);
    await waitFor(() => expect(screen.getByText(degradedRow!.name)).toBeTruthy());
    expect(screen.queryByText(healthyRow!.name)).toBeNull();
    await waitFor(() => expect(screen.getByTestId('search').textContent).toMatch(/health=degraded/));
    expect(degradedChip.getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(degradedChip);
    await waitFor(() => expect(screen.getByText(healthyRow!.name)).toBeTruthy());
    expect(screen.getByText(degradedRow!.name)).toBeTruthy();
    expect(screen.getByTestId('search').textContent).not.toMatch(/health=/);
  });
});

/* Loop 145 — Linked chip row toggles the same linked= filter as the Select. */
describe('Systems linked chips (Loop 145)', () => {
  it('linked chips filter the roster and write linked back to the URL', async () => {
    const linkedRow: SystemRow = {
      ...SYSTEMS[0]!,
      name: 'SecureSSID-LAB-Central',
      planeId: 'central',
      state: 'healthy',
    };
    const darkRow: SystemRow = {
      ...SYSTEMS[1]!,
      name: 'Mist',
      planeId: 'mist',
      state: 'warning',
      tone: 'neutral',
    };
    mockGetSystems.mockResolvedValue({
      systems: [linkedRow, darkRow],
      syncHistory: SYNC_HISTORY,
      permissions: PERMISSIONS,
      dataSource: 'live',
      syncedAt: '2026-03-04T09:41:00.000Z',
    });
    mockGetSystemsState.mockResolvedValue({
      demoMode: false,
      planes: {
        central: {
          id: 'central',
          linked: true,
          health: 'healthy',
          lastSync: '2026-03-04T09:41:00.000Z',
          deviceCount: 10,
          callsToday: 1,
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

    function SearchProbe() {
      const loc = useLocation();
      return <div data-testid="search">{loc.search}</div>;
    }

    render(
      <MemoryRouter
        future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
        initialEntries={['/systems']}
      >
        <ToastProvider>
          <SettingsProvider>
            <Routes>
              <Route
                path="/systems"
                element={
                  <>
                    <Systems />
                    <SearchProbe />
                  </>
                }
              />
            </Routes>
          </SettingsProvider>
        </ToastProvider>
      </MemoryRouter>,
    );

    expect(await screen.findByText('SecureSSID-LAB-Central')).toBeTruthy();
    // Unlinked rows sit in the dormant block until expanded or filtered.
    const chips = screen.getByRole('group', { name: 'Systems linked' });
    const unlinkedChip = within(chips).getByRole('button', { name: /^Unlinked/i });
    expect(unlinkedChip.getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(unlinkedChip);
    await waitFor(() => expect(screen.getByText('Mist')).toBeTruthy());
    expect(screen.queryByText('SecureSSID-LAB-Central')).toBeNull();
    await waitFor(() => expect(screen.getByTestId('search').textContent).toMatch(/linked=0/));
    expect(unlinkedChip.getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(unlinkedChip);
    await waitFor(() => expect(screen.getByText('SecureSSID-LAB-Central')).toBeTruthy());
    expect(screen.getByTestId('search').textContent).not.toMatch(/linked=/);
  });
});

/* Loop 169 — header LIVE badge honesty (pure live + systems blend). */
describe('Systems Loop 169 residuals', () => {
  it('stamps LIVE on pure live systems', async () => {
    mockGetSystems.mockResolvedValue({
      systems: [],
      syncHistory: [],
      permissions: PERMISSIONS,
      dataSource: 'live',
      syncedAt: '2026-03-04T09:41:00.000Z',
    });
    mockGetSystemsState.mockResolvedValue(registry());
    mockGetPortalSettings.mockResolvedValue(null);
    mockGetChatStatus.mockResolvedValue(null);
    mockGetChatSettings.mockResolvedValue(null);
    renderSystems();
    expect(await screen.findByText('LIVE')).toBeTruthy();
    expect(screen.getByText(/^LIVE · SYNCED /)).toBeTruthy();
  });

  it('stamps LIVE when systems arrives via blend', async () => {
    mockGetSystems.mockResolvedValue({
      systems: SYSTEMS.slice(0, 1),
      syncHistory: [],
      permissions: PERMISSIONS,
      dataSource: 'demo',
      blended: ['systems'],
      syncedAt: '2026-03-04T09:41:00.000Z',
    });
    mockGetSystemsState.mockResolvedValue(registry());
    mockGetPortalSettings.mockResolvedValue(null);
    mockGetChatStatus.mockResolvedValue(null);
    mockGetChatSettings.mockResolvedValue(null);
    renderSystems();
    expect(await screen.findByText('LIVE')).toBeTruthy();
  });

  it('keeps demo chrome quiet (no LIVE badge)', async () => {
    mockGetSystems.mockResolvedValue(DEMO_PAYLOAD);
    mockGetSystemsState.mockResolvedValue(registry());
    mockGetPortalSettings.mockResolvedValue(null);
    mockGetChatStatus.mockResolvedValue(null);
    mockGetChatSettings.mockResolvedValue(null);
    renderSystems();
    expect(await screen.findByText('DEMO FIXTURE')).toBeTruthy();
    expect(screen.queryByText('LIVE')).toBeNull();
  });
});

/* Loop 189 — plane roster bulk Export / Copy plane ids / Copy selection link. */
describe('Systems Loop 189 plane bulk', () => {
  it('systemsPlaneKey prefers registry id over name', () => {
    expect(
      systemsPlaneKey({
        planeId: 'central',
        row: { name: 'SecureSSID-LAB-Central', planeId: 'central' },
      }),
    ).toBe('central');
    expect(systemsPlaneKey({ planeId: null, row: { name: 'Local switches' } })).toBe(
      'Local switches',
    );
  });

  it('shows bulk bar for selection: Export selected, Copy plane ids, Copy selection link, Clear', async () => {
    const createObjectURL = vi.fn(() => 'blob:systems-planes-selected');
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    const central: SystemRow = {
      ...SYSTEMS[0]!,
      name: 'SecureSSID-LAB-Central',
      planeId: 'central',
      state: 'healthy',
    };
    const mist: SystemRow = {
      ...SYSTEMS[1]!,
      name: 'Mist',
      planeId: 'mist',
      state: 'healthy',
    };
    mockGetSystems.mockResolvedValue({
      systems: [central, mist],
      syncHistory: SYNC_HISTORY,
      permissions: PERMISSIONS,
      dataSource: 'demo',
    });
    mockGetSystemsState.mockResolvedValue(null);
    mockGetPortalSettings.mockResolvedValue(null);
    mockGetChatStatus.mockResolvedValue(null);
    mockGetChatSettings.mockResolvedValue(null);

    renderSystems('/systems');
    expect(await screen.findByText('SecureSSID-LAB-Central')).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Plane selection actions' })).toBeNull();

    fireEvent.click(screen.getByRole('checkbox', { name: 'Select plane SecureSSID-LAB-Central' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select plane Mist' }));

    const bar = await screen.findByRole('region', { name: 'Plane selection actions' });
    expect(within(bar).getByText('2 SELECTED')).toBeTruthy();
    expect(within(bar).getByRole('button', { name: 'Copy plane ids' })).toBeTruthy();

    fireEvent.click(within(bar).getByRole('button', { name: 'Export selected' }));
    expect(await screen.findByText(/Exported 2 selected plane/)).toBeTruthy();
    expect(createObjectURL).toHaveBeenCalled();

    fireEvent.click(within(bar).getByRole('button', { name: 'Copy plane ids' }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(String(writeText.mock.calls[0]![0])).toBe('central\nmist');

    fireEvent.click(within(bar).getByRole('button', { name: 'Copy selection link' }));
    await waitFor(() => expect(writeText.mock.calls.length).toBeGreaterThanOrEqual(2));
    expect(String(writeText.mock.calls.at(-1)![0])).toMatch(/ids=/);

    fireEvent.click(within(bar).getByRole('button', { name: 'Clear' }));
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: 'Plane selection actions' })).toBeNull(),
    );
  });

  it('deep-links ?ids= and shows a clearable selection chip', async () => {
    const central: SystemRow = {
      ...SYSTEMS[0]!,
      name: 'SecureSSID-LAB-Central',
      planeId: 'central',
      state: 'healthy',
    };
    const mist: SystemRow = {
      ...SYSTEMS[1]!,
      name: 'Mist',
      planeId: 'mist',
      state: 'healthy',
    };
    mockGetSystems.mockResolvedValue({
      systems: [central, mist],
      syncHistory: SYNC_HISTORY,
      permissions: PERMISSIONS,
      dataSource: 'demo',
    });
    mockGetSystemsState.mockResolvedValue(null);
    mockGetPortalSettings.mockResolvedValue(null);
    mockGetChatStatus.mockResolvedValue(null);
    mockGetChatSettings.mockResolvedValue(null);

    renderSystems(`/systems?ids=${encodeURIComponent('central')}`);
    expect(await screen.findByText('SecureSSID-LAB-Central')).toBeTruthy();
    /* Plane row only — MistSection may still mention the product elsewhere. */
    expect(
      screen.queryByRole('checkbox', { name: 'Select plane Mist' }),
    ).toBeNull();
    expect(
      screen.getByRole('checkbox', { name: 'Select plane SecureSSID-LAB-Central' }),
    ).toBeTruthy();
    const chip = await screen.findByRole('button', {
      name: 'Clear plane selection link filter',
    });
    fireEvent.click(chip);
    expect(
      await screen.findByRole('checkbox', { name: 'Select plane Mist' }),
    ).toBeTruthy();
  });
});

/* Loop 202 — roster filtered empty Clear filters CTA. */
describe('Systems Loop 202 residuals', () => {
  it('offers Clear filters when the roster filter is empty', async () => {
    mockGetSystems.mockResolvedValue(DEMO_PAYLOAD);
    mockGetSystemsState.mockResolvedValue(null);
    mockGetPortalSettings.mockResolvedValue(null);
    mockGetChatStatus.mockResolvedValue(null);
    mockGetChatSettings.mockResolvedValue(null);

    renderSystems('/systems?q=zzzz-no-match');
    expect(await screen.findByText(/Nothing matches this roster filter/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(await screen.findByText('HPE Aruba Central')).toBeTruthy();
    expect(
      screen.getByRole('checkbox', { name: 'Select plane HPE Aruba Central' }),
    ).toBeTruthy();
  });
});
