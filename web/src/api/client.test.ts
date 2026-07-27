import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_SETTINGS,
  getDeviceDetail,
  getDevices,
  getChatStatus,
  getOverview,
  getSettings,
  getSiteDetail,
  getSystemsState,
  getTerminalSession,
  getTerminalSessions,
  saveSettings,
  syncSystems,
} from './client';
import type { Settings } from './client';
import { DEVICE_RECONCILIATION } from '../../../shared';

afterEach(() => {
  vi.unstubAllGlobals();
});

function mockFetch(response: {
  ok: boolean;
  status?: number;
  body?: unknown;
}) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: response.ok,
      status: response.status ?? (response.ok ? 200 : 500),
      json: vi.fn().mockResolvedValue(response.body ?? {}),
    }),
  );
}

describe('screen API source handling', () => {
  it('preserves the server dataSource instead of relabeling demo responses as live', async () => {
    mockFetch({
      ok: true,
      body: {
        dataSource: 'demo',
        syncedAt: '2026-07-26T09:41:00.000Z',
        stats: [],
        alerts: [],
        sites: [],
        planes: [],
        changes: [],
        launchpad: [],
      },
    });

    const data = await getOverview();
    expect(data.dataSource).toBe('demo');
  });

  it('returns an explicit live API error instead of fixture devices for an HTTP failure', async () => {
    mockFetch({ ok: false, status: 500, body: { error: 'poller unavailable' } });

    const data = await getDevices();
    expect(data.dataSource).toBe('live');
    expect(data.devices).toEqual([]);
    expect(data.apiError).toBe('poller unavailable');
  });

  it('uses fixtures only when no backend answers', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('connection refused')));

    const data = await getDevices();
    expect(data.dataSource).toBe('demo');
    expect(data.devices.length).toBeGreaterThan(0);
    expect(data.apiError).toBeUndefined();
  });

  it('preserves demo source metadata on an answered detail 404', async () => {
    mockFetch({
      ok: false,
      status: 404,
      body: { error: 'unknown device', dataSource: 'demo', syncedAt: '2026-07-26T09:41:00.000Z' },
    });

    const data = await getDeviceDetail('missing-device');
    expect(data.device).toBeNull();
    expect(data.dataSource).toBe('demo');
  });

  it('does not fabricate an unknown device profile when the backend is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('connection refused')));

    const data = await getDeviceDetail('missing-device');
    expect(data).toMatchObject({ device: null, profile: null, config: null, clients: null, dataSource: 'demo' });
  });

  it('treats malformed JSON from a successful screen response as an API error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: vi.fn().mockRejectedValue(new SyntaxError('bad json')),
      }),
    );

    const data = await getDevices();
    expect(data.devices).toEqual([]);
    expect(data.dataSource).toBe('live');
    expect(data.apiError).toMatch(/invalid JSON/);
  });

  it('reports partial manual-sync failures instead of showing a false success', async () => {
    mockFetch({
      ok: true,
      body: { ok: false, started: ['central'], failed: ['central'] },
    });

    const result = await syncSystems();
    expect(result.ok).toBe(false);
    expect(result.message).toContain('failed to synchronize');
  });

  it('surfaces answered terminal storage failures instead of showing an empty list', async () => {
    mockFetch({ ok: false, status: 500, body: { error: 'internal error' } });
    await expect(getTerminalSessions('sw-core-a')).rejects.toThrow('internal error');
  });

  it('returns null only for a genuinely missing terminal transcript', async () => {
    mockFetch({ ok: false, status: 404, body: { error: 'unknown session recording' } });
    await expect(getTerminalSession('missing.jsonl')).resolves.toBeNull();
  });

  it('distinguishes an answered optional API failure from an unreachable backend', async () => {
    mockFetch({ ok: false, status: 500, body: { error: 'status probe failed' } });
    await expect(getChatStatus()).rejects.toThrow('status probe failed');

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('connection refused')));
    await expect(getChatStatus()).resolves.toBeNull();
  });

  it('passes the live per-site device and alert sections through the site-detail envelope', async () => {
    mockFetch({
      ok: true,
      body: {
        dataSource: 'live',
        site: { id: 'campus-01', name: 'Campus-01' },
        profile: null,
        devices: [
          {
            name: 'sw-core-a',
            model: 'CX 6400',
            plane: 'CENTRAL',
            planeTone: 'info',
            role: '—',
            state: 'up',
            stateTone: 'ok',
            uptime: '—',
          },
        ],
        alerts: [{ sev: 'MAJOR', tone: 'warning', title: 'AP down', meta: 'campus-01' }],
      },
    });

    const data = await getSiteDetail('campus-01');
    expect(data.profile).toBeNull();
    expect(data.devices?.map((d) => d.name)).toEqual(['sw-core-a']);
    expect(data.alerts?.map((a) => a.title)).toEqual(['AP down']);
  });

  it('does not fabricate a site page for a bookkeeping pseudo-site id when the backend is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('connection refused')));

    for (const pseudo of ['core-services', 'workspace', 'multiple']) {
      const data = await getSiteDetail(pseudo);
      expect(data).toEqual({ site: null, profile: null, dataSource: 'demo' });
    }
  });

  it('derives the offline profile from the site’s own inventory row instead of Warehouse-DC1’s numbers', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('connection refused')));

    const data = await getSiteDetail('northgate');
    expect(data.site?.id).toBe('northgate');
    expect(data.profile?.siteId).toBe('northgate');
    // The old fallback answered every unauthored site with the local-only
    // profile: Warehouse-DC1's core switch, subnet and device count.
    expect(data.profile?.core).not.toBe('sw-wh1-1');
    expect(data.profile?.devices.map((d) => d.name)).not.toContain('sw-wh1-1');
    expect(data.profile?.deviceCount).toBe(String(data.site?.devices));
  });

  it('carries the reconciliation counts in the offline device envelope', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('connection refused')));

    const data = await getDevices();
    expect(data.reconciliation).toEqual(DEVICE_RECONCILIATION);
  });

  it('passes the route’s terminal banner and chips through the device-detail envelope', async () => {
    mockFetch({
      ok: true,
      body: {
        dataSource: 'demo',
        device: { name: 'sw-core-a' },
        profile: { kind: 'cx' },
        config: null,
        clients: null,
        terminal: {
          banner: [{ text: 'Connecting …', tone: 'muted' }],
          quickCommands: ['show version', 'show vlan'],
        },
      },
    });

    const data = await getDeviceDetail('sw-core-a');
    expect(data.terminal?.quickCommands).toEqual(['show version', 'show vlan']);
    expect(data.terminal?.banner.map((l) => l.text)).toEqual(['Connecting …']);
  });

  it('keeps the per-plane freshness the registry stamps on /api/systems/state', async () => {
    mockFetch({
      ok: true,
      body: {
        dataSource: 'live',
        syncedAt: '2026-07-26T09:41:00.000Z',
        demoMode: false,
        planes: {
          central: {
            id: 'central',
            linked: true,
            health: 'degraded',
            lastSync: '2026-07-26T08:00:00.000Z',
            deviceCount: 9,
            callsToday: 42,
            note: null,
            recentCalls: [],
            stale: true,
            ageSec: 6060,
            callBudget: 5000,
            scope: 'read + broker',
          },
        },
        history: [],
      },
    });

    const state = await getSystemsState();
    expect(state?.dataSource).toBe('live');
    expect(state?.syncedAt).toBe('2026-07-26T09:41:00.000Z');
    expect(state?.planes.central.stale).toBe(true);
    expect(state?.planes.central.ageSec).toBe(6060);
    expect(state?.planes.central.callBudget).toBe(5000);
    expect(state?.planes.central.scope).toBe('read + broker');
  });
});

