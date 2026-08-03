import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CodexAppServer,
  CodexAppServerFailure,
  type CodexAppServerChild,
  type CodexAppServerFileSystem,
  type CodexAppServerLaunch,
} from '../src/services/assistant/codexAppServer';

interface SentMessage {
  id?: number;
  method: string;
  params?: Record<string, unknown>;
}

class FakeChild implements CodexAppServerChild {
  readonly sent: SentMessage[] = [];
  readonly rawSent: string[] = [];
  killed = false;
  inventory = ['centralmcp'];
  emitRemoteStatus = false;
  turnMode: 'complete' | 'disconnect' | 'foreign-tool' | 'unknown-event' | 'hang' | 'streaming' | 'mismatched-stream' | 'incomplete-item' | 'terminal-start-completed' | 'terminal-start-failed' | 'missing-completed-at' | 'unsafe-completed-at' | 'token-arguments' | 'token-result' | 'token-error' | 'token-message' = 'complete';
  private readonly events = new EventEmitter();
  private sequence = 0;

  write(line: string): void {
    if (this.killed) throw new Error('write after child shutdown');
    this.rawSent.push(line);
    const message = JSON.parse(line) as SentMessage;
    this.sent.push(message);
    if (message.id === undefined) return;
    queueMicrotask(() => this.reply(message));
  }

  onStdout(listener: (chunk: string) => void): void {
    this.events.on('stdout', listener);
  }

  onFailure(listener: (error: Error) => void): void {
    this.events.on('failure', listener);
  }

  kill(): void {
    this.killed = true;
  }

  sentMethods(): string[] {
    return this.sent.map((message) => message.method);
  }

  sentText(): string {
    return this.rawSent.join('');
  }

  private emit(message: unknown): void {
    this.events.emit('stdout', `${JSON.stringify(message)}\n`);
  }

