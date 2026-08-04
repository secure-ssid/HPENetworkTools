/**
 * GET /api/devices/bulk — serial lookup (max 50), no fabrication.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEVICES } from '@hpe/shared';

let server: Server;
let base: string;
let tmpDir: string;

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'hpe-bulk-'));
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

describe('GET /api/devices/bulk', () => {
  it('requires serials', async () => {
    const r = await fetch(`${base}/api/devices/bulk`);
    expect(r.status).toBe(400);
  });

  it('returns matching demo devices and missing serials', async () => {
    const withSerial = DEVICES.filter((d) => d.serial && String(d.serial).trim()).slice(0, 2);
    if (withSerial.length === 0) return;
    const serials = withSerial.map((d) => String(d.serial));
    const ghost = 'ZZ-NOT-A-REAL-SERIAL-000';
    const r = await fetch(
      `${base}/api/devices/bulk?serials=${encodeURIComponent([...serials, ghost].join(','))}`,
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      devices: Array<{ serial?: string }>;
      missing: string[];
      requested: number;
    };
    expect(body.requested).toBe(serials.length + 1);
    expect(body.devices.length).toBeGreaterThanOrEqual(1);
    expect(body.missing).toContain(ghost);
  });
});
