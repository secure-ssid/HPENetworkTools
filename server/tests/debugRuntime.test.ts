/**
 * GET /api/debug/runtime — operator diagnostics without secrets.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let server: Server;
let base: string;
let tmpDir: string;

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'hpe-debug-'));
  process.env.HPE_SETTINGS_PATH = join(tmpDir, 'settings.json');
  process.env.HPE_DATA_DIR = join(tmpDir, 'data');
  const { createApp } = await import('../src/index');
  server = createApp().listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.HPE_SETTINGS_PATH;
  delete process.env.HPE_DATA_DIR;
});

describe('GET /api/debug/runtime', () => {
  it('returns process and plane facts without secrets', async () => {
    const r = await fetch(`${base}/api/debug/runtime`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      ok: boolean;
      process: { node: string; uptimeSec: number; memory: { heapUsed: number } };
      portal: { demoMode: boolean; auth: string };
      planes: Array<{ id: string; linked: boolean }>;
      notifier: { deliveryLogSize: number };
    };
    expect(body.ok).toBe(true);
    expect(body.process.node).toMatch(/^v/);
    expect(typeof body.process.uptimeSec).toBe('number');
    expect(body.process.memory.heapUsed).toBeGreaterThan(0);
    expect(body.portal.auth === 'none' || body.portal.auth === 'oidc').toBe(true);
    expect(Array.isArray(body.planes)).toBe(true);
    expect(body.planes.length).toBeGreaterThan(0);
    expect(typeof body.notifier.deliveryLogSize).toBe('number');
    const raw = JSON.stringify(body);
    expect(raw).not.toMatch(/password|secret|token|apiKey/i);
  });

  it('exports plane facts as CSV without secrets', async () => {
    const r = await fetch(`${base}/api/debug/runtime/export`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type') ?? '').toMatch(/text\/csv/);
    const text = await r.text();
    expect(text.split('\n')[0]).toContain('id,linked,health');
    expect(text).not.toMatch(/password|secret|token|apiKey/i);
    expect(text.split('\n').length).toBeGreaterThan(2);
  });
});
