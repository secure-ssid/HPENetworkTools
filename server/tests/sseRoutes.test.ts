/**
 * server/tests/sseRoutes.test.ts — HPE Aruba Networking SSE end-to-end route
 * tests, in-process app + a real mock SSE Admin API on an ephemeral port.
 *
 * Same isolation pattern as routes.test.ts / systems.test.ts: HPE_SETTINGS_PATH
 * and HPE_DATA_DIR point at a fresh tmp dir, set BEFORE any server module is
 * imported (dynamic import inside beforeAll), so no test here ever touches the
 * real data/settings.json or makes a live call to admin-api.axissecurity.com.
 */

import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PlaneState } from '../src/planes/types';
import { SSE_INSECURE_HTTP_OVERRIDE_ENV, SSE_KIND_SPEC, SseAdapter } from '../src/planes/sse';

let server: Server;
let base: string;
let tmpDir: string;
let dataDir: string;
let mockSse: Server;
let mockSseBase: string;
const mockSseToken = 'sse-e2e-token';
let commitFails = false;
let commitCalls = 0;
let mutationCalls = 0;
let allReadsStatus: number | null = null;
let previousSseHttpOverride: string | undefined;

function jsonPage(rows: unknown[]): string {
  return JSON.stringify({ data: rows, totalRecords: rows.length, totalPages: 1 });
}

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'hpe-sse-routes-'));
  process.env.HPE_SETTINGS_PATH = join(tmpDir, 'settings.json');
  dataDir = join(tmpDir, 'data-filesystem-secret-marker');
  process.env.HPE_DATA_DIR = dataDir;
  previousSseHttpOverride = process.env[SSE_INSECURE_HTTP_OVERRIDE_ENV];
  process.env[SSE_INSECURE_HTTP_OVERRIDE_ENV] = '1';
  const { createApp } = await import('../src/index');
  server = createApp().listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  // A tiny fake SSE Admin API: nine collections, a create/update/delete on
  // ConnectorZones, and /Commit — everything else answers 404.
  const zones = new Map<string, Record<string, unknown>>([['cz-1', { id: 'cz-1', name: 'HQ zone', connectors: [] }]]);
  mockSse = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    res.setHeader('content-type', 'application/json');
    const auth = req.headers.authorization;
    if (auth !== `Bearer ${mockSseToken}`) {
      res.statusCode = 401;
      res.end('{}');
      return;
    }
    if (
      allReadsStatus !== null &&
      req.method === 'GET' &&
      Object.values(SSE_KIND_SPEC).some((spec) => spec.path === url.pathname)
    ) {
      res.statusCode = allReadsStatus;
      res.end(JSON.stringify({ error: 'vendor body must remain private' }));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/v1.0/ConnectorZones') {
      res.end(jsonPage([...zones.values()]));
      return;
    }
    if (req.method === 'GET' && ['/api/v1.0/Connectors', '/api/v1.0/Users', '/api/v1.0/Groups', '/api/v1.0/IpCategories', '/api/v1.0/IpCategoriesFeed'].includes(url.pathname)) {
      res.end(jsonPage([]));
      return;
    }
    // Locations/Tunnels/Applications: limited-release, this tenant is not entitled.
    if (req.method === 'GET' && ['/api/v1.0/Locations', '/api/v1.0/Tunnels', '/api/v1.0/Applications'].includes(url.pathname)) {
      res.statusCode = 404;
      res.end('{}');
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/v1.0/ConnectorZones') {
      mutationCalls += 1;
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const parsed = JSON.parse(body || '{}') as Record<string, unknown>;
        const id = `cz-${zones.size + 1}`;
        zones.set(id, { id, ...parsed });
        res.statusCode = 201;
        res.end(JSON.stringify({ id }));
      });
      return;
    }
    if (req.method === 'DELETE' && url.pathname.startsWith('/api/v1.0/ConnectorZones/')) {
      mutationCalls += 1;
      const id = url.pathname.split('/').pop() as string;
      zones.delete(id);
      res.statusCode = 200;
      res.end('{}');
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/v1.0/Commit') {
      commitCalls += 1;
      if (commitFails) {
        res.statusCode = 500;
        res.end('{}');
        return;
      }
      res.statusCode = 204;
      res.end();
      return;
    }
    res.statusCode = 404;
    res.end('{}');
  });
  mockSse.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => mockSse.once('listening', resolve));
  mockSseBase = `http://127.0.0.1:${(mockSse.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await new Promise<void>((resolve) => mockSse.close(() => resolve()));
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.HPE_SETTINGS_PATH;
  delete process.env.HPE_DATA_DIR;
  if (previousSseHttpOverride === undefined) delete process.env[SSE_INSECURE_HTTP_OVERRIDE_ENV];
  else process.env[SSE_INSECURE_HTTP_OVERRIDE_ENV] = previousSseHttpOverride;
});

async function getJson(path: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${path}`);
  return { status: res.status, body: await res.json() };
}

