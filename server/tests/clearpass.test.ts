/**
 * server/tests/clearpass.test.ts — ClearPass adapter unit tests, NO network.
 *
 * The mapping helpers are tested against recorded ClearPass auth JSON inlined
 * here (Insight, /api/session accounting and legacy shapes, shape variance on
 * purpose); ClearPassAdapter.pull() is exercised end-to-end with an in-memory
 * fake `fetch` (FetchLike injection) to cover OAuth token minting and the 401
 * refresh, the HAL (_embedded.items) envelope, the windowed/paged request,
 * candidate-path fallback with a remembered working path, the newest-200 cap,
 * the endpoint-count fact, error naming and the secret-free call log.
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

/** A /api/session accounting row — the documented CPPM shape, no verdict field. */
const ROW_SESSION = {
  id: 90_112,
  acctsessionid: '5F2A-0001',
  acctstarttime: '2026-07-25T09:44:02Z',
  username: 'r.patel',
  mac_address: '9c:8e:99:1a:2b:3c',
  service_name: 'MRDN Wireless 802.1X',
  auth_type: 'EAP-TLS',
  nasipaddress: '10.42.3.19',
  enforcement_profile: 'Clinical staff',
};

/** 'HH:MM:SS' the way the adapter renders it (local wall-clock, design style). */
function expectedHhmmss(ms: number): string {
  const d = new Date(ms);
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((v) => String(v).padStart(2, '0')).join(':');
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
    expect(authResultFor('ACCEPT')).toEqual({ result: 'accept', tone: 'success', matched: true });
    expect(authResultFor('Access-Accept')).toEqual({ result: 'accept', tone: 'success', matched: true });
    expect(authResultFor('Access-Reject')).toEqual({ result: 'reject', tone: 'danger', matched: true });
    expect(authResultFor('DENIED')).toEqual({ result: 'reject', tone: 'danger', matched: true });
    expect(authResultFor('no-response')).toEqual({ result: 'timeout', tone: 'warning', matched: true });
  });

  // The bucket is a fallback, not CPPM's answer — the caller has to be able to
  // tell the two apart so the raw verdict can travel with the row.
  it('authResultFor reports an unrecognised verdict as unmatched', () => {
    expect(authResultFor('some-unrecognised-verdict')).toEqual({
      result: 'timeout',
      tone: 'warning',
      matched: false,
    });
    expect(authResultFor(null)).toEqual({ result: 'timeout', tone: 'warning', matched: false });
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
    expect(e!.time).toBe(expectedHhmmss(Date.parse(ROW_ACCEPT.timestamp)));
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
    expect(e!.time).toBe(expectedHhmmss(1_753_000_000_000));
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

  it('maps an /api/session accounting row — no verdict field means accept', () => {
    // A session exists only because RADIUS already answered Access-Accept;
    // bucketing it as 'timeout' would report a live network at 0% accept rate.
    const e = mapClearPassAuthEvent(ROW_SESSION);
    expect(e).not.toBeNull();
    expect(e!.time).toBe(expectedHhmmss(Date.parse(ROW_SESSION.acctstarttime)));
    expect(e!.tsMs).toBe(Date.parse(ROW_SESSION.acctstarttime));
    expect(e!.who).toBe('r.patel');
    expect(e!.mac).toBe('9c:8e:99:1a:2b:3c');
    expect(e!.method).toBe('802.1X'); // auth_type
    expect(e!.nas).toBe('10.42.3.19'); // nasipaddress
    expect(e!.role).toBe('role Clinical staff');
    expect(e!.result).toBe('accept');
    expect(e!.tone).toBe('success');
  });

  it('still buckets an explicit unknown verdict as timeout, session row or not', () => {
    const e = mapClearPassAuthEvent({ ...ROW_SESSION, auth_status: 'something-new' });
    expect(e!.result).toBe('timeout');
    expect(e!.tone).toBe('warning');
    // …and the raw verdict travels with the row: an operator must never read a
    // fabricated timeout with no evidence of what CPPM actually answered.
    expect(e!.reason).toBe('unmapped result: something-new');
  });

  it('keeps a reported reason alongside the unmapped raw verdict', () => {
    const e = mapClearPassAuthEvent({
      username: 'x.chen',
      mac: 'aa:bb:cc:00:11:22',
      auth_status: 'Access-Challenge',
      reason: 'EAP identity requested',
    });
    expect(e!.result).toBe('timeout');
    expect(e!.reason).toBe('EAP identity requested · unmapped result: Access-Challenge');
  });

  it('renders the design HH:MM:SS time, so a burst inside one minute stays orderable', () => {
    const first = mapClearPassAuthEvent({ ...ROW_ACCEPT, timestamp: '2026-07-25T09:41:22Z' });
    const second = mapClearPassAuthEvent({ ...ROW_ACCEPT, timestamp: '2026-07-25T09:41:47Z' });
    expect(first!.time).toMatch(/^\d{2}:\d{2}:\d{2}$/);
    expect(first!.time).not.toBe(second!.time);
  });
});

