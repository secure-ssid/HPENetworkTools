/**
 * server/tests/uxi.test.ts — UXI adapter unit tests, NO network.
 *
 * The mapping helpers are tested against UXI-style sensor/status JSON inlined
 * here; UxiAdapter.pull() is exercised end-to-end with an in-memory fake
 * `fetch` (FetchLike injection) to cover the OAuth2 Basic-auth token flow,
 * cursor pagination, per-sensor status reads (failures non-fatal), and the
 * secret-free call log.
 */

import { describe, expect, it } from 'vitest';
import type { PlaneState } from '../src/planes/types';
import type { FetchLike } from '../src/planes/uxi';
import { MAX_SENSOR_STATUSES, UxiAdapter, mapUxiIssue, mapUxiSensor } from '../src/planes/uxi';

// -- Recorded fixtures (shapes as the UXI APIs return them) -------------------

const SENSOR_A = { id: 'sen-001', name: 'uxi-cam01-2', model: 'UXI G2', mac_address: 'aa:bb:cc:00:11:22', firmware_version: '3.4.1' };
const SENSOR_B = { id: 'sen-002', name: 'uxi-cam02-1', model: 'UXI G2' };

const STATUS_ONLINE_ISSUE = {
  isOnline: true,
  isTesting: true,
  issues: [
    {
      code: 'DHCP_FAILURE',
      id: 'iss-1',
      severity: 'HIGH',
      status: 'open',
      timestamp: '2026-07-26T04:50:00Z',
      context: { sensorId: 'sen-001', networkName: 'clinical-ssid', serviceTestName: 'dhcp' },
    },
  ],
};

function state(): PlaneState {
  return { id: 'uxi', linked: true, health: 'warning', lastSync: null, deviceCount: null, callsToday: 0, note: null };
}

const CREDS = { clientId: 'uxi-client', clientSecret: 'uxi-secret' };

/** Fake fetch answering the token POST, the sensors list, and per-sensor status. */
function fakeFetch(opts: {
  sensorPages?: Array<{ items: unknown[]; next: string | null }>;
  statuses?: Record<string, { status: number; body: unknown }>;
  tokenStatus?: number;
  seenAuth?: { value: string | null };
}): FetchLike {
  const pages = opts.sensorPages ?? [{ items: [SENSOR_A, SENSOR_B], next: null }];
  const statuses = opts.statuses ?? {
    'sen-001': { status: 200, body: STATUS_ONLINE_ISSUE },
    'sen-002': { status: 200, body: { isOnline: false, isTesting: false, issues: [] } },
  };
  let pageIdx = 0;
  return async (url, init) => {
    const u = String(url);
    if (u.includes('token.oauth2')) {
      if (opts.seenAuth) opts.seenAuth.value = (init?.headers as Record<string, string>)?.authorization ?? null;
      const status = opts.tokenStatus ?? 200;
      return new Response(JSON.stringify({ access_token: 'tok-1', expires_in: 7200 }), { status });
    }
    if (u.includes('/sensors/') && u.endsWith('/status')) {
      const id = decodeURIComponent(u.split('/sensors/')[1].replace('/status', ''));
      const s = statuses[id] ?? { status: 404, body: {} };
      return new Response(JSON.stringify(s.body), { status: s.status });
    }
    if (u.includes('/sensors')) {
      const page = pages[Math.min(pageIdx, pages.length - 1)];
      pageIdx += 1;
      return new Response(JSON.stringify(page), { status: 200 });
    }
    return new Response('{}', { status: 404 });
  };
}

function makeAdapter(fetchImpl: FetchLike): { adapter: UxiAdapter; calls: Array<{ path: string; code: string }>; st: PlaneState } {
  const calls: Array<{ path: string; code: string }> = [];
  const st = state();
  const adapter = new UxiAdapter(CREDS, st, (c) => calls.push({ path: c.path, code: c.code }), fetchImpl);
  return { adapter, calls, st };
}

// -- mapping -------------------------------------------------------------------