describe('shell settings', () => {
  it('keeps only the five shell keys out of the full masked settings store', async () => {
    mockFetch({
      ok: true,
      body: {
        density: 'compact',
        inventoryView: 'Platform lanes',
        showPlatformTags: false,
        workspaceName: 'Meridian Health',
        pollIntervalSec: 30,
        demoMode: true,
        blendLive: true,
        sectionMode: { devices: 'live' },
        hiddenDemoDevices: ['ap-3f-01'],
        planes: { central: { token: '••••' } },
        mcp: { url: 'http://localhost:9000' },
        llm: { model: 'claude' },
      },
    });

    const settings = await getSettings();
    expect(settings).toEqual({
      density: 'compact',
      inventoryView: 'Platform lanes',
      showPlatformTags: false,
      workspaceName: 'Meridian Health',
      pollIntervalSec: 30,
    });
  });

  it('PUTs only the shell preferences, never demoMode or plane credentials', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: vi.fn().mockResolvedValue({}) });
    vi.stubGlobal('fetch', fetchMock);

    const wider = {
      ...DEFAULT_SETTINGS,
      density: 'compact',
      demoMode: true,
      sectionMode: { devices: 'live' },
      planes: { central: { token: '••••' } },
    } as unknown as Settings;
    const result = await saveSettings(wider);

    expect(result.ok).toBe(true);
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual([
      'density',
      'inventoryView',
      'pollIntervalSec',
      'showPlatformTags',
      'workspaceName',
    ]);
    expect(body.density).toBe('compact');
  });
});
