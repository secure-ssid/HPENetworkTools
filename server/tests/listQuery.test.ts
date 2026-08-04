import { describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import {
  applyListFilters,
  applyListPaging,
  etagPayload,
  sendCachedJson,
} from '../src/routes/screens/listQuery';

function req(query: Record<string, string | undefined> = {}, headers: Record<string, string> = {}): Request {
  return { query, headers } as unknown as Request;
}

type Named = { name: string; plane?: string; siteName?: string; claimedBy?: string[] };

describe('listQuery helpers', () => {
  it('applyListFilters narrows by q and plane without inventing rows', () => {
    const body = {
      devices: [
        { name: 'sw-a', plane: 'CENTRAL', siteName: 'HQ' },
        { name: 'ap-b', plane: 'MIST', siteName: 'HQ' },
        { name: 'sw-c', plane: 'CENTRAL', claimedBy: ['central', 'local'], siteName: 'DC' },
      ] satisfies Named[],
    };
    const qOnly = applyListFilters(req({ q: 'sw' }), body, 'devices', ['name', 'siteName']);
    const qNames = (qOnly.devices as Named[]).map((d) => d.name);
    expect(qNames).toEqual(['sw-a', 'sw-c']);

    const planeOnly = applyListFilters(req({ plane: 'mist' }), body, 'devices', ['name']);
    expect((planeOnly.devices as Named[]).map((d) => d.name)).toEqual(['ap-b']);

    const claimed = applyListFilters(req({ plane: 'local' }), body, 'devices', ['name']);
    expect((claimed.devices as Named[]).map((d) => d.name)).toEqual(['sw-c']);
  });

  it('applyListFilters treats non-string q/plane as honest no-ops (Loop 122 queryString)', () => {
    const body = {
      devices: [
        { name: 'sw-a', plane: 'CENTRAL' },
        { name: 'ap-b', plane: 'MIST' },
      ] satisfies Named[],
    };
    // Arrays / numbers must not coerce into filter tokens (shared queryString).
    const arrayQ = applyListFilters(
      { query: { q: ['sw'] } } as unknown as Request,
      body,
      'devices',
      ['name'],
    );
    expect((arrayQ.devices as Named[]).map((d) => d.name)).toEqual(['sw-a', 'ap-b']);

    const numPlane = applyListFilters(
      { query: { plane: 12 } } as unknown as Request,
      body,
      'devices',
      ['name'],
    );
    expect((numPlane.devices as Named[]).map((d) => d.name)).toEqual(['sw-a', 'ap-b']);

    const trimmed = applyListFilters(req({ q: '  ap  ' }), body, 'devices', ['name']);
    expect((trimmed.devices as Named[]).map((d) => d.name)).toEqual(['ap-b']);
  });

  it('applyListPaging leaves full list when limit omitted', () => {
    const body = { items: [1, 2, 3, 4, 5] };
    const out = applyListPaging(req({}), body, 'items');
    expect(out).toEqual({ body });
  });

  it('applyListPaging slices and attaches page meta', () => {
    const body = { items: ['a', 'b', 'c', 'd', 'e'] };
    const out = applyListPaging(req({ limit: '2', cursor: '0' }), body, 'items');
    expect('error' in out).toBe(false);
    if ('error' in out) return;
    expect(out.body.items).toEqual(['a', 'b']);
    expect(out.body.page).toMatchObject({ total: 5, limit: 2, cursor: 0 });
    expect((out.body.page as { nextCursor: string | null }).nextCursor).toBe('2');
  });

  it('etagPayload drops syncedAt so wall-clock stamps do not bust cache', () => {
    const a = etagPayload({ devices: [1], syncedAt: '2026-01-01T00:00:00.000Z' });
    const b = etagPayload({ devices: [1], syncedAt: '2026-01-02T00:00:00.000Z' });
    expect(a).toEqual({ devices: [1] });
    expect(a).toEqual(b);
    expect(etagPayload({ ok: true })).toEqual({ ok: true });
  });

  it('sendCachedJson writes json when etag misses', () => {
    const json = vi.fn();
    const setHeader = vi.fn();
    const res = {
      setHeader,
      status: vi.fn().mockReturnThis(),
      end: vi.fn(),
      json,
    } as unknown as Response;
    sendCachedJson(req({}, {}), res, { ok: true });
    expect(json).toHaveBeenCalledWith({ ok: true });
    expect(setHeader).toHaveBeenCalledWith('ETag', expect.stringMatching(/^W\//));
    expect(setHeader).toHaveBeenCalledWith('Cache-Control', 'private, no-cache');
  });

  it('sendCachedJson returns 304 when If-None-Match matches (ignoring syncedAt drift)', () => {
    const json = vi.fn();
    const end = vi.fn();
    const status = vi.fn().mockReturnThis();
    const headers: Record<string, string> = {};
    const res = {
      setHeader: (k: string, v: string) => {
        headers[k] = v;
      },
      status,
      end,
      json,
    } as unknown as Response;
    const body = { ok: true, n: 1, syncedAt: '2026-01-01T00:00:00.000Z' };
    sendCachedJson(req({}, {}), res, body);
    const etag = headers.ETag;
    expect(etag).toMatch(/^W\//);
    expect(json).toHaveBeenCalledTimes(1);

    sendCachedJson(
      req({}, { 'if-none-match': etag }),
      res,
      { ok: true, n: 1, syncedAt: '2026-01-02T00:00:00.000Z' },
    );
    expect(status).toHaveBeenCalledWith(304);
    expect(end).toHaveBeenCalled();
    expect(json).toHaveBeenCalledTimes(1);
  });
});
