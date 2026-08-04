/**
 * GET /api/auth-events + /api/auth-events/export — extracted authEventsScreen routes.
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
  tmpDir = mkdtempSync(join(tmpdir(), 'hpe-auth-events-export-'));
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

describe('authEventsScreen routes', () => {
  it('GET /api/auth-events returns envelope with events + stats', async () => {
    const r = await fetch(`${base}/api/auth-events`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      dataSource: string;
      events: unknown[];
      stats: unknown[];
    };
    expect(body.dataSource === 'demo' || body.dataSource === 'live').toBe(true);
    expect(Array.isArray(body.events)).toBe(true);
    expect(Array.isArray(body.stats)).toBe(true);
  });

  it('GET /api/auth-events/export returns CSV without secrets', async () => {
    const r = await fetch(`${base}/api/auth-events/export`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type') ?? '').toMatch(/text\/csv/);
    const text = await r.text();
    const header = text.split('\n')[0] ?? '';
    expect(header).toContain('who');
    expect(header).toContain('mac');
    expect(header).toContain('result');
    expect(header).toContain('plane');
    // Fixture reasons may say "Password expired…" — that is operator-visible
    // auth context, not a credential. Guard against export of secret material.
    expect(header).not.toMatch(/password|secret|token|apiKey|credential/i);
    expect(text).not.toMatch(/api[_-]?key\s*[:=]|bearer\s+[a-z0-9._-]+/i);
  });

  it('GET /api/auth-events?result=reject filters before paging', async () => {
    const r = await fetch(`${base}/api/auth-events?result=reject&limit=500`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { events: Array<{ result: string }> };
    expect(body.events.length).toBeGreaterThan(0);
    expect(body.events.every((e) => e.result === 'reject')).toBe(true);
  });

  it('GET /api/auth-events/export?result=&service= narrows CSV rows', async () => {
    const all = await fetch(`${base}/api/auth-events/export`);
    const allText = await all.text();
    const allLines = allText.split('\n').filter((l) => l.trim().length > 0);

    const r = await fetch(
      `${base}/api/auth-events/export?result=reject&service=${encodeURIComponent('MRDN Wireless 802.1X')}`,
    );
    expect(r.status).toBe(200);
    const text = await r.text();
    const lines = text.split('\n').filter((l) => l.trim().length > 0);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.length).toBeLessThan(allLines.length);
    // data rows only
    for (const line of lines.slice(1)) {
      expect(line.toLowerCase()).toContain('reject');
      expect(line.toLowerCase()).toContain('mrdn wireless 802.1x');
    }
  });

  it('GET /api/auth-events?method= exact filter (Loop 107)', async () => {
    const all = await fetch(`${base}/api/auth-events?limit=500`);
    const allBody = (await all.json()) as { events: Array<{ method: string }> };
    const sample = allBody.events.find((e) => e.method)?.method;
    expect(sample).toBeTruthy();
    const r = await fetch(
      `${base}/api/auth-events?method=${encodeURIComponent(sample!)}&limit=500`,
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as { events: Array<{ method: string }> };
    expect(body.events.length).toBeGreaterThan(0);
    expect(body.events.every((e) => e.method.toLowerCase() === sample!.toLowerCase())).toBe(true);
    expect(body.events.length).toBeLessThanOrEqual(allBody.events.length);

    const exp = await fetch(
      `${base}/api/auth-events/export?method=${encodeURIComponent(sample!)}`,
    );
    expect(exp.status).toBe(200);
    const text = await exp.text();
    for (const line of text.split('\n').filter((l) => l.trim()).slice(1)) {
      expect(line.toLowerCase()).toContain(sample!.toLowerCase());
    }
  });

  it('applyAuthEventExactFilters method is case-insensitive exact (Loop 107)', async () => {
    const { applyAuthEventExactFilters } = await import('../src/routes/screens/authEventsScreen');
    const body = {
      events: [
        { method: 'EAP-TLS', result: 'accept', service: 'A' },
        { method: 'MAB', result: 'accept', service: 'B' },
      ],
    };
    const filtered = applyAuthEventExactFilters(
      { query: { method: 'eap-tls' } } as never,
      body,
    ) as { events: Array<{ method: string }> };
    expect(filtered.events).toEqual([body.events[0]]);
    const noop = applyAuthEventExactFilters(
      { query: { method: '' } } as never,
      body,
    ) as { events: unknown[] };
    expect(noop.events).toHaveLength(2);
  });

  it('GET /api/auth-events?role= exact filter (Loop 115)', async () => {
    const all = await fetch(`${base}/api/auth-events?limit=500`);
    const allBody = (await all.json()) as { events: Array<{ role: string }> };
    const sample = allBody.events.find((e) => e.role)?.role;
    expect(sample).toBeTruthy();
    const r = await fetch(
      `${base}/api/auth-events?role=${encodeURIComponent(sample!)}&limit=500`,
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as { events: Array<{ role: string }> };
    expect(body.events.length).toBeGreaterThan(0);
    expect(body.events.every((e) => e.role.toLowerCase() === sample!.toLowerCase())).toBe(true);
    expect(body.events.length).toBeLessThanOrEqual(allBody.events.length);

    const exp = await fetch(
      `${base}/api/auth-events/export?role=${encodeURIComponent(sample!)}`,
    );
    expect(exp.status).toBe(200);
    const text = await exp.text();
    for (const line of text.split('\n').filter((l) => l.trim()).slice(1)) {
      expect(line.toLowerCase()).toContain(sample!.toLowerCase());
    }
  });

  it('applyAuthEventExactFilters role is case-insensitive exact (Loop 115)', async () => {
    const { applyAuthEventExactFilters } = await import('../src/routes/screens/authEventsScreen');
    const body = {
      events: [
        { role: 'Clinical staff', method: 'EAP-TLS', result: 'accept' },
        { role: 'Guest', method: 'MAB', result: 'accept' },
      ],
    };
    const filtered = applyAuthEventExactFilters(
      { query: { role: 'clinical staff' } } as never,
      body,
    ) as { events: Array<{ role: string }> };
    expect(filtered.events).toEqual([body.events[0]]);
    const noop = applyAuthEventExactFilters(
      { query: { role: '' } } as never,
      body,
    ) as { events: unknown[] };
    expect(noop.events).toHaveLength(2);
  });

  it('unknown result is a no-op (does not empty the feed)', async () => {
    const full = await fetch(`${base}/api/auth-events`);
    const filtered = await fetch(`${base}/api/auth-events?result=nope`);
    const a = (await full.json()) as { events: unknown[] };
    const b = (await filtered.json()) as { events: unknown[] };
    expect(b.events.length).toBe(a.events.length);
  });

  it('applyAuthEventRangeFilter keeps undated rows and windows by at (Loop 90)', async () => {
    const { applyAuthEventRangeFilter } = await import('../src/routes/screens/authEventsScreen');
    const now = Date.parse('2026-08-04T12:00:00.000Z');
    const body = {
      events: [
        { who: 'fresh', at: '2026-08-04T11:50:00.000Z' },
        { who: 'hour-old', at: '2026-08-04T10:30:00.000Z' },
        { who: 'day-old', at: '2026-08-03T13:00:00.000Z' },
        { who: 'undated', at: '' },
        { who: 'missing' },
      ],
    };
    const r15 = applyAuthEventRangeFilter({ query: { range: '15m' } }, body, now) as {
      events: Array<{ who: string }>;
    };
    expect(r15.events.map((e) => e.who).sort()).toEqual(['fresh', 'missing', 'undated']);

    const r1h = applyAuthEventRangeFilter({ query: { range: '1h' } }, body, now) as {
      events: Array<{ who: string }>;
    };
    expect(r1h.events.map((e) => e.who).sort()).toEqual(['fresh', 'missing', 'undated']);

    const r24 = applyAuthEventRangeFilter({ query: { range: '24h' } }, body, now) as {
      events: Array<{ who: string }>;
    };
    expect(r24.events.map((e) => e.who).sort()).toEqual([
      'day-old',
      'fresh',
      'hour-old',
      'missing',
      'undated',
    ]);

    const all = applyAuthEventRangeFilter({ query: { range: 'all' } }, body, now) as {
      events: unknown[];
    };
    expect(all.events).toHaveLength(5);
    const typo = applyAuthEventRangeFilter({ query: { range: '2h' } }, body, now) as {
      events: unknown[];
    };
    expect(typo.events).toHaveLength(5);
  });

  it('GET /api/auth-events?range= and export honour the window (Loop 90)', async () => {
    const all = await fetch(`${base}/api/auth-events?limit=500`);
    const allBody = (await all.json()) as { events: Array<{ at?: string }> };
    expect(allBody.events.length).toBeGreaterThan(0);

    const r = await fetch(`${base}/api/auth-events?range=15m&limit=500`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { events: Array<{ at?: string }> };
    expect(body.events.length).toBeLessThanOrEqual(allBody.events.length);

    const exp = await fetch(`${base}/api/auth-events/export?range=7d`);
    expect(exp.status).toBe(200);
    expect(exp.headers.get('content-type') ?? '').toMatch(/text\/csv/);
    const text = await exp.text();
    expect(text.split('\n')[0]).toContain('who');
  });
});
