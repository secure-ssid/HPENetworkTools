/**
 * server/tests/greenlakeObjects.test.ts — GreenLakeObjectsService unit tests.
 *
 * Service-level, mirroring sseObjects.test.ts: every instantiation injects a
 * `plane` override (a real GreenLakeAdapter over an in-memory fake fetch) plus
 * a duck-typed fake registry/poller, so this file exercises the action
 * allowlist, the "not linked" 409, the pre-sync inventory honesty rule, the
 * review gate, the write-scope gate, the applied/accepted distinction, the 4xx
 * translation and the audit log — WITHOUT the process-wide singletons.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PlaneState } from '../src/planes/types';
import { GreenLakeAdapter, type FetchLike } from '../src/planes/greenlake';
import { GreenLakeObjectsError, GreenLakeObjectsService } from '../src/services/greenlakeObjects';
import type { PlaneRegistry } from '../src/planes/registry';
import type { Poller } from '../src/services/poller';

type HandlerResult = { status?: number; body?: unknown };
type Handler = (method: string, pathname: string, body: unknown) => HandlerResult | undefined;

const TOKEN_PATH = '/authorization/v2/oauth2/ws-1/token';

function fakeFetch(handler: Handler): FetchLike {
  return async (url, init) => {
    const u = new URL(url);
    const method = (init?.method as string | undefined) ?? 'GET';
    if (method === 'POST' && u.pathname === TOKEN_PATH) {
      return new Response(JSON.stringify({ access_token: 'gl-tok', expires_in: 7200 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    const parsed = init?.body ? JSON.parse(String(init.body)) : null;
    const result = handler(method, u.pathname, parsed);
    if (!result) return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify(result.body ?? {}), {
      status: result.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  };
}

/** `scopes` is the operator-declared string the directWrite gate reads. */
function makeGlAdapter(handler: Handler, scopes = 'read:inventory,write:brokered'): GreenLakeAdapter {
  const state: PlaneState = {
    id: 'greenlake',
    linked: true,
    health: 'healthy',
    lastSync: null,
    deviceCount: null,
    callsToday: 0,
    note: null,
  };
  return new GreenLakeAdapter(
    { workspaceId: 'ws-1', clientId: 'id-1', clientSecret: 'shh-gl-secret', scopes },
    state,
    () => {},
    fakeFetch(handler),
  );
}

function fakeRegistry(): PlaneRegistry {
  return {
    get: () => {
      throw new Error('service must use the injected `plane` override, never the registry');
    },
    recordEvent: () => {},
  } as unknown as PlaneRegistry;
}

/** A poller that answers a forced pull but contributes no greenlake section —
 *  i.e. the cache is left exactly as stale as it was. */
const emptyPoller = {
  contributionsByPlane: () => new Map(),
  syncNowFor: async () => 'ok',
} as unknown as Poller;

/** A poller whose forced pull lands and contributes a greenlake section. */
function refreshingPoller(tick: string = 'ok'): Poller {
  return {
    contributionsByPlane: () =>
      new Map([
        [
          'greenlake',
          {
            greenlake: {
              users: [],
              locations: [],
              roleAssignments: [],
              unavailable: [],
              readStatus: {},
              source: 'test',
            },
          },
        ],
      ]),
    syncNowFor: async () => tick,
  } as unknown as Poller;
}

/**
 * Every field GLP validates as required on a location create — including the
 * full country name and the primary contact, both of which the live workspace
 * rejects the request without.
 */
const LOCATION_INPUT = {
  name: 'Campus-01',
  streetAddress: '1 Example Way',
  city: 'Houston',
  state: 'TX',
  postalCode: '77001',
  country: 'United States',
  contactName: 'ops@example.com',
  contactEmail: 'ops@example.com',
  contactPhone: '+15550000000',
};

let tmpDir: string;
beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'hpe-gl-objects-'));
});
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeService(
  opts: { plane?: GreenLakeAdapter | null; pollerRef?: Poller; allowsLabDirectWrites?: () => boolean } = {},
) {
  return new GreenLakeObjectsService({
    registry: fakeRegistry(),
    pollerRef: opts.pollerRef ?? emptyPoller,
    plane: opts.plane === undefined ? makeGlAdapter(() => ({ status: 500 })) : opts.plane,
    dataDir: tmpDir,
    allowsLabDirectWrites: opts.allowsLabDirectWrites,
  });
}

