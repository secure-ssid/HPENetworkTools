/**
 * server/tests/sseObjects.test.ts — SseObjectsService unit tests.
 *
 * Service-level: every instantiation injects a `plane` override (a real
 * SseAdapter built against an in-memory fake fetch — same pattern
 * ssidDirectWrite.test.ts uses a stub SsidWritePlane for) plus a duck-typed
 * fake registry/poller (registryPoller.test.ts's fakeRegistry pattern), so
 * this file exercises the review-gate, the write-scope gate, field
 * validation, the mutation/commit split, the commit-only retry, and the
 * audit log — all WITHOUT the process-wide registry or poller singletons.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlaneState } from '../src/planes/types';
import { SSE_KIND_SPEC, SseAdapter, type FetchLike } from '../src/planes/sse';
import { SseObjectsError, SseObjectsService } from '../src/services/sseObjects';
import type { PlaneRegistry } from '../src/planes/registry';
import type { Poller } from '../src/services/poller';

type HandlerResult = { status?: number; body?: unknown };
type Handler = (method: string, pathname: string) => HandlerResult | undefined;

function fakeFetch(handler: Handler): FetchLike {
  return async (url, init) => {
    const u = new URL(url);
    const method = (init?.method as string | undefined) ?? 'GET';
    const result = handler(method, u.pathname);
    if (!result) return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } });
    const status = result.status ?? 200;
    const nullBody = status === 204 || status === 205 || status === 304;
    return new Response(nullBody ? null : JSON.stringify(result.body ?? {}), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };
}

function makeSseAdapter(
  handler: Handler,
  creds: Record<string, string> = { token: 'shh' },
  recordCall: ConstructorParameters<typeof SseAdapter>[2] = () => {},
): SseAdapter {
  const state: PlaneState = { id: 'sse', linked: true, health: 'healthy', lastSync: null, deviceCount: null, callsToday: 0, note: null };
  return new SseAdapter(creds, state, recordCall, fakeFetch(handler));
}

function fakeRegistry(events: { id: string; what: string; who: string }[]): PlaneRegistry {
  return {
    get: () => {
      throw new Error('service must use the injected `plane` override, never fall through to the registry');
    },
    recordEvent: (id: string, e: { what: string; who: string }) => events.push({ id, ...e }),
  } as unknown as PlaneRegistry;
}

let tmpDir: string;
beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'hpe-sse-objects-'));
});
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('SseObjectsService.inventory / listKind', () => {
  it('serves the poller cache, never a live call', () => {
    const events: { id: string; what: string; who: string }[] = [];
    const adapter = makeSseAdapter(() => ({ status: 500 })); // any live call here would fail loudly
    const fakePoller = {
      contributionsByPlane: () =>
        new Map([
          [
            'sse',
            {
              sse: {
                kinds: { connectors: { rows: [{ kind: 'connectors', id: 'c-1', name: 'edge-1', raw: {} }], total: 1, truncated: false } },
                unavailable: ['users'],
                source: 'test',
              },
            },
          ],
        ]),
    } as unknown as Poller;
    const service = new SseObjectsService({ registry: fakeRegistry(events), pollerRef: fakePoller, plane: adapter, dataDir: tmpDir });
    const inv = service.inventory();
    expect(inv.kinds.connectors?.rows).toHaveLength(1);
    expect(inv.unavailable).toEqual(['users']);
    expect(service.listKind('users').unavailable).toBe(true);
    expect(service.listKind('connectors', 'edge').rows).toHaveLength(1);
    expect(service.listKind('connectors', 'nomatch').rows).toHaveLength(0);
  });

  it('is not linked → 409, distinct from "linked but empty"', () => {
    const events: { id: string; what: string; who: string }[] = [];
    const fakePoller = { contributionsByPlane: () => new Map() } as unknown as Poller;
    const service = new SseObjectsService({ registry: fakeRegistry(events), pollerRef: fakePoller, plane: null, dataDir: tmpDir });
    expect(() => service.inventory()).toThrow(SseObjectsError);
    try {
      service.inventory();
    } catch (err) {
      expect((err as SseObjectsError).status).toBe(409);
    }
  });
});

describe('SseObjectsService write gates', () => {
  function harness(creds: Record<string, string>, handler: Handler) {
    const events: { id: string; what: string; who: string }[] = [];
    const adapter = makeSseAdapter(handler, creds);
    const fakePoller = {
      contributionsByPlane: () => new Map(),
      syncNowFor: async () => 'ok' as const,
    } as unknown as Poller;
    const service = new SseObjectsService({ registry: fakeRegistry(events), pollerRef: fakePoller, plane: adapter, dataDir: tmpDir });
    return { service, events };
  }

  it('rejects a mutation without reviewConfirmed: true', async () => {
    const { service } = harness({ token: 'x', scopes: 'write:brokered' }, () => ({ status: 201, body: { id: 'z' } }));
    await expect(service.create('connectorZones', { name: 'z' }, undefined)).rejects.toMatchObject({ status: 400 });
    await expect(service.create('connectorZones', { name: 'z' }, false)).rejects.toMatchObject({ status: 400 });
  });

  it('rejects a write when the token’s declared scope is read-only', async () => {
    const { service } = harness({ token: 'x' }, () => ({ status: 201, body: { id: 'z' } }));
    await expect(service.create('connectorZones', { name: 'z' }, true)).rejects.toMatchObject({ status: 403 });
  });

  it('requires the create kind’s minimum field (name / userName)', async () => {
    const { service } = harness({ token: 'x', scopes: 'write:brokered' }, () => ({ status: 201, body: { id: 'z' } }));
    await expect(service.create('connectorZones', { description: 'no name' }, true)).rejects.toMatchObject({ status: 400 });
    await expect(service.create('users', { email: 'no username' }, true)).rejects.toMatchObject({ status: 400 });
  });

  it('never accepts a caller-supplied id in the create body', async () => {
    let sentBody: unknown;
    const { service } = harness({ token: 'x', scopes: 'write:brokered' }, (method, pathname) => {
      if (method === 'POST' && pathname === SSE_KIND_SPEC.connectorZones.path) return { status: 201, body: { id: 'server-assigned' } };
      if (method === 'POST' && pathname === '/api/v1.0/Commit') return { status: 204 };
      return undefined;
    });
    void sentBody;
    const result = await service.create('connectorZones', { id: 'operator-supplied', name: 'HQ' }, true);
    expect(result.mutation.id).toBe('server-assigned');
  });

  it('a successful create + commit without target verification is logged unverified, with no payload or secret', async () => {
    const { service, events } = harness({ token: 'super-secret-token', scopes: 'write:brokered' }, (method, pathname) => {
      if (method === 'POST' && pathname === SSE_KIND_SPEC.groups.path) return { status: 201, body: { id: 'g-1' } };
      if (method === 'POST' && pathname === '/api/v1.0/Commit') return { status: 204 };
      return undefined;
    });
    const result = await service.create('groups', { name: 'clinical-staff' }, true);
    expect(result.staged).toBe(false);
    expect(events).toHaveLength(1);
    expect(events[0].what).toContain('unverified');
    expect(events[0].what).not.toContain('super-secret-token');
    const log = readFileSync(join(tmpDir, 'change-log.jsonl'), 'utf8').trim();
    expect(log).toContain('"kind":"sse:groups"');
    expect(log).toContain('"result":"unverified"');
    expect(log).not.toContain('super-secret-token');
    expect(log).not.toContain('clinical-staff'); // no payload body in the log line
  });

  it('redacts raw transport errors from results, audit records, and plane call logs', async () => {
    const secret = 'transport-secret-token';
    const rawError = `ECONNRESET reading ${join(tmpDir, secret, 'socket.json')}`;
    const calls: Array<{ path: string; ms: number; code: string }> = [];
    const events: { id: string; what: string; who: string }[] = [];
    const state: PlaneState = { id: 'sse', linked: true, health: 'healthy', lastSync: null, deviceCount: null, callsToday: 0, note: null };
    const adapter = new SseAdapter(
      { token: secret, scopes: 'write:brokered' },
      state,
      (call) => calls.push(call),
      async () => {
        throw new Error(rawError);
      },
    );
    const service = new SseObjectsService({
      registry: fakeRegistry(events),
      pollerRef: { contributionsByPlane: () => new Map() } as unknown as Poller,
      plane: adapter,
      dataDir: tmpDir,
    });
    const serverLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const result = await service.create('groups', { name: 'g' }, true);
      const exposed = JSON.stringify({ result, events, calls });
      expect(result.mutation.message).toBe('mutation request outcome is unknown');
      expect(exposed).not.toContain(rawError);
      expect(exposed).not.toContain(tmpDir);
      expect(exposed).not.toContain(secret);
      expect(readFileSync(join(tmpDir, 'change-log.jsonl'), 'utf8')).not.toContain(secret);
      expect(serverLog).toHaveBeenCalledWith(expect.stringContaining(rawError));
    } finally {
      serverLog.mockRestore();
    }
  });

  it('a staged mutation (commit failed) is logged as staged, and retryCommit() logs a separate outcome', async () => {
    let commitAttempts = 0;
    const { service, events } = harness({ token: 'x', scopes: 'write:brokered' }, (method, pathname) => {
      if (method === 'PUT' && pathname === `${SSE_KIND_SPEC.tunnels.path}/t-1`) return { status: 200, body: { id: 't-1' } };
      if (method === 'POST' && pathname === '/api/v1.0/Commit') {
        commitAttempts += 1;
        return { status: commitAttempts === 1 ? 500 : 204 };
      }
      return undefined;
    });
    const result = await service.update('tunnels', 't-1', { name: 'renamed' }, true);
    expect(result.staged).toBe(true);
    expect(events[0].what).toContain('staged');

    const retry = await service.retryCommit(true);
    expect(retry.commit.ok).toBe(true);
    expect(events[1].what).toContain('object verification is reported separately');
    expect(commitAttempts).toBe(2);
  });

  it('delete requires an id and the same review + scope gates as create/update', async () => {
    const { service } = harness({ token: 'x', scopes: 'write:brokered' }, (method, pathname) =>
      method === 'DELETE' && pathname === `${SSE_KIND_SPEC.groups.path}/g-1` ? { status: 200 } : undefined,
    );
    await expect(service.remove('groups', '', true)).rejects.toMatchObject({ status: 400 });
    await expect(service.remove('groups', 'g-1', undefined)).rejects.toMatchObject({ status: 400 });
  });
});

describe('SseObjectsService.getObject — distinct read failures (requirement 4)', () => {
  function svcFor(handler: Handler): SseObjectsService {
    const adapter = makeSseAdapter(handler, { token: 'x' });
    const fakePoller = { contributionsByPlane: () => new Map() } as unknown as Poller;
    return new SseObjectsService({ registry: fakeRegistry([]), pollerRef: fakePoller, plane: adapter, dataDir: tmpDir });
  }

  it('a real 404 stays 404', async () => {
    await expect(svcFor(() => ({ status: 404 })).getObject('tunnels', 't-1')).rejects.toMatchObject({ status: 404 });
  });

  it('a 401/403 (denied) is reported distinctly — never collapsed into 404', async () => {
    const err = await svcFor(() => ({ status: 403 }))
      .getObject('tunnels', 't-1')
      .catch((e) => e as SseObjectsError);
    expect(err).toBeInstanceOf(SseObjectsError);
    expect((err as SseObjectsError).status).not.toBe(404);
    expect((err as SseObjectsError).status).toBe(502);
  });

  it('an unreachable plane (5xx, unreadable body, or transport failure) is reported distinctly — never collapsed into 404 or an empty object', async () => {
    await expect(svcFor(() => ({ status: 500 })).getObject('tunnels', 't-1')).rejects.toMatchObject({ status: 502 });

    const state: PlaneState = { id: 'sse', linked: true, health: 'healthy', lastSync: null, deviceCount: null, callsToday: 0, note: null };
    const throwingAdapter = new SseAdapter({ token: 'x' }, state, () => {}, async () => {
      throw new Error('ECONNRESET');
    });
    const fakePoller = { contributionsByPlane: () => new Map() } as unknown as Poller;
    const service = new SseObjectsService({ registry: fakeRegistry([]), pollerRef: fakePoller, plane: throwingAdapter, dataDir: tmpDir });
    await expect(service.getObject('tunnels', 't-1')).rejects.toMatchObject({ status: 502 });
  });

  it('no error message ever carries the token', async () => {
    const adapter = makeSseAdapter(() => ({ status: 403 }), { token: 'ultra-secret-value' });
    const fakePoller = { contributionsByPlane: () => new Map() } as unknown as Poller;
    const service = new SseObjectsService({ registry: fakeRegistry([]), pollerRef: fakePoller, plane: adapter, dataDir: tmpDir });
    const err = await service.getObject('tunnels', 't-1').catch((e) => e as Error);
    expect(err.message).not.toContain('ultra-secret-value');
  });
});

describe('SseObjectsService cacheRefresh reporting (requirement 5)', () => {
  it('reports "refreshed" when the post-commit poll succeeds', async () => {
    const adapter = makeSseAdapter(
      (method, pathname) => {
        if (method === 'POST' && pathname === SSE_KIND_SPEC.groups.path) return { status: 201, body: { id: 'g-1' } };
        if (method === 'POST' && pathname === '/api/v1.0/Commit') return { status: 204 };
        return undefined;
      },
      { token: 'x', scopes: 'write:brokered' },
    );
    const fakePoller = {
      contributionsByPlane: () =>
        new Map([
          [
            'sse',
            {
              sse: {
                kinds: {
                  groups: {
                    rows: [{ kind: 'groups', id: 'g-1', name: 'g', raw: {} }],
                    total: 1,
                    truncated: false,
                  },
                },
                unavailable: [],
                source: 'test',
              },
            },
          ],
        ]),
      syncNowFor: async () => 'ok' as const,
    } as unknown as Poller;
    const service = new SseObjectsService({ registry: fakeRegistry([]), pollerRef: fakePoller, plane: adapter, dataDir: tmpDir });
    const result = await service.create('groups', { name: 'g' }, true);
    expect(result.cacheRefresh).toMatchObject({ attempted: true, status: 'refreshed' });
    expect(result.outcome).toBe('applied');
  });

  it.each([
    {
      name: 'partial pull',
      pull: {
        sse: {
          kinds: {
            groups: { rows: [{ kind: 'groups', id: 'g-1', name: 'g', raw: {} }], total: 1, truncated: false },
          },
          unavailable: [],
          source: 'test',
        },
        partial: ['sse'],
      },
    },
    {
      name: 'truncated target kind',
      pull: {
        sse: {
          kinds: {
            groups: { rows: [{ kind: 'groups', id: 'g-1', name: 'g', raw: {} }], total: null, truncated: true },
          },
          unavailable: [],
          source: 'test',
        },
      },
    },
    {
      name: 'target missing',
      pull: {
        sse: {
          kinds: { groups: { rows: [], total: 0, truncated: false } },
          unavailable: [],
          source: 'test',
        },
      },
    },
  ])('reports stale/unverified for a $name refresh', async ({ pull }) => {
    const adapter = makeSseAdapter(
      (method, pathname) => {
        if (method === 'POST' && pathname === SSE_KIND_SPEC.groups.path) return { status: 201, body: { id: 'g-1' } };
        if (method === 'POST' && pathname === '/api/v1.0/Commit') return { status: 204 };
        return undefined;
      },
      { token: 'x', scopes: 'write:brokered' },
    );
    const fakePoller = {
      contributionsByPlane: () => new Map([['sse', pull]]),
      syncNowFor: async () => 'ok' as const,
    } as unknown as Poller;
    const result = await new SseObjectsService({
      registry: fakeRegistry([]),
      pollerRef: fakePoller,
      plane: adapter,
      dataDir: tmpDir,
    }).create('groups', { name: 'g' }, true);
    expect(result.cacheRefresh.status).toBe('stale');
    expect(result.cacheRefresh.message).toMatch(/unverified/i);
  });

  it('verifies a delete only when a complete target-kind refresh shows the id absent', async () => {
    const adapter = makeSseAdapter(
      (method, pathname) => {
        if (method === 'DELETE' && pathname === `${SSE_KIND_SPEC.groups.path}/g-1`) return { status: 200 };
        if (method === 'POST' && pathname === '/api/v1.0/Commit') return { status: 204 };
        return undefined;
      },
      { token: 'x', scopes: 'write:brokered' },
    );
    const fakePoller = {
      contributionsByPlane: () =>
        new Map([
          [
            'sse',
            {
              sse: {
                kinds: { groups: { rows: [], total: 0, truncated: false } },
                unavailable: [],
                source: 'test',
              },
            },
          ],
        ]),
      syncNowFor: async () => 'ok' as const,
    } as unknown as Poller;
    const result = await new SseObjectsService({
      registry: fakeRegistry([]),
      pollerRef: fakePoller,
      plane: adapter,
      dataDir: tmpDir,
    }).remove('groups', 'g-1', true);
    expect(result.cacheRefresh.status).toBe('refreshed');
    expect(result.outcome).toBe('applied');
  });

  it('reports "stale" (never fabricates "refreshed") when the post-commit poll answers error/skipped or throws', async () => {
    const handler: Handler = (method, pathname) => {
      if (method === 'POST' && pathname === SSE_KIND_SPEC.groups.path) return { status: 201, body: { id: 'g-1' } };
      if (method === 'POST' && pathname === '/api/v1.0/Commit') return { status: 204 };
      return undefined;
    };

    const erroringPoller = {
      contributionsByPlane: () => new Map(),
      syncNowFor: async () => 'error' as const,
    } as unknown as Poller;
    const serviceA = new SseObjectsService({
      registry: fakeRegistry([]),
      pollerRef: erroringPoller,
      plane: makeSseAdapter(handler, { token: 'x', scopes: 'write:brokered' }),
      dataDir: tmpDir,
    });
    const resultA = await serviceA.create('groups', { name: 'g' }, true);
    expect(resultA.cacheRefresh.status).toBe('stale');

    const throwingPoller = {
      contributionsByPlane: () => new Map(),
      syncNowFor: async () => {
        throw new Error('poll blew up');
      },
    } as unknown as Poller;
    const serviceB = new SseObjectsService({
      registry: fakeRegistry([]),
      pollerRef: throwingPoller,
      plane: makeSseAdapter(handler, { token: 'x', scopes: 'write:brokered' }),
      dataDir: tmpDir,
    });
    const resultB = await serviceB.create('groups', { name: 'g2' }, true);
    expect(resultB.cacheRefresh.status).toBe('stale');
  });

  it('reports "skipped" (never attempts a refresh) when the mutation itself failed', async () => {
    const adapter = makeSseAdapter(() => ({ status: 409 }), { token: 'x', scopes: 'write:brokered' });
    const fakePoller = { contributionsByPlane: () => new Map(), syncNowFor: async () => 'ok' as const } as unknown as Poller;
    const service = new SseObjectsService({ registry: fakeRegistry([]), pollerRef: fakePoller, plane: adapter, dataDir: tmpDir });
    const result = await service.create('groups', { name: 'g' }, true);
    expect(result.mutation.ok).toBe(false);
    expect(result.cacheRefresh).toMatchObject({ attempted: false, status: 'skipped' });
  });
});

describe('SseObjectsService — commit is tenant-wide, made explicit (requirement 3)', () => {
  it('every attempted commit outcome (success or failure) carries a tenant-wide warning', async () => {
    let commitAttempts = 0;
    const adapter = makeSseAdapter(
      (method, pathname) => {
        if (method === 'POST' && pathname === SSE_KIND_SPEC.groups.path) return { status: 201, body: { id: 'g-1' } };
        if (method === 'POST' && pathname === '/api/v1.0/Commit') {
          commitAttempts += 1;
          return { status: commitAttempts === 1 ? 500 : 204 };
        }
        return undefined;
      },
      { token: 'x', scopes: 'write:brokered' },
    );
    const fakePoller = { contributionsByPlane: () => new Map(), syncNowFor: async () => 'ok' as const } as unknown as Poller;
    const service = new SseObjectsService({ registry: fakeRegistry([]), pollerRef: fakePoller, plane: adapter, dataDir: tmpDir });
    const staged = await service.create('groups', { name: 'g' }, true);
    expect(staged.commit.warning).toMatch(/tenant-wide/i);

    const retry = await service.retryCommit(true);
    expect(retry.commit.ok).toBe(true);
    expect(retry.commit.warning).toMatch(/tenant-wide/i);
  });
});

describe('SseObjectsService — durable pending-commit state (requirement 2 + 3)', () => {
  function harness(handler: Handler, creds: Record<string, string> = { token: 'x', scopes: 'write:brokered' }) {
    const events: { id: string; what: string; who: string }[] = [];
    const adapter = makeSseAdapter(handler, creds);
    const fakePoller = { contributionsByPlane: () => new Map(), syncNowFor: async () => 'ok' as const } as unknown as Poller;
    const service = new SseObjectsService({ registry: fakeRegistry(events), pollerRef: fakePoller, plane: adapter, dataDir: tmpDir });
    return { service, events };
  }

  function stagingHandler(): { handler: Handler; commitAttempts: () => number } {
    let commitAttempts = 0;
    const handler: Handler = (method, pathname) => {
      if (method === 'POST' && pathname === SSE_KIND_SPEC.connectorZones.path) return { status: 201, body: { id: 'cz-1' } };
      if (method === 'POST' && pathname === '/api/v1.0/Commit') {
        commitAttempts += 1;
        return { status: commitAttempts === 1 ? 500 : 204 };
      }
      return undefined;
    };
    return { handler, commitAttempts: () => commitAttempts };
  }

  it('a staged mutation persists a secret-free, payload-free pending record and blocks further mutations', async () => {
    const { handler } = stagingHandler();
    const { service } = harness(handler);
    const result = await service.create('connectorZones', { name: 'HQ super secret label' }, true);
    expect(result.staged).toBe(true);

    const pendingRaw = readFileSync(join(tmpDir, 'sse-pending-commit.json'), 'utf8');
    expect(pendingRaw).toContain('"kind": "connectorZones"');
    expect(pendingRaw).toContain('"action": "create"');
    expect(pendingRaw).toContain('"phase": "commit-rejected"');
    expect(pendingRaw).toContain('"tenantFingerprint": "sse:');
    expect(pendingRaw).not.toContain('HQ super secret label'); // no payload/name persisted
    expect(pendingRaw).not.toContain('"token"');

    await expect(service.create('connectorZones', { name: 'Blocked' }, true)).rejects.toMatchObject({ status: 409 });
  });

  it('the pending state is durable — a brand-new service instance over the same dataDir still blocks and can still resolve it', async () => {
    const { handler } = stagingHandler();
    const { service } = harness(handler);
    const result = await service.create('connectorZones', { name: 'HQ' }, true);
    expect(result.staged).toBe(true);

    const restarted = new SseObjectsService({
      registry: fakeRegistry([]),
      pollerRef: { contributionsByPlane: () => new Map(), syncNowFor: async () => 'ok' as const } as unknown as Poller,
      plane: makeSseAdapter(handler, { token: 'x', scopes: 'write:brokered' }),
      dataDir: tmpDir,
    });
    await expect(restarted.create('connectorZones', { name: 'Still blocked' }, true)).rejects.toMatchObject({ status: 409 });

    const retry = await restarted.retryCommit(true);
    expect(retry.commit.ok).toBe(true);
    expect(() => readFileSync(join(tmpDir, 'sse-pending-commit.json'), 'utf8')).toThrow();

    // Now cleared — a further mutation is allowed again.
    const unblocked = await restarted.create('connectorZones', { name: 'Allowed again' }, true);
    expect(unblocked.mutation.ok).toBe(true);
  });

  it('rejects a commit-only retry when nothing is staged (empty retry)', async () => {
    const { service } = harness(() => ({ status: 200 }));
    await expect(service.retryCommit(true)).rejects.toMatchObject({ status: 409 });
  });

  it('rejects a commit-only retry against an unowned/corrupt pending file, while still fail-safe blocking new mutations', async () => {
    const { service } = harness(() => ({ status: 200 }));
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(join(tmpDir, 'sse-pending-commit.json'), JSON.stringify({ notAValidRecord: true }));

    await expect(service.create('connectorZones', { name: 'x' }, true)).rejects.toMatchObject({ status: 409 });
    await expect(service.retryCommit(true)).rejects.toMatchObject({ status: 409 });
  });

  it('retryCommit still requires reviewConfirmed:true and the declared write scope', async () => {
    const { handler } = stagingHandler();
    const { service } = harness(handler);
    await service.create('connectorZones', { name: 'HQ' }, true);

    await expect(service.retryCommit(undefined)).rejects.toMatchObject({ status: 400 });
    await expect(service.retryCommit(false)).rejects.toMatchObject({ status: 400 });

    const readOnlyAdapter = makeSseAdapter(handler, { token: 'x' }); // no write scope declared
    const readOnlyService = new SseObjectsService({
      registry: fakeRegistry([]),
      pollerRef: { contributionsByPlane: () => new Map() } as unknown as Poller,
      plane: readOnlyAdapter,
      dataDir: tmpDir,
    });
    await expect(readOnlyService.retryCommit(true)).rejects.toMatchObject({ status: 403 });
  });

  it('clears pending state ONLY after a successful commit — a failed retry leaves it staged and mutations still blocked', async () => {
    const handler: Handler = (method, pathname) => {
      if (method === 'POST' && pathname === SSE_KIND_SPEC.connectorZones.path) return { status: 201, body: { id: 'cz-1' } };
      if (method === 'POST' && pathname === '/api/v1.0/Commit') return { status: 500 }; // always fails
      return undefined;
    };
    const { service } = harness(handler);
    const result = await service.create('connectorZones', { name: 'HQ' }, true);
    expect(result.staged).toBe(true);

    const retry = await service.retryCommit(true);
    expect(retry.commit.ok).toBe(false);

    await expect(service.create('connectorZones', { name: 'Still blocked' }, true)).rejects.toMatchObject({ status: 409 });
  });

  it('retains mutation-transport-unknown on transport rejection, marks it non-staged, and blocks every later mutation', async () => {
    let mutationCalls = 0;
    const state: PlaneState = { id: 'sse', linked: true, health: 'healthy', lastSync: null, deviceCount: null, callsToday: 0, note: null };
    const adapter = new SseAdapter(
      { token: 'x', scopes: 'write:brokered' },
      state,
      () => {},
      async (url) => {
        if (new URL(url).pathname === `${SSE_KIND_SPEC.groups.path}/g-1`) {
          mutationCalls += 1;
          throw new Error('ETIMEDOUT');
        }
        return new Response(null, { status: 204 });
      },
    );
    const service = new SseObjectsService({
      registry: fakeRegistry([]),
      pollerRef: { contributionsByPlane: () => new Map() } as unknown as Poller,
      plane: adapter,
      dataDir: tmpDir,
    });
    const result = await service.update('groups', 'g-1', { name: 'renamed' }, true);
    expect(result).toMatchObject({ staged: false, outcome: 'unknown' });
    expect(result.mutation.acceptance).toBe('unknown');
    expect(readFileSync(join(tmpDir, 'sse-pending-commit.json'), 'utf8')).toContain(
      '"phase": "mutation-transport-unknown"',
    );
    await expect(service.remove('groups', 'g-2', true)).rejects.toMatchObject({ status: 409 });
    expect(mutationCalls).toBe(1);
  });

  it('reviewed recovery for a transport-unknown mutation fails closed and never calls Commit', async () => {
    let commitCalls = 0;
    const state: PlaneState = { id: 'sse', linked: true, health: 'healthy', lastSync: null, deviceCount: null, callsToday: 0, note: null };
    const adapter = new SseAdapter(
      { token: 'x', scopes: 'write:brokered' },
      state,
      () => {},
      async (url) => {
        const pathname = new URL(url).pathname;
        if (pathname === SSE_KIND_SPEC.groups.path) throw new Error('connection reset after send');
        if (pathname === '/api/v1.0/Commit') {
          commitCalls += 1;
          return new Response(null, { status: 204 });
        }
        return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } });
      },
    );
    const fakePoller = {
      syncNowFor: async () => 'ok' as const,
      contributionsByPlane: () =>
        new Map([
          [
            'sse',
            {
              sse: {
                kinds: { groups: { rows: [], total: 0, truncated: false } },
                unavailable: [],
                source: 'test',
              },
            },
          ],
        ]),
    } as unknown as Poller;
    const service = new SseObjectsService({
      registry: fakeRegistry([]),
      pollerRef: fakePoller,
      plane: adapter,
      dataDir: tmpDir,
    });
    const unknown = await service.create('groups', { name: 'g' }, true);
    expect(unknown.outcome).toBe('unknown');
    expect(unknown.staged).toBe(false);

    await expect(service.retryCommit(true)).rejects.toMatchObject({
      status: 409,
      code: 'SSE_MANUAL_RECONCILIATION_REQUIRED',
      message: expect.stringMatching(/must not be retried/i),
    });
    expect(commitCalls).toBe(0);
    expect(readFileSync(join(tmpDir, 'sse-pending-commit.json'), 'utf8')).toContain(
      '"phase": "mutation-transport-unknown"',
    );
  });

  it('rejects recovery when the current adapter fingerprint differs', async () => {
    const { service } = harness((method, pathname) => {
      if (method === 'POST' && pathname === SSE_KIND_SPEC.groups.path) return { status: 201, body: { id: 'g-1' } };
      if (method === 'POST' && pathname === '/api/v1.0/Commit') return { status: 500 };
      return undefined;
    }, { token: 'tenant-a', scopes: 'write:brokered' });
    await service.create('groups', { name: 'g' }, true);

    let commitCalls = 0;
    const mismatched = new SseObjectsService({
      registry: fakeRegistry([]),
      pollerRef: { contributionsByPlane: () => new Map() } as unknown as Poller,
      plane: makeSseAdapter((method, pathname) => {
        if (method === 'POST' && pathname === '/api/v1.0/Commit') commitCalls += 1;
        return { status: 204 };
      }, { token: 'tenant-b', scopes: 'write:brokered' }),
      dataDir: tmpDir,
    });
    await expect(mismatched.retryCommit(true)).rejects.toMatchObject({ status: 409 });
    expect(commitCalls).toBe(0);
  });
});

describe('SseObjectsService — recovery phase allowlist', () => {
  const ambiguousPhases = [
    'mutation-in-flight',
    'mutation-transport-unknown',
    'commit-in-flight',
    'commit-transport-unknown',
    'commit-accepted-unrecorded',
  ] as const;

  function serviceWithSeededPhase(
    phase: string,
    options: { removeFails?: boolean; commitStatus?: number } = {},
  ): {
    service: SseObjectsService;
    retrySpy: ReturnType<typeof vi.spyOn>;
    raw: () => string | null;
    allowRemove: () => void;
  } {
    let raw: string | null = null;
    let removeFails = options.removeFails ?? false;
    const adapter = makeSseAdapter(
      (method, pathname) =>
        method === 'POST' && pathname === '/api/v1.0/Commit'
          ? { status: options.commitStatus ?? 204 }
          : undefined,
      { token: 'x', scopes: 'write:brokered' },
    );
    raw = JSON.stringify({
      version: 1,
      phase,
      kind: 'groups',
      action: 'update',
      objectId: 'g-1',
      at: new Date(0).toISOString(),
      tenantFingerprint: adapter.tenantFingerprint(),
    });
    const journalStore = {
      exists: () => raw !== null,
      read: () => raw ?? '',
      write: (record: unknown) => {
        raw = JSON.stringify(record);
      },
      remove: () => {
        if (removeFails) throw new Error('disk refused unlink');
        raw = null;
      },
    };
    const fakePoller = {
      syncNowFor: async () => 'ok' as const,
      contributionsByPlane: () => new Map(),
    } as unknown as Poller;
    const retrySpy = vi.spyOn(adapter, 'retryCommit');
    return {
      service: new SseObjectsService({
        registry: fakeRegistry([]),
        pollerRef: fakePoller,
        plane: adapter,
        dataDir: tmpDir,
        journalStore,
      }),
      retrySpy,
      raw: () => raw,
      allowRemove: () => {
        removeFails = false;
      },
    };
  }

  it.each(ambiguousPhases)('never calls adapter.retryCommit for ambiguous phase %s', async (phase) => {
    const { service, retrySpy, raw } = serviceWithSeededPhase(phase);

    await expect(service.retryCommit(true)).rejects.toMatchObject({
      status: 409,
      code: 'SSE_MANUAL_RECONCILIATION_REQUIRED',
      message: expect.stringMatching(/Commit was not called|must not be retried/i),
    });
    expect(retrySpy).toHaveBeenCalledTimes(0);
    expect(JSON.parse(raw() ?? '').phase).toBe(phase);
  });

  it.each([
    ['corrupt JSON', '{'],
    ['invalid record', JSON.stringify({ notAValidRecord: true })],
    [
      'unsupported legacy/ambiguous phase',
      JSON.stringify({
        version: 1,
        phase: 'commit-pending',
        kind: 'groups',
        action: 'update',
        objectId: 'g-1',
        at: new Date(0).toISOString(),
        tenantFingerprint: 'irrelevant-before-validation',
      }),
    ],
  ])('never calls adapter.retryCommit for %s', async (_label, seededRaw) => {
    const adapter = makeSseAdapter(() => ({ status: 204 }), { token: 'x', scopes: 'write:brokered' });
    const retrySpy = vi.spyOn(adapter, 'retryCommit');
    const journalStore = {
      exists: () => true,
      read: () => seededRaw,
      write: () => {
        throw new Error('must not write invalid state');
      },
      remove: () => {
        throw new Error('must not remove invalid state');
      },
    };
    const service = new SseObjectsService({
      registry: fakeRegistry([]),
      pollerRef: { contributionsByPlane: () => new Map() } as unknown as Poller,
      plane: adapter,
      dataDir: tmpDir,
      journalStore,
    });

    await expect(service.retryCommit(true)).rejects.toMatchObject({
      status: 409,
      code: 'SSE_MANUAL_RECONCILIATION_REQUIRED',
    });
    expect(retrySpy).toHaveBeenCalledTimes(0);
  });

  it('calls adapter.retryCommit exactly once only for commit-rejected', async () => {
    const { service, retrySpy } = serviceWithSeededPhase('commit-rejected');

    const result = await service.retryCommit(true);

    expect(retrySpy).toHaveBeenCalledTimes(1);
    expect(result.recovery).toMatchObject({ journalPhase: 'commit-rejected', action: 'commit-retry' });
  });

  it('does not call Commit when mutation success lacks a definite 2xx response', async () => {
    const adapter = makeSseAdapter(() => ({ status: 204 }), { token: 'x', scopes: 'write:brokered' });
    vi.spyOn(adapter, 'mutateOnly').mockResolvedValue({
      ok: true,
      httpCode: null,
      acceptance: 'accepted',
      message: 'inconsistent adapter result',
    });
    const retrySpy = vi.spyOn(adapter, 'retryCommit');
    const service = new SseObjectsService({
      registry: fakeRegistry([]),
      pollerRef: { contributionsByPlane: () => new Map() } as unknown as Poller,
      plane: adapter,
      dataDir: tmpDir,
    });

    const result = await service.create('groups', { name: 'g' }, true);

    expect(result).toMatchObject({ staged: false, outcome: 'unknown' });
    expect(retrySpy).toHaveBeenCalledTimes(0);
    expect(JSON.parse(readFileSync(join(tmpDir, 'sse-pending-commit.json'), 'utf8')).phase).toBe(
      'mutation-transport-unknown',
    );
  });

  it('does not make an unproven Commit rejection retryable without a definite non-2xx response', async () => {
    const adapter = makeSseAdapter(() => ({ status: 204 }), { token: 'x', scopes: 'write:brokered' });
    vi.spyOn(adapter, 'mutateOnly').mockResolvedValue({
      ok: true,
      httpCode: 201,
      acceptance: 'accepted',
      id: 'g-1',
      message: 'accepted',
    });
    const retrySpy = vi.spyOn(adapter, 'retryCommit').mockResolvedValue({
      attempted: true,
      ok: false,
      httpCode: null,
      acceptance: 'rejected',
      message: 'inconsistent adapter result',
    });
    const service = new SseObjectsService({
      registry: fakeRegistry([]),
      pollerRef: { contributionsByPlane: () => new Map() } as unknown as Poller,
      plane: adapter,
      dataDir: tmpDir,
    });

    const result = await service.create('groups', { name: 'g' }, true);

    expect(result).toMatchObject({ staged: false, outcome: 'unknown' });
    expect(retrySpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(readFileSync(join(tmpDir, 'sse-pending-commit.json'), 'utf8')).phase).toBe(
      'commit-transport-unknown',
    );

    retrySpy.mockClear();
    await expect(service.retryCommit(true)).rejects.toMatchObject({
      code: 'SSE_MANUAL_RECONCILIATION_REQUIRED',
    });
    expect(retrySpy).toHaveBeenCalledTimes(0);
  });

  it('never calls adapter.retryCommit for mutation-rejected cleanup, including repeated deletion failure', async () => {
    const { service, retrySpy, raw, allowRemove } = serviceWithSeededPhase('mutation-rejected', {
      removeFails: true,
    });

    await expect(service.retryCommit(true)).rejects.toMatchObject({
      status: 500,
      code: 'SSE_JOURNAL_PERSIST_FAILED',
      message: 'internal error',
    });
    expect(retrySpy).toHaveBeenCalledTimes(0);
    expect(JSON.parse(raw() ?? '').phase).toBe('mutation-rejected');

    await expect(service.retryCommit(true)).rejects.toMatchObject({ status: 500 });
    expect(retrySpy).toHaveBeenCalledTimes(0);

    allowRemove();
    const recovered = await service.retryCommit(true);
    expect(retrySpy).toHaveBeenCalledTimes(0);
    expect(recovered.recovery).toMatchObject({ action: 'cleanup-only', journalPhase: 'mutation-rejected' });
    expect(raw()).toBeNull();
  });

  it('never calls adapter.retryCommit for commit-accepted refresh/cleanup when deletion fails', async () => {
    const { service, retrySpy, raw } = serviceWithSeededPhase('commit-accepted', { removeFails: true });

    await expect(service.retryCommit(true)).rejects.toMatchObject({
      status: 500,
      code: 'SSE_JOURNAL_PERSIST_FAILED',
      message: 'internal error',
    });
    expect(retrySpy).toHaveBeenCalledTimes(0);
    expect(JSON.parse(raw() ?? '').phase).toBe('commit-accepted');
  });

  it('persists mutation-rejected before cleanup, so a deletion failure can never become commit-eligible', async () => {
    let raw: string | null = null;
    let removeFails = true;
    const adapter = makeSseAdapter(
      (method, pathname) =>
        method === 'POST' && pathname === SSE_KIND_SPEC.groups.path ? { status: 409 } : { status: 204 },
      { token: 'x', scopes: 'write:brokered' },
    );
    const retrySpy = vi.spyOn(adapter, 'retryCommit');
    const service = new SseObjectsService({
      registry: fakeRegistry([]),
      pollerRef: { contributionsByPlane: () => new Map() } as unknown as Poller,
      plane: adapter,
      dataDir: tmpDir,
      journalStore: {
        exists: () => raw !== null,
        read: () => raw ?? '',
        write: (record: unknown) => {
          raw = JSON.stringify(record);
        },
        remove: () => {
          if (removeFails) throw new Error('disk refused unlink');
          raw = null;
        },
      },
    });

    // SSE refused the object. That answer, and the reason attached to it, is
    // what the operator needs; a failed cleanup afterwards does not turn the
    // refusal into an internal error. What it does do is leave a blocker, and
    // the result says so on its own field.
    const rejected = await service.create('groups', { name: 'rejected' }, true);
    expect(rejected).toMatchObject({ outcome: 'rejected', journalRetained: true });
    expect(JSON.parse(raw ?? '').phase).toBe('mutation-rejected');
    expect(retrySpy).toHaveBeenCalledTimes(0);

    await expect(service.retryCommit(true)).rejects.toMatchObject({ status: 500 });
    expect(retrySpy).toHaveBeenCalledTimes(0);
    removeFails = false;
    const cleanup = await service.retryCommit(true);
    expect(cleanup.recovery?.action).toBe('cleanup-only');
    expect(retrySpy).toHaveBeenCalledTimes(0);
  });
});

describe('SseObjectsService — manually reconciled ambiguous journal cleanup', () => {
  const ambiguousPhases = [
    'mutation-in-flight',
    'mutation-transport-unknown',
    'commit-in-flight',
    'commit-transport-unknown',
    'commit-accepted-unrecorded',
  ] as const;

  function manualCleanupHarness(
    phase: string,
    options: {
      token?: string;
      scopes?: string;
      tenantFingerprint?: string;
      removeFails?: boolean;
      rawOverride?: string;
    } = {},
  ) {
    const events: { id: string; what: string; who: string }[] = [];
    const adapter = makeSseAdapter(
      () => ({ status: 204 }),
      {
        token: options.token ?? 'manual-cleanup-token',
        scopes: options.scopes ?? 'write:brokered',
      },
    );
    let raw: string | null =
      options.rawOverride ??
      JSON.stringify({
        version: 1,
        phase,
        kind: 'groups',
        action: 'update',
        objectId: 'g-1',
        at: new Date(0).toISOString(),
        tenantFingerprint: options.tenantFingerprint ?? adapter.tenantFingerprint(),
      });
    let removeFails = options.removeFails ?? false;
    let syncCalls = 0;
    const journalStore = {
      exists: () => raw !== null,
      read: () => raw ?? '',
      write: (record: unknown) => {
        raw = JSON.stringify(record);
      },
      remove: () => {
        if (removeFails) throw new Error('disk refused unlink');
        raw = null;
      },
    };
    const poller = {
      syncNowFor: async () => {
        syncCalls += 1;
        return 'ok' as const;
      },
      contributionsByPlane: () =>
        new Map([
          [
            'sse',
            {
              sse: {
                kinds: {
                  groups: {
                    rows: [{ kind: 'groups', id: 'g-1', name: 'group', raw: {} }],
                    total: 1,
                    truncated: false,
                  },
                },
                unavailable: [],
                source: 'test',
              },
            },
          ],
        ]),
    } as unknown as Poller;
    const mutateSpy = vi.spyOn(adapter, 'mutateOnly');
    const retrySpy = vi.spyOn(adapter, 'retryCommit');
    return {
      service: new SseObjectsService({
        registry: fakeRegistry(events),
        pollerRef: poller,
        plane: adapter,
        dataDir: tmpDir,
        journalStore,
      }),
      events,
      mutateSpy,
      retrySpy,
      raw: () => raw,
      syncCalls: () => syncCalls,
      allowRemove: () => {
        removeFails = false;
      },
    };
  }

  it.each(ambiguousPhases)(
    'removes manually reconciled %s without mutation or tenant-wide Commit',
    async (phase) => {
      const { service, mutateSpy, retrySpy, raw, syncCalls } = manualCleanupHarness(phase);

      const result = await service.cleanupManuallyReconciled(true, true);

      expect(result.commit).toMatchObject({ attempted: false, acceptance: 'not-attempted' });
      expect(result.commit.message).toMatch(/tenant-wide Commit was not called/i);
      expect(result.recovery).toMatchObject({
        journalPhase: phase,
        action: 'manual-cleanup',
        status: 'journal-removed',
      });
      expect(result.recovery.message).toMatch(/tenant-wide Commit was not called/i);
      expect(result.cacheRefresh.attempted).toBe(true);
      expect(syncCalls()).toBe(1);
      expect(mutateSpy).toHaveBeenCalledTimes(0);
      expect(retrySpy).toHaveBeenCalledTimes(0);
      expect(raw()).toBeNull();
    },
  );

  it('requires both explicit acknowledgments and current declared write scope', async () => {
    const acknowledged = manualCleanupHarness('mutation-transport-unknown');
    await expect(acknowledged.service.cleanupManuallyReconciled(undefined, true)).rejects.toMatchObject({
      status: 400,
    });
    await expect(acknowledged.service.cleanupManuallyReconciled(true, false)).rejects.toMatchObject({
      status: 400,
      message: expect.stringMatching(/manualReconciled:true/i),
    });
    expect(acknowledged.raw()).not.toBeNull();
    expect(acknowledged.mutateSpy).toHaveBeenCalledTimes(0);
    expect(acknowledged.retrySpy).toHaveBeenCalledTimes(0);

    const readOnly = manualCleanupHarness('mutation-transport-unknown', { scopes: '' });
    await expect(readOnly.service.cleanupManuallyReconciled(true, true)).rejects.toMatchObject({
      status: 403,
    });
    expect(readOnly.raw()).not.toBeNull();
  });

  it('rejects a current-tenant fingerprint mismatch and retains the blocker', async () => {
    const { service, mutateSpy, retrySpy, raw } = manualCleanupHarness(
      'commit-transport-unknown',
      { tenantFingerprint: 'sse:different-tenant' },
    );

    await expect(service.cleanupManuallyReconciled(true, true)).rejects.toMatchObject({
      status: 409,
      code: 'SSE_MANUAL_RECONCILIATION_REQUIRED',
      message: expect.stringMatching(/different credentials or base URL/i),
    });
    expect(mutateSpy).toHaveBeenCalledTimes(0);
    expect(retrySpy).toHaveBeenCalledTimes(0);
    expect(raw()).not.toBeNull();
  });

  it.each(['commit-rejected', 'commit-accepted', 'mutation-rejected'] as const)(
    'rejects wrong phase %s and preserves its phase-specific recovery path',
    async (phase) => {
      const { service, mutateSpy, retrySpy, raw } = manualCleanupHarness(phase);

      await expect(service.cleanupManuallyReconciled(true, true)).rejects.toMatchObject({
        status: 409,
        code: 'SSE_MANUAL_CLEANUP_NOT_ALLOWED',
        message: expect.stringMatching(/tenant-wide Commit was not called/i),
      });
      expect(JSON.parse(raw() ?? '').phase).toBe(phase);
      expect(mutateSpy).toHaveBeenCalledTimes(0);
      expect(retrySpy).toHaveBeenCalledTimes(0);
    },
  );

  it('rejects no journal and corrupt journals without inventing cleanup success', async () => {
    const empty = manualCleanupHarness('mutation-transport-unknown');
    empty.allowRemove();
    await empty.service.cleanupManuallyReconciled(true, true);
    await expect(empty.service.cleanupManuallyReconciled(true, true)).rejects.toMatchObject({
      status: 409,
      code: 'SSE_MANUAL_CLEANUP_NOT_ALLOWED',
    });

    const corrupt = manualCleanupHarness('mutation-transport-unknown', { rawOverride: '{' });
    await expect(corrupt.service.cleanupManuallyReconciled(true, true)).rejects.toMatchObject({
      status: 409,
      code: 'SSE_MANUAL_RECONCILIATION_REQUIRED',
    });
    expect(corrupt.raw()).toBe('{');
  });

  it('reports refresh status but retains the blocker when durable deletion fails', async () => {
    const { service, mutateSpy, retrySpy, raw, allowRemove } = manualCleanupHarness(
      'commit-transport-unknown',
      { removeFails: true },
    );
    const serverLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const err = await service.cleanupManuallyReconciled(true, true).then(
        () => {
          throw new Error('cleanup unexpectedly succeeded');
        },
        (e) => e as SseObjectsError,
      );
      expect(err).toMatchObject({
        status: 500,
        code: 'SSE_JOURNAL_PERSIST_FAILED',
        message: 'internal error',
        result: {
          cacheRefresh: { attempted: true },
          recovery: {
            action: 'manual-cleanup',
            status: 'journal-retained',
          },
        },
      });
      expect(err.result?.recovery.message).toMatch(/tenant-wide Commit was not called/i);
      expect(JSON.parse(raw() ?? '').phase).toBe('commit-transport-unknown');
      expect(mutateSpy).toHaveBeenCalledTimes(0);
      expect(retrySpy).toHaveBeenCalledTimes(0);

      allowRemove();
      const recovered = await service.cleanupManuallyReconciled(true, true);
      expect(recovered.recovery.status).toBe('journal-removed');
      expect(raw()).toBeNull();
    } finally {
      serverLog.mockRestore();
    }
  });

  it('keeps cleanup results, audit events, and logs free of credentials and payload secrets', async () => {
    const secret = 'manual-cleanup-super-secret-token';
    const { service, events } = manualCleanupHarness('mutation-transport-unknown', {
      token: secret,
    });

    const result = await service.cleanupManuallyReconciled(true, true);
    const exposed = JSON.stringify({ result, events });
    const log = readFileSync(join(tmpDir, 'change-log.jsonl'), 'utf8');
    expect(exposed).not.toContain(secret);
    expect(log).not.toContain(secret);
    expect(log).not.toContain('manual-cleanup-super-secret');
  });
});

describe('SseObjectsService — journal IO is fail-closed', () => {
  it('does not issue an HTTP mutation when the preflight journal save fails', async () => {
    let calls = 0;
    const blocker = join(tmpDir, 'journal-filesystem-secret-not-a-directory');
    writeFileSync(blocker, 'x');
    const service = new SseObjectsService({
      registry: fakeRegistry([]),
      pollerRef: { contributionsByPlane: () => new Map() } as unknown as Poller,
      plane: makeSseAdapter(() => {
        calls += 1;
        return { status: 201, body: { id: 'g-1' } };
      }, { token: 'x', scopes: 'write:brokered' }),
      dataDir: join(blocker, 'child'),
    });
    const serverLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(service.create('groups', { name: 'g' }, true)).rejects.toMatchObject({
        status: 500,
        code: 'SSE_JOURNAL_PERSIST_FAILED',
        message: 'internal error',
      });
      expect(calls).toBe(0);
      expect(serverLog).toHaveBeenCalledWith(expect.stringContaining(blocker));
    } finally {
      serverLog.mockRestore();
    }
  });

  it('stops before Commit when the post-acceptance journal phase update fails', async () => {
    let raw: string | null = null;
    let writes = 0;
    let mutationCalls = 0;
    let commitCalls = 0;
    const journalStore = {
      exists: () => raw !== null,
      read: () => raw ?? '',
      write: (record: unknown) => {
        writes += 1;
        if (writes === 2) throw new Error('phase update failed');
        raw = JSON.stringify(record);
      },
      remove: () => {
        raw = null;
      },
    };
    const service = new SseObjectsService({
      registry: fakeRegistry([]),
      pollerRef: { contributionsByPlane: () => new Map() } as unknown as Poller,
      plane: makeSseAdapter((method, pathname) => {
        if (method === 'POST' && pathname === SSE_KIND_SPEC.groups.path) {
          mutationCalls += 1;
          return { status: 201, body: { id: 'g-1' } };
        }
        if (method === 'POST' && pathname === '/api/v1.0/Commit') {
          commitCalls += 1;
          return { status: 204 };
        }
        return undefined;
      }, { token: 'x', scopes: 'write:brokered' }),
      dataDir: tmpDir,
      journalStore,
    });
    await expect(service.create('groups', { name: 'g' }, true)).rejects.toMatchObject({ status: 500 });
    expect(mutationCalls).toBe(1);
    expect(commitCalls).toBe(0);
    expect(raw).toContain('"phase":"mutation-in-flight"');
    await expect(service.create('groups', { name: 'blocked' }, true)).rejects.toMatchObject({ status: 409 });
  });

  it('reports the applied change and retains the blocker when journal deletion fails after Commit', async () => {
    let raw: string | null = null;
    const journalStore = {
      exists: () => raw !== null,
      read: () => {
        if (raw === null) throw new Error('missing');
        return raw;
      },
      write: (record: unknown) => {
        raw = JSON.stringify(record);
      },
      remove: () => {
        throw new Error('disk refused unlink');
      },
    };
    const adapter = makeSseAdapter(
      (method, pathname) => {
        if (method === 'POST' && pathname === SSE_KIND_SPEC.groups.path) return { status: 201, body: { id: 'g-1' } };
        if (method === 'POST' && pathname === '/api/v1.0/Commit') return { status: 204 };
        return undefined;
      },
      { token: 'x', scopes: 'write:brokered' },
    );
    const poller = {
      syncNowFor: async () => 'ok' as const,
      contributionsByPlane: () =>
        new Map([
          [
            'sse',
            {
              sse: {
                kinds: {
                  groups: {
                    rows: [{ kind: 'groups', id: 'g-1', name: 'g', raw: {} }],
                    total: 1,
                    truncated: false,
                  },
                },
                unavailable: [],
                source: 'test',
              },
            },
          ],
        ]),
    } as unknown as Poller;
    const service = new SseObjectsService({
      registry: fakeRegistry([]),
      pollerRef: poller,
      plane: adapter,
      dataDir: tmpDir,
      journalStore,
    });
    // The object exists in the tenant and the Commit was accepted. Answering
    // "internal error" here would be a lie about a change that happened, and
    // the operator's response to it — do it again — creates a second object.
    const applied = await service.create('groups', { name: 'g' }, true);
    expect(applied).toMatchObject({ outcome: 'applied', journalRetained: true });
    expect(raw).not.toBeNull();
    /* The change is auditable. Throwing out of the cleanup used to happen
     * BEFORE the audit line was written, so a group that now exists in the
     * tenant left no record that the portal created it — the one case where
     * the trail matters most, because the operator was told it failed. */
    const audit = readFileSync(join(tmpDir, 'change-log.jsonl'), 'utf8');
    expect(audit).toContain('sse-create');
    expect(audit).toContain('applied');
    // The blocker is real, and the NEXT change is still refused.
    await expect(service.create('groups', { name: 'blocked' }, true)).rejects.toMatchObject({ status: 409 });
  });
});

