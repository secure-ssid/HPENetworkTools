/**
 * server/tests/mcpChat.test.ts — MCP streamable-HTTP client + LLM tool loop.
 *
 * Covers: the initialize handshake and Mcp-Session-Id capture, SSE response
 * parsing, the re-init-once-on-session-error retry, the write-tool gating
 * (invoke_tool offered when saved lab write mode is enabled; a hallucinated
 * write remains refused when it is disabled), and the full
 * chat loop against a scripted fetch (tool_call round, then a final answer).
 *
 * HPE_SETTINGS_PATH points at a tmp dir; global fetch is stubbed per test.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { McpClient as McpClientType, chatLoop as chatLoopType } from '../src/services/mcpChat';
import type { SettingsStore } from '../src/config/settings';
import { OpenAICompatibleAdapter, resolveProviderTimeoutMs } from '../src/services/assistant/openaiCompatible';
import { CodexAdapter } from '../src/services/assistant/cliAdapters';
import {
  CodexAppServer,
  type CodexAppServerChild,
  type CodexAppServerFileSystem,
  type CodexAppServerLaunch,
} from '../src/services/assistant/codexAppServer';

let tmpDir: string;
let McpClient: typeof McpClientType;
let chatLoop: typeof chatLoopType;
let settings: SettingsStore;

const MCP_URL = 'http://mcp.test/mcp';
// Legacy LLM updates classify loopback endpoints as Ollama, matching the
// provider this suite exercises through its compatibility path.
const LLM_URL = 'http://127.0.0.1:11434/v1';
const OPENROUTER_URL = 'https://router.test/v1';

interface CapturedRequest {
  url: string;
  headers: Record<string, string>;
  body: any; // parsed JSON payload
}

let requests: CapturedRequest[] = [];

function record(url: unknown, init?: RequestInit): CapturedRequest {
  const captured: CapturedRequest = {
    url: String(url),
    headers: (init?.headers ?? {}) as Record<string, string>,
    body: init?.body ? JSON.parse(String(init.body)) : undefined,
  };
  requests.push(captured);
  return captured;
}

function jsonRpc(result: unknown, id: number | string = 1): unknown {
  return { jsonrpc: '2.0', id, result };
}

function jsonResponse(body: unknown, init?: { status?: number; headers?: Record<string, string> }): Response {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
}

function sseResponse(payloads: unknown[], init?: { headers?: Record<string, string> }): Response {
  const body = payloads.map((p) => `data: ${JSON.stringify(p)}\n\n`).join('');
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream', ...(init?.headers ?? {}) },
  });
}

/** OpenAI-shaped completion payload. */
function llmMessage(message: unknown): Response {
  return jsonResponse({ choices: [{ message }] });
}

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'hpe-mcpchat-'));
  process.env.HPE_SETTINGS_PATH = join(tmpDir, 'settings.json');
  const mod = await import('../src/services/mcpChat');
  const cfg = await import('../src/config/settings');
  McpClient = mod.McpClient;
  chatLoop = mod.chatLoop;
  settings = cfg.settings;
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.HPE_SETTINGS_PATH;
});