// -- pull() with an in-memory fake fetch (no network) ---------------------------------

type HandlerResult = { status?: number; body?: unknown; headers?: Record<string, string> };
type Handler = (method: string, pathname: string, query: URLSearchParams, body: unknown) => HandlerResult | undefined;

interface FakeFetch {
  fn: FetchLike;
  calls: string[];
  authHeaders: (string | null)[];
  bodies: (string | null)[];
}

function fakeFetch(handler: Handler): FakeFetch {
  const calls: string[] = [];
  const authHeaders: (string | null)[] = [];
  const bodies: (string | null)[] = [];
  const fn: FetchLike = async (url, init) => {
    const u = new URL(url);
    const method = (init?.method as string | undefined) ?? 'GET';
    calls.push(`${method} ${u.pathname}${u.search}`);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    authHeaders.push(headers.authorization ?? null);
    const raw = typeof init?.body === 'string' ? init.body : null;
    bodies.push(raw);
    const result = handler(method, u.pathname, u.searchParams, raw === null ? undefined : JSON.parse(raw));
    if (!result) {
      return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify(result.body ?? {}), {
      status: result.status ?? 200,
      headers: { 'content-type': 'application/json', ...(result.headers ?? {}) },
    });
  };
  return { fn, calls, authHeaders, bodies };
}

function makeState(): PlaneState {
  return { id: 'clearpass', linked: true, health: 'warning', lastSync: null, deviceCount: null, callsToday: 0, note: null };
}

/** The legacy pre-minted-token credentials (still supported). */
const CREDS = { host: 'https://cppm.example.com', token: 'cppm-token-shh' };
/** What the connect drawer actually saves: publisher + API client credentials. */
const OAUTH_CREDS = {
  publisher: 'cppm-01.meridian.health',
  clientId: 'portal-insight',
  clientSecret: 'cppm-client-s3cr3t',
};

const AUTH_PATH = '/api/session';
const INSIGHT_PATH = '/api/insight/endpoint/auth-events';

function makeAdapter(handler: Handler, creds: Record<string, string> = CREDS) {
  const { fn, calls, authHeaders, bodies } = fakeFetch(handler);
  const recorded: { path: string; ms: number; code: string }[] = [];
  const state = makeState();
  // The backoff sleep is captured, never actually awaited in wall time — the
  // test asserts the delay the adapter CHOSE, without paying it.
  const slept: number[] = [];
  const adapter = new ClearPassAdapter(creds, state, (c) => recorded.push(c), fn, async (ms) => {
    slept.push(ms);
  });
  return { adapter, state, recorded, calls, authHeaders, bodies, slept };
}

/** The container a real CPPM answers a collection with. */
function hal(items: unknown[], extra: Record<string, unknown> = {}): unknown {
  return { count: items.length, _links: { self: { href: AUTH_PATH } }, _embedded: { items }, ...extra };
}

const HAPPY_ROUTES: Record<string, unknown> = {
  // unordered on purpose, in the HAL envelope CPPM actually sends
  [`GET ${AUTH_PATH}`]: hal([ROW_REJECT, ROW_TIMEOUT, ROW_ACCEPT]),
};

function routeHandler(routes: Record<string, unknown>): Handler {
  return (method, pathname) => {
    const body = routes[`${method} ${pathname}`];
    return body === undefined ? undefined : { body };
  };
}

