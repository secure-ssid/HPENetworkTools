/**
 * server/tests/settings.test.ts — settings store: masking, roundtrip, file mode.
 */

import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SettingsStore } from '../src/config/settings';

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
  it('writes defaults on first load with mode 0600', () => {
    const { file, store } = tmpStore();
    const s = store.load();
    expect(s.demoMode).toBe(true);
    expect(s.pollIntervalSec).toBe(60);
    expect(s.planes.central).toBeNull();
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('roundtrips save/load, deep-merging plane credentials', () => {
    const { file, store } = tmpStore();
    store.load();
    store.update({ workspaceName: 'Test Org', planes: { central: { gatewayBaseUrl: 'https://gw.example.com', clientId: 'id-1' } } });
    store.update({ planes: { central: { clientSecret: 'supersecretvalue' } } });

    const again = new SettingsStore(file);
    const loaded = again.load();
    expect(loaded.workspaceName).toBe('Test Org');
    expect(loaded.planes.central).toEqual({
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
    store.update({ planes: { central: { clientSecret: 'supersecretvalue' } } });
    const masked = store.maskedView().planes.central!;
    store.update({ planes: { central: masked } });
    expect(store.get().planes.central?.clientSecret).toBe('supersecretvalue');
  });

  it('clears a plane when its credentials are set to null', () => {
    const { store } = tmpStore();
    store.update({ planes: { central: { clientId: 'id-1' } } });
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
});
