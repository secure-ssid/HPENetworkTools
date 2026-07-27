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
 *                          systems → Assistant); 502 {error} on any MCP/LLM
 *                          failure.
 */

import { Router, type NextFunction, type Request, type Response } from 'express';
import { settings } from '../config/settings';
import { chatLoop, chatMcpClient, type ChatMessage } from '../services/mcpChat';

export const chatRouter = Router();

/** Wrap async handlers so rejections reach the error middleware (Express 4). */
function h(fn: (req: Request, res: Response, next: NextFunction) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    fn(req, res, next).catch(next);
  };
}

chatRouter.get(
  '/chat/status',
  h(async (_req, res) => {
    const s = settings.get();
    const mcpConfigured = Boolean(s.mcp?.url);
    let mcpReachable = false;
    if (mcpConfigured && s.mcp) {
      try {
        await chatMcpClient(s.mcp).probe(3000);
        mcpReachable = true;
      } catch {
        mcpReachable = false;
      }
    }
    res.json({
      configured: { mcp: mcpConfigured, llm: Boolean(s.llm?.baseUrl && s.llm.model) },
      writeMode: s.chatWriteMode,
      mcpUrl: s.mcp?.url,
      mcpReachable,
    });
  }),
);

const MAX_MESSAGES = 40;
const MAX_CONTENT = 8000;

chatRouter.post(
  '/chat',
  h(async (req, res) => {
    const s = settings.get();
    if (!s.mcp?.url || !s.llm?.baseUrl || !s.llm.model) {
      res.status(400).json({
        error: 'assistant is not configured — set the MCP server and LLM in Connected systems → Assistant',
      });
      return;
    }

    const body = req.body as { messages?: unknown; allowWrite?: unknown } | undefined;
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
      const { reply, transcript } = await chatLoop(messages, {
        allowWrite: body?.allowWrite === true,
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      res.json({ reply, transcript });
    } catch (err) {
      if (controller.signal.aborted) return;
      // MCP/LLM error text embeds the configured URLs — log it, don't forward it.
      console.error(`chat failed: ${(err as Error).message}`);
      res.status(502).json({ error: 'assistant request failed upstream — check the MCP/LLM configuration' });
    } finally {
      res.off('close', cancelOnDisconnect);
    }
  }),
);
