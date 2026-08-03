import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AssistantProviderConfig, AssistantProviderId } from '../../config/settings';
import { createMcpLaunchConfig, type McpLaunchConfig } from './mcpLaunchConfig';
import type {
  AssistantChatRequest,
  AssistantChatResult,
  AssistantProviderAdapter,
  CommandExecution,
  CommandRunner,
  ProviderDiscovery,
  ReadOnlyProbeContext,
  ReadOnlyProbeResult,
} from './types';
import { createSpawnCommandRunner } from './types';

const PROBE_TIMEOUT_MS = 30_000;
const CODEX_PROBE_ATTEMPTS = 2;
const READ_ONLY_PROBE_PROMPT = [
  'Perform one read-only centralmcp capability check.',
  'Call only the centralmcp find_tool tool once, then report that it completed.',
  'Do not use shell, filesystem, browser, network, write, or any other MCP tool.',
].join(' ');

type NativeProviderId = Extract<AssistantProviderId, 'codex' | 'claude' | 'kimi' | 'copilot'>;
type CodexProviderConfig = Extract<AssistantProviderConfig, { reasoningEffort: string }>;

export interface NativeCliAdapterDependencies {
  commandRunner?: CommandRunner;
  createMcpLaunchConfig?: (input: { endpoint: string; authToken: string | null }) => Promise<McpLaunchConfig>;
  /** Creates an empty Codex workspace. It must never contain an MCP config or credential. */
  createEmptyDirectory?: () => Promise<DisposableWorkingDirectory>;
  probeTimeoutMs?: number;
  cwd?: string;
}

interface DisposableWorkingDirectory {
  directory: string;
  dispose(): Promise<void>;
}

interface NativeCliPolicy<TConfig extends AssistantProviderConfig> {
  executable: string;
  valid(config: AssistantProviderConfig): config is TConfig;
  canAttachGeneratedConfig: boolean;
  buildProbe(config: TConfig, configPath: string): CommandExecution | null;
  parseProbe(stdout: string): ParsedNativeProbe;
}

interface ParsedNativeProbe {
  centralReadOnly: boolean;
  invalid: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const CLI_TRANSCRIPT_ARGS_CAP = 200;
const CLI_TRANSCRIPT_RESULT_CAP = 300;

interface CodexToolTranscript {
  tool: string;
  args: string;
  resultPreview: string;
  ok: boolean;
}

interface ParsedCodexRun {
  text: string | null;
  transcript: CodexToolTranscript[];
  invalid: boolean;
}

function compact(value: string, cap: number): string {
  return value.length <= cap ? value : `${value.slice(0, Math.max(0, cap - 1))}…`;
}

function compactJson(value: unknown, cap: number): string {
  try {
    return compact(JSON.stringify(value ?? {}), cap);
  } catch {
    return '{}';
  }
}

function compactResult(value: unknown): string {
  if (typeof value === 'string') return compact(value.trim() || '(tool returned no text)', CLI_TRANSCRIPT_RESULT_CAP);
  return compactJson(value, CLI_TRANSCRIPT_RESULT_CAP);
}

/**
 * Codex `exec --json` is a JSONL transport, not browser data. Keep only the
 * two item shapes this UI can safely use: final agent text and actual calls to
 * the one MCP server the portal supplied. Everything else is discarded; bad
 * JSON, another MCP server, or an unfinished turn means no answer is returned.
 */
function parseCodexRun(stdout: string): ParsedCodexRun {
  const lines = stdout.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length === 0) return { text: null, transcript: [], invalid: true };

  let text: string | null = null;
  let completed = false;
  const transcript: CodexToolTranscript[] = [];
  for (const line of lines) {
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      return { text: null, transcript: [], invalid: true };
    }
    if (!isRecord(event) || typeof event.type !== 'string') return { text: null, transcript: [], invalid: true };

    if (event.type === 'turn.completed') {
      if (event.status === 'failed' || event.status === 'error' || (event.error !== undefined && event.error !== null)) {
        return { text: null, transcript: [], invalid: true };
      }
      completed = true;
      continue;
    }
    if (event.type !== 'item.completed') continue;
    const item = event.item;
    if (!isRecord(item) || typeof item.type !== 'string') return { text: null, transcript: [], invalid: true };
    if (item.type === 'agent_message') {
      if (typeof item.text !== 'string') return { text: null, transcript: [], invalid: true };
      const next = item.text.trim();
      if (next) text = next;
      continue;
    }
    if (item.type !== 'mcp_tool_call') continue;
    if (item.server !== 'centralmcp' || typeof item.tool !== 'string' || item.tool.trim().length === 0) {
      return { text: null, transcript: [], invalid: true };
    }
    transcript.push({
      tool: item.tool,
      args: compactJson(item.arguments, CLI_TRANSCRIPT_ARGS_CAP),
      resultPreview: compactResult(item.result),
      ok: item.is_error !== true && item.status !== 'failed' && item.status !== 'error',
    });
  }
  return { text, transcript, invalid: !completed || text === null };
}