beforeEach(() => {
  requests = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('McpClient', () => {
  it('runs the initialize handshake, captures Mcp-Session-Id and echoes it', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown, init?: RequestInit) => {
        record(url, init);
        const method = init?.body ? JSON.parse(String(init.body)).method : '';
        if (method === 'initialize') {
          return jsonResponse(jsonRpc({ serverInfo: { name: 'centralmcp' } }, 1), {
            headers: { 'mcp-session-id': 'sess-1' },
          });
        }
        if (method === 'notifications/initialized') return new Response(null, { status: 202 });
        if (method === 'tools/call') {
          return jsonResponse(jsonRpc({ content: [{ type: 'text', text: 'hello' }] }, 2));
        }
        throw new Error(`unexpected method ${method}`);
      }),
    );

    const client = new McpClient(MCP_URL, 'tok-abc');
    const out = await client.callTool('find_tool', { query: 'devices' });

    expect(out).toEqual({ text: 'hello', isError: false });
    expect(client.isReady()).toBe(true);
    expect(requests.map((r) => r.body.method)).toEqual([
      'initialize',
      'notifications/initialized',
      'tools/call',
    ]);

    const initReq = requests[0];
    expect(initReq.body.params.protocolVersion).toBe('2025-03-26');
    expect(initReq.body.params.clientInfo.name).toBe('hpe-network-tools');
    expect(initReq.headers.accept).toBe('application/json, text/event-stream');
    expect(initReq.headers.authorization).toBe('Bearer tok-abc');

    const notify = requests[1];
    expect(notify.body.id).toBeUndefined(); // a notification, not a request

    const call = requests[2];
    expect(call.headers['mcp-session-id']).toBe('sess-1');
    expect(call.body.params).toEqual({ name: 'find_tool', arguments: { query: 'devices' } });
  });

  it('probes a cached session with tools/list and clears stale readiness on failure', async () => {
    let failProbe = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown, init?: RequestInit) => {
        record(url, init);
        const method = init?.body ? JSON.parse(String(init.body)).method : '';
        if (method === 'initialize') {
          return jsonResponse(jsonRpc({}, 1), { headers: { 'mcp-session-id': 'sess-probe' } });
        }
        if (method === 'notifications/initialized') return new Response(null, { status: 202 });
        if (method === 'tools/list') {
          if (failProbe) return new Response('backend unavailable', { status: 503 });
          return jsonResponse(jsonRpc({ tools: [] }, 2));
        }
        throw new Error(`unexpected method ${method}`);
      }),
    );

    const client = new McpClient(MCP_URL, null);
    await client.init();
    await client.probe();
    expect(requests.map((r) => r.body.method)).toEqual([
      'initialize',
      'notifications/initialized',
      'tools/list',
    ]);

    failProbe = true;
    await expect(client.probe()).rejects.toThrow(/503/);
    expect(client.isReady()).toBe(false);
  });

  it('parses SSE answers, joining content text items and taking the last result', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: unknown, init?: RequestInit) => {
        const method = init?.body ? JSON.parse(String(init.body)).method : '';
        if (method === 'initialize') return jsonResponse(jsonRpc({}, 1));
        if (method === 'notifications/initialized') return new Response(null, { status: 202 });
        return sseResponse([
          { jsonrpc: '2.0', method: 'notifications/progress', params: { pct: 50 } },
          jsonRpc(
            { content: [{ type: 'text', text: 'line one' }, { type: 'image', data: '…' }, { type: 'text', text: 'line two' }] },
            2,
          ),
        ]);
      }),
    );

    const client = new McpClient(MCP_URL, null);
    const out = await client.callTool('invoke_read_tool', { name: 'x', arguments: {} });
    expect(out.text).toBe('line one\nline two');
    expect(out.isError).toBe(false);
  });

  it('maps isError tool results without throwing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: unknown, init?: RequestInit) => {
        const method = init?.body ? JSON.parse(String(init.body)).method : '';
        if (method === 'initialize') return jsonResponse(jsonRpc({}, 1));
        if (method === 'notifications/initialized') return new Response(null, { status: 202 });
        return jsonResponse(jsonRpc({ isError: true, content: [{ type: 'text', text: 'denied by policy' }] }, 2));
      }),
    );
    const out = await new McpClient(MCP_URL, null).callTool('invoke_read_tool', { name: 'x', arguments: {} });
    expect(out).toEqual({ text: 'denied by policy', isError: true });
  });

  it('re-initializes once on a session error and retries the call', async () => {
    let toolCalls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: unknown, init?: RequestInit) => {
        record(_url, init);
        const method = init?.body ? JSON.parse(String(init.body)).method : '';
        if (method === 'initialize') {
          const sessions = requests.filter((r) => r.body.method === 'initialize').length;
          return jsonResponse(jsonRpc({}, 1), { headers: { 'mcp-session-id': `sess-${sessions}` } });
        }
        if (method === 'notifications/initialized') return new Response(null, { status: 202 });
        toolCalls += 1;
        if (toolCalls === 1) return new Response('unknown session', { status: 400 });
        return jsonResponse(jsonRpc({ content: [{ type: 'text', text: 'after retry' }] }, 3));
      }),
    );

    const client = new McpClient(MCP_URL, null);
    const out = await client.callTool('find_tool', { query: 'x' });

    expect(out.text).toBe('after retry');
    expect(requests.map((r) => r.body.method)).toEqual([
      'initialize',
      'notifications/initialized',
      'tools/call',
      'initialize',
      'notifications/initialized',
      'tools/call',
    ]);
    expect(requests[5].headers['mcp-session-id']).toBe('sess-2');
  });

  it('does not retry a non-session HTTP failure, and retries only once', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: unknown, init?: RequestInit) => {
        record(_url, init);
        const method = init?.body ? JSON.parse(String(init.body)).method : '';
        if (method === 'initialize') return jsonResponse(jsonRpc({}, 1));
        if (method === 'notifications/initialized') return new Response(null, { status: 202 });
        return new Response('boom', { status: 500 });
      }),
    );
    await expect(new McpClient(MCP_URL, null).callTool('find_tool', { query: 'x' })).rejects.toThrow(
      /MCP HTTP 500/,
    );
    expect(requests.filter((r) => r.body.method === 'initialize')).toHaveLength(1);

    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: unknown, init?: RequestInit) => {
        record(_url, init);
        const method = init?.body ? JSON.parse(String(init.body)).method : '';
        if (method === 'initialize') return jsonResponse(jsonRpc({}, 1));
        if (method === 'notifications/initialized') return new Response(null, { status: 202 });
        return new Response('session gone again', { status: 404 });
      }),
    );
    requests = [];
    await expect(new McpClient(MCP_URL, null).callTool('find_tool', { query: 'x' })).rejects.toThrow(
      /session/i,
    );
    // init + notify + call, re-init + notify + call — then it gives up.
    expect(requests.filter((r) => r.body.method === 'tools/call')).toHaveLength(2);
    expect(requests.filter((r) => r.body.method === 'initialize')).toHaveLength(2);
  });

  it('raises JSON-RPC errors with their code and message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: unknown, init?: RequestInit) => {
        const method = init?.body ? JSON.parse(String(init.body)).method : '';
        if (method === 'initialize') return jsonResponse(jsonRpc({}, 1));
        if (method === 'notifications/initialized') return new Response(null, { status: 202 });
        return jsonResponse({ jsonrpc: '2.0', id: 2, error: { code: -32602, message: 'bad arguments' } });
      }),
    );
    await expect(new McpClient(MCP_URL, null).callTool('find_tool', {})).rejects.toThrow(
      'MCP error -32602: bad arguments',
    );
  });
});

