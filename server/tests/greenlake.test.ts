/**
 * server/tests/greenlake.test.ts — GreenLake adapter unit tests, NO network.
 *
 * The mapping helpers are tested against recorded GLP-style subscription JSON
 * inlined here; GreenLakeAdapter.pull() is exercised end-to-end with an
 * in-memory fake `fetch` (FetchLike injection) to cover the OAuth2 token flow
 * (documented /authorization/v2/oauth2/{workspaceId}/token first, legacy
 * /oauth2/token and /token as 404-tolerated fallbacks), form-encoded token
 * POSTs, token caching across pulls, candidate-path fallback with remembered
 * working paths, error naming and the secret-free call log.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { PlaneState } from '../src/planes/types';
import type { FetchLike } from '../src/planes/central';
import {
  EXPIRING_SOON_DAYS,
  GreenLakeAdapter,
  expiryDisplay,
  mapGreenLakeSubscription,
  subStatusFor,
} from '../src/planes/greenlake';

// -- Recorded fixtures (shapes as the GLP subscription APIs return them) ------

/** Fixed 'now' for mapping tests: 2026-07-25. */
const NOW = Date.parse('2026-07-25T00:00:00Z');

const SUB_ACTIVE = {
  id: 'sub-0001',
  subscription_name: 'Foundation AP',
  sku: 'R7G20AAE',
  status: 'ACTIVE',
  quantity: 180,
  assigned_count: 174,
  term_months: 36,
  start_date: '2024-09-14T00:00:00Z',
  end_date: '2027-09-14T00:00:00Z',
};

const SUB_EXPIRING = {
  subscription_name: 'Advanced AP',
  sku: 'R7G21AAE',
  status: 'ACTIVE',
  quantity: 40,
  assigned_count: 40,
  term: '3 yr subscription',
  expiration_date: '2026-09-23T00:00:00Z', // 60 days after NOW
};

const SUB_IDLE = {
  name: 'UXI sensor SUB',
  part_number: 'UXI-SUB-1Y',
  status: 'ACTIVE',
  quantity: 12,
  assigned_count: 0,
  term_months: 12,
  end_date: '2028-02-01T00:00:00Z',
};

const SUB_RETIRING = {
  name: 'Central Classic device licences',
  status: 'EXPIRED',
  quantity: 24,
  assigned: 24,
  end_date: '2026-08-12T00:00:00Z', // 18 days after NOW — retiring still wins
};

// -- Pure helpers --------------------------------------------------------------

describe('pure helpers', () => {
  it("expiryDisplay renders the month-precision style ('Mar 2027')", () => {
    expect(expiryDisplay(Date.parse('2027-03-15T10:00:00Z'))).toBe('Mar 2027');
    expect(expiryDisplay(Date.parse('2027-09-14T00:00:00Z'))).toBe('Sep 2027');
  });

  it('subStatusFor applies retiring > expiring > idle > active', () => {
    expect(subStatusFor(null, 10, 400)).toEqual({ status: 'active', tone: 'success' });
    expect(subStatusFor('ACTIVE', 10, EXPIRING_SOON_DAYS - 1)).toEqual({ status: 'expiring', tone: 'warning' });
    expect(subStatusFor('ACTIVE', 0, 400)).toEqual({ status: 'idle', tone: 'neutral' });
    expect(subStatusFor('CANCELLED', 10, 400)).toEqual({ status: 'retiring', tone: 'danger' });
    expect(subStatusFor(null, 10, -5)).toEqual({ status: 'retiring', tone: 'danger' }); // date already past
    // precedence: a retiring row stays retiring even when idle + expiring too
    expect(subStatusFor('EXPIRED', 0, 30)).toEqual({ status: 'retiring', tone: 'danger' });
  });
});

// -- Row mapping -----------------------------------------------------------------