describe('ClearPassAdapter.pull()', () => {
  it('reads the HAL envelope, sorts newest first, and reports the summary note', async () => {
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
    expect(recorded.some((c) => c.path.startsWith(`GET ${AUTH_PATH}?`) && c.code === '200')).toBe(true);
  });

  it('asks for a bounded, sorted, paged window instead of the vendor default page', async () => {
    const { adapter, calls } = makeAdapter(routeHandler(HAPPY_ROUTES));
    await adapter.pull();
    const url = new URL(`https://cppm.example.com${calls.find((c) => c.startsWith(`GET ${AUTH_PATH}`))!.slice(4)}`);
    expect(url.searchParams.get('limit')).toBe('100');
    expect(url.searchParams.get('offset')).toBe('0');
    expect(url.searchParams.get('sort')).toBe('-acctstarttime');
    const filter = JSON.parse(url.searchParams.get('filter') as string) as { acctstarttime: { $gte: string } };
    const since = Date.parse(filter.acctstarttime.$gte);
    expect(Date.now() - since).toBeGreaterThan(0);
    expect(Date.now() - since).toBeLessThanOrEqual(24 * 60 * 60 * 1000 + 5_000); // a 24h window
  });

  it('pages until the newest-200 cap is filled', async () => {
    const base = Date.parse('2026-07-25T00:00:00Z');
    const many = Array.from({ length: MAX_AUTH_EVENTS + 5 }, (_, i) => ({
      timestamp: new Date(base + i * 60_000).toISOString(),
      username: `u${i}`,
      mac_address: i.toString(16).padStart(12, '0'),
      service: 'svc',
      auth_result: 'ACCEPT',
    }));
    const newestFirst = [...many].reverse(); // the server honours sort=-…, as CPPM does
    const { adapter, calls } = makeAdapter((method, pathname, query) => {
      if (method !== 'GET' || pathname !== AUTH_PATH) return undefined;
      const offset = Number(query.get('offset') ?? '0');
      const limit = Number(query.get('limit') ?? '25');
      return { body: hal(newestFirst.slice(offset, offset + limit), { count: newestFirst.length }) };
    });
    const pull = await adapter.pull();
    expect(pull.authEvents).toHaveLength(MAX_AUTH_EVENTS);
    expect(pull.authEvents![0].who).toBe(`u${MAX_AUTH_EVENTS + 4}`); // newest kept
    expect(pull.authEvents![MAX_AUTH_EVENTS - 1].who).toBe('u5'); // oldest five dropped
    // two pages of 100 — not one accidental page, and not an unbounded crawl
    const pages = calls.filter((c) => c.startsWith(`GET ${AUTH_PATH}`));
    expect(pages).toHaveLength(2);
    expect(pages[1]).toContain('offset=100');
  });

  it('stops paging when a short page says the window is exhausted', async () => {
    const rows = Array.from({ length: 40 }, (_, i) => ({ ...ROW_ACCEPT, username: `u${i}` }));
    const { adapter, calls } = makeAdapter((method, pathname) =>
      method === 'GET' && pathname === AUTH_PATH ? { body: hal(rows) } : undefined,
    );
    const pull = await adapter.pull();
    expect(pull.authEvents).toHaveLength(40);
    expect(calls.filter((c) => c.startsWith(`GET ${AUTH_PATH}`))).toHaveLength(1);
  });

  it('retries the first page bare when the build rejects the query vocabulary', async () => {
    // An older build 400s on the filter/sort params but still serves the resource.
    const { adapter, calls } = makeAdapter((method, pathname, query) => {
      if (method !== 'GET' || pathname !== AUTH_PATH) return undefined;
      if (query.has('filter')) return { status: 400, body: { detail: 'unknown parameter filter' } };
      return { body: hal([ROW_ACCEPT]) };
    });
    const pull = await adapter.pull();
    expect(pull.authEvents).toHaveLength(1);
    expect(calls).toContain(`GET ${AUTH_PATH}`); // the bare retry
    // …and the bare style is remembered: the second pull does not re-probe with params
    await adapter.pull();
    expect(calls.filter((c) => c.startsWith(`GET ${AUTH_PATH}?`))).toHaveLength(1);
  });

  it('tolerates a 404 candidate and remembers the working path', async () => {
    const { adapter, calls } = makeAdapter((method, pathname) =>
      method === 'GET' && pathname === INSIGHT_PATH ? { body: hal([ROW_ACCEPT]) } : undefined,
    );
    const pull = await adapter.pull();
    expect(pull.authEvents).toHaveLength(1);
    expect(calls.some((c) => c.startsWith(`GET ${AUTH_PATH}`))).toBe(true); // tried, 404

    await adapter.pull(); // resolved path goes first — the dead candidate is not retried
    expect(calls.filter((c) => c.startsWith(`GET ${AUTH_PATH}`))).toHaveLength(1);
    expect(calls.filter((c) => c.startsWith(`GET ${INSIGHT_PATH}`))).toHaveLength(2);
  });

  it('sends the Insight candidate an epoch start/end window', async () => {
    const { adapter, calls } = makeAdapter((method, pathname) =>
      method === 'GET' && pathname === INSIGHT_PATH ? { body: hal([ROW_ACCEPT]) } : undefined,
    );
    await adapter.pull();
    const url = new URL(`https://cppm.example.com${calls.find((c) => c.startsWith(`GET ${INSIGHT_PATH}`))!.slice(4)}`);
    const start = Number(url.searchParams.get('start_time'));
    const end = Number(url.searchParams.get('end_time'));
    expect(end - start).toBeGreaterThanOrEqual(24 * 60 * 60); // seconds, not ms
    expect(end - start).toBeLessThanOrEqual(24 * 60 * 60 + 1); // ±1s from rounding the window edges
    expect(url.searchParams.get('limit')).toBe('100');
  });

  it('accepts a bare-array body (first array-valued key tolerance)', async () => {
    const { adapter } = makeAdapter((method, pathname) => {
      if (method === 'GET' && pathname === AUTH_PATH) return { body: [ROW_ACCEPT, ROW_REJECT] };
      return undefined;
    });
    const pull = await adapter.pull();
    expect(pull.authEvents).toHaveLength(2);
  });

  it('prefers the logs payload key over an incidental array', async () => {
    // `{errors: [], logs: [...]}` — the first-array heuristic alone would zero the section.
    const { adapter } = makeAdapter((method, pathname) => {
      if (method === 'GET' && pathname === AUTH_PATH) return { body: { errors: [], logs: [ROW_ACCEPT] } };
      return undefined;
    });
    const pull = await adapter.pull();
    expect(pull.authEvents).toHaveLength(1);
    expect(pull.authEvents![0].who).toBe('m.okonjo');
  });

  it('reads an empty HAL page as an honest empty feed (CPPM omits _embedded)', async () => {
    const { adapter, state } = makeAdapter((method, pathname) => {
      if (method === 'GET' && pathname === AUTH_PATH) return { body: { count: 0, _links: { self: { href: AUTH_PATH } } } };
      return undefined;
    });
    const pull = await adapter.pull();
    expect(pull.authEvents).toEqual([]);
    expect(state.note).toBe('0 auth events · 0 rejects');
  });

  it('fails the pull on a 200 whose payload has no row container — never a silent empty feed', async () => {
    const { adapter, state } = makeAdapter((method, pathname) => {
      if (method === 'GET' && pathname === AUTH_PATH) return { body: { status: 'ok', detail: { note: 'nothing here' } } };
      return undefined;
    });
    await expect(adapter.pull()).rejects.toThrow(/section 'authEvents' failed — 200 from \/api\/session/);
    await expect(adapter.pull()).rejects.toThrow(/no row container/);
    expect(state.health).toBe('warning'); // never promoted on an unreadable body
    expect(state.note).toBeNull();
  });

  it('fails the pull naming the section when every candidate 404s', async () => {
    const { adapter } = makeAdapter(() => undefined);
    await expect(adapter.pull()).rejects.toThrow(/section 'authEvents' failed/);
    await expect(adapter.pull()).rejects.toThrow(/404 on every candidate/);
  });

  // A build that names the timestamp field something we do not read still
  // reports real decisions — sinking them to the back of the 200-row cap threw
  // them away silently. They keep arrival order behind the dated rows instead.
  it('keeps undated rows rather than sorting them off the end of the cap, and names them', async () => {
    const dated = Array.from({ length: MAX_AUTH_EVENTS - 1 }, (_, i) => ({
      timestamp: new Date(Date.parse('2026-07-25T00:00:00Z') + i * 60_000).toISOString(),
      username: `dated-${i}`,
      auth_result: 'ACCEPT',
    }));
    const undated = [
      { occurred: '2026-07-25T09:00:00Z', username: 'undated-1', auth_result: 'ACCEPT' },
      { occurred: '2026-07-25T09:01:00Z', username: 'undated-2', auth_result: 'ACCEPT' },
    ];
    const { adapter, state } = makeAdapter((method, pathname) =>
      method === 'GET' && pathname === AUTH_PATH ? { body: hal([...undated, ...dated]) } : undefined,
    );
    const pull = await adapter.pull();
    expect(pull.authEvents).toHaveLength(MAX_AUTH_EVENTS);
    // dated rows first (newest first), then the undated ones in arrival order
    expect(pull.authEvents![0].who).toBe(`dated-${MAX_AUTH_EVENTS - 2}`);
    expect(pull.authEvents![MAX_AUTH_EVENTS - 1].who).toBe('undated-1');
    expect(state.note).toContain('1 without timestamps');
  });

  // A throttle is not a verdict: back off (honouring Retry-After) and try
  // again rather than degrading the plane every 60s.
  it('backs off and retries a 429, honouring Retry-After', async () => {
    let throttled = 0;
    const { adapter, state, slept, calls } = makeAdapter((method, pathname) => {
      if (method !== 'GET' || pathname !== AUTH_PATH) return undefined;
      throttled += 1;
      if (throttled === 1) return { status: 429, body: { detail: 'rate limit' }, headers: { 'retry-after': '2' } };
      return { body: hal([ROW_ACCEPT]) };
    });
    const pull = await adapter.pull();
    expect(pull.authEvents).toHaveLength(1);
    expect(slept).toEqual([2_000]); // Retry-After wins over the exponential floor
    expect(state.health).toBe('healthy'); // not degraded by a survivable throttle
    // every attempt is on the wire, so the Activity tab shows the real 429
    expect(calls.filter((c) => c.startsWith(`GET ${AUTH_PATH}`))).toHaveLength(2);
  });

  it('names rate limiting when the throttle outlives the backoff', async () => {
    const { adapter, slept } = makeAdapter((method, pathname) =>
      method === 'GET' && pathname === AUTH_PATH ? { status: 429, body: {} } : undefined,
    );
    await expect(adapter.pull()).rejects.toThrow(/rate limited, backoff exhausted/);
    expect(slept).toEqual([1_000, 2_000]); // exponential floor, no Retry-After sent
  });

  it('rides out a transient 503 gateway blip', async () => {
    let n = 0;
    const { adapter } = makeAdapter((method, pathname) => {
      if (method !== 'GET' || pathname !== AUTH_PATH) return undefined;
      n += 1;
      return n === 1 ? { status: 503, body: {} } : { body: hal([ROW_ACCEPT]) };
    });
    const pull = await adapter.pull();
    expect(pull.authEvents).toHaveLength(1);
  });

  // ClearPass describes policy, not a transport: no shell, no brokered push.
  it('claims no shell, no brokered write and no config read', () => {
    const { adapter } = makeAdapter(routeHandler(HAPPY_ROUTES));
    expect(adapter.capabilities()).toEqual({ localShell: false, brokeredWrite: false, configRead: false });
  });

  it('fails the pull naming the section on a non-404 error (a static token cannot self-heal on 401)', async () => {
    const { adapter, calls } = makeAdapter((method, pathname) => {
      if (method === 'GET' && pathname === AUTH_PATH) {
        return { status: 401, body: { error: 'bad token' } };
      }
      return undefined;
    });
    await expect(adapter.pull()).rejects.toThrow(/section 'authEvents' failed — HTTP 401/);
    expect(calls.filter((c) => c.startsWith(`GET ${AUTH_PATH}`))).toHaveLength(1); // no retry
  });
});

