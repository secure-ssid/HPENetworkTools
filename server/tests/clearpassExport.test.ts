/**
 * GET /api/clearpass + /api/clearpass/export — extracted clearpassScreen routes.
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
  tmpDir = mkdtempSync(join(tmpdir(), 'hpe-clearpass-export-'));
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

describe('clearpassScreen routes', () => {
  it('GET /api/clearpass returns envelope with auth feed (endpoints empty on screen)', async () => {
    const r = await fetch(`${base}/api/clearpass`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      dataSource: string;
      endpoints: unknown[];
      authEvents: unknown[];
    };
    expect(body.dataSource === 'demo' || body.dataSource === 'live').toBe(true);
    expect(Array.isArray(body.endpoints)).toBe(true);
    expect(body.endpoints).toHaveLength(0);
    expect(Array.isArray(body.authEvents)).toBe(true);
  });

  it('GET /api/clearpass/export returns CSV without secrets', async () => {
    const r = await fetch(`${base}/api/clearpass/export`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type') ?? '').toMatch(/text\/csv/);
    const text = await r.text();
    const header = text.split('\n')[0] ?? '';
    expect(header).toContain('section');
    expect(header).toContain('mac');
    expect(header).toContain('hostname');
    expect(header).toContain('who');
    expect(header).toContain('result');
    expect(header).toContain('plane');
    expect(text).toMatch(/\bendpoint\b/);
    expect(text).toMatch(/\bsession\b/);
    expect(header).not.toMatch(/password|secret|token|apiKey|credential/i);
    expect(text).not.toMatch(/api[_-]?key\s*[:=]|bearer\s+[a-z0-9._-]+/i);
  });

  it('GET /api/clearpass/export?part=endpoints returns endpoint rows only', async () => {
    const r = await fetch(`${base}/api/clearpass/export?part=endpoints`);
    expect(r.status).toBe(200);
    const text = await r.text();
    const lines = text.trim().split('\n').slice(1).filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line.startsWith('endpoint,') || line.startsWith('"endpoint"')).toBe(true);
    }
  });

  it('GET /api/clearpass/export rejects bad part', async () => {
    const r = await fetch(`${base}/api/clearpass/export?part=passwords`);
    expect(r.status).toBe(400);
  });

  it('GET /api/clearpass/export?part=services returns service columns (Loop 95)', async () => {
    const r = await fetch(`${base}/api/clearpass/export?part=services`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type') ?? '').toMatch(/text\/csv/);
    const text = await r.text();
    const header = text.split('\n')[0] ?? '';
    expect(header).toContain('id');
    expect(header).toContain('name');
    expect(header).toContain('enabled');
    expect(header).toContain('rulesSummary');
    expect(header).not.toMatch(/password|secret|token|apiKey|credential/i);
    const lines = text.trim().split('\n').slice(1).filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);
  });

  it('GET /api/clearpass/export?part=services honours q + enabled (Loop 95)', async () => {
    const all = await fetch(`${base}/api/clearpass/export?part=services`);
    expect(all.status).toBe(200);
    const allLines = (await all.text()).trim().split('\n').slice(1).filter(Boolean);
    expect(allLines.length).toBeGreaterThan(0);

    const q = await fetch(`${base}/api/clearpass/export?part=services&q=eduroam`);
    expect(q.status).toBe(200);
    const qText = await q.text();
    const qLines = qText.trim().split('\n').slice(1).filter(Boolean);
    expect(qLines.length).toBeGreaterThan(0);
    expect(qLines.length).toBeLessThanOrEqual(allLines.length);
    expect(qText.toLowerCase()).toMatch(/eduroam/);

    const enabled = await fetch(`${base}/api/clearpass/export?part=services&enabled=0`);
    expect(enabled.status).toBe(200);
    const enabledLines = (await enabled.text()).trim().split('\n').slice(1).filter(Boolean);
    expect(enabledLines.length).toBeGreaterThan(0);
    expect(enabledLines.length).toBeLessThanOrEqual(allLines.length);
    for (const line of enabledLines) {
      expect(line).toMatch(/,no,/i);
    }

    // Loop 115: queryFlag accepts off/no as disabled aliases of 0/false.
    const enabledOff = await fetch(`${base}/api/clearpass/export?part=services&enabled=off`);
    expect(enabledOff.status).toBe(200);
    expect((await enabledOff.text()).trim().split('\n').slice(1).filter(Boolean).length).toBe(
      enabledLines.length,
    );

    const miss = await fetch(`${base}/api/clearpass/export?part=services&q=__no_such_service__`);
    expect(miss.status).toBe(200);
    const missLines = (await miss.text()).trim().split('\n').slice(1).filter(Boolean);
    expect(missLines).toHaveLength(0);
  });

  it('GET /api/clearpass/export honours status/category exact filters on endpoints (Loop 80)', async () => {
    const all = await fetch(`${base}/api/clearpass/export?part=endpoints`);
    expect(all.status).toBe(200);
    const allText = await all.text();
    const allLines = allText.trim().split('\n').slice(1).filter(Boolean);
    expect(allLines.length).toBeGreaterThan(0);

    const known = await fetch(`${base}/api/clearpass/export?part=endpoints&status=Known`);
    expect(known.status).toBe(200);
    const knownText = await known.text();
    const knownLines = knownText.trim().split('\n').slice(1).filter(Boolean);
    expect(knownLines.length).toBeGreaterThan(0);
    expect(knownLines.length).toBeLessThanOrEqual(allLines.length);
    for (const line of knownLines) {
      expect(line).toMatch(/,Known,/);
    }

    const bogus = await fetch(`${base}/api/clearpass/export?part=endpoints&status=__no_such_status__`);
    expect(bogus.status).toBe(200);
    const bogusLines = (await bogus.text()).trim().split('\n').slice(1).filter(Boolean);
    expect(bogusLines).toHaveLength(0);
  });

  it('GET /api/clearpass/endpoints still pages the repository', async () => {
    const r = await fetch(`${base}/api/clearpass/endpoints?offset=0&limit=5`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      dataSource: string;
      endpoints: unknown[];
      limit: number;
    };
    expect(body.dataSource === 'demo' || body.dataSource === 'live').toBe(true);
    expect(Array.isArray(body.endpoints)).toBe(true);
    expect(body.limit).toBe(5);
  });

  it('GET /api/clearpass/endpoints honours status filter before paging (Loop 86)', async () => {
    const all = await fetch(`${base}/api/clearpass/endpoints?offset=0&limit=100`);
    expect(all.status).toBe(200);
    const allBody = (await all.json()) as { endpoints: Array<{ status?: string }>; total: number | null };
    const known = allBody.endpoints.filter((e) => e.status === 'Known');
    if (known.length === 0) return; // live estate without Known rows — skip
    const filtered = await fetch(`${base}/api/clearpass/endpoints?offset=0&limit=100&status=Known`);
    expect(filtered.status).toBe(200);
    const body = (await filtered.json()) as {
      endpoints: Array<{ status?: string }>;
      total: number | null;
    };
    expect(body.endpoints.every((e) => e.status === 'Known')).toBe(true);
    if (body.total !== null) {
      expect(body.total).toBe(body.endpoints.length);
      expect(body.total).toBeLessThanOrEqual(allBody.endpoints.length);
    }
  });
});