describe('mapUxiSensor', () => {
  it('maps a sensor with online status', () => {
    const d = mapUxiSensor(SENSOR_A, true);
    expect(d).toMatchObject({
      name: 'uxi-cam01-2',
      type: 'sensor',
      plane: 'UXI',
      state: 'up',
      stateTone: 'success',
      firmware: '3.4.1',
      localShell: false,
      mac: 'aa:bb:cc:00:11:22',
    });
  });

  it('maps offline and unknown states honestly', () => {
    expect(mapUxiSensor(SENSOR_B, false)).toMatchObject({ state: 'offline', stateTone: 'danger' });
    expect(mapUxiSensor(SENSOR_B, null)).toMatchObject({ state: 'unknown', stateTone: 'neutral' });
  });

  it('drops a row with neither name nor id', () => {
    expect(mapUxiSensor({ model: 'UXI G2' }, true)).toBeNull();
  });
});

describe('mapUxiIssue', () => {
  const NOW = Date.parse('2026-07-26T05:00:00Z');

  it('maps an ongoing issue onto the alert vocabulary', () => {
    const a = mapUxiIssue(STATUS_ONLINE_ISSUE.issues[0], 'uxi-cam01-2', NOW);
    expect(a).toMatchObject({
      title: 'DHCP_FAILURE',
      plane: 'UXI',
      state: 'open',
      device: 'uxi-cam01-2',
      sev: 'P1',
      tone: 'danger',
    });
    expect(a?.detail).toContain('dhcp');
    expect(a?.age).not.toBe('—');
  });

  it('treats a resolved issue as acked and drops junk rows', () => {
    expect(
      mapUxiIssue({ code: 'X', severity: 'LOW', status: 'resolved', timestamp: '2026-07-26T04:00:00Z' }, 's', NOW)?.state,
    ).toBe('acked');
    expect(mapUxiIssue({}, 's', NOW)).toBeNull();
  });
});

// -- pull() end-to-end -----------------------------------------------------------

describe('UxiAdapter.pull', () => {
  it('auths with HTTP Basic client-credentials and pulls devices + alerts', async () => {
    const seenAuth = { value: null as string | null };
    const { adapter, calls, st } = makeAdapter(fakeFetch({ seenAuth }));
    const pull = await adapter.pull();
    expect(seenAuth.value).toBe(`Basic ${Buffer.from('uxi-client:uxi-secret').toString('base64')}`);
    expect(pull.devices).toHaveLength(2);
    expect(pull.devices?.[0]).toMatchObject({ name: 'uxi-cam01-2', state: 'up' });
    expect(pull.devices?.[1]).toMatchObject({ name: 'uxi-cam02-1', state: 'offline' });
    expect(pull.alerts).toHaveLength(1);
    expect(pull.alerts?.[0]).toMatchObject({ title: 'DHCP_FAILURE', plane: 'UXI', device: 'uxi-cam01-2' });
    expect(st.note).toContain('2 sensors');
    expect(st.note).toContain('push-only');
    expect(st.health).toBe('healthy');
    // The call log carries paths only — never the Authorization header.
    expect(calls.every((c) => !c.path.includes('uxi-secret') && !c.path.includes('tok-1'))).toBe(true);
  });

  it('follows the cursor until next is null', async () => {
    const { adapter } = makeAdapter(
      fakeFetch({
        sensorPages: [
          { items: [SENSOR_A], next: 'cursor-2' },
          { items: [SENSOR_B], next: null },
        ],
      }),
    );
    const pull = await adapter.pull();
    expect(pull.devices).toHaveLength(2);
  });

  it('keeps a sensor unknown when its status read fails, and says so', async () => {
    const { adapter, st } = makeAdapter(fakeFetch({ statuses: { 'sen-001': { status: 500, body: {} } } }));
    const pull = await adapter.pull();
    expect(pull.devices?.[0]).toMatchObject({ name: 'uxi-cam01-2', state: 'unknown' });
    expect(pull.devices?.[1]).toMatchObject({ name: 'uxi-cam02-1', state: 'unknown' });
    expect(st.note).toContain('status reads failed');
  });

  it('fails the pull naming the section when the sensors list errors', async () => {
    const { adapter } = makeAdapter(fakeFetch({ tokenStatus: 403 }));
    await expect(adapter.pull()).rejects.toThrow("uxi pull: section 'sensors' failed");
  });

  it('isComplete requires clientId and clientSecret', () => {
    expect(UxiAdapter.isComplete(CREDS)).toBe(true);
    expect(UxiAdapter.isComplete({ clientId: 'x' })).toBe(false);
    expect(UxiAdapter.isComplete(null)).toBe(false);
    expect(MAX_SENSOR_STATUSES).toBeGreaterThan(0);
  });
});
