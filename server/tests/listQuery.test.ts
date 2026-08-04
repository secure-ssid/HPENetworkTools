import { describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import {
  applyListFilters,
  applyListPaging,
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

  it('sendCachedJson writes json when etag misses', () => {
    const json = vi.fn();
    const res = {
      setHeader: vi.fn(),
      status: vi.fn().mockReturnThis(),
      end: vi.fn(),
      json,
    } as unknown as Response;
    sendCachedJson(req({}, {}), res, { ok: true });
    expect(json).toHaveBeenCalledWith({ ok: true });
  });
});