// ---------------------------------------------------------------------------
// chatLoop — gating + the scripted tool round-trip
// ---------------------------------------------------------------------------

function configureChat(chatWriteMode: boolean): void {
  settings.update({
    mcp: { url: MCP_URL, bearerToken: null },
    llm: { baseUrl: LLM_URL, apiKey: 'sk-test', model: 'test-model' },
    chatWriteMode,
  });
}

function configureCompatibleProvider(provider: 'ollama' | 'openrouter'): void {
  settings.update({
    assistant: {
      activeProvider: provider,
      mcp: { enabled: true, endpoint: MCP_URL, authToken: null },
      chatWriteMode: 'read-only',
      providers: {
        codex: { enabled: false, model: 'gpt-5.6-terra', reasoningEffort: 'low' },
        claude: { enabled: false, model: 'sonnet', reasoningEffort: 'low' },
        kimi: { enabled: false, model: 'kimi-code/kimi-for-coding-highspeed', thinking: false },
        copilot: { enabled: false, model: 'auto', effort: 'adaptive' },
        ollama: { enabled: provider === 'ollama', baseUrl: LLM_URL, model: 'ollama-model' },
        openrouter: { enabled: provider === 'openrouter', baseUrl: OPENROUTER_URL, model: 'router-model', apiKey: 'router-secret' },
      },
    },
  });
}

/** A client that never actually gets used in LLM-only tests. */
function freshClient(): McpClientType {
  return new McpClient(MCP_URL, null);
}

class PortalCodexChild implements CodexAppServerChild {
  readonly sent: Array<{ id?: number; method: string; params?: Record<string, unknown> }> = [];
  private readonly events = new EventEmitter();
  private sequence = 0;

