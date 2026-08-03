import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SettingsStore } from '../src/config/settings';
import type { ProviderStatus } from '../src/services/assistant/types';
import { AssistantProviderTimeoutError } from '../src/services/assistant/openaiCompatible';
import { classifyChatFailure } from '../src/routes/chat';

let server: Server;
let base: string;
let tmpDir: string;
let settings: SettingsStore;
let createChatRouter: typeof import('../src/routes/chat').createChatRouter;

const ready: ProviderStatus = {
  installed: true,
  authenticated: true,
  mcpReady: true,
  modelReady: true,
  selected: true,
  resolvedModel: 'test-model',
  latencyMs: 12,
  message: 'Provider is ready.',
};

function configureAssistant(overrides: Record<string, unknown> = {}): void {
  settings.update({
    assistant: {
      activeProvider: 'ollama',
      mcp: { enabled: true, endpoint: 'http://mcp.test/mcp', authToken: 'centralmcp-secret' },
      chatWriteMode: 'enabled',
      providers: {
        codex: { enabled: false, model: 'gpt-5.6-terra', reasoningEffort: 'low' },
        claude: { enabled: false, model: 'sonnet', reasoningEffort: 'low' },
        kimi: { enabled: false, model: 'kimi-code/kimi-for-coding-highspeed', thinking: false },
        copilot: { enabled: false, model: 'auto', effort: 'adaptive' },
        ollama: { enabled: true, baseUrl: 'http://llm.test/v1', model: 'test-model', apiKey: 'provider-secret' },
        openrouter: { enabled: false, baseUrl: 'https://router.test/v1', model: 'router-model' },
      },
      ...overrides,
    },
  });
}

async function request(path: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const response = await fetch(`${base}${path}`, init);
  return { status: response.status, body: await response.json() };
}

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'hpe-chat-route-'));
  process.env.HPE_SETTINGS_PATH = join(tmpDir, 'settings.json');
  ({ settings } = await import('../src/config/settings'));
  ({ createChatRouter } = await import('../src/routes/chat'));
});

afterAll(() => {
  server?.close();
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.HPE_SETTINGS_PATH;
});

beforeEach(() => {
  server?.close();
  configureAssistant();
});

function mount(dependencies: Parameters<typeof createChatRouter>[0]): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use('/api', createChatRouter(dependencies));
  server = app.listen(0, '127.0.0.1');
  return new Promise((resolve) => server.once('listening', () => {
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    resolve();
  }));
}

describe('assistant provider chat routes', () => {
  it('returns the active provider and a redacted readiness list', async () => {
    const status = vi.fn(async (_assistant: unknown, id: string) => ({ ...ready, selected: id === 'ollama' }));
    await mount({ providerRegistry: { status } });

    const response = await request('/api/chat/status');

    expect(response.status).toBe(200);
    expect(response.body.activeProvider).toBe('ollama');
    expect(response.body.providers).toHaveLength(6);
    expect(response.body.providers.find((provider: any) => provider.id === 'ollama')).toMatchObject(ready);
    expect(response.body.writeMode).toBe('enabled');
    expect(response.body.mcpUrl).toBe('http://mcp.test/mcp');
    expect(JSON.stringify(response.body)).not.toContain('centralmcp-secret');
    expect(JSON.stringify(response.body)).not.toContain('provider-secret');
  });

  it('dispatches chat through the persisted active provider without persisting a session override', async () => {
    const status = vi.fn(async () => ready);
    const chat = vi.fn(async () => ({ reply: 'active provider reply', transcript: [] }));
    await mount({ providerRegistry: { status }, chat });

    const response = await request('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hello' }] }),
    });

    expect(response).toMatchObject({ status: 200, body: { reply: 'active provider reply' } });
    expect(chat).toHaveBeenCalledWith(
      [{ role: 'user', content: 'hello' }],
      expect.objectContaining({ providerId: 'ollama', allowWrite: false }),
    );
    expect(settings.get().assistant.activeProvider).toBe('ollama');
  });

  it('accepts an enabled saved session provider without changing the active selection', async () => {
    configureAssistant({ providers: {
      ...settings.get().assistant.providers,
      openrouter: { enabled: true, baseUrl: 'https://router.test/v1', model: 'router-model' },
    } });
    const status = vi.fn(async () => ready);
    const chat = vi.fn(async () => ({ reply: 'session provider reply', transcript: [] }));
    await mount({ providerRegistry: { status }, chat });

    const response = await request('/api/chat', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ providerId: 'openrouter', messages: [{ role: 'user', content: 'hello' }] }),
    });

    expect(response).toMatchObject({ status: 200, body: { reply: 'session provider reply' } });
    expect(chat).toHaveBeenCalledWith(expect.any(Array), expect.objectContaining({ providerId: 'openrouter' }));
    expect(settings.get().assistant.activeProvider).toBe('ollama');
  });

  it('rejects a disabled or unready selected provider with an actionable 409', async () => {
    const status = vi.fn(async () => ({ ...ready, mcpReady: false, message: 'Provider is unavailable.' }));
    const chat = vi.fn();
    await mount({ providerRegistry: { status }, chat });

    const response = await request('/api/chat', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hello' }] }),
    });

    expect(response.status).toBe(409);
    expect(response.body.error).toMatch(/unavailable.*Test provider/i);
    expect(chat).not.toHaveBeenCalled();
  });

  it('runs the explicit provider test through the read-only registry path only', async () => {
    const invocations: Array<{ tool: string; access: string }> = [];
    const status = vi.fn(async () => {
      invocations.push({ tool: 'find_tool', access: 'read-only' });
      return ready;
    });
    await mount({ providerRegistry: { status } });

    const response = await request('/api/chat/providers/ollama/test', { method: 'POST' });

    expect(response).toMatchObject({ status: 200, body: ready });
    expect(status).toHaveBeenCalledWith(settings.get().assistant, 'ollama');
    expect(invocations).toEqual([{ tool: 'find_tool', access: 'read-only' }]);
    expect(invocations.some((invocation) => invocation.access === 'write' || invocation.tool === 'invoke_tool')).toBe(false);
  });
});

describe('chat provider failure responses', () => {
  it('returns a distinct safe gateway-timeout response for a provider timeout', () => {
    expect(classifyChatFailure(new AssistantProviderTimeoutError(15_000))).toEqual({
      status: 504,
      error: 'assistant provider timed out — try again shortly',
      logMessage: 'assistant provider timed out after 15000ms',
    });
  });

  it('keeps all other provider failures generic and never returns their message', () => {
    const failure = classifyChatFailure(new Error('assistant provider HTTP 401: Bearer sk-secret'));
    expect(failure.status).toBe(502);
    expect(failure.error).toBe('assistant request failed upstream — check the MCP/LLM configuration');
    expect(failure.error).not.toContain('sk-secret');
    expect(failure.logMessage).not.toContain('sk-secret');
  });
});
