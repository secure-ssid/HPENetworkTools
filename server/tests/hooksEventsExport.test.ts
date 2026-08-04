/**
 * Loop 99 — GET /api/hooks/events/export (+ source/q filters on list + export).
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
  tmpDir = mkdtempSync(join(testRoot, 'hooks-events-export-'));
  process.env.HPE_SETTINGS_PATH = join(tmpDir, 'settings.json');
  process.env.HPE_DATA_DIR = join(tmpDir, 'data');
  const { createApp } = await import('../src/index');
  server = createApp().listen(0, '127.0.0.1');
  await new Promise<void>((resolveListen) => server.once('listening', resolveListen));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  // Seed at least one labelled demo event through the real signed path.
  await fetch(`${base}/api/hooks/simulate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source: 'mist', topic: 'alarms' }),
  });
  await fetch(`${base}/api/hooks/simulate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source: 'central' }),
  });
});

afterAll(async () => {
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.HPE_SETTINGS_PATH;
  delete process.env.HPE_DATA_DIR;
});

describe('hooks events export (Loop 99)', () => {
  it('GET /api/hooks/events/export returns summary CSV without payloads/secrets', async () => {
    const r = await fetch(`${base}/api/hooks/events/export`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type') ?? '').toMatch(/text\/csv/);
    const text = await r.text();
    const header = text.split('\n')[0] ?? '';
    expect(header).toContain('id');
    expect(header).toContain('source');
    expect(header).toContain('receivedAt');
    expect(header).toContain('eventType');
    expect(header).toContain('demo');
    expect(header).toContain('title');
    expect(header).toContain('device');
    // Never raw bodies or signing material.
    expect(text).not.toMatch(/x-mist-signature|hmac|password|bearer\s+[A-Za-z0-9]|client_secret/i);
    expect(text.trim().split('\n').length).toBeGreaterThan(1);
  });

  it('honours source= and q= on list and export', async () => {
    const mistList = await fetch(`${base}/api/hooks/events?source=mist&limit=50`);
    expect(mistList.status).toBe(200);
    const mistBody = (await mistList.json()) as { events: Array<{ source: string }> };
    expect(mistBody.events.length).toBeGreaterThan(0);
    for (const e of mistBody.events) expect(e.source).toBe('mist');

    const mistCsv = await fetch(`${base}/api/hooks/events/export?source=mist&limit=50`);
    expect(mistCsv.status).toBe(200);
    const mistText = await mistCsv.text();
    for (const line of mistText.trim().split('\n').slice(1).filter(Boolean)) {
      expect(line.startsWith('') || line.includes('mist')).toBe(true);
      // source column is second field
      const cols = line.split(',');
      expect(cols[1]?.replace(/"/g, '')).toBe('mist');
    }

    const full = await fetch(`${base}/api/hooks/events/export?limit=50`);
    const fullRows = (await full.text()).trim().split('\n').filter(Boolean).length - 1;
    const q = await fetch(`${base}/api/hooks/events/export?q=zzzz-no-match-loop99&limit=50`);
    const qRows = (await q.text()).trim().split('\n').filter(Boolean).length - 1;
    expect(qRows).toBe(0);
    expect(fullRows).toBeGreaterThan(0);
  });

  it('unknown source filter is a no-op (does not empty the list)', async () => {
    const all = await fetch(`${base}/api/hooks/events?limit=50`);
    const allBody = (await all.json()) as { events: unknown[] };
    const bogus = await fetch(`${base}/api/hooks/events?source=not-a-plane&limit=50`);
    const bogusBody = (await bogus.json()) as { events: unknown[] };
    expect(bogusBody.events.length).toBe(allBody.events.length);
  });
});