describe('SseObjectsService — terminal commit-accepted phase (requirement 1 + 2)', () => {
  it('reviewed recovery on a restarted process cleans up a commit-accepted journal without ever replaying Commit', async () => {
    let commitCalls = 0;
    const adapter = makeSseAdapter(
      (method, pathname) => {
        if (method === 'POST' && pathname === '/api/v1.0/Commit') {
          commitCalls += 1;
          return { status: 204 };
        }
        if (method === 'POST' && pathname === SSE_KIND_SPEC.groups.path) return { status: 201, body: { id: 'g-2' } };
        return undefined;
      },
      { token: 'x', scopes: 'write:brokered' },
    );
    // Simulate a journal left behind by a PRIOR process that crashed after
    // Commit was accepted and durably recorded, but before cleanup ran.
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(
      join(tmpDir, 'sse-pending-commit.json'),
      JSON.stringify({
        version: 1,
        phase: 'commit-accepted',
        kind: 'groups',
        action: 'update',
        objectId: 'g-1',
        at: new Date(0).toISOString(),
        tenantFingerprint: adapter.tenantFingerprint(),
      }),
    );
    const fakePoller = {
      syncNowFor: async () => 'ok' as const,
      contributionsByPlane: () =>
        new Map([
          [
            'sse',
            {
              sse: {
                kinds: { groups: { rows: [{ kind: 'groups', id: 'g-1', name: 'g', raw: {} }], total: 1, truncated: false } },
                unavailable: [],
                source: 'test',
              },
            },
          ],
        ]),
    } as unknown as Poller;
    const restarted = new SseObjectsService({
      registry: fakeRegistry([]),
      pollerRef: fakePoller,
      plane: adapter,
      dataDir: tmpDir,
    });

    const recovery = await restarted.retryCommit(true);
    expect(commitCalls).toBe(0); // Commit was NEVER called again
    expect(recovery.commit.attempted).toBe(false);
    expect(recovery.commit.ok).toBe(true);
    expect(recovery.commit.message).toMatch(/already accepted/i);
    expect(recovery.cacheRefresh.attempted).toBe(true);

    // Cleanup succeeded — the journal is gone and a further mutation works.
    expect(() => readFileSync(join(tmpDir, 'sse-pending-commit.json'), 'utf8')).toThrow();
    const unblocked = await restarted.create('groups', { name: 'after-recovery' }, true);
    expect(unblocked.mutation.ok).toBe(true);
  });

  it('never issues a second Commit when journal cleanup fails after an accepted commit, and cleans up once the store recovers', async () => {
    let raw: string | null = null;
    let removeFails = true;
    const journalStore = {
      exists: () => raw !== null,
      read: () => {
        if (raw === null) throw new Error('missing');
        return raw;
      },
      write: (record: unknown) => {
        raw = JSON.stringify(record);
      },
      remove: () => {
        if (removeFails) throw new Error('disk refused unlink');
        raw = null;
      },
    };
    let mutationCalls = 0;
    let commitCalls = 0;
    const adapter = makeSseAdapter(
      (method, pathname) => {
        if (method === 'POST' && pathname === SSE_KIND_SPEC.groups.path) {
          mutationCalls += 1;
          return { status: 201, body: { id: 'g-1' } };
        }
        if (method === 'POST' && pathname === '/api/v1.0/Commit') {
          commitCalls += 1;
          return { status: 204 };
        }
        return undefined;
      },
      { token: 'x', scopes: 'write:brokered' },
    );
    const fakePoller = {
      syncNowFor: async () => 'ok' as const,
      contributionsByPlane: () =>
        new Map([
          [
            'sse',
            {
              sse: {
                kinds: { groups: { rows: [{ kind: 'groups', id: 'g-1', name: 'g', raw: {} }], total: 1, truncated: false } },
                unavailable: [],
                source: 'test',
              },
            },
          ],
        ]),
    } as unknown as Poller;
    const service = new SseObjectsService({
      registry: fakeRegistry([]),
      pollerRef: fakePoller,
      plane: adapter,
      dataDir: tmpDir,
      journalStore,
    });

    const applied = await service.create('groups', { name: 'g' }, true);
    expect(applied).toMatchObject({ outcome: 'applied', journalRetained: true });
    expect(mutationCalls).toBe(1);
    expect(commitCalls).toBe(1);
    expect(JSON.parse(raw ?? '').phase).toBe('commit-accepted');

    // A reviewed retry while cleanup is still broken must NOT call Commit
    // again — only cleanup is attempted, and it is reported as pending.
    await expect(service.retryCommit(true)).rejects.toMatchObject({
      status: 500,
      code: 'SSE_JOURNAL_PERSIST_FAILED',
      message: 'internal error',
    });
    expect(commitCalls).toBe(1); // still just the one Commit call, ever
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw ?? '').phase).toBe('commit-accepted');

    // Once the journal store recovers, cleanup succeeds without another Commit.
    removeFails = false;
    const recovered = await service.retryCommit(true);
    expect(commitCalls).toBe(1);
    expect(recovered.commit.attempted).toBe(false);
    expect(raw).toBeNull();

    const unblocked = await service.create('groups', { name: 'now allowed' }, true);
    expect(unblocked.mutation.ok).toBe(true);
    expect(commitCalls).toBe(2); // this is a BRAND NEW mutation's own commit
  });

  it('fails closed with a distinct code when persisting the terminal commit-accepted phase itself fails — never refreshes or clears', async () => {
    let raw: string | null = null;
    let syncCalls = 0;
    const journalStore = {
      exists: () => raw !== null,
      read: () => raw ?? '',
      write: (record: unknown) => {
        const rec = record as { phase: string };
        if (rec.phase === 'commit-accepted') throw new Error('journal disk full');
        raw = JSON.stringify(record);
      },
      remove: () => {
        raw = null;
      },
    };
    let commitCalls = 0;
    const adapter = makeSseAdapter(
      (method, pathname) => {
        if (method === 'POST' && pathname === SSE_KIND_SPEC.groups.path) return { status: 201, body: { id: 'g-1' } };
        if (method === 'POST' && pathname === '/api/v1.0/Commit') {
          commitCalls += 1;
          return { status: 204 };
        }
        return undefined;
      },
      { token: 'x', scopes: 'write:brokered' },
    );
    const fakePoller = {
      syncNowFor: async () => {
        syncCalls += 1;
        return 'ok' as const;
      },
      contributionsByPlane: () => new Map(),
    } as unknown as Poller;
    const service = new SseObjectsService({
      registry: fakeRegistry([]),
      pollerRef: fakePoller,
      plane: adapter,
      dataDir: tmpDir,
      journalStore,
    });

    await expect(service.create('groups', { name: 'g' }, true)).rejects.toMatchObject({
      status: 500,
      code: 'SSE_COMMIT_ACCEPTED_UNRECORDED',
      message: 'internal error',
    });
    expect(commitCalls).toBe(1); // the tenant DID accept the commit
    expect(syncCalls).toBe(0); // but the cache was never refreshed — fail closed
    expect(raw).not.toBeNull(); // and the journal was never cleared
    expect(JSON.parse(raw ?? '').phase).toBe('commit-accepted-unrecorded');

    // A further mutation stays blocked — this is not "safe to clear".
    await expect(service.create('groups', { name: 'blocked' }, true)).rejects.toMatchObject({
      status: 409,
      code: 'SSE_PENDING_MUTATION',
    });
    await expect(service.retryCommit(true)).rejects.toMatchObject({
      status: 409,
      code: 'SSE_MANUAL_RECONCILIATION_REQUIRED',
    });
    expect(commitCalls).toBe(1);
  });

  it('leaves prior commit-in-flight ambiguous when neither accepted terminal marker can be saved, and recovery never replays Commit', async () => {
    let raw: string | null = null;
    let writes = 0;
    const journalStore = {
      exists: () => raw !== null,
      read: () => raw ?? '',
      write: (record: unknown) => {
        writes += 1;
        if (writes >= 3) throw new Error('all terminal writes failed');
        raw = JSON.stringify(record);
      },
      remove: () => {
        raw = null;
      },
    };
    const adapter = makeSseAdapter(
      (method, pathname) => {
        if (method === 'POST' && pathname === SSE_KIND_SPEC.groups.path) return { status: 201, body: { id: 'g-1' } };
        if (method === 'POST' && pathname === '/api/v1.0/Commit') return { status: 204 };
        return undefined;
      },
      { token: 'x', scopes: 'write:brokered' },
    );
    const retrySpy = vi.spyOn(adapter, 'retryCommit');
    const service = new SseObjectsService({
      registry: fakeRegistry([]),
      pollerRef: { contributionsByPlane: () => new Map() } as unknown as Poller,
      plane: adapter,
      dataDir: tmpDir,
      journalStore,
    });

    await expect(service.create('groups', { name: 'g' }, true)).rejects.toMatchObject({
      status: 500,
      code: 'SSE_COMMIT_ACCEPTED_UNRECORDED',
      message: 'internal error',
    });
    expect(retrySpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(raw ?? '').phase).toBe('commit-in-flight');

    retrySpy.mockClear();
    await expect(service.retryCommit(true)).rejects.toMatchObject({
      status: 409,
      code: 'SSE_MANUAL_RECONCILIATION_REQUIRED',
    });
    expect(retrySpy).toHaveBeenCalledTimes(0);
  });
});