  write(line: string): void {
    const message = JSON.parse(line) as { id?: number; method: string; params?: Record<string, unknown> };
    this.sent.push(message);
    if (message.id !== undefined) queueMicrotask(() => this.reply(message));
  }

  onStdout(listener: (chunk: string) => void): void {
    this.events.on('stdout', listener);
  }

  onFailure(listener: (error: Error) => void): void {
    this.events.on('failure', listener);
  }

  kill(): void {
    this.events.emit('failure', new Error('child closed'));
  }

  private emit(message: unknown): void {
    this.events.emit('stdout', `${JSON.stringify(message)}\n`);
  }

  private reply(message: { id?: number; method: string; params?: Record<string, unknown> }): void {
    if (message.method === 'initialize') {
      this.emit({ id: message.id, result: { userAgent: 'portal-test' } });
      return;
    }
    if (message.method === 'thread/start') {
      this.sequence += 1;
      this.emit({ id: message.id, result: { thread: { id: `portal-thread-${this.sequence}`, ephemeral: true, turns: [], status: 'idle' } } });
      return;
    }
    if (message.method === 'mcpServerStatus/list') {
      this.emit({ id: message.id, result: { data: [{ name: 'centralmcp', authStatus: 'notRequired', resourceTemplates: [], resources: [], tools: {} }], nextCursor: null } });
      return;
    }
    if (message.method !== 'turn/start') throw new Error(`unexpected Codex app-server method ${message.method}`);
    const threadId = String(message.params?.threadId);
    const turnId = `portal-turn-${this.sequence}`;
    const prompt = String((message.params?.input as Array<{ text?: string }> | undefined)?.[0]?.text ?? '');
    this.emit({ id: message.id, result: { turn: { id: turnId, items: [], status: 'inProgress' } } });
    this.emit({ method: 'item/started', params: { threadId, turnId, startedAtMs: 0, item: { id: 'user-1', type: 'userMessage', content: [{ type: 'text', text: prompt }] } } });
    this.emit({ method: 'item/completed', params: { threadId, turnId, completedAtMs: 0, item: { id: 'user-1', type: 'userMessage', content: [{ type: 'text', text: prompt }] } } });
    this.emit({ method: 'item/started', params: { threadId, turnId, startedAtMs: 1, item: { id: 'tool-1', type: 'mcpToolCall', server: 'centralmcp', tool: 'find_tool', arguments: { query: 'inventory' }, status: 'inProgress' } } });
    this.emit({ method: 'item/completed', params: { threadId, turnId, completedAtMs: 1, item: { id: 'tool-1', type: 'mcpToolCall', server: 'centralmcp', tool: 'find_tool', arguments: { query: 'inventory' }, result: 'tool found', status: 'completed', error: null } } });
    this.emit({ method: 'item/started', params: { threadId, turnId, startedAtMs: 2, item: { id: 'message-1', type: 'agentMessage', text: '' } } });
    this.emit({ method: 'item/completed', params: { threadId, turnId, completedAtMs: 2, item: { id: 'message-1', type: 'agentMessage', text: `portal reply ${this.sequence}` } } });
    this.emit({ method: 'turn/completed', params: { threadId, turn: { id: turnId, items: [], status: 'completed', error: null } } });
  }
}

/** Stub fetch for LLM-only tests: answers completions, records payloads. */
function stubLlm(script: Array<(body: any) => unknown>): void {
  let call = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: unknown, init?: RequestInit) => {
      record(url, init);
      if (String(url) === `${LLM_URL}/chat/completions`) {
        const produce = script[Math.min(call, script.length - 1)];
        call += 1;
        return llmMessage(produce(JSON.parse(String(init?.body ?? '{}'))));
      }
      throw new Error(`unexpected fetch to ${String(url)}`);
    }),
  );
}

