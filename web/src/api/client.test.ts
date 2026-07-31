import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_SETTINGS,
  acknowledgeCentralWebhookHandoff,
  cleanupSseManualReconciliation,
  createCentralWebhook,
  createSseObject,
  getAlerts,
  getChangeHistory,
  getChangeQueue,
  getClientDetail,
  getClients,
  getConfigure,
  getDeviceDetail,
  getDiagnosticEligibility,
  getCentralWebhookHandoffStatus,
  startDiagnostic,
  getDevices,
  getChatStatus,
  getOverview,
  getSettings,
  getSiteDetail,
  getSiteTopology,
  getSseKind,
  getSystems,
  getSystemsState,
  getTerminalSession,
  getTerminalSessions,
  isApiError,
  isUnknownWebhookOutcome,
  retrySseCommit,
  rebootDevice,
  resolveCentralWebhookHandoff,
  rotateCentralWebhookHmacKey,
  saveSettings,
  syncSystems,
  updateCentralWebhook,
} from './client';
import type { Settings } from './client';
import {
  DEVICES,
  DEVICE_RECONCILIATION,
  deviceProfile,
  terminalBanner,
  terminalQuickCommands,
} from '@hpe/shared';
import type { WebhookForm } from '@hpe/shared';

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

/** Same as mockFetch, but returns the fetch mock so a test can inspect the
 *  exact URL a client function requested. */