  private reply(message: SentMessage): void {
    if (message.method === 'initialize') {
      this.emit({ id: message.id, result: { userAgent: 'codex-app-server-test' } });
      if (this.emitRemoteStatus) {
        this.emit({
          method: 'remoteControl/status/changed',
          params: { installationId: 'local-install', serverName: 'local-server', status: 'disabled', environmentId: null },
        });
      }
      return;
    }
    if (message.method === 'thread/start') {
      this.sequence += 1;
      this.emit({
        id: message.id,
        result: {
          thread: { id: `thread-${this.sequence}`, ephemeral: true, turns: [], status: 'idle' },
          model: 'gpt-5.6-terra',
        },
      });
      return;
    }
    if (message.method === 'mcpServerStatus/list') {
      this.emit({
        id: message.id,
        result: {
          data: this.inventory.map((name) => ({ name, authStatus: 'notRequired', resourceTemplates: [], resources: [], tools: {} })),
          nextCursor: null,
        },
      });
      return;
    }
    if (message.method !== 'turn/start') throw new Error(`unexpected method ${message.method}`);

    const threadId = String(message.params?.threadId);
    const turnId = `turn-${this.sequence}`;
    this.emit({ id: message.id, result: { turn: { id: turnId, items: [], status: 'inProgress' } } });
    if (this.turnMode === 'hang') return;
    if (this.turnMode === 'disconnect') {
      this.events.emit('failure', new Error('child disconnected'));
      return;
    }
    if (this.turnMode === 'unknown-event') {
      this.emit({ method: 'item/started', params: { threadId, turnId, item: { id: 'unsafe', type: 'commandExecution' } } });
      return;
    }
    const server = this.turnMode === 'foreign-tool' ? 'computer-use' : 'centralmcp';
    if (this.turnMode === 'streaming' || this.turnMode === 'mismatched-stream') {
      this.emit({
        method: 'item/started',
        params: {
          threadId,
          turnId,
          startedAtMs: -1,
          item: { id: 'user-1', type: 'userMessage', content: [{ type: 'text', text: 'Check the lab inventory.' }] },
        },
      });
      this.emit({
        method: 'item/completed',
        params: {
          threadId,
          turnId,
          completedAtMs: -1,
          item: { id: 'user-1', type: 'userMessage', content: [{ type: 'text', text: 'Check the lab inventory.' }] },
        },
      });
      this.emit({
        method: 'item/started',
        params: {
          threadId,
          turnId,
          startedAtMs: 0,
          item: { id: 'reasoning-1', type: 'reasoning', content: [], summary: [] },
        },
      });
      this.emit({
        method: 'item/reasoning/summaryPartAdded',
        params: { threadId, turnId, itemId: 'reasoning-1', summaryIndex: 0 },
      });
      this.emit({
        method: 'item/reasoning/summaryTextDelta',
        params: { threadId, turnId, itemId: 'reasoning-1', summaryIndex: 0, delta: 'private summary' },
      });
      this.emit({
        method: 'item/reasoning/textDelta',
        params: { threadId, turnId, itemId: 'reasoning-1', contentIndex: 0, delta: 'private reasoning' },
      });
      this.emit({
        method: 'item/completed',
        params: {
          threadId,
          turnId,
          completedAtMs: 0,
          item: { id: 'reasoning-1', type: 'reasoning', content: ['private reasoning'], summary: ['private summary'] },
        },
      });
      this.emit({
        method: 'item/started',
        params: {
          threadId,
          turnId,
          startedAtMs: 1,
          item: {
            id: 'tool-1',
            type: 'mcpToolCall',
            server: 'centralmcp',
            tool: 'find_tool',
            arguments: { query: 'switch inventory' },
            status: 'inProgress',
          },
        },
      });
      this.emit({
        method: 'item/mcpToolCall/progress',
        params: {
          threadId,
          turnId: this.turnMode === 'mismatched-stream' ? 'wrong-turn' : turnId,
          itemId: 'tool-1',
          message: 'searching private inventory',
        },
      });
    }
    if (this.turnMode === 'terminal-start-completed' || this.turnMode === 'terminal-start-failed') {
      this.emit({
        method: 'item/started',
        params: {
          threadId,
          turnId,
          startedAtMs: 1,
          item: {
            id: 'tool-1',
            type: 'mcpToolCall',
            server: 'centralmcp',
            tool: 'find_tool',
            arguments: { query: 'switch inventory' },
            status: this.turnMode === 'terminal-start-completed' ? 'completed' : 'failed',
          },
        },
      });
    }
    this.emit({
      method: 'item/completed',
      params: {
        threadId,
        turnId,
        ...(this.turnMode === 'missing-completed-at' ? {} : {
          completedAtMs: this.turnMode === 'unsafe-completed-at' ? Number.MAX_SAFE_INTEGER + 1 : 1,
        }),
        item: {
          id: 'tool-1',
          type: 'mcpToolCall',
          server,
          tool: 'find_tool',
          arguments: { query: this.turnMode === 'token-arguments' ? 'secret-token' : 'switch inventory' },
          result: this.turnMode === 'token-error'
            ? null
            : { content: [{ type: 'text', text: this.turnMode === 'token-result' ? 'secret-token' : 'catalogue found' }] },
          status: this.turnMode === 'token-error' ? 'failed' : 'completed',
          error: this.turnMode === 'token-error' ? { message: 'secret-token' } : null,
        },
      },
    });
    if (this.turnMode === 'incomplete-item') {
      this.emit({
        method: 'item/started',
        params: {
          threadId,
          turnId,
          startedAtMs: 2,
          item: { id: 'reasoning-incomplete', type: 'reasoning', content: [], summary: [] },
        },
      });
    }
    if (this.turnMode === 'streaming') {
      this.emit({
        method: 'item/started',
        params: {
          threadId,
          turnId,
          startedAtMs: 2,
          item: { id: 'message-1', type: 'agentMessage', text: '' },
        },
      });
      this.emit({
        method: 'item/agentMessage/delta',
        params: {
          threadId,
          turnId,
          itemId: 'message-1',
          delta: 'This streamed text must not become the final output.',
        },
      });
    }
    this.emit({
      method: 'item/completed',
      params: {
        threadId,
        turnId,
        completedAtMs: 2,
        item: {
          id: 'message-1',
          type: 'agentMessage',
          text: this.turnMode === 'token-message' ? 'Leaked secret-token' : 'CentralMCP is ready.',
        },
      },
    });
    this.emit({
      method: 'turn/completed',
      params: { threadId, turn: { id: turnId, items: [], status: 'completed', error: null } },
    });
  }
}