// -- OAuth token minting (the credentials the product actually saves) ------------------

describe('ClearPassAdapter OAuth', () => {
  /** Mints numbered tokens so an invalidate + re-mint is visible. */
  function oauthHandler(rest: Handler): { handler: Handler; minted: () => number } {
    let n = 0;
    const handler: Handler = (method, pathname, query, body) => {
      if (method === 'POST' && pathname === '/api/oauth') {
        expect(body).toMatchObject({ grant_type: 'client_credentials', client_id: 'portal-insight' });
        n += 1;
        return { body: { access_token: `minted-${n}`, expires_in: 28_800, token_type: 'Bearer' } };
      }
      return rest(method, pathname, query, body);
    };
    return { handler, minted: () => n };
  }

  it('mints a token at POST /api/oauth and bears it on the auth-log call', async () => {
    const { handler, minted } = oauthHandler((method, pathname) =>
      method === 'GET' && pathname === AUTH_PATH ? { body: hal([ROW_ACCEPT]) } : undefined,
    );
    const { adapter, calls, authHeaders, recorded } = makeAdapter(handler, OAUTH_CREDS);
    const pull = await adapter.pull();
    expect(pull.authEvents).toHaveLength(1);
    expect(calls[0]).toBe('POST /api/oauth');
    expect(minted()).toBe(1);
    expect(authHeaders.filter((h) => h !== null)).toContain('Bearer minted-1');
    // one mint is shared by the whole poll — not one per call
    await adapter.pull();
    expect(minted()).toBe(1);
    // the client secret never reaches the call log
    expect(JSON.stringify(recorded)).not.toContain('cppm-client-s3cr3t');
    expect(recorded.some((c) => c.path === 'POST /api/oauth')).toBe(true);
  });

  it('invalidates and re-mints exactly once on a 401 (CPPM tokens expire at 8h)', async () => {
    let seenAuthCalls = 0;
    const { handler, minted } = oauthHandler((method, pathname) => {
      if (method !== 'GET' || pathname !== AUTH_PATH) return undefined;
      seenAuthCalls += 1;
      // the first call carries the (expired) first token
      if (seenAuthCalls === 1) return { status: 401, body: { detail: 'token expired' } };
      return { body: hal([ROW_ACCEPT]) };
    });
    const { adapter, authHeaders } = makeAdapter(handler, OAUTH_CREDS);
    const pull = await adapter.pull();
    expect(pull.authEvents).toHaveLength(1);
    expect(minted()).toBe(2); // mint, 401, re-mint
    expect(authHeaders).toContain('Bearer minted-2');
  });

  it('fails the pull naming /api/oauth when the mint itself fails', async () => {
    const { adapter } = makeAdapter(
      (method, pathname) => (method === 'POST' && pathname === '/api/oauth' ? { status: 403, body: {} } : undefined),
      OAUTH_CREDS,
    );
    await expect(adapter.pull()).rejects.toThrow(/\/api\/oauth answered HTTP 403 without an access_token/);
  });

  it('publishes the minted credential expiry on plane state (never the token)', async () => {
    // The registry seeds PlaneState.token with the SOURCE only; the 8-hour
    // CPPM grant's expiry is knowable here and nowhere else.
    const { handler } = oauthHandler((method, pathname) =>
      method === 'GET' && pathname === AUTH_PATH ? { body: hal([ROW_ACCEPT]) } : undefined,
    );
    const { adapter, state } = makeAdapter(handler, OAUTH_CREDS);
    const before = Date.now();
    await adapter.pull();
    expect(state.token?.source).toBe('oauth client_credentials');
    expect(Date.parse(state.token!.expiresAt!)).toBeGreaterThanOrEqual(before + 28_800 * 1000);
    expect(JSON.stringify(state.token)).not.toContain('minted-1');
    expect(JSON.stringify(state.token)).not.toContain('cppm-client-s3cr3t');
  });

  it('a mint without expires_in publishes no expiry rather than the 8h default', async () => {
    const handler: Handler = (method, pathname) => {
      if (method === 'POST' && pathname === '/api/oauth') return { body: { access_token: 'no-ttl' } };
      if (method === 'GET' && pathname === AUTH_PATH) return { body: hal([ROW_ACCEPT]) };
      return undefined;
    };
    const { adapter, state } = makeAdapter(handler, OAUTH_CREDS);
    await adapter.pull();
    expect(state.token).toEqual({ expiresAt: null, source: 'oauth client_credentials' });
  });

  it('accepts the credential record the connect drawer writes', () => {
    expect(ClearPassAdapter.isComplete({ ...OAUTH_CREDS, displayName: 'ClearPass', scopes: 'read:session' })).toBe(true);
    expect(ClearPassAdapter.isComplete(CREDS)).toBe(true); // legacy host + token
    expect(ClearPassAdapter.isComplete({ token: 'shh' })).toBe(false); // no publisher/host
    expect(ClearPassAdapter.isComplete({ publisher: 'cppm-01' })).toBe(false); // no credentials
    expect(ClearPassAdapter.isComplete({ publisher: 'cppm-01', clientId: 'x' })).toBe(false); // no secret
    expect(ClearPassAdapter.isComplete(null)).toBe(false);
  });
});

