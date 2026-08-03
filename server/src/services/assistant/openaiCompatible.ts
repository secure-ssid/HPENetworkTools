import type { AssistantProviderConfig, AssistantProviderId } from '../../config/settings';
import type {
  AssistantChatRequest,
  AssistantChatResult,
  AssistantChatToolCall,
  AssistantChatToolOutcome,
  AssistantProviderAdapter,
  ProviderDiscovery,
  ReadOnlyProbeContext,
  ReadOnlyProbeResult,
} from './types';

export type ProviderTimeoutKind = 'interactive' | 'generation' | 'startup';

/** Short UI requests must fail promptly; model loading and generation get one bounded retry window. */
export function resolveProviderTimeoutMs(kind: ProviderTimeoutKind): number {
  return kind === 'interactive' ? 15_000 : 90_000;
}

export interface OpenAICompatibleConfig {
  baseUrl: string;
  model: string;
  apiKey?: string;
  timeoutMs: number;
}

export class AssistantProviderTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`assistant provider timed out after ${timeoutMs}ms`);
    this.name = 'AssistantProviderTimeoutError';
  }
}

class AssistantProviderHttpError extends Error {}

export type OpenAICompatibleToolCall = AssistantChatToolCall;

export interface OpenAICompatibleMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: OpenAICompatibleToolCall[];
  tool_call_id?: string;
}

export interface OpenAICompatibleToolOutcome<TTranscript> {
  toolMessage: OpenAICompatibleMessage;
  transcript: TTranscript;
}

export interface OpenAICompatibleChatInput<TTranscript> {
  config: OpenAICompatibleConfig;
  messages: OpenAICompatibleMessage[];
  tools: unknown[];
  executeTool(call: OpenAICompatibleToolCall): Promise<OpenAICompatibleToolOutcome<TTranscript>>;
  signal?: AbortSignal;
}

export interface OpenAICompatibleChatResult<TTranscript> {
  reply: string;
  transcript: TTranscript[];
}

const MAX_ITERATIONS = 6;

async function complete(
  config: OpenAICompatibleConfig,
  messages: OpenAICompatibleMessage[],
  tools: unknown[],
  signal?: AbortSignal,
): Promise<OpenAICompatibleMessage> {
  const url = `${config.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const payload: Record<string, unknown> = { model: config.model, messages, tool_choice: 'auto' };
  if (tools.length > 0) payload.tools = tools;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (config.apiKey) headers.authorization = `Bearer ${config.apiKey}`;

  const controller = new AbortController();
  const abortFromCaller = () => controller.abort();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener('abort', abortFromCaller, { once: true });
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload), signal: controller.signal });
    if (!response.ok) throw new AssistantProviderHttpError(`assistant provider HTTP ${response.status}`);
    // The same signal guards both the headers and streamed response body.
    const body = await response.json() as { choices?: Array<{ message?: OpenAICompatibleMessage }> };
    const message = body.choices?.[0]?.message;
    if (!message) throw new Error('assistant provider answered without choices[0].message');
    return message;
  } catch (err) {
    if (signal?.aborted) throw new Error('request cancelled');
    if (err instanceof AssistantProviderTimeoutError) throw err;
    if (err instanceof AssistantProviderHttpError) throw err;
    if (controller.signal.aborted) throw new AssistantProviderTimeoutError(config.timeoutMs);
    throw new Error(`assistant provider request failed: ${(err as Error).message}`);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abortFromCaller);
  }
}

/** Shared OpenAI Chat Completions loop for Ollama and OpenRouter. No global settings are read here. */
export class OpenAICompatibleAdapter implements AssistantProviderAdapter {
  constructor(readonly id: Extract<AssistantProviderId, 'ollama' | 'openrouter'>) {}

  async discover(config: AssistantProviderConfig): Promise<ProviderDiscovery> {
    if (!this.matchesConfig(config)) return { installed: false, authenticated: false, modelReady: false };
    return { installed: config.enabled, authenticated: config.enabled, modelReady: config.enabled, resolvedModel: config.model };
  }

  async probeReadOnly(_config: AssistantProviderConfig, _context: ReadOnlyProbeContext): Promise<ReadOnlyProbeResult> {
    return { authenticated: false, modelReady: false };
  }

  async chat(request: AssistantChatRequest): Promise<AssistantChatResult> {
    const config = this.configFor(request.config, request.timeoutMs);
    const result = await this.run({
      config,
      messages: request.messages.map((message) => ({ role: message.role, content: message.content })),
      tools: [...(request.tools ?? [])],
      executeTool: async (call) => {
        if (!request.executeTool) throw new Error('No tool executor was supplied.');
        const outcome: AssistantChatToolOutcome = await request.executeTool(call);
        return outcome;
      },
      signal: request.signal,
    });
    return { text: result.reply, transcript: result.transcript };
  }

  private matchesConfig(config: AssistantProviderConfig): config is Extract<AssistantProviderConfig, { baseUrl: string }> {
    return (this.id === 'ollama' || this.id === 'openrouter') && 'baseUrl' in config && 'model' in config;
  }

  private configFor(config: AssistantProviderConfig, timeoutMs: number): OpenAICompatibleConfig {
    if (!this.matchesConfig(config)) throw new Error('Selected provider does not use the OpenAI-compatible protocol.');
    return { baseUrl: config.baseUrl, model: config.model, apiKey: config.apiKey, timeoutMs };
  }

  async run<TTranscript>(input: OpenAICompatibleChatInput<TTranscript>): Promise<OpenAICompatibleChatResult<TTranscript>> {
    const conversation = [...input.messages];
    const transcript: TTranscript[] = [];
    for (let index = 0; index < MAX_ITERATIONS; index += 1) {
      const message = await complete(input.config, conversation, input.tools, input.signal);
      const calls = (message.tool_calls ?? []).filter((call) => typeof call.function?.name === 'string');
      if (calls.length === 0) {
        const reply = (message.content ?? '').trim();
        if (reply) return { reply, transcript };
        conversation.push({ role: 'assistant', content: '' });
        conversation.push({ role: 'user', content: 'Empty reply. Answer the question directly, or call a tool.' });
        continue;
      }
      // OpenAI permits null here, but Ollama requires a string when tool calls are replayed.
      conversation.push({ role: 'assistant', content: message.content ?? '', tool_calls: calls });
      for (const call of calls) {
        const outcome = await input.executeTool(call);
        transcript.push(outcome.transcript);
        conversation.push(outcome.toolMessage);
      }
    }
    conversation.push({ role: 'user', content: 'Tool-call limit reached. Summarize what you established and what is still unknown — no further tool calls.' });
    const final = await complete(input.config, conversation, [], input.signal);
    return { reply: (final.content ?? '').trim() || 'The assistant reached its tool-call limit without a conclusion.', transcript };
  }
}
