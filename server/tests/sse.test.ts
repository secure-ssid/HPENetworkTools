/**
 * server/tests/sse.test.ts — SseAdapter unit tests, NO network.
 *
 * mapSseObject() is tested against representative vendor-shaped bodies for
 * every one of the nine managed kinds; SseAdapter.pull()/getObject()/mutate()/
 * retryCommit() are exercised end-to-end against an in-memory fake `fetch`
 * (FetchLike injection) covering: the static Bearer token on every call,
 * pagination (pagenumber/pagesize, not pageNumber/pageSize), partial
 * permissions (401/403 on one kind, 404 on a limited-release kind), an
 * all-kinds failure degrading the whole pull, the mutation+commit split
 * (staged vs applied), commit-only retry, and the secret-free call log.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PlaneState } from '../src/planes/types';
import {
  normalizeSseBaseUrl,
  SSE_INSECURE_HTTP_OVERRIDE_ENV,
  SSE_KIND_SPEC,
  SseAdapter,
  mapSseObject,
  type FetchLike,
} from '../src/planes/sse';

// -- Pure mapper -------------------------------------------------------------

describe('mapSseObject', () => {
  it('maps a connector zone, pulling the connector count into `detail`', () => {
    const row = mapSseObject('connectorZones', { id: 'cz-1', name: 'HQ zone', connectors: ['c-1', 'c-2'] });
    expect(row).toMatchObject({ kind: 'connectorZones', id: 'cz-1', name: 'HQ zone', detail: '2 connector(s)' });
  });

  it('maps a connector, naming its zone in `detail`', () => {
    const row = mapSseObject('connectors', { id: 'c-1', name: 'edge-1', connectorZoneId: 'cz-1', enabled: true });
    expect(row).toMatchObject({ kind: 'connectors', id: 'c-1', name: 'edge-1', enabled: true, detail: 'zone cz-1' });
  });

  it('maps a user, naming its display via userName and email in `detail`', () => {
    const row = mapSseObject('users', { id: 'u-1', userName: 'j.alvarez', email: 'j.alvarez@meridian.health' });
    expect(row).toMatchObject({ kind: 'users', id: 'u-1', name: 'j.alvarez', detail: 'j.alvarez@meridian.health' });
  });

  it('strips a private key / PSK / secret field out of the raw payload', () => {
    const row = mapSseObject('users', {
      id: 'u-2',
      userName: 'svc-account',
      sshPrivateKey: '-----BEGIN OPENSSH PRIVATE KEY-----',
      hasSshPrivateKey: true,
    });
    expect(row?.raw.sshPrivateKey).toBeUndefined();
    // hasSshPrivateKey is a harmless boolean flag, but it incidentally matches
    // the same secret-shaped key filter (contains "privateKey") — stripping
    // it too is a safe over-approximation, not a bug.
    expect(row?.raw.hasSshPrivateKey).toBeUndefined();
    expect(JSON.stringify(row)).not.toContain('BEGIN OPENSSH');
  });

  it('marks a system-defined row builtIn', () => {
    const row = mapSseObject('customIpCategories', { id: 'ip-1', name: 'RFC1918', systemDefined: true });
    expect(row?.builtIn).toBe(true);
  });

  it('returns null for a row with no id', () => {
    expect(mapSseObject('groups', { name: 'no-id' })).toBeNull();
    expect(mapSseObject('groups', null)).toBeNull();
  });

  it('every kind resolves to a known REST path (the mutation allowlist)', () => {
    for (const kind of Object.keys(SSE_KIND_SPEC) as (keyof typeof SSE_KIND_SPEC)[]) {
      expect(SSE_KIND_SPEC[kind].path.startsWith('/api/v1.0/')).toBe(true);
    }
  });
});

// -- pull() / mutate() with an in-memory fake fetch ---------------------------

type HandlerResult = { status?: number; body?: unknown };
type Handler = (method: string, pathname: string, query: URLSearchParams, body: unknown) => HandlerResult | undefined;

interface FakeFetch {
  fn: FetchLike;
  calls: string[];
  authHeaders: (string | null)[];
  redirectModes: RequestInit['redirect'][];
}

function fakeFetch(handler: Handler): FakeFetch {
  const calls: string[] = [];
  const authHeaders: (string | null)[] = [];
  const redirectModes: RequestInit['redirect'][] = [];
  const fn: FetchLike = async (url, init) => {
    const u = new URL(url);
    const method = (init?.method as string | undefined) ?? 'GET';
    calls.push(`${method} ${u.pathname}${u.search}`);
    redirectModes.push(init?.redirect);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    authHeaders.push(headers.authorization ?? null);
    const raw = typeof init?.body === 'string' ? init.body : null;
    const result = handler(method, u.pathname, u.searchParams, raw === null ? undefined : JSON.parse(raw));
    if (!result) return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } });
    const status = result.status ?? 200;
    // Fetch forbids a body on a null-body status (204/205/304) — a real
    // server would send no content-length either, so this fake must not.
    const nullBody = status === 204 || status === 205 || status === 304;
    return new Response(nullBody ? null : JSON.stringify(result.body ?? {}), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fn, calls, authHeaders, redirectModes };
}

function makeState(): PlaneState {
  return { id: 'sse', linked: true, health: 'warning', lastSync: null, deviceCount: null, callsToday: 0, note: null };
}

const CREDS = { token: 'sse-admin-token-shh' };

function makeAdapter(handler: Handler, creds: Record<string, string> = CREDS) {
  const { fn, calls, authHeaders, redirectModes } = fakeFetch(handler);
  const recorded: { path: string; ms: number; code: string }[] = [];
  const state = makeState();
  const slept: number[] = [];
  const adapter = new SseAdapter(creds, state, (c) => recorded.push(c), fn, async (ms) => {
    slept.push(ms);
  });
  return { adapter, state, calls, authHeaders, redirectModes, recorded, slept };
}

/** Every kind's collection answers one small page of `count` rows. */
function everyKindOk(count = 1): Handler {
  return (method, pathname) => {
    if (method !== 'GET') return undefined;
    for (const [kind, spec] of Object.entries(SSE_KIND_SPEC)) {
      if (pathname === spec.path) {
        const rows = Array.from({ length: count }, (_, i) => ({ id: `${kind}-${i}`, name: `${kind} ${i}` }));
        return { body: { data: rows, totalRecords: count } };
      }
    }
    return undefined;
  };
}