function codexPrompt(messages: AssistantChatRequest['messages'], writeEnabled: boolean): string {
  const conversation = messages
    .map((message) => `[${message.role.toUpperCase()}]\n${message.content ?? ''}`)
    .join('\n\n');
  return [
    'You are the HPE Network Tools lab assistant.',
    'Use only the centralmcp MCP server. First call find_tool to learn the exact backend tool and schema; never invent a tool name or arguments.',
    writeEnabled
      ? 'This is a lab: centralmcp configuration writes are enabled and apply immediately. Use invoke_tool when the request needs a write, then state exactly what changed.'
      : 'Write tools are disabled. Use find_tool and invoke_read_tool only.',
    'Keep the response concise and technical. Do not use shell, filesystem, browser, or unrelated tools.',
    'Conversation follows:',
    conversation,
  ].join('\n\n');
}

function isToolResultContent(value: unknown): boolean {
  if (typeof value === 'string') return true;
  return Array.isArray(value) && value.every((block) => isRecord(block) && block.type === 'text' && typeof block.text === 'string');
}

/**
 * Claude stream-json must describe an actual, successful invocation—not merely
 * an assistant request or a convenient string in arbitrary JSON. Any unknown
 * event/block, malformed non-empty line, duplicate, or out-of-order result is
 * unsafe evidence and leaves the provider unavailable.
 */
function parseClaudeProbe(stdout: string): ParsedNativeProbe {
  const lines = stdout.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length === 0) return { centralReadOnly: false, invalid: true };

  let toolUseId: string | null = null;
  let successfulToolResult = false;
  let finalSuccess = false;
  for (let index = 0; index < lines.length; index += 1) {
    let event: unknown;
    try {
      event = JSON.parse(lines[index]);
    } catch {
      return { centralReadOnly: false, invalid: true };
    }
    if (!isRecord(event) || typeof event.type !== 'string') return { centralReadOnly: false, invalid: true };

    if (event.type === 'system') {
      if (event.subtype !== 'init') return { centralReadOnly: false, invalid: true };
      continue;
    }
    if (event.type === 'assistant') {
      if (!isRecord(event.message) || event.message.role !== 'assistant' || !Array.isArray(event.message.content)) {
        return { centralReadOnly: false, invalid: true };
      }
      for (const block of event.message.content) {
        if (!isRecord(block) || typeof block.type !== 'string') return { centralReadOnly: false, invalid: true };
        if (block.type === 'text') {
          if (typeof block.text !== 'string') return { centralReadOnly: false, invalid: true };
          continue;
        }
        if (block.type === 'thinking') {
          if (typeof block.thinking !== 'string') return { centralReadOnly: false, invalid: true };
          continue;
        }
        if (block.type !== 'tool_use'
          || typeof block.id !== 'string'
          || block.id.length === 0
          || block.name !== 'mcp__centralmcp__find_tool'
          || !isRecord(block.input)
          || toolUseId !== null) {
          return { centralReadOnly: false, invalid: true };
        }
        toolUseId = block.id;
      }
      continue;
    }
    if (event.type === 'user') {
      if (!isRecord(event.message) || event.message.role !== 'user' || !Array.isArray(event.message.content)) {
        return { centralReadOnly: false, invalid: true };
      }
      for (const block of event.message.content) {
        if (!isRecord(block) || typeof block.type !== 'string') return { centralReadOnly: false, invalid: true };
        if (block.type === 'text') {
          if (typeof block.text !== 'string') return { centralReadOnly: false, invalid: true };
          continue;
        }
        if (block.type !== 'tool_result'
          || toolUseId === null
          || successfulToolResult
          || block.tool_use_id !== toolUseId
          || block.is_error !== false
          || !isToolResultContent(block.content)) {
          return { centralReadOnly: false, invalid: true };
        }
        successfulToolResult = true;
      }
      continue;
    }
    if (event.type === 'result') {
      if (index !== lines.length - 1
        || toolUseId === null
        || !successfulToolResult
        || event.subtype !== 'success'
        || event.is_error !== false
        || typeof event.result !== 'string'
        || finalSuccess) {
        return { centralReadOnly: false, invalid: true };
      }
      finalSuccess = true;
      continue;
    }
    return { centralReadOnly: false, invalid: true };
  }
  return { centralReadOnly: toolUseId !== null && successfulToolResult && finalSuccess, invalid: false };
}

