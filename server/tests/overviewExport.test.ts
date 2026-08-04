/**
 * GET /api/overview + /api/overview/export — extracted overviewScreen routes.
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
  tmpDir = mkdtempSync(join(tmpdir(), 'hpe-overview-export-'));
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

describe('overviewScreen routes', () => {
  it('GET /api/overview returns the demo envelope and payload', async () => {
    const r = await fetch(`${base}/api/overview`);
    expect(r.status).toBe(200);
    const etag = r.headers.get('etag');
    expect(etag).toMatch(/^W\//);
    expect(r.headers.get('cache-control')).toMatch(/private/);
    const body = (await r.json()) as {
      dataSource: string;
      stats: unknown[];
      alerts: unknown[];
      sites: unknown[];
      planes: unknown[];
      changes: unknown[];
      launchpad: unknown[];
      workspace?: string;
    };
    expect(body.dataSource === 'demo' || body.dataSource === 'live').toBe(true);
    expect(Array.isArray(body.stats)).toBe(true);
    expect(Array.isArray(body.alerts)).toBe(true);
    expect(Array.isArray(body.sites)).toBe(true);
    expect(Array.isArray(body.planes)).toBe(true);
    expect(Array.isArray(body.changes)).toBe(true);
    expect(Array.isArray(body.launchpad)).toBe(true);
  });

  it('GET /api/overview honors If-None-Match with 304', async () => {
    const first = await fetch(`${base}/api/overview`);
    expect(first.status).toBe(200);
    const etag = first.headers.get('etag');
    expect(etag).toBeTruthy();
    await first.json();
    const second = await fetch(`${base}/api/overview`, {
      headers: { 'If-None-Match': etag! },
    });
    expect(second.status).toBe(304);
  });

  it('GET /api/overview/export?part=alerts returns Needs-you-now CSV', async () => {
    const r = await fetch(`${base}/api/overview/export?part=alerts`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type') ?? '').toMatch(/text\/csv/);
    const text = await r.text();
    const header = text.split('\n')[0] ?? '';
    expect(header).toContain('sev');
    expect(header).toContain('title');
    expect(header).toContain('plane');
    expect(header).toContain('age');
    expect(header).toContain('device');
    expect(header).toContain('site');
    expect(header).toContain('meta');
    expect(text).not.toMatch(/password|secret|token|apiKey|credential|bearer/i);
  });

  it('GET /api/overview/export defaults part=alerts', async () => {
    const r = await fetch(`${base}/api/overview/export`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type') ?? '').toMatch(/text\/csv/);
  });

  it('GET /api/overview/export supports planes|sites|changes parts (Loop 89)', async () => {
    for (const [part, cols] of [
      ['planes', ['name', 'scope', 'state', 'sync', 'linked']],
      ['sites', ['name', 'siteId', 'plane', 'devices', 'clients', 'health', 'tone', 'alerts']],
      ['changes', ['time', 'text', 'who']],
    ] as const) {
      const r = await fetch(`${base}/api/overview/export?part=${part}`);
      expect(r.status).toBe(200);
      expect(r.headers.get('content-type') ?? '').toMatch(/text\/csv/);
      const text = await r.text();
      const header = text.split('\n')[0] ?? '';
      for (const col of cols) expect(header).toContain(col);
      expect(text).not.toMatch(/password|secret|token|apiKey|credential|bearer/i);
    }
  });

  it('GET /api/overview/export?part=sites&health= filters tone (Loop 89)', async () => {
    const all = await fetch(`${base}/api/overview/export?part=sites`);
    expect(all.status).toBe(200);
    const allText = await all.text();
    const allRows = allText.trim().split('\n').length - 1;

    const bad = await fetch(`${base}/api/overview/export?part=sites&health=bad`);
    expect(bad.status).toBe(200);
    const badText = await bad.text();
    const badRows = Math.max(0, badText.trim().split('\n').length - 1);
    expect(badRows).toBeLessThanOrEqual(allRows);

    const bogus = await fetch(`${base}/api/overview/export?part=sites&health=purple`);
    expect(bogus.status).toBe(400);
    const body = (await bogus.json()) as { error: string };
    expect(body.error).toMatch(/health must be/);
  });

  it("GET /api/overview/export rejects unknown part", async () => {
    const r = await fetch(`${base}/api/overview/export?part=launchpad`);
    expect(r.status).toBe(400);
    const body = (await r.json()) as { error: string };
    expect(body.error).toMatch(/part must be 'alerts', 'planes', 'sites', or 'changes'/);
  });

  it('trims part/health via shared queryString (Loop 121)', async () => {
    const part = await fetch(`${base}/api/overview/export?part=${encodeURIComponent('  planes  ')}`);
    expect(part.status).toBe(200);
    expect(part.headers.get('content-type') ?? '').toMatch(/text\/csv/);
    const header = (await part.text()).split('\n')[0] ?? '';
    expect(header).toContain('linked');

    const health = await fetch(
      `${base}/api/overview/export?part=sites&health=${encodeURIComponent('  bad  ')}`,
    );
    expect(health.status).toBe(200);
  });
});
