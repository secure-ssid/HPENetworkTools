/**
 * server/tests/systems.test.ts — connection-test hardening, error middleware,
 * masked round-trip through PUT /api/settings, and the poller's tick guard.
 *
 * Same in-process pattern as routes.test.ts: HPE_SETTINGS_PATH/HPE_DATA_DIR
 * point at a tmp dir and must be set before the app modules are imported
 * (the settings singleton resolves its path at construction).
 */

import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PlaneRegistry } from '../src/planes/registry';
import type { SettingsStore } from '../src/config/settings';
import { normalizeSseBaseUrl, SSE_INSECURE_HTTP_OVERRIDE_ENV } from '../src/planes/sse';

let server: Server;
let base: string;
let tmpDir: string;
let settings: (typeof import('../src/config/settings'))['settings'];
let poller: (typeof import('../src/services/poller'))['poller'];
let registry: (typeof import('../src/planes/registry'))['registry'];
let mockSse: Server;
let mockSseBase: string;
let mockCppm: Server;
let mockCppmBase: string;
const sseRequests: Array<{ url: string; authorization: string | undefined }> = [];
let previousSseHttpOverride: string | undefined;

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'hpe-systems-'));
  process.env.HPE_SETTINGS_PATH = join(tmpDir, 'settings.json');
  process.env.HPE_DATA_DIR = join(tmpDir, 'data'); // ticket writes land in tmp, never real data/
  // A real budget, shrunk: the credential-save tests below poll localhost (which
  // refuses in microseconds) and the no-adapter stub (which returns without any
  // I/O at all), so a second is generous for the outcomes that resolve — and it
  // keeps the one that deliberately does not inside the test timeout.
  process.env.HPE_CREDENTIAL_INDEX_WAIT_MS = '1000';
  previousSseHttpOverride = process.env[SSE_INSECURE_HTTP_OVERRIDE_ENV];
  process.env[SSE_INSECURE_HTTP_OVERRIDE_ENV] = '1';
  const index = await import('../src/index');
  ({ settings } = await import('../src/config/settings'));
  ({ poller } = await import('../src/services/poller'));
  ({ registry } = await import('../src/planes/registry'));
  server = index.createApp().listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  mockSse = createServer((req, res) => {
    const authorization = typeof req.headers.authorization === 'string' ? req.headers.authorization : undefined;
    sseRequests.push({ url: req.url ?? '', authorization });
    res.setHeader('content-type', 'application/json');
    if (req.url === '/') {
      res.end('{}');
      return;
    }
    if (req.url === '/api/v1.0/Connectors?pagenumber=1&pagesize=1') {
      const token = authorization?.replace(/^Bearer /, '');
      if (token === 'valid-sse-token') {
        res.end(JSON.stringify({ data: [], totalRecords: 0 }));
        return;
      }
      if (token === 'nonempty-sse-token') {
        res.end(JSON.stringify({ data: [{ id: 'c-1', name: 'Branch connector' }], totalRecords: 1 }));
        return;
      }
      if (token === 'html-sse-token') {
        res.setHeader('content-type', 'text/html');
        res.end('<html><body>not json</body></html>');
        return;
      }
      if (token === 'malformed-json-sse-token') {
        res.end('{ this is not valid json');
        return;
      }
      if (token === 'unrecognized-json-sse-token') {
        res.end(JSON.stringify({ foo: 'bar' }));
        return;
      }
      res.statusCode = 401;
      res.end('{}');
      return;
    }
    res.statusCode = 404;
    res.end('{}');
  });
  mockSse.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => mockSse.once('listening', resolve));
  mockSseBase = `http://127.0.0.1:${(mockSse.address() as AddressInfo).port}`;

  mockCppm = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/api/oauth' && req.method === 'POST') {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        let clientId = '';
        try {
          clientId = String((JSON.parse(raw) as { client_id?: unknown }).client_id ?? '');
        } catch {
          /* malformed body falls through to the refusal */
        }
        if (clientId === 'good-client') {
          res.end(JSON.stringify({ access_token: 'mock-cppm-token', expires_in: 28800 }));
          return;
        }
        res.statusCode = 400;
        res.end(JSON.stringify({ title: 'unauthorized_client', detail: 'The grant type is unauthorized for this client_id' }));
      });
      return;
    }
    if (req.url?.startsWith('/api/endpoint')) {
      const token = typeof req.headers.authorization === 'string' ? req.headers.authorization.replace(/^Bearer /, '') : '';
      if (token === 'good-token' || token === 'mock-cppm-token') {
        res.end('[]');
        return;
      }
      if (token === 'limited-token') {
        res.statusCode = 403;
        res.end(JSON.stringify({ title: 'Forbidden', detail: 'Forbidden' }));
        return;
      }
      res.statusCode = 401;
      res.end('{}');
      return;
    }
    res.statusCode = 404;
    res.end('{}');
  });
  mockCppm.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => mockCppm.once('listening', resolve));
  mockCppmBase = `http://127.0.0.1:${(mockCppm.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await new Promise<void>((resolve) => mockSse.close(() => resolve()));
  await new Promise<void>((resolve) => mockCppm.close(() => resolve()));
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.HPE_SETTINGS_PATH;
  delete process.env.HPE_DATA_DIR;
  if (previousSseHttpOverride === undefined) delete process.env[SSE_INSECURE_HTTP_OVERRIDE_ENV];
  else process.env[SSE_INSECURE_HTTP_OVERRIDE_ENV] = previousSseHttpOverride;
});

async function postJson(path: string, payload?: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload ?? {}),
  });
  return { status: res.status, body: await res.json() };
}

async function putSettings(payload: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}/api/settings`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return { status: res.status, body: await res.json() };
}