function unavailable(): ReadOnlyProbeResult {
  return { authenticated: false, modelReady: false };
}

function resultFor(config: { model: string }): ReadOnlyProbeResult {
  return { authenticated: true, modelReady: true, resolvedModel: config.model };
}

/**
 * Codex receives its MCP endpoint and optional bearer-token environment name
 * as TOML overrides. Its working directory must remain empty: unlike the
 * generated JSON configurations used by other CLIs, a readable file here
 * would let the agent inspect an HTTP bearer token.
 */
async function createEmptyCodexWorkspace(): Promise<DisposableWorkingDirectory> {
  const directory = await fs.mkdtemp(join(tmpdir(), 'hpe-codex-'));
  let disposed = false;
  return {
    directory,
    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      await fs.rm(directory, { recursive: true, force: true });
    },
  };
}

abstract class NativeCliAdapter<TConfig extends AssistantProviderConfig> implements AssistantProviderAdapter {
  readonly id: NativeProviderId;
  protected readonly runner: CommandRunner;
  private readonly makeLaunchConfig: (input: { endpoint: string; authToken: string | null }) => Promise<McpLaunchConfig>;
  protected readonly timeoutMs: number;
  protected readonly cwd: string | undefined;

  protected constructor(readonly policy: NativeCliPolicy<TConfig>, id: NativeProviderId, dependencies: NativeCliAdapterDependencies = {}) {
    this.id = id;
    this.runner = dependencies.commandRunner ?? createSpawnCommandRunner();
    this.makeLaunchConfig = dependencies.createMcpLaunchConfig ?? createMcpLaunchConfig;
    this.timeoutMs = dependencies.probeTimeoutMs ?? PROBE_TIMEOUT_MS;
    this.cwd = dependencies.cwd;
  }

  canChat(): boolean {
    // No native adapter has a generated-config-only conversational transport
    // yet. A successful readiness probe must not promise a later chat call.
    return false;
  }

  async discover(config: AssistantProviderConfig): Promise<ProviderDiscovery> {
    if (!this.policy.valid(config)) return { installed: false, authenticated: false, modelReady: false };
    try {
      const command = await this.runner.run({ command: this.policy.executable, args: ['--version'], cwd: this.cwd, timeoutMs: this.timeoutMs });
      const installed = command.exitCode === 0;
      // Authentication and model access are proved by the isolated probe, not by executable discovery.
      return { installed, authenticated: installed, modelReady: installed, resolvedModel: installed ? config.model : undefined };
    } catch {
      return { installed: false, authenticated: false, modelReady: false };
    }
  }

  async probeReadOnly(config: AssistantProviderConfig, context: ReadOnlyProbeContext): Promise<ReadOnlyProbeResult> {
    if (!this.policy.valid(config)) return unavailable();
    if (!this.policy.canAttachGeneratedConfig) return unavailable();
    const launch = await this.createIsolatedLaunch(context.mcp);
    if (!launch) return unavailable();
    try {
      const command = this.policy.buildProbe(config, launch.path);
      if (!command) return unavailable();
      const result = await this.runner.run({ ...command, cwd: this.cwd, timeoutMs: this.timeoutMs });
      // stderr can include provider diagnostics and must never become a status/chat response or log entry.
      if (result.exitCode !== 0) return unavailable();
      const parsed = this.policy.parseProbe(result.stdout);
      if (!parsed.centralReadOnly || parsed.invalid) return unavailable();
      context.recordInvocation({ boundary: 'mcp', server: 'centralmcp', tool: 'find_tool', access: 'read-only' });
      return resultFor(config);
    } catch {
      return unavailable();
    } finally {
      await launch.dispose().catch(() => undefined);
    }
  }

  async chat(_request: AssistantChatRequest): Promise<AssistantChatResult> {
    // Native chat dispatch is intentionally deferred until Task 5 can supply the same registry-owned
    // centralmcp launch context used by the readiness probe. Never fall back to a broader CLI session.
    throw new Error('Native assistant provider is unavailable.');
  }