describe('chatLoop tool gating', () => {
  it('offers only find_tool + invoke_read_tool by default', async () => {
    configureChat(false);
    stubLlm([() => ({ role: 'assistant', content: 'done.' })]);

    const { reply } = await chatLoop([{ role: 'user', content: 'hi' }], { client: freshClient() });
    expect(reply).toBe('done.');

    const tools = requests[0].body.tools.map((t: any) => t.function.name);
    expect(tools).toEqual(['find_tool', 'invoke_read_tool']);
  });

  it('offers invoke_tool as soon as the saved lab write mode is on', async () => {
    configureChat(true);
    stubLlm([() => ({ role: 'assistant', content: 'done.' })]);

    await chatLoop([{ role: 'user', content: 'hi' }], { client: freshClient() });
    const tools = requests[0].body.tools.map((t: any) => t.function.name);
    expect(tools).toEqual(['find_tool', 'invoke_read_tool', 'invoke_tool']);
    const system = requests[0].body.messages[0];
    expect(system.role).toBe('system');
    expect(system.content).toContain('invoke_tool');
  });

  it('passes the saved centralmcp connection and lab write state to a native Codex adapter', async () => {
    settings.update({
      assistant: {
        activeProvider: 'codex',
        mcp: { enabled: true, endpoint: MCP_URL, authToken: 'centralmcp-secret' },
        chatWriteMode: 'enabled',
        providers: {
          codex: { enabled: true, model: 'gpt-5.6-terra', reasoningEffort: 'low' },
          claude: { enabled: false, model: 'sonnet', reasoningEffort: 'low' },
          kimi: { enabled: false, model: 'kimi-code/kimi-for-coding-highspeed', thinking: false },
          copilot: { enabled: false, model: 'auto', effort: 'adaptive' },
          ollama: { enabled: false, baseUrl: LLM_URL, model: 'ollama-model' },
          openrouter: { enabled: false, baseUrl: OPENROUTER_URL, model: 'router-model' },
        },
      },
    });
    const { assistantProviderRegistry } = await import('../src/services/mcpChat');
    const nativeChat = vi.fn(async () => ({ text: 'native reply', transcript: [] }));
    const get = vi.spyOn(assistantProviderRegistry, 'get').mockReturnValue({
      id: 'codex',
      canChat: () => true,
      discover: async () => ({ installed: true, authenticated: true, modelReady: true }),
      probeReadOnly: async () => ({ authenticated: true, modelReady: true }),
      chat: nativeChat,
    });
    try {
      await expect(chatLoop([{ role: 'user', content: 'update the lab SSID' }], { client: freshClient() }))
        .resolves.toMatchObject({ reply: 'native reply' });
      expect(nativeChat).toHaveBeenCalledWith(expect.objectContaining({
        mcp: { endpoint: MCP_URL, authToken: 'centralmcp-secret', writeEnabled: true },
      }));
    } finally {
      get.mockRestore();
      configureCompatibleProvider('ollama');
    }
  });

  it('keeps one real Codex app-server child warm across two sequential portal chats', async () => {
    const launches: CodexAppServerLaunch[] = [];
    const children: PortalCodexChild[] = [];
    const fs: CodexAppServerFileSystem = {
      mkdtemp: async () => `/private/portal-codex-${children.length + 1}`,
      mkdir: async () => undefined,
      chmod: async () => undefined,
      copyFile: async () => undefined,
      rm: async () => undefined,
    };
    const appServer = new CodexAppServer({
      fs,
      authPath: '/private/source/auth.json',
      temporaryDirectory: '/private',
      spawnChild: (launch) => {
        launches.push(launch);
        const child = new PortalCodexChild();
        children.push(child);
        return child;
      },
    });
    const adapter = new CodexAdapter({ codexAppServer: appServer });
    settings.update({
      assistant: {
        activeProvider: 'codex',
        mcp: { enabled: true, endpoint: MCP_URL, authToken: 'portal-token' },
        chatWriteMode: 'enabled',
        providers: {
          codex: { enabled: true, model: 'gpt-5.3-spark', reasoningEffort: 'auto' },
          claude: { enabled: false, model: 'sonnet', reasoningEffort: 'low' },
          kimi: { enabled: false, model: 'kimi-code/kimi-for-coding-highspeed', thinking: false },
          copilot: { enabled: false, model: 'auto', effort: 'adaptive' },
          ollama: { enabled: false, baseUrl: LLM_URL, model: 'ollama-model' },
          openrouter: { enabled: false, baseUrl: OPENROUTER_URL, model: 'router-model' },
        },
      },
    });
    const { assistantProviderRegistry } = await import('../src/services/mcpChat');
    const get = vi.spyOn(assistantProviderRegistry, 'get').mockReturnValue(adapter);
    try {
      await expect(chatLoop([{ role: 'user', content: 'Show inventory.' }], { client: freshClient() }))
        .resolves.toMatchObject({ reply: 'portal reply 1' });
      await expect(chatLoop([{ role: 'user', content: 'Show sites.' }], { client: freshClient() }))
        .resolves.toMatchObject({ reply: 'portal reply 2' });

      expect(launches).toHaveLength(1);
      expect(children).toHaveLength(1);
      const threadStarts = children[0]!.sent.filter((message) => message.method === 'thread/start');
      const turnStarts = children[0]!.sent.filter((message) => message.method === 'turn/start');
      expect(threadStarts).toHaveLength(2);
      expect(turnStarts.map((message) => message.params?.threadId)).toEqual(['portal-thread-1', 'portal-thread-2']);
    } finally {
      get.mockRestore();
      await adapter.dispose();
      configureCompatibleProvider('ollama');
    }
  });

  it('refuses a hallucinated invoke_tool without touching MCP', async () => {
    configureChat(false);
    stubLlm([
      () => ({
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'c1',
            type: 'function',
            function: { name: 'invoke_tool', arguments: '{"name":"reboot_device","arguments":{}}' },
          },
        ],
      }),
      () => ({ role: 'assistant', content: 'That requires write mode — staying read-only.' }),
    ]);

    const { reply, transcript } = await chatLoop([{ role: 'user', content: 'reboot sw-01' }], {
      client: freshClient(),
    });

    expect(reply).toBe('That requires write mode — staying read-only.');
    expect(transcript).toHaveLength(1);
    expect(transcript[0].tool).toBe('invoke_tool');
    expect(transcript[0].ok).toBe(false);
    expect(transcript[0].resultPreview).toMatch(/refused/);
    // MCP was never called — the refusal happens before any centralmcp traffic.
    expect(requests.every((r) => r.url === `${LLM_URL}/chat/completions`)).toBe(true);
    // The refusal went back to the model as the tool message.
    const secondCall = requests[1].body;
    const toolMsg = secondCall.messages.find((m: any) => m.role === 'tool');
    expect(toolMsg.content).toMatch(/refused/);
  });
});

