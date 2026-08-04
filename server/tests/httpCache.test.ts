import { describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { maybeNotModified, pageSlice, parseLimitCursor, weakEtag } from '../src/lib/httpCache';

function mockRes() {
  const headers: Record<string, string> = {};
  const res = {
    headers,
    statusCode: 200,
    setHeader(k: string, v: string) {
      headers[k] = v;
    },
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    end: vi.fn(),
  };
  return res as unknown as Response & {
    headers: Record<string, string>;
    statusCode: number;
    end: ReturnType<typeof vi.fn>;
  };
}

describe('httpCache', () => {
  it('builds stable weak etags', () => {
    expect(weakEtag({ a: 1 })).toBe(weakEtag({ a: 1 }));
    expect(weakEtag({ a: 1 })).not.toBe(weakEtag({ a: 2 }));
    expect(weakEtag({ a: 1 }).startsWith('W/"')).toBe(true);
  });

  it('returns 304 when If-None-Match matches', () => {
    const etag = weakEtag({ x: 1 });
    const res = mockRes();
    const req = { headers: { 'if-none-match': etag } } as unknown as Request;
    expect(maybeNotModified(req, res, etag)).toBe(true);
    expect(res.statusCode).toBe(304);
    expect(res.end).toHaveBeenCalled();
    expect(res.headers.ETag).toBe(etag);
  });

  it('does not short-circuit on miss', () => {
    const etag = weakEtag({ x: 1 });
    const res = mockRes();
    const req = { headers: { 'if-none-match': 'W/"other"' } } as unknown as Request;
    expect(maybeNotModified(req, res, etag)).toBe(false);
    expect(res.end).not.toHaveBeenCalled();
  });

  it('parses limit/cursor and pages', () => {
    const ok = parseLimitCursor({ query: { limit: '2', cursor: '1' } } as unknown as Request);
    expect(ok).toEqual({ limit: 2, cursor: 1 });
    expect(pageSlice(['a', 'b', 'c', 'd'], 1, 2)).toEqual({
      items: ['b', 'c'],
      nextCursor: '3',
      total: 4,
    });
  });

  it('rejects bad limit', () => {
    expect(parseLimitCursor({ query: { limit: '0' } } as unknown as Request)).toEqual({
      error: 'limit must be a positive integer',
    });
  });
});