async function postJson(path: string, method = 'POST', payload?: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload ?? {}),
  });
  return { status: res.status, body: await res.json() };
}

describe('SSE routes — unlinked', () => {
  it('every SSE route answers 409 before any credentials are saved', async () => {
    expect((await getJson('/api/sse/inventory')).status).toBe(409);
    expect((await getJson('/api/sse/objects/connectors')).status).toBe(409);
    expect((await postJson('/api/sse/objects/connectorZones', 'POST', { fields: { name: 'x' }, reviewConfirmed: true })).status).toBe(409);
  });

  it('rejects an unknown object kind before it can reach any adapter method', async () => {
    expect((await getJson('/api/sse/objects/not-a-real-kind')).status).toBe(404);
  });
});

describe('SSE routes — linked, read scope only', () => {
  it('connects with a token and no write scope, syncs, and serves the cached inventory', async () => {
    const save = await postJson('/api/systems/sse/credentials', 'POST', { baseUrl: mockSseBase, token: mockSseToken });
    expect(save.status).toBe(200);
    expect(save.body.state.linked).toBe(true);
    expect(JSON.stringify(save.body)).not.toContain(mockSseToken);

    const sync = await postJson('/api/systems/sync');
    expect(sync.status).toBe(200);
    expect(sync.body.started).toContain('sse');

    const inv = await getJson('/api/sse/inventory');
    expect(inv.status).toBe(200);
    expect(inv.body.kinds.connectorZones.rows).toHaveLength(1);
    expect(inv.body.kinds.connectorZones.rows[0].name).toBe('HQ zone');
    expect(inv.body.unavailable.sort()).toEqual(['applications', 'locations', 'tunnels']);
    expect(inv.body.readStatus.locations).toMatchObject({ state: 'failed', reason: 'unsupported', httpCode: 404 });
    expect(JSON.stringify(inv.body)).not.toContain('vendor body');

    const locations = await getJson('/api/sse/objects/locations');
    expect(locations.body.readStatus).toMatchObject({ state: 'failed', reason: 'unsupported', httpCode: 404 });

    const state = await getJson('/api/systems/state');
    expect(state.body.planes.sse.linked).toBe(true);
    expect(state.body.planes.sse.capabilities.directWrite).toBe(false);
  });

  it('a search filters one kind’s cached rows without an extra live call', async () => {
    const hit = await getJson('/api/sse/objects/connectorZones?q=hq');
    expect(hit.status).toBe(200);
    expect(hit.body.rows).toHaveLength(1);
    const miss = await getJson('/api/sse/objects/connectorZones?q=nope');
    expect(miss.body.rows).toHaveLength(0);
  });

  it('a read-only token is refused a write with 403, never silently downgraded to a no-op', async () => {
    const res = await postJson('/api/sse/objects/connectorZones', 'POST', { fields: { name: 'Should fail' }, reviewConfirmed: true });
    expect(res.status).toBe(403);
  });
});

