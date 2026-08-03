/**
 * server/src/services/mcpChat.ts — the assistant's two outbound channels.
 *
 * McpClient — minimal MCP "streamable HTTP" client (no SDK) for the user's
 * centralmcp server. JSON-RPC 2.0 over POST with
 * `Accept: application/json, text/event-stream`; the server may answer with a
 * plain JSON body or an SSE stream (`data: {…}\n\n` lines — we take the last
 * data event bearing a result). The `Mcp-Session-Id` response header from
 * `initialize` is captured and echoed on every later request. Session errors
 * (HTTP 400/404 or a JSON-RPC error mentioning the session) trigger one
 * re-initialize + retry. All requests time out (15s default).
 *
 * chatLoop — compatibility façade over the OpenAI-compatible provider adapter.
 * The LLM only ever sees three
 * meta-tools: find_tool and invoke_read_tool always, invoke_tool (write /
 * destructive) ONLY when settings.chatWriteMode is on AND the request opted
 * in via opts.allowWrite. A hallucinated invoke_tool while writes are off is
 * refused as a tool result (ok:false in the transcript), never executed.
 * Results fed back to the LLM are capped (~4000 chars); the transcript keeps
 * ~300-char previews. Transport failures (MCP or LLM) throw — the route maps
 * them to 502 {error}.
 *
 * Neither the MCP bearer token nor the LLM API key is ever logged or included
 * in error messages; both travel only in Authorization headers.
 */

import { settings, type McpSettings } from '../config/settings';
import { AssistantProviderRegistry } from './assistant/registry';
import {
  OpenAICompatibleAdapter,
  resolveProviderTimeoutMs,
  type OpenAICompatibleMessage,
  type OpenAICompatibleToolCall,
} from './assistant/openaiCompatible';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function truncate(text: string, cap: number): string {
  return text.length <= cap ? text : `${text.slice(0, cap)}…`;
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const ctl = new AbortController();
  const externalSignal = init.signal;
  const abortFromCaller = () => ctl.abort();
  if (externalSignal?.aborted) ctl.abort();
  else externalSignal?.addEventListener('abort', abortFromCaller, { once: true });
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctl.signal });
  } catch (err) {
    if (externalSignal?.aborted) throw new Error('request cancelled');
    if (ctl.signal.aborted) throw new Error(`no answer within ${timeoutMs}ms`);
    throw err;
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener('abort', abortFromCaller);
  }
}

// ---------------------------------------------------------------------------
// MCP streamable-HTTP client
// ---------------------------------------------------------------------------

interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

interface JsonRpcResponse {
  jsonrpc?: string;
  id?: number | string | null;
  result?: unknown;
  error?: JsonRpcError;
}

/** Thrown when the server says our session is gone; callTool re-inits once. */
class McpSessionError extends Error {}

/** Parse a response body into JSON-RPC messages: SSE data lines or plain JSON. */
function parseMcpMessages(contentType: string | null, text: string): JsonRpcResponse[] {
  if (contentType?.includes('text/event-stream')) {
    const out: JsonRpcResponse[] = [];
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      try {
        out.push(JSON.parse(data) as JsonRpcResponse);
      } catch {
        /* keep-alive / comment payloads are not JSON — skip */
      }
    }
    return out;
  }
  if (!text.trim()) return [];
  const parsed = JSON.parse(text) as JsonRpcResponse | JsonRpcResponse[];
  return Array.isArray(parsed) ? parsed : [parsed];
}

/** The last message bearing a result or error — the answer to our request. */
function lastResult(messages: JsonRpcResponse[]): JsonRpcResponse | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    if ('result' in messages[i] || 'error' in messages[i]) return messages[i];
  }
  return null;
}

export interface McpToolResult {
  text: string;
  isError: boolean;
}

export class McpClient {
  private sessionId: string | null = null;
  private initPromise: Promise<void> | null = null;
  private nextId = 0;

  constructor(
    private readonly url: string,
    private readonly bearerToken: string | null,
    private readonly timeoutMs: number = 15000,
  ) {}

  isReady(): boolean {
    return this.sessionId !== null;
  }

  /** Lazily initialize; concurrent callers share one handshake. */
  async init(timeoutMs: number = this.timeoutMs, signal?: AbortSignal): Promise<void> {
    if (this.sessionId) return;
    if (signal) return this.initOnce(timeoutMs, signal);
    if (!this.initPromise) {
      this.initPromise = this.initOnce(timeoutMs).finally(() => {
        this.initPromise = null;
      });
    }
    return this.initPromise;
  }

