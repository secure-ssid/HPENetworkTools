import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  AssistantChatResult,
  CodexTransportFailureStage,
  CodexTransportRequest,
} from './types';

const APP_SERVER_ARGS = [
  'app-server', '--stdio', '--strict-config',
  '--disable', 'apps', '--disable', 'plugins',
  '--disable', 'computer_use', '--disable', 'browser_use',
] as const;
const READ_TOOLS = ['find_tool', 'invoke_read_tool'] as const;
const WRITE_TOOLS = [...READ_TOOLS, 'invoke_tool'] as const;
const OPT_OUT_NOTIFICATION_METHODS = [
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
] as const;
const MAX_JSONL_BUFFER = 1_048_576;
const TRANSCRIPT_ARGS_CAP = 200;
const TRANSCRIPT_RESULT_CAP = 300;

type JsonRecord = Record<string, unknown>;

export interface CodexAppServerLaunch {
  command: 'codex';
  args: readonly string[];
  cwd: string;
  env: Readonly<Record<string, string | undefined>>;
  shell: false;
}

/** Injectable JSONL child boundary. Implementations must never log either stream. */
export interface CodexAppServerChild {
  write(line: string): void;
  onStdout(listener: (chunk: string) => void): void;
  onFailure(listener: (error: Error) => void): void;
  kill(): void;
}

/** Injectable filesystem boundary used to create the private Codex home. */
export interface CodexAppServerFileSystem {
  mkdtemp(prefix: string): Promise<string>;
  mkdir(path: string, options: { mode: number }): Promise<unknown>;
  chmod(path: string, mode: number): Promise<void>;
  copyFile(source: string, destination: string): Promise<void>;
  rm(path: string, options: { recursive: true; force: true }): Promise<void>;
}

export interface CodexAppServerDependencies {
  spawnChild?: (launch: CodexAppServerLaunch) => CodexAppServerChild;
  fs?: CodexAppServerFileSystem;
  authPath?: string;
  temporaryDirectory?: string;
  environment?: NodeJS.ProcessEnv;
}

export interface CodexAppServerLike {
  chat(input: CodexTransportRequest): Promise<AssistantChatResult>;
  probe(input: CodexTransportRequest): Promise<AssistantChatResult>;
  dispose(): Promise<void>;
}

export class CodexAppServerFailure extends Error {
  readonly stage: CodexTransportFailureStage;

  constructor(stage: CodexTransportFailureStage) {
    super(stage === 'before-turn'
      ? 'Codex app-server could not start the assistant turn.'
      : 'Codex CLI did not complete the assistant request.');
    this.name = 'CodexAppServerFailure';
    this.stage = stage;
  }
}

interface PrivateContext {
  root: string;
  home: string;
  workspace: string;
  dispose(): Promise<void>;
}

interface PendingResponse {
  resolve(value: unknown): void;
  reject(error: CodexAppServerFailure): void;
}

interface ToolTranscript {
  tool: string;
  args: string;
  resultPreview: string;
  ok: boolean;
}

interface ActiveTurn {
  threadId: string;
  turnId: string | null;
  allowedTools: ReadonlySet<string>;
  text: string | null;
  transcript: ToolTranscript[];
  items: Map<string, { type: 'userMessage' | 'agentMessage' | 'mcpToolCall' | 'reasoning'; completed: boolean }>;
  prompt: string;
  sensitiveToken: string | null;
  resolve(result: AssistantChatResult): void;
  reject(error: CodexAppServerFailure): void;
}

interface Session {
  child: CodexAppServerChild;
  context: PrivateContext;
  scope: string;
  nextId: number;
  pending: Map<number, PendingResponse>;
  buffer: string;
  stage: CodexTransportFailureStage;
  activeTurn: ActiveTurn | null;
  disposed: boolean;
}