function mockFetchCapture(response: { ok: boolean; status?: number; body?: unknown }) {
  const fn = vi.fn().mockResolvedValue({
    ok: response.ok,
    status: response.status ?? (response.ok ? 200 : 500),
    json: vi.fn().mockResolvedValue(response.body ?? {}),
  });
  vi.stubGlobal('fetch', fn);
  return fn;
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

  describe('diagnostics API client', () => {
    it('preserves live eligibility and sends the explicit confirmation gate', async () => {
      const fetchMock = vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: vi.fn().mockResolvedValue({
            operation: 'traceroute',
            source: 'live-inventory',
            devices: [],
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 202,
          json: vi.fn().mockResolvedValue({
            id: 'j1',
            state: 'running',
            operation: 'traceroute',
          }),
        });

      vi.stubGlobal('fetch', fetchMock);

      expect((await getDiagnosticEligibility()).source).toBe('live-inventory');
      await startDiagnostic('review-1', 'CENTRAL', 'AP-SERIAL');
      expect(fetchMock).toHaveBeenLastCalledWith('/api/diagnostics/start', expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ reviewId: 'review-1', confirmed: true, plane: 'CENTRAL', serial: 'AP-SERIAL' }),
      }));
    });
  });

  it('encodes the reboot route and sends exact plane+serial identity in the payload', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({
        ok: true,
        applied: true,
        device: 'ap/shared name',
        plane: 'CENTRAL',
        serial: 'SERIAL/1',
        ticket: 'NET-1',
        message: 'accepted',
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await rebootDevice('ap/shared name', 'NET-1', {
      plane: 'CENTRAL',
      serial: 'SERIAL/1',
    });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/devices/ap%2Fshared%20name/reboot',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          ticket: 'NET-1',
          plane: 'CENTRAL',
          serial: 'SERIAL/1',
        }),
      }),
    );
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
      body: { ok: false, started: ['central'], synced: [], failed: ['central'] },
    });

    const result = await syncSystems();
    expect(result.ok).toBe(false);
    expect(result.message).toContain('1 failed');
  });

  /* A run that refreshed four planes and lost one used to report only the
   * loss: the failure clause REPLACED the success clause, so an operator who
   * clicked Sync could not tell whether anything on screen had moved. */
  it('keeps the success count beside the failure count', async () => {
    mockFetch({
      ok: true,
      body: {
        ok: false,
        requested: ['central', 'mist', 'greenlake', 'uxi', 'clearpass'],
        started: ['central', 'mist', 'greenlake', 'uxi', 'clearpass'],
        synced: ['central', 'mist', 'greenlake', 'uxi'],
        failed: ['clearpass'],
      },
    });

    const result = await syncSystems();
    expect(result.message).toContain('4 linked systems synchronized');
    expect(result.message).toContain('1 failed');
  });

  /* The defect. tick() answers 'skipped' for five different situations and the
   * summary called every one of them "already syncing". A plane still on the
   * StubAdapter is skipped on every cycle forever — it holds credentials and
   * has no implementation to spend them on — so the operator was told to wait
   * for a sync that was never going to start. */
  it('does not call a plane with no sync adapter "already syncing"', async () => {
    mockFetch({
      ok: true,
      body: {
        ok: true,
        requested: ['central', 'local'],
        started: ['central'],
        synced: ['central'],
        skipped: ['local'],
        skippedReason: { local: 'no-adapter' },
      },
    });

    const result = await syncSystems();
    expect(result.message).toContain('1 has no sync adapter yet');
    expect(result.message).not.toContain('already syncing');
    expect(result.message).toContain('1 linked system synchronized');
  });

  it('still says "already syncing" for a plane that genuinely is', async () => {
    mockFetch({
      ok: true,
      body: {
        ok: true,
        started: ['central'],
        synced: ['central'],
        skipped: ['mist'],
        skippedReason: { mist: 'in-flight' },
      },
    });

    expect((await syncSystems()).message).toContain('1 already syncing');
  });

  it('groups mixed skip reasons rather than merging them into one number', async () => {
    mockFetch({
      ok: true,
      body: {
        ok: true,
        started: ['central'],
        synced: ['central'],
        skipped: ['mist', 'local', 'aos8'],
        skippedReason: { mist: 'in-flight', local: 'no-adapter', aos8: 'no-adapter' },
      },
    });

    const result = await syncSystems();
    expect(result.message).toContain('1 already syncing');
    expect(result.message).toContain('2 has no sync adapter yet');
  });

  it('will not borrow another skip reason for a skip the server did not explain', async () => {
    mockFetch({
      ok: true,
      body: { ok: true, started: ['central'], synced: ['central'], skipped: ['mist'] },
    });

    const result = await syncSystems();
    expect(result.message).toContain('1 skipped for an unstated reason');
    expect(result.message).not.toContain('already syncing');
  });

  it('surfaces answered terminal storage failures instead of showing an empty list', async () => {
    mockFetch({ ok: false, status: 500, body: { error: 'internal error' } });
    await expect(getTerminalSessions('sw-core-a')).rejects.toThrow('internal error');
  });

  it('returns null only for a genuinely missing terminal transcript', async () => {
    mockFetch({ ok: false, status: 404, body: { error: 'unknown session recording' } });
    await expect(getTerminalSession('missing.jsonl', 'sw-core-a')).resolves.toBeNull();
  });

  it('encodes device+plane+serial into the recorded-sessions listing query', async () => {
    const fetchMock = mockFetchCapture({ ok: true, body: { sessions: [] } });
    await getTerminalSessions('shared name', { plane: 'LOCAL', serial: 'SERIAL/1' });
    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toContain('/api/terminal/sessions?');
    expect(url).toContain('device=shared+name');
    expect(url).toContain('plane=LOCAL');
    expect(url).toContain('serial=SERIAL%2F1');
  });

  it('a legacy call with no identity sends no plane/serial params at all', async () => {
    const fetchMock = mockFetchCapture({ ok: true, body: { sessions: [] } });
    await getTerminalSessions('sw-core-a');
    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).not.toContain('plane=');
    expect(url).not.toContain('serial=');
  });

  it('throws an honest error when the server reports an ambiguous shared name, never a silently-picked list', async () => {
    mockFetch({ ok: true, body: { sessions: [], ambiguous: true } });
    await expect(getTerminalSessions('shared-name')).rejects.toThrow(/names more than one device/);
  });

  it('encodes device+plane+serial into the transcript read query', async () => {
    const fetchMock = mockFetchCapture({ ok: true, body: { file: 'a.jsonl', events: [], truncated: false } });
    await getTerminalSession('a.jsonl', 'shared name', { plane: 'LOCAL', serial: 'SERIAL/1' });
    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toContain('/api/terminal/sessions/a.jsonl?');
    expect(url).toContain('device=shared+name');
    expect(url).toContain('plane=LOCAL');
    expect(url).toContain('serial=SERIAL%2F1');
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

    const history = await getChangeHistory();
    expect(fetchSpy.mock.calls[0][0]).toBe('/api/configure/history?limit=50');
    expect(history && 'events' in history && history.events[0]).toMatchObject({
      changeId: 'chg-7f21',
      ticket: 'NET-4166',
      result: 'applied',
    });
    // A server that says nothing about unreadable generations is not making a
    // claim of partiality, so the drawer must not invent one.
    expect(history && 'unreadable' in history && history.unreadable).toEqual([]);
  });

  it('carries the generations the server could not read alongside the events', async () => {
    // The events list comes back short. Without this field the drawer would
    // show a plausible, continuous history and the missing stretch would read
    // as "nothing was brokered then".
    mockFetch({
      ok: true,
      body: { events: [{ ts: '2026-01-01T00:00:00Z', changeId: 'chg-1' }], unreadable: ['change-log.2.jsonl'] },
    });

    const history = await getChangeHistory();
    expect(history && 'unreadable' in history && history.unreadable).toEqual(['change-log.2.jsonl']);
  });

  it('ignores a non-string entry in unreadable rather than rendering it', async () => {
    mockFetch({ ok: true, body: { events: [], unreadable: ['change-log.2.jsonl', 7, null] } });

    const history = await getChangeHistory();
    expect(history && 'unreadable' in history && history.unreadable).toEqual(['change-log.2.jsonl']);
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

describe('on-demand detail payloads', () => {
  const clientSource = {
    plane: 'central',
    at: '2026-07-28T15:58:08.279Z',
    sections: { rssi: 'empty', tput: 'ok', roams: 'ok', timeline: 'empty' },
    cached: false,
    note: null,
  };

  it('passes a client detail read through with its three-state provenance intact', async () => {
    // Live shape from the tenant: a stationary camera — 0 roams and an empty
    // trail are REAL answers, and rssi is null because the plane reported none.
    mockFetch({
      ok: true,
      body: {
        dataSource: 'live',
        stats: [],
        clients: [],
        client: { mac: '00:0b:86:b8:c4:b8' },
        detail: {
          mac: '00:0b:86:b8:c4:b8',
          rssi: null,
          roams: 0,
          roamsWindowSec: 86_400,
          timeline: [],
          usageSeries: [{ ts: '2026-07-28T12:55:00Z', txBytes: 64_654, rxBytes: 366_581 }],
          source: clientSource,
        },
      },
    });

    const detail = await getClientDetail('00:0b:86:b8:c4:b8');
    expect(detail?.roams).toBe(0);
    expect(detail?.rssi).toBeNull();
    // Present-and-empty is "no roaming in the last 24h", which is only legible
    // next to sections.timeline === 'empty'. Neither may be dropped or filled.
    expect(detail?.timeline).toEqual([]);
    expect(detail?.source.sections).toEqual(clientSource.sections);
    expect(detail?.usageSeries?.[0].rxBytes).toBe(366_581);
    // Nothing the plane may learn to report later is stripped on the way past.
    expect(detail?.roamsWindowSec).toBe(86_400);
  });

  it('asks for a client detail on the named-client route, never on the list poll', async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValue({ ok: true, status: 200, json: vi.fn().mockResolvedValue({ dataSource: 'live', stats: [], clients: [] }) });
    vi.stubGlobal('fetch', fetchSpy);

    await getClients();
    await getClientDetail('00:0b:86:b8:c4:b8');

    // The per-object read happens only when a request names a client: a plain
    // list poll that carried a MAC would spend a plane call every 60 seconds.
    expect(fetchSpy.mock.calls[0][0]).toBe('/api/clients');
    expect(fetchSpy.mock.calls[1][0]).toBe('/api/clients?mac=00%3A0b%3A86%3Ab8%3Ac4%3Ab8');
  });

  it('returns null (never fixtures, never an error banner) when a detail read cannot be served', async () => {
    // The route's own honest "no plane could answer for this MAC".
    mockFetch({ ok: true, body: { dataSource: 'live', stats: [], clients: [], detail: null } });
    expect(await getClientDetail('00:0b:86:b8:c4:b8')).toBeNull();

    // An HTTP failure on a SUPPLEMENTARY read leaves the drawer's other rows
    // standing — it must not blank the screen, and must not invent a reading.
    mockFetch({ ok: false, status: 500, body: { error: 'detail read failed' } });
    expect(await getClientDetail('00:0b:86:b8:c4:b8')).toBeNull();

    // No backend at all: there is no authored client detail to fall back to.
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('connection refused')));
    expect(await getClientDetail('00:0b:86:b8:c4:b8')).toBeNull();
  });

  it('discards a detail payload that arrived without provenance', async () => {
    // Numbers with no source.sections cannot be told apart from "not fetched"
    // downstream, so they must not reach an operator as if they were current.
    mockFetch({
      ok: true,
      body: { dataSource: 'live', stats: [], clients: [], detail: { mac: 'aa:bb', rssi: -55 } },
    });
    expect(await getClientDetail('aa:bb')).toBeNull();

    const data = await getClients('aa:bb');
    expect(data.detail).toBeUndefined();
    // …and the rest of the screen still renders rather than erroring out.
    expect(data.apiError).toBeUndefined();
    expect(data.dataSource).toBe('live');
  });

  it('passes the per-device radios and WLANs through the device-detail envelope', async () => {
    mockFetch({
      ok: true,
      body: {
        dataSource: 'live',
        device: { name: 'AP735-LR' },
        profile: null,
        config: null,
        clients: null,
        detail: {
          serial: 'PHT5M520SZ',
          kind: 'ap',
          source: {
            plane: 'central',
            at: '2026-07-28T15:57:13.905Z',
            sections: { radios: 'ok', wlans: 'empty' },
            cached: true,
            note: null,
          },
          radios: [{ number: 0, band: '5 GHz', channel: '157E', retries: 0, noiseFloorDbm: -93 }],
          wlans: [],
        },
      },
    });

    const data = await getDeviceDetail('AP735-LR');
    expect(data.detail?.radios?.[0].channel).toBe('157E');
    // 0 retries is a reading, not a missing value.
    expect(data.detail?.radios?.[0].retries).toBe(0);
    // Three states, all distinct after the boundary: wlans was asked and came
    // back empty, ports was never asked at all.
    expect(data.detail?.wlans).toEqual([]);
    expect(data.detail?.ports).toBeUndefined();
    expect(data.detail?.source.sections).toEqual({ radios: 'ok', wlans: 'empty' });
  });

  it('keeps a failed section marked failed instead of passing it off as empty', async () => {
    mockFetch({
      ok: true,
      body: {
        dataSource: 'live',
        site: { id: 'ext-securessid', name: 'SecureSSID' },
        profile: null,
        topology: {
          siteId: 'SecureSSID',
          source: {
            plane: 'central',
            at: '2026-07-28T15:57:40.658Z',
            sections: { nodes: 'failed', links: 'failed' },
            note: 'topology: HTTP 404',
            cached: true,
          },
        },
      },
    });

    const data = await getSiteDetail('ext-securessid');
    // A failed read has no arrays at all — filling them with [] here would let
    // the page say "this site has no links", which is a different claim.
    expect(data.topology?.nodes).toBeUndefined();
    expect(data.topology?.links).toBeUndefined();
    expect(data.topology?.source.sections).toEqual({ nodes: 'failed', links: 'failed' });
    expect(data.topology?.source.note).toBe('topology: HTTP 404');

    // The same payload, read through the topology getter the drawer uses.
    mockFetch({
      ok: true,
      body: {
        dataSource: 'live',
        site: { id: 'ext-securessid' },
        profile: null,
        topology: {
          siteId: 'SecureSSID',
          nodes: [{ serial: 'SG30LMR164', name: 'CX6300-CORE' }],
          links: [],
          source: { plane: 'central', at: '2026-07-28T15:57:40.658Z', sections: { nodes: 'ok', links: 'empty' } },
        },
      },
    });
    const topology = await getSiteTopology('ext-securessid');
    expect(topology?.nodes?.[0].name).toBe('CX6300-CORE');
    expect(topology?.links).toEqual([]);
    expect(topology?.source.sections.links).toBe('empty');
  });

  it('preserves live success, empty, and cached topology states across the API boundary', async () => {
    const nodes = Array.from({ length: 11 }, (_, index) => ({
      serial: `node-${index}`,
      name: `Node ${index}`,
    }));
    const links = Array.from({ length: 10 }, (_, index) => ({
      from: 'node-0',
      to: `node-${index + 1}`,
      fromPorts: [{ name: `1/1/${index + 1}` }],
      toPorts: [{ name: 'eth0' }],
      speedBps: 1_000_000_000,
      health: 'Good',
    }));
    mockFetch({
      ok: true,
      body: {
        dataSource: 'live',
        site: { id: 'ext-securessid', name: 'SecureSSID' },
        profile: null,
        topology: {
          siteId: 'SecureSSID',
          nodes,
          links,
          source: {
            plane: 'central',
            at: '2026-07-29T06:47:26.761Z',
            sections: { nodes: 'ok', links: 'ok' },
            cached: true,
          },
        },
      },
    });
    const live = await getSiteDetail('ext-securessid');
    expect(live.topology?.nodes).toHaveLength(11);
    expect(live.topology?.links).toHaveLength(10);
    expect(live.topology?.source.cached).toBe(true);
    expect(live.topology?.source.sections).toEqual({ nodes: 'ok', links: 'ok' });

    mockFetch({
      ok: true,
      body: {
        dataSource: 'live',
        site: { id: 'ext-securessid', name: 'SecureSSID' },
        profile: null,
        topology: {
          siteId: 'SecureSSID',
          nodes: [],
          links: [],
          source: {
            plane: 'central',
            at: '2026-07-29T06:48:00.000Z',
            sections: { nodes: 'empty', links: 'empty' },
          },
        },
      },
    });
    const empty = await getSiteDetail('ext-securessid');
    expect(empty.topology?.nodes).toEqual([]);
    expect(empty.topology?.links).toEqual([]);
    expect(empty.topology?.source.sections).toEqual({ nodes: 'empty', links: 'empty' });
  });

  it('drops an unreadable device detail block without blanking the device page', async () => {
    mockFetch({
      ok: true,
      body: {
        dataSource: 'live',
        device: { name: 'AP735-LR' },
        profile: null,
        config: null,
        clients: null,
        detail: { serial: 'PHT5M520SZ', kind: 'ap', radios: [{ number: 0 }] },
      },
    });

    const data = await getDeviceDetail('AP735-LR');
    expect(data.detail).toBeUndefined();
    expect(data.device?.name).toBe('AP735-LR');
    expect(data.apiError).toBeUndefined();
  });
});

