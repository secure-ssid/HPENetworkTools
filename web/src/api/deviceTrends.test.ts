/**
 * web/src/api/deviceTrends.test.ts — the per-device trend getters.
 *
 * The reads are on-demand (one per open device page, per window) and keep the
 * three outcomes distinct: a payload renders, 'not-reported' is the portal's
 * straight answer (honest null, a 404, or a block with no provenance), and
 * 'failed' means the read itself broke. An unreachable backend mirrors the
 * server's demo branch: the authored fixture for the one device the demo
 * world has one for, 'not-reported' for every other.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getDeviceApTrends,
  getDeviceHardwareTrends,
  getDeviceInterfaceTrends,
} from './client';
import { SWITCH_HARDWARE_TRENDS_DEMO, AP_TRENDS_DEMO } from '@hpe/shared';

afterEach(() => {
  vi.unstubAllGlobals();
});

function mockFetch(response: { ok: boolean; status?: number; body?: unknown }) {
  const fn = vi.fn().mockResolvedValue({
    ok: response.ok,
    status: response.status ?? (response.ok ? 200 : 500),
    json: vi.fn().mockResolvedValue(response.body ?? {}),
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

function mockFetchReject() {
  const fn = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
  vi.stubGlobal('fetch', fn);
  return fn;
}

const WINDOW = { start: '2026-07-27T12:00:00.000Z', end: '2026-07-28T12:00:00.000Z' };
const HW = SWITCH_HARDWARE_TRENDS_DEMO['sw-core-a']!;

describe('getDeviceHardwareTrends', () => {
  it('unwraps the route envelope, and requests the exact device+window+identity', async () => {
    const fetchMock = mockFetch({
      ok: true,
      body: { dataSource: 'live', hardwareTrends: HW },
    });
    const result = await getDeviceHardwareTrends('sw-core-a', WINDOW, { plane: 'CENTRAL', serial: 'CS1' });
    expect(result).toEqual({ kind: 'ok', live: HW });

    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toContain('/api/devices/sw-core-a/trends/hardware?');
    expect(url).toContain('start=2026-07-27T12%3A00%3A00.000Z');
    expect(url).toContain('end=2026-07-28T12%3A00%3A00.000Z');
    expect(url).toContain('plane=CENTRAL');
    expect(url).toContain('serial=CS1');
  });

  it("the route's honest null is 'not-reported', and so is a block with no provenance", async () => {
    mockFetch({ ok: true, body: { dataSource: 'live', hardwareTrends: null } });
    expect(await getDeviceHardwareTrends('sw-core-a', WINDOW)).toEqual({ kind: 'not-reported' });

    mockFetch({ ok: true, body: { dataSource: 'live', hardwareTrends: { serial: 'CS1' } } });
    expect(await getDeviceHardwareTrends('sw-core-a', WINDOW)).toEqual({ kind: 'not-reported' });
  });

  it('a 404 is not-reported; any other answered failure is a failed read with the server message', async () => {
    mockFetch({ ok: false, status: 404, body: { error: "unknown device 'ghost-1'" } });
    expect(await getDeviceHardwareTrends('ghost-1', WINDOW)).toEqual({ kind: 'not-reported' });

    mockFetch({ ok: false, status: 502, body: { error: 'central read broke' } });
    expect(await getDeviceHardwareTrends('sw-core-a', WINDOW)).toEqual({
      kind: 'failed',
      message: 'central read broke',
    });
  });

  it('an unreachable backend mirrors the demo branch — fixture by name, never a fabricated read', async () => {
    mockFetchReject();
    const result = await getDeviceHardwareTrends('sw-core-a', WINDOW);
    expect(result).toEqual({ kind: 'ok', live: HW });

    mockFetchReject();
    expect(await getDeviceHardwareTrends('sw-core-b', WINDOW)).toEqual({ kind: 'not-reported' });
  });
});

describe('getDeviceInterfaceTrends', () => {
  it('hits the interfaces path and mirrors the demo fallback', async () => {
    const fetchMock = mockFetch({ ok: true, body: { dataSource: 'live', interfaceTrends: null } });
    expect(await getDeviceInterfaceTrends('sw-core-a', WINDOW)).toEqual({ kind: 'not-reported' });
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/api/devices/sw-core-a/trends/interfaces?');

    mockFetchReject();
    const result = await getDeviceInterfaceTrends('sw-core-a', WINDOW);
    expect(result.kind).toBe('ok');
  });
});

describe('getDeviceApTrends', () => {
  it('hits the per-metric path and keys the demo fallback by name+metric', async () => {
    const fetchMock = mockFetch({
      ok: true,
      body: { dataSource: 'demo', apTrends: AP_TRENDS_DEMO['ap-1f-04|throughput'] },
    });
    const result = await getDeviceApTrends('ap-1f-04', 'throughput', WINDOW);
    expect(result.kind).toBe('ok');
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/api/devices/ap-1f-04/trends/ap/throughput?');

    mockFetchReject();
    expect(await getDeviceApTrends('ap-1f-04', 'throughput', WINDOW)).toEqual({
      kind: 'ok',
      live: AP_TRENDS_DEMO['ap-1f-04|throughput'],
    });
    mockFetchReject();
    expect(await getDeviceApTrends('ap-3f-08', 'cpu', WINDOW)).toEqual({ kind: 'not-reported' });
  });
});
