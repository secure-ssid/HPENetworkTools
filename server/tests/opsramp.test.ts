import { describe, expect, it } from 'vitest';
import { OpsRampAdapter, type FetchLike } from '../src/planes/opsramp';
import type { PlaneState } from '../src/planes/types';

const state = (): PlaneState => ({
  id: 'opsramp', linked: true, health: 'warning', lastSync: null,
  deviceCount: null, callsToday: 0, note: '', callBudget: null, token: null,
  consecutiveFailures: 0, nextAttemptAt: null,
});

describe('OpsRamp authenticated connection probe', () => {
  it('mints OAuth and proves tenant access with one Resources page', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push({ url: String(url), init });
      if (String(url).endsWith('/auth/oauth/token')) {
        return new Response(JSON.stringify({ access_token: 'ops-token', expires_in: 3600 }), { status: 200 });
      }
      return new Response(JSON.stringify({ results: [], totalResults: 0 }), { status: 200 });
    };
    const adapter = new OpsRampAdapter(
      { baseUrl: 'https://ops.example', tenantId: 'tenant-1', clientId: 'client-1', clientSecret: 'ops-secret' },
      state(), () => undefined, fetchImpl,
    );

    await expect(adapter.validateConnection()).resolves.toMatchObject({
      ok: true, authenticated: true, dataset: 'devices',
    });
    expect(calls.map((call) => call.url)).toEqual([
      'https://ops.example/auth/oauth/token',
      'https://ops.example/api/v2/tenants/tenant-1/resources?pageSize=1&pageNo=1',
    ]);
    expect(new Headers(calls[1].init?.headers).get('authorization')).toBe('Bearer ops-token');
  });

  it('reports tenant Resources scope denial without echoing credentials', async () => {
    const fetchImpl: FetchLike = async (url) => String(url).endsWith('/auth/oauth/token')
      ? new Response(JSON.stringify({ access_token: 'ops-token' }), { status: 200 })
      : new Response('{}', { status: 403 });
    const adapter = new OpsRampAdapter(
      { baseUrl: 'https://ops.example', tenantId: 'tenant-1', clientId: 'client-1', clientSecret: 'ops-secret' },
      state(), () => undefined, fetchImpl,
    );
    const result = await adapter.validateConnection();
    expect(result).toMatchObject({ ok: false, authenticated: true, status: 403 });
    expect(JSON.stringify(result)).not.toContain('ops-secret');
  });
});
