/**
 * server/tests/ssidDirectWrite.test.ts — SSID direct-apply pipeline.
 *
 * Service-level tests inject a stub SsidWritePlane (structural — same
 * pattern writeBroker.test.ts uses for BrokerTransport) so no real
 * CentralAdapter/HTTP/token machinery is needed, and every service
 * instantiation here passes an explicit `plane` (even `null`) so it NEVER
 * falls through to the process registry.
 *
 * Route-level tests boot createApp() the same way configureHistory.test.ts /
 * writeBroker.test.ts do. HPE_SETTINGS_PATH / HPE_DATA_DIR MUST be set before
 * ANY server module is evaluated — importing config/settings.ts or
 * planes/registry.ts (even indirectly, even for a type) constructs their
 * process-wide singletons against whatever HPE_SETTINGS_PATH is set at that
 * moment. That is why every server-module import below is dynamic, inside
 * beforeAll, AFTER the env vars are set — a static top-level import would
 * construct those singletons against the REAL developer install's
 * data/settings.json (and, on a box with a linked Central plane, would run
 * live network calls against a real tenant).
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express, { type NextFunction, type Request, type Response } from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_SSID_FORM } from '@hpe/shared';
import type { SsidApplyResult, SsidCatalog, SsidForm } from '@hpe/shared';
import type { SsidDirectWriteError as SsidDirectWriteErrorType, SsidWritePlane } from '../src/services/ssidDirectWrite';

let SsidDirectWriteService: typeof import('../src/services/ssidDirectWrite').SsidDirectWriteService;
let SsidDirectWriteError: typeof SsidDirectWriteErrorType;
let createApp: typeof import('../src/index').createApp;
let makeConfigureRouter: typeof import('../src/routes/configure').makeConfigureRouter;
let WriteBroker: typeof import('../src/services/writeBroker').WriteBroker;
let settings: typeof import('../src/config/settings').settings;

let tmpDir: string;
let server: Server;
let base: string;

let dirCounter = 0;
function freshDataDir(): string {
  return join(tmpDir, `d${dirCounter++}`);
}

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'hpe-ssid-'));
  process.env.HPE_SETTINGS_PATH = join(tmpDir, 'settings.json');
  process.env.HPE_DATA_DIR = join(tmpDir, 'data');
  ({ SsidDirectWriteService } = await import('../src/services/ssidDirectWrite'));
  ({ SsidDirectWriteError } = await import('../src/services/ssidDirectWrite'));
  ({ makeConfigureRouter } = await import('../src/routes/configure'));
  ({ WriteBroker } = await import('../src/services/writeBroker'));
  ({ settings } = await import('../src/config/settings'));
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

const READY_FORM: SsidForm = {
  ...DEFAULT_SSID_FORM,
  security: 'wpa2-psk',
  scopeIds: ['site-1'],
  defaultRole: 'guest',
  passphrase: 'super-secret-pw',
  noDfs: false,
};

const APPLIED: SsidApplyResult = {
  ok: true,
  partial: false,
  profile: { ok: true, action: 'created', verified: true, httpCode: 201, message: 'profile created — HTTP 201' },
  assignments: [{ scopeId: 'site-1', label: 'site-1', ok: true, httpCode: 200, message: 'assigned — HTTP 200' }],
};

function stubPlane(overrides: Partial<SsidWritePlane> = {}): SsidWritePlane {
  return {
    ssidCatalog: async () => ({
      scopes: [{ id: 'site-1', label: 'Campus-01', category: 'site' }],
      roles: [{ id: 'guest', label: 'guest' }],
      authServerGroups: [{ id: 'clearpass', label: 'clearpass' }],
      captivePortalProfiles: [{ id: 'guest-portal', label: 'guest-portal' }],
      unavailable: [],
      source: 'stub',
    }),
    applySsidProfile: async () => APPLIED,
    ...overrides,
  };
}

/** A fresh copy per test — apply() writes back into the result the plane
 *  returned (assignment labels, and now the cache-refresh outcome), so the
 *  shared APPLIED constant must never be handed to it directly. */
function appliedResult(over: Partial<SsidApplyResult> = {}): SsidApplyResult {
  return {
    ...APPLIED,
    profile: { ...APPLIED.profile },
    assignments: APPLIED.assignments.map((a) => ({ ...a })),
    ...over,
  };
}

