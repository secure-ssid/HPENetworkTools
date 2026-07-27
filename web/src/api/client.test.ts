import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_SETTINGS,
  getAlerts,
  getChangeHistory,
  getChangeQueue,
  getConfigure,
  getDeviceDetail,
  getDevices,
  getChatStatus,
  getOverview,
  getSettings,
  getSiteDetail,
  getSystems,
  getSystemsState,
  getTerminalSession,
  getTerminalSessions,
  saveSettings,
  syncSystems,
} from './client';
import type { Settings } from './client';
import {
  DEVICES,
  DEVICE_RECONCILIATION,
  deviceProfile,
  terminalBanner,
  terminalQuickCommands,
} from '../../../shared';

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

  it('sends the route’s terminal payload in the offline demo envelope too', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('connection refused')));

    const data = await getDeviceDetail(DEVICES[0].name);
    const kind = deviceProfile(DEVICES[0].name).kind;
    expect(data.dataSource).toBe('demo');
    // Same envelope the demo ROUTE serves — the terminal panel must not change
    // behaviour depending on whether the backend happens to be running.
    expect(data.terminal?.quickCommands).toEqual(terminalQuickCommands(kind));
    expect(data.terminal?.banner).toEqual(terminalBanner(kind));
  });

  it('passes the per-device evidence block through the device-detail envelope', async () => {
    mockFetch({
      ok: true,
      body: {
        dataSource: 'live',
        device: { name: 'sw-core-a' },
        profile: null,
        config: null,
        clients: null,
        evidence: {
          mode: 'live',
          checks: [{ mark: 'fail', tone: 'warning', label: 'Plane freshness', rule: 'scan.coverage.freshness' }],
        },
      },
    });

    const data = await getDeviceDetail('sw-core-a');
    expect(data.evidence?.mode).toBe('live');
    expect(data.evidence?.checks.map((c) => c.rule)).toEqual(['scan.coverage.freshness']);
  });

  it('reads an empty bare checks list as "no evidence", never as an all-pass scorecard', async () => {
    mockFetch({
      ok: true,
      body: {
        dataSource: 'live',
        device: { name: 'sw-core-a' },
        profile: null,
        config: null,
        clients: null,
        checks: [],
      },
    });

    const data = await getDeviceDetail('sw-core-a');
    expect(data.evidence?.mode).toBe('unavailable');
    expect(data.evidence?.checks).toEqual([]);
    expect(data.evidence?.note).toBeTruthy();
    expect((data as { checks?: unknown }).checks).toBeUndefined();
  });

  it('normalizes a populated bare checks list into the live evidence block', async () => {
    mockFetch({
      ok: true,
      body: {
        dataSource: 'live',
        device: { name: 'sw-core-a' },
        profile: null,
        config: null,
        clients: null,
        checks: [{ mark: 'pass', tone: 'success', label: 'Identity evidence', rule: 'scan.coverage.identity' }],
      },
    });

    const data = await getDeviceDetail('sw-core-a');
    expect(data.evidence).toEqual({
      mode: 'live',
      checks: [{ mark: 'pass', tone: 'success', label: 'Identity evidence', rule: 'scan.coverage.identity' }],
    });
  });

  it('passes a server-derived alert correlation, tone and all, through the envelope', async () => {
    mockFetch({
      ok: true,
      body: {
        dataSource: 'live',
        syncedAt: '2026-07-26T09:41:00.000Z',
        alerts: [],
        correlation: {
          title: 'Two planes are behind',
          body: 'The queue below is unverified, not quiet.',
          tone: 'warning',
        },
      },
    });

    const data = await getAlerts();
    expect(data.correlation?.tone).toBe('warning');
    expect(data.correlation?.title).toBe('Two planes are behind');
  });

  it('leaves the alert correlation absent when the route sends none', async () => {
    mockFetch({ ok: true, body: { dataSource: 'live', syncedAt: null, alerts: [] } });

    const data = await getAlerts();
    expect(data.correlation).toBeUndefined();
  });

  it('passes the live "Local reachability" block through the site-detail envelope', async () => {
    mockFetch({
      ok: true,
      body: {
        dataSource: 'live',
        site: { id: 'campus-01', name: 'Campus-01' },
        profile: null,
        reachability: {
          collector: 'not linked',
          collectorTone: 'neutral',
          reachValue: null,
          collectorNote: 'No local collector is linked, so no device answers directly.',
        },
      },
    });

    const data = await getSiteDetail('campus-01');
    expect(data.profile).toBeNull();
    // null, not 0 — the panel renders '—' rather than an empty progress bar.
    expect(data.reachability?.reachValue).toBeNull();
    expect(data.reachability?.collector).toBe('not linked');
  });

  it('carries the authored demo evidence in the offline device-detail envelope', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('connection refused')));

    const name = DEVICES[0].name;
    const data = await getDeviceDetail(name);
    // The authored profile IS the demo evidence — served under the same key the
    // live branch uses, so a screen reading `evidence` uniformly keeps the
    // Compliance panel when there is no backend at all.
    expect(data.evidence?.mode).toBe('demo');
    expect(data.evidence?.checks).toEqual(deviceProfile(name).checks);
    expect(data.evidence?.checks.length).toBeGreaterThan(0);
    expect(data.evidence?.note).toBeUndefined();
  });

  it('passes the live shell gate (localShell) through untouched', async () => {
    mockFetch({
      ok: true,
      body: {
        dataSource: 'live',
        device: { name: 'ap-3f-12', plane: 'MIST', localShell: false, reconciliationIssue: false },
        profile: null,
        config: null,
        clients: null,
      },
    });

    const data = await getDeviceDetail('ap-3f-12');
    // One field decides whether the pane may dial — the client must never
    // re-derive or optimistically default it.
    expect(data.device?.localShell).toBe(false);
  });

  it('keeps the reconciliation counts a demo-sourced devices payload already carries', async () => {
    mockFetch({
      ok: true,
      body: {
        dataSource: 'demo',
        devices: [],
        lanes: {},
        reconciliation: { doubleClaimed: 2, unclaimed: 1 },
        hiddenDevices: ['sw-acc-3f-2'],
      },
    });

    const data = await getDevices();
    // The route is authoritative in both modes: the counts are not a
    // client-side demo-only substitution.
    expect(data.reconciliation).toEqual({ doubleClaimed: 2, unclaimed: 1 });
    expect(data.hiddenDevices).toEqual(['sw-acc-3f-2']);
  });

  it('passes the alert site as its own field, not only as meta prose', async () => {
    mockFetch({
      ok: true,
      body: {
        dataSource: 'live',
        syncedAt: '2026-07-26T09:41:00.000Z',
        stats: [],
        alerts: [
          {
            sev: 'P1',
            tone: 'danger',
            title: 'mm-lake-1 lost heartbeat',
            meta: 'AOS-8 cluster',
            plane: 'AOS-8',
            age: '41m',
            device: 'mm-lake-1',
            siteName: 'Lakeshore Medical Center',
            siteId: 'lakeshore',
          },
        ],
        sites: [],
        planes: [],
        changes: [],
        launchpad: [],
      },
    });

    const data = await getOverview();
    expect(data.alerts[0].siteName).toBe('Lakeshore Medical Center');
    expect(data.alerts[0].siteId).toBe('lakeshore');
    // The site is no longer welded into the prose, so a renderer can place it.
    expect(data.alerts[0].meta).toBe('AOS-8 cluster');
  });

  it('passes the broker change id and lease through the configure queue rows', async () => {
    mockFetch({
      ok: true,
      body: {
        dataSource: 'live',
        stats: [],
        ssids: [],
        ports: [],
        vlans: [],
        inventoryMode: 'observed',
        capabilities: [],
        queued: [
          {
            state: 'ready',
            tone: 'success',
            what: 'Add DHCP helper 10.44.0.20 to vlan 812',
            where: '2 core switches',
            ticket: 'NET-4166',
            id: 'chg-7f21',
            expiresAt: '2026-07-26T10:00:00.000Z',
          },
        ],
      },
    });

    const data = await getConfigure();
    // Without the id a queued change stops being pushable after a reload.
    expect(data.queued[0].id).toBe('chg-7f21');
    expect(data.queued[0].expiresAt).toBe('2026-07-26T10:00:00.000Z');
  });

  it('leaves the offline demo queue rows id-less, which is what makes them non-pushable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('connection refused')));

    const data = await getConfigure();
    expect(data.queued.length).toBeGreaterThan(0);
    for (const row of data.queued) {
      expect(row.id ?? null).toBeNull();
      expect(row.expiresAt ?? null).toBeNull();
    }
  });

  it('returns the broker audit rows from the change-history envelope', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({
        events: [
          {
            ts: '2026-07-26T09:41:00.000Z',
            event: 'push',
            changeId: 'chg-7f21',
            ticket: 'NET-4166',
            kind: 'vlan',
            result: 'applied',
          },
        ],
      }),
    });
    vi.stubGlobal('fetch', fetchSpy);

    const events = await getChangeHistory();
    expect(fetchSpy.mock.calls[0][0]).toBe('/api/configure/history?limit=50');
    expect(Array.isArray(events) && events[0]).toMatchObject({
      changeId: 'chg-7f21',
      ticket: 'NET-4166',
      result: 'applied',
    });
  });

  it('surfaces an HTTP failure on the audit log instead of an empty history', async () => {
    // An empty list would read as "nothing has ever been brokered here" —
    // the opposite of what a 500 means.
    mockFetch({ ok: false, status: 500, body: { error: 'audit log unreadable' } });

    const events = await getChangeHistory();
    expect(events).toEqual({ error: 'audit log unreadable' });
  });

  it('treats a wrong-shaped 200 on the audit log as an API failure, not an empty log', async () => {
    // A 200 whose body has no `events` array used to flow through as
    // `undefined`, which the drawer would render as "nothing brokered yet".
    mockFetch({ ok: true, body: { ok: true } });

    expect(await getChangeHistory()).toEqual({
      error: 'The portal API returned an unexpected change-history payload.',
    });
  });

  it('treats a wrong-shaped 200 on the change queue as an API failure, not an empty queue', async () => {
    // An undefined queue would read as "nothing is pending" while the broker
    // may in fact be holding changes the operator cannot see.
    mockFetch({ ok: true, body: { changes: { id: 'chg-7f21' } } });

    expect(await getChangeQueue()).toEqual({
      error: 'The portal API returned an unexpected change-queue payload.',
    });
  });

  it('returns the broker queue rows from a well-shaped envelope', async () => {
    mockFetch({ ok: true, body: { changes: [{ id: 'chg-7f21', ticket: 'NET-4166' }] } });

    const queue = await getChangeQueue();
    expect(Array.isArray(queue) && queue[0]).toMatchObject({ id: 'chg-7f21', ticket: 'NET-4166' });
  });

  it('returns null (never fixtures) for the audit log when no backend answers', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('connection refused')));

    // There is no authored audit log: substituting one would be a fabricated
    // record of changes this install never brokered.
    expect(await getChangeHistory()).toBeNull();
  });

  it('passes the per-plane console URL through the systems envelope', async () => {
    mockFetch({
      ok: true,
      body: {
        dataSource: 'live',
        systems: [
          { name: 'HPE Aruba Central', planeId: 'central', consoleUrl: 'https://app-us4.central.arubanetworks.com', sites: [], pulls: [] },
          { name: 'Local switch collector', planeId: 'local', sites: [], pulls: [] },
        ],
        syncHistory: [],
        permissions: [],
      },
    });

    const data = await getSystems();
    expect(data.systems[0].consoleUrl).toBe('https://app-us4.central.arubanetworks.com');
    // No URL recorded — "Open console" must stay inert rather than invent one.
    expect(data.systems[1].consoleUrl).toBeUndefined();
  });

  it('carries the authored console URLs in the offline systems envelope', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('connection refused')));

    const data = await getSystems();
    const byName = new Map(data.systems.map((s) => [s.name, s.consoleUrl]));
    expect(byName.get('HPE Aruba Central')).toBe('https://app-us4.central.arubanetworks.com');
    expect(byName.get('Local switch collector')).toBeUndefined();
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