describe('SSE Admin API endpoint security', () => {
  let previousOverride: string | undefined;

  beforeEach(() => {
    previousOverride = process.env[SSE_INSECURE_HTTP_OVERRIDE_ENV];
    delete process.env[SSE_INSECURE_HTTP_OVERRIDE_ENV];
  });

  afterEach(() => {
    if (previousOverride === undefined) delete process.env[SSE_INSECURE_HTTP_OVERRIDE_ENV];
    else process.env[SSE_INSECURE_HTTP_OVERRIDE_ENV] = previousOverride;
  });

  it('requires an explicit https:// scheme for custom endpoints', () => {
    expect(() => normalizeSseBaseUrl('admin-api.example.test')).toThrow(/must start with https:\/\//);
    expect(() => normalizeSseBaseUrl('http://admin-api.example.test')).toThrow(/plaintext HTTP is disabled/);
    expect(() => normalizeSseBaseUrl('ftp://admin-api.example.test')).toThrow(/must use https:\/\//);
  });

  it('normalizes a valid HTTPS endpoint without weakening its scheme', () => {
    expect(normalizeSseBaseUrl(' HTTPS://ADMIN-API.EXAMPLE.TEST///?ignored=yes#fragment ')).toBe(
      'https://admin-api.example.test',
    );
  });

  it('allows HTTP only with the process-level test/development override', () => {
    process.env[SSE_INSECURE_HTTP_OVERRIDE_ENV] = '1';
    expect(normalizeSseBaseUrl('http://127.0.0.1:9876///')).toBe('http://127.0.0.1:9876');
  });

  it('keeps the override disabled in production', () => {
    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    process.env[SSE_INSECURE_HTTP_OVERRIDE_ENV] = '1';
    try {
      expect(() => normalizeSseBaseUrl('http://127.0.0.1:9876')).toThrow(/plaintext HTTP is disabled/);
    } finally {
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
    }
  });

  it('rejects an insecure adapter endpoint before fetch can receive the token', async () => {
    let fetchCalls = 0;
    const fetchImpl: FetchLike = async () => {
      fetchCalls += 1;
      return new Response('{}');
    };
    expect(
      () =>
        new SseAdapter(
          { token: 'must-not-leak', baseUrl: 'http://127.0.0.1:9876' },
          makeState(),
          () => {},
          fetchImpl,
        ),
    ).toThrow(/plaintext HTTP is disabled/);
    expect(fetchCalls).toBe(0);
  });
});

describe('SseAdapter.isComplete / capabilities', () => {
  it('requires only a token — baseUrl is optional', () => {
    expect(SseAdapter.isComplete({ token: 'x' })).toBe(true);
    expect(SseAdapter.isComplete({ baseUrl: 'https://admin-api.axissecurity.com' })).toBe(false);
    expect(SseAdapter.isComplete(null)).toBe(false);
  });

  it('directWrite reflects the connect drawer’s declared write scope, never a guess', () => {
    const { adapter: readOnly } = makeAdapter(everyKindOk(), CREDS);
    expect(readOnly.capabilities()).toMatchObject({ localShell: false, brokeredWrite: false, configRead: false, directWrite: false });
    const { adapter: writable } = makeAdapter(everyKindOk(), { ...CREDS, scopes: 'read:inventory,write:brokered' });
    expect(writable.capabilities().directWrite).toBe(true);
  });

  it('binds journals to a normalized base URL plus a one-way token hash', () => {
    const a = makeAdapter(everyKindOk(), { token: 'same-token', baseUrl: 'HTTPS://ADMIN-API.AXISSECURITY.COM/' }).adapter;
    const b = makeAdapter(everyKindOk(), { token: 'same-token', baseUrl: 'https://admin-api.axissecurity.com' }).adapter;
    const otherToken = makeAdapter(everyKindOk(), { token: 'other-token' }).adapter;
    expect(a.tenantFingerprint()).toBe(b.tenantFingerprint());
    expect(a.tenantFingerprint()).not.toBe(otherToken.tenantFingerprint());
    expect(a.tenantFingerprint()).not.toContain('same-token');
  });
});

describe('SseAdapter.pull()', () => {
  it('reads all nine kinds, pages with pagenumber/pagesize, and Bearer-authenticates every call', async () => {
    const { adapter, calls, authHeaders, redirectModes } = makeAdapter(everyKindOk(3));
    const pull = await adapter.pull();
    expect(pull.sse?.unavailable).toEqual([]);
    expect(Object.keys(pull.sse!.kinds)).toHaveLength(9);
    expect(pull.sse?.kinds.connectors?.rows).toHaveLength(3);
    expect(pull.sse?.kinds.connectors?.total).toBe(3);
    expect(calls.some((c) => c.includes('pagenumber=1') && c.includes('pagesize='))).toBe(true);
    expect(authHeaders.every((h) => h === `Bearer ${CREDS.token}`)).toBe(true);
    expect(pull.partial).toBeUndefined();
    expect(redirectModes.every((mode) => mode === 'manual')).toBe(true);
  });

  it('a 401 on one kind marks it unavailable without failing the rest (partial, not empty)', async () => {
    const handler: Handler = (method, pathname) => {
      if (pathname === SSE_KIND_SPEC.users.path) return { status: 401, body: {} };
      return everyKindOk(2)(method, pathname, new URLSearchParams(), undefined);
    };
    const { adapter, state } = makeAdapter(handler);
    const pull = await adapter.pull();
    expect(pull.sse?.unavailable).toEqual(['users']);
    expect(pull.sse?.readStatus?.users).toMatchObject({ state: 'failed', reason: 'denied', httpCode: 401 });
    expect(pull.sse?.kinds.users).toBeUndefined();
    expect(pull.sse?.kinds.connectors?.rows.length).toBeGreaterThan(0);
    expect(pull.partial).toEqual(['sse']);
    expect(state.note).toContain('failed');
  });

  it('a 404 on a limited-release kind (locations) is unavailable, never an empty list', async () => {
    const handler: Handler = (method, pathname) => {
      if (pathname === SSE_KIND_SPEC.locations.path) return { status: 404, body: {} };
      return everyKindOk(1)(method, pathname, new URLSearchParams(), undefined);
    };
    const { adapter } = makeAdapter(handler);
    const pull = await adapter.pull();
    expect(pull.sse?.unavailable).toContain('locations');
    expect(pull.sse?.readStatus?.locations).toMatchObject({ state: 'failed', reason: 'unsupported', httpCode: 404 });
  });

  it('every denied kind is preserved as failure evidence instead of a permission-shaped empty inventory', async () => {
    const { adapter } = makeAdapter(() => ({ status: 403, body: {} }));
    const pull = await adapter.pull();
    expect(Object.keys(pull.sse?.kinds ?? {})).toHaveLength(0);
    expect(pull.sse?.unavailable).toHaveLength(9);
    expect(Object.values(pull.sse?.readStatus ?? {}).every((status) => status?.state === 'failed' && status.reason === 'denied')).toBe(true);
    expect(pull.partial).toEqual(['sse']);
  });

  it('transport failures remain unreachable per kind and never become permission failures', async () => {
    const throwingFetch: FetchLike = async () => {
      throw new Error('getaddrinfo ENOTFOUND admin-api.axissecurity.com');
    };
    const state = makeState();
    const adapter = new SseAdapter(CREDS, state, () => {}, throwingFetch);
    const pull = await adapter.pull();
    expect(pull.sse?.readStatus?.connectorZones).toMatchObject({
      state: 'failed',
      reason: 'unreachable',
      httpCode: null,
    });
    expect(JSON.stringify(pull.sse?.readStatus)).not.toContain('admin-api.axissecurity.com');
  });

  it.each([429, 500, 503])('keeps HTTP %s as a service/rate failure, never denied', async (status) => {
    const handler: Handler = (method, pathname) => {
      if (pathname === SSE_KIND_SPEC.groups.path) {
        return { status, body: { error: 'vendor response body must not escape' } };
      }
      return everyKindOk(1)(method, pathname, new URLSearchParams(), undefined);
    };
    const { adapter } = makeAdapter(handler);
    const pull = await adapter.pull();
    expect(pull.sse?.readStatus?.groups).toMatchObject({ state: 'failed', reason: 'service-error', httpCode: status });
    expect(JSON.stringify(pull)).not.toContain('vendor response body');
    expect(pull.sse?.kinds.connectors?.rows).toHaveLength(1);
  });

  it('keeps an unrecognized successful body as invalid-response, never denied or empty', async () => {
    const handler: Handler = (method, pathname) => {
      if (pathname === SSE_KIND_SPEC.applications.path) {
        return { status: 200, body: { unexpected: 'secret-free but unreadable' } };
      }
      return everyKindOk(1)(method, pathname, new URLSearchParams(), undefined);
    };
    const { adapter } = makeAdapter(handler);
    const pull = await adapter.pull();
    expect(pull.sse?.readStatus?.applications).toMatchObject({
      state: 'failed',
      reason: 'invalid-response',
      httpCode: 200,
    });
    expect(pull.sse?.kinds.applications).toBeUndefined();
    expect(pull.sse?.kinds.connectors?.rows).toHaveLength(1);
  });

  it('never logs the token — the call log carries method + path + status only', async () => {
    const { adapter, recorded } = makeAdapter(everyKindOk(1));
    await adapter.pull();
    expect(JSON.stringify(recorded)).not.toContain(CREDS.token);
    expect(recorded.some((c) => c.path.startsWith('GET /api/v1.0/Connectors'))).toBe(true);
  });
});

describe('SseAdapter.getObject()', () => {
  it('fetches one object fresh and strips secret fields', async () => {
    const { adapter } = makeAdapter((method, pathname) =>
      method === 'GET' && pathname === `${SSE_KIND_SPEC.tunnels.path}/t-1`
        ? { body: { id: 't-1', name: 'branch-1', authenticationPsk: 'shh-psk' } }
        : undefined,
    );
    const result = await adapter.getObject('tunnels', 't-1');
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('expected ok');
    expect(result.object.name).toBe('branch-1');
    expect(result.object.authenticationPsk).toBeUndefined();
  });

  it('a real 404 is reported as not-found — never fabricated as denied/unreachable', async () => {
    const { adapter } = makeAdapter(() => ({ status: 404, body: {} }));
    const result = await adapter.getObject('tunnels', 'missing');
    expect(result).toMatchObject({ status: 'not-found', httpCode: 404 });
  });

  it('a 401/403 is reported as denied — distinct from not-found', async () => {
    const { adapter } = makeAdapter(() => ({ status: 403, body: {} }));
    const result = await adapter.getObject('tunnels', 't-1');
    expect(result).toMatchObject({ status: 'denied', httpCode: 403 });
  });

  it('a transport failure is reported as unreachable — distinct from not-found', async () => {
    const throwingFetch: FetchLike = async () => {
      throw new Error('ECONNRESET');
    };
    const adapter = new SseAdapter(CREDS, makeState(), () => {}, throwingFetch);
    const result = await adapter.getObject('tunnels', 't-1');
    expect(result).toMatchObject({ status: 'unreachable', httpCode: null });
  });

  it('a 5xx (not 404, not 401/403) is reported as unreachable, never a fabricated not-found', async () => {
    const { adapter } = makeAdapter(() => ({ status: 500, body: {} }));
    const result = await adapter.getObject('tunnels', 't-1');
    expect(result).toMatchObject({ status: 'unreachable', httpCode: 500 });
  });
});

describe('SseAdapter.mutate() / retryCommit()', () => {
  it('create → 201, then an automatic commit → 204: applied, not staged', async () => {
    const handler: Handler = (method, pathname) => {
      if (method === 'POST' && pathname === SSE_KIND_SPEC.connectorZones.path) {
        return { status: 201, body: { id: 'cz-new' } };
      }
      if (method === 'POST' && pathname === '/api/v1.0/Commit') return { status: 204, body: {} };
      return undefined;
    };
    const { adapter } = makeAdapter(handler);
    const result = await adapter.mutate('connectorZones', 'create', undefined, { name: 'New zone' });
    expect(result.mutation).toMatchObject({ ok: true, httpCode: 201, id: 'cz-new' });
    expect(result.commit).toMatchObject({ attempted: true, ok: true, httpCode: 204 });
    expect(result.staged).toBe(false);
    expect(result.outcome).toBe('unverified');
  });

  it('a successful mutation with a failed commit is STAGED, not applied', async () => {
    const handler: Handler = (method, pathname) => {
      if (method === 'PUT' && pathname === `${SSE_KIND_SPEC.connectors.path}/c-1`) return { status: 200, body: { id: 'c-1' } };
      if (method === 'POST' && pathname === '/api/v1.0/Commit') return { status: 500, body: {} };
      return undefined;
    };
    const { adapter } = makeAdapter(handler);
    const result = await adapter.mutate('connectors', 'update', 'c-1', { name: 'renamed' });
    expect(result.mutation.ok).toBe(true);
    expect(result.commit.ok).toBe(false);
    expect(result.staged).toBe(true);
  });

  it('a failed mutation never even attempts the commit', async () => {
    const { adapter, calls } = makeAdapter((method, pathname) =>
      method === 'DELETE' && pathname === `${SSE_KIND_SPEC.groups.path}/g-1` ? { status: 409, body: {} } : undefined,
    );
    const result = await adapter.mutate('groups', 'delete', 'g-1');
    expect(result.mutation.ok).toBe(false);
    expect(result.mutation.acceptance).toBe('rejected');
    expect(result.commit).toMatchObject({ attempted: false, ok: false });
    expect(calls.some((c) => c.startsWith('POST /api/v1.0/Commit'))).toBe(false);
  });

  it('a transport rejection is an unknown mutation outcome and never auto-commits', async () => {
    const calls: string[] = [];
    const adapter = new SseAdapter(
      { token: 'x', scopes: 'write:brokered' },
      makeState(),
      () => {},
      async (url, init) => {
        const pathname = new URL(url).pathname;
        calls.push(`${init?.method ?? 'GET'} ${pathname}`);
        throw new Error('socket timed out');
      },
    );
    const result = await adapter.mutate('groups', 'update', 'g-1', { name: 'renamed' });
    expect(result.mutation).toMatchObject({ ok: false, acceptance: 'unknown', httpCode: null });
    expect(result.outcome).toBe('unknown');
    expect(result.staged).toBe(true);
    expect(calls).toEqual([`PUT ${SSE_KIND_SPEC.groups.path}/g-1`]);
  });

  it('retryCommit() only calls /Commit — it never replays the mutation', async () => {
    let mutationCalls = 0;
    const handler: Handler = (method, pathname) => {
      if (method === 'POST' && pathname === SSE_KIND_SPEC.users.path) {
        mutationCalls += 1;
        return { status: 201, body: { id: 'u-9' } };
      }
      if (method === 'POST' && pathname === '/api/v1.0/Commit') return { status: 204, body: {} };
      return undefined;
    };
    const { adapter } = makeAdapter(handler);
    const commitOnly = await adapter.retryCommit();
    expect(commitOnly).toMatchObject({ attempted: true, ok: true });
    expect(mutationCalls).toBe(0);
  });
});