interface RunGuard {
  cancelled: boolean;
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
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

function resultPreview(result: unknown): string {
  if (typeof result === 'string') return compact(result.trim() || '(tool returned no text)', TRANSCRIPT_RESULT_CAP);
  if (isRecord(result) && Array.isArray(result.content)) {
    const text = result.content
      .filter((block): block is JsonRecord => isRecord(block) && block.type === 'text' && typeof block.text === 'string')
      .map((block) => String(block.text).trim())
      .filter(Boolean)
      .join('\n');
    if (text) return compact(text, TRANSCRIPT_RESULT_CAP);
  }
  return compactJson(result, TRANSCRIPT_RESULT_CAP);
}

function containsSensitiveToken(value: unknown, token: string | null): boolean {
  if (!token) return false;
  if (typeof value === 'string') return value.includes(token);
  if (Array.isArray(value)) return value.some((entry) => containsSensitiveToken(entry, token));
  if (!isRecord(value)) return false;
  return Object.entries(value).some(([key, entry]) => key.includes(token) || containsSensitiveToken(entry, token));
}

function minimalEnvironment(source: NodeJS.ProcessEnv): Record<string, string | undefined> {
  const environment: Record<string, string | undefined> = {};
  for (const name of ['PATH', 'HOME', 'USER', 'LANG'] as const) {
    if (source[name]) environment[name] = source[name];
  }
  return environment;
}

function defaultFileSystem(): CodexAppServerFileSystem {
  return {
    mkdtemp: (prefix) => fs.mkdtemp(prefix),
    mkdir: (path, options) => fs.mkdir(path, options),
    chmod: (path, mode) => fs.chmod(path, mode),
    copyFile: (source, destination) => fs.copyFile(source, destination),
    rm: (path, options) => fs.rm(path, options),
  };
}

function defaultSpawnChild(launch: CodexAppServerLaunch): CodexAppServerChild {
  const child = spawn(launch.command, [...launch.args], {
    cwd: launch.cwd,
    env: launch.env as NodeJS.ProcessEnv,
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const stdoutListeners: Array<(chunk: string) => void> = [];
  const failureListeners: Array<(error: Error) => void> = [];
  let failed = false;
  const safeError = new Error('Codex app-server process ended.');
  const fail = () => {
    if (failed) return;
    failed = true;
    for (const listener of failureListeners) listener(safeError);
  };
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    for (const listener of stdoutListeners) listener(chunk);
  });
  // Drain diagnostics without retaining, logging, or returning them.
  child.stderr.resume();
  child.stdin.on('error', fail);
  child.once('error', fail);
  child.once('close', fail);
  return {
    write(line) {
      if (failed || child.stdin.destroyed) throw new Error('Codex app-server process is unavailable.');
      child.stdin.write(`${line}\n`);
    },
    onStdout(listener) { stdoutListeners.push(listener); },
    onFailure(listener) {
      failureListeners.push(listener);
      if (failed) listener(safeError);
    },
    kill() {
      if (!child.killed) child.kill();
    },
  };
}

export class CodexAppServer implements CodexAppServerLike {
  private readonly spawnChild: (launch: CodexAppServerLaunch) => CodexAppServerChild;
  private readonly fileSystem: CodexAppServerFileSystem;
  private readonly authPath: string;
  private readonly temporaryDirectory: string;
  private readonly environment: NodeJS.ProcessEnv;
  private session: Session | null = null;
  private queue: Promise<void> = Promise.resolve();

  constructor(dependencies: CodexAppServerDependencies = {}) {
    this.spawnChild = dependencies.spawnChild ?? defaultSpawnChild;
    this.fileSystem = dependencies.fs ?? defaultFileSystem();
    this.environment = dependencies.environment ?? process.env;
    const currentCodexHome = this.environment.CODEX_HOME || join(homedir(), '.codex');
    this.authPath = dependencies.authPath ?? join(currentCodexHome, 'auth.json');
    this.temporaryDirectory = dependencies.temporaryDirectory ?? tmpdir();
  }

  chat(input: CodexTransportRequest): Promise<AssistantChatResult> {
    return this.enqueue(input);
  }

  probe(input: CodexTransportRequest): Promise<AssistantChatResult> {
    return this.enqueue({ ...input, writeEnabled: false });
  }

  async dispose(): Promise<void> {
    await this.disposeSession();
  }

