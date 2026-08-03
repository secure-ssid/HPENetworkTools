/**
 * web/src/api/mist.test.ts — getMist(): the screen payload getter's three
 * outcomes. An answered envelope passes through untouched; an answered
 * failure is an apiError with an unlinked plane block (never a fabricated
 * healthy plane); an unreachable backend composes the same authored demo
 * world the server's demo branch serves.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { getMist } from './screens';
import { MIST_PLANE_STATUS, MIST_ROGUE_APS, SITE_SLE } from '@hpe/shared';

afterEach(() => {
  vi.unstubAllGlobals();
});

function mockFetch(response: { ok: boolean; status?: number; body?: unknown }) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: response.ok,
      status: response.status ?? (response.ok ? 200 : 500),
      json: vi.fn().mockResolvedValue(response.body ?? {}),
    }),
  );
}

describe('getMist', () => {
  it('passes an answered envelope through', async () => {
    mockFetch({ ok: true, body: { dataSource: 'live', plane: { linked: false }, devices: [] } });
    const data = await getMist();
    expect(data.dataSource).toBe('live');
    expect(data.plane).toEqual({ linked: false });
  });

  it('an answered failure is an apiError, never the fixtures', async () => {
    mockFetch({ ok: false, status: 500, body: { error: 'mist read blew up' } });
    const data = await getMist();
    expect(data.apiError).toContain('mist read blew up');
    expect(data.dataSource).toBe('live');
    expect(data.plane.linked).toBe(false);
    expect(data.plane.health).toBe('unlinked');
    expect(data.devices).toEqual([]);
    expect(data.sleBySiteId).toBeUndefined();
  });

  it('an unreachable backend composes the authored demo world', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('connection refused')));
    const data = await getMist();
    expect(data.dataSource).toBe('demo');
    expect(data.apiError).toBeUndefined();
    expect(data.plane).toEqual(MIST_PLANE_STATUS);
    expect(data.sleBySiteId).toEqual(SITE_SLE);
    expect(data.rogues).toEqual(MIST_ROGUE_APS);
    expect(data.wlans?.map((w) => w.name).sort()).toEqual(['MRDN-IoT', 'MRDN-Research', 'MRDN-Staff']);
    expect(data.devices.map((d) => d.name).sort()).toEqual(['ap-3f-12', 'ap-3f-14', 'ap-ng-02', 'sw-cam02-1']);
    expect(data.licenseUsages).toHaveLength(3);
  });
});