/** Structural stand-in for the poller: only the two methods the write path
 *  uses. `ssids` undefined models a Central pull that omitted the section
 *  because it could not read it — Central never sends it empty. */
function fakePoller(opts: { tick?: string; ssids?: unknown[]; throws?: boolean } = {}): {
  poller: import('../src/services/poller').Poller;
  syncCalls: string[];
} {
  const syncCalls: string[] = [];
  const poller = {
    syncNowFor: async (plane: string) => {
      syncCalls.push(plane);
      if (opts.throws) throw new Error('https://central.example/token?secret=abc exploded');
      return opts.tick ?? 'ok';
    },
    contributionsByPlane: () =>
      new Map([['central', opts.ssids === undefined ? { config: {} } : { config: { ssids: opts.ssids } }]]),
  } as unknown as import('../src/services/poller').Poller;
  return { poller, syncCalls };
}

async function startInjectedRoute(
  service: InstanceType<typeof SsidDirectWriteService>,
): Promise<{ server: Server; base: string }> {
  const app = express();
  app.use(express.json());
  app.use(
    '/api',
    makeConfigureRouter(
      new WriteBroker({ dataDir: freshDataDir(), transport: null, knownTicket: () => true }),
      service,
    ),
  );
  // Mirrors the real production error middleware in server/src/index.ts:
  // SsidDirectWriteError's fixed, secret-free message is safe to surface
  // even at 5xx (502 "central did not answer…"); every other 5xx collapses
  // to the generic message so no raw upstream detail ever reaches a caller.
  app.use((err: Error & { status?: number }, _req: Request, res: Response, _next: NextFunction) => {
    const status = err.status ?? 500;
    const safe5xxMessage = err instanceof SsidDirectWriteError ? err.message : undefined;
    res.status(status).json({ error: status >= 500 ? (safe5xxMessage ?? 'internal error') : err.message });
  });
  const routeServer = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => routeServer.once('listening', resolve));
  return {
    server: routeServer,
    base: `http://127.0.0.1:${(routeServer.address() as AddressInfo).port}`,
  };
}

async function closeServer(serverToClose: Server): Promise<void> {
  await new Promise<void>((resolve) => serverToClose.close(() => resolve()));
}

