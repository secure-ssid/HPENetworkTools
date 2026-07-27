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
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PlaneRegistry } from '../src/planes/registry';
import type { SettingsStore } from '../src/config/settings';

let server: Server;
let base: string;
let tmpDir: string;
let settings: (typeof import('../src/config/settings'))['settings'];
let poller: (typeof import('../src/services/poller'))['poller'];

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'hpe-systems-'));
  process.env.HPE_SETTINGS_PATH = join(tmpDir, 'settings.json');
  process.env.HPE_DATA_DIR = join(tmpDir, 'data'); // ticket writes land in tmp, never real data/
  const index = await import('../src/index');
  ({ settings } = await import('../src/config/settings'));
  ({ poller } = await import('../src/services/poller'));
  server = index.createApp().listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.HPE_SETTINGS_PATH;
  delete process.env.HPE_DATA_DIR;
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
    expect(save.status).toBe(200);

    const res = await fetch(`${base}/api/systems/clearpass/test`, { method: 'POST' });
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.error).toMatch(/no credentials\/host/);
    expect(JSON.stringify(body)).not.toContain(secret);
  });

  it('a failed TCP test reports host:port only — never the token or the socket detail', async () => {
    const secret = 'clearpass-token-s3cr3t-value';
    const save = await postJson('/api/systems/clearpass/credentials', { host: '127.0.0.1:1', token: secret });
    expect(save.status).toBe(200);

    const res = await fetch(`${base}/api/systems/clearpass/test`, { method: 'POST' });
    expect(res.status).toBe(502);
    const body = (await res.json()) as any;
    expect(body.message).toBe('TCP connect to 127.0.0.1:1 failed');
    expect(JSON.stringify(body)).not.toContain(secret);

    await fetch(`${base}/api/systems/clearpass`, { method: 'DELETE' }); // restore
  });

  it('non-http(s) targets are rejected instead of probed', async () => {
    const res = await postJson('/api/systems/classic/test', { host: 'file:///etc/passwd', token: 'unused-secret' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/cannot parse a host/);
    expect(JSON.stringify(res.body)).not.toContain('unused-secret');
  });

  it('a failed fetch test keeps the error detail server-side', async () => {
    const res = await postJson('/api/systems/classic/test', { host: 'http://127.0.0.1:1', token: 'body-secret' });
    expect(res.status).toBe(502);
    expect(res.body.message).toBe('cannot reach http://127.0.0.1:1');
    expect(JSON.stringify(res.body)).not.toContain('body-secret');
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
        for (const id of ['central', 'classic', 'mist', 'greenlake', 'aos8', 'aos10', 'local', 'clearpass', 'uxi']) {
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
  it('POST /api/systems/sync immediately polls linked planes even in demo mode', async () => {
    const save = await postJson('/api/systems/classic/credentials', { host: 'classic.example.test' });
    expect(save.status).toBe(200);
    try {
      const synced = await postJson('/api/systems/sync');
      expect(synced.status).toBe(200);
      expect(synced.body).toEqual({ ok: true, started: ['classic'] });
    } finally {
      await fetch(`${base}/api/systems/classic`, { method: 'DELETE' });
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

  it('POST /api/chat returns a generic 502, not the MCP/LLM error text', async () => {
    const cfg = await putSettings({
      mcp: { url: 'http://127.0.0.1:1/mcp', bearerToken: 'mcp-token' },
      llm: { baseUrl: 'http://127.0.0.1:1', apiKey: 'sk-test', model: 'qwen' },
    });
    expect(cfg.status).toBe(200);

    const res = await postJson('/api/chat', { messages: [{ role: 'user', content: 'hi' }] });
    expect(res.status).toBe(502);
    expect(res.body.error).toBe('assistant request failed upstream — check the MCP/LLM configuration');
    expect(JSON.stringify(res.body)).not.toContain('127.0.0.1:1');

    await putSettings({ mcp: null, llm: null }); // restore
  });
});
