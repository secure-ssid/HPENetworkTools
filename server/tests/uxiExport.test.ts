/**
 * GET /api/uxi + /api/uxi/export — extracted uxiScreen routes.
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
  tmpDir = mkdtempSync(join(tmpdir(), 'hpe-uxi-export-'));
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

describe('uxiScreen routes', () => {
  it('GET /api/uxi returns envelope with sensors', async () => {
    const r = await fetch(`${base}/api/uxi`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      dataSource: string;
      sensors: unknown[];
    };
    expect(body.dataSource === 'demo' || body.dataSource === 'live').toBe(true);
    expect(Array.isArray(body.sensors)).toBe(true);
  });

  it('GET /api/uxi/export returns CSV without credentials', async () => {
    const r = await fetch(`${base}/api/uxi/export`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type') ?? '').toMatch(/text\/csv/);
    const text = await r.text();
    const header = text.split('\n')[0] ?? '';
    expect(header).toContain('id');
    expect(header).toContain('name');
    expect(header).toContain('serial');
    expect(text).not.toMatch(/password|secret|token|apiKey|credential/i);
  });

  /* Loop 61 — optional list filters + paging on GET /api/uxi. */
  it('GET /api/uxi?limit=1 returns page meta and nextCursor when more remain', async () => {
    const r = await fetch(`${base}/api/uxi?limit=1`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      sensors: unknown[];
      page?: { total: number; limit: number; nextCursor: string | null };
    };
    expect(Array.isArray(body.sensors)).toBe(true);
    expect(body.sensors.length).toBeLessThanOrEqual(1);
    expect(body.page).toBeTruthy();
    expect(body.page!.limit).toBe(1);
    expect(typeof body.page!.total).toBe('number');
    if (body.page!.total > 1) {
      expect(body.page!.nextCursor).toBeTruthy();
    }
  });

  it('GET /api/uxi?status=online never returns offline sensors', async () => {
    const r = await fetch(`${base}/api/uxi?status=online`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { sensors: Array<{ isOnline?: boolean | null }> };
    for (const s of body.sensors) {
      expect(s.isOnline).toBe(true);
    }
  });

  it('GET /api/uxi?severity=critical returns only sensors with a critical issue (Loop 110)', async () => {
    const r = await fetch(`${base}/api/uxi?severity=critical`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      sensors: Array<{ issues?: Array<{ severity?: string }> }>;
    };
    expect(Array.isArray(body.sensors)).toBe(true);
    for (const s of body.sensors) {
      const hit = (s.issues ?? []).some(
        (i) => String(i.severity ?? '').toLowerCase() === 'critical',
      );
      expect(hit).toBe(true);
    }

    const exportR = await fetch(`${base}/api/uxi/export?severity=critical`);
    expect(exportR.status).toBe(200);
    expect(exportR.headers.get('content-type') ?? '').toMatch(/text\/csv/);
  });

  it('GET /api/uxi/export?q= honours substring filter without secrets', async () => {
    const r = await fetch(`${base}/api/uxi/export?q=zzz-no-such-sensor`);
    expect(r.status).toBe(200);
    const text = await r.text();
    const lines = text.trim().split('\n').filter(Boolean);
    // header only when nothing matches
    expect(lines.length).toBe(1);
    expect(text).not.toMatch(/password|secret|token|apiKey|credential/i);
  });
});
