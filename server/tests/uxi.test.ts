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
import { MAX_SENSOR_STATUSES, UxiAdapter, mapUxiIssue, mapUxiSensor, uxiSevFor } from '../src/planes/uxi';

// -- Recorded fixtures (shapes as the UXI APIs return them) -------------------

// SensorsGetItem, exactly as the spec's own example item is shaped: camelCase,
// site in `groupName`, model in `modelNumber`, MACs split ethernet/wifi.
const SENSOR_A = {
  id: 'sen-001',
  serial: 'UX2F5C00171',
  name: 'uxi-cam01-2',
  groupName: 'Campus-01 — Meridian HQ',
  groupPath: '/root/Campus-01 — Meridian HQ',
  modelNumber: 'UX-F5C',
  ethernetMacAddress: 'aa:bb:cc:00:11:22',
  wifiMacAddress: 'aa:bb:cc:00:11:23',
  pcapMode: 'off',
  type: 'UXI',
};
const SENSOR_B = { id: 'sen-002', serial: 'UX2F5C00172', name: 'uxi-cam02-1', groupName: 'Campus-02 Research', modelNumber: 'UX-F5C' };
/** A proxied/older deployment that still emits the snake_case variants. */
const SENSOR_LEGACY = { id: 'sen-009', name: 'uxi-lake-1', model: 'UXI G2', mac_address: 'aa:bb:cc:00:99:01', firmware_version: '3.4.1' };

const STATUS_ONLINE_ISSUE = {
  isOnline: true,
  isTesting: true,
  issues: [
    {
      code: 'DHCP_FAILURE',
      id: 'iss-1',
      severity: 'ERROR',
      status: 'open',
      timestamp: '2026-07-26T04:50:00Z',
      context: {
        sensorId: 'sen-001',
        groupName: 'Campus-01 — Meridian HQ',
        networkName: 'clinical-ssid',
        serviceTestName: 'dhcp',
      },
    },
  ],
};

/** The sensor an issue was read from, as pull() threads it into the mapper. */
const SENSOR_A_REF = { name: 'uxi-cam01-2', siteId: 'campus-01' as const, siteName: 'Campus-01 — Meridian HQ' };

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
  /** Statuses served for the sensors list before the pages start, in order. */
  sensorListStatuses?: Array<{ status: number; retryAfter?: string }>;
  urls?: string[];
}): FetchLike {
  const pages = opts.sensorPages ?? [{ items: [SENSOR_A, SENSOR_B], next: null }];
  const statuses = opts.statuses ?? {
    'sen-001': { status: 200, body: STATUS_ONLINE_ISSUE },
    'sen-002': { status: 200, body: { isOnline: false, isTesting: false, issues: [] } },
  };
  let pageIdx = 0;
  let listStatusIdx = 0;
  return async (url, init) => {
    const u = String(url);
    opts.urls?.push(u);
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
      const forced = opts.sensorListStatuses?.[listStatusIdx];
      if (forced) {
        listStatusIdx += 1;
        return new Response('{}', {
          status: forced.status,
          headers: forced.retryAfter ? { 'retry-after': forced.retryAfter } : undefined,
        });
      }
      const page = pages[Math.min(pageIdx, pages.length - 1)];
      pageIdx += 1;
      return new Response(JSON.stringify(page), { status: 200 });
    }
    return new Response('{}', { status: 404 });
  };
}

function makeAdapter(fetchImpl: FetchLike): {
  adapter: UxiAdapter;
  calls: Array<{ path: string; code: string }>;
  st: PlaneState;
  slept: number[];
} {
  const calls: Array<{ path: string; code: string }> = [];
  const st = state();
  // Pacing and backoff delays are captured, never paid in wall time — the test
  // asserts the wait the adapter CHOSE.
  const slept: number[] = [];
  const adapter = new UxiAdapter(CREDS, st, (c) => calls.push({ path: c.path, code: c.code }), fetchImpl, async (ms) => {
    slept.push(ms);
  });
  return { adapter, calls, st, slept };
}

