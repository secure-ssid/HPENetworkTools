import { describe, expect, it } from 'vitest';
import { EdgeConnectAdapter, type FetchLike } from '../src/planes/edgeconnect';
import type { PlaneState } from '../src/planes/types';

const state = (): PlaneState => ({
  id: 'edgeconnect', linked: true, health: 'warning', lastSync: null,
  deviceCount: null, callsToday: 0, note: '', callBudget: null, token: null,
  consecutiveFailures: 0, nextAttemptAt: null,
});

describe('EdgeConnect authenticated connection probe', () => {
  it('proves the API key with the bounded Appliances read', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const adapter = new EdgeConnectAdapter(
      'edgeconnect', state(), { baseUrl: 'https://orchestrator.example', apiKey: 'edge-secret' },
      () => undefined, fetchImpl,
    );

    await expect(adapter.validateConnection()).resolves.toMatchObject({
      ok: true, authenticated: true, dataset: 'devices',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://orchestrator.example/gms/rest/v1.0/appliances');
    expect(new Headers(calls[0].init?.headers).get('x-auth-token')).toBe('edge-secret');
  });

  it('reports an Appliances privilege gap separately from rejected credentials', async () => {
    const fetchImpl: FetchLike = async () => new Response('{}', { status: 403 });
    const adapter = new EdgeConnectAdapter(
      'edgeconnect', state(), { baseUrl: 'https://orchestrator.example', apiKey: 'edge-secret' },
      () => undefined, fetchImpl,
    );
    await expect(adapter.validateConnection()).resolves.toMatchObject({
      ok: false, authenticated: true, status: 403,
    });
  });
});
