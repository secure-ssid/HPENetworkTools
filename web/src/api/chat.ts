/** Assistant chat: status, settings and message posting. */

import { apiFetch, fromApi, serverMessage } from './core';
import { SystemMutationResult } from './systems';

// ---------------------------------------------------------------------------
// Chat (assistant) — /api/chat/* and the mcp/llm slice of /api/settings
//
// The chatbot is the app's only MCP consumer: the server proxies an
// OpenAI-compatible LLM tool loop onto the user's centralmcp server. There is
// no fixture fallback — unconfigured or unreachable backends are surfaced
// honestly (null status, or the server's {error} message verbatim).
// ---------------------------------------------------------------------------

export interface ChatStatus {
  configured: { mcp: boolean; llm: boolean };
  writeMode: AssistantChatWriteMode;
  mcpUrl?: string;
  mcpReachable: boolean;
  activeProvider?: AssistantProviderId;
  providers?: Array<AssistantProviderStatus & { id: AssistantProviderId }>;
}

export type AssistantChatWriteMode = 'read-only' | 'confirm' | 'enabled';

export const ASSISTANT_PROVIDER_IDS = ['codex', 'claude', 'kimi', 'copilot', 'ollama', 'openrouter'] as const;
export type AssistantProviderId = typeof ASSISTANT_PROVIDER_IDS[number];

export interface AssistantProviderStatus {
  installed: boolean;
  authenticated: boolean;
  mcpReady: boolean;
  modelReady: boolean;
  selected: boolean;
  resolvedModel: string | null;
  latencyMs: number | null;
  /** Server supplied and redacted: never substitute a browser-side diagnosis. */
  message: string;
}

type NativeProvider = { enabled: boolean; model: string; reasoningEffort: 'low' | 'medium' | 'high' };
type KimiProvider = { enabled: boolean; model: string; thinking: boolean };
type CopilotProvider = { enabled: boolean; model: string; effort: 'adaptive' | 'low' | 'medium' | 'high' };
type CompatibleProvider = { enabled: boolean; baseUrl: string; model: string; apiKey?: string };

export interface AssistantSettings {
  activeProvider: AssistantProviderId;
  mcp: { enabled: boolean; endpoint: string; authToken: string | null };
  chatWriteMode: AssistantChatWriteMode;
  providers: {
    codex: NativeProvider;
    claude: NativeProvider;
    kimi: KimiProvider;
    copilot: CopilotProvider;
    ollama: CompatibleProvider;
    openrouter: CompatibleProvider;
  };
}

/** Live chat status; null when the backend is absent. */
export async function getChatStatus(): Promise<ChatStatus | null> {
  return fromApi<ChatStatus>('/api/chat/status');
}

export interface ChatTranscriptEntry {
  tool: string;
  args: string;
  resultPreview: string;
  ok: boolean;
}

export interface ChatRequestMessage {
  role: 'user' | 'assistant';
  content: string;
}

export type ChatResult =
  | { ok: true; reply: string; transcript: ChatTranscriptEntry[] }
  | { ok: false; error: string };

/** POST /api/chat — surfaces the server's message verbatim on failure. */
export async function postChat(
  messages: ChatRequestMessage[],
  allowWrite: boolean,
): Promise<ChatResult> {
  // The server-side LLM tool loop can legitimately take minutes, but never
  // forever — cancel at 120s so the composer can't pend indefinitely.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120_000);
  try {
    const r = await apiFetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages, allowWrite }),
      signal: controller.signal,
    });
    if (r.ok) {
      const body = (await r.json()) as { reply: string; transcript: ChatTranscriptEntry[] };
      return { ok: true, reply: body.reply, transcript: body.transcript ?? [] };
    }
    return { ok: false, error: await serverMessage(r, `chat failed — HTTP ${r.status}`) };
  } catch (err) {
    if (controller.signal.aborted) {
      return { ok: false, error: 'no answer within two minutes — the request was cancelled' };
    }
    return { ok: false, error: `cannot reach the portal backend: ${(err as Error).message}` };
  } finally {
    clearTimeout(timer);
  }
}

/** The canonical server settings envelope; secrets are always masked or null. */
export interface ChatSettings {
  assistant: AssistantSettings;
}

/** GET /api/settings, narrowed to the chat keys; null when backend absent. */
export async function getChatSettings(): Promise<ChatSettings | null> {
  return fromApi<ChatSettings>('/api/settings');
}

/**
 * PUT /api/settings with a chat partial. The store deep-merges mcp/llm, and
 * masked '••••••…' secrets written back unchanged are ignored, so a round
 * trip of the masked view keeps the stored secrets.
 */
export async function saveChatSettings(patch: { assistant: Partial<AssistantSettings> }): Promise<SystemMutationResult> {
  try {
    const r = await apiFetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    if (r.ok) return { ok: true, message: 'assistant settings saved' };
    return { ok: false, message: await serverMessage(r, `save failed — HTTP ${r.status}`) };
  } catch (err) {
    return { ok: false, message: `cannot reach the portal backend: ${(err as Error).message}` };
  }
}

/** Runs the server-owned, read-only readiness probe for one provider. */
export async function testChatProvider(id: AssistantProviderId): Promise<AssistantProviderStatus> {
  const r = await apiFetch(`/api/chat/providers/${id}/test`, { method: 'POST' });
  if (!r.ok) throw new Error(await serverMessage(r, `provider test failed — HTTP ${r.status}`));
  return r.json() as Promise<AssistantProviderStatus>;
}