describe('SSE mutation and commit API', () => {
  it('preserves a failed kind read instead of returning an empty-list-shaped success', async () => {
    mockFetch({ ok: false, status: 503, body: { error: 'SSE cache read unavailable' } });

    const result = await getSseKind('connectorZones');

    expect(result.rows).toEqual([]);
    expect(result.unavailable).toBe(true);
    expect(result.total).toBeNull();
    expect(result.readStatus).toMatchObject({ state: 'failed', reason: 'service-error', httpCode: 503 });
    expect(result.readError).toBe('SSE cache read unavailable');
  });

  it('does not turn an unrecognized successful list response into an empty success', async () => {
    mockFetch({ ok: true, status: 200, body: { unexpected: [] } });

    const result = await getSseKind('connectorZones');

    expect(result.unavailable).toBe(true);
    expect(result.readStatus).toMatchObject({ state: 'failed', reason: 'invalid-response', httpCode: 200 });
    expect(result.readError).toMatch(/not recognized/i);
  });

  it('reports a portal transport failure as unreachable, not denied', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('connection refused')));

    const result = await getSseKind('connectorZones');

    expect(result.readStatus).toMatchObject({ state: 'failed', reason: 'unreachable', httpCode: null });
  });

  it('identifies a pending journal from its structured code after a frontend reload', async () => {
    mockFetch({
      ok: false,
      status: 409,
      body: {
        error: 'durable recovery is required',
        code: 'SSE_PENDING_MUTATION',
      },
    });

    const result = await createSseObject('connectorZones', { name: 'Blocked zone' });

    expect(result.pendingCommit).toBe(true);
    expect(result.message).toBe('durable recovery is required');
  });

  it('never infers pending journal state from human-readable message text', async () => {
    mockFetch({
      ok: false,
      status: 409,
      body: {
        error:
          'a previous SSE change is staged because its commit failed — resolve it with a commit-only retry before making another change',
        code: 'SOME_OTHER_ERROR',
      },
    });

    const result = await createSseObject('connectorZones', { name: 'Blocked zone' });

    expect(result.pendingCommit).toBeUndefined();
    expect(result.message).toMatch(/previous SSE change is staged/i);
  });

  it('sends the explicit review confirmation and consumes commit/cache outcomes', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({
        commit: {
          attempted: true,
          ok: true,
          httpCode: 204,
          message: 'committed',
          warning: 'Commit is tenant-wide.',
        },
        cacheRefresh: {
          attempted: true,
          status: 'stale',
          message: 'refresh did not complete',
        },
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await retrySseCommit(true);

    expect(fetchMock).toHaveBeenCalledWith('/api/sse/commit/retry', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reviewConfirmed: true }),
    });
    expect(result.result?.commit.warning).toBe('Commit is tenant-wide.');
    expect(result.result?.cacheRefresh.status).toBe('stale');
  });

  it('treats completed cleanup-only recovery as success without requiring Commit success', async () => {
    mockFetch({
      ok: true,
      body: {
        commit: {
          attempted: false,
          ok: false,
          httpCode: null,
          acceptance: 'not-attempted',
          message: 'the rejected mutation journal was cleaned up without calling Commit',
        },
        cacheRefresh: {
          attempted: false,
          status: 'skipped',
          message: 'the rejected mutation required no cache refresh',
        },
        recovery: {
          journalPhase: 'mutation-rejected',
          action: 'cleanup-only',
          mutationVerified: false,
          message: 'the rejected mutation journal was cleaned up without calling tenant-wide Commit',
        },
      },
    });

    const result = await retrySseCommit(true);

    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/cleaned up without calling tenant-wide Commit/i);
    expect(result.result?.commit).toMatchObject({ attempted: false, ok: false });
    expect(result.result?.cacheRefresh.status).toBe('skipped');
  });

  it('keeps failed and manual-reconciliation recovery unsuccessful and preserves error codes', async () => {
    mockFetch({
      ok: true,
      body: {
        commit: {
          attempted: true,
          ok: false,
          httpCode: null,
          acceptance: 'unknown',
          message: 'Commit outcome is unknown',
        },
        cacheRefresh: { attempted: false, status: 'skipped', message: 'cache was not refreshed' },
        recovery: {
          journalPhase: 'commit-transport-unknown',
          action: 'manual-reconciliation',
          mutationVerified: false,
          message: 'manual tenant reconciliation is required',
        },
      },
    });
    expect((await retrySseCommit(true)).ok).toBe(false);

    mockFetch({
      ok: true,
      body: {
        commit: {
          attempted: false,
          ok: false,
          httpCode: null,
          acceptance: 'not-attempted',
          message: 'no recovery action was completed',
        },
        cacheRefresh: { attempted: false, status: 'skipped', message: 'cache was not refreshed' },
      },
    });
    expect((await retrySseCommit(true)).ok).toBe(false);

    mockFetch({
      ok: false,
      status: 500,
      body: {
        error: 'durable journal cleanup is still pending',
        code: 'SSE_JOURNAL_PERSIST_FAILED',
      },
    });
    const failed = await retrySseCommit(true);
    expect(failed).toMatchObject({
      ok: false,
      message: 'durable journal cleanup is still pending',
      code: 'SSE_JOURNAL_PERSIST_FAILED',
    });
  });

  it('does not issue an unreviewed retry request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await retrySseCommit(false);

    expect(result.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends both manual-cleanup acknowledgments and requires journal removal for success', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({
        commit: {
          attempted: false,
          ok: false,
          httpCode: null,
          acceptance: 'not-attempted',
          message: 'Tenant-wide Commit was not called',
        },
        cacheRefresh: {
          attempted: true,
          status: 'refreshed',
          message: 'cache refreshed',
        },
        recovery: {
          journalPhase: 'commit-transport-unknown',
          action: 'manual-cleanup',
          status: 'journal-removed',
          mutationVerified: false,
          message: 'journal removed; tenant-wide Commit was not called',
        },
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await cleanupSseManualReconciliation(true, true);

    expect(fetchMock).toHaveBeenCalledWith('/api/sse/recovery/manual-cleanup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reviewConfirmed: true, manualReconciled: true }),
    });
    expect(result.ok).toBe(true);
    expect(result.result?.recovery.status).toBe('journal-removed');
    expect(result.result?.cacheRefresh.status).toBe('refreshed');
  });

  it('does not issue manual cleanup without both acknowledgments', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    expect((await cleanupSseManualReconciliation(false, true)).ok).toBe(false);
    expect((await cleanupSseManualReconciliation(true, false)).ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('preserves refresh and journal-retained status from a failed manual cleanup', async () => {
    mockFetch({
      ok: false,
      status: 500,
      body: {
        error: 'internal error',
        code: 'SSE_JOURNAL_PERSIST_FAILED',
        result: {
          commit: {
            attempted: false,
            ok: false,
            httpCode: null,
            acceptance: 'not-attempted',
            message: 'Tenant-wide Commit was not called',
          },
          cacheRefresh: {
            attempted: true,
            status: 'stale',
            message: 'refresh incomplete',
          },
          recovery: {
            journalPhase: 'mutation-transport-unknown',
            action: 'manual-cleanup',
            status: 'journal-retained',
            mutationVerified: false,
            message: 'journal retained; tenant-wide Commit was not called',
          },
        },
      },
    });

    const result = await cleanupSseManualReconciliation(true, true);

    expect(result).toMatchObject({
      ok: false,
      code: 'SSE_JOURNAL_PERSIST_FAILED',
      result: {
        cacheRefresh: { status: 'stale' },
        recovery: { action: 'manual-cleanup', status: 'journal-retained' },
      },
    });
  });
});

