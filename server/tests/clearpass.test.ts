/**
 * server/tests/clearpass.test.ts — ClearPass adapter unit tests, NO network.
 *
 * The mapping helpers are tested against recorded ClearPass auth-log JSON
 * inlined here (Insight + legacy shapes, shape variance on purpose);
 * ClearPassAdapter.pull() is exercised end-to-end with an in-memory fake
 * `fetch` (FetchLike injection) to cover the static Bearer header on every
 * call, candidate-path fallback with a remembered working path, the newest-200
 * cap, error naming and the secret-free call log.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { PlaneState } from '../src/planes/types';
import type { FetchLike } from '../src/planes/central';
import {
  ClearPassAdapter,
  MAX_AUTH_EVENTS,
  authMethodFor,
  authResultFor,
  mapClearPassAuthEvent,
  normalizeMac,
} from '../src/planes/clearpass';

// -- Recorded fixtures (Insight and legacy shapes, mixed on purpose) ------------

const ROW_ACCEPT = {
  id: 'log-1',
  timestamp: '2026-07-25T09:41:22Z',
  username: 'm.okonjo',
  mac_address: '3C-22-FB-41-0A-19',
  service_name: 'MRDN Wireless 802.1X',
  auth_method: '802.1X EAP-TLS',
  auth_result: 'ACCEPT',
  reason: 'Certificate valid, AD group Clinical',
  enforcement_profiles: 'Clinical staff',
  nas_ip: '10.42.3.12',
};

const ROW_REJECT = {
  auth_time: 1_753_000_000, // epoch seconds — the legacy key on purpose
  user: 'lab-laptop-7',
  calling_station_id: '482AE31107C4',
  service: 'MRDN Wired MAB',
  method: 'MAC-AUTH',
  result: 'Access-Reject',
  reject_reason: 'Password expired in Active Directory',
  nas_name: 'sw-acc-3f-3',
};

const ROW_TIMEOUT = {
  timestamp: '2026-07-25T09:35:08Z',
  username: 'guest-4471',
  mac: 'f0:18:98:5c:11:73',
  service: 'MRDN Guest Portal',
  auth_method: 'portal',
  status: 'no-response',
  nas: 'ap-1f-04',
};

/** 'HH:MM' the way the adapter renders it (local wall-clock). */
function expectedHhmm(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// -- Pure helpers ------------------------------------------------------------------

describe('pure helpers', () => {
  it('normalizeMac handles every separator and case', () => {
    expect(normalizeMac('3C-22-FB-41-0A-19')).toBe('3c:22:fb:41:0a:19');
    expect(normalizeMac('482AE31107C4')).toBe('48:2a:e3:11:07:c4');
    expect(normalizeMac('aabb.ccdd.eeff')).toBe('aa:bb:cc:dd:ee:ff');
    expect(normalizeMac('aa:bb:cc:dd:ee:ff')).toBe('aa:bb:cc:dd:ee:ff');
    expect(normalizeMac('not-a-mac')).toBe('not-a-mac'); // not 12 hex digits — passthrough
  });

  it('authResultFor maps the vocabulary onto accept|reject|timeout', () => {
    expect(authResultFor('ACCEPT')).toEqual({ result: 'accept', tone: 'success' });
    expect(authResultFor('Access-Accept')).toEqual({ result: 'accept', tone: 'success' });
    expect(authResultFor('Access-Reject')).toEqual({ result: 'reject', tone: 'danger' });
    expect(authResultFor('DENIED')).toEqual({ result: 'reject', tone: 'danger' });
    expect(authResultFor('no-response')).toEqual({ result: 'timeout', tone: 'warning' });
    expect(authResultFor('some-unrecognised-verdict')).toEqual({ result: 'timeout', tone: 'warning' });
  });

  it('authMethodFor normalises to 802.1X / MAB / TACACS+', () => {
    expect(authMethodFor('802.1X EAP-TLS')).toBe('802.1X');
    expect(authMethodFor('dot1x')).toBe('802.1X');
    expect(authMethodFor('MAC-AUTH')).toBe('MAB');
    expect(authMethodFor('mab')).toBe('MAB');
    expect(authMethodFor('TACACS+ admin')).toBe('TACACS+');
    expect(authMethodFor('portal')).toBe('portal'); // unfamiliar — passed through
    expect(authMethodFor(null)).toBe('—');
  });
});

// -- Row mapping ---------------------------------------------------------------------

describe('mapClearPassAuthEvent', () => {
  it('maps a full Insight row', () => {
    const e = mapClearPassAuthEvent(ROW_ACCEPT);
    expect(e).not.toBeNull();
    expect(e!.time).toBe(expectedHhmm(Date.parse(ROW_ACCEPT.timestamp)));
    expect(e!.who).toBe('m.okonjo');
    expect(e!.mac).toBe('3c:22:fb:41:0a:19');
    expect(e!.service).toBe('MRDN Wireless 802.1X');
    expect(e!.method).toBe('802.1X');
    expect(e!.result).toBe('accept');
    expect(e!.tone).toBe('success');
    expect(e!.reason).toBe('Certificate valid, AD group Clinical');
    expect(e!.role).toBe('role Clinical staff');
    expect(e!.nas).toBe('10.42.3.12');
    expect(e!.plane).toBe('CLEARPASS');
    expect(e!.tsMs).toBe(Date.parse(ROW_ACCEPT.timestamp));
  });

  it('maps a legacy reject row (epoch seconds, different keys)', () => {
    const e = mapClearPassAuthEvent(ROW_REJECT);
    expect(e).not.toBeNull();
    expect(e!.time).toBe(expectedHhmm(1_753_000_000_000));
    expect(e!.who).toBe('lab-laptop-7');
    expect(e!.mac).toBe('48:2a:e3:11:07:c4');
    expect(e!.service).toBe('MRDN Wired MAB');
    expect(e!.method).toBe('MAB');
    expect(e!.result).toBe('reject');
    expect(e!.tone).toBe('danger');
    expect(e!.reason).toBe('Password expired in Active Directory');
    expect(e!.role).toBe('no role assigned');
    expect(e!.nas).toBe('sw-acc-3f-3');
    expect(e!.tsMs).toBe(1_753_000_000_000);
  });

  it('maps a no-response row to timeout/warning', () => {
    const e = mapClearPassAuthEvent(ROW_TIMEOUT);
    expect(e!.result).toBe('timeout');
    expect(e!.tone).toBe('warning');
    expect(e!.method).toBe('portal'); // unfamiliar method passes through
    expect(e!.reason).toBe('—');
  });

  it('tolerates a row with no timestamp: display —, no hint', () => {
    const e = mapClearPassAuthEvent({ username: 'ghost', result: 'ACCEPT' });
    expect(e).not.toBeNull();
    expect(e!.time).toBe('—');
    expect(e!.tsMs).toBeUndefined();
    expect(e!.mac).toBe('—');
  });

  it('returns null for rows with no identity at all', () => {
    expect(mapClearPassAuthEvent(null)).toBeNull();
    expect(mapClearPassAuthEvent({ service: 'MRDN Wireless 802.1X' })).toBeNull();
  });
});

// -- pull() with an in-memory fake fetch (no network) ---------------------------------

type HandlerResult = { status?: number; body?: unknown };
type Handler = (method: string, pathname: string, query: URLSearchParams) => HandlerResult | undefined;

function fakeFetch(handler: Handler): { fn: FetchLike; calls: string[]; authHeaders: (string | null)[] } {
  const calls: string[] = [];
  const authHeaders: (string | null)[] = [];
  const fn: FetchLike = async (url, init) => {
    const u = new URL(url);
    const method = (init?.method as string | undefined) ?? 'GET';
    calls.push(`${method} ${u.pathname}${u.search}`);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    authHeaders.push(headers.authorization ?? null);
    const result = handler(method, u.pathname, u.searchParams);
    if (!result) {
      return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify(result.body ?? {}), {
      status: result.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fn, calls, authHeaders };
}

function makeState(): PlaneState {
  return { id: 'clearpass', linked: true, health: 'warning', lastSync: null, deviceCount: null, callsToday: 0, note: null };
}

const CREDS = { host: 'https://cppm.example.com', token: 'cppm-token-shh' };

function makeAdapter(handler: Handler) {
  const { fn, calls, authHeaders } = fakeFetch(handler);
  const recorded: { path: string; ms: number; code: string }[] = [];
  const state = makeState();
  const adapter = new ClearPassAdapter(CREDS, state, (c) => recorded.push(c), fn);
  return { adapter, state, recorded, calls, authHeaders };
}

const HAPPY_ROUTES: Record<string, unknown> = {
  'GET /api-insight/v1/auth/logs': { logs: [ROW_REJECT, ROW_TIMEOUT, ROW_ACCEPT] }, // unordered on purpose
};

function routeHandler(routes: Record<string, unknown>): Handler {
  return (method, pathname) => {
    const body = routes[`${method} ${pathname}`];
    return body === undefined ? undefined : { body };
  };
}

describe('ClearPassAdapter.pull()', () => {
  it('pulls auth events, sorts newest first, and reports the summary note', async () => {
    const { adapter, state, recorded, authHeaders } = makeAdapter(routeHandler(HAPPY_ROUTES));
    const pull = await adapter.pull();
    expect(pull.authEvents).toHaveLength(3);
    expect(pull.authEvents!.map((e) => e.who)).toEqual(['m.okonjo', 'guest-4471', 'lab-laptop-7']); // tsMs desc
    expect(state.note).toBe('3 auth events · 1 rejects');
    expect(state.health).toBe('healthy'); // promoted from 'warning' on first success
    // the static token rides the Authorization header on every call…
    expect(authHeaders.length).toBeGreaterThan(0);
    expect(authHeaders.every((h) => h === 'Bearer cppm-token-shh')).toBe(true);
    // …and never the recorded call log
    expect(JSON.stringify(recorded)).not.toContain('cppm-token-shh');
    expect(recorded.some((c) => c.path === 'GET /api-insight/v1/auth/logs' && c.code === '200')).toBe(true);
  });

  it('tolerates a 404 candidate and remembers the working path', async () => {
    const routes = { ...HAPPY_ROUTES };
    delete routes['GET /api-insight/v1/auth/logs'];
    routes['GET /api/auth-logs'] = { events: [ROW_ACCEPT] };
    const { adapter, calls } = makeAdapter(routeHandler(routes));
    const pull = await adapter.pull();
    expect(pull.authEvents).toHaveLength(1);
    expect(calls.some((c) => c.startsWith('GET /api-insight/v1/auth/logs'))).toBe(true); // tried, 404

    await adapter.pull(); // resolved path goes first — the dead candidate is not retried
    expect(calls.filter((c) => c.startsWith('GET /api-insight/v1/auth/logs'))).toHaveLength(1);
    expect(calls.filter((c) => c.startsWith('GET /api/auth-logs'))).toHaveLength(2);
  });

  it('accepts a bare-array body (first array-valued key tolerance)', async () => {
    const { adapter } = makeAdapter((method, pathname) => {
      if (method === 'GET' && pathname === '/api-insight/v1/auth/logs') return { body: [ROW_ACCEPT, ROW_REJECT] };
      return undefined;
    });
    const pull = await adapter.pull();
    expect(pull.authEvents).toHaveLength(2);
  });

  it('prefers the logs payload key over an incidental array', async () => {
    // `{errors: [], logs: [...]}` — the first-array heuristic alone would zero the section.
    const { adapter } = makeAdapter((method, pathname) => {
      if (method === 'GET' && pathname === '/api-insight/v1/auth/logs') return { body: { errors: [], logs: [ROW_ACCEPT] } };
      return undefined;
    });
    const pull = await adapter.pull();
    expect(pull.authEvents).toHaveLength(1);
    expect(pull.authEvents![0].who).toBe('m.okonjo');
  });

  it('keeps only the newest 200 events', async () => {
    const base = Date.parse('2026-07-25T00:00:00Z');
    const many = Array.from({ length: MAX_AUTH_EVENTS + 5 }, (_, i) => ({
      timestamp: new Date(base + i * 60_000).toISOString(),
      username: `u${i}`,
      mac_address: i.toString(16).padStart(12, '0'),
      service: 'svc',
      auth_result: 'ACCEPT',
    }));
    const { adapter } = makeAdapter((method, pathname) => {
      if (method === 'GET' && pathname === '/api-insight/v1/auth/logs') return { body: { logs: many } };
      return undefined;
    });
    const pull = await adapter.pull();
    expect(pull.authEvents).toHaveLength(MAX_AUTH_EVENTS);
    expect(pull.authEvents![0].who).toBe(`u${MAX_AUTH_EVENTS + 4}`); // newest kept
    expect(pull.authEvents![MAX_AUTH_EVENTS - 1].who).toBe('u5'); // oldest five dropped
  });

  it('fails the pull naming the section when every candidate 404s', async () => {
    const { adapter } = makeAdapter(() => undefined);
    await expect(adapter.pull()).rejects.toThrow(/section 'authEvents' failed/);
    await expect(adapter.pull()).rejects.toThrow(/404 on every candidate/);
  });

  it('fails the pull naming the section on a non-404 error (401 included — no retry)', async () => {
    const { adapter } = makeAdapter((method, pathname) => {
      if (method === 'GET' && pathname === '/api-insight/v1/auth/logs') {
        return { status: 401, body: { error: 'bad token' } };
      }
      return undefined;
    });
    await expect(adapter.pull()).rejects.toThrow(/section 'authEvents' failed — HTTP 401/);
  });
});

// -- Registry wiring --------------------------------------------------------------------

describe('registry wiring', () => {
  it('builds the real ClearPassAdapter when credentials are complete', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'hpe-clearpass-'));
    process.env.HPE_SETTINGS_PATH = join(tmpDir, 'settings.json');
    try {
      const { SettingsStore } = await import('../src/config/settings');
      const { PlaneRegistry } = await import('../src/planes/registry');
      const store = new SettingsStore();
      store.update({ planes: { clearpass: { host: 'https://cppm.example.com', token: 'shh' } } });
      const reg = new PlaneRegistry(store);
      expect(reg.get('clearpass')).toBeInstanceOf(ClearPassAdapter);
      const state = reg.state('clearpass');
      expect(state.linked).toBe(true);
      expect(state.health).toBe('warning');
      expect(state.note).toBe('credentials saved — first sync pending');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
      delete process.env.HPE_SETTINGS_PATH;
    }
  });
});