  private enqueue(input: CodexTransportRequest): Promise<AssistantChatResult> {
    const result = this.queue.then(() => this.run(input));
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async run(input: CodexTransportRequest): Promise<AssistantChatResult> {
    let stage: CodexTransportFailureStage = 'before-turn';
    const guard: RunGuard = { cancelled: false };
    let rejectGuard!: (error: CodexAppServerFailure) => void;
    const guardedFailure = new Promise<never>((_resolve, reject) => { rejectGuard = reject; });
    const failGuard = () => {
      if (guard.cancelled) return;
      guard.cancelled = true;
      const failure = new CodexAppServerFailure(stage);
      if (this.session) this.invalidate(this.session, failure);
      rejectGuard(failure);
    };
    const timer = setTimeout(failGuard, Math.max(0, input.timeoutMs));
    const abort = () => failGuard();
    if (input.signal?.aborted) failGuard();
    else input.signal?.addEventListener('abort', abort, { once: true });

    const lifecycle = (async () => {
      if (guard.cancelled) throw new CodexAppServerFailure('before-turn');
      const allowedTools = input.writeEnabled ? WRITE_TOOLS : READ_TOOLS;
      const scope = this.scopeFor(input, allowedTools);
      const session = await this.ensureSession(input, allowedTools, scope, guard);
      if (guard.cancelled) throw new CodexAppServerFailure('before-turn');
      session.stage = 'before-turn';

      const threadResult = await this.request(session, 'thread/start', this.threadStartParams(input, session, allowedTools));
      const threadId = this.threadIdFrom(threadResult);
      const inventory = await this.inventory(session, threadId);
      if (inventory.length !== 1 || inventory[0] !== 'centralmcp') {
        const failure = new CodexAppServerFailure('before-turn');
        this.invalidate(session, failure);
        throw failure;
      }

      stage = 'after-turn';
      session.stage = 'after-turn';
      let activeTurn!: ActiveTurn;
      const completion = new Promise<AssistantChatResult>((resolve, reject) => {
        activeTurn = {
          threadId,
          turnId: null,
          allowedTools: new Set(allowedTools),
          text: null,
          transcript: [],
          items: new Map(),
          prompt: input.prompt,
          sensitiveToken: input.authToken,
          resolve,
          reject,
        };
        session.activeTurn = activeTurn;
      });
      const [turnId, completedResult] = await Promise.all([
        this.request(session, 'turn/start', {
          threadId,
          input: [{ type: 'text', text: input.prompt }],
        }).then((result) => this.turnIdFrom(result)),
        completion,
      ]);
      if (activeTurn.turnId !== null && activeTurn.turnId !== turnId) {
        const failure = new CodexAppServerFailure('after-turn');
        this.invalidate(session, failure);
        throw failure;
      }
      activeTurn.turnId = turnId;
      return completedResult;
    })();

    try {
      return await Promise.race([lifecycle, guardedFailure]);
    } catch (error) {
      const failure = error instanceof CodexAppServerFailure ? error : new CodexAppServerFailure(stage);
      if (this.session) this.invalidate(this.session, failure);
      throw failure;
    } finally {
      clearTimeout(timer);
      input.signal?.removeEventListener('abort', abort);
    }
  }

  private async ensureSession(
    input: CodexTransportRequest,
    allowedTools: readonly string[],
    scope: string,
    guard: RunGuard,
  ): Promise<Session> {
    if (this.session?.scope === scope && !this.session.disposed) return this.session;
    if (this.session) await this.disposeSession();

    const context = await this.createPrivateContext();
    if (guard.cancelled) {
      await context.dispose().catch(() => undefined);
      throw new CodexAppServerFailure('before-turn');
    }
    const env = {
      ...minimalEnvironment(this.environment),
      HOME: context.home,
      CODEX_HOME: context.home,
      ...(input.authToken ? { HPE_ASSISTANT_MCP_TOKEN: input.authToken } : {}),
    };
    let child: CodexAppServerChild;
    try {
      child = this.spawnChild({
        command: 'codex',
        args: APP_SERVER_ARGS,
        cwd: context.workspace,
        env,
        shell: false,
      });
    } catch {
      await context.dispose().catch(() => undefined);
      throw new CodexAppServerFailure('before-turn');
    }
    const session: Session = {
      child,
      context,
      scope,
      nextId: 1,
      pending: new Map(),
      buffer: '',
      stage: 'before-turn',
      activeTurn: null,
      disposed: false,
    };
    this.session = session;
    child.onStdout((chunk) => this.onStdout(session, chunk));
    child.onFailure(() => this.invalidate(session, new CodexAppServerFailure(session.stage)));
    try {
      await this.request(session, 'initialize', {
        clientInfo: { name: 'hpe-network-tools', title: 'HPE Network Tools', version: '1.0.0' },
        capabilities: {
          experimentalApi: true,
          optOutNotificationMethods: OPT_OUT_NOTIFICATION_METHODS,
        },
      });
      this.notify(session, 'initialized');
      return session;
    } catch (error) {
      const failure = error instanceof CodexAppServerFailure ? error : new CodexAppServerFailure('before-turn');
      this.invalidate(session, failure);
      throw failure;
    }
  }

  private async createPrivateContext(): Promise<PrivateContext> {
    const root = await this.fileSystem.mkdtemp(join(this.temporaryDirectory, 'hpe-codex-app-server-'));
    const home = join(root, 'home');
    const workspace = join(root, 'workspace');
    try {
      await this.fileSystem.chmod(root, 0o700);
      await this.fileSystem.mkdir(home, { mode: 0o700 });
      await this.fileSystem.chmod(home, 0o700);
      await this.fileSystem.mkdir(workspace, { mode: 0o700 });
      await this.fileSystem.chmod(workspace, 0o700);
      const authDestination = join(home, 'auth.json');
      await this.fileSystem.copyFile(this.authPath, authDestination);
      await this.fileSystem.chmod(authDestination, 0o600);
      return {
        root,
        home,
        workspace,
        dispose: () => this.fileSystem.rm(root, { recursive: true, force: true }),
      };
    } catch {
      await this.fileSystem.rm(root, { recursive: true, force: true }).catch(() => undefined);
      throw new CodexAppServerFailure('before-turn');
    }
  }

  private scopeFor(input: CodexTransportRequest, allowedTools: readonly string[]): string {
    const tokenDigest = createHash('sha256').update(input.authToken ?? '').digest('hex');
    return JSON.stringify({ endpoint: input.endpoint, tokenDigest, allowedTools });
  }

  private threadStartParams(input: CodexTransportRequest, session: Session, allowedTools: readonly string[]): JsonRecord {
    const config: JsonRecord = {
      'mcp_servers.centralmcp.url': input.endpoint,
      'mcp_servers.centralmcp.enabled': true,
      'mcp_servers.centralmcp.required': true,
      'mcp_servers.centralmcp.enabled_tools': [...allowedTools],
      'mcp_servers.centralmcp.default_tools_approval_mode': 'auto',
      ...(input.authToken ? { 'mcp_servers.centralmcp.bearer_token_env_var': 'HPE_ASSISTANT_MCP_TOKEN' } : {}),
      ...(input.reasoningEffort === 'auto' ? {} : { model_reasoning_effort: input.reasoningEffort }),
      hide_agent_reasoning: true,
    };
    return {
      ephemeral: true,
      cwd: session.context.workspace,
      sandbox: 'read-only',
      approvalPolicy: 'never',
      model: input.model,
      config,
    };
  }

  private async inventory(session: Session, threadId: string): Promise<string[]> {
    const names: string[] = [];
    let cursor: string | undefined;
    do {
      const result = await this.request(session, 'mcpServerStatus/list', {
        threadId,
        ...(cursor ? { cursor } : {}),
      });
      if (!isRecord(result) || !Array.isArray(result.data)) throw new CodexAppServerFailure('before-turn');
      for (const entry of result.data) {
        if (!isRecord(entry) || typeof entry.name !== 'string') throw new CodexAppServerFailure('before-turn');
        names.push(entry.name);
      }
      if (result.nextCursor !== null && result.nextCursor !== undefined && typeof result.nextCursor !== 'string') {
        throw new CodexAppServerFailure('before-turn');
      }
      cursor = typeof result.nextCursor === 'string' && result.nextCursor.length > 0 ? result.nextCursor : undefined;
    } while (cursor);
    return names;
  }

  private threadIdFrom(value: unknown): string {
    if (!isRecord(value) || !isRecord(value.thread) || typeof value.thread.id !== 'string' || !value.thread.id) {
      throw new CodexAppServerFailure('before-turn');
    }
    return value.thread.id;
  }

  private turnIdFrom(value: unknown): string {
    if (!isRecord(value) || !isRecord(value.turn) || typeof value.turn.id !== 'string' || !value.turn.id) {
      throw new CodexAppServerFailure('after-turn');
    }
    return value.turn.id;
  }

  private request(session: Session, method: string, params: JsonRecord): Promise<unknown> {
    if (session.disposed) return Promise.reject(new CodexAppServerFailure(session.stage));
    const id = session.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      session.pending.set(id, { resolve, reject });
      try {
        session.child.write(JSON.stringify({ id, method, params }));
      } catch {
        const failure = new CodexAppServerFailure(session.stage);
        session.pending.delete(id);
        this.invalidate(session, failure);
        reject(failure);
      }
    });
  }

