/**
 * GET /api/systems — extracted systemsScreen view-model route.
 * Connector state/credentials stay on routes/systems.ts.
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
  tmpDir = mkdtempSync(join(tmpdir(), 'hpe-systems-screen-'));
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

describe('systemsScreen routes', () => {
  it('GET /api/systems demo envelope matches the client contract', async () => {
    const r = await fetch(`${base}/api/systems`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      dataSource: string;
      systems: unknown[];
      syncHistory: unknown[];
      permissions: unknown[];
    };
    expect(body.dataSource === 'demo' || body.dataSource === 'live').toBe(true);
    expect(Array.isArray(body.systems)).toBe(true);
    expect(body.systems.length).toBeGreaterThan(0);
    expect(Array.isArray(body.syncHistory)).toBe(true);
    expect(Array.isArray(body.permissions)).toBe(true);
  });
});
