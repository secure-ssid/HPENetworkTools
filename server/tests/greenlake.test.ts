/**
 * server/tests/greenlake.test.ts — GreenLake adapter unit tests, NO network.
 *
 * The mapping helpers are tested against recorded GLP-style subscription JSON
 * inlined here — both the flat snake_case shapes and the camelCase/nested
 * shapes a live workspace actually returns (v1 skuDescription/availableQuantity/
 * endTime, v1alpha1 productDescription/appointment); GreenLakeAdapter.pull() is
 * exercised end-to-end (including offset/limit paging of the real
 * `{items, count, offset, total}` envelope) with an
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

/**
 * Recorded verbatim from a live GLP v1 /subscriptions/v1/subscriptions row
 * (identifiers redacted): camelCase throughout, counts as strings, no name
 * field at all (skuDescription is the only human label), startTime/endTime
 * rather than *_date, and only the complement of the assigned count.
 */
const SUB_GLP_V1 = {
  id: '05975b22-564f-5f0b-bd47-f8cdbcde9c74',
  type: 'subscriptions/subscription',
  subscriptionType: 'CENTRAL_SWITCH',
  createdAt: '2026-03-16T07:02:48.206Z',
  updatedAt: '2026-03-16T07:02:48.207Z',
  key: 'K1B2C3D4E5F6A7B8C9',
  quantity: '5',
  availableQuantity: '2',
  isEval: true,
  sku: 'JZ540-EVALS',
  skuDescription: 'Aruba Central 8/9/10xxx A EVAL',
  startTime: '2026-03-16T00:00:00.000Z',
  endTime: '2027-08-03T00:00:00.000Z',
  subscriptionStatus: 'STARTED',
  tags: {},
  productType: 'DEVICE',
  tier: 'ADVANCED_SWITCH_8XXX_9XXX_10XXX',
  tierDescription: 'Advanced-Switch-Class-5',
};

/** The v1alpha1 spelling of the same endpoint: nested product + appointment. */
const SUB_GLP_V1ALPHA1 = {
  id: 'sub-v1alpha1',
  subscriptionKey: 'K9Z8Y7X6W5V4U3T2S1',
  productDescription: 'Advanced AP Subscription',
  productSku: 'R7G21AAE',
  quantity: 200,
  availableQuantity: 24,
  subscriptionStatus: 'ACTIVE',
  appointment: { subscriptionStart: '2024-06-01T00:00:00Z', subscriptionEnd: '2026-09-23T00:00:00Z' },
};

// -- Pure helpers --------------------------------------------------------------