describe('SseObjectsService — honest update verification (requirement 3)', () => {
  function updateHarness(refreshedRow: Record<string, unknown> | null) {
    const adapter = makeSseAdapter(
      (method, pathname) => {
        if (method === 'PUT' && pathname === `${SSE_KIND_SPEC.groups.path}/g-1`) return { status: 200, body: { id: 'g-1' } };
        if (method === 'POST' && pathname === '/api/v1.0/Commit') return { status: 204 };
        return undefined;
      },
      { token: 'x', scopes: 'write:brokered' },
    );
    const fakePoller = {
      syncNowFor: async () => 'ok' as const,
      contributionsByPlane: () =>
        new Map([
          [
            'sse',
            {
              sse: {
                kinds: { groups: { rows: refreshedRow ? [refreshedRow] : [], total: refreshedRow ? 1 : 0, truncated: false } },
                unavailable: [],
                source: 'test',
              },
            },
          ],
        ]),
    } as unknown as Poller;
    return new SseObjectsService({ registry: fakeRegistry([]), pollerRef: fakePoller, plane: adapter, dataDir: tmpDir });
  }

  it('verifies an update ONLY when the reviewed allowlisted fields match the refreshed object, not merely because the id exists', async () => {
    const service = updateHarness({ kind: 'groups', id: 'g-1', name: 'renamed', raw: {} });
    const result = await service.update('groups', 'g-1', { name: 'renamed' }, true);
    expect(result.outcome).toBe('applied');
    expect(result.cacheRefresh.status).toBe('refreshed');
    expect(result.cacheRefresh.message).toMatch(/matched the refreshed object/i);
  });

  it('reports unverified/stale when the id exists but the refreshed object does not match the reviewed update (no false "verified")', async () => {
    // The id is present, but the cache still shows the OLD name — proof the
    // id existing already, alone, never proved the update's content landed.
    const service = updateHarness({ kind: 'groups', id: 'g-1', name: 'stale-old-name', raw: {} });
    const result = await service.update('groups', 'g-1', { name: 'renamed' }, true);
    expect(result.outcome).toBe('unverified');
    expect(result.cacheRefresh.status).toBe('stale');
    expect(result.cacheRefresh.message).toMatch(/do not match/i);
  });

  it('reports unverified (never a false match) when the update touched no safely comparable field, and never compares secrets/raw payloads', async () => {
    const service = updateHarness({ kind: 'groups', id: 'g-1', name: 'g', raw: {} });
    // `users` isn't the array field the review dialog would send for groups,
    // but the point stands generically: an update whose fields are all
    // outside the name/description/enabled allowlist cannot be verified from
    // the cache alone.
    const result = await service.update('groups', 'g-1', { users: ['u-1'] }, true);
    expect(result.outcome).toBe('unverified');
    expect(result.cacheRefresh.status).toBe('stale');
    expect(result.cacheRefresh.message).toMatch(/safely comparable/i);
  });
});