describe('mapGreenLakeSubscription', () => {
  it('maps a full subscription row with metric hints', () => {
    const s = mapGreenLakeSubscription(SUB_ACTIVE, NOW);
    expect(s).not.toBeNull();
    expect(s!.name).toBe('Foundation AP');
    expect(s!.sku).toBe('R7G20AAE');
    expect(s!.plane).toBe('GREENLAKE');
    expect(s!.planeTone).toBe('accent');
    expect(s!.term).toBe('3 yr subscription'); // derived from term_months
    expect(s!.qty).toBe('180');
    expect(s!.assigned).toBe('174');
    expect(s!.pct).toBe('97%');
    expect(s!.expires).toBe('Sep 2027');
    expect(s!.status).toBe('active');
    expect(s!.tone).toBe('success');
    expect(s!.expiresAtMs).toBe(Date.parse(SUB_ACTIVE.end_date));
    expect(s!.daysLeft).toBe(Math.floor((Date.parse(SUB_ACTIVE.end_date) - NOW) / 86_400_000));
    expect(s!.qtyValue).toBe(180);
    expect(s!.assignedValue).toBe(174);
  });

  it('flags <90d rows as expiring/warning and passes a reported term through', () => {
    const s = mapGreenLakeSubscription(SUB_EXPIRING, NOW);
    expect(s!.status).toBe('expiring');
    expect(s!.tone).toBe('warning');
    expect(s!.daysLeft).toBe(60);
    expect(s!.term).toBe('3 yr subscription');
    expect(s!.pct).toBe('100%');
  });

  it('flags 0-assigned rows as idle/neutral', () => {
    const s = mapGreenLakeSubscription(SUB_IDLE, NOW);
    expect(s!.status).toBe('idle');
    expect(s!.tone).toBe('neutral');
    expect(s!.assigned).toBe('0');
    expect(s!.pct).toBe('0%');
    expect(s!.sku).toBe('UXI-SUB-1Y'); // part_number fallback
  });

  it('an expired raw status maps to retiring/danger even with days left', () => {
    const s = mapGreenLakeSubscription(SUB_RETIRING, NOW);
    expect(s!.status).toBe('retiring');
    expect(s!.tone).toBe('danger');
    expect(s!.assigned).toBe('24'); // 'assigned' key variant
  });

  it('derives assigned from an assignments array when no count is reported', () => {
    const s = mapGreenLakeSubscription(
      { name: 'Foundation Switch', quantity: 10, assignments: [{ device: 'sw-1' }, { device: 'sw-2' }] },
      NOW,
    );
    expect(s!.assigned).toBe('2');
    expect(s!.assignedValue).toBe(2);
    expect(s!.pct).toBe('20%');
  });

  it('derives the term from start/end dates when nothing else is reported', () => {
    const threeYr = mapGreenLakeSubscription(
      { name: 'A', start_date: '2024-01-01T00:00:00Z', end_date: '2027-01-01T00:00:00Z' },
      NOW,
    );
    expect(threeYr!.term).toBe('3 yr subscription');
    const short = mapGreenLakeSubscription(
      { name: 'B', start_date: '2026-01-01T00:00:00Z', end_date: '2026-07-01T00:00:00Z' },
      NOW,
    );
    expect(short!.term).toBe('<1 yr subscription');
  });

  it('tolerates a sparse row: name only, everything else honest defaults', () => {
    const s = mapGreenLakeSubscription({ product_name: 'Bare minimum' }, NOW);
    expect(s).not.toBeNull();
    expect(s!.name).toBe('Bare minimum');
    expect(s!.sku).toBe('—');
    expect(s!.qty).toBe('—');
    expect(s!.assigned).toBe('—');
    expect(s!.pct).toBe('—');
    expect(s!.expires).toBe('—');
    expect(s!.term).toBe('—');
    expect(s!.status).toBe('active');
    expect(s!.expiresAtMs).toBeUndefined();
    expect(s!.qtyValue).toBeUndefined();
  });

  it('returns null for junk rows', () => {
    expect(mapGreenLakeSubscription(null, NOW)).toBeNull();
    expect(mapGreenLakeSubscription({ sku: 'R7G20AAE' }, NOW)).toBeNull(); // no name at all
  });
});

// -- pull() with an in-memory fake fetch (no network) ----------------------------

type HandlerResult = { status?: number; body?: unknown };
type Handler = (method: string, pathname: string, query: URLSearchParams) => HandlerResult | undefined;

