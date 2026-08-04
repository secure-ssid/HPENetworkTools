/**
 * Shared list paging / filter / ETag helpers for screen envelopes.
 */

import type { Request, Response } from 'express';
import {
  maybeNotModified,
  pageSlice,
  parseLimitCursor,
  weakEtag,
} from '../../lib/httpCache';

/**
 * Optional list paging: when `?limit=` is present, slice `body[listKey]` and
 * attach a `page` envelope. Omitted limit keeps the full list (backward
 * compatible with every existing screen).
 */
export function applyListPaging(
  req: Request,
  body: Record<string, unknown>,
  listKey: string,
): { body: Record<string, unknown> } | { error: string } {
  if (req.query.limit === undefined || req.query.limit === '') return { body };
  const parsed = parseLimitCursor(req, { defaultLimit: 100, maxLimit: 500 });
  if ('error' in parsed) return parsed;
  const list = body[listKey];
  if (!Array.isArray(list)) return { body };
  const page = pageSlice(list as unknown[], parsed.cursor, parsed.limit);
  return {
    body: {
      ...body,
      [listKey]: page.items,
      page: {
        total: page.total,
        limit: parsed.limit,
        cursor: parsed.cursor,
        nextCursor: page.nextCursor,
      },
    },
  };
}

export function sendCachedJson(req: Request, res: Response, body: Record<string, unknown>): void {
  if (maybeNotModified(req, res, weakEtag(body))) return;
  res.json(body);
}

/** Optional list filters for inventory endpoints: ?q= and ?plane=. */
export function applyListFilters(
  req: Request,
  body: Record<string, unknown>,
  listKey: string,
  fields: string[],
): Record<string, unknown> {
  const list = body[listKey];
  if (!Array.isArray(list)) return body;
  const q = typeof req.query.q === 'string' ? req.query.q.trim().toLowerCase() : '';
  const plane =
    typeof req.query.plane === 'string' ? req.query.plane.trim().toLowerCase() : '';
  if (!q && !plane) return body;
  const filtered = (list as Record<string, unknown>[]).filter((row) => {
    if (plane) {
      const p = String(row.plane ?? '').toLowerCase();
      const claimed = Array.isArray(row.claimedBy)
        ? (row.claimedBy as unknown[]).map((x) => String(x).toLowerCase())
        : [];
      if (p !== plane && !claimed.includes(plane)) return false;
    }
    if (q) {
      const hay = fields.map((f) => String(row[f] ?? '')).join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
  return { ...body, [listKey]: filtered };
}