describe('Central webhook one-time HMAC API client', () => {
  const tenantBinding = 'a'.repeat(64);
  const apiKeyForm: WebhookForm = {
    name: 'noc-hook',
    endpoint: 'https://hooks.example.com/central',
    authMechanism: 'API_KEY',
    apiKey: 'submitted-api-secret',
  };

  it('does not send create or rotate without both explicit acknowledgements', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await createCentralWebhook(apiKeyForm, false, true, tenantBinding);
    await createCentralWebhook(apiKeyForm, true, false, tenantBinding);
    await rotateCentralWebhookHmacKey('wh-1', false, true, tenantBinding);
    await rotateCentralWebhookHmacKey('wh-1', true, false, tenantBinding);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('canonicalizes create non-secret identity before sending it', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({
        ok: true,
        action: 'created',
        operationId: 'canonical-op',
        hmacKey: 'canonical-once',
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await createCentralWebhook(
      {
        name: '  canonical hook  ',
        endpoint: '  https://hooks.example.com/canonical  ',
        authMechanism: 'OIDC',
        oidcClientId: '  client-id  ',
        oidcClientSecret: ' secret bytes ',
        oidcWellKnownUrl: '  https://issuer.example/.well-known/openid-configuration  ',
      },
      true,
      true,
      tenantBinding,
    );

    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      form: {
        name: 'canonical hook',
        endpoint: 'https://hooks.example.com/canonical',
        authMechanism: 'OIDC',
        oidcClientId: 'client-id',
        oidcClientSecret: ' secret bytes ',
        oidcWellKnownUrl: 'https://issuer.example/.well-known/openid-configuration',
      },
      reviewConfirmed: true,
      oneTimeSecretAcknowledged: true,
      reviewedTenantBinding: tenantBinding,
    });
  });

  it('loads, acknowledges, and manually resolves the server handoff journal with exact attestations', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue({
          pending: true,
          operation: {
            operationId: 'pending-op',
            opType: 'rotate',
            state: 'outcome-unknown',
            webhookId: 'wh-1',
            createdAt: '2026-01-01T00:00:00Z',
            updatedAt: '2026-01-01T00:00:00Z',
            fingerprintMatches: true,
          },
        }),
      })
      .mockResolvedValue({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue({
          ok: true,
          operationId: 'pending-op',
          resolution: 'rotate-reconciled',
          message: 'cleared',
        }),
      });
    vi.stubGlobal('fetch', fetchMock);

    expect(await getCentralWebhookHandoffStatus()).toMatchObject({
      pending: true,
      operation: { operationId: 'pending-op' },
    });
    await acknowledgeCentralWebhookHandoff('pending-op', true);
    await resolveCentralWebhookHandoff({
      operationId: 'pending-op',
      resolution: 'rotate-reconciled',
      reviewConfirmed: true,
      attestations: { receiverReconciled: true, centralReconciled: true },
    });

    expect(fetchMock.mock.calls[1]).toEqual([
      '/api/central/webhooks/handoff/acknowledge',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ operationId: 'pending-op', secretStored: true }),
      }),
    ]);
    expect(fetchMock.mock.calls[2]).toEqual([
      '/api/central/webhooks/handoff/resolve',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          operationId: 'pending-op',
          resolution: 'rotate-reconciled',
          reviewConfirmed: true,
          attestations: { receiverReconciled: true, centralReconciled: true },
        }),
      }),
    ]);
  });

  it('sends the exact reviewed create body and returns only the recognized one-time result without persistence', async () => {
    const hmacKey = 'client-create-one-time';
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({
        ok: true,
        action: 'created',
        operationId: 'client-create-op',
        hmacKey,
        message: 'copy now',
      }),
    });
    const storageSpy = vi.spyOn(Storage.prototype, 'setItem');
    vi.stubGlobal('fetch', fetchMock);

    const result = await createCentralWebhook(
      { ...apiKeyForm, allowInsecureCallback: true, uiOnly: 'strip-me' } as WebhookForm,
      true,
      true,
      tenantBinding,
    );

    expect(result).toEqual({
      ok: true,
      action: 'created',
      operationId: 'client-create-op',
      hmacKey,
      message: 'webhook created — copy the one-time HMAC key now',
    });
    expect(fetchMock).toHaveBeenCalledWith('/api/central/webhooks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        form: apiKeyForm,
        reviewConfirmed: true,
        oneTimeSecretAcknowledged: true,
        reviewedTenantBinding: tenantBinding,
      }),
    });
    expect(storageSpy).not.toHaveBeenCalled();
    storageSpy.mockRestore();
  });

  it('uses the official rotate path and both acknowledgements', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({
        ok: true,
        action: 'rotated',
        operationId: 'client-rotate-op',
        hmacKey: 'client-rotate-one-time',
        message: 'copy now',
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await rotateCentralWebhookHmacKey('wh/1', true, true, tenantBinding);

    expect(fetchMock).toHaveBeenCalledWith('/api/central/webhooks/wh%2F1/rotate-hmac-key', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        reviewConfirmed: true,
        oneTimeSecretAcknowledged: true,
        reviewedTenantBinding: tenantBinding,
      }),
    });
  });

  it('does not return a secret from an unrecognized success or expose submitted credentials in unknown errors', async () => {
    const providerSecret = 'provider-secret-must-not-escape';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue({
          ok: true,
          action: 'failed',
          hmacKey: providerSecret,
          message: providerSecret,
        }),
      }),
    );
    const malformed = await createCentralWebhook(apiKeyForm, true, true, tenantBinding);
    expect(JSON.stringify(malformed)).not.toContain(providerSecret);
    expect(malformed).toMatchObject({
      outcome: 'unknown',
      code: 'WEBHOOK_CREATE_HMAC_OUTCOME_UNKNOWN',
      httpCode: 200,
    });
    expect(isApiError(malformed)).toBe(true);
    if (!isApiError(malformed)) throw new Error('expected API error');
    expect(isUnknownWebhookOutcome(malformed)).toBe(true);

    mockFetch({
      ok: false,
      status: 502,
      body: { error: `outcome unknown after submitted-api-secret` },
    });
    const unknown = await createCentralWebhook(apiKeyForm, true, true, tenantBinding);
    expect(isApiError(unknown)).toBe(true);
    if (!isApiError(unknown)) throw new Error('expected API error');
    expect(unknown.error).not.toContain('submitted-api-secret');
    expect(isUnknownWebhookOutcome(unknown)).toBe(true);
  });

  it.each([
    undefined,
    null,
    {},
    { ok: true, action: 'created', hmacKey: '' },
    { ok: true, action: 'created', hmacKey: '   ' },
    { ok: true, action: 'created', hmacKey: 42 },
  ])('classifies malformed successful create payloads as stable unknown outcomes: %#', async (body) => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue(body),
      }),
    );

    const result = await createCentralWebhook(apiKeyForm, true, true, tenantBinding);

    expect(result).toMatchObject({
      outcome: 'unknown',
      code: 'WEBHOOK_CREATE_HMAC_OUTCOME_UNKNOWN',
      httpCode: 200,
    });
    expect(isApiError(result)).toBe(true);
    if (!isApiError(result)) throw new Error('expected API error');
    expect(result.error).toContain('retrying blindly may duplicate the webhook');
    expect(isUnknownWebhookOutcome(result)).toBe(true);
  });

  it('preserves the server rotate unknown code but replaces all response text with a stable safe message', async () => {
    const rawSecret = 'raw-provider-body-secret';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue({
          ok: false,
          action: 'unknown',
          outcome: 'unknown',
          code: 'WEBHOOK_ROTATE_HMAC_OUTCOME_UNKNOWN',
          message: 'reconcile receiver and key; retrying may rotate again',
          raw: rawSecret,
        }),
      }),
    );

    const result = await rotateCentralWebhookHmacKey('wh-1', true, true, tenantBinding);

    expect(result).toEqual({
      error: 'The HMAC rotation outcome is unknown because the one-time key response was unavailable. Reconcile the receiver and key before another rotation; retrying blindly may rotate the key again.',
      httpCode: 200,
      outcome: 'unknown',
      code: 'WEBHOOK_ROTATE_HMAC_OUTCOME_UNKNOWN',
    });
    expect(JSON.stringify(result)).not.toContain(rawSecret);
    expect(isApiError(result) && isUnknownWebhookOutcome(result)).toBe(true);
  });

  it('treats an unreadable successful response body as unknown', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: vi.fn().mockRejectedValue(new Error('unreadable raw body')),
      }),
    );

    const result = await rotateCentralWebhookHmacKey('wh-1', true, true, tenantBinding);

    expect(result).toMatchObject({
      outcome: 'unknown',
      code: 'WEBHOOK_ROTATE_HMAC_OUTCOME_UNKNOWN',
      httpCode: 200,
    });
    expect(JSON.stringify(result)).not.toContain('unreadable raw body');
  });
});