describe('chatLoop compatible provider routing', () => {
  it.each([
    ['ollama', LLM_URL, 'ollama-model'],
    ['openrouter', OPENROUTER_URL, 'router-model'],
  ] as const)('routes %s through the shared compatible adapter', async (provider, baseUrl, model) => {
    configureCompatibleProvider(provider);
    vi.stubGlobal('fetch', vi.fn(async (url: unknown, init?: RequestInit) => {
      record(url, init);
      return llmMessage({ role: 'assistant', content: 'done.' });
    }));

    await expect(chatLoop([{ role: 'user', content: 'hi' }], { client: freshClient() })).resolves.toMatchObject({ reply: 'done.' });
    expect(requests[0].url).toBe(`${baseUrl}/chat/completions`);
    expect(requests[0].body.model).toBe(model);
  });

  it('forwards find_tool platform unchanged to centralmcp', async () => {
    configureCompatibleProvider('ollama');
    let llmCalls = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: unknown, init?: RequestInit) => {
      record(url, init);
      if (String(url) === `${LLM_URL}/chat/completions`) {
        llmCalls += 1;
        return llmMessage(llmCalls === 1
          ? { role: 'assistant', content: null, tool_calls: [{ id: 'find-1', type: 'function', function: { name: 'find_tool', arguments: '{"query":"APs","platform":"mist"}' } }] }
          : { role: 'assistant', content: 'done.' });
      }
      const method = JSON.parse(String(init?.body)).method;
      if (method === 'initialize') return jsonResponse(jsonRpc({}, 1), { headers: { 'mcp-session-id': 'sess-platform' } });
      if (method === 'notifications/initialized') return new Response(null, { status: 202 });
      return jsonResponse(jsonRpc({ content: [{ type: 'text', text: 'found' }] }, 2));
    }));

    await chatLoop([{ role: 'user', content: 'find APs' }], { client: freshClient() });
    const toolCall = requests.find((r) => r.body?.method === 'tools/call');
    expect(toolCall?.body.params.arguments).toEqual({ query: 'APs', platform: 'mist' });
  });

  it('uses short interactive and longer bounded generation/startup timeouts', () => {
    expect(resolveProviderTimeoutMs('interactive')).toBeLessThan(resolveProviderTimeoutMs('generation'));
    expect(resolveProviderTimeoutMs('generation')).toBe(resolveProviderTimeoutMs('startup'));
    expect(resolveProviderTimeoutMs('interactive')).not.toBe(30_000);
  });

  it('allows a tool-capable chat completion to exceed the readiness deadline', async () => {
    configureCompatibleProvider('ollama');
    vi.useFakeTimers();
    try {
      vi.stubGlobal('fetch', vi.fn((_url: unknown, init?: RequestInit) => new Promise<Response>((resolve, reject) => {
        const timer = setTimeout(() => resolve(llmMessage({ role: 'assistant', content: 'completed after tool-capable generation time.' })), 15_001);
        init?.signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new Error('aborted'));
        }, { once: true });
      })));

      const pending = chatLoop([{ role: 'user', content: 'answer with the available network tools' }], { client: freshClient() });
      const outcome = pending.then(
        (result) => ({ kind: 'completed' as const, reply: result.reply }),
        () => ({ kind: 'timed-out' as const }),
      );
      await vi.advanceTimersByTimeAsync(15_001);
      await expect(outcome).resolves.toEqual({ kind: 'completed', reply: 'completed after tool-capable generation time.' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns a clear provider timeout using the explicitly supplied timeout', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn((_url: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    })));
    const pending = new OpenAICompatibleAdapter('ollama').run({
      config: { baseUrl: LLM_URL, model: 'test-model', timeoutMs: 7 },
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      executeTool: async () => { throw new Error('not reached'); },
    });
    const rejected = expect(pending).rejects.toThrow('assistant provider timed out after 7ms');
    await vi.advanceTimersByTimeAsync(7);
    await rejected;
    vi.useRealTimers();
  });

  it('keeps the provider deadline active while parsing a stalled response body', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => ({
      ok: true,
      status: 200,
      json: () => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('body aborted')), { once: true });
      }),
    } as Response)));
    const pending = new OpenAICompatibleAdapter('ollama').run({
      config: { baseUrl: LLM_URL, model: 'test-model', timeoutMs: 7 },
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      executeTool: async () => { throw new Error('not reached'); },
    });
    const rejected = expect(pending).rejects.toThrow('assistant provider timed out after 7ms');
    await vi.advanceTimersByTimeAsync(7);
    await rejected;
    vi.useRealTimers();
  });

  it('does not include a provider error body in the thrown failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('authorization failed for Bearer sk-provider-secret', { status: 401 })));
    const pending = new OpenAICompatibleAdapter('openrouter').run({
      config: { baseUrl: OPENROUTER_URL, model: 'router-model', apiKey: 'sk-provider-secret', timeoutMs: 10 },
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      executeTool: async () => { throw new Error('not reached'); },
    });
    let error: Error;
    try {
      await pending;
      throw new Error('provider request unexpectedly succeeded');
    } catch (reason) {
      error = reason as Error;
    }
    expect(error.message).toBe('assistant provider HTTP 401');
    expect(error.message).not.toContain('sk-provider-secret');
  });

  it('accepts declared registry chat configuration without an adapter-specific cast', async () => {
    configureCompatibleProvider('ollama');
    vi.stubGlobal('fetch', vi.fn(async () => llmMessage({ role: 'assistant', content: 'done.' })));

    const result = await new OpenAICompatibleAdapter('ollama').chat({
      config: settings.get().assistant.providers.ollama,
      timeoutMs: 123,
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(result).toEqual({ text: 'done.', transcript: [] });
  });
});

