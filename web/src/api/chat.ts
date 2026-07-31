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
  writeMode: boolean;
  mcpUrl?: string;
  mcpReachable: boolean;
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

/** The assistant slice of the server settings (masked secrets, never raw). */
export interface ChatSettings {
  mcp: { url: string; bearerToken: string | null } | null;
  llm: { baseUrl: string; apiKey: string; model: string } | null;
  chatWriteMode: boolean;
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
export async function saveChatSettings(patch: Partial<ChatSettings>): Promise<SystemMutationResult> {
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