  /** Verify an existing session with a real request; initialize when absent. */
  async probe(timeoutMs: number = this.timeoutMs): Promise<void> {
    if (!this.sessionId) {
      await this.init(timeoutMs);
      return;
    }
    try {
      await this.post(
        { jsonrpc: '2.0', id: ++this.nextId, method: 'tools/list', params: {} },
        true,
        timeoutMs,
      );
    } catch (err) {
      this.sessionId = null;
      throw err;
    }
  }

  /** Call a tool; on a session error, re-initialize once and retry once. */
  async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpToolResult> {
    await this.init(this.timeoutMs, signal);
    try {
      return await this.callToolOnce(name, args, signal);
    } catch (err) {
      if (!(err instanceof McpSessionError)) throw err;
      this.sessionId = null;
      await this.init(this.timeoutMs, signal);
      return this.callToolOnce(name, args, signal);
    }
  }

  // -- internals ---------------------------------------------------------------

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    };
    if (this.bearerToken) h.authorization = `Bearer ${this.bearerToken}`;
    if (this.sessionId) h['mcp-session-id'] = this.sessionId;
    return h;
  }

  private async initOnce(timeoutMs: number, signal?: AbortSignal): Promise<void> {
    await this.post(
      {
        jsonrpc: '2.0',
        id: ++this.nextId,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'hpe-network-tools', version: '0.1.0' },
        },
      },
      true,
      timeoutMs,
      signal,
    );
    await this.post({ jsonrpc: '2.0', method: 'notifications/initialized' }, false, timeoutMs, signal);
  }

  private async callToolOnce(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<McpToolResult> {
    const result = await this.post(
      { jsonrpc: '2.0', id: ++this.nextId, method: 'tools/call', params: { name, arguments: args } },
      true,
      this.timeoutMs,
      signal,
    );
    const content = (result as { content?: unknown }).content;
    let text = '';
    if (Array.isArray(content)) {
      text = content
        .filter((c): c is { type: string; text: string } =>
          c !== null && typeof c === 'object' && (c as { type?: unknown }).type === 'text' &&
          typeof (c as { text?: unknown }).text === 'string')
        .map((c) => c.text)
        .join('\n');
    } else if (typeof content === 'string') {
      text = content;
    }
    const isError = (result as { isError?: unknown }).isError === true;
    return { text, isError };
  }

  /**
   * One POST. Returns the result member of the answering JSON-RPC message
   * (null for notifications). Throws McpSessionError for session failures,
   * Error for everything else.
   */
  private async post(
    message: Record<string, unknown>,
    expectResult: boolean,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<unknown> {
    let res: Response;
    try {
      res = await fetchWithTimeout(
        this.url,
        { method: 'POST', headers: this.headers(), body: JSON.stringify(message), signal },
        timeoutMs,
      );
    } catch (err) {
      throw new Error(`MCP request to ${this.url} failed: ${(err as Error).message}`);
    }

    const session = res.headers.get('mcp-session-id');
    if (session) this.sessionId = session;

    if (!expectResult && res.status === 202) return null;
    const text = await res.text();
    if (!res.ok) {
      if ((res.status === 400 || res.status === 404) && /session/i.test(text)) {
        throw new McpSessionError(`MCP session rejected (HTTP ${res.status})`);
      }
      throw new Error(`MCP HTTP ${res.status} from ${this.url}: ${truncate(text, 200)}`);
    }
    if (!expectResult) return null;

    let rpc: JsonRpcResponse | null;
    try {
      rpc = lastResult(parseMcpMessages(res.headers.get('content-type'), text));
    } catch {
      throw new Error(`MCP response was neither JSON nor SSE: ${truncate(text, 200)}`);
    }
    if (!rpc) throw new Error('MCP response carried no JSON-RPC result');
    if (rpc.error) {
      if (/session/i.test(rpc.error.message)) throw new McpSessionError(rpc.error.message);
      throw new Error(`MCP error ${rpc.error.code}: ${rpc.error.message}`);
    }
    return rpc.result;
  }
}

/** Process-wide client per centralmcp target, rebuilt when settings change. */
let cachedClient: { key: string; client: McpClient } | null = null;

export function chatMcpClient(mcp: McpSettings): McpClient {
  const key = `${mcp.url}\n${mcp.bearerToken ?? ''}`;
  if (!cachedClient || cachedClient.key !== key) {
    cachedClient = { key, client: new McpClient(mcp.url, mcp.bearerToken) };
  }
  return cachedClient.client;
}

// ---------------------------------------------------------------------------
// LLM tool loop (OpenAI-compatible chat completions)
// ---------------------------------------------------------------------------

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ChatTranscriptEntry {
  tool: string;
  args: string;
  resultPreview: string;
  ok: boolean;
}

export interface ChatLoopOptions {
  /** Per-request write opt-in; must be paired with settings.chatWriteMode. */
  allowWrite?: boolean;
  /** Test seam: inject a client instead of the process-wide one. */
  client?: McpClient;
  /** Cancels in-flight LLM and MCP requests when the browser disconnects. */
  signal?: AbortSignal;
}

export interface ChatLoopResult {
  reply: string;
  transcript: ChatTranscriptEntry[];
}

const TOOL_RESULT_CAP = 4000;
const PREVIEW_CAP = 300;
const ARGS_CAP = 200;

const INVOKE_PARAMETERS = {
  type: 'object',
  properties: {
    name: { type: 'string', description: 'Exact backend tool name from find_tool' },
    arguments: { type: 'object', description: 'Arguments matching that tool’s input schema' },
  },
  required: ['name', 'arguments'],
  additionalProperties: false,
} as const;

const TOOL_FIND = {
  type: 'function',
  function: {
    name: 'find_tool',
    description:
      'Search the centralmcp backend tool catalogue. Always call this before invoking a backend tool, to learn its exact name and input schema.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What you want to do, in a few words' },
        platform: { type: 'string', enum: ['central', 'mist', 'clearpass'], description: 'Optional product platform to search' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
};

const TOOL_INVOKE_READ = {
  type: 'function',
  function: {
    name: 'invoke_read_tool',
    description: 'Invoke a read-only centralmcp backend tool by name (from find_tool). No side effects.',
    parameters: INVOKE_PARAMETERS,
  },
};

const TOOL_INVOKE_WRITE = {
  type: 'function',
  function: {
    name: 'invoke_tool',
    description:
      'DESTRUCTIVE — invoke a write/destructive centralmcp backend tool. Only offered because write mode is on; report exactly what changed.',
    parameters: INVOKE_PARAMETERS,
  },
};

function systemPrompt(writeEnabled: boolean): string {
  return [
    'You are the assistant embedded in HPE Network Tools, a multi-plane network operations portal ' +
      '(Aruba Central, Classic, Mist, GreenLake, AOS-8/10 gateways, ClearPass, UXI, local SSH switches).',
    'You reach the user’s centralmcp server through meta-tools: find_tool discovers backend tools, ' +
      'invoke_read_tool runs read-only ones.' +
      (writeEnabled ? ' invoke_tool runs write/destructive ones and is enabled for this session.' : ''),
    'Workflow: call find_tool first to learn exact tool names and schemas; never invent tool names or arguments.',
    writeEnabled
      ? 'Write tools are enabled this session — still prefer read-only tools when they answer the question, and report precisely what any write changed.'
      : 'Read-only mode: write/destructive tools are unavailable. If the task needs one, say it requires write mode ' +
        '(Connected systems → Assistant, plus "allow writes this session" in the chat panel) and stop there.',
    'Be terse and technical: exact hostnames, IPs, VLANs, counts; no filler, no pleasantries.',
  ].join('\n');
}

/** Refusal text when a call must not execute, else null. */
function gateRefusal(name: string, writeEnabled: boolean): string | null {
  if (name === 'find_tool' || name === 'invoke_read_tool') return null;
  if (name === 'invoke_tool') {
    return writeEnabled
      ? null
      : 'refused: invoke_tool runs write/destructive backend tools and write mode is off. ' +
        'Enable "Allow write tools" in Connected systems → Assistant and "allow writes this session" in the chat panel.';
  }
  return `unknown tool '${name}' — available tools: find_tool, invoke_read_tool${writeEnabled ? ', invoke_tool' : ''}.`;
}

/** Map the LLM-facing meta-tool arguments to what centralmcp expects. */
function mcpArgs(name: string, args: Record<string, unknown>): Record<string, unknown> {
  if (name === 'find_tool') {
    const out: Record<string, unknown> = { query: typeof args.query === 'string' ? args.query : JSON.stringify(args) };
    if (args.platform === 'central' || args.platform === 'mist' || args.platform === 'clearpass') out.platform = args.platform;
    return out;
  }
  const inner = args.arguments;
  return {
    name: typeof args.name === 'string' ? args.name : '',
    arguments: inner !== null && typeof inner === 'object' && !Array.isArray(inner) ? inner : {},
  };
}

async function runToolCall(
  client: McpClient,
  call: OpenAICompatibleToolCall,
  writeEnabled: boolean,
  signal?: AbortSignal,
): Promise<{ toolMessage: OpenAICompatibleMessage; transcript: ChatTranscriptEntry }> {
  const name = call.function?.name ?? '';
  let args: Record<string, unknown> = {};
  let argsNote = '';
  const rawArgs = call.function?.arguments;
  if (typeof rawArgs === 'string' && rawArgs.trim()) {
    try {
      const parsed: unknown = JSON.parse(rawArgs);
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        args = parsed as Record<string, unknown>;
      } else {
        argsNote = ' (arguments were not a JSON object)';
      }
    } catch {
      argsNote = ' (arguments were not valid JSON)';
    }
  }
  const argsPreview = truncate(JSON.stringify(args), ARGS_CAP) + argsNote;

  const refusal = gateRefusal(name, writeEnabled);
  if (refusal) {
    return {
      toolMessage: { role: 'tool', tool_call_id: call.id, content: refusal },
      transcript: { tool: name || '(unknown)', args: argsPreview, resultPreview: truncate(refusal, PREVIEW_CAP), ok: false },
    };
  }

  // Transport/protocol failures throw here → the route answers 502.
  const { text, isError } = await client.callTool(name, mcpArgs(name, args), signal);
  const full = text.trim() || '(tool returned no text)';
  return {
    toolMessage: { role: 'tool', tool_call_id: call.id, content: truncate(full, TOOL_RESULT_CAP) },
    transcript: { tool: name, args: argsPreview, resultPreview: truncate(full, PREVIEW_CAP), ok: !isError },
  };
}

export async function chatLoop(messages: ChatMessage[], opts: ChatLoopOptions = {}): Promise<ChatLoopResult> {
  const s = settings.get();
  const assistant = s.assistant;
  const activeProvider = assistant.activeProvider;
  if (activeProvider !== 'ollama' && activeProvider !== 'openrouter') {
    throw new Error('The selected assistant provider is not available for chat yet.');
  }
  const provider = assistant.providers[activeProvider];
  if (!provider.enabled || !provider.baseUrl || !provider.model) {
    if (!s.llm?.baseUrl || !s.llm.model) {
      throw new Error('LLM is not configured — set it in Connected systems → Assistant');
    }
    throw new Error('Selected assistant provider is not configured — set it in Connected systems → Assistant');
  }
  if (!assistant.mcp.enabled || !assistant.mcp.endpoint) {
    throw new Error('MCP server is not configured — set it in Connected systems → Assistant');
  }
  const client = opts.client ?? chatMcpClient({ url: assistant.mcp.endpoint, bearerToken: assistant.mcp.authToken });
  // Read-only boundary: writes need BOTH the global setting and this request's opt-in.
  const writeEnabled = assistant.chatWriteMode === 'enabled' && opts.allowWrite === true;
  const tools: unknown[] = writeEnabled
    ? [TOOL_FIND, TOOL_INVOKE_READ, TOOL_INVOKE_WRITE]
    : [TOOL_FIND, TOOL_INVOKE_READ];
  const conversation: OpenAICompatibleMessage[] = [
    { role: 'system', content: systemPrompt(writeEnabled) },
    ...messages.map((m) => ({ role: m.role, content: m.content })),
  ];
  const adapter = compatibleProviderRegistry.get(activeProvider);
  if (!(adapter instanceof OpenAICompatibleAdapter)) {
    throw new Error('The selected assistant provider is not available for chat yet.');
  }
  return adapter.run({
    config: { baseUrl: provider.baseUrl, model: provider.model, apiKey: provider.apiKey, timeoutMs: resolveProviderTimeoutMs('interactive') },
    messages: conversation,
    tools,
    executeTool: (call) => runToolCall(client, call, writeEnabled, opts.signal),
    signal: opts.signal,
  });
}

/** Registry-backed compatibility boundary; native providers join this registry in later tasks. */
const compatibleProviderRegistry = new AssistantProviderRegistry([
  new OpenAICompatibleAdapter('ollama'),
  new OpenAICompatibleAdapter('openrouter'),
]);