describe('chatLoop tool round-trip', () => {
  function stubLlmAndMcp(mcpText: string): void {
    let llmCalls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown, init?: RequestInit) => {
        record(url, init);
        if (String(url) === `${LLM_URL}/chat/completions`) {
          llmCalls += 1;
          if (llmCalls === 1) {
            return llmMessage({
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call-1',
                  type: 'function',
                  function: { name: 'find_tool', arguments: '{"query":"list devices"}' },
                },
              ],
            });
          }
          return llmMessage({ role: 'assistant', content: 'There are 3 switches.' });
        }
        const method = init?.body ? JSON.parse(String(init.body)).method : '';
        if (method === 'initialize') {
          return jsonResponse(jsonRpc({}, 1), { headers: { 'mcp-session-id': 'sess-loop' } });
        }
        if (method === 'notifications/initialized') return new Response(null, { status: 202 });
        if (method === 'tools/call') {
          return sseResponse([jsonRpc({ content: [{ type: 'text', text: mcpText }] }, 2)]);
        }
        throw new Error(`unexpected MCP method ${method}`);
      }),
    );
  }

  it('runs tool_call → MCP → final answer, with a transcript entry', async () => {
    configureChat(false);
    stubLlmAndMcp('device_list tool found');

    const { reply, transcript } = await chatLoop([{ role: 'user', content: 'how many switches?' }], {
      client: freshClient(),
    });

    expect(reply).toBe('There are 3 switches.');
    expect(transcript).toEqual([
      {
        tool: 'find_tool',
        args: '{"query":"list devices"}',
        resultPreview: 'device_list tool found',
        ok: true,
      },
    ]);
    // The LLM got the tool result back with the original tool_call_id.
    const secondLlm = requests.filter((r) => r.url === `${LLM_URL}/chat/completions`)[1];
    const toolMsg = secondLlm.body.messages.find((m: any) => m.role === 'tool');
    expect(toolMsg.tool_call_id).toBe('call-1');
    expect(toolMsg.content).toBe('device_list tool found');
  });

  it('replays assistant tool calls with string content for Ollama compatibility', async () => {
    configureChat(false);
    stubLlmAndMcp('device_list tool found');

    const { transcript } = await chatLoop([{ role: 'user', content: 'how many switches?' }], {
      client: freshClient(),
    });

    const secondLlm = requests.filter((r) => r.url === `${LLM_URL}/chat/completions`)[1];
    const assistantMsg = secondLlm.body.messages.find((m: any) => m.role === 'assistant');
    expect(assistantMsg).toEqual({
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          id: 'call-1',
          type: 'function',
          function: { name: 'find_tool', arguments: '{"query":"list devices"}' },
        },
      ],
    });
    expect(transcript).toEqual([
      {
        tool: 'find_tool',
        args: '{"query":"list devices"}',
        resultPreview: 'device_list tool found',
        ok: true,
      },
    ]);
  });

  it('caps tool output fed back to the LLM and previews in the transcript', async () => {
    configureChat(false);
    stubLlmAndMcp('x'.repeat(5000));

    const { transcript } = await chatLoop([{ role: 'user', content: 'dump everything' }], {
      client: freshClient(),
    });

    const secondLlm = requests.filter((r) => r.url === `${LLM_URL}/chat/completions`)[1];
    const toolMsg = secondLlm.body.messages.find((m: any) => m.role === 'tool');
    expect(toolMsg.content.length).toBeLessThanOrEqual(4001); // 4000 + '…'
    expect(transcript[0].resultPreview.length).toBeLessThanOrEqual(301); // 300 + '…'
  });

  it('throws a clear error when the LLM is not configured', async () => {
    settings.update({ llm: null });
    await expect(
      chatLoop([{ role: 'user', content: 'hi' }], { client: freshClient() }),
    ).rejects.toThrow(/LLM is not configured/);
    configureChat(false);
  });

  it('aborts an in-flight LLM request when the caller cancels', async () => {
    configureChat(false);
    let requestAborted = false;
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: unknown, init?: RequestInit) => {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => {
              requestAborted = true;
              reject(new Error('aborted'));
            },
            { once: true },
          );
        });
      }),
    );

    const controller = new AbortController();
    const pending = chatLoop([{ role: 'user', content: 'hi' }], {
      client: freshClient(),
      signal: controller.signal,
    });
    controller.abort();

    await expect(pending).rejects.toThrow(/request cancelled/);
    expect(requestAborted).toBe(true);
  });
});