  private notify(session: Session, method: string): void {
    if (session.disposed) throw new CodexAppServerFailure(session.stage);
    try {
      session.child.write(JSON.stringify({ method }));
    } catch {
      const failure = new CodexAppServerFailure(session.stage);
      this.invalidate(session, failure);
      throw failure;
    }
  }

  private onStdout(session: Session, chunk: string): void {
    if (session.disposed) return;
    session.buffer += chunk;
    if (session.buffer.length > MAX_JSONL_BUFFER) {
      this.invalidate(session, new CodexAppServerFailure(session.stage));
      return;
    }
    let newline = session.buffer.indexOf('\n');
    while (newline >= 0 && !session.disposed) {
      const line = session.buffer.slice(0, newline).trim();
      session.buffer = session.buffer.slice(newline + 1);
      if (line) {
        let message: unknown;
        try {
          message = JSON.parse(line);
        } catch {
          this.invalidate(session, new CodexAppServerFailure(session.stage));
          return;
        }
        this.onMessage(session, message);
      }
      newline = session.buffer.indexOf('\n');
    }
  }

  private onMessage(session: Session, message: unknown): void {
    if (!isRecord(message)) {
      this.invalidate(session, new CodexAppServerFailure(session.stage));
      return;
    }
    if ((typeof message.id === 'number' || typeof message.id === 'string') && message.method === undefined) {
      const numericId = typeof message.id === 'number' ? message.id : Number(message.id);
      const pending = Number.isSafeInteger(numericId) ? session.pending.get(numericId) : undefined;
      if (!pending) {
        this.invalidate(session, new CodexAppServerFailure(session.stage));
        return;
      }
      session.pending.delete(numericId);
      if (message.error !== undefined && message.error !== null) {
        const failure = new CodexAppServerFailure(session.stage);
        pending.reject(failure);
        this.invalidate(session, failure);
        return;
      }
      pending.resolve(message.result);
      return;
    }
    if (typeof message.method !== 'string' || message.id !== undefined) {
      this.invalidate(session, new CodexAppServerFailure(session.stage));
      return;
    }
    this.onNotification(session, message.method, message.params);
  }