describe('SSE routes — linked with a declared write scope', () => {
  it('re-keys with write scope declared, then create → commit → cache refresh, all visible in one round trip', async () => {
    const save = await postJson('/api/systems/sse/credentials', 'POST', {
      baseUrl: mockSseBase,
      token: mockSseToken,
      scopes: 'read:inventory,write:brokered',
    });
    expect(save.status).toBe(200);

    const create = await postJson('/api/sse/objects/connectorZones', 'POST', {
      fields: { name: 'Branch zone' },
      reviewConfirmed: true,
    });
    expect(create.status).toBe(200);
    expect(create.body.mutation.ok).toBe(true);
    expect(create.body.commit.ok).toBe(true);
    expect(create.body.staged).toBe(false);

    // The route forces a fresh full pull after a successful mutation — the
    // new zone must be visible immediately, not after the next poll tick.
    const inv = await getJson('/api/sse/inventory');
    expect(inv.body.kinds.connectorZones.rows.map((r: any) => r.name)).toContain('Branch zone');

    const log = readFileSync(join(dataDir, 'change-log.jsonl'), 'utf8');
    expect(log).toContain('"kind":"sse:connectorZones"');
    expect(log).toContain('"result":"unverified"');
    expect(log).not.toContain(mockSseToken);
    expect(log).not.toContain('Branch zone');
  });

  it('a mutation without reviewConfirmed:true is refused', async () => {
    const res = await postJson('/api/sse/objects/connectorZones', 'POST', { fields: { name: 'no review' } });
    expect(res.status).toBe(400);
  });

  it('a commit failure stages the change and the retry-commit route never replays the mutation', async () => {
    commitFails = true;
    const create = await postJson('/api/sse/objects/connectorZones', 'POST', {
      fields: { name: 'Staged zone' },
      reviewConfirmed: true,
    });
    expect(create.status).toBe(200);
    expect(create.body.mutation.ok).toBe(true);
    expect(create.body.staged).toBe(true);
    expect(create.body.commit.warning).toContain('tenant-wide');

    // A retry without reviewConfirmed:true is refused, same as a mutation.
    const noReview = await postJson('/api/sse/commit/retry');
    expect(noReview.status).toBe(400);

    const credentialUpdate = await postJson('/api/systems/sse/credentials', 'POST', {
      baseUrl: mockSseBase,
      token: 'replacement-token',
      scopes: 'read:inventory,write:brokered',
    });
    expect(credentialUpdate.status).toBe(409);
    // Machine-readable code, not message-text sniffing — the message stays
    // secret-free and human-readable, but callers key off `code`.
    expect(credentialUpdate.body.code).toBe('SSE_PENDING_MUTATION');
    expect(credentialUpdate.body.error).toMatch(/journal is pending/i);

    const credentialDelete = await postJson('/api/systems/sse', 'DELETE');
    expect(credentialDelete.status).toBe(409);
    expect(credentialDelete.body.code).toBe('SSE_PENDING_MUTATION');

    const settingsBypass = await postJson('/api/settings', 'PUT', { planes: { sse: null } });
    expect(settingsBypass.status).toBe(409);
    expect(settingsBypass.body.code).toBe('SSE_PENDING_MUTATION');

    commitFails = false;
    const retry = await postJson('/api/sse/commit/retry', 'POST', { reviewConfirmed: true });
    expect(retry.status).toBe(200);
    expect(retry.body.commit.ok).toBe(true);
    // This tenant lacks three limited-release kinds, so the full pull is
    // partial and must not claim "refreshed with change".
    expect(retry.body.cacheRefresh.status).toBe('stale');
    expect(retry.body.recovery.mutationVerified).toBe(false);

    // The pending state is cleared, so a further mutation is no longer blocked.
    const another = await postJson('/api/sse/objects/connectorZones', 'POST', {
      fields: { name: 'After retry' },
      reviewConfirmed: true,
    });
    expect(another.status).toBe(200);

    const log = readFileSync(join(dataDir, 'change-log.jsonl'), 'utf8');
    expect(log).toContain('"event":"sse-commit-retry"');
  });

  it('a staged commit blocks further mutations until the retry clears it', async () => {
    commitFails = true;
    const create = await postJson('/api/sse/objects/connectorZones', 'POST', {
      fields: { name: 'Blocking zone' },
      reviewConfirmed: true,
    });
    expect(create.status).toBe(200);
    expect(create.body.staged).toBe(true);

    const blocked = await postJson('/api/sse/objects/connectorZones', 'POST', {
      fields: { name: 'Should be blocked' },
      reviewConfirmed: true,
    });
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe('SSE_PENDING_MUTATION');

    commitFails = false;
    const retry = await postJson('/api/sse/commit/retry', 'POST', { reviewConfirmed: true });
    expect(retry.status).toBe(200);

    const unblocked = await postJson('/api/sse/objects/connectorZones', 'POST', {
      fields: { name: 'Now allowed' },
      reviewConfirmed: true,
    });
    expect(unblocked.status).toBe(200);
  });

  it('a commit-only retry with nothing staged is rejected, not silently applied', async () => {
    const retry = await postJson('/api/sse/commit/retry', 'POST', { reviewConfirmed: true });
    expect(retry.status).toBe(409);
  });

  it('manually reconciles an ambiguous journal through cleanup-only with both acknowledgments and no mutation or Commit', async () => {
    const state: PlaneState = {
      id: 'sse',
      linked: true,
      health: 'healthy',
      lastSync: null,
      deviceCount: null,
      callsToday: 0,
      note: null,
    };
    const fingerprint = new SseAdapter(
      {
        baseUrl: mockSseBase,
        token: mockSseToken,
        scopes: 'read:inventory,write:brokered',
      },
      state,
      () => {},
    ).tenantFingerprint();
    mkdirSync(dataDir, { recursive: true });
    const journalPath = join(dataDir, 'sse-pending-commit.json');
    writeFileSync(
      journalPath,
      JSON.stringify({
        version: 1,
        phase: 'commit-transport-unknown',
        kind: 'connectorZones',
        action: 'update',
        objectId: 'cz-1',
        at: new Date(0).toISOString(),
        tenantFingerprint: fingerprint,
      }),
    );
    const beforeMutationCalls = mutationCalls;
    const beforeCommitCalls = commitCalls;

    const missingAttestation = await postJson('/api/sse/recovery/manual-cleanup', 'POST', {
      reviewConfirmed: true,
    });
    expect(missingAttestation.status).toBe(400);
    expect(readFileSync(journalPath, 'utf8')).toContain('commit-transport-unknown');

    const cleanup = await postJson('/api/sse/recovery/manual-cleanup', 'POST', {
      reviewConfirmed: true,
      manualReconciled: true,
    });

    expect(cleanup.status).toBe(200);
    expect(cleanup.body.commit).toMatchObject({ attempted: false, acceptance: 'not-attempted' });
    expect(cleanup.body.recovery).toMatchObject({
      journalPhase: 'commit-transport-unknown',
      action: 'manual-cleanup',
      status: 'journal-removed',
    });
    expect(cleanup.body.cacheRefresh.attempted).toBe(true);
    expect(cleanup.body.recovery.message).toMatch(/tenant-wide Commit was not called/i);
    expect(mutationCalls).toBe(beforeMutationCalls);
    expect(commitCalls).toBe(beforeCommitCalls);
    expect(JSON.stringify(cleanup.body)).not.toContain(mockSseToken);
    expect(() => readFileSync(journalPath, 'utf8')).toThrow();
  });

  it('caches all-kind failure reasons while degrading the plane and reporting the sync failed', async () => {
    allReadsStatus = 503;
    try {
      const sync = await postJson('/api/systems/sync');
      expect(sync.status).toBe(200);
      expect(sync.body.failed).toContain('sse');

      const inv = await getJson('/api/sse/inventory');
      expect(inv.status).toBe(200);
      expect(Object.keys(inv.body.kinds)).toHaveLength(0);
      expect(inv.body.readStatus.connectorZones).toMatchObject({
        state: 'failed',
        reason: 'service-error',
        httpCode: 503,
      });
      expect(JSON.stringify(inv.body)).not.toContain('vendor body');

      const listing = await getJson('/api/sse/objects/connectorZones');
      expect(listing.body.rows).toEqual([]);
      expect(listing.body.readStatus.reason).toBe('service-error');

      const state = await getJson('/api/systems/state');
      expect(state.body.planes.sse.health).toBe('degraded');
    } finally {
      allReadsStatus = null;
    }
  });

  it('redacts journal filesystem failures across SSE, settings, and systems routes while preserving the code', async () => {
    const save = await postJson('/api/systems/sse/credentials', 'POST', {
      baseUrl: mockSseBase,
      token: mockSseToken,
      scopes: 'read:inventory,write:brokered',
    });
    expect(save.status).toBe(200);

    mkdirSync(dataDir, { recursive: true });
    const savedDataDir = `${dataDir}.saved`;
    renameSync(dataDir, savedDataDir);
    writeFileSync(dataDir, 'not a directory');
    try {
      const responses = [
        await postJson('/api/sse/objects/groups', 'POST', {
          fields: { name: 'must not run' },
          reviewConfirmed: true,
        }),
        await postJson('/api/settings', 'PUT', { planes: { sse: null } }),
        await postJson('/api/systems/sse/credentials', 'POST', { token: 'replacement-token' }),
        await postJson('/api/systems/sse', 'DELETE'),
      ];
      for (const response of responses) {
        expect(response.status).toBe(500);
        expect(response.body).toEqual({
          error: 'internal error',
          code: 'SSE_JOURNAL_PERSIST_FAILED',
        });
        const json = JSON.stringify(response.body);
        expect(json).not.toContain(dataDir);
        expect(json).not.toContain('filesystem-secret-marker');
        expect(json).not.toMatch(/ENOTDIR|EACCES|errno/i);
      }

      const state = await getJson('/api/systems/state');
      const exposedState = JSON.stringify(state.body);
      expect(exposedState).not.toContain(dataDir);
      expect(exposedState).not.toContain('filesystem-secret-marker');
      expect(exposedState).not.toMatch(/ENOTDIR|EACCES|errno/i);

      const audit = readFileSync(join(savedDataDir, 'change-log.jsonl'), 'utf8');
      expect(audit).not.toContain(dataDir);
      expect(audit).not.toContain('filesystem-secret-marker');
      expect(audit).not.toMatch(/ENOTDIR|EACCES|errno/i);
    } finally {
      unlinkSync(dataDir);
      renameSync(savedDataDir, dataDir);
    }
  });
});