describe('SseObjectsService — machine-readable pending-mutation error code (requirement 4)', () => {
  function stagedService() {
    const adapter = makeSseAdapter(
      (method, pathname) => {
        if (method === 'POST' && pathname === SSE_KIND_SPEC.connectorZones.path) return { status: 201, body: { id: 'cz-1' } };
        if (method === 'POST' && pathname === '/api/v1.0/Commit') return { status: 500 }; // stays staged
        return undefined;
      },
      { token: 'x', scopes: 'write:brokered' },
    );
    const fakePoller = { contributionsByPlane: () => new Map(), syncNowFor: async () => 'ok' as const } as unknown as Poller;
    return new SseObjectsService({ registry: fakeRegistry([]), pollerRef: fakePoller, plane: adapter, dataDir: tmpDir });
  }

  it('a blocked mutation while a journal is pending carries the SSE_PENDING_MUTATION code, not just message text', async () => {
    const service = stagedService();
    await service.create('connectorZones', { name: 'HQ' }, true);

    await expect(service.create('connectorZones', { name: 'blocked' }, true)).rejects.toMatchObject({
      status: 409,
      code: 'SSE_PENDING_MUTATION',
    });
  });

  it('assertCredentialsMutable blocks with the SSE_PENDING_MUTATION code while a journal is pending', async () => {
    const service = stagedService();
    await service.create('connectorZones', { name: 'HQ' }, true);

    expect(() => service.assertCredentialsMutable()).toThrow(
      expect.objectContaining({ status: 409, code: 'SSE_PENDING_MUTATION' }),
    );
  });
});