function testHarness(options: { inventory?: string[]; turnMode?: FakeChild['turnMode']; remoteStatus?: boolean } = {}) {
  const launches: CodexAppServerLaunch[] = [];
  const children: FakeChild[] = [];
  const chmodCalls: Array<{ path: string; mode: number }> = [];
  const removed: string[] = [];
  const fs: CodexAppServerFileSystem = {
    mkdtemp: vi.fn(async () => `/private/hpe-codex-${children.length + 1}`),
    mkdir: vi.fn(async () => undefined),
    chmod: vi.fn(async (path, mode) => { chmodCalls.push({ path, mode }); }),
    copyFile: vi.fn(async () => undefined),
    rm: vi.fn(async (path) => { removed.push(path); }),
  };
  const transport = new CodexAppServer({
    fs,
    authPath: '/Users/test/.codex/auth.json',
    temporaryDirectory: '/private',
    spawnChild: (launch) => {
      launches.push(launch);
      const child = new FakeChild();
      if (options.inventory) child.inventory = options.inventory;
      if (options.turnMode) child.turnMode = options.turnMode;
      if (options.remoteStatus) child.emitRemoteStatus = true;
      children.push(child);
      return child;
    },
  });
  return { transport, launches, children, fs, chmodCalls, removed };
}

const request = {
  endpoint: 'http://127.0.0.1:3000/mcp',
  authToken: 'secret-token',
  writeEnabled: false,
  model: 'gpt-5.6-terra',
  reasoningEffort: 'low' as const,
  prompt: 'Check the lab inventory.',
  timeoutMs: 5_000,
};