  private onNotification(session: Session, method: string, params: unknown): void {
    if (method === 'remoteControl/status/changed' && session.stage === 'before-turn') {
      if (!isRecord(params)
        || typeof params.installationId !== 'string'
        || typeof params.serverName !== 'string'
        || !['disabled', 'connecting', 'connected', 'errored'].includes(String(params.status))
        || (params.environmentId !== undefined && params.environmentId !== null && typeof params.environmentId !== 'string')) {
        this.invalidate(session, new CodexAppServerFailure('before-turn'));
      }
      return;
    }
    if (method === 'thread/started' && session.stage === 'before-turn') {
      if (!isRecord(params) || !isRecord(params.thread) || typeof params.thread.id !== 'string') {
        this.invalidate(session, new CodexAppServerFailure('before-turn'));
      }
      return;
    }
    const active = session.activeTurn;
    if (!active || !isRecord(params)) {
      this.invalidate(session, new CodexAppServerFailure(session.stage));
      return;
    }
    if (params.threadId !== active.threadId) {
      this.invalidate(session, new CodexAppServerFailure('after-turn'));
      return;
    }
    if (method === 'turn/started') {
      if (!isRecord(params.turn) || typeof params.turn.id !== 'string' || !this.acceptTurnId(active, params.turn.id)) {
        this.invalidate(session, new CodexAppServerFailure('after-turn'));
      }
      return;
    }
    if (method === 'item/started') {
      if (typeof params.turnId !== 'string'
        || !this.acceptTurnId(active, params.turnId)
        || !Number.isSafeInteger(params.startedAtMs)
        || !isRecord(params.item)
        || !this.acceptStartedItem(active, params.item)) {
        this.invalidate(session, new CodexAppServerFailure('after-turn'));
      }
      return;
    }
    if (method === 'item/agentMessage/delta' || method === 'item/mcpToolCall/progress') {
      const expectedType = method === 'item/agentMessage/delta' ? 'agentMessage' : 'mcpToolCall';
      const content = method === 'item/agentMessage/delta' ? params.delta : params.message;
      if (!this.acceptStreamingItem(active, params, expectedType) || typeof content !== 'string') {
        this.invalidate(session, new CodexAppServerFailure('after-turn'));
      }
      return;
    }
    if (method === 'item/reasoning/summaryTextDelta'
      || method === 'item/reasoning/summaryPartAdded'
      || method === 'item/reasoning/textDelta') {
      const validIndex = method === 'item/reasoning/textDelta'
        ? Number.isSafeInteger(params.contentIndex)
        : Number.isSafeInteger(params.summaryIndex);
      const validDelta = method === 'item/reasoning/summaryPartAdded' || typeof params.delta === 'string';
      if (!this.acceptStreamingItem(active, params, 'reasoning') || !validIndex || !validDelta) {
        this.invalidate(session, new CodexAppServerFailure('after-turn'));
      }
      return;
    }
    if (method === 'item/completed') {
      if (typeof params.turnId !== 'string' || !this.acceptTurnId(active, params.turnId) || !isRecord(params.item)) {
        this.invalidate(session, new CodexAppServerFailure('after-turn'));
        return;
      }
      this.acceptCompletedItem(session, active, params.item);
      return;
    }
    if (method === 'turn/completed') {
      if (!isRecord(params.turn)
        || typeof params.turn.id !== 'string'
        || !this.acceptTurnId(active, params.turn.id)
        || params.turn.status !== 'completed'
        || (params.turn.error !== undefined && params.turn.error !== null)
        || !active.text) {
        this.invalidate(session, new CodexAppServerFailure('after-turn'));
        return;
      }
      session.activeTurn = null;
      active.resolve({ text: active.text, transcript: active.transcript });
      return;
    }
    this.invalidate(session, new CodexAppServerFailure('after-turn'));
  }