  protected async createIsolatedLaunch(mcp: ReadOnlyProbeContext['mcp']): Promise<McpLaunchConfig | null> {
    try {
      return await this.makeLaunchConfig(mcp);
    } catch {
      return null;
    }
  }
}

function isCodexConfig(config: AssistantProviderConfig): config is CodexProviderConfig {
  return 'reasoningEffort' in config && config.model === 'gpt-5.6-terra' && config.reasoningEffort === 'low';
}

function isClaudeConfig(config: AssistantProviderConfig): config is Extract<AssistantProviderConfig, { reasoningEffort: string }> {
  return 'reasoningEffort' in config && /sonnet/i.test(config.model) && !/opus/i.test(config.model) && config.reasoningEffort === 'low';
}

function isKimiConfig(config: AssistantProviderConfig): config is Extract<AssistantProviderConfig, { thinking: false }> {
  return 'thinking' in config && config.model === 'kimi-code/kimi-for-coding-highspeed' && config.thinking === false;
}

function isCopilotConfig(config: AssistantProviderConfig): config is Extract<AssistantProviderConfig, { effort: string }> {
  return 'effort' in config && (
    (config.model === 'auto' && config.effort === 'adaptive')
    || config.model === 'gpt-5.6-terra'
  );
}

export class CodexAdapter extends NativeCliAdapter<CodexProviderConfig> {
  private readonly makeEmptyDirectory: () => Promise<DisposableWorkingDirectory>;

  constructor(dependencies: NativeCliAdapterDependencies = {}) {
    super({
      executable: 'codex',
      valid: isCodexConfig,
      canAttachGeneratedConfig: true,
      parseProbe: () => ({ centralReadOnly: false, invalid: true }),
      // Codex receives TOML overrides, never the generated JSON file. The
      // disposable directory still gives each command an empty working tree.
      buildProbe: () => null,
    }, 'codex', dependencies);
    this.makeEmptyDirectory = dependencies.createEmptyDirectory ?? createEmptyCodexWorkspace;
  }

  override canChat(): boolean {
    return true;
  }

  override async probeReadOnly(config: AssistantProviderConfig, context: ReadOnlyProbeContext): Promise<ReadOnlyProbeResult> {
    if (!isCodexConfig(config)) return unavailable();
    for (let attempt = 0; attempt < CODEX_PROBE_ATTEMPTS; attempt += 1) {
      const workspace = await this.createEmptyWorkspace();
      if (!workspace) return unavailable();
      try {
        const result = await this.runner.run(this.commandFor(config, context.mcp, workspace.directory, READ_ONLY_PROBE_PROMPT, false, this.timeoutMs));
        if (result.exitCode !== 0) return unavailable();
        const parsed = parseCodexRun(result.stdout);
        const successfulFindTool = !parsed.invalid
          && parsed.transcript.length === 1
          && parsed.transcript[0]?.tool === 'find_tool'
          && parsed.transcript[0]?.ok;
        if (successfulFindTool) {
          context.recordInvocation({ boundary: 'mcp', server: 'centralmcp', tool: 'find_tool', access: 'read-only' });
          return resultFor(config);
        }
        // The native CLI can occasionally complete a valid turn without calling
        // an offered MCP tool. Retry exactly once in a fresh empty workspace;
        // readiness remains true only after a real centralmcp read is observed.
        if (!parsed.invalid && parsed.transcript.length === 0 && attempt + 1 < CODEX_PROBE_ATTEMPTS) {
          continue;
        }
        return unavailable();
      } catch {
        return unavailable();
      } finally {
        await workspace.dispose().catch(() => undefined);
      }
    }
    return unavailable();
  }

  override async chat(request: AssistantChatRequest): Promise<AssistantChatResult> {
    if (!isCodexConfig(request.config)) throw new Error('Codex provider configuration is invalid.');
    if (!request.mcp) throw new Error('Codex centralmcp connection is unavailable.');
    const workspace = await this.createEmptyWorkspace();
    if (!workspace) throw new Error('Codex launch context is unavailable.');
    try {
      const result = await this.runner.run(this.commandFor(
        request.config,
        request.mcp,
        workspace.directory,
        codexPrompt(request.messages, request.mcp.writeEnabled),
        request.mcp.writeEnabled,
        request.timeoutMs,
        request.signal,
      ));
      if (result.exitCode !== 0) throw new Error('Codex CLI did not complete the assistant request.');
      const parsed = parseCodexRun(result.stdout);
      if (parsed.invalid || !parsed.text) throw new Error('Codex CLI returned an invalid assistant response.');
      return { text: parsed.text, transcript: parsed.transcript };
    } finally {
      await workspace.dispose().catch(() => undefined);
    }
  }

