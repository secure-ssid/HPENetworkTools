import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AssistantSettings } from '../src/config/settings';
import { createMcpLaunchConfig } from '../src/services/assistant/mcpLaunchConfig';
import { AssistantProviderRegistry, getAssistantDefaults } from '../src/services/assistant/registry';
import type { AssistantProviderAdapter, ReadOnlyProbeContext } from '../src/services/assistant/types';

const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map(async (path) => {
    const { rm } = await import('node:fs/promises');
    await rm(path, { recursive: true, force: true });
  }));
});

function settings(): AssistantSettings {
  return {
    activeProvider: 'codex',
    mcp: { enabled: true, endpoint: 'http://127.0.0.1:3000/mcp', authToken: null },
    chatWriteMode: 'read-only',
    providers: {
      codex: { enabled: true, model: 'gpt-5.6-terra', reasoningEffort: 'low' },
      claude: { enabled: false, model: 'sonnet', reasoningEffort: 'low' },
      kimi: { enabled: false, model: 'kimi-code/kimi-for-coding-highspeed', thinking: false },
      copilot: { enabled: false, model: 'auto', effort: 'adaptive' },
      ollama: { enabled: false, baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen2.5-coder:7b' },
      openrouter: { enabled: false, baseUrl: 'https://openrouter.ai/api/v1', model: 'openai/gpt-4.1-mini' },
    },
  };
}

describe('assistant provider registry', () => {
  it('exposes the speed-first defaults and descriptors for every supported provider', () => {
    expect(getAssistantDefaults()).toEqual([
      expect.objectContaining({ id: 'codex', title: 'Codex', executionKind: 'cli', requiredFields: ['model', 'reasoningEffort'], defaultConfig: { enabled: false, model: 'gpt-5.6-terra', reasoningEffort: 'low' } }),
      expect.objectContaining({ id: 'claude', title: 'Claude', executionKind: 'cli', requiredFields: ['model', 'reasoningEffort'], defaultConfig: { enabled: false, model: 'sonnet', reasoningEffort: 'low' } }),
      expect.objectContaining({ id: 'kimi', title: 'Kimi', executionKind: 'cli', requiredFields: ['model', 'thinking'], defaultConfig: { enabled: false, model: 'kimi-code/kimi-for-coding-highspeed', thinking: false } }),
      expect.objectContaining({ id: 'copilot', title: 'GitHub Copilot', executionKind: 'cli', requiredFields: ['model', 'effort'], defaultConfig: { enabled: false, model: 'auto', effort: 'adaptive' } }),
      expect.objectContaining({ id: 'ollama', title: 'Ollama', executionKind: 'openai-compatible', requiredFields: ['baseUrl', 'model'], defaultConfig: { enabled: false, baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen2.5-coder:7b' } }),
      expect.objectContaining({ id: 'openrouter', title: 'OpenRouter', executionKind: 'openai-compatible', requiredFields: ['baseUrl', 'model'], defaultConfig: { enabled: false, baseUrl: 'https://openrouter.ai/api/v1', model: 'openai/gpt-4.1-mini' } }),
    ]);
  });

  it('reports an unavailable executable without claiming readiness', async () => {
    const adapter: AssistantProviderAdapter = {
      id: 'codex',
      discover: async () => ({ installed: false, authenticated: false, modelReady: false, message: 'codex missing' }),
      chat: async () => ({ text: '' }),
      probeReadOnly: async () => ({ authenticated: true, modelReady: true }),
    };
    const result = await new AssistantProviderRegistry([adapter]).status(settings(), 'codex');
    expect(result).toMatchObject({ installed: false, authenticated: false, mcpReady: false, modelReady: false, selected: true, resolvedModel: null });
    expect(result.message).not.toContain('codex missing');
  });

  it('reports malformed configuration without invoking an adapter', async () => {
    let discovered = false;
    const adapter: AssistantProviderAdapter = {
      id: 'codex',
      discover: async () => { discovered = true; return { installed: true, authenticated: true, modelReady: true }; },
      chat: async () => ({ text: '' }),
      probeReadOnly: async () => ({ authenticated: true, modelReady: true }),
    };
    const invalid = settings() as unknown as { providers: { codex: { enabled: boolean; model: string; reasoningEffort: string } } };
    invalid.providers.codex.model = ' ';
    const result = await new AssistantProviderRegistry([adapter]).status(invalid, 'codex');
    expect(result).toMatchObject({ installed: false, authenticated: false, mcpReady: false, modelReady: false });
    expect(discovered).toBe(false);
  });

  it('only reports MCP ready after a recorded centralmcp read-only invocation and accounts for latency', async () => {
    const adapter: AssistantProviderAdapter = {
      id: 'codex',
      discover: async () => ({ installed: true, authenticated: true, modelReady: true }),
      chat: async () => ({ text: '' }),
      probeReadOnly: async (_config, context: ReadOnlyProbeContext) => {
        context.recordInvocation({ boundary: 'mcp', server: 'centralmcp', tool: 'find_tool', access: 'read-only' });
        return { authenticated: true, modelReady: true, resolvedModel: 'gpt-5.6-terra' };
      },
    };
    let now = 100;
    const result = await new AssistantProviderRegistry([adapter], { now: () => now++ === 100 ? 100 : 143 }).status(settings(), 'codex');
    expect(result).toMatchObject({ installed: true, authenticated: true, mcpReady: true, modelReady: true, selected: true, resolvedModel: 'gpt-5.6-terra', latencyMs: 43 });
  });

  it('does not treat provider discovery as centralmcp readiness', async () => {
    const adapter: AssistantProviderAdapter = {
      id: 'codex',
      discover: async () => ({ installed: true, authenticated: true, modelReady: true }),
      chat: async () => ({ text: '' }),
      probeReadOnly: async () => ({ authenticated: true, modelReady: true }),
    };
    const result = await new AssistantProviderRegistry([adapter]).status(settings(), 'codex');
    expect(result).toMatchObject({ installed: true, authenticated: true, modelReady: true, mcpReady: false });
  });

  it.each([
    { boundary: 'browser', tool: 'open' },
    { boundary: 'filesystem', tool: 'readFile' },
    { boundary: 'shell', tool: 'exec' },
    { boundary: 'mcp', server: 'othermcp', tool: 'find_tool', access: 'read-only' },
  ] as const)('rejects a probe that records a forbidden $boundary invocation', async (forbidden) => {
    const adapter: AssistantProviderAdapter = {
      id: 'codex',
      discover: async () => ({ installed: true, authenticated: true, modelReady: true }),
      chat: async () => ({ text: '' }),
      probeReadOnly: async (_config, context: ReadOnlyProbeContext) => {
        context.recordInvocation({ boundary: 'mcp', server: 'centralmcp', tool: 'find_tool', access: 'read-only' });
        context.recordInvocation(forbidden);
        return { authenticated: true, modelReady: true };
      },
    };
    const result = await new AssistantProviderRegistry([adapter]).status(settings(), 'codex');
    expect(result).toMatchObject({ installed: true, authenticated: true, modelReady: true, mcpReady: false });
  });
});

describe('centralmcp launch config', () => {
  it('writes an owner-only disposable centralmcp-only configuration and removes it', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'hpe-assistant-test-'));
    temporaryPaths.push(baseDir);
    const launch = await createMcpLaunchConfig({ endpoint: 'http://127.0.0.1:3000/mcp', authToken: null, baseDir });
    const content = JSON.parse(await readFile(launch.path, 'utf8'));
    expect(content).toEqual({ mcpServers: { centralmcp: { type: 'streamable-http', url: 'http://127.0.0.1:3000/mcp' } } });
    expect((await stat(launch.path)).mode & 0o777).toBe(0o600);
    await launch.dispose();
    await expect(stat(launch.path)).rejects.toThrow();
    await expect(stat(launch.directory)).rejects.toThrow();
  });

  it('removes its temporary directory when config creation fails', async () => {
    const baseDir = await mkdtemp(join(tmpdir(), 'hpe-assistant-test-'));
    temporaryPaths.push(baseDir);
    let madeDirectory = '';
    await expect(createMcpLaunchConfig(
      { endpoint: 'http://127.0.0.1:3000/mcp', authToken: null, baseDir },
      {
        mkdtemp: async (prefix) => { madeDirectory = await mkdtemp(prefix); return madeDirectory; },
        writeFile: async () => { throw new Error('disk unavailable'); },
      },
    )).rejects.toThrow('disk unavailable');
    await expect(stat(madeDirectory)).rejects.toThrow();
  });
});
