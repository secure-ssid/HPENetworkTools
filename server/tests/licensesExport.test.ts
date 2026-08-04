/**
 * GET /api/licenses + /api/licenses/export — extracted licensesScreen routes.
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
  tmpDir = mkdtempSync(join(tmpdir(), 'hpe-licenses-export-'));
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

describe('licensesScreen routes', () => {
  it('GET /api/licenses returns envelope with subscriptions', async () => {
    const r = await fetch(`${base}/api/licenses`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      dataSource: string;
      subscriptions: unknown[];
      stats: unknown[];
    };
    expect(body.dataSource === 'demo' || body.dataSource === 'live').toBe(true);
    expect(Array.isArray(body.subscriptions)).toBe(true);
    expect(Array.isArray(body.stats)).toBe(true);
  });

  it('GET /api/licenses/export returns CSV without secrets', async () => {
    const r = await fetch(`${base}/api/licenses/export`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type') ?? '').toMatch(/text\/csv/);
    const text = await r.text();
    expect(text.split('\n')[0]).toContain('name');
    expect(text.split('\n')[0]).toContain('sku');
    expect(text).not.toMatch(/password|secret|token|apiKey/i);
  });

  it('GET /api/licenses/export?part=renewals returns renewals CSV', async () => {
    const r = await fetch(`${base}/api/licenses/export?part=renewals`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type') ?? '').toMatch(/text\/csv/);
    const text = await r.text();
    const header = text.split('\n')[0] ?? '';
    expect(header).toContain('date');
    expect(header).toContain('what');
    expect(header).toContain('days');
    expect(text).not.toMatch(/password|secret|token|apiKey/i);
  });

  it('GET /api/licenses/export rejects unknown part', async () => {
    const r = await fetch(`${base}/api/licenses/export?part=guessed`);
    expect(r.status).toBe(400);
  });

  it('isOperationalSubscriptionRow matches the Licences UI idle-zero hide rule', async () => {
    const { isOperationalSubscriptionRow, includeIdleCapacity } = await import(
      '../src/routes/screens/licensesScreen'
    );
    expect(isOperationalSubscriptionRow({ status: 'idle', assigned: '0' })).toBe(false);
    expect(isOperationalSubscriptionRow({ status: 'idle', assigned: '1' })).toBe(true);
    expect(isOperationalSubscriptionRow({ status: 'idle', assigned: '—' })).toBe(true);
    expect(isOperationalSubscriptionRow({ status: 'active', assigned: '0' })).toBe(true);
    expect(includeIdleCapacity({ query: { idle: '1' } })).toBe(true);
    expect(includeIdleCapacity({ query: { idle: 'true' } })).toBe(true);
    expect(includeIdleCapacity({ query: { idle: '0' } })).toBe(false);
    expect(includeIdleCapacity({ query: {} })).toBe(false);
  });

  it('GET /api/licenses/export?idle=1 is accepted (UI spare-capacity parity)', async () => {
    const def = await fetch(`${base}/api/licenses/export`);
    const withIdle = await fetch(`${base}/api/licenses/export?idle=1`);
    expect(def.status).toBe(200);
    expect(withIdle.status).toBe(200);
    const a = await def.text();
    const b = await withIdle.text();
    // Demo fixtures may have no idle-zero rows — idle=1 must never shrink the export.
    expect(b.split('\n').filter((l) => l.trim()).length).toBeGreaterThanOrEqual(
      a.split('\n').filter((l) => l.trim()).length,
    );
  });

  it('GET /api/licenses/export?plane= filters subscriptions (Loop 86)', async () => {
    const all = await fetch(`${base}/api/licenses/export`);
    expect(all.status).toBe(200);
    const allText = await all.text();
    const allLines = allText.trim().split('\n').slice(1).filter(Boolean);
    if (allLines.length === 0) return;
    // plane is the 3rd CSV column (name,sku,plane,…)
    const plane = allLines[0]?.split(',')[2]?.replace(/^"|"$/g, '') ?? '';
    if (!plane) return;
    const filtered = await fetch(
      `${base}/api/licenses/export?plane=${encodeURIComponent(plane)}`,
    );
    expect(filtered.status).toBe(200);
    const lines = (await filtered.text()).trim().split('\n').slice(1).filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.length).toBeLessThanOrEqual(allLines.length);
    for (const line of lines) {
      expect(line.toLowerCase()).toContain(plane.toLowerCase());
    }
    const { applyLicensePlaneFilter } = await import('../src/routes/screens/licensesScreen');
    expect(
      applyLicensePlaneFilter({ query: { plane: 'mist' } }, [
        { plane: 'MIST' },
        { plane: 'GREENLAKE' },
      ]),
    ).toEqual([{ plane: 'MIST' }]);
  });

  it('GET /api/licenses/export?status= exact filter (Loop 113)', async () => {
    const all = await fetch(`${base}/api/licenses/export?idle=1`);
    expect(all.status).toBe(200);
    const allText = await all.text();
    const allLines = allText.trim().split('\n').slice(1).filter(Boolean);
    if (allLines.length === 0) return;
    // status is the last CSV column
    const status = allLines[0]?.split(',').pop()?.replace(/^"|"$/g, '') ?? '';
    if (!status) return;
    const filtered = await fetch(
      `${base}/api/licenses/export?idle=1&status=${encodeURIComponent(status)}`,
    );
    expect(filtered.status).toBe(200);
    const lines = (await filtered.text()).trim().split('\n').slice(1).filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.length).toBeLessThanOrEqual(allLines.length);
    for (const line of lines) {
      expect(line.toLowerCase()).toContain(status.toLowerCase());
    }
    const { applyLicenseStatusFilter } = await import('../src/routes/screens/licensesScreen');
    expect(
      applyLicenseStatusFilter({ query: { status: 'ACTIVE' } }, [
        { status: 'active' },
        { status: 'idle' },
        { status: 'expiring' },
      ]),
    ).toEqual([{ status: 'active' }]);
    expect(applyLicenseStatusFilter({ query: {} }, [{ status: 'active' }])).toEqual([
      { status: 'active' },
    ]);
  });

  it('GET /api/licenses/export?q= substring filter (Loop 100)', async () => {
    const all = await fetch(`${base}/api/licenses/export`);
    expect(all.status).toBe(200);
    const allText = await all.text();
    const allLines = allText.trim().split('\n').slice(1).filter(Boolean);
    if (allLines.length === 0) return;
    // name is first column
    const name = allLines[0]?.split(',')[0]?.replace(/^"|"$/g, '') ?? '';
    const needle = name.slice(0, Math.min(4, name.length));
    if (!needle) return;
    const filtered = await fetch(
      `${base}/api/licenses/export?q=${encodeURIComponent(needle)}`,
    );
    expect(filtered.status).toBe(200);
    const lines = (await filtered.text()).trim().split('\n').slice(1).filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.length).toBeLessThanOrEqual(allLines.length);
    for (const line of lines) {
      expect(line.toLowerCase()).toContain(needle.toLowerCase());
    }
    const { applyLicenseTextFilter } = await import('../src/routes/screens/licensesScreen');
    expect(
      applyLicenseTextFilter({ query: { q: 'found' } }, [
        { name: 'Foundation AP', sku: 'X', plane: 'GREENLAKE', term: '1y', status: 'active' },
        { name: 'Other', sku: 'Y', plane: 'MIST', term: '1y', status: 'idle' },
      ]),
    ).toEqual([
      { name: 'Foundation AP', sku: 'X', plane: 'GREENLAKE', term: '1y', status: 'active' },
    ]);
  });
});