function fakeFetch(handler: Handler): { fn: FetchLike; calls: string[]; tokenInits: RequestInit[] } {
  const calls: string[] = [];
  const tokenInits: RequestInit[] = [];
  const fn: FetchLike = async (url, init) => {
    const u = new URL(url);
    const method = (init?.method as string | undefined) ?? 'GET';
    calls.push(`${method} ${u.pathname}${u.search}`);
    if (method === 'POST' && u.pathname.includes('token')) tokenInits.push(init ?? {});
    const result = handler(method, u.pathname, u.searchParams);
    if (!result) {
      return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify(result.body ?? {}), {
      status: result.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fn, calls, tokenInits };
}

function makeState(): PlaneState {
  return { id: 'greenlake', linked: true, health: 'warning', lastSync: null, deviceCount: null, callsToday: 0, note: null };
}

const CREDS = { workspaceId: 'ws-1', clientId: 'id-1', clientSecret: 'shh-gl-secret' };

function makeAdapter(handler: Handler) {
  const { fn, calls, tokenInits } = fakeFetch(handler);
  const recorded: { path: string; ms: number; code: string }[] = [];
  const state = makeState();
  const adapter = new GreenLakeAdapter(CREDS, state, (c) => recorded.push(c), fn);
  return { adapter, state, recorded, calls, tokenInits };
}

const TOKEN_PATH = '/authorization/v2/oauth2/ws-1/token';

const HAPPY_ROUTES: Record<string, unknown> = {
  [`POST ${TOKEN_PATH}`]: { access_token: 'gl-tok-1', expires_in: 7200 },
  'GET /subscriptions/v1/subscriptions': { subscriptions: [SUB_ACTIVE, SUB_EXPIRING, SUB_IDLE, SUB_RETIRING], total: 4 },
};

function routeHandler(routes: Record<string, unknown>): Handler {
  return (method, pathname) => {
    const body = routes[`${method} ${pathname}`];
    return body === undefined ? undefined : { body };
  };
}

describe('GreenLakeAdapter.pull()', () => {
  it('pulls subscriptions, maps them, and reports the summary note', async () => {
    const { adapter, state, recorded, calls } = makeAdapter(routeHandler(HAPPY_ROUTES));
    const pull = await adapter.pull();
    expect(pull.subscriptions).toHaveLength(4);
    expect(pull.subscriptions![0].name).toBe('Foundation AP');
    expect(pull.subscriptions!.map((s) => s.status)).toEqual(['active', 'expiring', 'idle', 'retiring']);
    expect(state.note).toBe('4 subscriptions · 1 expiring < 90d');
    expect(state.health).toBe('healthy'); // promoted from 'warning' on first success
    // the workspace scoping query is on the wire
    expect(calls.some((c) => c.includes('workspace_id=ws-1'))).toBe(true);
    // secrets never appear in the recorded call log
    expect(JSON.stringify(recorded)).not.toContain('shh-gl-secret');
    expect(recorded.some((c) => c.path === `POST ${TOKEN_PATH}` && c.code === '200')).toBe(true);
  });

  it('auths against the documented workspace-scoped door, form-encoded', async () => {
    const { adapter, tokenInits } = makeAdapter(routeHandler(HAPPY_ROUTES));
    await adapter.pull();
    expect(tokenInits).toHaveLength(1);
    const headers = tokenInits[0].headers as Record<string, string>;
    expect(headers['content-type']).toBe('application/x-www-form-urlencoded');
    const body = String(tokenInits[0].body);
    expect(body).toContain('grant_type=client_credentials');
    expect(body).toContain('client_id=id-1');
    expect(body).toContain('client_secret=shh-gl-secret');
  });

  it('caches the token across pulls (one token fetch for two pulls)', async () => {
    const { adapter, calls } = makeAdapter(routeHandler(HAPPY_ROUTES));
    await adapter.pull();
    await adapter.pull();
    expect(calls.filter((c) => c.startsWith(`POST ${TOKEN_PATH}`))).toHaveLength(1);
  });

  it('falls back through the legacy doors on 404 and remembers the working one', async () => {
    const routes = { ...HAPPY_ROUTES };
    delete routes[`POST ${TOKEN_PATH}`];
    delete routes['POST /oauth2/token'];
    routes['POST /token'] = { access_token: 'legacy-tok', expires_in: 7200 };
    const { adapter, calls } = makeAdapter(routeHandler(routes));
    await adapter.pull();
    await adapter.pull(); // cached token — no second round of token POSTs
    expect(calls.filter((c) => c.startsWith(`POST ${TOKEN_PATH}`))).toHaveLength(1); // tried once, 404
    expect(calls.filter((c) => c.startsWith('POST /oauth2/token'))).toHaveLength(1); // tried once, 404
    expect(calls.filter((c) => c.startsWith('POST /token'))).toHaveLength(1); // fallback worked
  });

  it('falls back to /oauth2/token alone when only the documented door 404s', async () => {
    const routes = { ...HAPPY_ROUTES };
    delete routes[`POST ${TOKEN_PATH}`];
    routes['POST /oauth2/token'] = { access_token: 'legacy-tok-2', expires_in: 7200 };
    const { adapter, calls } = makeAdapter(routeHandler(routes));
    const pull = await adapter.pull();
    expect(pull.subscriptions).toHaveLength(4);
    expect(calls.some((c) => c.startsWith('POST /oauth2/token'))).toBe(true);
    expect(calls.some((c) => c.startsWith('POST /token'))).toBe(false); // never reached
  });

  it('fails the pull when no token endpoint answers', async () => {
    const routes = { ...HAPPY_ROUTES };
    delete routes[`POST ${TOKEN_PATH}`];
    const { adapter } = makeAdapter(routeHandler(routes));
    await expect(adapter.pull()).rejects.toThrow(/token endpoint answered HTTP 404/);
  });

  it('prefers the subscriptions payload key over an incidental array', async () => {
    // `{errors: [], subscriptions: [...]}` — the first-array heuristic alone would zero the section.
    const routes = { ...HAPPY_ROUTES, 'GET /subscriptions/v1/subscriptions': { errors: [], subscriptions: [SUB_ACTIVE], total: 1 } };
    const { adapter } = makeAdapter(routeHandler(routes));
    const pull = await adapter.pull();
    expect(pull.subscriptions).toHaveLength(1);
    expect(pull.subscriptions![0].name).toBe('Foundation AP');
  });

  it('tolerates a 404 candidate and remembers the working path', async () => {
    const routes = { ...HAPPY_ROUTES };
    delete routes['GET /subscriptions/v1/subscriptions'];
    routes['GET /subscription-manager/v1/subscriptions'] = { subscriptions: [SUB_ACTIVE] };
    const { adapter, calls } = makeAdapter(routeHandler(routes));
    const pull = await adapter.pull();
    expect(pull.subscriptions).toHaveLength(1);
    expect(calls.some((c) => c.startsWith('GET /subscriptions/v1/subscriptions'))).toBe(true); // tried, 404

    await adapter.pull(); // resolved path goes first — the dead candidate is not retried
    expect(calls.filter((c) => c.startsWith('GET /subscriptions/v1/subscriptions'))).toHaveLength(1);
    expect(calls.filter((c) => c.startsWith('GET /subscription-manager/v1/subscriptions'))).toHaveLength(2);
  });

  it('fails the pull naming the section when every candidate 404s', async () => {
    const routes = { ...HAPPY_ROUTES };
    delete routes['GET /subscriptions/v1/subscriptions'];
    const { adapter } = makeAdapter(routeHandler(routes));
    await expect(adapter.pull()).rejects.toThrow(/section 'subscriptions' failed/);
    await expect(adapter.pull()).rejects.toThrow(/404 on every candidate/);
  });

  it('fails the pull naming the section on a non-404 error', async () => {
    const { adapter } = makeAdapter((method, pathname) => {
      if (method === 'GET' && pathname === '/subscriptions/v1/subscriptions') {
        return { status: 500, body: { error: 'boom' } };
      }
      const body = HAPPY_ROUTES[`${method} ${pathname}`];
      return body === undefined ? undefined : { body };
    });
    await expect(adapter.pull()).rejects.toThrow(/section 'subscriptions' failed — HTTP 500/);
  });

  it('retries once with a fresh token on 401', async () => {
    let tokenFetches = 0;
    let subs401 = true;
    const { adapter } = makeAdapter((method, pathname) => {
      if (method === 'POST' && pathname === TOKEN_PATH) {
        tokenFetches += 1;
        return { body: { access_token: `gl-tok-${tokenFetches}`, expires_in: 7200 } };
      }
      if (method === 'GET' && pathname === '/subscriptions/v1/subscriptions' && subs401) {
        subs401 = false;
        return { status: 401, body: { error: 'expired' } };
      }
      const body = HAPPY_ROUTES[`${method} ${pathname}`];
      return body === undefined ? undefined : { body };
    });
    const pull = await adapter.pull();
    expect(pull.subscriptions).toHaveLength(4);
    expect(tokenFetches).toBe(2);
  });
});

// -- Registry wiring ---------------------------------------------------------------

describe('registry wiring', () => {
  it('builds the real GreenLakeAdapter when credentials are complete', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'hpe-greenlake-'));
    process.env.HPE_SETTINGS_PATH = join(tmpDir, 'settings.json');
    try {
      const { SettingsStore } = await import('../src/config/settings');
      const { PlaneRegistry } = await import('../src/planes/registry');
      const store = new SettingsStore();
      store.update({ planes: { greenlake: { workspaceId: 'ws-1', clientId: 'id-1', clientSecret: 'shh' } } });
      const reg = new PlaneRegistry(store);
      expect(reg.get('greenlake')).toBeInstanceOf(GreenLakeAdapter);
      const state = reg.state('greenlake');
      expect(state.linked).toBe(true);
      expect(state.health).toBe('warning');
      expect(state.note).toBe('credentials saved — first sync pending');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
      delete process.env.HPE_SETTINGS_PATH;
    }
  });
});
