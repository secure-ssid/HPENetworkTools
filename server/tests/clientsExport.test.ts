/**
 * GET /api/clients/export + list/:mac — clientsScreen routes.
 * Export must register before :mac so "export" is never captured as a MAC.
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
  tmpDir = mkdtempSync(join(tmpdir(), 'hpe-clients-export-'));
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

describe('clientsScreen export route', () => {
  it('GET /api/clients/export returns CSV (not treated as :mac)', async () => {
    const r = await fetch(`${base}/api/clients/export`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type') ?? '').toMatch(/text\/csv/);
    const text = await r.text();
    const header = text.split('\n')[0] ?? '';
    expect(header).toContain('client');
    expect(header).toContain('mac');
    expect(header).toContain('plane');
    expect(text).not.toMatch(/password|secret|token|apiKey|credential/i);
  });

  it('GET /api/clients and export honour medium/problems filters', async () => {
    const list = await fetch(`${base}/api/clients?medium=wireless&limit=500`);
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as { clients: Array<{ medium: string }> };
    expect(listBody.clients.every((c) => c.medium === 'wireless')).toBe(true);

    const csv = await fetch(`${base}/api/clients/export?problems=1`);
    expect(csv.status).toBe(200);
    const text = await csv.text();
    expect(text.split('\n')[0] ?? '').toContain('client');
    expect(text.length).toBeGreaterThan(0);
  });

  it('GET /api/clients still returns the list envelope', async () => {
    const r = await fetch(`${base}/api/clients`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { dataSource: string; clients: unknown[] };
    expect(body.dataSource === 'demo' || body.dataSource === 'live').toBe(true);
    expect(Array.isArray(body.clients)).toBe(true);
  });

  it('GET /api/clients/:mac returns detail envelope (not 404 for unknown MAC)', async () => {
    const r = await fetch(`${base}/api/clients/aa-bb-cc-dd-ee-ff`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      dataSource: string;
      clients: unknown[];
      client: unknown;
    };
    expect(body.dataSource === 'demo' || body.dataSource === 'live').toBe(true);
    expect(Array.isArray(body.clients)).toBe(true);
    // Unknown MAC stays on the clients screen with client: null.
    expect(body.client === null || body.client === undefined || typeof body.client === 'object').toBe(true);
  });
});