// -- mapping -------------------------------------------------------------------

describe('mapUxiSensor', () => {
  // The live item names model/MAC/serial with the spec's own keys — reading
  // anything else drops the reconcile identity hints entirely.
  it('maps a sensor from the live SensorsGetItem shape', () => {
    const d = mapUxiSensor(SENSOR_A, true);
    expect(d).toMatchObject({
      name: 'uxi-cam01-2',
      model: 'UX-F5C',
      type: 'sensor',
      plane: 'UXI',
      state: 'up',
      stateTone: 'success',
      localShell: false,
      serial: 'UX2F5C00171',
      mac: 'aa:bb:cc:00:11:22',
    });
    // The sensor item publishes no firmware — 'unknown' is the honest answer.
    expect(d?.firmware).toBe('unknown');
  });

  // Without this the whole UXI lane lands on the 'multiple' pseudo-site and no
  // site mix can ever contain 'uxi'.
  it('resolves the site from groupName', () => {
    expect(mapUxiSensor(SENSOR_A, true)).toMatchObject({ siteId: 'campus-01', siteName: 'Campus-01 — Meridian HQ' });
    expect(mapUxiSensor(SENSOR_B, true)).toMatchObject({ siteId: 'campus-02' });
    expect(mapUxiSensor({ id: 'sen-x', name: 'uxi-x' }, true)).toMatchObject({ siteId: 'multiple' });
  });

  it('still tolerates the snake_case variants', () => {
    expect(mapUxiSensor(SENSOR_LEGACY, true)).toMatchObject({
      model: 'UXI G2',
      mac: 'aa:bb:cc:00:99:01',
      firmware: '3.4.1',
    });
  });

  it('maps offline and unknown states honestly', () => {
    expect(mapUxiSensor(SENSOR_B, false)).toMatchObject({ state: 'offline', stateTone: 'danger' });
    expect(mapUxiSensor(SENSOR_B, null)).toMatchObject({ state: 'unknown', stateTone: 'neutral' });
  });

  it('drops a row with neither name nor id', () => {
    expect(mapUxiSensor({ modelNumber: 'UX-F5C' }, true)).toBeNull();
  });
});

describe('uxiSevFor', () => {
  // The live enum is ERROR | WARNING | INFO; an ERROR is a failed synthetic
  // test, which is P1 evidence, not a P3 footnote.
  it('maps the live severity enum', () => {
    expect(uxiSevFor('ERROR')).toBe('P1');
    expect(uxiSevFor('WARNING')).toBe('P2');
    expect(uxiSevFor('INFO')).toBe('P3');
  });

  it('keeps the HIGH/MEDIUM/LOW variants and defers on anything else', () => {
    expect(uxiSevFor('HIGH')).toBe('P1');
    expect(uxiSevFor('MEDIUM')).toBe('P2');
    expect(uxiSevFor('LOW')).toBe('P3');
    expect(uxiSevFor('critical')).toBe('P1');
    expect(uxiSevFor(null)).toBe('P3');
  });
});

