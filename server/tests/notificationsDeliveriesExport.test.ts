/**
 * GET /api/notifications/deliveries/export — outcome fields only (no bodies).
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
  tmpDir = mkdtempSync(join(tmpdir(), 'hpe-notif-deliv-export-'));
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

async function sendJson(method: string, path: string, body?: unknown) {
  const r = await fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, unknown> };
}

describe('notifications deliveries export', () => {
  it('GET /api/notifications/deliveries/export returns outcome CSV without payloads', async () => {
    const created = await sendJson('POST', '/api/notifications/endpoints', {
      name: 'noc-export',
      url: 'https://hooks.example.com/export-demo',
      template: 'slack',
    });
    expect(created.status).toBe(201);
    const id = (created.body.endpoint as { id: string }).id;
    await sendJson('POST', `/api/notifications/endpoints/${id}/test`);

    const r = await fetch(`${base}/api/notifications/deliveries/export`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type') ?? '').toMatch(/text\/csv/);
    const text = await r.text();
    const header = text.split('\n')[0] ?? '';
    expect(header).toContain('at');
    expect(header).toContain('result');
    expect(header).toContain('test');
    expect(header).toContain('endpoint');
    expect(header).toContain('title');
    expect(header).toContain('httpCode');
    expect(header).toContain('error');
    // Outcomes only — never payload bodies, secrets, or webhook URLs.
    expect(text).not.toMatch(/hooks\.example\.com|hmac|password|secret|bearer|"text"\s*:/i);
    expect(text).toMatch(/demo|delivered|failed/i);
  });

  it('honours ?result= on list and export; unknown result is a no-op', async () => {
    const list = await fetch(`${base}/api/notifications/deliveries`);
    expect(list.status).toBe(200);
    const all = (await list.json()) as { entries: Array<{ result: string }> };
    expect(all.entries.length).toBeGreaterThan(0);

    const demo = await fetch(`${base}/api/notifications/deliveries?result=demo`);
    const demoBody = (await demo.json()) as { entries: Array<{ result: string }> };
    for (const e of demoBody.entries) expect(e.result).toBe('demo');

    const bogus = await fetch(`${base}/api/notifications/deliveries?result=not-real`);
    const bogusBody = (await bogus.json()) as { entries: unknown[] };
    expect(bogusBody.entries.length).toBe(all.entries.length);

    const csv = await fetch(`${base}/api/notifications/deliveries/export?result=demo`);
    expect(csv.status).toBe(200);
    const text = await csv.text();
    const dataLines = text.split('\n').filter((l) => l && !l.startsWith('at,'));
    for (const line of dataLines) {
      if (!line.trim()) continue;
      expect(line.toLowerCase()).toContain('demo');
    }
    expect(text).not.toMatch(/hooks\.example\.com|password|secret/i);
  });

  it('honours q= text filter on list and export (Loop 116)', async () => {
    const created = await sendJson('POST', '/api/notifications/endpoints', {
      name: 'triage-q-endpoint',
      url: 'https://hooks.example.com/triage-q',
      template: 'slack',
    });
    expect(created.status).toBe(201);
    const id = (created.body.endpoint as { id: string }).id;
    await sendJson('POST', `/api/notifications/endpoints/${id}/test`);

    const list = await fetch(`${base}/api/notifications/deliveries`);
    const all = (await list.json()) as { entries: Array<{ endpointName: string }> };
    expect(all.entries.length).toBeGreaterThan(0);

    const hit = await fetch(`${base}/api/notifications/deliveries?q=triage-q-endpoint`);
    expect(hit.status).toBe(200);
    const hitBody = (await hit.json()) as { entries: Array<{ endpointName: string }> };
    expect(hitBody.entries.length).toBeGreaterThan(0);
    for (const e of hitBody.entries) {
      expect(e.endpointName.toLowerCase()).toContain('triage-q-endpoint');
    }

    const miss = await fetch(`${base}/api/notifications/deliveries?q=zz-no-such-endpoint-zz`);
    const missBody = (await miss.json()) as { entries: unknown[] };
    expect(missBody.entries.length).toBe(0);

    const emptyQ = await fetch(`${base}/api/notifications/deliveries?q=`);
    const emptyBody = (await emptyQ.json()) as { entries: unknown[] };
    expect(emptyBody.entries.length).toBe(all.entries.length);

    const csv = await fetch(`${base}/api/notifications/deliveries/export?q=triage-q-endpoint`);
    expect(csv.status).toBe(200);
    const text = await csv.text();
    expect(text.toLowerCase()).toContain('triage-q-endpoint');
    expect(text).not.toMatch(/hooks\.example\.com|password|secret/i);
  });
});
