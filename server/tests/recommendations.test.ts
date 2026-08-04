import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let createApp: typeof import('../src/index').createApp;

let tmpDir: string;
let server: Server;
let base: string;

beforeAll(async () => {
  const testRoot = resolve(process.cwd(), '.agent-tmp');
  mkdirSync(testRoot, { recursive: true });
  tmpDir = mkdtempSync(join(testRoot, 'recs-'));
  process.env.HPE_SETTINGS_PATH = join(tmpDir, 'settings.json');
  process.env.HPE_DATA_DIR = join(tmpDir, 'data');
  writeFileSync(
    process.env.HPE_SETTINGS_PATH,
    JSON.stringify({ demoMode: true, blendLive: false }),
  );
  ({ createApp } = await import('../src/index'));
  server = createApp().listen(0, '127.0.0.1');
  await new Promise<void>((resolveListen) => server.once('listening', resolveListen));
  const { port } = server.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolveClose, reject) =>
    server.close((err) => (err ? reject(err) : resolveClose())),
  );
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.HPE_SETTINGS_PATH;
  delete process.env.HPE_DATA_DIR;
});

describe('recommendations API', () => {
  it('returns read-only recommendations for the demo estate', async () => {
    const res = await fetch(`${base}/api/recommendations?limit=50`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      recommendations: Array<{ id: string; ruleId: string }>;
      readOnly: boolean;
      counts: { total: number };
    };
    expect(body.readOnly).toBe(true);
    expect(body.counts.total).toBeGreaterThan(0);
    expect(body.recommendations.length).toBeGreaterThan(0);
  });

  it('filters by device name', async () => {
    const res = await fetch(`${base}/api/recommendations?device=ap-3f-14`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { recommendations: Array<{ device?: string }> };
    expect(body.recommendations.every((r) => r.device === 'ap-3f-14')).toBe(true);
  });

  it('returns taxonomy summary buckets', async () => {
    const res = await fetch(`${base}/api/taxonomy/summary`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      devices: { total: number; byType: Array<{ key: string; count: number }> };
      clients: { total: number; byType: Array<{ key: string; count: number }> };
    };
    expect(body.devices.total).toBeGreaterThan(0);
    expect(body.devices.byType.some((b) => b.key === 'switch' || b.key === 'ap')).toBe(true);
    expect(body.clients.total).toBeGreaterThan(0);
  });
});