describe('SsidDirectWriteService — service level (every instance is given an explicit plane/null — never the real registry)', () => {
  it('demo mode never touches the plane: catalog and apply are both canned', async () => {
    let planeTouched = false;
    const service = new SsidDirectWriteService({
      dataDir: freshDataDir(),
      demoMode: () => true,
      plane: stubPlane({
        ssidCatalog: async () => {
          planeTouched = true;
          return {
            scopes: [],
            roles: [],
            authServerGroups: [],
            captivePortalProfiles: [],
            unavailable: [],
            source: 'live',
          };
        },
      }),
    });
    const catalog = await service.catalog();
    expect(catalog.source).toMatch(/demo catalog/);
    expect(planeTouched).toBe(false);

    const result = await service.apply(READY_FORM, true);
    expect(result.ok).toBe(true);
    expect(result.profile.action).toBe('created');
    expect(result.assignments).toHaveLength(1);
    expect(result.assignments[0].scopeId).toBe('site-1');
    // A canned success has to assert the read-back too. Undefined here means
    // "written, never confirmed" — a real state for a tenant that will not
    // open its assignment list, and a meaningless one for a fixture. The
    // screen marks it '?' and withholds the green, which would make demo mode
    // display a doubt it does not have.
    expect(result.assignments[0].verified).toBe(true);
  });

  /* The Configure list is served from the poll cache. Without a forced
     re-read, the screen re-fetches it the instant an apply succeeds and gets
     back the snapshot from before the write — the operator is told the SSID
     was created and then shown a list without it in it. */
  it('re-reads Central after a write so the list is not the pre-change one', async () => {
    const { poller, syncCalls } = fakePoller({ ssids: [{ name: 'Corp-WiFi' }] });
    const service = new SsidDirectWriteService({
      dataDir: freshDataDir(),
      demoMode: () => false,
      pollerRef: poller,
      plane: stubPlane({ applySsidProfile: async () => appliedResult() }),
    });
    const result = await service.apply(READY_FORM, true);
    expect(syncCalls).toEqual(['central']);
    expect(result.cacheRefresh).toEqual({ attempted: true, ok: true });
  });

  /* A pull that completed but brought back no SSID list leaves the cache
     exactly as stale as a failed one. Calling that a refresh would be the same
     lie by a quieter route. */
  it('will not call a re-read that returned no SSID list a refresh', async () => {
    for (const opts of [{ tick: 'error' }, { ssids: undefined }, { throws: true }]) {
      const { poller } = fakePoller(opts);
      const service = new SsidDirectWriteService({
        dataDir: freshDataDir(),
        demoMode: () => false,
        pollerRef: poller,
        plane: stubPlane({ applySsidProfile: async () => appliedResult() }),
      });
      const result = await service.apply(READY_FORM, true);
      expect(result.cacheRefresh?.attempted).toBe(true);
      expect(result.cacheRefresh?.ok).toBe(false);
      // Operator-facing, and never the caught error — the poller's message can
      // carry a URL or a token-bearing query string.
      expect(result.cacheRefresh?.message).toMatch(/^Central /);
      expect(result.cacheRefresh?.message).not.toMatch(/secret|https:/);
    }
  });

  /* Not attempted and attempted-but-failed are different states and the screen
     reads them differently: one is "nothing changed, so nothing is behind",
     the other is "something changed and you cannot see it yet". */
  it('attempts no refresh when the write changed nothing', async () => {
    const unchanged: SsidApplyResult = {
      ok: true,
      partial: false,
      profile: { ok: true, action: 'unchanged', verified: true, httpCode: 200, message: 'already matches' },
      assignments: [
        { scopeId: 'site-1', label: 'site-1', ok: true, skipped: true, httpCode: 200, message: 'already assigned' },
      ],
    };
    const { poller, syncCalls } = fakePoller();
    const service = new SsidDirectWriteService({
      dataDir: freshDataDir(),
      demoMode: () => false,
      pollerRef: poller,
      plane: stubPlane({ applySsidProfile: async () => unchanged }),
    });
    const result = await service.apply(READY_FORM, true);
    expect(syncCalls).toEqual([]);
    expect(result.cacheRefresh).toEqual({ attempted: false, ok: false });
  });

  /* A partial apply is explicitly not rolled back — the profile is on the
     estate. That is the case where the operator is most likely to retry from
     the list, so it is the last one that can afford to show a stale one. */
  it('re-reads Central after a partial apply too, because the profile stands', async () => {
    const { poller, syncCalls } = fakePoller({ ssids: [{ name: 'Corp-WiFi' }] });
    const service = new SsidDirectWriteService({
      dataDir: freshDataDir(),
      demoMode: () => false,
      pollerRef: poller,
      plane: stubPlane({
        applySsidProfile: async () =>
          appliedResult({
            ok: false,
            partial: true,
            assignments: [
              { scopeId: 'site-1', label: 'site-1', ok: false, httpCode: 500, message: 'assignment failed' },
            ],
          }),
      }),
    });
    const result = await service.apply(READY_FORM, true);
    expect(syncCalls).toEqual(['central']);
    expect(result.cacheRefresh).toEqual({ attempted: true, ok: true });
  });

  it('uses a live Configure override even when the portal is globally demo', async () => {
    let catalogCalls = 0;
    let applyCalls = 0;
    const service = new SsidDirectWriteService({
      dataDir: freshDataDir(),
      plane: stubPlane({
        ssidCatalog: async () => {
          catalogCalls += 1;
          return stubPlane().ssidCatalog();
        },
        applySsidProfile: async () => {
          applyCalls += 1;
          return APPLIED;
        },
      }),
    });
    settings.update({ demoMode: true, sectionMode: { configure: 'live' } });
    try {
      expect((await service.catalog()).source).toBe('stub');
      expect(await service.apply(READY_FORM, true)).toEqual(APPLIED);
      expect(catalogCalls).toBe(2);
      expect(applyCalls).toBe(1);
    } finally {
      settings.update({ demoMode: true, sectionMode: {} });
    }
  });

  it('uses a demo Configure override even when the portal is globally live', async () => {
    let planeTouched = false;
    const service = new SsidDirectWriteService({
      dataDir: freshDataDir(),
      plane: stubPlane({
        ssidCatalog: async () => {
          planeTouched = true;
          return stubPlane().ssidCatalog();
        },
        applySsidProfile: async () => {
          planeTouched = true;
          return APPLIED;
        },
      }),
    });
    settings.update({ demoMode: false, sectionMode: { configure: 'demo' } });
    try {
      expect((await service.catalog()).source).toMatch(/demo catalog/);
      expect((await service.apply(READY_FORM, true)).profile.message).toMatch(/demo profile/);
      expect(planeTouched).toBe(false);
    } finally {
      settings.update({ demoMode: true, sectionMode: {} });
    }
  });

  it('follows global demoMode when Configure has no section override', async () => {
    let catalogCalls = 0;
    let applyCalls = 0;
    const service = new SsidDirectWriteService({
      dataDir: freshDataDir(),
      plane: stubPlane({
        ssidCatalog: async () => {
          catalogCalls += 1;
          return stubPlane().ssidCatalog();
        },
        applySsidProfile: async () => {
          applyCalls += 1;
          return APPLIED;
        },
      }),
    });
    try {
      settings.update({ demoMode: true, sectionMode: {} });
      expect((await service.catalog()).source).toMatch(/demo catalog/);
      expect((await service.apply(READY_FORM, true)).profile.message).toMatch(/demo profile/);
      expect(catalogCalls).toBe(0);
      expect(applyCalls).toBe(0);

      settings.update({ demoMode: false, sectionMode: {} });
      expect((await service.catalog()).source).toBe('stub');
      expect((await service.apply(READY_FORM, true)).profile.action).toBe('created');
      expect(catalogCalls).toBe(2);
      expect(applyCalls).toBe(1);
    } finally {
      settings.update({ demoMode: true, sectionMode: {} });
    }
  });

  it('rejects apply without an explicit reviewConfirmed:true', async () => {
    const service = new SsidDirectWriteService({ dataDir: freshDataDir(), demoMode: () => false, plane: stubPlane() });
    await expect(service.apply(READY_FORM, false)).rejects.toThrow(/explicit review confirmation/);
    await expect(service.apply(READY_FORM, undefined)).rejects.toThrow(/explicit review confirmation/);
    await expect(service.apply(READY_FORM, 'true')).rejects.toThrow(/explicit review confirmation/); // truthy string is not `=== true`
  });

  it('rejects a form with no scope selected', async () => {
    const service = new SsidDirectWriteService({ dataDir: freshDataDir(), demoMode: () => false, plane: stubPlane() });
    await expect(service.apply({ ...READY_FORM, scopeIds: [] }, true)).rejects.toThrow(/select at least one scope/);
  });

  it('rejects duplicate scope selections instead of silently issuing duplicate assignments', async () => {
    const service = new SsidDirectWriteService({
      dataDir: freshDataDir(),
      demoMode: () => false,
      plane: stubPlane(),
    });
    await expect(service.apply({ ...READY_FORM, scopeIds: ['site-1', 'site-1'] }, true)).rejects.toThrow(
      /scope may be selected only once/,
    );
  });

  it('rejects missing passphrases, server groups, captive portals, and roles', async () => {
    const service = new SsidDirectWriteService({ dataDir: freshDataDir(), demoMode: () => false, plane: stubPlane() });
    await expect(service.apply({ ...READY_FORM, passphrase: undefined }, true)).rejects.toThrow(/passphrase is required/);
    await expect(
      service.apply(
        { ...READY_FORM, security: 'wpa3-enterprise', passphrase: undefined, authServerGroupId: undefined },
        true,
      ),
    ).rejects.toThrow(/authentication server group is required/);
    await expect(
      service.apply({ ...READY_FORM, security: 'psk-portal', captivePortalProfileId: undefined }, true),
    ).rejects.toThrow(/captive-portal profile is required/);
    await expect(service.apply({ ...READY_FORM, defaultRole: undefined }, true)).rejects.toThrow(/default role is required/);
  });

  it('keeps passphrase validation for PSK modes', async () => {
    const service = new SsidDirectWriteService({ dataDir: freshDataDir(), demoMode: () => false, plane: stubPlane() });
    await expect(service.apply({ ...READY_FORM, passphrase: 'short' }, true)).rejects.toThrow(
      /passphrase must be 8-63 characters/,
    );
    await expect(
      service.apply(
        {
          ...READY_FORM,
          security: 'psk-portal',
          captivePortalProfileId: 'guest-portal',
          passphrase: 'not-hex'.padEnd(64, 'z'),
        },
        true,
      ),
    ).rejects.toThrow(/exactly 64 hexadecimal/);
  });

  it('ignores malicious stale security fields and passes only mode-applicable values to Central', async () => {
    const appliedForms: SsidForm[] = [];
    const service = new SsidDirectWriteService({
      dataDir: freshDataDir(),
      demoMode: () => false,
      plane: stubPlane({
        applySsidProfile: async (form) => {
          appliedForms.push(form);
          return APPLIED;
        },
      }),
    });

    await service.apply(
      {
        ...READY_FORM,
        security: 'open',
        passphrase: 'short',
        authServerGroupId: 'missing-group',
        captivePortalProfileId: 'missing-portal',
      },
      true,
    );
    await service.apply(
      {
        ...READY_FORM,
        security: 'wpa3-enterprise',
        authServerGroupId: 'clearpass',
        passphrase: 'short',
        captivePortalProfileId: 'missing-portal',
      },
      true,
    );
    await service.apply(
      {
        ...READY_FORM,
        authServerGroupId: 'missing-group',
        captivePortalProfileId: 'missing-portal',
      },
      true,
    );

    expect(appliedForms).toHaveLength(3);
    expect(appliedForms[0]).toMatchObject({ security: 'open', defaultRole: 'guest' });
    expect(appliedForms[0]).not.toHaveProperty('passphrase');
    expect(appliedForms[0]).not.toHaveProperty('authServerGroupId');
    expect(appliedForms[0]).not.toHaveProperty('captivePortalProfileId');
    expect(appliedForms[1]).toMatchObject({
      security: 'wpa3-enterprise',
      defaultRole: 'guest',
      authServerGroupId: 'clearpass',
    });
    expect(appliedForms[1]).not.toHaveProperty('passphrase');
    expect(appliedForms[1]).not.toHaveProperty('captivePortalProfileId');
    expect(appliedForms[2]).toMatchObject({
      security: 'wpa2-psk',
      defaultRole: 'guest',
      passphrase: 'super-secret-pw',
    });
    expect(appliedForms[2]).not.toHaveProperty('authServerGroupId');
    expect(appliedForms[2]).not.toHaveProperty('captivePortalProfileId');
  });

  it('rejects stale scope and dependency IDs against a fresh Central catalog', async () => {
    const service = new SsidDirectWriteService({
      dataDir: freshDataDir(),
      demoMode: () => false,
      plane: stubPlane(),
    });
    await expect(service.apply({ ...READY_FORM, scopeIds: ['missing-scope'] }, true)).rejects.toThrow(
      /scopes are no longer available/,
    );
    await expect(service.apply({ ...READY_FORM, defaultRole: 'missing-role' }, true)).rejects.toThrow(
      /role is no longer available/,
    );
    await expect(
      service.apply(
        {
          ...READY_FORM,
          security: 'wpa3-enterprise',
          passphrase: undefined,
          authServerGroupId: 'missing-group',
        },
        true,
      ),
    ).rejects.toThrow(/authentication server group is no longer available/);
  });

  it('rejects when central is not linked in live mode', async () => {
    const service = new SsidDirectWriteService({ dataDir: freshDataDir(), demoMode: () => false, plane: null });
    await expect(service.apply(READY_FORM, true)).rejects.toThrow(/central is not linked/);
    const catalog = await service.catalog();
    expect(catalog.unavailable).toContain('sites');
    expect(catalog.source).toMatch(/not linked/);
  });

  it('applies through the injected plane and logs ONE audit line with no ticket and no passphrase', async () => {
    const dataDir = freshDataDir();
    const service = new SsidDirectWriteService({ dataDir, demoMode: () => false, plane: stubPlane() });
    const result = await service.apply(READY_FORM, true);
    expect(result).toEqual(APPLIED);

    const raw = readFileSync(join(dataDir, 'change-log.jsonl'), 'utf8').trim();
    const lines = raw.split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ event: 'ssid-apply', kind: 'ssid', result: 'applied', httpCode: 201 });
    expect(lines[0].ticket).toMatch(/none/);
    expect(raw).not.toMatch(/super-secret-pw/);
  });

  it('logs "partial" and "failed" outcomes distinctly', async () => {
    const dataDir = freshDataDir();
    const partialResult: SsidApplyResult = {
      ok: false,
      partial: true,
      profile: { ok: true, action: 'updated', verified: true, httpCode: 200, message: 'ok' },
      assignments: [{ scopeId: 'site-1', label: 'site-1', ok: false, httpCode: 500, message: 'assignment failed' }],
    };
    const service = new SsidDirectWriteService({
      dataDir,
      demoMode: () => false,
      plane: stubPlane({ applySsidProfile: async () => partialResult }),
    });
    await service.apply(READY_FORM, true);

    const failedResult: SsidApplyResult = {
      ok: false,
      partial: false,
      profile: { ok: false, action: 'failed', verified: false, httpCode: 500, message: 'nope' },
      assignments: [],
    };
    const service2 = new SsidDirectWriteService({
      dataDir,
      demoMode: () => false,
      plane: stubPlane({ applySsidProfile: async () => failedResult }),
    });
    await service2.apply(READY_FORM, true);

    const lines = readFileSync(join(dataDir, 'change-log.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines.map((l) => l.result)).toEqual(['partial', 'failed']);
  });

  it('adapter.applySsidProfile() throwing (timeout/transport/unknown outcome) logs ONE secret-free audit line and propagates a fixed, secret-free error instead of a fabricated result', async () => {
    const dataDir = freshDataDir();
    // A transport error whose own message could carry a URL, token, or
    // passphrase-adjacent detail — this must never reach the propagated
    // error or the audit log, only a fixed, secret-free message may.
    const SECRET_LEAK = 'wpa-passphrase=super-secret-pw at https://tenant.example.com/token?access_token=abcd1234';
    const service = new SsidDirectWriteService({
      dataDir,
      demoMode: () => false,
      plane: stubPlane({
        applySsidProfile: async () => {
          throw new Error(SECRET_LEAK);
        },
      }),
    });

    let firstErr: unknown;
    try {
      await service.apply(READY_FORM, true);
    } catch (err) {
      firstErr = err;
    }
    expect(firstErr).toBeInstanceOf(SsidDirectWriteError);
    expect((firstErr as InstanceType<typeof SsidDirectWriteError>).status).toBe(502);
    expect((firstErr as Error).message).toBe('central did not answer the SSID write; the outcome is unknown');
    expect((firstErr as Error).message).not.toMatch(/super-secret-pw|access_token|tenant\.example\.com/);

    await expect(service.apply(READY_FORM, true)).rejects.toMatchObject({ status: 502 });

    const raw = readFileSync(join(dataDir, 'change-log.jsonl'), 'utf8').trim();
    const lines = raw.split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    // Two apply() calls above → two audit lines, no more, no fewer: exactly
    // one per failed attempt, never zero and never doubled.
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(line).toMatchObject({ event: 'ssid-apply', kind: 'ssid' });
      expect(String(line.result)).toMatch(/failed|error|unknown/i);
    }
    // SECURITY: no passphrase, no rendered form/payload body, and no
    // fragment of the caught transport error's own message anywhere in the log.
    expect(raw).not.toMatch(/super-secret-pw/);
    expect(raw).not.toMatch(/passphrase/i);
    expect(raw).not.toMatch(/profile/i); // no payload/body leaked in from a result object
    expect(raw).not.toMatch(/access_token|tenant\.example\.com|socket hang up/);
  });

  it('SsidDirectWriteError carries a status the route layer maps to an HTTP code', () => {
    const err = new SsidDirectWriteError(409, 'nope');
    expect(err.status).toBe(409);
    expect(err.name).toBe('SsidDirectWriteError');
  });
});

