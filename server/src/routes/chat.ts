/**
 * server/src/routes/chat.ts — the assistant API (the app's only MCP consumer).
 *
 *   GET  /api/chat/status  settings-based configuration state + a live MCP
 *                          reachability probe (lazy initialize, 3s timeout,
 *                          failure tolerated). The bearer token is never
 *                          returned — mcpUrl only.
 *   POST /api/chat         { messages: [{role, content}], allowWrite? } →
 *                          { reply, transcript }. 400 when MCP/LLM are not
 *                          configured (the message points at Connected
 *                          systems → Assistant); 504 for a bounded provider
 *                          timeout and 502 {error} for other MCP/LLM failures.
 */

import { Router } from 'express';
import { h } from './handler';
import { ASSISTANT_PROVIDER_IDS, settings, type AssistantProviderId } from '../config/settings';
import { assistantProviderRegistry, chatLoop, chatMcpClient, type ChatMessage } from '../services/mcpChat';
import { AssistantProviderTimeoutError } from '../services/assistant/openaiCompatible';
import type { AssistantProviderRegistry } from '../services/assistant/registry';
import type { ProviderStatus } from '../services/assistant/types';

type ChatRouterDependencies = {
  providerRegistry?: Pick<AssistantProviderRegistry, 'status'>;
  chat?: typeof chatLoop;
};

function providerIsReady(status: ProviderStatus): boolean {
  return status.installed && status.authenticated && status.mcpReady && status.modelReady;
}

function isProviderId(value: unknown): value is AssistantProviderId {
  return typeof value === 'string' && (ASSISTANT_PROVIDER_IDS as readonly string[]).includes(value);
}

function providerConflict(id: AssistantProviderId, status: ProviderStatus): string {
  if (!status.installed || !status.authenticated || !status.modelReady || !status.mcpReady) {
    return `assistant provider '${id}' is unavailable. Test provider in Connected systems → Assistant, then try again.`;
  }
  return `assistant provider '${id}' is unavailable.`;
}

const MAX_MESSAGES = 40;
const MAX_CONTENT = 8000;

export function classifyChatFailure(err: unknown): { status: number; error: string; logMessage: string } {
  if (err instanceof AssistantProviderTimeoutError) {
    return {
      status: 504,
      error: 'assistant provider timed out — try again shortly',
      logMessage: err.message,
    };
  }
  return {
    status: 502,
    error: 'assistant request failed upstream — check the MCP/LLM configuration',
    // Provider and MCP errors may contain echoed credentials or target URLs.
    logMessage: 'assistant upstream request failed',
  };
}

/** Injectable only at the route boundary; production uses the shared provider registry. */
export function createChatRouter(dependencies: ChatRouterDependencies = {}): Router {
  const router = Router();
  const providerRegistry = dependencies.providerRegistry ?? assistantProviderRegistry;
  const dispatchChat = dependencies.chat ?? chatLoop;

  router.get(
  '/chat/status',
  h(async (_req, res) => {
    const s = settings.get();
    const assistant = s.assistant;
    const mcpConfigured = assistant.mcp.enabled && Boolean(assistant.mcp.endpoint);
    let mcpReachable = false;
    if (mcpConfigured) {
      try {
        await chatMcpClient({ url: assistant.mcp.endpoint, bearerToken: assistant.mcp.authToken }).probe(3000);
        mcpReachable = true;
      } catch {
        mcpReachable = false;
      }
    }
    const providers = await Promise.all(ASSISTANT_PROVIDER_IDS.map(async (id) => ({
      id,
      ...(await providerRegistry.status(assistant, id)),
    })));
    res.json({
      configured: { mcp: mcpConfigured, llm: Boolean(assistant.providers[assistant.activeProvider].enabled) },
      writeMode: assistant.chatWriteMode,
      mcpUrl: assistant.mcp.endpoint,
      mcpReachable,
      activeProvider: assistant.activeProvider,
      providers,
    });
  }),
);

  router.post(
  '/chat/providers/:providerId/test',
  h(async (req, res) => {
    const id = req.params.providerId;
    if (!isProviderId(id)) {
      res.status(400).json({ error: 'unknown assistant provider' });
      return;
    }
    // status() performs the adapter's isolated probeReadOnly() and returns only
    // its redacted proof-based result. This route never exposes a write tool.
    const status = await providerRegistry.status(settings.get().assistant, id);
    res.json(status);
  }),
);

  router.post(
  '/chat',
  h(async (req, res) => {
    const s = settings.get();
    const body = req.body as { messages?: unknown; allowWrite?: unknown; providerId?: unknown } | undefined;
    const requestedProvider = body?.providerId;
    if (requestedProvider !== undefined && !isProviderId(requestedProvider)) {
      res.status(400).json({ error: 'unknown assistant provider' });
      return;
    }
    const providerId = requestedProvider ?? s.assistant.activeProvider;
    const savedProvider = s.assistant.providers[providerId];
    if (!savedProvider.enabled) {
      res.status(409).json({ error: `assistant provider '${providerId}' is disabled — enable it in Connected systems → Assistant.` });
      return;
    }
    const providerStatus = await providerRegistry.status(s.assistant, providerId);
    if (!providerIsReady(providerStatus)) {
      res.status(409).json({ error: providerConflict(providerId, providerStatus) });
      return;
    }
    const raw = body?.messages;
    if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_MESSAGES) {
      res.status(400).json({ error: `messages must be an array of 1–${MAX_MESSAGES} entries` });
      return;
    }
    const messages: ChatMessage[] = [];
    for (const m of raw as Array<{ role?: unknown; content?: unknown }>) {
      if (
        !m || typeof m !== 'object' ||
        (m.role !== 'user' && m.role !== 'assistant') ||
        typeof m.content !== 'string' ||
        m.content.trim().length === 0 ||
        m.content.length > MAX_CONTENT
      ) {
        res.status(400).json({
          error: `each message must be { role: 'user'|'assistant', content: 1–${MAX_CONTENT} chars }`,
        });
        return;
      }
      messages.push({ role: m.role, content: m.content });
    }

    const controller = new AbortController();
    const cancelOnDisconnect = () => {
      if (!res.writableEnded) controller.abort();
    };
    res.once('close', cancelOnDisconnect);
    try {
      const { reply, transcript } = await dispatchChat(messages, {
        allowWrite: body?.allowWrite === true,
        signal: controller.signal,
        providerId,
      });
      if (controller.signal.aborted) return;
      res.json({ reply, transcript });
    } catch (err) {
      if (controller.signal.aborted) return;
      const failure = classifyChatFailure(err);
      console.error(`chat failed: ${failure.logMessage}`);
      res.status(failure.status).json({ error: failure.error });
    } finally {
      res.off('close', cancelOnDisconnect);
    }
  }),
);
  return router;
}

export const chatRouter = createChatRouter();
