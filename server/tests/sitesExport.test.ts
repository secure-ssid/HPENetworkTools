/**
 * GET /api/sites + /api/sites/export — extracted sitesScreen routes.
 * Detail /sites/:siteId remains on screens.ts; export must not be a siteId.
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
  tmpDir = mkdtempSync(join(tmpdir(), 'hpe-sites-export-'));
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

describe('sitesScreen routes', () => {
  it('GET /api/sites returns envelope with sites', async () => {
    const r = await fetch(`${base}/api/sites`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { dataSource: string; sites: unknown[] };
    expect(body.dataSource === 'demo' || body.dataSource === 'live').toBe(true);
    expect(Array.isArray(body.sites)).toBe(true);
  });

  it('GET /api/sites/export returns CSV (not treated as :siteId)', async () => {
    const r = await fetch(`${base}/api/sites/export`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type') ?? '').toMatch(/text\/csv/);
    const text = await r.text();
    const header = text.split('\n')[0] ?? '';
    expect(header).toContain('name');
    expect(header).toContain('id');
    expect(header).toContain('devices');
    expect(text).not.toMatch(/password|secret|token|apiKey|credential/i);
  });

  it('honours health + plane filters on list and export (planes[] badge match)', async () => {
    const all = await fetch(`${base}/api/sites`);
    const allBody = (await all.json()) as {
      sites: Array<{ id: string; tone?: string; planes?: Array<{ name?: string } | string> }>;
    };
    expect(allBody.sites.length).toBeGreaterThan(0);

    const health = await fetch(`${base}/api/sites?health=ok`);
    expect(health.status).toBe(200);
    const healthBody = (await health.json()) as { sites: Array<{ tone?: string }> };
    for (const s of healthBody.sites) {
      expect(String(s.tone ?? '').toLowerCase()).toBe('ok');
    }

    // Unknown health is a no-op (full list), not an invented empty estate.
    const bogus = await fetch(`${base}/api/sites?health=not-a-tone`);
    const bogusBody = (await bogus.json()) as { sites: unknown[] };
    expect(bogusBody.sites.length).toBe(allBody.sites.length);

    const planeName = (() => {
      for (const s of allBody.sites) {
        for (const p of s.planes ?? []) {
          const n = typeof p === 'string' ? p : p.name;
          if (n) return n;
        }
      }
      return null;
    })();
    if (planeName) {
      const plane = await fetch(`${base}/api/sites?plane=${encodeURIComponent(planeName)}`);
      const planeBody = (await plane.json()) as {
        sites: Array<{ planes?: Array<{ name?: string } | string> }>;
      };
      expect(planeBody.sites.length).toBeGreaterThan(0);
      for (const s of planeBody.sites) {
        const names = (s.planes ?? []).map((p) =>
          (typeof p === 'string' ? p : p.name ?? '').toLowerCase(),
        );
        expect(names).toContain(planeName.toLowerCase());
      }

      const csv = await fetch(
        `${base}/api/sites/export?plane=${encodeURIComponent(planeName)}&health=ok`,
      );
      expect(csv.status).toBe(200);
      const text = await csv.text();
      expect(text.split('\n')[0]).toContain('name');
      expect(text).not.toMatch(/password|secret|token/i);
    }
  });
});