  private async createEmptyWorkspace(): Promise<DisposableWorkingDirectory | null> {
    try {
      return await this.makeEmptyDirectory();
    } catch {
      return null;
    }
  }

  private commandFor(
    config: CodexProviderConfig,
    mcp: ReadOnlyProbeContext['mcp'],
    directory: string,
    prompt: string,
    writeEnabled: boolean,
    timeoutMs: number,
    signal?: AbortSignal,
  ): CommandExecution {
    const enabledTools = writeEnabled
      ? ['find_tool', 'invoke_read_tool', 'invoke_tool']
      : ['find_tool', 'invoke_read_tool'];
    const overrides = [
      'model_reasoning_effort="low"',
      `mcp_servers.centralmcp.url=${JSON.stringify(mcp.endpoint)}`,
      'mcp_servers.centralmcp.enabled=true',
      'mcp_servers.centralmcp.required=true',
      `mcp_servers.centralmcp.enabled_tools=[${enabledTools.map((tool) => JSON.stringify(tool)).join(',')}]`,
      'mcp_servers.centralmcp.default_tools_approval_mode="auto"',
    ];
    if (mcp.authToken) overrides.push('mcp_servers.centralmcp.bearer_token_env_var="HPE_ASSISTANT_MCP_TOKEN"');
    return {
      command: 'codex',
      args: [
        'exec', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check',
        '--cd', directory, '--sandbox', 'read-only', '--model', config.model, '--strict-config',
        ...overrides.flatMap((override) => ['-c', override]),
        '--json', prompt,
      ],
      cwd: directory,
      ...(mcp.authToken ? { env: { HPE_ASSISTANT_MCP_TOKEN: mcp.authToken } } : {}),
      timeoutMs,
      signal,
    };
  }
}

export class ClaudeAdapter extends NativeCliAdapter<Extract<AssistantProviderConfig, { reasoningEffort: string }>> {
  constructor(dependencies: NativeCliAdapterDependencies = {}) {
    super({
      executable: 'claude',
      valid: isClaudeConfig,
      canAttachGeneratedConfig: true,
      parseProbe: parseClaudeProbe,
      buildProbe: (config, configPath) => ({
        command: 'claude',
        args: [
          '-p', READ_ONLY_PROBE_PROMPT,
          '--output-format', 'stream-json',
          '--mcp-config', configPath,
          '--strict-mcp-config',
          '--no-session-persistence',
          '--no-chrome',
          '--disable-slash-commands',
          '--model', config.model,
          '--effort', 'low',
          '--permission-mode', 'dontAsk',
          '--allowedTools', 'mcp__centralmcp__find_tool',
          '--disallowedTools', 'Bash,Edit,Read,Write,Glob,Grep,WebFetch,WebSearch',
        ],
      }),
    }, 'claude', dependencies);
  }
}

export class KimiAdapter extends NativeCliAdapter<Extract<AssistantProviderConfig, { thinking: false }>> {
  constructor(dependencies: NativeCliAdapterDependencies = {}) {
    super({
      executable: 'kimi',
      valid: isKimiConfig,
      canAttachGeneratedConfig: false,
      parseProbe: () => ({ centralReadOnly: false, invalid: true }),
      // The installed Kimi CLI exposes neither an MCP-config flag nor an ACP option for passing one.
      // Do not rely on its user config or invent an undocumented environment variable.
      buildProbe: () => null,
    }, 'kimi', dependencies);
  }
}

export class CopilotAdapter extends NativeCliAdapter<Extract<AssistantProviderConfig, { effort: string }>> {
  constructor(dependencies: NativeCliAdapterDependencies = {}) {
    super({
      executable: 'copilot',
      valid: isCopilotConfig,
      canAttachGeneratedConfig: false,
      // --additional-mcp-config augments user/workspace/plugin MCP sources. This installed CLI
      // has no documented replacement or strict configuration option, so never launch it here.
      buildProbe: () => null,
      parseProbe: () => ({ centralReadOnly: false, invalid: true }),
    }, 'copilot', dependencies);
  }
}