// -- The endpoint repository (the plane's second dataset) ------------------------------

describe('ClearPassAdapter endpoints', () => {
  const endpointRoutes: Handler = (method, pathname) => {
    if (method === 'GET' && pathname === AUTH_PATH) return { body: hal([ROW_ACCEPT]) };
    if (method === 'GET' && pathname === '/api/endpoint') {
      return { body: hal([{ id: 1, mac_address: 'aabbccddeeff' }], { count: 4182 }) };
    }
    return undefined;
  };

  it('reports the endpoint total as the plane device count and in the note', async () => {
    const { adapter, state, calls } = makeAdapter(endpointRoutes);
    await adapter.pull();
    expect(state.deviceCount).toBe(4182);
    expect(state.note).toBe('4,182 endpoints · 1 auth events · 0 rejects');
    expect(calls.some((c) => c.startsWith('GET /api/endpoint?'))).toBe(true);

    // the repository is a 5-minute pull, not a 60-second one
    await adapter.pull();
    expect(calls.filter((c) => c.startsWith('GET /api/endpoint'))).toHaveLength(1);
  });

  it('drops the endpoint fact without failing the auth feed when /api/endpoint errors', async () => {
    const { adapter, state } = makeAdapter((method, pathname) => {
      if (method === 'GET' && pathname === AUTH_PATH) return { body: hal([ROW_ACCEPT]) };
      if (method === 'GET' && pathname === '/api/endpoint') return { status: 500, body: { detail: 'boom' } };
      return undefined;
    });
    const pull = await adapter.pull();
    expect(pull.authEvents).toHaveLength(1);
    expect(state.deviceCount).toBeNull();
    expect(state.note).toBe('1 auth events · 0 rejects');
  });
});

