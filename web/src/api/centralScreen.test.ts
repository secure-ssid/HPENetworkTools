/**
 * web/src/api/centralScreen.test.ts — getCentral()'s three outcomes.
 *
 * The screen endpoint contract (api/core.ts fetchScreen): an answered
 * payload passes through verbatim; an answered HTTP ERROR is an explicit
 * live failure (apiError set, fixtures never substituted); only an
 * UNREACHABLE backend falls back to the same shared demo composition the
 * server's demo branch serves.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { getCentral } from './screens';
import { demoCentralSections } from '@hpe/shared';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function mockFetch(impl: () => Promise<Partial<Response>> | Partial<Response>) {
  vi.stubGlobal('fetch', vi.fn().mockImplementation(impl));
}

describe('getCentral', () => {
  it('passes an answered payload through untouched', async () => {
    const payload = {
      ...demoCentralSections(),
      dataSource: 'live',
      syncedAt: '2026-08-01T10:00:00.000Z',
      notReported: [],
    };
    mockFetch(() => ({ ok: true, status: 200, json: () => Promise.resolve(payload) }));
    const data = await getCentral();
    expect(data).toEqual(payload);
  });

  it('turns an answered HTTP error into an explicit failure, never fixtures', async () => {
    mockFetch(() => ({
      ok: false,
      status: 500,
      json: () => Promise.resolve({ error: 'boom' }),
      text: () => Promise.resolve('boom'),
    }));
    const data = await getCentral();
    expect(data.apiError).toBeTruthy();
    expect(data.dataSource).toBe('live');
    // The failure shape is empty, honestly — not a demo estate wearing a 500.
    expect(data.fleet.total).toBe(0);
    expect(data.sites).toEqual([]);
    expect(data.plane.linked).toBe(false);
  });

  it('falls back to the shared demo composition only when the backend is unreachable', async () => {
    mockFetch(() => Promise.reject(new TypeError('fetch failed')));
    const data = await getCentral();
    expect(data.dataSource).toBe('demo');
    expect(data.apiError).toBeUndefined();
    // Exactly what the server's demo branch serves (shared/central.ts).
    expect(data.plane).toEqual(demoCentralSections().plane);
    expect(data.fleet).toEqual(demoCentralSections().fleet);
    expect(data.sites).toEqual(demoCentralSections().sites);
    expect(data.wlans.map((w) => w.name)).toEqual(demoCentralSections().wlans.map((w) => w.name));
    expect(data.alerts).toEqual(demoCentralSections().alerts);
  });
});