describe('CodexAppServer', () => {
  const transports: CodexAppServer[] = [];

  afterEach(async () => {
    await Promise.all(transports.splice(0).map((transport) => transport.dispose()));
  });

  it('uses the installed JSONL lifecycle with a private auth copy and keeps the bearer token out of protocol text', async () => {
    const fake = testHarness({ remoteStatus: true });
    transports.push(fake.transport);

    await expect(fake.transport.chat(request)).resolves.toEqual({
      text: 'CentralMCP is ready.',
      transcript: [{
        tool: 'find_tool',
        args: '{"query":"switch inventory"}',
        resultPreview: 'catalogue found',
        ok: true,
      }],
    });

    expect(fake.children[0]?.sentMethods()).toEqual([
      'initialize', 'initialized', 'thread/start', 'mcpServerStatus/list', 'turn/start',
    ]);
    const initialize = fake.children[0]?.sent.find((message) => message.method === 'initialize');
    expect(initialize?.params?.capabilities).toEqual({
      experimentalApi: true,
      optOutNotificationMethods: [
        'remoteControl/status/changed',
        'mcpServer/startupStatus/updated',
        'warning',
        'thread/status/changed',
        'thread/tokenUsage/updated',
        'thread/started',
        'turn/started',
        'item/started',
        'item/agentMessage/delta',
        'item/mcpToolCall/progress',
        'item/reasoning/summaryTextDelta',
        'item/reasoning/summaryPartAdded',
        'item/reasoning/textDelta',
      ],
    });
    expect(fake.launches[0]).toMatchObject({
      command: 'codex',
      args: ['app-server', '--stdio', '--strict-config', '--disable', 'apps', '--disable', 'plugins', '--disable', 'computer_use', '--disable', 'browser_use'],
      cwd: '/private/hpe-codex-1/workspace',
      shell: false,
      env: {
        HOME: '/private/hpe-codex-1/home',
        CODEX_HOME: '/private/hpe-codex-1/home',
        HPE_ASSISTANT_MCP_TOKEN: 'secret-token',
      },
    });
    expect(fake.children[0]?.sentText()).not.toContain('secret-token');
    expect(fake.chmodCalls).toEqual(expect.arrayContaining([
      { path: '/private/hpe-codex-1', mode: 0o700 },
      { path: '/private/hpe-codex-1/home', mode: 0o700 },
      { path: '/private/hpe-codex-1/workspace', mode: 0o700 },
      { path: '/private/hpe-codex-1/home/auth.json', mode: 0o600 },
    ]));
    expect(fake.fs.copyFile).toHaveBeenCalledWith('/Users/test/.codex/auth.json', '/private/hpe-codex-1/home/auth.json');

    const threadStart = fake.children[0]?.sent.find((message) => message.method === 'thread/start');
    expect(threadStart?.params).toMatchObject({
      ephemeral: true,
      cwd: '/private/hpe-codex-1/workspace',
      sandbox: 'read-only',
      approvalPolicy: 'never',
      model: 'gpt-5.6-terra',
      config: {
        'mcp_servers.centralmcp.url': 'http://127.0.0.1:3000/mcp',
        'mcp_servers.centralmcp.enabled': true,
        'mcp_servers.centralmcp.required': true,
        'mcp_servers.centralmcp.enabled_tools': ['find_tool', 'invoke_read_tool'],
        'mcp_servers.centralmcp.default_tools_approval_mode': 'auto',
        'mcp_servers.centralmcp.bearer_token_env_var': 'HPE_ASSISTANT_MCP_TOKEN',
        model_reasoning_effort: 'low',
        hide_agent_reasoning: true,
      },
    });

    await fake.transport.dispose();
    expect(fake.children[0]?.killed).toBe(true);
    expect(fake.removed).toContain('/private/hpe-codex-1');
  });

  it('requires the exact centralmcp inventory before a turn can start', async () => {
    const fake = testHarness({ inventory: ['centralmcp', 'computer-use'] });
    transports.push(fake.transport);
    const pending = fake.transport.chat(request);

    await expect(pending).rejects.toMatchObject({ stage: 'before-turn' });
    expect(fake.children[0]?.sentMethods()).not.toContain('turn/start');
    expect(fake.children[0]?.killed).toBe(true);
  });

  it('classifies disconnects and forbidden events after turn submission without exposing child diagnostics', async () => {
    for (const turnMode of ['disconnect', 'foreign-tool', 'unknown-event'] as const) {
      const fake = testHarness({ turnMode });
      transports.push(fake.transport);
      const pending = fake.transport.chat(request);

      await expect(pending).rejects.toEqual(expect.objectContaining({
        stage: 'after-turn',
        message: expect.stringMatching(/did not complete/i),
      }));
      expect(fake.children[0]?.killed).toBe(true);
    }
  });

  it('accepts and discards only schema-backed start, reasoning, MCP progress, and agent delta events for the active turn', async () => {
    const fake = testHarness({ turnMode: 'streaming' });
    transports.push(fake.transport);

    await expect(fake.transport.chat(request)).resolves.toEqual({
      text: 'CentralMCP is ready.',
      transcript: [{
        tool: 'find_tool',
        args: '{"query":"switch inventory"}',
        resultPreview: 'catalogue found',
        ok: true,
      }],
    });
    expect(fake.children[0]?.killed).toBe(false);
  });

  it('rejects a schema-backed streaming event for a different turn', async () => {
    const fake = testHarness({ turnMode: 'mismatched-stream' });
    transports.push(fake.transport);

    await expect(fake.transport.chat(request)).rejects.toMatchObject({ stage: 'after-turn' });
    expect(fake.children[0]?.killed).toBe(true);
  });

  it('rejects turn completion while a tracked allowed item is still incomplete', async () => {
    const fake = testHarness({ turnMode: 'incomplete-item' });
    transports.push(fake.transport);

    await expect(fake.transport.chat(request)).rejects.toMatchObject({ stage: 'after-turn' });
    expect(fake.children[0]?.killed).toBe(true);
  });

  it.each(['terminal-start-completed', 'terminal-start-failed'] as const)(
    'rejects a started CentralMCP item carrying terminal status via %s',
    async (turnMode) => {
      const fake = testHarness({ turnMode });
      transports.push(fake.transport);

      await expect(fake.transport.chat(request)).rejects.toMatchObject({ stage: 'after-turn' });
      expect(fake.children[0]?.killed).toBe(true);
    },
  );

  it.each(['missing-completed-at', 'unsafe-completed-at'] as const)(
    'rejects a schema-invalid completion timestamp via %s',
    async (turnMode) => {
      const fake = testHarness({ turnMode });
      transports.push(fake.transport);

      await expect(fake.transport.chat(request)).rejects.toMatchObject({ stage: 'after-turn' });
      expect(fake.children[0]?.killed).toBe(true);
    },
  );

  it.each(['token-arguments', 'token-result', 'token-error', 'token-message'] as const)('fails closed when CentralMCP or final output echoes the bearer token via %s', async (turnMode) => {
    const fake = testHarness({ turnMode });
    transports.push(fake.transport);

    const failure = await fake.transport.chat(request).catch((error: unknown) => error);
    expect(failure).toMatchObject({ stage: 'after-turn', message: expect.stringMatching(/did not complete/i) });
    expect(JSON.stringify(failure)).not.toContain('secret-token');
    expect(fake.children[0]?.killed).toBe(true);
  });

  it('reuses an unchanged scoped child, replaces it when endpoint, token digest, or allowed tools change, and omits auto effort', async () => {
    const fake = testHarness();
    transports.push(fake.transport);

    await fake.transport.chat({ ...request, reasoningEffort: 'auto' });
    await fake.transport.chat({ ...request, reasoningEffort: 'auto' });
    expect(fake.children).toHaveLength(1);
    expect(fake.launches).toHaveLength(1);
    const threadStarts = fake.children[0]?.sent.filter((message) => message.method === 'thread/start') ?? [];
    expect(threadStarts).toHaveLength(2);
    expect(new Set(threadStarts.map((message) => message.id)).size).toBe(2);
    const turnStarts = fake.children[0]?.sent.filter((message) => message.method === 'turn/start') ?? [];
    expect(turnStarts.map((message) => message.params?.threadId)).toEqual(['thread-1', 'thread-2']);
    const firstThreadConfig = fake.children[0]?.sent.find((message) => message.method === 'thread/start')?.params?.config;
    expect(firstThreadConfig).not.toHaveProperty('model_reasoning_effort');

    await fake.transport.chat({ ...request, endpoint: 'http://127.0.0.1:4000/mcp', reasoningEffort: 'auto' });
    expect(fake.children).toHaveLength(2);
    expect(fake.children[0]?.killed).toBe(true);

    await fake.transport.chat({ ...request, endpoint: 'http://127.0.0.1:4000/mcp', authToken: 'rotated-token', reasoningEffort: 'auto' });
    expect(fake.children).toHaveLength(3);
    expect(fake.children[1]?.killed).toBe(true);

    await fake.transport.chat({ ...request, endpoint: 'http://127.0.0.1:4000/mcp', authToken: 'rotated-token', writeEnabled: true, reasoningEffort: 'auto' });
    expect(fake.children).toHaveLength(4);
    expect(fake.children[2]?.killed).toBe(true);
    expect(fake.children.flatMap((child) => child.rawSent).join('')).not.toContain('rotated-token');
  });

  it('fails before turn start when already aborted and disposes a running child when aborted during a turn', async () => {
    const fake = testHarness({ turnMode: 'hang' });
    transports.push(fake.transport);
    const alreadyAborted = new AbortController();
    alreadyAborted.abort();

    await expect(fake.transport.chat({ ...request, signal: alreadyAborted.signal }))
      .rejects.toBeInstanceOf(CodexAppServerFailure);
    expect(fake.children).toHaveLength(0);

    const activeAbort = new AbortController();
    const pending = fake.transport.chat({ ...request, signal: activeAbort.signal });
    await vi.waitFor(() => expect(fake.children).toHaveLength(1));
    await vi.waitFor(() => expect(fake.children[0]?.sentMethods()).toContain('turn/start'));
    activeAbort.abort();
    await expect(pending).rejects.toMatchObject({ stage: 'after-turn' });
    expect(fake.children[0]?.killed).toBe(true);
  });
});
