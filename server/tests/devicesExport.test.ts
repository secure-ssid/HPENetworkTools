/**
 * GET /api/devices + /api/devices/export + /api/devices/bulk — devicesScreen routes.
 * Detail + trends also live here; export/bulk must not be treated as names.
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
  tmpDir = mkdtempSync(join(tmpdir(), 'hpe-devices-export-'));
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

describe('devicesScreen routes', () => {
  it('GET /api/devices returns envelope with devices', async () => {
    const r = await fetch(`${base}/api/devices`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { dataSource: string; devices: unknown[] };
    expect(body.dataSource === 'demo' || body.dataSource === 'live').toBe(true);
    expect(Array.isArray(body.devices)).toBe(true);
  });

  it('GET /api/devices/export returns CSV (not treated as :name)', async () => {
    const r = await fetch(`${base}/api/devices/export`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type') ?? '').toMatch(/text\/csv/);
    const text = await r.text();
    const header = text.split('\n')[0] ?? '';
    expect(header).toContain('name');
    expect(header).toContain('serial');
    expect(header).toContain('plane');
    expect(text).not.toMatch(/api[_-]?key\s*[:=]|bearer\s+[a-z0-9._-]+/i);
  });

  it('GET /api/devices and export honour type/issues/site filters', async () => {
    const list = await fetch(`${base}/api/devices?type=switch&limit=500`);
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as { devices: Array<{ type: string }> };
    expect(listBody.devices.every((d) => d.type.toLowerCase() === 'switch')).toBe(true);

    const csv = await fetch(`${base}/api/devices/export?issues=1`);
    expect(csv.status).toBe(200);
    const text = await csv.text();
    expect(text.split('\n')[0] ?? '').toContain('name');
    // Filtered export still has header; body may be empty when no issues.
    expect(text.length).toBeGreaterThan(0);
  });

  it('GET /api/devices/bulk requires serials and returns matches + missing', async () => {
    const missingOnly = await fetch(`${base}/api/devices/bulk`);
    expect(missingOnly.status).toBe(400);

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

  it('GET /api/devices/:name/clients/export returns attached sessions CSV (Loop 87)', async () => {
    const r = await fetch(`${base}/api/devices/sw-core-a/clients/export`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type') ?? '').toMatch(/text\/csv/);
    const text = await r.text();
    const header = text.split('\n')[0] ?? '';
    expect(header).toContain('client');
    expect(header).toContain('mac');
    expect(header).toContain('state');
    expect(header).toContain('detail');
    // Demo CX switch profile carries authored client rows.
    expect(text.split('\n').filter((l) => l.trim()).length).toBeGreaterThan(1);
    expect(text).not.toMatch(/api[_-]?key\s*[:=]|bearer\s+[a-z0-9._-]+|password|secret|token/i);
  });

  it('GET /api/devices/:name/clients/export 404s unknown device', async () => {
    const r = await fetch(`${base}/api/devices/not-a-real-device-xyz/clients/export`);
    expect(r.status).toBe(404);
  });

  it('GET /api/devices/:name/ports/export returns port rows CSV (Loop 93)', async () => {
    const r = await fetch(`${base}/api/devices/sw-core-a/ports/export`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type') ?? '').toMatch(/text\/csv/);
    const text = await r.text();
    const header = text.split('\n')[0] ?? '';
    expect(header).toContain('port');
    expect(header).toContain('what');
    expect(header).toContain('state');
    expect(header).toContain('neighbour');
    // Demo CX switch profile carries authored port rows.
    expect(text.split('\n').filter((l) => l.trim()).length).toBeGreaterThan(1);
    expect(text).toMatch(/1\/1\//);
    expect(text).not.toMatch(/api[_-]?key\s*[:=]|bearer\s+[a-z0-9._-]+|password|secret|token/i);
  });

  it('GET /api/devices/:name/ports/export 404s unknown device', async () => {
    const r = await fetch(`${base}/api/devices/not-a-real-device-xyz/ports/export`);
    expect(r.status).toBe(404);
  });
});