describe('pure helpers', () => {
  // The design and the fixtures render '14 Sep 26', and blend mode puts live
  // and fixture rows in ONE table — month precision both drifted from the
  // reference and hid the difference between the 2nd and the 29th.
  it("expiryDisplay renders the design's day-precision style ('14 Sep 26')", () => {
    expect(expiryDisplay(Date.parse('2027-03-15T10:00:00Z'))).toBe('15 Mar 27');
    expect(expiryDisplay(Date.parse('2026-09-14T00:00:00Z'))).toBe('14 Sep 26');
    expect(expiryDisplay(Date.parse('2026-09-02T00:00:00Z'))).toBe('02 Sep 26');
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
    expect(s!.sku).toBe('R7G20AAE · greenlake'); // the fixtures' '<key> · <plane>' convention
    expect(s!.plane).toBe('GREENLAKE');
    expect(s!.planeTone).toBe('accent');
    expect(s!.term).toBe('3 yr subscription'); // derived from term_months
    expect(s!.qty).toBe('180');
    expect(s!.assigned).toBe('174');
    expect(s!.pct).toBe('97%');
    expect(s!.expires).toBe('14 Sep 27');
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
    expect(s!.sku).toBe('UXI-SUB-1Y · greenlake'); // part_number fallback
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

  it('maps a real camelCase GLP v1 row (no *_name key anywhere)', () => {
    const s = mapGreenLakeSubscription(SUB_GLP_V1, NOW);
    expect(s).not.toBeNull(); // the whole workspace used to be dropped here
    expect(s!.name).toBe('Aruba Central 8/9/10xxx A EVAL'); // skuDescription
    expect(s!.sku).toBe('JZ540-EVALS · greenlake');
    expect(s!.qty).toBe('5'); // string '5' coerced
    expect(s!.assigned).toBe('3'); // quantity − availableQuantity
    expect(s!.pct).toBe('60%');
    expect(s!.expires).toBe('03 Aug 27'); // endTime
    expect(s!.expiresAtMs).toBe(Date.parse(SUB_GLP_V1.endTime));
    expect(s!.daysLeft).toBe(Math.floor((Date.parse(SUB_GLP_V1.endTime) - NOW) / 86_400_000));
    expect(s!.qtyValue).toBe(5);
    expect(s!.assignedValue).toBe(3);
    expect(s!.term).toBe('1 yr subscription'); // derived from startTime/endTime
    expect(s!.status).toBe('active');
  });

  it('maps the v1alpha1 spelling (productDescription + appointment dates)', () => {
    const s = mapGreenLakeSubscription(SUB_GLP_V1ALPHA1, NOW);
    expect(s!.name).toBe('Advanced AP Subscription');
    expect(s!.sku).toBe('R7G21AAE · greenlake'); // productSku
    expect(s!.assigned).toBe('176'); // 200 − 24
    expect(s!.pct).toBe('88%');
    expect(s!.expires).toBe('23 Sep 26'); // appointment.subscriptionEnd
    expect(s!.daysLeft).toBe(60);
    expect(s!.status).toBe('expiring'); // < 90d — dead before the dates were read
    expect(s!.term).toBe('2 yr subscription'); // derived from the appointment span
  });

  it('a fully consumed GLP row reports 100% rather than an unknown', () => {
    const s = mapGreenLakeSubscription({ ...SUB_GLP_V1, availableQuantity: '0' }, NOW);
    expect(s!.assigned).toBe('5');
    expect(s!.pct).toBe('100%');
  });

  it('an unused GLP row is idle, and a reported count beats the complement', () => {
    const idle = mapGreenLakeSubscription({ ...SUB_GLP_V1, availableQuantity: '5' }, NOW);
    expect(idle!.assigned).toBe('0');
    expect(idle!.status).toBe('idle');
    // a directly reported count wins over the quantity − availableQuantity path
    const direct = mapGreenLakeSubscription({ ...SUB_GLP_V1, assignedQuantity: 4 }, NOW);
    expect(direct!.assigned).toBe('4');
  });

  it("GLP subscriptionStatus 'ENDED' retires the row; 'EXTENDED' does not", () => {
    const ended = mapGreenLakeSubscription({ ...SUB_GLP_V1, subscriptionStatus: 'ENDED' }, NOW);
    expect(ended!.status).toBe('retiring');
    expect(ended!.tone).toBe('danger');
    const extended = mapGreenLakeSubscription({ ...SUB_GLP_V1, subscriptionStatus: 'EXTENDED' }, NOW);
    expect(extended!.status).toBe('active');
  });
});

// -- pull() with an in-memory fake fetch (no network) ----------------------------

type HandlerResult = { status?: number; body?: unknown; headers?: Record<string, string> };
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
      headers: { 'content-type': 'application/json', ...(result.headers ?? {}) },
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
  // Backoff delays are captured, never paid in wall time.
  const slept: number[] = [];
  const adapter = new GreenLakeAdapter(CREDS, state, (c) => recorded.push(c), fn, async (ms) => {
    slept.push(ms);
  });
  return { adapter, state, recorded, calls, tokenInits, slept };
}

const TOKEN_PATH = '/authorization/v2/oauth2/ws-1/token';

/**
 * A GLP device row exactly as the live /devices/v1/devices envelope carries
 * it: the device→entitlement join the Licences screen counts 'unlicensed' from.
 */
const DEVICE_ASSIGNED = {
  id: 'dev-1',
  serialNumber: 'SG01ABC123',
  macAddress: '9c:8e:99:1a:2b:3c',
  model: 'AP-635',
  deviceType: 'AP',
  deviceName: 'ap-3f-12',
  archived: false,
  assignedState: 'ASSIGNED_TO_SERVICE',
  subscription: [{ key: 'K1B2C3D4E5F6A7B8C9', tierDescription: 'Advanced-AP', endTime: '2027-08-03T00:00:00.000Z' }],
};
const DEVICE_UNASSIGNED = {
  id: 'dev-2',
  serialNumber: 'SG01ABC124',
  model: 'CX-6300',
  deviceType: 'SWITCH',
  archived: false,
  assignedState: 'UNASSIGNED',
  subscription: null,
};

const HAPPY_ROUTES: Record<string, unknown> = {
  [`POST ${TOKEN_PATH}`]: { access_token: 'gl-tok-1', expires_in: 7200 },
  'GET /subscriptions/v1/subscriptions': { subscriptions: [SUB_ACTIVE, SUB_EXPIRING, SUB_IDLE, SUB_RETIRING], total: 4 },
  'GET /devices/v1/devices': { items: [DEVICE_ASSIGNED, DEVICE_UNASSIGNED], count: 2, offset: 0, total: 2 },
};

function routeHandler(routes: Record<string, unknown>): Handler {
  return (method, pathname) => {
    const body = routes[`${method} ${pathname}`];
    return body === undefined ? undefined : { body };
  };
}

/** Serves `rows` through the real GLP envelope, honouring offset/limit. */
function pagingHandler(rows: unknown[]): Handler {
  return (method, pathname, query) => {
    if (method === 'POST' && pathname === TOKEN_PATH) return { body: { access_token: 'gl-tok-1', expires_in: 7200 } };
    if (method === 'GET' && pathname === '/devices/v1/devices') {
      return { body: { items: [DEVICE_ASSIGNED, DEVICE_UNASSIGNED], count: 2, offset: 0, total: 2 } };
    }
    if (method === 'GET' && pathname === '/subscriptions/v1/subscriptions') {
      const offset = Number(query.get('offset') ?? '0');
      const limit = Number(query.get('limit') ?? '100');
      const items = rows.slice(offset, offset + limit);
      return { body: { items, errors: [], count: items.length, offset, total: rows.length } };
    }
    return undefined;
  };
}

describe('GreenLakeAdapter.pull()', () => {
  it('pulls subscriptions, maps them, and reports the summary note', async () => {
    const { adapter, state, recorded, calls } = makeAdapter(routeHandler(HAPPY_ROUTES));
    const pull = await adapter.pull();
    expect(pull.subscriptions).toHaveLength(4);
    expect(pull.subscriptions![0].name).toBe('Foundation AP');
    expect(pull.subscriptions!.map((s) => s.status)).toEqual(['active', 'expiring', 'idle', 'retiring']);
    expect(state.note).toBe('4 subscriptions · 1 expiring < 90d · 2 devices · 1 unlicensed');
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

  it('pages the real GLP envelope until total, merging every page', async () => {
    const rows = Array.from({ length: 250 }, (_, i) => ({ ...SUB_GLP_V1, id: `sub-${i}`, key: `KEY-${i}` }));
    const { adapter, calls, state } = makeAdapter(pagingHandler(rows));
    const pull = await adapter.pull();
    expect(pull.subscriptions).toHaveLength(250); // page 1 alone would have been 100
    expect(state.note).toBe('250 subscriptions · 0 expiring < 90d · 2 devices · 1 unlicensed');
    const subsCalls = calls.filter((c) => c.startsWith('GET /subscriptions/v1/subscriptions'));
    expect(subsCalls).toHaveLength(3);
    expect(subsCalls[0]).toContain('offset=0&limit=100');
    expect(subsCalls[0]).toContain('workspace_id=ws-1'); // scoping survives paging
    expect(subsCalls[1]).toContain('offset=100&limit=100');
    expect(subsCalls[2]).toContain('offset=200&limit=100');
  });

  it('stops on a short page without asking for one past the end', async () => {
    const rows = Array.from({ length: 40 }, (_, i) => ({ ...SUB_GLP_V1, id: `sub-${i}`, key: `KEY-${i}` }));
    const { adapter, calls } = makeAdapter(pagingHandler(rows));
    const pull = await adapter.pull();
    expect(pull.subscriptions).toHaveLength(40);
    expect(calls.filter((c) => c.startsWith('GET /subscriptions/v1/subscriptions'))).toHaveLength(1);
  });

  it('declares a page-capped read partial rather than asserting the count', async () => {
    const rows = Array.from({ length: 2600 }, (_, i) => ({ ...SUB_GLP_V1, id: `sub-${i}`, key: `KEY-${i}` }));
    const { adapter, state } = makeAdapter(pagingHandler(rows));
    const pull = await adapter.pull();
    expect(pull.subscriptions).toHaveLength(2500); // 25 pages × 100
    expect(state.note).toBe('2,500 subscriptions · 0 expiring < 90d · partial (page cap 25) · 2 devices · 1 unlicensed');
  });

  // The device→entitlement join: without it the Licences screen can only
  // guess at 'Devices unlicensed', and orphan/gap rows have no source.
  it('reads the assignments feed and maps the device→subscription join', async () => {
    const { adapter } = makeAdapter(routeHandler(HAPPY_ROUTES));
    const pull = await adapter.pull();
    expect(pull.assignments).toHaveLength(2);
    expect(pull.assignments![0]).toMatchObject({
      serial: 'SG01ABC123',
      mac: '9c:8e:99:1a:2b:3c',
      deviceName: 'ap-3f-12',
      deviceType: 'AP',
      assigned: true,
      subscriptionKey: 'K1B2C3D4E5F6A7B8C9',
      subscriptionTier: 'Advanced-AP',
      archived: false,
    });
    // 'UNASSIGNED' contains 'assigned' — the negative has to win, or every
    // unlicensed device reads as licensed.
    expect(pull.assignments![1]).toMatchObject({ serial: 'SG01ABC124', assigned: false, subscriptionKey: null });
    expect(pull.partial).toBeUndefined();
  });

  it('refreshes the assignments feed on a slower cadence than the subscriptions', async () => {
    const { adapter, calls } = makeAdapter(routeHandler(HAPPY_ROUTES));
    await adapter.pull();
    await adapter.pull();
    expect(calls.filter((c) => c.startsWith('GET /subscriptions/v1/subscriptions'))).toHaveLength(2);
    expect(calls.filter((c) => c.startsWith('GET /devices/v1/devices'))).toHaveLength(1);
  });

  // An unread feed must never look like 'no unlicensed devices' — the pull
  // says which dataset it could not read and the licence pull still lands.
  it('declares the pull partial when the assignments feed cannot be read', async () => {
    const routes = { ...HAPPY_ROUTES };
    delete routes['GET /devices/v1/devices'];
    const { adapter, state } = makeAdapter(routeHandler(routes));
    const pull = await adapter.pull();
    expect(pull.subscriptions).toHaveLength(4); // the licence feed still lands
    expect(pull.assignments).toBeUndefined();
    expect(pull.partial).toEqual(['assignments']);
    expect(state.note).toContain('assignments unavailable');
  });

  // A workspace whose devices endpoint does not exist must not be probed once
  // a minute forever: the cadence gates attempts, not successes.
  it('does not re-probe a missing assignments endpoint every poll', async () => {
    const routes = { ...HAPPY_ROUTES };
    delete routes['GET /devices/v1/devices'];
    const { adapter, calls } = makeAdapter(routeHandler(routes));
    await adapter.pull();
    await adapter.pull();
    expect(calls.filter((c) => c.startsWith('GET /devices/v1/devices'))).toHaveLength(1);
  });

  // 34 real subscriptions that all map to null used to publish as a healthy
  // '0 subscriptions' — an operator reading 'this workspace owns nothing'.
  it('fails the pull when rows came back but none could be mapped', async () => {
    const routes = {
      ...HAPPY_ROUTES,
      'GET /subscriptions/v1/subscriptions': { subscriptions: [{ sku: 'R7G20AAE' }, { sku: 'R7G21AAE' }], total: 2 },
    };
    const { adapter, state } = makeAdapter(routeHandler(routes));
    await expect(adapter.pull()).rejects.toThrow(/2 rows returned but none could be mapped/);
    expect(state.health).not.toBe('healthy');
  });

  it('keeps a partly-readable page but names the rows it dropped', async () => {
    const routes = {
      ...HAPPY_ROUTES,
      'GET /subscriptions/v1/subscriptions': { subscriptions: [SUB_ACTIVE, { sku: 'no-name-anywhere' }], total: 2 },
    };
    const { adapter, state } = makeAdapter(routeHandler(routes));
    const pull = await adapter.pull();
    expect(pull.subscriptions).toHaveLength(1);
    expect(state.note).toContain('1 rows unmapped');
  });

  it('leaves a genuinely empty workspace as an honest zero', async () => {
    const routes = { ...HAPPY_ROUTES, 'GET /subscriptions/v1/subscriptions': { subscriptions: [], total: 0 } };
    const { adapter, state } = makeAdapter(routeHandler(routes));
    const pull = await adapter.pull();
    expect(pull.subscriptions).toEqual([]);
    expect(state.health).toBe('healthy');
  });

  it('backs off and retries a 429, honouring Retry-After', async () => {
    let throttled = 0;
    const { adapter, state, slept } = makeAdapter((method, pathname) => {
      if (method === 'GET' && pathname === '/subscriptions/v1/subscriptions') {
        throttled += 1;
        if (throttled === 1) return { status: 429, body: {}, headers: { 'retry-after': '4' } };
      }
      const body = HAPPY_ROUTES[`${method} ${pathname}`];
      return body === undefined ? undefined : { body };
    });
    const pull = await adapter.pull();
    expect(pull.subscriptions).toHaveLength(4);
    expect(slept).toEqual([4_000]);
    expect(state.health).toBe('healthy'); // a survivable throttle is not a degraded plane
  });

  it('names rate limiting when the throttle outlives the backoff', async () => {
    const { adapter, slept } = makeAdapter((method, pathname) => {
      if (method === 'GET' && pathname === '/subscriptions/v1/subscriptions') return { status: 429, body: {} };
      const body = HAPPY_ROUTES[`${method} ${pathname}`];
      return body === undefined ? undefined : { body };
    });
    await expect(adapter.pull()).rejects.toThrow(/rate limited, backoff exhausted/);
    expect(slept).toEqual([1_000, 2_000]);
  });

  it('claims no shell, no brokered write and no config read', () => {
    const { adapter } = makeAdapter(routeHandler(HAPPY_ROUTES));
    expect(adapter.capabilities()).toEqual({ localShell: false, brokeredWrite: false, configRead: false });
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
