/**
 * server/src/routes/sse.ts — HPE Aruba Networking SSE object management.
 *
 *   GET    /api/sse/inventory              cached SseInventory (poller cache)
 *   GET    /api/sse/objects/:kind          one kind's rows, optional ?q= search
 *   GET    /api/sse/objects/:kind/:id      on-demand fresh detail read
 *   POST   /api/sse/objects/:kind          create {fields, reviewConfirmed}
 *   PUT    /api/sse/objects/:kind/:id      update {fields, reviewConfirmed}
 *   DELETE /api/sse/objects/:kind/:id      delete {reviewConfirmed}
 *   POST   /api/sse/commit/retry           commit-only retry {reviewConfirmed} — never replays a mutation
 *   POST   /api/sse/recovery/manual-cleanup cleanup-only {reviewConfirmed, manualReconciled}
 *
 * Every `:kind` is checked against the shared SSE_OBJECT_KINDS allowlist
 * before it ever reaches an adapter method: there is no route here that
 * accepts an arbitrary path or forwards a caller-supplied URL to the SSE
 * Admin API. Mutations additionally require capabilities().directWrite (the
 * token's declared write scope) AND an explicit `reviewConfirmed: true` — the
 * review gate server/src/services/ssidDirectWrite.ts uses for Central's
 * direct SSID writes, standing in for a ticket reference this plane has none
 * of. A successful mutation always attempts the mandatory (tenant-wide)
 * commit and reports the two outcomes separately, plus whether the cached
 * inventory actually got refreshed (server/src/services/sseObjects.ts).
 *
 * Every mutation and recovery operation is serialized in-process by
 * SseObjectsService. A durable journal blocks further mutations until its
 * phase-specific reviewed recovery succeeds: only `commit-rejected` may call
 * Commit; ambiguous phases require a separate manual-reconciliation
 * attestation and cleanup-only route. Every "a durable SSE journal already
 * blocks this" 409 carries a stable machine-readable `code` (e.g.
 * `SSE_PENDING_MUTATION`) alongside its secret-free message — callers must
 * key off `code`, never message text. A denied/unreachable single-object read
 * is reported as a distinct non-2xx (502), never collapsed into a 404 — only
 * a real "object not found" answers 404.
 */

import { Router, type Response } from 'express';
import { h } from './handler';
import {
  SSE_OBJECT_KINDS,
  type SseInventory,
  type SseKindReadStatus,
  type SseObjectKind,
} from '@hpe/shared';
import { SseObjectsError, sseObjects, sseObjectsErrorBody } from '../services/sseObjects';

export const sseRouter = Router();

function asKind(value: string): SseObjectKind | null {
  return (SSE_OBJECT_KINDS as readonly string[]).includes(value) ? (value as SseObjectKind) : null;
}

function completeReadStatus(inventory: SseInventory): SseInventory {
  const readStatus: NonNullable<SseInventory['readStatus']> = { ...inventory.readStatus };
  for (const kind of SSE_OBJECT_KINDS) {
    if (readStatus[kind]) continue;
    if (inventory.kinds[kind] && !inventory.unavailable.includes(kind)) {
      readStatus[kind] = { state: 'ok' };
    } else {
      readStatus[kind] = {
        state: 'failed',
        reason: 'not-synced',
        httpCode: null,
        message: 'This SSE kind has not been read yet; run a sync to obtain its current status.',
      };
    }
  }
  return { ...inventory, readStatus };
}

function kindReadStatus(inventory: SseInventory, kind: SseObjectKind): SseKindReadStatus {
  return completeReadStatus(inventory).readStatus![kind]!;
}

/** SseObjectsError carries its own HTTP status; anything else is a real bug
 *  and goes to the shared error middleware (index.ts) rather than being
 *  swallowed as a 500 with no server-side trace. */
function reportOrThrow(err: unknown, res: Response): void {
  if (err instanceof SseObjectsError) {
    if (err.status >= 500) console.error(`error: ${err.message}`);
    res.status(err.status).json(sseObjectsErrorBody(err));
    return;
  }
  throw err;
}

sseRouter.get(
  '/sse/inventory',
  h(async (_req, res) => {
    try {
      res.json(completeReadStatus(sseObjects.inventory()));
    } catch (err) {
      reportOrThrow(err, res);
    }
  }),
);

sseRouter.get(
  '/sse/objects/:kind',
  h(async (req, res) => {
    const kind = asKind(req.params.kind);
    if (!kind) {
      res.status(404).json({ error: `unknown SSE object kind '${req.params.kind}'` });
      return;
    }
    try {
      const q = typeof req.query.q === 'string' ? req.query.q : undefined;
      const inventory = sseObjects.inventory();
      res.json({ ...sseObjects.listKind(kind, q), readStatus: kindReadStatus(inventory, kind) });
    } catch (err) {
      reportOrThrow(err, res);
    }
  }),
);

sseRouter.get(
  '/sse/objects/:kind/:id',
  h(async (req, res) => {
    const kind = asKind(req.params.kind);
    if (!kind) {
      res.status(404).json({ error: `unknown SSE object kind '${req.params.kind}'` });
      return;
    }
    try {
      res.json(await sseObjects.getObject(kind, req.params.id));
    } catch (err) {
      reportOrThrow(err, res);
    }
  }),
);

sseRouter.post(
  '/sse/objects/:kind',
  h(async (req, res) => {
    const kind = asKind(req.params.kind);
    if (!kind) {
      res.status(404).json({ error: `unknown SSE object kind '${req.params.kind}'` });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    try {
      res.json(await sseObjects.create(kind, body.fields, body.reviewConfirmed));
    } catch (err) {
      reportOrThrow(err, res);
    }
  }),
);

sseRouter.put(
  '/sse/objects/:kind/:id',
  h(async (req, res) => {
    const kind = asKind(req.params.kind);
    if (!kind) {
      res.status(404).json({ error: `unknown SSE object kind '${req.params.kind}'` });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    try {
      res.json(await sseObjects.update(kind, req.params.id, body.fields, body.reviewConfirmed));
    } catch (err) {
      reportOrThrow(err, res);
    }
  }),
);

sseRouter.delete(
  '/sse/objects/:kind/:id',
  h(async (req, res) => {
    const kind = asKind(req.params.kind);
    if (!kind) {
      res.status(404).json({ error: `unknown SSE object kind '${req.params.kind}'` });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    try {
      res.json(await sseObjects.remove(kind, req.params.id, body.reviewConfirmed));
    } catch (err) {
      reportOrThrow(err, res);
    }
  }),
);

sseRouter.post(
  '/sse/commit/retry',
  h(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    try {
      res.json(await sseObjects.retryCommit(body.reviewConfirmed));
    } catch (err) {
      reportOrThrow(err, res);
    }
  }),
);

sseRouter.post(
  '/sse/recovery/manual-cleanup',
  h(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    try {
      res.json(
        await sseObjects.cleanupManuallyReconciled(
          body.reviewConfirmed,
          body.manualReconciled,
        ),
      );
    } catch (err) {
      reportOrThrow(err, res);
    }
  }),
);