function auditLines(): Record<string, unknown>[] {
  const raw = readFileSync(join(tmpDir, 'change-log.jsonl'), 'utf8').trim();
  return raw ? raw.split('\n').map((l) => JSON.parse(l) as Record<string, unknown>) : [];
}

describe('GreenLakeObjectsService.assertAction', () => {
  it('refuses an action outside the allowlist with a 404', () => {
    expect(() => GreenLakeObjectsService.assertAction('deleteWorkspace')).toThrow(GreenLakeObjectsError);
    try {
      GreenLakeObjectsService.assertAction('deleteWorkspace');
    } catch (err) {
      expect((err as GreenLakeObjectsError).status).toBe(404);
    }
    expect(GreenLakeObjectsService.assertAction('createLocation')).toBe('createLocation');
  });
});

describe('GreenLakeObjectsService.inventory', () => {
  it('serves the poller cache, never a live call', () => {
    // Any live call under this adapter would 500 — the read must not make one.
    const pollerRef = {
      contributionsByPlane: () =>
        new Map([
          [
            'greenlake',
            {
              greenlake: {
                users: [{ id: 'u-1', username: 'a@b.com', firstName: null, lastName: null, status: 'VERIFIED', lastLogin: null, createdAt: null, roles: [] }],
                locations: [],
                roleAssignments: [],
                unavailable: ['locations'],
                readStatus: { locations: { state: 'failed', reason: 'denied', message: 'HTTP 403' } },
                source: 'test',
              },
            },
          ],
        ]),
    } as unknown as Poller;
    const inv = makeService({ pollerRef }).inventory();
    expect(inv.users).toHaveLength(1);
    expect(inv.unavailable).toEqual(['locations']);
  });

  // The honesty rule at its sharpest: before the first poll the service knows
  // nothing, and 'nothing known' must not render as 'this workspace is empty'.
  it('reports every section unavailable before the first sync, not empty', () => {
    const inv = makeService().inventory();
    expect(inv.users).toEqual([]);
    expect(inv.unavailable).toEqual(['users', 'locations', 'roleAssignments']);
    expect(inv.source).toContain('first sync pending');
  });

  it('is not linked → 409, distinct from "linked but empty"', () => {
    const service = makeService({ plane: null });
    expect(() => service.inventory()).toThrow(GreenLakeObjectsError);
    try {
      service.inventory();
    } catch (err) {
      expect((err as GreenLakeObjectsError).status).toBe(409);
      expect((err as GreenLakeObjectsError).message).toContain('not linked');
    }
  });
});

describe('GreenLakeObjectsService.write gates', () => {
  // Gate ORDER is the property, not just the outcome: if the scope gate ran
  // first, a read-only credential would leak "you are read-only" to a caller
  // who never confirmed a review, and an unconfirmed write against a writable
  // credential would be indistinguishable from one against a read-only one.
  it('applies without reviewConfirmed in lab-direct mode while preserving the write scope', async () => {
    const service = makeService({
      plane: makeGlAdapter(() => ({ body: { id: 'loc-9' } })),
      allowsLabDirectWrites: () => true,
    });
    await expect(service.write('createLocation', LOCATION_INPUT, undefined)).resolves.toMatchObject({ outcome: 'applied' });
  });

  it('refuses an unconfirmed write before consulting the write scope when hardened mode is enabled', async () => {
    let called = false;
    const adapter = makeGlAdapter(() => {
      called = true;
      return { body: {} };
    }, 'read:inventory'); // read-only — the scope gate would also refuse
    const service = makeService({ plane: adapter, allowsLabDirectWrites: () => false });
    await expect(service.write('createLocation', LOCATION_INPUT, undefined)).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining('review confirmation'),
    });
    expect(called).toBe(false);
  });

  it('rejects a truthy-but-not-true confirmation when hardened mode is enabled', async () => {
    const service = makeService({ plane: makeGlAdapter(() => ({ body: {} })), allowsLabDirectWrites: () => false });
    await expect(service.write('createLocation', LOCATION_INPUT, 'yes')).rejects.toMatchObject({ status: 400 });
    await expect(service.write('createLocation', LOCATION_INPUT, 1)).rejects.toMatchObject({ status: 400 });
  });

  it('refuses a confirmed write when no write scope is declared', async () => {
    let called = false;
    const adapter = makeGlAdapter(() => {
      called = true;
      return { body: {} };
    }, 'read:inventory,read:config-licences');
    const service = makeService({ plane: adapter });
    expect(service.canWrite()).toBe(false);
    await expect(service.write('createLocation', LOCATION_INPUT, true)).rejects.toMatchObject({
      status: 403,
      message: expect.stringContaining('read-only'),
    });
    expect(called).toBe(false);
  });

  it('canWrite follows the declared scope', () => {
    expect(makeService({ plane: makeGlAdapter(() => ({ body: {} })) }).canWrite()).toBe(true);
    expect(makeService({ plane: makeGlAdapter(() => ({ body: {} }), 'read:inventory') }).canWrite()).toBe(false);
  });
});