// ---------------------------------------------------------------------------
// Route level — GET/POST /api/configure/ssids/* against createApp(), whose
// singletons are all bound to the tmp settings/data dirs from the outer
// beforeAll above — never the real install.
// ---------------------------------------------------------------------------

describe('SSID direct-write routes', () => {
  async function postJson(path: string, payload: unknown): Promise<{ status: number; body: any }> {
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return { status: res.status, body: await res.json() };
  }

  it('GET /api/configure/ssids/catalog answers the demo catalog by default', async () => {
    const res = await fetch(`${base}/api/configure/ssids/catalog`);
    expect(res.status).toBe(200);
    const catalog = (await res.json()) as SsidCatalog;
    expect(catalog.unavailable).toEqual([]);
    expect(catalog.scopes.length).toBeGreaterThan(0);
    expect(catalog.source).toMatch(/demo catalog/);
  });

  it('POST /api/configure/ssids/apply succeeds in demo mode without needing a ticket', async () => {
    const applied = await postJson('/api/configure/ssids/apply', { form: READY_FORM, reviewConfirmed: true });
    expect(applied.status).toBe(200);
    expect(applied.body.ok).toBe(true);
    expect(applied.body.profile.action).toBe('created');
    // SECURITY: the passphrase must never ride back in the response.
    expect(JSON.stringify(applied.body)).not.toMatch(/super-secret-pw/);
  });

  it('POST /api/configure/ssids/apply answers 400 without an explicit reviewConfirmed:true', async () => {
    const res = await postJson('/api/configure/ssids/apply', { form: READY_FORM });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/explicit review confirmation/);
  });

  it('POST /api/configure/ssids/apply answers 400 for an unsupported security value or a missing scope', async () => {
    const badSecurity = await postJson('/api/configure/ssids/apply', {
      form: { ...READY_FORM, security: 'wep' },
      reviewConfirmed: true,
    });
    expect(badSecurity.status).toBe(400);
    expect(badSecurity.body.error).toMatch(/unsupported SSID security/);

    const noScope = await postJson('/api/configure/ssids/apply', {
      form: { ...READY_FORM, scopeIds: [] },
      reviewConfirmed: true,
    });
    expect(noScope.status).toBe(400);
    expect(noScope.body.error).toMatch(/select at least one scope/);
  });

  it('a live Configure override answers unavailable/409 with no Central instead of simulating demo success', async () => {
    const put = await fetch(`${base}/api/settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ demoMode: true, sectionMode: { configure: 'live' } }),
    });
    expect(put.status).toBe(200);
    try {
      const catalogRes = await fetch(`${base}/api/configure/ssids/catalog`);
      expect(catalogRes.status).toBe(200);
      const catalog = (await catalogRes.json()) as SsidCatalog;
      expect(catalog.unavailable.length).toBeGreaterThan(0);
      expect(catalog.source).toMatch(/not linked/);

      const applyRes = await postJson('/api/configure/ssids/apply', { form: READY_FORM, reviewConfirmed: true });
      expect(applyRes.status).toBe(409);
      expect(applyRes.body.error).toMatch(/central is not linked/);
    } finally {
      await fetch(`${base}/api/settings`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ demoMode: true, sectionMode: {} }),
      });
    }
  });
});

describe('SSID direct-write route integration with an injected plane', () => {
  async function postJson(routeBase: string, payload: unknown): Promise<{ status: number; body: any }> {
    const res = await fetch(`${routeBase}/api/configure/ssids/apply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return { status: res.status, body: await res.json() };
  }

  it('global demo + Configure live routes catalog/apply through the injected plane', async () => {
    let catalogCalls = 0;
    let applyCalls = 0;
    const service = new SsidDirectWriteService({
      dataDir: freshDataDir(),
      plane: stubPlane({
        ssidCatalog: async () => {
          catalogCalls += 1;
          return stubPlane().ssidCatalog();
        },
        applySsidProfile: async () => {
          applyCalls += 1;
          return APPLIED;
        },
      }),
    });
    settings.update({ demoMode: true, sectionMode: { configure: 'live' } });
    const route = await startInjectedRoute(service);
    try {
      const catalogRes = await fetch(`${route.base}/api/configure/ssids/catalog`);
      expect(catalogRes.status).toBe(200);
      expect(((await catalogRes.json()) as SsidCatalog).source).toBe('stub');
      expect((await postJson(route.base, { form: READY_FORM, reviewConfirmed: true })).body).toEqual(APPLIED);
      expect(catalogCalls).toBe(2);
      expect(applyCalls).toBe(1);
    } finally {
      await closeServer(route.server);
      settings.update({ demoMode: true, sectionMode: {} });
    }
  });

  it('global live + Configure demo routes catalog/apply to fixtures and canned success', async () => {
    let planeTouched = false;
    const service = new SsidDirectWriteService({
      dataDir: freshDataDir(),
      plane: stubPlane({
        ssidCatalog: async () => {
          planeTouched = true;
          return stubPlane().ssidCatalog();
        },
        applySsidProfile: async () => {
          planeTouched = true;
          return APPLIED;
        },
      }),
    });
    settings.update({ demoMode: false, sectionMode: { configure: 'demo' } });
    const route = await startInjectedRoute(service);
    try {
      const catalogRes = await fetch(`${route.base}/api/configure/ssids/catalog`);
      expect(((await catalogRes.json()) as SsidCatalog).source).toMatch(/demo catalog/);
      const applied = await postJson(route.base, { form: READY_FORM, reviewConfirmed: true });
      expect(applied.status).toBe(200);
      expect(applied.body.profile.message).toMatch(/demo profile/);
      expect(planeTouched).toBe(false);
    } finally {
      await closeServer(route.server);
      settings.update({ demoMode: true, sectionMode: {} });
    }
  });

  it('with no Configure override, routes follow the global mode', async () => {
    let catalogCalls = 0;
    let applyCalls = 0;
    const service = new SsidDirectWriteService({
      dataDir: freshDataDir(),
      plane: stubPlane({
        ssidCatalog: async () => {
          catalogCalls += 1;
          return stubPlane().ssidCatalog();
        },
        applySsidProfile: async () => {
          applyCalls += 1;
          return APPLIED;
        },
      }),
    });
    const route = await startInjectedRoute(service);
    try {
      settings.update({ demoMode: true, sectionMode: {} });
      const demoCatalog = (await (await fetch(`${route.base}/api/configure/ssids/catalog`)).json()) as SsidCatalog;
      expect(demoCatalog.source).toMatch(/demo catalog/);
      expect((await postJson(route.base, { form: READY_FORM, reviewConfirmed: true })).body.profile.message).toMatch(
        /demo profile/,
      );
      expect(catalogCalls).toBe(0);
      expect(applyCalls).toBe(0);

      settings.update({ demoMode: false, sectionMode: {} });
      const liveCatalog = (await (await fetch(`${route.base}/api/configure/ssids/catalog`)).json()) as SsidCatalog;
      expect(liveCatalog.source).toBe('stub');
      expect((await postJson(route.base, { form: READY_FORM, reviewConfirmed: true })).body.profile.action).toBe(
        'created',
      );
      expect(catalogCalls).toBe(2);
      expect(applyCalls).toBe(1);
    } finally {
      await closeServer(route.server);
      settings.update({ demoMode: true, sectionMode: {} });
    }
  });

  it("routes SsidDirectWriteError's 502 unknown-outcome message to the caller, not a generic internal error", async () => {
    const service = new SsidDirectWriteService({
      dataDir: freshDataDir(),
      demoMode: () => false,
      plane: stubPlane({
        applySsidProfile: async () => {
          // A transport failure whose own message could carry secret-adjacent
          // detail — the caller below never sees it verbatim.
          throw new Error('socket hang up at https://tenant.example.com/token?access_token=abcd1234');
        },
      }),
    });
    const route = await startInjectedRoute(service);
    try {
      const res = await postJson(route.base, { form: READY_FORM, reviewConfirmed: true });
      expect(res.status).toBe(502);
      expect(res.body.error).toBe('central did not answer the SSID write; the outcome is unknown');
      // SECURITY: the raw transport error's message never leaks to the caller.
      expect(res.body.error).not.toMatch(/socket hang up|access_token|tenant\.example\.com/);
    } finally {
      await closeServer(route.server);
    }
  });

  it('collapses an arbitrary 5xx error (not SsidDirectWriteError) to the generic message — raw detail never leaks', async () => {
    const service = new SsidDirectWriteService({
      dataDir: freshDataDir(),
      demoMode: () => false,
      plane: stubPlane({
        ssidCatalog: async () => {
          throw new Error('ECONNREFUSED 10.0.0.5:443 — internal tenant host detail');
        },
      }),
    });
    const route = await startInjectedRoute(service);
    try {
      const res = await fetch(`${route.base}/api/configure/ssids/catalog`);
      const body = (await res.json()) as { error: string };
      expect(res.status).toBe(500);
      expect(body.error).toBe('internal error');
      expect(body.error).not.toMatch(/ECONNREFUSED|10\.0\.0\.5|internal tenant host/);
    } finally {
      await closeServer(route.server);
    }
  });
});
