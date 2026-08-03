/**
 * server/tests/clearpassDirectWrite.test.ts — the ClearPass reviewed
 * direct-write pipeline (endpoint register/update, local-user create/update).
 *
 * Service-level tests inject a stub ClearPassWritePlane (structural — the
 * same pattern ssidDirectWrite.test.ts uses for SsidWritePlane) so no real
 * ClearPassAdapter/HTTP/token machinery is needed, and every service
 * instantiation passes an explicit `plane` (even `null`) so it NEVER falls
 * through to the process registry. Route-level tests boot createApp() the
 * same way ssidDirectWrite.test.ts does: HPE_SETTINGS_PATH / HPE_DATA_DIR
 * are set before ANY server module is evaluated, and every server-module
 * import below is dynamic, inside beforeAll, AFTER the env vars are set —
 * a static top-level import would construct the settings/registry
 * singletons against the real developer install's data/settings.json.
 *
 * Password secrecy is proved, not asserted: the local-user tests write a
 * canary password through success AND failure paths and then read the audit
 * log back — it must appear in neither the log, the result message, nor any
 * error the client receives.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  ClearPassEndpointRegisterForm,
  ClearPassLocalUserCreateForm,
  ClearPassWriteResult,
} from '@hpe/shared';
import type {
  ClearPassDirectWriteError as ClearPassDirectWriteErrorType,
  ClearPassWritePlane,
} from '../src/services/clearpassDirectWrite';

let ClearPassDirectWriteService: typeof import('../src/services/clearpassDirectWrite').ClearPassDirectWriteService;
let ClearPassDirectWriteError: typeof ClearPassDirectWriteErrorType;
let createApp: typeof import('../src/index').createApp;

let tmpDir: string;
let server: Server;
let base: string;

let dirCounter = 0;
function freshDataDir(): string {
  return join(tmpDir, `d${dirCounter++}`);
}

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'hpe-cppm-write-'));
  process.env.HPE_SETTINGS_PATH = join(tmpDir, 'settings.json');
  process.env.HPE_DATA_DIR = join(tmpDir, 'data');
  ({ ClearPassDirectWriteService, ClearPassDirectWriteError } = await import('../src/services/clearpassDirectWrite'));
  ({ createApp } = await import('../src/index'));
  server = createApp().listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.HPE_SETTINGS_PATH;
  delete process.env.HPE_DATA_DIR;
});

const REGISTER_FORM: ClearPassEndpointRegisterForm = {
  mac: '3C-22-FB-41-0A-19',
  description: 'Ward 3E infusion pump',
  status: 'Known',
  attributes: { Category: 'Computer' },
};

const CREATE_USER_FORM: ClearPassLocalUserCreateForm = {
  userId: 'noc-operator',
  username: 'NOC Operator',
  roleName: 'IT admin', // a CLEARPASS_ROLES fixture name — the demo inventory
  enabled: true,
  password: 'canary-p@ssw0rd-never-logged',
};

const APPLIED: ClearPassWriteResult = {
  ok: true,
  action: 'created',
  verified: true,
  httpCode: 201,
  message: 'endpoint registered and confirmed in the repository read-back (HTTP 201)',
};

function stubPlane(overrides: Partial<ClearPassWritePlane> = {}): ClearPassWritePlane {
  return {
    registerEndpoint: async () => ({ ...APPLIED }),
    updateEndpoint: async () => ({ ...APPLIED, action: 'updated', httpCode: 200 }),
    createLocalUser: async () => ({ ...APPLIED }),
    updateLocalUser: async () => ({ ...APPLIED, action: 'updated', httpCode: 200 }),
    ...overrides,
  };
}

/** Structural stand-in for the poller: only the two methods the write path
 *  uses, keyed 'clearpass' like the real contributions map. */
function fakePoller(opts: { tick?: string; sections?: Record<string, unknown>; throws?: boolean } = {}) {
  const syncCalls: string[] = [];
  const poller = {
    syncNowFor: async (plane: string) => {
      syncCalls.push(plane);
      if (opts.throws) throw new Error('https://cppm.example/api/oauth?secret=abc exploded');
      return opts.tick ?? 'ok';
    },
    contributionsByPlane: () => new Map([['clearpass', opts.sections ?? { endpoints: [] }]]),
  } as unknown as import('../src/services/poller').Poller;
  return { poller, syncCalls };
}