describe('mapUxiIssue', () => {
  const NOW = Date.parse('2026-07-26T05:00:00Z');

  it('maps an ongoing issue onto the alert vocabulary', () => {
    const a = mapUxiIssue(STATUS_ONLINE_ISSUE.issues[0], SENSOR_A_REF, NOW);
    expect(a).toMatchObject({
      title: 'DHCP_FAILURE',
      plane: 'UXI',
      state: 'open',
      device: 'uxi-cam01-2',
      sev: 'P1',
      tone: 'danger',
      siteId: 'campus-01',
    });
    expect(a?.detail).toContain('dhcp');
    expect(a?.age).not.toBe('—');
  });

  it('inherits the sensor site when the issue context names no group', () => {
    const a = mapUxiIssue({ code: 'DNS_FAILURE', severity: 'ERROR', status: 'open' }, SENSOR_A_REF, NOW);
    expect(a).toMatchObject({ siteId: 'campus-01', siteName: 'Campus-01 — Meridian HQ' });
  });

  // 'cleared' is the plane resolving it; 'acked' is a human acknowledging it
  // through the broker. UXI has no acknowledgement concept, so calling a
  // resolved issue 'acked' credits an operator action that never happened.
  it('treats a resolved issue as cleared (not acked) and drops junk rows', () => {
    const ref = { name: 's', siteId: 'multiple' as const, siteName: 'Multiple' };
    for (const status of ['resolved', 'closed', 'cleared']) {
      expect(
        mapUxiIssue({ code: 'X', severity: 'INFO', status, timestamp: '2026-07-26T04:00:00Z' }, ref, NOW)?.state,
      ).toBe('cleared');
    }
    expect(mapUxiIssue({ code: 'X', severity: 'INFO', status: 'open' }, ref, NOW)?.state).toBe('open');
    expect(mapUxiIssue({}, ref, NOW)).toBeNull();
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
    expect(pull.devices?.[0]).toMatchObject({ name: 'uxi-cam01-2', state: 'up', siteId: 'campus-01' });
    expect(pull.devices?.[1]).toMatchObject({ name: 'uxi-cam02-1', state: 'offline', siteId: 'campus-02' });
    expect(pull.alerts).toHaveLength(1);
    expect(pull.alerts?.[0]).toMatchObject({
      title: 'DHCP_FAILURE',
      plane: 'UXI',
      device: 'uxi-cam01-2',
      sev: 'P1',
      siteId: 'campus-01',
    });
    expect(st.note).toContain('2 sensors');
    expect(st.note).toContain('push-only');
    expect(st.health).toBe('healthy');
    // The call log carries paths only — never the Authorization header.
    expect(calls.every((c) => !c.path.includes('uxi-secret') && !c.path.includes('tok-1'))).toBe(true);
  });

  it('publishes the minted credential expiry on plane state (never the token)', async () => {
    // The registry could only publish the credential SOURCE; the expiry the
    // Systems 'Token' fact renders is learned here, when the token is minted.
    const { adapter, st } = makeAdapter(fakeFetch({}));
    const before = Date.now();
    await adapter.pull();
    expect(st.token?.source).toBe('oauth client_credentials');
    expect(Date.parse(st.token!.expiresAt!)).toBeGreaterThanOrEqual(before + 7200 * 1000);
    // SECURITY: PlaneState is served unmasked — expiry + label only.
    expect(JSON.stringify(st.token)).not.toContain('tok-1');
    expect(JSON.stringify(st.token)).not.toContain('uxi-secret');
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

  // isOnline is `boolean | null` and the body may omit it — the portal must
  // not turn "the sensor did not say" into a red offline row.
  it('keeps a sensor unknown when the status body declines to say isOnline', async () => {
    const { adapter } = makeAdapter(
      fakeFetch({
        statuses: {
          'sen-001': { status: 200, body: { issues: [] } },
          'sen-002': { status: 200, body: { isOnline: null, isTesting: null, issues: [] } },
        },
      }),
    );
    const pull = await adapter.pull();
    expect(pull.devices?.[0]).toMatchObject({ name: 'uxi-cam01-2', state: 'unknown', stateTone: 'neutral' });
    expect(pull.devices?.[1]).toMatchObject({ name: 'uxi-cam02-1', state: 'unknown', stateTone: 'neutral' });
  });

  it('names sensors that are online but running no tests', async () => {
    const { adapter, st } = makeAdapter(
      fakeFetch({
        statuses: {
          'sen-001': { status: 200, body: { isOnline: true, isTesting: false, issues: [] } },
          'sen-002': { status: 200, body: { isOnline: true, isTesting: true, issues: [] } },
        },
      }),
    );
    const pull = await adapter.pull();
    expect(pull.devices?.every((d) => d.state === 'up')).toBe(true);
    expect(st.note).toContain('1 idle (online, not testing)');
  });

  // Every status read failing means the portal has NO live sensor state — the
  // inventory is still real, but the freshness claim would be a lie.
  it('degrades the plane when every status read fails, and says so', async () => {
    const { adapter, st } = makeAdapter(fakeFetch({ statuses: { 'sen-001': { status: 500, body: {} } } }));
    const pull = await adapter.pull();
    expect(pull.devices?.[0]).toMatchObject({ name: 'uxi-cam01-2', state: 'unknown' });
    expect(pull.devices?.[1]).toMatchObject({ name: 'uxi-cam02-1', state: 'unknown' });
    expect(st.note).toContain('2 status reads failed');
    expect(st.health).toBe('degraded');
  });

  it('stays healthy when one status read fails but another proves live state', async () => {
    const { adapter, st } = makeAdapter(
      fakeFetch({
        statuses: {
          'sen-001': { status: 500, body: {} },
          'sen-002': { status: 200, body: { isOnline: true, isTesting: true, issues: [] } },
        },
      }),
    );
    const pull = await adapter.pull();
    expect(pull.devices?.[1]).toMatchObject({ name: 'uxi-cam02-1', state: 'up' });
    expect(st.note).toContain('1 status reads failed');
    expect(st.health).toBe('healthy');
  });

  // The spec's maximum page size is 100 (default 50): asking for it halves the
  // calls, and both params must ride the cursor or the server resets the size.
  it('asks for the maximum page size and carries it onto the cursor', async () => {
    const urls: string[] = [];
    const { adapter } = makeAdapter(
      fakeFetch({
        urls,
        sensorPages: [
          { items: [SENSOR_A], next: 'cursor-2' },
          { items: [SENSOR_B], next: null },
        ],
      }),
    );
    await adapter.pull();
    const listCalls = urls.filter((u) => u.includes('/sensors?'));
    expect(listCalls).toHaveLength(2);
    expect(listCalls[0]).toContain('limit=100');
    expect(listCalls[1]).toContain('limit=100');
    expect(listCalls[1]).toContain('next=cursor-2');
  });

  // A walk that ends holding a cursor read PART of the estate; publishing it as
  // the whole inventory makes every unread sensor look decommissioned.
  it('names a page-capped walk as truncated instead of asserting the count', async () => {
    const { adapter, st } = makeAdapter(
      fakeFetch({ sensorPages: [{ items: [SENSOR_A], next: 'more-please' }] }), // never returns next: null
    );
    const pull = await adapter.pull();
    expect(st.note).toContain('inventory truncated');
    expect(st.note).toContain('page cap 10');
    expect(pull.partial).toEqual(['devices']);
  });

  it('backs off once on a 429 and counts the throttle in the note', async () => {
    const { adapter, st, slept } = makeAdapter(
      fakeFetch({ sensorListStatuses: [{ status: 429, retryAfter: '3' }] }),
    );
    const pull = await adapter.pull();
    expect(pull.devices).toHaveLength(2); // the retry succeeded
    expect(slept).toContain(3_000); // Retry-After honoured over the 1s floor
    expect(st.note).toContain('1 throttled (429)');
  });

  it('paces requests to the documented 5 req/s budget', async () => {
    const { adapter, slept } = makeAdapter(fakeFetch({}));
    await adapter.pull();
    // list + two status reads: every request after the first waits its turn
    expect(slept.filter((ms) => ms > 0 && ms <= 200).length).toBeGreaterThanOrEqual(2);
  });

  it('claims no shell, no brokered write and no config read', () => {
    const { adapter } = makeAdapter(fakeFetch({}));
    expect(adapter.capabilities()).toEqual({ localShell: false, brokeredWrite: false, configRead: false });
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
