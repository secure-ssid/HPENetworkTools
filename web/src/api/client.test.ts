import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getDeviceDetail,
  getDevices,
  getChatStatus,
  getOverview,
  getTerminalSession,
  getTerminalSessions,
  syncSystems,
} from './client';

afterEach(() => {
  vi.unstubAllGlobals();
});

function mockFetch(response: {
  ok: boolean;
  status?: number;
  body?: unknown;
}) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: response.ok,
      status: response.status ?? (response.ok ? 200 : 500),
      json: vi.fn().mockResolvedValue(response.body ?? {}),
    }),
  );
}

describe('screen API source handling', () => {
  it('preserves the server dataSource instead of relabeling demo responses as live', async () => {
    mockFetch({
      ok: true,
      body: {
        dataSource: 'demo',
        syncedAt: '2026-07-26T09:41:00.000Z',
        stats: [],
        alerts: [],
        sites: [],
        planes: [],
        changes: [],
        launchpad: [],
      },
    });

    const data = await getOverview();
    expect(data.dataSource).toBe('demo');
  });

  it('returns an explicit live API error instead of fixture devices for an HTTP failure', async () => {
    mockFetch({ ok: false, status: 500, body: { error: 'poller unavailable' } });

    const data = await getDevices();
    expect(data.dataSource).toBe('live');
    expect(data.devices).toEqual([]);
    expect(data.apiError).toBe('poller unavailable');
  });

  it('uses fixtures only when no backend answers', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('connection refused')));

    const data = await getDevices();
    expect(data.dataSource).toBe('demo');
    expect(data.devices.length).toBeGreaterThan(0);
    expect(data.apiError).toBeUndefined();
  });

  it('preserves demo source metadata on an answered detail 404', async () => {
    mockFetch({
      ok: false,
      status: 404,
      body: { error: 'unknown device', dataSource: 'demo', syncedAt: '2026-07-26T09:41:00.000Z' },
    });

    const data = await getDeviceDetail('missing-device');
    expect(data.device).toBeNull();
    expect(data.dataSource).toBe('demo');
  });

  it('does not fabricate an unknown device profile when the backend is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('connection refused')));

    const data = await getDeviceDetail('missing-device');
    expect(data).toMatchObject({ device: null, profile: null, config: null, clients: null, dataSource: 'demo' });
  });

  it('treats malformed JSON from a successful screen response as an API error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: vi.fn().mockRejectedValue(new SyntaxError('bad json')),
      }),
    );

    const data = await getDevices();
    expect(data.devices).toEqual([]);
    expect(data.dataSource).toBe('live');
    expect(data.apiError).toMatch(/invalid JSON/);
  });

  it('reports partial manual-sync failures instead of showing a false success', async () => {
    mockFetch({
      ok: true,
      body: { ok: false, started: ['central'], failed: ['central'] },
    });

    const result = await syncSystems();
    expect(result.ok).toBe(false);
    expect(result.message).toContain('failed to synchronize');
  });

  it('surfaces answered terminal storage failures instead of showing an empty list', async () => {
    mockFetch({ ok: false, status: 500, body: { error: 'internal error' } });
    await expect(getTerminalSessions('sw-core-a')).rejects.toThrow('internal error');
  });

  it('returns null only for a genuinely missing terminal transcript', async () => {
    mockFetch({ ok: false, status: 404, body: { error: 'unknown session recording' } });
    await expect(getTerminalSession('missing.jsonl')).resolves.toBeNull();
  });

  it('distinguishes an answered optional API failure from an unreachable backend', async () => {
    mockFetch({ ok: false, status: 500, body: { error: 'status probe failed' } });
    await expect(getChatStatus()).rejects.toThrow('status probe failed');

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('connection refused')));
    await expect(getChatStatus()).resolves.toBeNull();
  });
});