function makeService(
  plane: ClearPassWritePlane | null,
  opts: {
    demo?: boolean;
    pollerOpts?: Parameters<typeof fakePoller>[0];
    dataDir?: string;
    allowsLabDirectWrites?: () => boolean;
  } = {},
) {
  const { poller, syncCalls } = fakePoller(opts.pollerOpts);
  const dataDir = opts.dataDir ?? freshDataDir();
  const service = new ClearPassDirectWriteService({
    plane,
    pollerRef: poller,
    dataDir,
    demoMode: () => opts.demo ?? false,
    allowsLabDirectWrites: opts.allowsLabDirectWrites,
    nowMs: () => 1_753_000_000_000,
  });
  return { service, dataDir, syncCalls };
}

/** The audit lines a test's data dir collected. */
function auditLines(dataDir: string): Array<Record<string, unknown>> {
  try {
    return readFileSync(join(dataDir, 'change-log.jsonl'), 'utf8')
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  } catch {
    return [];
  }
}

async function postJson(path: string, body: unknown, method = 'POST'): Promise<{ status: number; body: unknown }> {
  const r = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}

// -- the review gate ------------------------------------------------------------

describe('the review gate', () => {
  it('applies without reviewConfirmed in lab-direct mode', async () => {
    const { service } = makeService(stubPlane(), { allowsLabDirectWrites: () => true });
    await expect(service.registerEndpoint(REGISTER_FORM, undefined)).resolves.toMatchObject({ ok: true, action: 'created' });
  });

  it('refuses every write without an explicit reviewConfirmed:true when hardened mode is enabled', async () => {
    const { service } = makeService(stubPlane(), { allowsLabDirectWrites: () => false });
    for (const attempt of [
      () => service.registerEndpoint(REGISTER_FORM, undefined),
      () => service.registerEndpoint(REGISTER_FORM, 'yes'),
      () => service.updateEndpoint('301', { status: 'Disabled' }, false),
      () => service.createLocalUser(CREATE_USER_FORM, null),
      () => service.updateLocalUser('lu-1', { enabled: false }, 1),
    ]) {
      await expect(attempt()).rejects.toMatchObject({
        name: 'ClearPassDirectWriteError',
        status: 400,
        message: 'direct ClearPass writes require an explicit review confirmation',
      });
    }
  });
});

// -- form validation ------------------------------------------------------------

