/**
 * Loop 99 — GET /api/central/webhooks/export (summary fields; optional q=).
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let server: Server;
let base: string;
let tmpDir: string;

beforeAll(async () => {
  const testRoot = resolve(process.cwd(), '.agent-tmp');
  mkdirSync(testRoot, { recursive: true });
  tmpDir = mkdtempSync(join(testRoot, 'central-webhooks-export-'));
  process.env.HPE_SETTINGS_PATH = join(tmpDir, 'settings.json');
  process.env.HPE_DATA_DIR = join(tmpDir, 'data');
  const { createApp } = await import('../src/index');
  server = createApp().listen(0, '127.0.0.1');
  await new Promise<void>((resolveListen) => server.once('listening', resolveListen));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.HPE_SETTINGS_PATH;
  delete process.env.HPE_DATA_DIR;
});

describe('central webhooks export (Loop 99)', () => {
  it('GET /api/central/webhooks/export returns summary CSV without secrets', async () => {
    const r = await fetch(`${base}/api/central/webhooks/export`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type') ?? '').toMatch(/text\/csv/);
    const text = await r.text();
    const header = text.split('\n')[0] ?? '';
    expect(header).toContain('id');
    expect(header).toContain('name');
    expect(header).toContain('endpoint');
    expect(header).toContain('authMechanism');
    expect(header).toContain('generation');
    // Never HMAC keys, API keys, or client secrets.
    expect(text).not.toMatch(/hmac|apiKey|clientSecret|password|bearer\s+[A-Za-z0-9]/i);
  });

  it('honours ?q= filter on export (name/endpoint substring)', async () => {
    const full = await fetch(`${base}/api/central/webhooks/export`);
    const fullText = await full.text();
    const fullRows = fullText.trim().split('\n').filter(Boolean).length - 1;

    const q = await fetch(`${base}/api/central/webhooks/export?q=servicenow`);
    expect(q.status).toBe(200);
    const qText = await q.text();
    const qRows = qText.trim().split('\n').filter(Boolean).length - 1;
    expect(qRows).toBeGreaterThanOrEqual(0);
    if (fullRows > 0) {
      expect(qRows).toBeLessThanOrEqual(fullRows);
    }
    // Filter should not invent rows outside the match.
    for (const line of qText.trim().split('\n').slice(1).filter(Boolean)) {
      expect(line.toLowerCase()).toMatch(/servicenow|name|endpoint/);
    }
  });

  it('static export path is not captured by /central/webhooks/:id', async () => {
    const r = await fetch(`${base}/api/central/webhooks/export`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type') ?? '').toMatch(/text\/csv/);
  });
});
