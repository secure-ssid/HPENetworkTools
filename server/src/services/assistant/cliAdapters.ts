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
}

interface ParsedNativeProbe {
  centralReadOnly: boolean;
  forbiddenTool: boolean;
}

function parseJsonLines(stdout: string): unknown[] {
  return stdout.split(/\r?\n/).flatMap((line) => {
    try {
      return [JSON.parse(line) as unknown];
    } catch {
      return [];
    }
  });
}

function toolNameFrom(value: unknown): string | null {
  if (value === null || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  for (const candidate of [record.name, record.toolName, record.tool_name]) {
    if (typeof candidate === 'string') return candidate;
  }
  const item = record.item;
  if (item !== null && typeof item === 'object') return toolNameFrom(item);
  const message = record.message;
  if (message !== null && typeof message === 'object') {
    const content = (message as { content?: unknown }).content;
    if (Array.isArray(content)) {
      for (const block of content) {
        const name = toolNameFrom(block);
        if (name) return name;
      }
    }
  }
  return null;
}

function parseNativeProbe(stdout: string): ParsedNativeProbe {
  let centralReadOnly = false;
  let forbiddenTool = false;
  for (const event of parseJsonLines(stdout)) {
    const name = toolNameFrom(event);
    if (!name) continue;
    const normalized = name.toLowerCase();
    if (normalized === 'mcp__centralmcp__find_tool' || normalized === 'centralmcp__find_tool' || normalized === 'centralmcp(find_tool)') {
      centralReadOnly = true;
    } else {
      forbiddenTool = true;
    }
  }
  return { centralReadOnly, forbiddenTool };
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
      const parsed = parseNativeProbe(result.stdout);
      if (!parsed.centralReadOnly || parsed.forbiddenTool) return unavailable();
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
  return 'effort' in config && (config.model === 'auto' || config.model === 'gpt-5.6-terra');
}

export class CodexAdapter extends NativeCliAdapter<Extract<AssistantProviderConfig, { reasoningEffort: 'low' }>> {
  constructor(dependencies: NativeCliAdapterDependencies = {}) {
    super({
      executable: 'codex',
      valid: isCodexConfig,
      canAttachGeneratedConfig: false,
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
      canAttachGeneratedConfig: true,
      buildProbe: (config, configPath) => ({
        command: 'copilot',
        args: [
          '-p', READ_ONLY_PROBE_PROMPT,
          '--output-format', 'json',
          '--disable-builtin-mcps',
          '--additional-mcp-config', configPath,
          '--available-tools', 'centralmcp(find_tool)',
          '--no-custom-instructions',
          '--no-ask-user',
          '--disallow-temp-dir',
          '--no-remote',
          '--no-remote-export',
          '--model', config.model,
          ...(config.effort === 'adaptive' ? [] : ['--effort', config.effort]),
        ],
      }),
    }, 'copilot', dependencies);
  }
}
