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

const PROBE_TIMEOUT_MS = 15_000;
const READ_ONLY_PROBE_PROMPT = [
  'Perform one read-only centralmcp capability check.',
  'Call only the centralmcp find_tool tool once, then report that it completed.',
  'Do not use shell, filesystem, browser, network, write, or any other MCP tool.',
].join(' ');

type NativeProviderId = Extract<AssistantProviderId, 'codex' | 'claude' | 'kimi' | 'copilot'>;

export interface NativeCliAdapterDependencies {
  commandRunner?: CommandRunner;
  createMcpLaunchConfig?: (input: { endpoint: string; authToken: string | null }) => Promise<McpLaunchConfig>;
  probeTimeoutMs?: number;
  cwd?: string;
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

abstract class NativeCliAdapter<TConfig extends AssistantProviderConfig> implements AssistantProviderAdapter {
  readonly id: NativeProviderId;
  private readonly runner: CommandRunner;
  private readonly makeLaunchConfig: (input: { endpoint: string; authToken: string | null }) => Promise<McpLaunchConfig>;
  private readonly timeoutMs: number;
  private readonly cwd: string | undefined;

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
    const launch = await this.createIsolatedLaunch(context);
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

  private async createIsolatedLaunch(context: ReadOnlyProbeContext): Promise<McpLaunchConfig | null> {
    try {
      return await this.makeLaunchConfig(context.mcp);
    } catch {
      return null;
    }
  }
}

function isCodexConfig(config: AssistantProviderConfig): config is Extract<AssistantProviderConfig, { reasoningEffort: 'low' }> {
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

export class CodexAdapter extends NativeCliAdapter<Extract<AssistantProviderConfig, { reasoningEffort: 'low' }>> {
  constructor(dependencies: NativeCliAdapterDependencies = {}) {
    super({
      executable: 'codex',
      valid: isCodexConfig,
      canAttachGeneratedConfig: false,
      parseProbe: () => ({ centralReadOnly: false, invalid: true }),
      // app-server only accepts TOML config overrides and has no option for the generated JSON MCP file.
      // Using a user/profile config would broaden MCP access, so this local transport is fail-closed.
      buildProbe: () => null,
    }, 'codex', dependencies);
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