describe('GreenLakeObjectsService.write outcomes', () => {
  it('applies a synchronous write and audits it once', async () => {
    const service = makeService({ plane: makeGlAdapter(() => ({ body: { id: 'loc-9' } })) });
    const result = await service.write('createLocation', LOCATION_INPUT, true);
    expect(result.outcome).toBe('applied');
    const lines = auditLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ plane: 'greenlake', kind: 'greenlake:createLocation', event: 'greenlake-write' });
    expect(String(lines[0].result)).toContain('applied');
  });

  // A 202 means the workspace took the request, not that it granted it.
  it('reports an asynchronous 202 as accepted, never as applied', async () => {
    const service = makeService({
      plane: makeGlAdapter(() => ({ status: 202, body: { transactionId: 'txn-7', status: 'ACCEPTED' } })),
    });
    const result = await service.write('addSubscription', { key: 'K-1' }, true);
    expect(result.outcome).toBe('accepted');
    expect(String(auditLines()[0].result)).toContain('accepted');
  });

  /**
   * The audit trail is the durable record; the toast that carries the same
   * handle is gone in seconds. An `accepted` row describes a change settled
   * somewhere the portal cannot see, so a row without the workspace's handle
   * says permanently that something was submitted and gives no way to find
   * out how it ended.
   */
  it('records the workspace transaction handle on an accepted write', async () => {
    const service = makeService({
      plane: makeGlAdapter(() => ({ status: 202, body: { transactionId: 'txn-7' } })),
    });
    await service.write('addSubscription', { key: 'K-1' }, true);
    expect(auditLines()[0].transactionId).toBe('txn-7');
  });

  // A synchronous write is settled; there is no handle to record and the
  // field must be absent rather than present-and-empty, which would read as
  // "the workspace issued one and we lost it".
  it('omits the handle entirely when the write was applied outright', async () => {
    const service = makeService({ plane: makeGlAdapter(() => ({ body: { id: 'loc-9' } })) });
    await service.write('createLocation', LOCATION_INPUT, true);
    expect(Object.hasOwn(auditLines()[0], 'transactionId')).toBe(false);
  });

  /**
   * The GreenLake screen re-renders its lists from the poller cache right
   * after a write. If nothing forced that cache forward, "Applied" is followed
   * by the pre-change list, which reads as a silent failure — and the natural
   * operator response is to run the action again, creating a duplicate user,
   * location or device.
   */
  it('forces the workspace cache forward after an applied write', async () => {
    const poller = refreshingPoller();
    const forced: string[] = [];
    (poller as unknown as { syncNowFor: (id: string) => Promise<string> }).syncNowFor = async (
      id: string,
    ) => {
      forced.push(id);
      return 'ok';
    };
    const service = makeService({
      plane: makeGlAdapter(() => ({ body: { id: 'loc-9' } })),
      pollerRef: poller,
    });
    const result = await service.write('createLocation', LOCATION_INPUT, true);
    expect(forced).toEqual(['greenlake']);
    expect(result.cacheRefresh).toEqual({ attempted: true, ok: true });
  });

  // A refresh that did not land must be reported, not assumed. The write
  // itself still succeeded — only the operator's view of it is behind.
  it('reports a refresh that failed rather than implying the list is current', async () => {
    const service = makeService({
      plane: makeGlAdapter(() => ({ body: { id: 'loc-9' } })),
      pollerRef: refreshingPoller('error'),
    });
    const result = await service.write('createLocation', LOCATION_INPUT, true);
    expect(result.outcome).toBe('applied');
    expect(result.cacheRefresh?.attempted).toBe(true);
    expect(result.cacheRefresh?.ok).toBe(false);
    expect(result.cacheRefresh?.message).toContain('could not be re-read');
  });

  // A pull that completes but contributes no greenlake section leaves the
  // cache exactly as stale as a failed one; calling that a success would be
  // the same lie by a quieter route.
  it('does not call a pull that contributed no sections a successful refresh', async () => {
    const service = makeService({ plane: makeGlAdapter(() => ({ body: { id: 'loc-9' } })) });
    const result = await service.write('createLocation', LOCATION_INPUT, true);
    expect(result.cacheRefresh).toMatchObject({ attempted: true, ok: false });
    expect(result.cacheRefresh?.message).toContain('no platform sections');
  });

  // A 202 has not been applied, so a pull would faithfully return a list
  // without the new row — and having just re-read the workspace makes that
  // absence look like a verdict rather than a race.
  it('does not refresh after an accepted 202', async () => {
    const poller = refreshingPoller();
    let forced = 0;
    (poller as unknown as { syncNowFor: () => Promise<string> }).syncNowFor = async () => {
      forced += 1;
      return 'ok';
    };
    const service = makeService({
      plane: makeGlAdapter(() => ({ status: 202, body: { transactionId: 'txn-7' } })),
      pollerRef: poller,
    });
    const result = await service.write('addSubscription', { key: 'K-1' }, true);
    expect(result.outcome).toBe('accepted');
    expect(forced).toBe(0);
    expect(result.cacheRefresh).toEqual({ attempted: false, ok: false });
  });

  // The refresh is a display concern. A write that the workspace performed
  // must never be reported as failed because the follow-up pull threw.
  it('never fails an applied write because the refresh threw', async () => {
    const poller = refreshingPoller();
    (poller as unknown as { syncNowFor: () => Promise<string> }).syncNowFor = async () => {
      throw new Error('poller exploded');
    };
    const service = makeService({
      plane: makeGlAdapter(() => ({ body: { id: 'loc-9' } })),
      pollerRef: poller,
    });
    const result = await service.write('createLocation', LOCATION_INPUT, true);
    expect(result.outcome).toBe('applied');
    expect(result.cacheRefresh).toMatchObject({ attempted: true, ok: false });
  });

  it('translates a missing required field into a 400 and audits the rejection', async () => {
    const service = makeService({ plane: makeGlAdapter(() => ({ body: {} })) });
    await expect(service.write('createLocation', {}, true)).rejects.toMatchObject({ status: 400 });
    expect(String(auditLines()[0].result)).toContain('rejected');
  });

  // 405 is the live answer for a device delete: the endpoint exists but the
  // method is refused, which is a different operator story from 403 or 404.
  it('passes a vendor 4xx through with a reason the operator can act on', async () => {
    const cases: [number, RegExp][] = [
      [403, /not permitted/],
      [404, /no endpoint/i],
      [405, /refuses the method/],
      [409, /conflict/],
    ];
    for (const [status, matcher] of cases) {
      const service = makeService({ plane: makeGlAdapter(() => ({ status, body: { message: 'vendor detail' } })) });
      await expect(service.write('createLocation', LOCATION_INPUT, true)).rejects.toMatchObject({
        status,
        message: matcher,
      });
    }
  });

  it('turns a vendor 5xx into a 502 without echoing the vendor body', async () => {
    const service = makeService({
      plane: makeGlAdapter(() => ({ status: 500, body: { message: 'internal stack trace' } })),
    });
    await expect(service.write('createLocation', LOCATION_INPUT, true)).rejects.toMatchObject({ status: 502 });
    const logged = readFileSync(join(tmpDir, 'change-log.jsonl'), 'utf8');
    expect(logged).not.toContain('internal stack trace');
    expect(logged).toContain('failed');
  });

  it('never writes the workspace secret into the audit log', async () => {
    const service = makeService({ plane: makeGlAdapter(() => ({ body: { id: 'u-9' } })) });
    await service.write('inviteUser', { email: 'a@b.com' }, true);
    expect(readFileSync(join(tmpDir, 'change-log.jsonl'), 'utf8')).not.toContain('shh-gl-secret');
  });
});