describe('form validation', () => {
  it('refuses a MAC that is not 12 hex digits, and normalises one that is', async () => {
    const plane = stubPlane();
    const { service } = makeService(plane);
    await expect(service.registerEndpoint({ ...REGISTER_FORM, mac: 'not-a-mac' }, true)).rejects.toMatchObject({
      status: 400,
      message: 'a valid MAC address is 12 hex digits (any separator) — e.g. 3c:22:fb:41:0a:19',
    });
    let seen: ClearPassEndpointRegisterForm | undefined;
    plane.registerEndpoint = async (form) => {
      seen = form;
      return { ...APPLIED };
    };
    await service.registerEndpoint(REGISTER_FORM, true);
    expect(seen?.mac).toBe('3c:22:fb:41:0a:19'); // normalised before the adapter ever sees it
  });

  it('refuses an out-of-vocabulary status', async () => {
    const { service } = makeService(stubPlane());
    await expect(
      service.registerEndpoint({ ...REGISTER_FORM, status: 'Quarantined' as never }, true),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('refuses an endpoint update with nothing to write', async () => {
    const { service } = makeService(stubPlane());
    await expect(service.updateEndpoint('301', {}, true)).rejects.toMatchObject({
      status: 400,
      message: 'nothing to update — send a status, a description, or both',
    });
  });

  it('refuses malformed attributes and an over-long description', async () => {
    const { service } = makeService(stubPlane());
    await expect(
      service.registerEndpoint({ ...REGISTER_FORM, attributes: ['Category'] as never }, true),
    ).rejects.toMatchObject({ status: 400, message: 'attributes must be an object of name → value strings' });
    await expect(
      service.registerEndpoint({ ...REGISTER_FORM, description: 'x'.repeat(300) }, true),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('refuses a local-user create without a role, an enabled flag, or a password', async () => {
    const { service } = makeService(stubPlane());
    await expect(service.createLocalUser({ ...CREATE_USER_FORM, roleName: '' }, true)).rejects.toMatchObject({
      status: 400,
      message: 'role is required',
    });
    await expect(
      service.createLocalUser({ ...CREATE_USER_FORM, enabled: 'yes' as never }, true),
    ).rejects.toMatchObject({ status: 400, message: 'enabled must be true or false' });
    await expect(service.createLocalUser({ ...CREATE_USER_FORM, password: '' }, true)).rejects.toMatchObject({
      status: 400,
      message: 'a password is required for a new local user',
    });
  });

  it('refuses a local-user update with nothing to write', async () => {
    const { service } = makeService(stubPlane());
    await expect(service.updateLocalUser('lu-1', {}, true)).rejects.toMatchObject({
      status: 400,
      message: 'nothing to update — send a display name, role, enabled state, or password',
    });
  });

  it('refuses a role outside the reported inventory (demo fixtures here)', async () => {
    const { service } = makeService(stubPlane(), { demo: true });
    await expect(
      service.createLocalUser({ ...CREATE_USER_FORM, roleName: 'Not A Real Role' }, true),
    ).rejects.toMatchObject({ status: 409 });
  });
});

// -- demo mode ------------------------------------------------------------------

describe('demo mode', () => {
  it('answers a canned, audited apply without touching the plane', async () => {
    // plane: null proves the registry is never resolved on the demo path.
    const { service, dataDir } = makeService(null, { demo: true });
    const r = await service.registerEndpoint(REGISTER_FORM, true);
    expect(r).toMatchObject({ ok: true, action: 'created', verified: true, httpCode: 200 });
    expect(r.message).toContain('no live CPPM was written');
    const lines = auditLines(dataDir);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ event: 'endpoint-register', kind: 'endpoint', result: 'applied' });
    expect(lines[0].ticket).toBe('(none — direct apply)');
  });

  it('demos the local-user create with no password anywhere near the audit log', async () => {
    const { service, dataDir } = makeService(null, { demo: true });
    const r = await service.createLocalUser(CREATE_USER_FORM, true);
    expect(r.ok).toBe(true);
    expect(JSON.stringify(r)).not.toContain(CREATE_USER_FORM.password);
    const raw = readFileSync(join(dataDir, 'change-log.jsonl'), 'utf8');
    expect(raw).toContain('local-user-create');
    expect(raw).not.toContain(CREATE_USER_FORM.password);
  });
});

// -- the live flow ---------------------------------------------------------------

describe('the live flow', () => {
  it('applies, refreshes the cache, and audits one line', async () => {
    const { service, dataDir, syncCalls } = makeService(stubPlane());
    const r = await service.registerEndpoint(REGISTER_FORM, true);
    expect(r.ok).toBe(true);
    expect(syncCalls).toEqual(['clearpass']);
    expect(r.cacheRefresh).toEqual({ attempted: true, ok: true });
    expect(auditLines(dataDir)[0]).toMatchObject({ event: 'endpoint-register', result: 'applied', httpCode: 201 });
    expect(existsSync(join(dataDir, 'tickets.json'))).toBe(false);
  });

  it('does not refresh the cache for a write the plane refused', async () => {
    const refused = stubPlane({
      registerEndpoint: async () => ({ ok: false, action: 'failed', httpCode: 422, message: 'refused (HTTP 422)' }),
    });
    const { service, dataDir, syncCalls } = makeService(refused);
    const r = await service.registerEndpoint(REGISTER_FORM, true);
    expect(r.ok).toBe(false);
    expect(syncCalls).toEqual([]);
    expect(r.cacheRefresh).toEqual({ attempted: false, ok: false });
    expect(auditLines(dataDir)[0]).toMatchObject({ result: 'failed', httpCode: 422 });
  });

  it('reports a cache refresh that did not land instead of assuming it', async () => {
    const { service } = makeService(stubPlane(), { pollerOpts: { tick: 'degraded' } });
    const r = await service.registerEndpoint(REGISTER_FORM, true);
    expect(r.ok).toBe(true); // the write already landed — only the view is behind
    expect(r.cacheRefresh?.attempted).toBe(true);
    expect(r.cacheRefresh?.ok).toBe(false);
    expect(r.cacheRefresh?.message).toContain('could not be re-read');
  });

  it('reports a refresh that came back without the written section', async () => {
    const { service } = makeService(stubPlane(), { pollerOpts: { sections: {} } });
    const r = await service.updateEndpoint('301', { status: 'Disabled' }, true);
    expect(r.cacheRefresh).toMatchObject({ attempted: true, ok: false, message: 'ClearPass was re-read but returned no updated list' });
  });

  it('refuses a live write when ClearPass is not linked', async () => {
    const { service } = makeService(null);
    await expect(service.registerEndpoint(REGISTER_FORM, true)).rejects.toMatchObject({
      status: 409,
      message: 'clearpass is not linked — connect it under Systems and retry',
    });
  });

  it('turns a thrown adapter call into a fixed 502 and audits the unknown outcome', async () => {
    const throwing = stubPlane({
      registerEndpoint: async () => {
        throw new Error(`fetch failed: https://cppm.example/api/endpoint body=${JSON.stringify(CREATE_USER_FORM)}`);
      },
    });
    const { service, dataDir } = makeService(throwing);
    const err = await service.registerEndpoint(REGISTER_FORM, true).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ClearPassDirectWriteError);
    expect((err as InstanceType<typeof ClearPassDirectWriteError>).status).toBe(502);
    // The fixed message — the caught error's own text (URL, body) never crosses.
    expect((err as Error).message).toBe('ClearPass did not answer the write; the outcome is unknown');
    expect(auditLines(dataDir)[0]).toMatchObject({ result: 'error (transport failure — outcome unknown)' });
  });

  it('never lets a local-user password near the audit log or a thrown error', async () => {
    const throwing = stubPlane({
      createLocalUser: async () => {
        throw new Error(`boom ${CREATE_USER_FORM.password}`);
      },
    });
    const { service, dataDir } = makeService(throwing);
    const err = await service.createLocalUser(CREATE_USER_FORM, true).catch((e: unknown) => e);
    expect((err as Error).message).not.toContain(CREATE_USER_FORM.password);
    expect(readFileSync(join(dataDir, 'change-log.jsonl'), 'utf8')).not.toContain(CREATE_USER_FORM.password);
  });

  it('audits the update writes under their own events', async () => {
    const { service, dataDir } = makeService(stubPlane());
    await service.updateEndpoint('301', { status: 'Disabled', description: 'revoked' }, true);
    await service.updateLocalUser('lu-1', { enabled: false }, true);
    const events = auditLines(dataDir).map((l) => l.event);
    expect(events).toEqual(['endpoint-update', 'local-user-update']);
  });
});

// -- the routes (demo-mode createApp) ---------------------------------------------

describe('routes', () => {
  it('POST /api/clearpass/endpoints applies a form without review in the default lab mode', async () => {
    const ok = await postJson('/api/clearpass/endpoints', { form: REGISTER_FORM, reviewConfirmed: true });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ ok: true, action: 'created', verified: true });
    expect((ok.body as { message: string }).message).toContain('no live CPPM was written');

    const denied = await postJson('/api/clearpass/endpoints', { form: REGISTER_FORM });
    expect(denied.status).toBe(200);
    expect(denied.body).toMatchObject({ ok: true, action: 'created' });
  });

  it('POST /api/clearpass/endpoints answers 400 for an invalid MAC', async () => {
    const r = await postJson('/api/clearpass/endpoints', { form: { mac: 'zz' }, reviewConfirmed: true });
    expect(r.status).toBe(400);
    expect((r.body as { error: string }).error).toContain('12 hex digits');
  });

  it('PUT /api/clearpass/endpoints/:id applies a reviewed update', async () => {
    const ok = await postJson(
      '/api/clearpass/endpoints/ep-001',
      { form: { status: 'Disabled', description: 'access revoked' }, reviewConfirmed: true },
      'PUT',
    );
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ ok: true, action: 'updated' });

    const empty = await postJson('/api/clearpass/endpoints/ep-001', { form: {}, reviewConfirmed: true }, 'PUT');
    expect(empty.status).toBe(400);
  });

  it('POST /api/clearpass/local-users creates — and the password is nowhere in the answer', async () => {
    const ok = await postJson('/api/clearpass/local-users', { form: CREATE_USER_FORM, reviewConfirmed: true });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ ok: true, action: 'created' });
    expect(JSON.stringify(ok.body)).not.toContain(CREATE_USER_FORM.password);

    const unknownRole = await postJson('/api/clearpass/local-users', {
      form: { ...CREATE_USER_FORM, roleName: 'Not A Real Role' },
      reviewConfirmed: true,
    });
    expect(unknownRole.status).toBe(409);
    expect(JSON.stringify(unknownRole.body)).not.toContain(CREATE_USER_FORM.password);

    const noPassword = await postJson('/api/clearpass/local-users', {
      form: { ...CREATE_USER_FORM, password: '' },
      reviewConfirmed: true,
    });
    expect(noPassword.status).toBe(400);
  });

  it('PUT /api/clearpass/local-users/:id applies a reviewed update', async () => {
    const ok = await postJson('/api/clearpass/local-users/lu-001', { form: { enabled: false }, reviewConfirmed: true }, 'PUT');
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ ok: true, action: 'updated' });
  });

  it('no other method exists on these paths — the write surface is exactly four routes', async () => {
    const r = await fetch(`${base}/api/clearpass/endpoints/ep-001`, { method: 'DELETE' });
    expect(r.status).toBe(404);
  });
});