  private acceptTurnId(active: ActiveTurn, turnId: string): boolean {
    if (!turnId) return false;
    if (active.turnId === null) {
      active.turnId = turnId;
      return true;
    }
    return active.turnId === turnId;
  }

  private acceptStartedItem(active: ActiveTurn, item: JsonRecord): boolean {
    if (typeof item.id !== 'string' || !item.id || active.items.has(item.id)) return false;
    if (item.type === 'agentMessage') {
      if (typeof item.text !== 'string') return false;
      active.items.set(item.id, { type: 'agentMessage', completed: false });
      return true;
    }
    if (item.type === 'userMessage') {
      if (!this.isSubmittedUserMessage(active, item)) return false;
      active.items.set(item.id, { type: 'userMessage', completed: false });
      return true;
    }
    if (item.type === 'mcpToolCall') {
      if (item.server !== 'centralmcp'
        || typeof item.tool !== 'string'
        || !active.allowedTools.has(item.tool)
        || !Object.hasOwn(item, 'arguments')
        || !['inProgress', 'completed', 'failed'].includes(String(item.status))) return false;
      active.items.set(item.id, { type: 'mcpToolCall', completed: false });
      return true;
    }
    if (item.type === 'reasoning') {
      const validStrings = (value: unknown) => value === undefined
        || (Array.isArray(value) && value.every((entry) => typeof entry === 'string'));
      if (!validStrings(item.content) || !validStrings(item.summary)) return false;
      active.items.set(item.id, { type: 'reasoning', completed: false });
      return true;
    }
    return false;
  }