describe('Central webhook PATCH API client', () => {
  const apiKeyForm: WebhookForm = {
    name: 'noc-hook',
    endpoint: 'https://hooks.example.com/central',
    authMechanism: 'API_KEY',
    apiKey: 'submitted-api-secret',
  };

  it('sends only the strict API_KEY PATCH variant, nesting expectedGeneration and stripping legacy/UI fields', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({ ok: true, action: 'patched', message: 'webhook patched' }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const form = {
      ...apiKeyForm,
      allowInsecureCallback: true,
      oidcClientId: 'stale-client',
      oidcClientSecret: 'stale-secret',
      oidcWellKnownUrl: 'https://stale.example/.well-known/openid-configuration',
      uiOnly: 'must-not-cross-the-boundary',
    } as WebhookForm;

    await updateCentralWebhook('wh-1', form, true, 7);

    expect(JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)).toEqual({
      form: {
        expectedGeneration: 7,
        name: 'noc-hook',
        endpoint: 'https://hooks.example.com/central',
        authMechanism: 'API_KEY',
        apiKey: 'submitted-api-secret',
      },
      reviewConfirmed: true,
    });
  });

  it('sends the exact OIDC auth variant without an API key or unknown fields', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({ ok: true, action: 'patched', message: 'webhook patched' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await updateCentralWebhook(
      'wh-oidc',
      {
        name: 'oidc-hook',
        endpoint: 'https://hooks.example.com/oidc',
        authMechanism: 'OIDC',
        apiKey: 'stale-api-key',
        oidcClientId: 'client-1',
        oidcClientSecret: 'oidc-secret',
        oidcWellKnownUrl: 'https://issuer.example/.well-known/openid-configuration',
      },
      true,
      8,
    );

    expect(JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)).toEqual({
      form: {
        expectedGeneration: 8,
        name: 'oidc-hook',
        endpoint: 'https://hooks.example.com/oidc',
        authMechanism: 'OIDC',
        oidcClientId: 'client-1',
        oidcClientSecret: 'oidc-secret',
        oidcWellKnownUrl: 'https://issuer.example/.well-known/openid-configuration',
      },
      reviewConfirmed: true,
    });
  });

  it('returns the server structured HTTP 409 conflict so callers can refetch', async () => {
    mockFetch({
      ok: false,
      status: 409,
      body: {
        ok: false,
        action: 'conflict',
        httpCode: 409,
        callbackValidatedAt: '2026-07-29T17:00:00.000Z',
        message: 'webhook generation conflict: reviewed 7, current 8',
      },
    });

    const result = await updateCentralWebhook('wh-1', apiKeyForm, true, 7);

    expect(result).toEqual({
      ok: false,
      action: 'conflict',
      httpCode: 409,
      callbackValidatedAt: '2026-07-29T17:00:00.000Z',
      message: 'webhook generation conflict: reviewed 7, current 8',
    });
    expect(isApiError(result)).toBe(false);
  });

  it('keeps a 502 outcome identifiable while redacting a submitted secret from an unsafe error echo', async () => {
    mockFetch({
      ok: false,
      status: 502,
      body: { error: 'central did not answer after submitted-api-secret; the outcome is unknown' },
    });

    const result = await updateCentralWebhook('wh-1', apiKeyForm, true, 7);

    expect(isApiError(result)).toBe(true);
    if (!isApiError(result)) throw new Error('expected an API error');
    expect(result).toMatchObject({ httpCode: 502 });
    expect(result.error).toContain('outcome is unknown');
    expect(result.error).not.toContain('submitted-api-secret');
    expect(isUnknownWebhookOutcome(result)).toBe(true);
  });

  it('emits JSON that an HTTP route boundary accepts under the strict API_KEY shape', async () => {
    const nativeFetch = globalThis.fetch.bind(globalThis);
    const { createServer } = await import('node:http');
    let received: unknown;
    const server = createServer((req, res) => {
      req.setEncoding('utf8');
      let raw = '';
      req.on('data', (chunk: string) => {
        raw += chunk;
      });
      req.on('end', () => {
        received = JSON.parse(raw);
        const body = received as Record<string, unknown>;
        const form = body.form as Record<string, unknown>;
        const exactTopLevel = Object.keys(body).sort().join(',') === 'form,reviewConfirmed';
        const exactForm =
          Object.keys(form).sort().join(',') ===
          'apiKey,authMechanism,endpoint,expectedGeneration,name';
        const valid =
          req.method === 'PATCH' &&
          req.url === '/api/central/webhooks/wh-1' &&
          exactTopLevel &&
          exactForm &&
          body.reviewConfirmed === true &&
          form.expectedGeneration === 9 &&
          form.authMechanism === 'API_KEY' &&
          typeof form.apiKey === 'string';
        res.writeHead(valid ? 200 : 400, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify(
            valid
              ? { ok: true, action: 'patched', message: 'strict route accepted webhook patch' }
              : { error: 'strict webhook PATCH shape rejected' },
          ),
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as { port: number };
    vi.stubGlobal('fetch', (path: string, init?: RequestInit) =>
      nativeFetch(`http://127.0.0.1:${address.port}${path}`, init),
    );

    try {
      const result = await updateCentralWebhook(
        'wh-1',
        {
          ...apiKeyForm,
          allowInsecureCallback: true,
          oidcClientSecret: 'legacy-oidc-secret',
        },
        true,
        9,
      );
      expect(result).toMatchObject({ ok: true, action: 'patched' });
      expect(received).toEqual({
        form: {
          expectedGeneration: 9,
          name: 'noc-hook',
          endpoint: 'https://hooks.example.com/central',
          authMechanism: 'API_KEY',
          apiKey: 'submitted-api-secret',
        },
        reviewConfirmed: true,
      });
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    }
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
