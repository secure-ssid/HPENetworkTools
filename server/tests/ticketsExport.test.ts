/**
 * GET /api/tickets/export — CSV of the operator ticket queue (no note bodies).
 * Loop 75: noteCount column + pri/state filter parity with the list route.
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
  tmpDir = mkdtempSync(join(tmpdir(), 'hpe-tickets-export-'));
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

function parseCsv(text: string): { header: string[]; rows: string[][] } {
  const lines = text
    .split('\n')
    .map((l) => l.replace(/\r$/, ''))
    .filter((l) => l.length > 0);
  const header = (lines[0] ?? '').split(',');
  const rows = lines.slice(1).map((l) => l.split(','));
  return { header, rows };
}

describe('GET /api/tickets/export', () => {
  it('returns CSV without note bodies but with noteCount', async () => {
    const r = await fetch(`${base}/api/tickets/export`);
    expect(r.status).toBe(200);
    const ct = r.headers.get('content-type') ?? '';
    expect(ct).toMatch(/text\/csv/);
    const text = await r.text();
    const { header } = parseCsv(text);
    expect(header).toContain('id');
    expect(header).toContain('noteCount');
    expect(text.toLowerCase()).not.toContain('note body');
    // Honesty: count is allowed; free-form note/notes body columns are not.
    expect(header).not.toContain('note');
    expect(header).not.toContain('notes');
  });

  it('honours pri filter and rejects unknown pri (Loop 75)', async () => {
    const all = parseCsv(await (await fetch(`${base}/api/tickets/export`)).text());
    const priIdx = all.header.indexOf('pri');
    expect(priIdx).toBeGreaterThanOrEqual(0);
    const p1 = parseCsv(await (await fetch(`${base}/api/tickets/export?pri=P1`)).text());
    expect(p1.rows.length).toBeGreaterThan(0);
    expect(p1.rows.every((row) => row[priIdx] === 'P1')).toBe(true);
    expect(p1.rows.length).toBeLessThanOrEqual(all.rows.length);

    const bad = await fetch(`${base}/api/tickets/export?pri=P9`);
    expect(bad.status).toBe(400);
  });

  it('honours site= exact filter on siteName/siteId (Loop 100)', async () => {
    // Titles contain commas, so assert filter parity via the JSON list rather
    // than naive CSV column splits; CSV still must return the same row count.
    type TicketLite = { siteName?: string; siteId?: string };
    const all = (await (await fetch(`${base}/api/tickets`)).json()) as { tickets: TicketLite[] };
    expect(all.tickets.length).toBeGreaterThan(0);
    const site = String(all.tickets[0]?.siteName ?? '').trim();
    expect(site.length).toBeGreaterThan(0);

    const filtered = (await (
      await fetch(`${base}/api/tickets?site=${encodeURIComponent(site)}`)
    ).json()) as { tickets: TicketLite[] };
    expect(filtered.tickets.length).toBeGreaterThan(0);
    expect(filtered.tickets.length).toBeLessThanOrEqual(all.tickets.length);
    for (const t of filtered.tickets) {
      const name = String(t.siteName ?? '')
        .trim()
        .toLowerCase();
      const id = String(t.siteId ?? '')
        .trim()
        .toLowerCase();
      expect(name === site.toLowerCase() || id === site.toLowerCase()).toBe(true);
    }

    const csvRes = await fetch(`${base}/api/tickets/export?site=${encodeURIComponent(site)}`);
    expect(csvRes.status).toBe(200);
    const csvText = await csvRes.text();
    const dataLines = csvText
      .split('\n')
      .map((l) => l.replace(/\r$/, ''))
      .filter((l) => l.length > 0).length - 1;
    expect(dataLines).toBe(filtered.tickets.length);

    // Stale site → honest empty (no 400).
    const empty = (await (
      await fetch(`${base}/api/tickets?site=__no_such_site__`)
    ).json()) as { tickets: TicketLite[] };
    expect(empty.tickets.length).toBe(0);
    const emptyCsv = await (await fetch(`${base}/api/tickets/export?site=__no_such_site__`)).text();
    const emptyLines = emptyCsv
      .split('\n')
      .map((l) => l.replace(/\r$/, ''))
      .filter((l) => l.length > 0).length - 1;
    expect(emptyLines).toBe(0);
  });
});
