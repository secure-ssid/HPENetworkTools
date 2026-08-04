/**
 * server/src/lib/httpCache.ts — weak ETag helpers for JSON list endpoints.
 *
 * Operators still get fresh data on every intentional refresh (Cache-Control
 * private, no-cache). Conditional GET with If-None-Match only skips the body
 * when the payload bytes are unchanged — never a license to serve stale
 * inventory across authentic changes.
 */

import { createHash } from 'node:crypto';
import type { Request, Response } from 'express';

/** Stable weak ETag from a JSON-serializable value. */
export function weakEtag(value: unknown): string {
  const json = typeof value === 'string' ? value : JSON.stringify(value);
  const hash = createHash('sha1').update(json).digest('base64url');
  return `W/"${hash}"`;
}

/**
 * If the client already holds this ETag, send 304 and return true.
 * Otherwise set ETag on the response and return false (caller sends body).
 */
export function maybeNotModified(req: Request, res: Response, etag: string): boolean {
  res.setHeader('ETag', etag);
  res.setHeader('Cache-Control', 'private, no-cache');
  const inm = req.headers['if-none-match'];
  if (typeof inm === 'string' && inm.split(/,\s*/).includes(etag)) {
    res.status(304).end();
    return true;
  }
  return false;
}

/** Shared cursor/limit parsing for list endpoints. */
export function parseLimitCursor(
  req: Request,
  defaults: { defaultLimit: number; maxLimit: number } = { defaultLimit: 100, maxLimit: 500 },
): { limit: number; cursor: number } | { error: string } {
  let limit = defaults.defaultLimit;
  if (req.query.limit !== undefined && req.query.limit !== '') {
    if (typeof req.query.limit !== 'string') return { error: 'limit must be a number' };
    const n = Number(req.query.limit);
    if (!Number.isInteger(n) || n < 1) return { error: 'limit must be a positive integer' };
    limit = Math.min(n, defaults.maxLimit);
  }
  let cursor = 0;
  if (req.query.cursor !== undefined && req.query.cursor !== '') {
    if (typeof req.query.cursor !== 'string') return { error: 'cursor must be a number' };
    const n = Number(req.query.cursor);
    if (!Number.isInteger(n) || n < 0) return { error: 'cursor must be a non-negative integer' };
    cursor = n;
  }
  return { limit, cursor };
}

export function pageSlice<T>(
  rows: readonly T[],
  cursor: number,
  limit: number,
): { items: T[]; nextCursor: string | null; total: number } {
  const items = rows.slice(cursor, cursor + limit);
  const next = cursor + items.length;
  return {
    items,
    nextCursor: next < rows.length ? String(next) : null,
    total: rows.length,
  };
}
