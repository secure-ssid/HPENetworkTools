/**
 * server/tests/settings.test.ts — settings store: masking, roundtrip, file mode.
 */

import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

// The settings singleton the router uses resolves its path at construction, so
// point it at a tmp file before any module under test is imported. Without
// this the route test below would write the developer's real settings.json.
const ROUTE_DIR = vi.hoisted(() => {
  const dir = `${process.env.TMPDIR?.replace(/\/$/, '') ?? '/tmp'}/hpe-settings-route-${process.pid}-${Date.now()}`;
  process.env.HPE_SETTINGS_PATH = `${dir}/settings.json`;
  return dir;
});

import express from 'express';
import { migrateAssistantSettings, SettingsStore, settings } from '../src/config/settings';
import { settingsRouter } from '../src/routes/settings';
import { registry } from '../src/planes/registry';
import { poller } from '../src/services/poller';

const dirs: string[] = [];

function tmpStore(): { dir: string; file: string; store: SettingsStore } {
  const dir = mkdtempSync(join(tmpdir(), 'hpe-settings-'));
  dirs.push(dir);
  const file = join(dir, 'settings.json');
  return { dir, file, store: new SettingsStore(file) };
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('SettingsStore', () => {
  it('migrates a local legacy OpenAI-compatible LLM into the Ollama provider and masks its key', () => {
    const { store } = tmpStore();
    store.update({
      mcp: { url: 'http://centralmcp.local/mcp', bearerToken: 'mcp-token' },
      llm: { baseUrl: 'http://127.0.0.1:11434/v1', apiKey: 'ollama-key', model: 'qwen-local' },
      chatWriteMode: true,
    });

    const assistant = store.get().assistant;
    expect(assistant.activeProvider).toBe('ollama');
    expect(assistant.providers.ollama).toMatchObject({
      enabled: true, baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen-local', apiKey: 'ollama-key',
    });
    expect(assistant.mcp).toEqual({ enabled: true, endpoint: 'http://centralmcp.local/mcp', authToken: 'mcp-token' });
    expect(assistant.chatWriteMode).toBe('enabled');
    expect(store.maskedView().assistant.providers.ollama.apiKey).toBe('••••••');
    expect(store.maskedView().assistant.mcp.authToken).toBe('••••••');
  });

  it('migrates a non-local legacy OpenAI-compatible LLM into OpenRouter', () => {
    const assistant = migrateAssistantSettings({
      llm: { baseUrl: 'https://gateway.example.com/v1', apiKey: 'router-key', model: 'fast-model' },
    });
    expect(assistant.activeProvider).toBe('openrouter');
    expect(assistant.providers.openrouter).toMatchObject({
      enabled: true, baseUrl: 'https://gateway.example.com/v1', model: 'fast-model', apiKey: 'router-key',
    });
  });

  it('uses canonical assistant defaults when legacy settings are blank', () => {
    const assistant = migrateAssistantSettings({
      mcp: { url: '', bearerToken: '' },
      llm: { baseUrl: '', apiKey: '', model: '' },
    });
    expect(assistant.activeProvider).toBe('ollama');
    expect(assistant.mcp.enabled).toBe(false);
    expect(assistant.providers.ollama.enabled).toBe(false);
    expect(assistant.providers.codex).toMatchObject({ model: 'gpt-5.6-terra', reasoningEffort: 'low' });
    expect(assistant.providers.kimi).toMatchObject({ model: 'kimi-code/kimi-for-coding-highspeed', thinking: false });
  });

  it('keeps an existing canonical assistant object unchanged during migration', () => {
    const existing = {
      activeProvider: 'copilot',
      mcp: { enabled: false, endpoint: 'http://127.0.0.1:3000/mcp', authToken: null },
      chatWriteMode: 'confirm',
      providers: {
        codex: { enabled: false, model: 'gpt-5.6-terra', reasoningEffort: 'low' },
        claude: { enabled: false, model: 'sonnet', reasoningEffort: 'low' },
        kimi: { enabled: false, model: 'kimi-code/kimi-for-coding-highspeed', thinking: false },
        copilot: { enabled: true, model: 'auto', effort: 'adaptive' },
        ollama: { enabled: false, baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen2.5-coder:7b' },
        openrouter: { enabled: false, baseUrl: 'https://openrouter.ai/api/v1', model: 'openai/gpt-4.1-mini' },
      },
    } as const;
    expect(migrateAssistantSettings({ assistant: existing, llm: { baseUrl: 'https://ignored.example/v1', apiKey: 'ignored', model: 'ignored' } })).toEqual(existing);
  });

  it('rejects invalid canonical provider configuration before saving', () => {
    const { store } = tmpStore();
    expect(() => store.update({ assistant: { providers: { unknown: {} } } })).toThrow(/unrecognized assistant provider/);
    expect(() => store.update({ assistant: { providers: { ollama: { baseUrl: 'file:///tmp/model' } } } })).toThrow(/HTTP\(S\)/);
    expect(() => store.update({ assistant: { providers: { codex: { model: ' ', reasoningEffort: 'maximum' } } } })).toThrow(/model is required/);
    expect(() => store.update({ assistant: { providers: { kimi: { thinking: 'sometimes' } } } })).toThrow();
  });

  it('writes defaults on first load with mode 0600', () => {
    const { file, store } = tmpStore();
    const s = store.load();
    expect(s.demoMode).toBe(true);
    expect(s.pollIntervalSec).toBe(60);
    expect(s.connectors.central).toBeNull();
    expect(s.planes.central).toBeNull();
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('migrates a complete legacy plane once and persists the typed connector on the next save', () => {
    const { file, store } = tmpStore();
    writeFileSync(file, JSON.stringify({
      demoMode: false,
      planes: {
        opsramp: {
          tenantId: 'tenant-a',
          clientId: 'client-a',
          clientSecret: 'secret-a',
        },
      },
    }));

    const loaded = store.load();
    expect(loaded.connectors.opsramp).toMatchObject({
      id: 'opsramp',
      enabled: true,
      endpoint: 'https://app.opsramp.net',
      auth: {
        kind: 'oauth_client_credentials',
        tenantId: 'tenant-a',
        clientId: 'client-a',
        clientSecret: 'secret-a',
      },
    });
    expect(loaded.planes.opsramp).toMatchObject({
      baseUrl: 'https://app.opsramp.net',
      tenantId: 'tenant-a',
      clientId: 'client-a',
      clientSecret: 'secret-a',
    });

    store.update({ workspaceName: 'Migrated workspace' });
    const persisted = JSON.parse(readFileSync(file, 'utf8')) as Record<string, any>;
    expect(persisted.connectors.opsramp).toMatchObject({ id: 'opsramp', endpoint: 'https://app.opsramp.net' });
  });

  it('treats a typed connector as authoritative over stale legacy plane credentials', () => {
    const { file, store } = tmpStore();
    writeFileSync(file, JSON.stringify({
      connectors: {
        opsramp: {
          id: 'opsramp', enabled: true, endpoint: 'https://typed.opsramp.example',
          auth: {
            kind: 'oauth_client_credentials', tenantId: 'typed-tenant',
            clientId: 'typed-client', clientSecret: 'typed-secret',
          },
          verifyTls: true, pollIntervalSec: 60, callBudget: null,
          datasets: ['devices', 'alerts'], scopes: ['read:inventory'],
        },
      },
      planes: {
        opsramp: {
          baseUrl: 'https://stale.opsramp.example', tenantId: 'stale-tenant',
          clientId: 'stale-client', clientSecret: 'stale-secret',
        },
      },
    }));

    const loaded = store.load();
    expect(loaded.connectors.opsramp?.endpoint).toBe('https://typed.opsramp.example');
    expect(loaded.planes.opsramp?.baseUrl).toBe('https://typed.opsramp.example');
    expect(JSON.stringify(loaded)).not.toContain('stale-secret');
  });

  it('masks typed connector secrets and preserves them across a masked round-trip', () => {
    const { store } = tmpStore();
    store.update({
      connectors: {
        opsramp: {
          id: 'opsramp', enabled: true, endpoint: 'https://app.opsramp.net',
          auth: {
            kind: 'oauth_client_credentials', tenantId: 'tenant-a',
            clientId: 'client-a', clientSecret: 'secret-a',
          },
          verifyTls: true, pollIntervalSec: 60, callBudget: null,
          datasets: ['devices', 'alerts'], scopes: ['read:inventory'],
        },
      },
    });

    const masked = store.maskedView();
    expect(masked.connectors.opsramp?.auth).toMatchObject({
      kind: 'oauth_client_credentials',
      clientSecret: '••••••',
    });
    expect(JSON.stringify(masked)).not.toContain('secret-a');

    store.update({ connectors: { opsramp: masked.connectors.opsramp } });
    expect(store.get().connectors.opsramp?.auth).toMatchObject({ clientSecret: 'secret-a' });
  });

  it('replaces auth on a kind switch instead of carrying masked fields across kinds', () => {
    const { store } = tmpStore();
    store.update({ connectors: { edgeconnect: {
      id: 'edgeconnect', enabled: true, endpoint: 'https://orchestrator.example.com',
      auth: { kind: 'api_key', apiKey: 'edge-key' },
      verifyTls: true, pollIntervalSec: 60, callBudget: null,
      datasets: ['devices'], scopes: ['read:inventory'],
    } } });

    store.update({ connectors: { edgeconnect: {
      auth: { kind: 'username_password', username: 'operator', password: 'new-password' },
    } } });
    expect(store.get().connectors.edgeconnect?.auth).toEqual({
      kind: 'username_password', username: 'operator', password: 'new-password',
    });

    expect(() => store.update({ connectors: { edgeconnect: {
      auth: { kind: 'api_key', apiKey: '••••••' },
    } } })).toThrow(/no stored value to preserve/);
  });

  it('supports both ClearPass auth transitions without retaining fields from the old kind', () => {
    const { store } = tmpStore();
    store.update({ connectors: { clearpass: {
      id: 'clearpass', enabled: true, endpoint: 'https://cppm.example.com',
      auth: { kind: 'oauth_client_credentials', clientId: 'client-a', clientSecret: 'secret-a' },
      verifyTls: true, pollIntervalSec: 60, callBudget: null,
      datasets: ['authEvents'], scopes: ['read:inventory'],
    } } });

    store.update({ connectors: { clearpass: { auth: { kind: 'token', token: 'token-a' } } } });
    expect(store.get().connectors.clearpass?.auth).toEqual({ kind: 'token', token: 'token-a' });

    store.update({ connectors: { clearpass: {
      auth: { kind: 'oauth_client_credentials', clientId: 'client-b', clientSecret: 'secret-b' },
    } } });
    expect(store.get().connectors.clearpass?.auth).toEqual({
      kind: 'oauth_client_credentials', clientId: 'client-b', clientSecret: 'secret-b',
    });
  });

  it('roundtrips save/load, deep-merging plane credentials', () => {
    const { file, store } = tmpStore();
    store.load();
    store.update({ workspaceName: 'Test Org', planes: { central: {
      gatewayBaseUrl: 'https://gw.example.com', clientId: 'id-0', clientSecret: 'supersecretvalue',
    } } });
    store.update({ planes: { central: { clientId: 'id-1' } } });

    const again = new SettingsStore(file);
    const loaded = again.load();
    expect(loaded.workspaceName).toBe('Test Org');
    expect(loaded.planes.central).toMatchObject({
      gatewayBaseUrl: 'https://gw.example.com',
      clientId: 'id-1',
      clientSecret: 'supersecretvalue',
    });
    expect(loaded.planes.mist).toBeNull();
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('deep-merges partial MCP and LLM updates without erasing omitted fields', () => {
    const { store } = tmpStore();
    store.update({
      mcp: { url: 'http://mcp.example.com', bearerToken: 'token-1' },
      llm: { baseUrl: 'http://llm.example.com', apiKey: 'key-1', model: 'model-1' },
    });
    store.update({ mcp: { url: 'http://mcp-2.example.com' }, llm: { model: 'model-2' } });
    expect(store.get().mcp).toEqual({ url: 'http://mcp-2.example.com', bearerToken: 'token-1' });
    expect(store.get().llm).toEqual({
      baseUrl: 'http://llm.example.com',
      apiKey: 'key-1',
      model: 'model-2',
    });
  });

  it('rolls back in-memory settings when persistence fails', () => {
    const { dir, store } = tmpStore();
    store.update({ workspaceName: 'Persisted workspace' });
    rmSync(dir, { recursive: true, force: true });
    writeFileSync(dir, 'blocks directory recreation');

    expect(() => store.update({ workspaceName: 'Must not stick' })).toThrow();
    expect(store.get().workspaceName).toBe('Persisted workspace');
  });

  it('maskedView masks only secret-ish keys, keeps the raw store intact', () => {
    const { store } = tmpStore();
    store.update({
      planes: { central: { gatewayBaseUrl: 'https://gw.example.com', clientId: 'plain-id', clientSecret: 'supersecretvalue' } },
      mcp: { url: 'http://mcp.example.com', bearerToken: 'tok-1234567890' },
      llm: { baseUrl: 'http://llm.example.com', apiKey: 'sk-abcdef', model: 'qwen' },
    });

    const mv = store.maskedView();
    expect(mv.planes.central?.clientSecret).toBe('••••••');
    expect(mv.planes.central?.clientId).toBe('plain-id');
    expect(mv.planes.central?.gatewayBaseUrl).toBe('https://gw.example.com');
    expect(mv.mcp?.bearerToken).toBe('••••••');
    expect(mv.llm?.apiKey).toBe('••••••');

    // Raw store untouched, and no secret leaks anywhere in the view — not
    // even the trailing characters of a secret.
    expect(store.get().planes.central?.clientSecret).toBe('supersecretvalue');
    const serialized = JSON.stringify(mv);
    expect(serialized).not.toContain('supersecretvalue');
    expect(serialized).not.toContain('tok-1234567890');
    expect(serialized).not.toContain('sk-abcdef');
    expect(serialized).not.toContain('alue');
    expect(serialized).not.toContain('7890');
    expect(serialized).not.toContain('cdef');
  });

  it('ignores masked values written back over stored secrets', () => {
    const { store } = tmpStore();
    store.update({ planes: { central: {
      gatewayBaseUrl: 'https://gw.example.com', clientId: 'id-1', clientSecret: 'supersecretvalue',
    } } });
    const masked = store.maskedView().planes.central!;
    store.update({ planes: { central: masked } });
    expect(store.get().planes.central?.clientSecret).toBe('supersecretvalue');
  });

  it('clears a plane when its credentials are set to null', () => {
    const { store } = tmpStore();
    store.update({ planes: { central: {
      gatewayBaseUrl: 'https://gw.example.com', clientId: 'id-1', clientSecret: 'supersecretvalue',
    } } });
    expect(store.get().planes.central).not.toBeNull();
    store.update({ planes: { central: null } });
    expect(store.get().planes.central).toBeNull();
  });

  it('throws a clear error on a corrupt settings file', () => {
    const { file, store } = tmpStore();
    store.load();
    const raw = readFileSync(file, 'utf8');
    expect(raw.length).toBeGreaterThan(0);
    writeFileSync(file, '{ not json');
    expect(() => new SettingsStore(file).load()).toThrow(/not valid JSON/);
  });

  /* The web shell's table column configs and saved views are opaque maps the
   * server does not interpret — but they must survive the store: accepted by
   * update(), kept across unrelated writes, and persisted to disk. */
  it('passes tableColumns and savedViews through, keeping them across unrelated updates', () => {
    const { file, store } = tmpStore();
    store.load();
    store.update({
      tableColumns: { devices: { hidden: ['model'] } },
      savedViews: { devices: [{ name: 'WAN focus', filters: { q: 'wan' }, density: 'compact' }] },
    });
    // An unrelated preference write must not drop either map.
    store.update({ workspaceName: 'Unrelated' });
    expect(store.get().tableColumns).toEqual({ devices: { hidden: ['model'] } });
    expect(store.get().savedViews).toEqual({
      devices: [{ name: 'WAN focus', filters: { q: 'wan' }, density: 'compact' }],
    });

    const loaded = new SettingsStore(file).load();
    expect(loaded.tableColumns).toEqual({ devices: { hidden: ['model'] } });
    expect(loaded.savedViews).toEqual({
      devices: [{ name: 'WAN focus', filters: { q: 'wan' }, density: 'compact' }],
    });

    // Whole-map replace, never a deep merge: the client always sends its full map.
    store.update({ tableColumns: { alerts: { hidden: ['site'] } } });
    expect(store.get().tableColumns).toEqual({ alerts: { hidden: ['site'] } });
  });
});

/**
 * PUT /api/settings must not treat "the body mentioned planes" as "credentials
 * changed": the shell round-trips the whole settings blob on a density or
 * workspace-name write, and clearing the poller cache there blanks every live
 * screen for a poll interval.
 */
describe('PUT /api/settings plane reinit guard', () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    const app = express();
    app.use(express.json({ limit: '1mb' }));
    app.use('/api', settingsRouter);
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(ROUTE_DIR, { recursive: true, force: true });
    delete process.env.HPE_SETTINGS_PATH;
  });

  async function put(body: unknown): Promise<{ status: number; body: any }> {
    const res = await fetch(`${base}/api/settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  }

  it('reinitialises a plane whose credentials really changed, and only then', async () => {
    // Spies only — they call through; the guard is what we are asserting on.
    const clear = vi.spyOn(poller, 'clearPlane');
    const reinit = vi.spyOn(registry, 'reinitPlane');
    try {
      const saved = await put({
        planes: { central: { gatewayBaseUrl: 'https://gw.example.com', clientId: 'id-1', clientSecret: 'supersecretvalue' } },
      });
      expect(saved.status).toBe(200);
      expect(clear).toHaveBeenCalledWith('central');
      expect(reinit).toHaveBeenCalledWith('central');

      // The shell's preference write: the whole masked blob back with one UI
      // key changed. Nothing about central actually moved.
      clear.mockClear();
      reinit.mockClear();
      const masked = (await (await fetch(`${base}/api/settings`)).json()) as Record<string, unknown>;
      const echoed = await put({ ...masked, density: 'compact' });
      expect(echoed.status).toBe(200);
      expect(echoed.body.density).toBe('compact');
      expect(clear).not.toHaveBeenCalled();
      expect(reinit).not.toHaveBeenCalled();
      // …and the masked secret round-trip did not damage the stored record.
      expect(echoed.body.planes.central.clientId).toBe('id-1');
      expect(echoed.body.planes.central.gatewayBaseUrl).toBe('https://gw.example.com');

      // A real credential edit still reinitialises.
      clear.mockClear();
      reinit.mockClear();
      await put({ planes: { central: { clientId: 'id-2' } } });
      expect(clear).toHaveBeenCalledWith('central');
      expect(reinit).toHaveBeenCalledWith('central');

      // Clearing a plane counts as a change; an untouched plane never does.
      clear.mockClear();
      reinit.mockClear();
      await put({ planes: { central: null, mist: null } });
      expect(clear).toHaveBeenCalledWith('central');
      expect(clear).not.toHaveBeenCalledWith('mist'); // already null — no change
    } finally {
      clear.mockRestore();
      reinit.mockRestore();
    }
  });
});

/**
 * PUT /api/settings accepts an auth block (the settings screen echoes the
 * whole masked store back), so it must apply the same validation as
 * PUT /api/auth/config — otherwise it is a weaker path onto the identity
 * provider than the dedicated route.
 */
describe('PUT /api/settings auth validation', () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    const app = express();
    app.use(express.json({ limit: '1mb' }));
    app.use('/api', settingsRouter);
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    // The singleton store writes through to ROUTE_DIR on every update; the
    // reinit-guard describe above has already removed it once.
    rmSync(ROUTE_DIR, { recursive: true, force: true });
  });

  async function put(body: unknown): Promise<{ status: number; body: any }> {
    const res = await fetch(`${base}/api/settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  }

  it('rejects an invalid identity provider rather than persisting it', async () => {
    const plainHttpIssuer = await put({
      auth: {
        issuer: 'http://evil.example.com',
        clientId: 'portal',
        clientSecret: 's3cret-value',
        redirectUri: 'https://portal.example.com/api/auth/callback',
      },
    });
    expect(plainHttpIssuer.status).toBe(400);
    expect(plainHttpIssuer.body.error).toBe('issuer must use HTTPS (http is allowed only for loopback)');

    const badRedirect = await put({
      auth: {
        issuer: 'https://idp.example.com',
        clientId: 'portal',
        clientSecret: 's3cret-value',
        redirectUri: 'not a url',
      },
    });
    expect(badRedirect.status).toBe(400);
    expect(badRedirect.body.error).toBe('redirectUri must be a valid absolute URL');

    // Nothing reached the store through the side door.
    expect(settings.get().auth).toBeNull();
  });

  it('accepts a valid provider and keeps the stored secret on a masked round-trip', async () => {
    const saved = await put({
      auth: {
        issuer: 'https://idp.example.com',
        clientId: 'portal',
        clientSecret: 'real-secret',
        redirectUri: 'https://portal.example.com/api/auth/callback',
        allowedGroups: ['netops'],
      },
    });
    expect(saved.status).toBe(200);
    expect(saved.body.auth.clientSecret).toBe('••••••');
    expect(settings.get().auth?.clientSecret).toBe('real-secret');

    // The settings screen's write: the whole masked blob echoed back with one
    // preference changed. The masked auth block must validate, and the stored
    // secret must survive the round-trip untouched.
    const masked = (await (await fetch(`${base}/api/settings`)).json()) as Record<string, unknown>;
    const echoed = await put({ ...masked, workspaceName: 'Round Trip' });
    expect(echoed.status).toBe(200);
    expect(settings.get().auth?.clientSecret).toBe('real-secret');
    expect(settings.get().auth?.issuer).toBe('https://idp.example.com');
    expect(settings.get().workspaceName).toBe('Round Trip');

    // Null removes the provider, as DELETE /api/auth/config does.
    const removed = await put({ auth: null });
    expect(removed.status).toBe(200);
    expect(settings.get().auth).toBeNull();
  });
});

/**
 * The web shell syncs its table column configs and saved views through
 * /api/settings (SettingsContext.tsx): both are opaque object maps the route
 * must accept, serve back, and keep on a masked round-trip — and a non-object
 * value must still fail validation rather than reaching the store.
 */
describe('PUT /api/settings UI layout keys', () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    const app = express();
    app.use(express.json({ limit: '1mb' }));
    app.use('/api', settingsRouter);
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(ROUTE_DIR, { recursive: true, force: true });
  });

  async function put(body: unknown): Promise<{ status: number; body: any }> {
    const res = await fetch(`${base}/api/settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  }

  const COLUMNS = { devices: { hidden: ['model'], order: ['state', 'device'] } };
  const VIEWS = { devices: [{ name: 'WAN focus', filters: { facets: { plane: ['CENTRAL'] } }, density: 'compact' }] };

  it('accepts tableColumns and savedViews, serves them back, and keeps them on a shell round-trip', async () => {
    const saved = await put({
      density: 'comfortable',
      inventoryView: 'Unified table',
      showPlatformTags: true,
      workspaceName: 'Meridian Health',
      pollIntervalSec: 60,
      tableColumns: COLUMNS,
      savedViews: VIEWS,
    });
    expect(saved.status).toBe(200);
    expect(saved.body.tableColumns).toEqual(COLUMNS);
    expect(saved.body.savedViews).toEqual(VIEWS);

    // The shell's next preference write echoes the masked blob with one key
    // changed and only ONE of the maps: the other must survive — the merged
    // store only touches keys the patch actually carries.
    const masked = (await (await fetch(`${base}/api/settings`)).json()) as Record<string, unknown>;
    const echoed = await put({ ...masked, workspaceName: 'Round Trip', tableColumns: { alerts: { hidden: ['site'] } } });
    expect(echoed.status).toBe(200);
    expect(echoed.body.tableColumns).toEqual({ alerts: { hidden: ['site'] } });
    expect(echoed.body.savedViews).toEqual(VIEWS);
  });

  it('rejects a non-object tableColumns or savedViews instead of persisting it', async () => {
    const badColumns = await put({ tableColumns: ['not-an-object'] });
    expect(badColumns.status).toBe(400);
    expect(badColumns.body.error).toBe('invalid settings fields: tableColumns');

    const badViews = await put({ savedViews: 'nope' });
    expect(badViews.status).toBe(400);
    expect(badViews.body.error).toBe('invalid settings fields: savedViews');

    // A body that names ONLY an unsupported key is still a 400.
    const unknown = await put({ somethingElse: {} });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error).toBe('settings body contains no supported fields');
  });
});

describe('PUT /api/settings assistant registry', () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    const app = express();
    app.use(express.json({ limit: '1mb' }));
    app.use('/api', settingsRouter);
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(ROUTE_DIR, { recursive: true, force: true });
  });

  it('accepts canonical assistant updates and rejects unknown provider ids', async () => {
    const put = async (body: unknown) => {
      const res = await fetch(`${base}/api/settings`, {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      return { status: res.status, body: await res.json() as any };
    };
    const saved = await put({ assistant: { activeProvider: 'copilot', providers: { copilot: { enabled: true } } } });
    expect(saved.status).toBe(200);
    expect(saved.body.assistant.activeProvider).toBe('copilot');
    expect(saved.body.assistant.providers.copilot.enabled).toBe(true);

    const invalid = await put({ assistant: { providers: { arbitrary: {} } } });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error).toMatch(/unrecognized assistant provider/);
  });
});