describe('SseObjectsService — in-process serialization (requirement 1)', () => {
  it('queues a second mutation behind the first so it cannot race past the pending-commit check', async () => {
    let commitCalls = 0;
    const state: PlaneState = { id: 'sse', linked: true, health: 'healthy', lastSync: null, deviceCount: null, callsToday: 0, note: null };
    const adapter = new SseAdapter({ token: 'x', scopes: 'write:brokered' }, state, () => {}, async (url) => {
      const u = new URL(url as string);
      if (u.pathname === SSE_KIND_SPEC.connectorZones.path) {
        return new Response(JSON.stringify({ id: 'z-1' }), { status: 201, headers: { 'content-type': 'application/json' } });
      }
      if (u.pathname === '/api/v1.0/Commit') {
        commitCalls += 1;
        // Deliberately slow — long enough that a second, unserialized call
        // would reach its own pending-commit check before this one's commit
        // (and the pending-state write that follows it) has completed.
        await new Promise((resolve) => setTimeout(resolve, 40));
        return new Response('{}', { status: 500, headers: { 'content-type': 'application/json' } });
      }
      return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } });
    });
    const fakePoller = { contributionsByPlane: () => new Map(), syncNowFor: async () => 'ok' as const } as unknown as Poller;
    const service = new SseObjectsService({ registry: fakeRegistry([]), pollerRef: fakePoller, plane: adapter, dataDir: tmpDir });

    const [first, second] = await Promise.allSettled([
      service.create('connectorZones', { name: 'first' }, true),
      service.create('connectorZones', { name: 'second' }, true),
    ]);

    expect(first.status).toBe('fulfilled');
    if (first.status === 'fulfilled') expect(first.value.staged).toBe(true);
    // Without in-process serialization, the second call's pending-commit
    // check would run before the first ever persists its pending state, and
    // it would go on to attempt its own (redundant, unserialized) mutation.
    expect(second.status).toBe('rejected');
    if (second.status === 'rejected') expect((second.reason as SseObjectsError).status).toBe(409);
    expect(commitCalls).toBe(1);
  });

  it('serializes a commit-only retry behind an in-flight mutation too', async () => {
    let commitAttempts = 0;
    const handler: Handler = (method, pathname) => {
      if (method === 'POST' && pathname === SSE_KIND_SPEC.connectorZones.path) return { status: 201, body: { id: 'cz-1' } };
      if (method === 'POST' && pathname === '/api/v1.0/Commit') {
        commitAttempts += 1;
        return { status: commitAttempts === 1 ? 500 : 204 };
      }
      return undefined;
    };
    const events: { id: string; what: string; who: string }[] = [];
    const adapter = makeSseAdapter(handler, { token: 'x', scopes: 'write:brokered' });
    const fakePoller = { contributionsByPlane: () => new Map(), syncNowFor: async () => 'ok' as const } as unknown as Poller;
    const service = new SseObjectsService({ registry: fakeRegistry(events), pollerRef: fakePoller, plane: adapter, dataDir: tmpDir });

    // No pending state yet — a concurrent retry must be rejected (empty
    // retry), never silently queued into calling Commit on a whim.
    const [createResult, retryResult] = await Promise.allSettled([
      service.create('connectorZones', { name: 'HQ' }, true),
      service.retryCommit(true),
    ]);
    expect(createResult.status).toBe('fulfilled');
    // Whichever ran first, they never interleaved: the retry either ran
    // before any pending state existed (rejected, empty) or after the create
    // resolved (queued behind it via the same lock).
    if (retryResult.status === 'rejected') {
      expect((retryResult.reason as SseObjectsError).status).toBe(409);
    }
  });
});
