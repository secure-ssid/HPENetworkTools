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
  it('returns process, plane, and integrity facts without secrets', async () => {
    const r = await fetch(`${base}/api/debug/runtime`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      ok: boolean;
      process: { node: string; uptimeSec: number; memory: { heapUsed: number } };
      portal: { demoMode: boolean; auth: string };
      planes: Array<{ id: string; linked: boolean }>;
      notifier: { deliveryLogSize: number };
      integrity: { devices: number; doubleClaimed: number; unclaimed: number };
    };
    expect(body.ok).toBe(true);
    expect(body.process.node).toMatch(/^v/);
    expect(typeof body.process.uptimeSec).toBe('number');
    expect(body.process.memory.heapUsed).toBeGreaterThan(0);
    expect(body.portal.auth === 'none' || body.portal.auth === 'oidc').toBe(true);
    expect(Array.isArray(body.planes)).toBe(true);
    expect(body.planes.length).toBeGreaterThan(0);
    expect(typeof body.notifier.deliveryLogSize).toBe('number');
    expect(body.integrity).toEqual(
      expect.objectContaining({
        devices: expect.any(Number),
        doubleClaimed: expect.any(Number),
        unclaimed: expect.any(Number),
      }),
    );
    expect(body.integrity.devices).toBeGreaterThanOrEqual(0);
    expect(body.integrity.doubleClaimed).toBeGreaterThanOrEqual(0);
    expect(body.integrity.unclaimed).toBeGreaterThanOrEqual(0);
    const raw = JSON.stringify(body);
    expect(raw).not.toMatch(/password|secret|token|apiKey/i);
  });

  it('exports connector/plane integrity CSV without secrets', async () => {
    const r = await fetch(`${base}/api/debug/runtime/export`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type') ?? '').toMatch(/text\/csv/);
    const cd = r.headers.get('content-disposition') ?? '';
    expect(cd).toMatch(/connector-integrity\.csv/);
    const text = await r.text();
    const header = text.split('\n')[0];
    expect(header).toContain('kind,id,linked,health');
    expect(header).toContain('count');
    expect(text).toMatch(/^integrity,devices,/m);
    expect(text).toMatch(/^integrity,doubleClaimed,/m);
    expect(text).toMatch(/^integrity,unclaimed,/m);
    expect(text).toMatch(/^plane,/m);
    expect(text).not.toMatch(/password|secret|token|apiKey/i);
    expect(text.split('\n').length).toBeGreaterThan(5);
  });

  it('honours ?filter= on runtime export (Loop 89)', async () => {
    const all = await fetch(`${base}/api/debug/runtime/export`);
    expect(all.status).toBe(200);
    const allText = await all.text();
    const allPlanes = allText.split('\n').filter((l) => l.startsWith('plane,')).length;

    const unlinked = await fetch(`${base}/api/debug/runtime/export?filter=unlinked`);
    expect(unlinked.status).toBe(200);
    const unlinkedText = await unlinked.text();
    // Integrity tallies always ship regardless of plane filter.
    expect(unlinkedText).toMatch(/^integrity,devices,/m);
    const unlinkedPlanes = unlinkedText.split('\n').filter((l) => l.startsWith('plane,')).length;
    expect(unlinkedPlanes).toBeLessThanOrEqual(allPlanes);

    const bad = await fetch(`${base}/api/debug/runtime/export?filter=purple`);
    expect(bad.status).toBe(400);
    const body = (await bad.json()) as { error: string };
    expect(body.error).toMatch(/filter must be/);
  });
});
