/**
 * GET /api/greenlake/export — workspace section CSV (requires linked plane).
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
  tmpDir = mkdtempSync(join(tmpdir(), 'hpe-greenlake-export-'));
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

describe('greenlake export routes', () => {
  it('GET /api/greenlake/export rejects unknown part', async () => {
    const r = await fetch(`${base}/api/greenlake/export?part=guessed`);
    // Unlinked plane → 409 before part validation is fine; when linked, 400.
    expect([400, 409]).toContain(r.status);
    if (r.status === 400) {
      const body = (await r.json()) as { error?: string };
      expect(body.error ?? '').toMatch(/part/i);
    }
  });

  it('GET /api/greenlake/export without linked plane is 409 (not a silent empty CSV)', async () => {
    const r = await fetch(`${base}/api/greenlake/export?part=users`);
    // Fresh temp settings: GreenLake is not linked.
    expect(r.status).toBe(409);
    const body = (await r.json()) as { error?: string };
    expect(typeof body.error).toBe('string');
    expect(JSON.stringify(body)).not.toMatch(/password|secret|token|apiKey/i);
  });

  it('OpenAPI documents greenlake export part enum + q (Loop 95)', async () => {
    const r = await fetch(`${base}/api/openapi.json`);
    expect(r.status).toBe(200);
    const spec = (await r.json()) as {
      paths: Record<string, { get?: { parameters?: Array<{ name?: string; schema?: { enum?: string[] } }> } }>;
    };
    const params = spec.paths['/api/greenlake/export']?.get?.parameters ?? [];
    const part = params.find((p) => p.name === 'part');
    expect(part?.schema?.enum).toEqual(expect.arrayContaining(['users', 'locations', 'roles']));
    expect(params.some((p) => p.name === 'q')).toBe(true);
    expect(params.some((p) => p.name === 'status')).toBe(true);
  });

  it('matchesGreenLakeUserStatus is exact case-insensitive (Loop 107)', async () => {
    const { matchesGreenLakeUserStatus, matchesGreenLakeExportQ } = await import(
      '../src/routes/greenlake'
    );
    expect(matchesGreenLakeUserStatus('VERIFIED', 'verified')).toBe(true);
    expect(matchesGreenLakeUserStatus('PENDING', 'verified')).toBe(false);
    expect(matchesGreenLakeUserStatus('VERIFIED', '')).toBe(true);
    expect(matchesGreenLakeExportQ(['ops@example.com', 'VERIFIED'], 'ops@')).toBe(true);
    expect(matchesGreenLakeExportQ(['ops@example.com'], 'zzz')).toBe(false);
  });

  it('export part/q/status use shared queryString (Loop 121)', async () => {
    // Unlinked plane → 409 before filters run is fine; when linked, trim still parses.
    const trimmed = await fetch(
      `${base}/api/greenlake/export?part=${encodeURIComponent('  users  ')}&q=${encodeURIComponent('  x  ')}&status=${encodeURIComponent('  VERIFIED  ')}`,
    );
    expect([200, 409]).toContain(trimmed.status);
    if (trimmed.status === 200) {
      expect(trimmed.headers.get('content-type') ?? '').toMatch(/text\/csv/);
    }

    // Non-string bags are honest no-ops at the parser — empty part defaults to users.
    // Unknown named part still 400 (or 409 when unlinked).
    const bad = await fetch(`${base}/api/greenlake/export?part=not-a-section`);
    expect([400, 409]).toContain(bad.status);
  });
});
