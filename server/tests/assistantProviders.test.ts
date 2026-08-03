import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AssistantSettings } from '../src/config/settings';
import { ClaudeAdapter, CodexAdapter, CopilotAdapter, KimiAdapter, type NativeCliAdapterDependencies } from '../src/services/assistant/cliAdapters';
import { createMcpLaunchConfig } from '../src/services/assistant/mcpLaunchConfig';
import { AssistantProviderRegistry, getAssistantDefaults } from '../src/services/assistant/registry';
import type { AssistantProviderAdapter, CommandExecution, ProbeInvocation, ReadOnlyProbeContext } from '../src/services/assistant/types';

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

describe('isolated native assistant CLI adapters', () => {
  const centralMcp = { endpoint: 'http://127.0.0.1:3000/mcp', authToken: 'centralmcp-test-token' };

  function probeContext(): { context: ReadOnlyProbeContext; invocations: ProbeInvocation[] } {
    const invocations: ProbeInvocation[] = [];
    return {
      context: {
        mcp: centralMcp,
        recordInvocation(invocation) { invocations.push(invocation); },
      },
      invocations,
    };
  }

  function nativeDependencies(stdout: string): { dependencies: NativeCliAdapterDependencies; commands: CommandExecution[]; dispose: ReturnType<typeof vi.fn>; launchInputs: Array<Record<string, unknown>> } {
    const commands: CommandExecution[] = [];
    const dispose = vi.fn(async () => {});
    const launchInputs: Array<Record<string, unknown>> = [];
    return {
      dependencies: {
        commandRunner: {
          run: async (command) => {
            commands.push(command);
            return { exitCode: 0, stdout, stderr: '' };
          },
        },
        createMcpLaunchConfig: async (input) => {
          launchInputs.push(input);
          return { path: '/private/tmp/centralmcp.json', directory: '/private/tmp', dispose };
        },
      },
      commands,
      dispose,
      launchInputs,
    };
  }

  const successfulClaudeProbe = [
    '{"type":"system","subtype":"init"}',
    '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_centralmcp","name":"mcp__centralmcp__find_tool","input":{"query":"catalogue"}}]}}',
    '{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_centralmcp","content":"catalogue checked","is_error":false}]}}',
    '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"catalogue checked"}]}}',
    '{"type":"result","subtype":"success","is_error":false,"result":"catalogue checked"}',
  ].join('\n');

  it('Claude sends only an isolated read-only centralmcp probe with approved model policy', async () => {
    const fake = nativeDependencies(successfulClaudeProbe);
    const adapter = new ClaudeAdapter(fake.dependencies);
    const { context, invocations } = probeContext();

    const result = await adapter.probeReadOnly({ enabled: true, model: 'sonnet', reasoningEffort: 'low' }, context);

    expect(result).toEqual({ authenticated: true, modelReady: true, resolvedModel: 'sonnet' });
    expect(invocations).toEqual([{ boundary: 'mcp', server: 'centralmcp', tool: 'find_tool', access: 'read-only' }]);
    expect(fake.launchInputs).toEqual([centralMcp]);
    expect(fake.dispose).toHaveBeenCalledTimes(1);
    expect(fake.commands).toHaveLength(1);
    expect(fake.commands[0]).toMatchObject({ command: 'claude', timeoutMs: expect.any(Number) });
    expect(fake.commands[0].args).toEqual(expect.arrayContaining(['-p', '--output-format', 'stream-json', '--mcp-config', '/private/tmp/centralmcp.json', '--strict-mcp-config', '--model', 'sonnet', '--effort', 'low']));
    expect(JSON.stringify(fake.commands[0])).not.toContain('centralmcp-test-token');
    expect(JSON.stringify(fake.commands[0])).not.toMatch(/central-api-key|mist-api-key|clearpass-password/i);
  });

  it('rejects Copilot Auto with any persisted effort other than adaptive before executable discovery', async () => {
    const fake = nativeDependencies(successfulClaudeProbe);

    await expect(new CopilotAdapter(fake.dependencies).discover({ enabled: true, model: 'auto', effort: 'low' }))
      .resolves.toEqual({ installed: false, authenticated: false, modelReady: false });

    expect(fake.commands).toEqual([]);
  });

  it.each([
    ['Codex', (dependencies: NativeCliAdapterDependencies) => new CodexAdapter(dependencies), { enabled: true, model: 'gpt-5.6-terra', reasoningEffort: 'low' }],
    ['Kimi', (dependencies: NativeCliAdapterDependencies) => new KimiAdapter(dependencies), { enabled: true, model: 'kimi-code/kimi-for-coding-highspeed', thinking: false }],
    ['Copilot', (dependencies: NativeCliAdapterDependencies) => new CopilotAdapter(dependencies), { enabled: true, model: 'auto', effort: 'adaptive' }],
  ] as const)('%s refuses readiness when its installed transport cannot attach only the generated centralmcp config', async (_title, makeAdapter, config) => {
    const fake = nativeDependencies(successfulClaudeProbe);
    const { context, invocations } = probeContext();

    await expect(makeAdapter(fake.dependencies).probeReadOnly(config, context)).resolves.toEqual({ authenticated: false, modelReady: false });

    expect(invocations).toEqual([]);
    expect(fake.commands).toEqual([]);
    expect(fake.launchInputs).toEqual([]);
  });

  it('blocks readiness and disposes the generated config when authentication, isolation, or tool evidence fails without returning stderr', async () => {
    const fake = nativeDependencies('{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash"}]}}');
    fake.dependencies.commandRunner = {
      run: async (command) => {
        fake.commands.push(command);
        return { exitCode: 1, stdout: '{"type":"tool_call","toolName":"centralmcp__find_tool"}', stderr: 'provider-token=do-not-expose' };
      },
    };
    const { context, invocations } = probeContext();

    await expect(new ClaudeAdapter(fake.dependencies).probeReadOnly({ enabled: true, model: 'sonnet', reasoningEffort: 'low' }, context))
      .resolves.toEqual({ authenticated: false, modelReady: false });

    expect(invocations).toEqual([]);
    expect(fake.dispose).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['malformed output preceding valid evidence', `not-json\n${successfulClaudeProbe}`],
    ['a fabricated non-tool name', [
      '{"type":"system","subtype":"init"}',
      '{"type":"assistant","name":"mcp__centralmcp__find_tool","message":{"role":"assistant","content":[{"type":"text","text":"catalogue checked"}]}}',
      '{"type":"result","subtype":"success","is_error":false,"result":"catalogue checked"}',
    ].join('\n')],
    ['two centralmcp tool calls', successfulClaudeProbe.replace('"content":[{"type":"text","text":"catalogue checked"}]', '"content":[{"type":"tool_use","id":"toolu_second","name":"mcp__centralmcp__find_tool","input":{}}]')],
    ['centralmcp and shell tool calls in one event', successfulClaudeProbe.replace('"input":{"query":"catalogue"}}]', '"input":{"query":"catalogue"}},{"type":"tool_use","id":"toolu_shell","name":"Bash","input":{}}]')],
    ['a missing matching successful tool result', successfulClaudeProbe.replace('"type":"tool_result","tool_use_id":"toolu_centralmcp","content":"catalogue checked","is_error":false', '"type":"text","text":"catalogue checked"')],
    ['a failed matching tool result', successfulClaudeProbe.replace('"is_error":false}]', '"is_error":true}]')],
    ['a missing final successful result', successfulClaudeProbe.replace('\n{"type":"result","subtype":"success","is_error":false,"result":"catalogue checked"}', '')],
  ])('rejects $0 rather than manufacturing centralmcp readiness', async (_title, stdout) => {
    const fake = nativeDependencies(stdout);
    const { context, invocations } = probeContext();

    await expect(new ClaudeAdapter(fake.dependencies).probeReadOnly({ enabled: true, model: 'sonnet', reasoningEffort: 'low' }, context))
      .resolves.toEqual({ authenticated: false, modelReady: false });

    expect(invocations).toEqual([]);
    expect(fake.dispose).toHaveBeenCalledTimes(1);
  });

  it('refuses unsupported model policies without launching a native CLI', async () => {
    const fake = nativeDependencies('{"type":"tool_call","toolName":"centralmcp__find_tool"}');

    await expect(new ClaudeAdapter(fake.dependencies).probeReadOnly({ enabled: true, model: 'opus', reasoningEffort: 'low' }, probeContext().context))
      .resolves.toEqual({ authenticated: false, modelReady: false });
    await expect(new CodexAdapter(fake.dependencies).probeReadOnly({ enabled: true, model: 'gpt-5.6-terra', reasoningEffort: 'high' }, probeContext().context))
      .resolves.toEqual({ authenticated: false, modelReady: false });
    await expect(new KimiAdapter(fake.dependencies).probeReadOnly({ enabled: true, model: 'kimi-code/kimi-for-coding-highspeed', thinking: true }, probeContext().context))
      .resolves.toEqual({ authenticated: false, modelReady: false });

    expect(fake.commands).toEqual([]);
    expect(fake.launchInputs).toEqual([]);
  });
});