  private acceptStreamingItem(
    active: ActiveTurn,
    params: JsonRecord,
    expectedType: 'agentMessage' | 'mcpToolCall' | 'reasoning',
  ): boolean {
    if (typeof params.turnId !== 'string'
      || !this.acceptTurnId(active, params.turnId)
      || typeof params.itemId !== 'string'
      || !params.itemId) return false;
    const item = active.items.get(params.itemId);
    return item?.type === expectedType && !item.completed;
  }

  private acceptCompletedItem(session: Session, active: ActiveTurn, item: JsonRecord): void {
    if (typeof item.id !== 'string' || !item.id) {
      this.invalidate(session, new CodexAppServerFailure('after-turn'));
      return;
    }
    const started = active.items.get(item.id);
    if (started?.completed || (started && started.type !== item.type)) {
      this.invalidate(session, new CodexAppServerFailure('after-turn'));
      return;
    }
    if (item.type === 'agentMessage') {
      if (typeof item.text !== 'string' || containsSensitiveToken(item.text, active.sensitiveToken)) {
        this.invalidate(session, new CodexAppServerFailure('after-turn'));
        return;
      }
      const text = item.text.trim();
      if (text) active.text = text;
      active.items.set(item.id, { type: 'agentMessage', completed: true });
      return;
    }
    if (item.type === 'userMessage') {
      if (!this.isSubmittedUserMessage(active, item)) {
        this.invalidate(session, new CodexAppServerFailure('after-turn'));
        return;
      }
      active.items.set(item.id, { type: 'userMessage', completed: true });
      return;
    }
    if (item.type === 'mcpToolCall') {
      if (item.server !== 'centralmcp'
        || typeof item.tool !== 'string'
        || !active.allowedTools.has(item.tool)
        || !Object.hasOwn(item, 'arguments')
        || containsSensitiveToken(item.arguments, active.sensitiveToken)
        || containsSensitiveToken(item.result, active.sensitiveToken)
        || containsSensitiveToken(item.error, active.sensitiveToken)
        || !['completed', 'failed'].includes(String(item.status))) {
        this.invalidate(session, new CodexAppServerFailure('after-turn'));
        return;
      }
      active.transcript.push({
        tool: item.tool,
        args: compactJson(item.arguments, TRANSCRIPT_ARGS_CAP),
        resultPreview: resultPreview(item.result),
        ok: item.status === 'completed' && (item.error === undefined || item.error === null),
      });
      active.items.set(item.id, { type: 'mcpToolCall', completed: true });
      return;
    }
    if (item.type === 'reasoning') {
      const validStrings = (value: unknown) => value === undefined
        || (Array.isArray(value) && value.every((entry) => typeof entry === 'string'));
      if (!validStrings(item.content) || !validStrings(item.summary)) {
        this.invalidate(session, new CodexAppServerFailure('after-turn'));
        return;
      }
      active.items.set(item.id, { type: 'reasoning', completed: true });
      return;
    }
    this.invalidate(session, new CodexAppServerFailure('after-turn'));
  }

  private isSubmittedUserMessage(active: ActiveTurn, item: JsonRecord): boolean {
    if (!Array.isArray(item.content)
      || item.content.length !== 1
      || !isRecord(item.content[0])
      || item.content[0].type !== 'text'
      || item.content[0].text !== active.prompt
      || (item.clientId !== undefined && item.clientId !== null && typeof item.clientId !== 'string')) return false;
    const textElements = item.content[0].text_elements;
    return textElements === undefined || (Array.isArray(textElements) && textElements.length === 0);
  }

  private invalidate(session: Session, failure: CodexAppServerFailure): void {
    if (session.disposed) return;
    session.disposed = true;
    if (this.session === session) this.session = null;
    for (const pending of session.pending.values()) pending.reject(failure);
    session.pending.clear();
    session.activeTurn?.reject(failure);
    session.activeTurn = null;
    session.child.kill();
    void session.context.dispose().catch(() => undefined);
  }

  private async disposeSession(): Promise<void> {
    const session = this.session;
    if (!session) return;
    this.session = null;
    if (!session.disposed) {
      session.disposed = true;
      const failure = new CodexAppServerFailure(session.stage);
      for (const pending of session.pending.values()) pending.reject(failure);
      session.pending.clear();
      session.activeTurn?.reject(failure);
      session.activeTurn = null;
      session.child.kill();
      await session.context.dispose().catch(() => undefined);
    }
  }
}
