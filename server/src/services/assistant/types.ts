import { spawn } from 'node:child_process';
import type { AssistantProviderConfig, AssistantProviderId, CodexProviderConfig } from '../../config/settings';

export type ProviderExecutionKind = 'cli' | 'openai-compatible';

export interface ProviderStatus {
  installed: boolean;
  authenticated: boolean;
  mcpReady: boolean;
  modelReady: boolean;
  selected: boolean;
  resolvedModel: string | null;
  latencyMs: number | null;
  /** Safe for API responses: implementation errors and credentials are never included. */
  message: string;
}

export interface ProviderDiscovery {
  installed: boolean;
  authenticated: boolean;
  modelReady: boolean;
  resolvedModel?: string;
}

export interface ReadOnlyProbeResult {
  authenticated: boolean;
  modelReady: boolean;
  resolvedModel?: string;
}

/** Observable probe activity. Only one named centralmcp read-only call proves readiness. */
export interface ProbeInvocation {
  boundary: 'mcp' | 'browser' | 'filesystem' | 'shell';
  server?: string;
  tool: string;
  access?: 'read-only' | 'write';
}

/**
 * Registry-owned transcript boundary for native probes. Adapters may report
 * every action they attempt, but the registry—not an adapter success flag—
 * decides whether that transcript proves centralmcp-only read access.
 */
export interface ReadOnlyProbeContext {
  /** Registry-owned centralmcp connection details; never sourced from an adapter. */
  readonly mcp: {
    endpoint: string;
    authToken: string | null;
  };
  recordInvocation(invocation: ProbeInvocation): void;
}

export interface AssistantChatRequest {
  /** The saved configuration selected by the registry; adapters never read global settings. */
  config: AssistantProviderConfig;
  /**
   * Request-owned centralmcp connection details for native adapters. The
   * browser never sees this object, and the adapter never reads global
   * settings or product connector credentials.
   */
  mcp?: {
    endpoint: string;
    authToken: string | null;
    writeEnabled: boolean;
  };
  /** Caller-selected bounded operation timeout. */
  timeoutMs: number;
  messages: ReadonlyArray<AssistantChatMessage>;
  tools?: readonly unknown[];
  executeTool?(call: AssistantChatToolCall): Promise<AssistantChatToolOutcome>;
  signal?: AbortSignal;
}

export interface AssistantChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: AssistantChatToolCall[];
  tool_call_id?: string;
}

export interface AssistantChatToolCall {
  id: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

export interface AssistantChatToolOutcome {
  toolMessage: AssistantChatMessage;
  transcript: unknown;
}

export interface AssistantChatResult {
  text: string;
  transcript?: unknown[];
}

export type CodexTransportFailureStage = 'before-turn' | 'after-turn';

/** Request-owned input for the private persistent Codex app-server process. */
export interface CodexTransportRequest {
  endpoint: string;
  authToken: string | null;
  writeEnabled: boolean;
  model: string;
  reasoningEffort: CodexProviderConfig['reasoningEffort'];
  prompt: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface AssistantProviderAdapter {
  id: AssistantProviderId;
  /** False when a probe transport exists but no equally isolated chat transport does. */
  canChat?(): boolean;
  discover(config: AssistantProviderConfig): Promise<ProviderDiscovery>;
  chat(request: AssistantChatRequest): Promise<AssistantChatResult>;
  probeReadOnly(config: AssistantProviderConfig, context: ReadOnlyProbeContext): Promise<ReadOnlyProbeResult>;
}

export interface CommandExecution {
  command: string;
  args: readonly string[];
  cwd?: string;
  env?: Readonly<Record<string, string | undefined>>;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface CommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

/** Injectable boundary for CLI adapters. Commands are always spawned without a shell. */
export interface CommandRunner {
  run(command: CommandExecution): Promise<CommandResult>;
}

function minimalEnvironment(extra: Readonly<Record<string, string | undefined>> | undefined): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of ['PATH', 'HOME', 'USER', 'LANG'] as const) {
    if (process.env[name]) env[name] = process.env[name];
  }
  for (const [name, value] of Object.entries(extra ?? {})) {
    if (value !== undefined) env[name] = value;
  }
  return env;
}

export function createSpawnCommandRunner(): CommandRunner {
  return {
    run(command) {
      return new Promise<CommandResult>((resolve, reject) => {
        const child = spawn(command.command, [...command.args], {
          cwd: command.cwd,
          env: minimalEnvironment(command.env),
          shell: false,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        let timedOut = false;
        let aborted = false;
        let settled = false;
        const finish = (complete: () => void) => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          command.signal?.removeEventListener('abort', abort);
          complete();
        };
        const abort = () => {
          aborted = true;
          child.kill();
        };
        const timer = command.timeoutMs === undefined ? undefined : setTimeout(() => {
          timedOut = true;
          child.kill();
        }, command.timeoutMs);
        if (command.signal?.aborted) abort();
        else command.signal?.addEventListener('abort', abort, { once: true });
        child.stdout?.setEncoding('utf8');
        child.stderr?.setEncoding('utf8');
        child.stdout?.on('data', (chunk: string) => { stdout += chunk; });
        child.stderr?.on('data', (chunk: string) => { stderr += chunk; });
        child.once('error', (error) => {
          finish(() => reject(error));
        });
        child.once('close', (exitCode) => {
          finish(() => resolve({ exitCode: timedOut || aborted ? null : exitCode, stdout, stderr }));
        });
      });
    },
  };
}

export interface AssistantProviderDescriptor {
  id: AssistantProviderId;
  title: string;
  executionKind: ProviderExecutionKind;
  requiredFields: readonly string[];
  defaultConfig: AssistantProviderConfig;
}