// -- The one sanctioned write ----------------------------------------------------------

describe('ClearPassAdapter.coaDisconnect()', () => {
  it('sends the vendor-required body and no enforcement profile by default', async () => {
    const { adapter, calls, bodies } = makeAdapter(() => ({ status: 200, body: {} }));
    const res = await adapter.coaDisconnect('3C-22-FB-41-0A-19');
    expect(res.status).toBe(200);
    expect(calls[0]).toBe('POST /api/session-action/disconnect/mac/3c%3A22%3Afb%3A41%3A0a%3A19');
    expect(JSON.parse(bodies[0] as string)).toEqual({ async: false });
  });

  it('forwards a configured enforcement profile', async () => {
    const { adapter, bodies } = makeAdapter(() => ({ status: 200, body: {} }), {
      ...CREDS,
      coaEnforcementProfile: 'Quarantine',
    });
    await adapter.coaDisconnect('3c:22:fb:41:0a:19');
    expect(JSON.parse(bodies[0] as string)).toEqual({ async: false, enforcement_profile: 'Quarantine' });
  });
});

// -- Registry wiring --------------------------------------------------------------------

describe('registry wiring', () => {
  async function buildRegistry(creds: Record<string, string>) {
    const tmpDir = mkdtempSync(join(tmpdir(), 'hpe-clearpass-'));
    process.env.HPE_SETTINGS_PATH = join(tmpDir, 'settings.json');
    try {
      const { SettingsStore } = await import('../src/config/settings');
      const { PlaneRegistry } = await import('../src/planes/registry');
      const store = new SettingsStore();
      store.update({ planes: { clearpass: creds } });
      const reg = new PlaneRegistry(store);
      return { adapter: reg.get('clearpass'), state: reg.state('clearpass') };
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
      delete process.env.HPE_SETTINGS_PATH;
    }
  }

  it('builds the real ClearPassAdapter when credentials are complete', async () => {
    const { adapter, state } = await buildRegistry({ host: 'https://cppm.example.com', token: 'shh' });
    expect(adapter).toBeInstanceOf(ClearPassAdapter);
    expect(state.linked).toBe(true);
    expect(state.health).toBe('warning');
    expect(state.note).toBe('credentials saved — first sync pending');
  });

  it('builds the real adapter from the exact payload the connect drawer saves', async () => {
    // publisher + clientId + clientSecret — no host, no pre-minted token.
    const { adapter, state } = await buildRegistry({
      displayName: 'ClearPass',
      publisher: 'cppm-01.meridian.health',
      clientId: 'portal-insight',
      clientSecret: 'vault-secret',
      scopes: 'read:session,read:endpoint,read:policy',
    });
    expect(adapter).toBeInstanceOf(ClearPassAdapter);
    expect(state.note).toBe('credentials saved — first sync pending');
  });
});