describe('connection tests never disclose or dial stored secrets', () => {
  it('stored credentials with no host-ish field are a 400, not a reachability probe of a secret', async () => {
    const secret = 'clearpass-token-s3cr3t-value';
    const save = await postJson('/api/systems/clearpass/credentials', { token: secret });
    expect(save.status).toBe(502);
    expect(save.body.ok).toBe(false);
    expect(settings.get().connectors.clearpass).toBeNull();
    expect(JSON.stringify(save.body)).not.toContain(secret);
  });

  it('an unreachable CPPM reports the target only — never the token or the socket detail', async () => {
    const secret = 'clearpass-token-s3cr3t-value';
    const save = await postJson('/api/systems/clearpass/credentials', { host: '127.0.0.1:1', token: secret });
    expect(save.status).toBe(502);
    expect(save.body.ok).toBe(false);
    expect(settings.get().connectors.clearpass).toBeNull();
    expect(JSON.stringify(save.body)).not.toContain(secret);
  });

  it('non-http(s) targets are rejected instead of probed', async () => {
    // AOS-10 is Central-derived and must reject any independent target.
    const res = await postJson('/api/systems/aos10/test', { host: 'file:///etc/passwd', token: 'unused-secret' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/discovered through Central/);
    expect(JSON.stringify(res.body)).not.toContain('unused-secret');
  });

  it('a failed fetch test keeps the error detail server-side', async () => {
    const res = await postJson('/api/systems/aos10/test', { host: 'http://127.0.0.1:1', token: 'body-secret' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no independent connector probe/);
    expect(JSON.stringify(res.body)).not.toContain('body-secret');
  });
});

describe('ClearPass connection validation', () => {
  it('mints a real token when CPPM accepts the client credentials', async () => {
    const result = await postJson('/api/systems/clearpass/test', {
      host: mockCppmBase,
      clientId: 'good-client',
      clientSecret: 'cp-secret-never-echoed',
    });
    expect(result.status).toBe(200);
    expect(result.body.ok).toBe(true);
    expect(result.body.message).toContain('authenticated');
    expect(JSON.stringify(result.body)).not.toContain('cp-secret-never-echoed');
  });

  it('passes CPPM\'s refusal detail through when the grant type is not allowed', async () => {
    const result = await postJson('/api/systems/clearpass/test', {
      host: mockCppmBase,
      clientId: 'bad-client',
      clientSecret: 'cp-secret-never-echoed',
    });
    expect(result.status).toBe(502);
    expect(result.body.ok).toBe(false);
    expect(result.body.message).toContain('rejected the credentials');
    expect(JSON.stringify(result.body)).not.toContain('cp-secret-never-echoed');
  });

  it('accepts a pre-minted token that can read the endpoint repository', async () => {
    const result = await postJson('/api/systems/clearpass/test', { host: mockCppmBase, token: 'good-token' });
    expect(result.status).toBe(200);
    expect(result.body.message).toContain('endpoint repository readable');
  });

  it('names the privilege gap when a valid token gets 403 from CPPM', async () => {
    const result = await postJson('/api/systems/clearpass/test', { host: mockCppmBase, token: 'limited-token' });
    expect(result.status).toBe(502);
    expect(result.body.message).toContain('lacks Endpoint repository privileges');
  });

  it('says the token was rejected when CPPM answers 401', async () => {
    const result = await postJson('/api/systems/clearpass/test', { host: mockCppmBase, token: 'bad-token' });
    expect(result.status).toBe(502);
    expect(result.body.message).toContain('rejected');
  });
});

describe('SSE connection validation', () => {
  it('rejects HTTP from request data before fetch unless the process override is set', async () => {
    sseRequests.length = 0;
    delete process.env[SSE_INSECURE_HTTP_OVERRIDE_ENV];
    try {
      const result = await postJson('/api/systems/sse/test', {
        token: 'must-not-leak',
        baseUrl: mockSseBase,
        allowInsecureHttp: '1',
      });

      expect(result.status).toBe(400);
      expect(result.body.error).toMatch(/must use https:\/\//);
      expect(JSON.stringify(result.body)).not.toContain('must-not-leak');
      expect(sseRequests).toEqual([]);
    } finally {
      process.env[SSE_INSECURE_HTTP_OVERRIDE_ENV] = '1';
    }
  });

  it('rejects a bare custom endpoint even when the HTTP test override is set', async () => {
    sseRequests.length = 0;
    const bare = mockSseBase.replace(/^http:\/\//, '');

    const result = await postJson('/api/systems/sse/test', { token: 'must-not-leak', baseUrl: bare });

    expect(result.status).toBe(400);
    expect(result.body.error).toMatch(/must start with https:\/\//);
    expect(JSON.stringify(result.body)).not.toContain('must-not-leak');
    expect(sseRequests).toEqual([]);
  });

  it('rejects insecure SSE endpoints through both credential save routes', async () => {
    delete process.env[SSE_INSECURE_HTTP_OVERRIDE_ENV];
    try {
      const direct = await postJson('/api/systems/sse/credentials', {
        token: 'must-not-leak',
        baseUrl: mockSseBase,
      });
      expect(direct.status).toBe(400);
      expect(direct.body.error).toMatch(/must use https:\/\//);
      expect(JSON.stringify(direct.body)).not.toContain('must-not-leak');

      const settingsSave = await putSettings({
        planes: { sse: { token: 'must-not-leak', baseUrl: mockSseBase } },
      });
      expect(settingsSave.status).toBe(400);
      expect(settingsSave.body.error).toMatch(/must use https:\/\//);
      expect(JSON.stringify(settingsSave.body)).not.toContain('must-not-leak');
      expect(settings.get().planes.sse).toBeNull();
    } finally {
      process.env[SSE_INSECURE_HTTP_OVERRIDE_ENV] = '1';
    }
  });

  it('dispatches to the authenticated minimal Connectors read and accepts a valid token', async () => {
    sseRequests.length = 0;
    const token = 'valid-sse-token';

    const result = await postJson('/api/systems/sse/test', { token, baseUrl: `${mockSseBase}///` });

    expect(result.status).toBe(200);
    expect(result.body.ok).toBe(true);
    expect(result.body.message).toContain('token accepted; Connectors query ok');
    expect(JSON.stringify(result.body)).not.toContain(token);
    expect(sseRequests).toEqual([
      {
        url: '/api/v1.0/Connectors?pagenumber=1&pagesize=1',
        authorization: `Bearer ${token}`,
      },
    ]);
    const call = registry.recentCalls('sse')[0];
    expect(call.path).toBe('GET /api/v1.0/Connectors?pagenumber=1&pagesize=1');
    expect(JSON.stringify(call)).not.toContain(token);
  });

  it('rejects an invalid token even when the custom base URL is reachable', async () => {
    const reachable = await fetch(mockSseBase);
    expect(reachable.status).toBe(200);
    sseRequests.length = 0;
    const token = 'invalid-sse-token';

    const result = await postJson('/api/systems/sse/test', { token, baseUrl: `${mockSseBase}/` });

    expect(result.status).toBe(502);
    expect(result.body.ok).toBe(false);
    expect(result.body.message).toBe('Admin API rejected the token — HTTP 401');
    expect(JSON.stringify(result.body)).not.toContain(token);
    expect(sseRequests).toEqual([
      {
        url: '/api/v1.0/Connectors?pagenumber=1&pagesize=1',
        authorization: `Bearer ${token}`,
      },
    ]);
    const call = registry.recentCalls('sse')[0];
    expect(call.code).toBe('401');
    expect(JSON.stringify(call)).not.toContain(token);
  });

  it('accepts a valid, nonempty Connectors envelope and reports its row count', async () => {
    sseRequests.length = 0;
    const token = 'nonempty-sse-token';

    const result = await postJson('/api/systems/sse/test', { token, baseUrl: mockSseBase });

    expect(result.status).toBe(200);
    expect(result.body.ok).toBe(true);
    expect(result.body.message).toContain('reported connectors: 1');
    expect(JSON.stringify(result.body)).not.toContain(token);
  });

  it('rejects a 200 response with an HTML body instead of reporting authenticated', async () => {
    sseRequests.length = 0;
    const token = 'html-sse-token';

    const result = await postJson('/api/systems/sse/test', { token, baseUrl: mockSseBase });

    expect(result.status).toBe(502);
    expect(result.body.ok).toBe(false);
    expect(result.body.message).toMatch(/unreadable \(non-JSON\) body/);
    expect(JSON.stringify(result.body)).not.toContain(token);
    expect(sseRequests).toHaveLength(1); // the request WAS made — this is a response-shape rejection, not a pre-flight one
  });

  it('rejects a 200 response with malformed JSON instead of reporting authenticated', async () => {
    sseRequests.length = 0;
    const token = 'malformed-json-sse-token';

    const result = await postJson('/api/systems/sse/test', { token, baseUrl: mockSseBase });

    expect(result.status).toBe(502);
    expect(result.body.ok).toBe(false);
    expect(result.body.message).toMatch(/unreadable \(non-JSON\) body/);
    expect(JSON.stringify(result.body)).not.toContain(token);
    expect(sseRequests).toHaveLength(1);
  });

  it('rejects a 200 response with valid but unrecognized JSON instead of reporting authenticated', async () => {
    sseRequests.length = 0;
    const token = 'unrecognized-json-sse-token';

    const result = await postJson('/api/systems/sse/test', { token, baseUrl: mockSseBase });

    expect(result.status).toBe(502);
    expect(result.body.ok).toBe(false);
    expect(result.body.message).toMatch(/unrecognized response body/);
    expect(JSON.stringify(result.body)).not.toContain(token);
    expect(sseRequests).toHaveLength(1);
  });

  it('a token-only re-key tests and saves the SAME record — the stored custom base URL, not the default', async () => {
    // Establish a custom (non-default) base URL and a token together first.
    const initialSave = await postJson('/api/systems/sse/credentials', {
      token: 'valid-sse-token',
      baseUrl: mockSseBase,
    });
    expect(initialSave.status).toBe(200);
    const normalizedCustomBase = normalizeSseBaseUrl(mockSseBase);
    expect(settings.get().planes.sse?.baseUrl).toBe(normalizedCustomBase);

    // Re-key with the token alone — baseUrl omitted, exactly what a rotate
    // flow that only wants to swap the secret should be able to send.
    sseRequests.length = 0;
    const testResult = await postJson('/api/systems/sse/test', { token: 'valid-sse-token' });
    expect(testResult.status).toBe(200);
    expect(testResult.body.ok).toBe(true);
    // The mock server (the custom base) must have been hit — not the real
    // default host, which is unreachable from this test environment.
    expect(sseRequests).toEqual([
      {
        url: '/api/v1.0/Connectors?pagenumber=1&pagesize=1',
        authorization: `Bearer valid-sse-token`,
      },
    ]);

    const rekeySave = await postJson('/api/systems/sse/credentials', { token: 'valid-sse-token' });
    expect(rekeySave.status).toBe(200);
    // The saved record must retain the stored custom base URL — not silently
    // revert to the default while the test above quietly exercised something
    // else.
    expect(settings.get().planes.sse?.baseUrl).toBe(normalizedCustomBase);
    expect(rekeySave.body.credentials.baseUrl).toBe(normalizedCustomBase);

    await fetch(`${base}/api/systems/sse`, { method: 'DELETE' }); // restore for later tests
  });

  it('replaces writable SSE scopes with an explicitly empty tested and saved array', async () => {
    try {
      const initialSave = await postJson('/api/systems/sse/credentials', {
        token: 'valid-sse-token',
        baseUrl: mockSseBase,
        scopes: ['read:inventory', 'write:brokered'],
      });
      expect(initialSave.status).toBe(200);
      expect(registry.states().sse.capabilities?.directWrite).toBe(true);

      const revoked = { token: 'valid-sse-token', scopes: [] };
      const testResult = await postJson('/api/systems/sse/test', revoked);
      expect(testResult.status).toBe(200);

      const saved = await postJson('/api/systems/sse/credentials', revoked);
      expect(saved.status).toBe(200);
      expect(settings.get().planes.sse?.scopes).toBe('');
      expect(registry.states().sse.capabilities?.directWrite).toBe(false);
    } finally {
      await fetch(`${base}/api/systems/sse`, { method: 'DELETE' });
    }
  });

  it('never logs the submitted token, on success or on any failure path', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const token = 'log-secrecy-sse-token-should-not-leak';
      await postJson('/api/systems/sse/test', { token, baseUrl: mockSseBase }); // 401 — unrecognized token
      await postJson('/api/systems/sse/test', { token, baseUrl: 'http://127.0.0.1:1' }); // unreachable
      await postJson('/api/systems/sse/credentials', { token, baseUrl: mockSseBase });
      await fetch(`${base}/api/systems/sse`, { method: 'DELETE' }); // restore

      for (const call of errorSpy.mock.calls) {
        expect(call.join(' ')).not.toContain(token);
      }
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe('PUT /api/settings', () => {
  it('masks secrets fully and round-trips a masked write-back without losing the stored secret', async () => {
    const secret = 'route-secret-9876';
    const put = await putSettings({
      planes: { central: { gatewayBaseUrl: 'https://gw.example.com', clientId: 'id-1', clientSecret: secret } },
    });
    expect(put.status).toBe(200);
    expect(put.body.planes.central.clientSecret).toBe('••••••');
    expect(JSON.stringify(put.body)).not.toContain('9876');

    // Write the masked view straight back — the stored secret must survive.
    const masked = (await fetch(`${base}/api/settings`).then((r) => r.json())) as any;
    const back = await putSettings({ planes: masked.planes });
    expect(back.status).toBe(200);
    expect(settings.get().planes.central?.clientSecret).toBe(secret);

    await putSettings({ planes: { central: null } }); // restore
  });

  it('never starts a poller that was never started (createApp is side-effect free)', async () => {
    expect(poller.isRunning()).toBe(false);
    const res = await putSettings({ pollIntervalSec: 42 });
    expect(res.status).toBe(200);
    expect(res.body.pollIntervalSec).toBe(42);
    expect(poller.isRunning()).toBe(false);
  });
});

describe('poller tick guard', () => {
  it('polls in demo mode when any section is explicitly live', async () => {
    const { Poller } = await import('../src/services/poller');
    let pullCalls = 0;
    const adapter = {
      state: () => ({ linked: true, deviceCount: 0 }),
      pull: async () => {
        pullCalls += 1;
        return {};
      },
    };
    const reg = {
      get: () => adapter,
      recordCall: () => {},
      markSyncResult: () => {},
    } as unknown as PlaneRegistry;
    const store = {
      get: () => ({ demoMode: true, blendLive: false, sectionMode: { devices: 'live' }, pollIntervalSec: 5 }),
    } as unknown as SettingsStore;
    const p = new Poller(reg, store);

    type Tickable = { tick: (id: 'mist') => Promise<unknown> };
    await (p as unknown as Tickable).tick('mist');
    expect(pullCalls).toBe(1);
  });

  it('skips a tick while the plane’s previous pull is still in flight', async () => {
    const { Poller } = await import('../src/services/poller');
    let pullCalls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const adapter = {
      state: () => ({ linked: true, deviceCount: 0 }),
      pull: async () => {
        pullCalls += 1;
        await gate;
        return {};
      },
    };
    const reg = {
      get: () => adapter,
      recordCall: () => {},
      markSyncResult: () => {},
    } as unknown as PlaneRegistry;
    const store = { get: () => ({ demoMode: false, pollIntervalSec: 5 }) } as unknown as SettingsStore;
    const p = new Poller(reg, store);

    type Tickable = { tick: (id: 'mist') => Promise<void> };
    const first = (p as unknown as Tickable).tick('mist');
    expect(pullCalls).toBe(1);
    await (p as unknown as Tickable).tick('mist'); // overlaps — must be skipped
    expect(pullCalls).toBe(1);

    release();
    await first;
    await (p as unknown as Tickable).tick('mist'); // settled — ticks again
    expect(pullCalls).toBe(2);
  });

  it('syncNow reuses the overlap guard and reports skipped linked planes', async () => {
    const { Poller } = await import('../src/services/poller');
    let release!: () => void;
    let started!: () => void;
    const pullStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const adapter = {
      state: () => ({ linked: true, deviceCount: 0 }),
      pull: async () => {
        started();
        await gate;
        return {};
      },
    };
    const reg = {
      states: () => {
        const states: Record<string, { linked: boolean }> = {};
        for (const id of ['central', 'classic', 'mist', 'greenlake', 'aos8', 'aos10', 'local', 'clearpass', 'uxi', 'sse', 'edgeconnect', 'opsramp']) {
          states[id] = { linked: id === 'mist' };
        }
        return states;
      },
      get: () => adapter,
      recordCall: () => {},
      markSyncResult: () => {},
    } as unknown as PlaneRegistry;
    const store = { get: () => ({ demoMode: true, pollIntervalSec: 5 }) } as unknown as SettingsStore;
    const p = new Poller(reg, store);

    const first = p.syncNow();
    await pullStarted;
    const overlapping = await p.syncNow();
    expect(overlapping.requested).toEqual(['mist']);
    expect(overlapping.skipped).toEqual(['mist']);

    release();
    expect((await first).synced).toEqual(['mist']);
  });

  it('clearPlane removes cached rows and invalidates an older in-flight pull', async () => {
    const { Poller } = await import('../src/services/poller');
    let release!: () => void;
    let started!: () => void;
    const pullStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const adapter = {
      state: () => ({ linked: true, deviceCount: 0 }),
      pull: async () => {
        started();
        await gate;
        return { devices: [{ name: 'old-plane-row' }] };
      },
    };
    let syncMarks = 0;
    const reg = {
      get: () => adapter,
      recordCall: () => {},
      markSyncResult: () => {
        syncMarks += 1;
      },
    } as unknown as PlaneRegistry;
    const store = { get: () => ({ demoMode: false, pollIntervalSec: 5 }) } as unknown as SettingsStore;
    const p = new Poller(reg, store);

    type Tickable = { tick: (id: 'mist') => Promise<unknown> };
    const pull = (p as unknown as Tickable).tick('mist');
    await pullStarted;
    p.clearPlane('mist');
    release();
    await pull;

    expect(p.getCache().devices).toEqual([]);
    expect(syncMarks).toBe(0);
  });
});

describe('manual systems sync', () => {
  it('POST /api/systems/sync reports an empty estate without inventing work', async () => {
    const synced = await postJson('/api/systems/sync');
    expect(synced.status).toBe(200);
    expect(synced.body).toEqual({ ok: true, requested: [], started: [], synced: [] });
  });

  it('does not create a Classic connector from a host-only draft', async () => {
    const save = await postJson('/api/systems/classic/credentials', { host: 'classic.example.test' });
    expect(save.status).toBe(400);
    expect(settings.get().connectors.classic).toBeNull();
  });
});

describe('saving credentials authenticates before indexing', () => {
  it('accepts a raw typed connector draft for an authenticated connection test', async () => {
    const draft = {
      id: 'clearpass',
      enabled: true,
      endpoint: mockCppmBase,
      auth: { kind: 'token', token: 'good-token' },
      verifyTls: false,
      pollIntervalSec: 60,
      callBudget: null,
      datasets: ['endpoints'],
      scopes: ['read:inventory'],
    };

    const tested = await postJson('/api/systems/clearpass/test', draft);

    expect(tested.status).toBe(200);
    expect(tested.body).toMatchObject({
      ok: true,
      authenticated: true,
      dataset: 'endpoints',
      source: 'request',
    });
    expect(settings.get().connectors.clearpass).toBeNull();
  });

  it('accepts and persists a raw typed connector draft only after its authenticated probe', async () => {
    const spy = vi.spyOn(poller, 'syncNowFor').mockResolvedValue('ok');
    try {
      const saved = await postJson('/api/systems/clearpass/credentials', {
        id: 'clearpass',
        enabled: true,
        endpoint: mockCppmBase,
        auth: { kind: 'token', token: 'good-token' },
        verifyTls: false,
        pollIntervalSec: 90,
        callBudget: 1234,
        datasets: ['endpoints'],
        scopes: ['read:inventory'],
      });

      expect(saved.status).toBe(200);
      expect(saved.body.indexed).toBe('ok');
      expect(spy).toHaveBeenCalledWith('clearpass');
      expect(settings.get().connectors.clearpass).toMatchObject({
        id: 'clearpass',
        endpoint: mockCppmBase,
        enabled: true,
        verifyTls: false,
        pollIntervalSec: 90,
        callBudget: 1234,
        datasets: ['endpoints'],
        scopes: ['read:inventory'],
        auth: { kind: 'token', token: 'good-token' },
      });
    } finally {
      spy.mockRestore();
      await fetch(`${base}/api/systems/clearpass`, { method: 'DELETE' });
    }
  });

  it('rejects an unreachable credential without persisting or polling it', async () => {
    const spy = vi.spyOn(poller, 'syncNowFor');
    try {
      const save = await postJson('/api/systems/clearpass/credentials', {
        host: '127.0.0.1:1',
        token: 'clearpass-token',
      });
      expect(save.status).toBe(502);
      expect(spy).not.toHaveBeenCalled();
      expect(settings.get().connectors.clearpass).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });

  it('persists only after an authenticated ClearPass endpoint read', async () => {
    const spy = vi.spyOn(poller, 'syncNowFor').mockResolvedValue('ok');
    try {
      const save = await postJson('/api/systems/clearpass/credentials', {
        host: mockCppmBase,
        token: 'good-token',
      });
      expect(save.status).toBe(200);
      expect(save.body.indexed).toBe('ok');
      expect(spy).toHaveBeenCalledWith('clearpass');
      expect(settings.get().connectors.clearpass?.enabled).toBe(true);
    } finally {
      spy.mockRestore();
      await fetch(`${base}/api/systems/clearpass`, { method: 'DELETE' });
    }
  });
});

describe('error handling keeps internals server-side', () => {
  it('5xx from a handler returns a generic error, never the fs path', async () => {
    // A read-only settings dir makes the atomic save throw an EACCES that
    // embeds the absolute settings path.
    chmodSync(tmpDir, 0o500);
    try {
      const res = await putSettings({ workspaceName: 'No Write Here' });
      expect(res.status).toBe(500);
      expect(res.body.error).toBe('internal error');
      expect(JSON.stringify(res.body)).not.toContain(tmpDir);
    } finally {
      chmodSync(tmpDir, 0o700);
    }
  });

  it('POST /api/chat refuses an unready provider without exposing MCP/LLM details', async () => {
    const cfg = await putSettings({
      mcp: { url: 'http://127.0.0.1:1/mcp', bearerToken: 'mcp-token' },
      llm: { baseUrl: 'http://127.0.0.1:1', apiKey: 'sk-test', model: 'qwen' },
    });
    expect(cfg.status).toBe(200);

    const res = await postJson('/api/chat', { messages: [{ role: 'user', content: 'hi' }] });
    // Provider readiness now happens before dispatch. A failed isolated
    // centralmcp probe is an honest conflict, not an upstream-chat failure.
    expect(res.status).toBe(409);
    expect(res.body.error).toContain("assistant provider 'ollama' is unavailable");
    expect(JSON.stringify(res.body)).not.toContain('127.0.0.1:1');

    await putSettings({ mcp: null, llm: null }); // restore
  });
});
