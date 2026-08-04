/**
 * web/src/api/clearpass.test.ts — the ClearPass reviewed-write client.
 *
 * The four mutation functions are the whole surface: exact URL + method,
 * `{form, reviewConfirmed}` as the exact request body, the server's own
 * {error} message surfaced on non-OK, and `offline` on an unreachable
 * backend. The local-user tests pin the write-only password rule: it rides
 * the request body and is never read out of a response.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  registerClearPassEndpoint,
  updateClearPassEndpoint,
  createClearPassLocalUser,
  updateClearPassLocalUser,
  getClearPassEndpointPage,
} from './clearpass';
import { isApiError } from './core';

afterEach(() => {
  vi.unstubAllGlobals();
});

function mockFetchCapture(response: { ok: boolean; status?: number; body?: unknown }) {
  const fn = vi.fn().mockResolvedValue({
    ok: response.ok,
    status: response.status ?? (response.ok ? 200 : 500),
    json: vi.fn().mockResolvedValue(response.body ?? {}),
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

describe('clearpass reviewed-write client', () => {
  it('registerClearPassEndpoint POSTs {form, reviewConfirmed} to the collection', async () => {
    const fetchMock = mockFetchCapture({
      ok: true,
      body: { ok: true, action: 'created', verified: true, httpCode: 201, message: 'registered' },
    });
    const form = { mac: 'aa:bb:cc:dd:ee:ff', status: 'Known' as const, description: 'pump' };
    const r = await registerClearPassEndpoint(form, true);
    expect(isApiError(r)).toBe(false);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/clearpass/endpoints');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ form, reviewConfirmed: true });
  });

  it('updateClearPassEndpoint PUTs to the one endpoint, id encoded', async () => {
    const fetchMock = mockFetchCapture({ ok: true, body: { ok: true, action: 'updated' } });
    const r = await updateClearPassEndpoint('ep 001', { status: 'Disabled' }, true);
    expect(isApiError(r)).toBe(false);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/clearpass/endpoints/ep%20001');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body as string)).toEqual({ form: { status: 'Disabled' }, reviewConfirmed: true });
  });

  it('createClearPassLocalUser sends the password in the body and nowhere else', async () => {
    const fetchMock = mockFetchCapture({ ok: true, body: { ok: true, action: 'created', message: 'created' } });
    const form = { userId: 'noc-op', roleName: 'IT admin', enabled: true, password: 'write-only-canary' };
    const r = await createClearPassLocalUser(form, true);
    expect(isApiError(r)).toBe(false);
    const [, init] = fetchMock.mock.calls[0];
    expect(init.method).toBe('POST');
    // Sent — the one place it belongs…
    expect(JSON.parse(init.body as string).form.password).toBe('write-only-canary');
    // …and the function adds nothing of its own around it.
    expect(Object.keys(JSON.parse(init.body as string))).toEqual(['form', 'reviewConfirmed']);
    expect(JSON.stringify(r)).not.toContain('write-only-canary');
  });

  it('updateClearPassLocalUser PUTs an id-encoded partial update', async () => {
    const fetchMock = mockFetchCapture({ ok: true, body: { ok: true, action: 'updated' } });
    const r = await updateClearPassLocalUser('lu-001', { enabled: false }, true);
    expect(isApiError(r)).toBe(false);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/clearpass/local-users/lu-001');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body as string)).toEqual({ form: { enabled: false }, reviewConfirmed: true });
  });

  it('surfaces the server’s own {error} message on a refused request', async () => {
    mockFetchCapture({ ok: false, status: 400, body: { error: 'direct ClearPass writes require an explicit review confirmation' } });
    const r = await registerClearPassEndpoint({ mac: 'aa:bb:cc:dd:ee:ff' }, false);
    expect(isApiError(r)).toBe(true);
    if (isApiError(r)) {
      expect(r.error).toBe('direct ClearPass writes require an explicit review confirmation');
      expect(r.offline).toBeUndefined();
    }
  });

  it('marks an unreachable backend offline rather than dressing it up as a plane answer', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('connection refused')));
    const r = await createClearPassLocalUser({ userId: 'x', roleName: 'y', enabled: true, password: 'z' }, true);
    expect(isApiError(r)).toBe(true);
    if (isApiError(r)) {
      expect(r.offline).toBe(true);
      expect(r.error).toContain('cannot reach the portal backend');
    }
  });
});

describe('ClearPass endpoint-page client', () => {
  it('requests exactly the selected bounded page and preserves the server’s explicit state', async () => {
    const fetchMock = mockFetchCapture({
      ok: true,
      body: {
        dataSource: 'live', state: 'failed', endpoints: [], offset: 50, limit: 25,
        total: null, nextOffset: null, more: 'unknown',
      },
    });

    await expect(getClearPassEndpointPage(50, 25)).resolves.toEqual({
      dataSource: 'live', state: 'failed', endpoints: [], offset: 50, limit: 25,
      total: null, nextOffset: null, more: 'unknown',
    });
    expect(fetchMock.mock.calls[0][0]).toBe('/api/clearpass/endpoints?offset=50&limit=25');
  });

  it('passes q/status/category on the endpoint page request (Loop 86)', async () => {
    const fetchMock = mockFetchCapture({
      ok: true,
      body: {
        dataSource: 'demo',
        state: 'ok',
        endpoints: [],
        offset: 0,
        limit: 50,
        total: 0,
        nextOffset: null,
        more: 'no',
      },
    });
    await getClearPassEndpointPage(0, 50, { q: 'aa:bb', status: 'Known', category: 'Computer' });
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain('offset=0');
    expect(url).toContain('limit=50');
    expect(url).toContain('q=aa%3Abb');
    expect(url).toContain('status=Known');
    expect(url).toContain('category=Computer');
  });

  it('reports an unreachable or malformed page as failed rather than substituting demo endpoints', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('connection refused')));

    await expect(getClearPassEndpointPage(0, 50)).resolves.toEqual({
      dataSource: 'live', state: 'failed', endpoints: [], offset: 0, limit: 50,
      total: null, nextOffset: null, more: 'unknown',
    });
  });
});
