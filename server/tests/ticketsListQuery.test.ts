/**
 * GET /api/tickets listQuery paging + honest pri/state filters (Loop 59).
 *
 * Env must be set before any app module import — settings resolves its path
 * at construction (same rule as routes.test.ts).
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Request } from 'express';

let server: Server;
let base: string;
let tmpDir: string;
let applyTicketQueueFilters: typeof import('../src/routes/screens/ticketsScreen').applyTicketQueueFilters;

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'hpe-tickets-list-'));
  process.env.HPE_SETTINGS_PATH = join(tmpDir, 'settings.json');
  process.env.HPE_DATA_DIR = join(tmpDir, 'data');
  mkdirSync(join(tmpDir, 'data'), { recursive: true });
  writeFileSync(join(tmpDir, 'settings.json'), JSON.stringify({ demoMode: true }), 'utf8');

  ({ applyTicketQueueFilters } = await import('../src/routes/screens/ticketsScreen'));
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

function req(query: Record<string, string>): Request {
  return { query } as unknown as Request;
}

describe('applyTicketQueueFilters', () => {
  const body = {
    tickets: [
      { id: 'a', pri: 'P1', state: 'open', title: 'one' },
      { id: 'b', pri: 'P2', state: 'in progress', title: 'two' },
      { id: 'c', pri: 'P1', state: 'resolved', title: 'three' },
    ],
  };

  it('leaves the queue alone when pri/state omitted', () => {
    expect(applyTicketQueueFilters(req({}), body)).toEqual({ body });
  });

  it('filters by exact pri and openish state', () => {
    const out = applyTicketQueueFilters(req({ pri: 'P1', state: 'openish' }), body);
    expect('error' in out).toBe(false);
    if ('error' in out) return;
    expect((out.body.tickets as { id: string }[]).map((t) => t.id)).toEqual(['a']);
  });

  it('400-style errors on unknown pri/state rather than silent full queue', () => {
    expect(applyTicketQueueFilters(req({ pri: 'P9' }), body)).toEqual({
      error: "pri must be 'P1', 'P2', or 'P3'",
    });
    expect(applyTicketQueueFilters(req({ state: 'closed' }), body)).toMatchObject({
      error: expect.stringContaining('state must be'),
    });
  });

  it('trims pri/state/site via shared queryString (Loop 116)', () => {
    const out = applyTicketQueueFilters(req({ pri: '  P1  ', state: '  openish  ' }), body);
    expect('error' in out).toBe(false);
    if ('error' in out) return;
    expect((out.body.tickets as { id: string }[]).map((t) => t.id)).toEqual(['a']);

    // Non-string query values are honest no-ops (no invented 400).
    const junk = applyTicketQueueFilters(
      { query: { pri: ['P1'], state: 12 } } as unknown as Request,
      body,
    );
    expect(junk).toEqual({ body });
  });
});

describe('GET /api/tickets list paging', () => {
  async function getJson(path: string) {
    const r = await fetch(`${base}${path}`);
    return { status: r.status, body: (await r.json()) as Record<string, unknown> };
  }

  it('omits page envelope when limit is absent (backward compatible)', async () => {
    const { status, body } = await getJson('/api/tickets');
    expect(status).toBe(200);
    expect(Array.isArray(body.tickets)).toBe(true);
    expect((body.tickets as unknown[]).length).toBeGreaterThan(0);
    expect(body.page).toBeUndefined();
  });

  it('attaches page meta and slices when limit is set', async () => {
    const first = await getJson('/api/tickets?limit=1');
    expect(first.status).toBe(200);
    const tickets = first.body.tickets as unknown[];
    expect(tickets).toHaveLength(1);
    const page = first.body.page as {
      total: number;
      limit: number;
      cursor: number;
      nextCursor: string | null;
    };
    expect(page.limit).toBe(1);
    expect(page.total).toBeGreaterThanOrEqual(1);
    if (page.total > 1) {
      expect(page.nextCursor).toBeTruthy();
      const second = await getJson(
        `/api/tickets?limit=1&cursor=${encodeURIComponent(String(page.nextCursor))}`,
      );
      expect(second.status).toBe(200);
      expect((second.body.tickets as unknown[]).length).toBeGreaterThanOrEqual(1);
      const id1 = (tickets[0] as { id: string }).id;
      const id2 = ((second.body.tickets as { id: string }[])[0] ?? {}).id;
      expect(id2).not.toBe(id1);
    }
  });

  it('honors pri filter before paging and rejects unknown pri', async () => {
    const bad = await getJson('/api/tickets?pri=P9');
    expect(bad.status).toBe(400);

    const ok = await getJson('/api/tickets?pri=P1&limit=50');
    expect(ok.status).toBe(200);
    expect((ok.body.tickets as unknown[]).length).toBeGreaterThan(0);
    for (const t of ok.body.tickets as { pri?: string }[]) {
      expect(t.pri).toBe('P1');
    }
  });

  it('honors openish state (excludes resolved) and q text filter', async () => {
    const openish = await getJson('/api/tickets?state=openish');
    expect(openish.status).toBe(200);
    expect((openish.body.tickets as unknown[]).length).toBeGreaterThan(0);
    for (const t of openish.body.tickets as { state?: string }[]) {
      expect(t.state).not.toBe('resolved');
    }

    const q = await getJson(`/api/tickets?q=${encodeURIComponent('drops')}`);
    expect(q.status).toBe(200);
    const rows = q.body.tickets as { title?: string; id?: string }[];
    expect(rows.length).toBeGreaterThan(0);
    for (const t of rows) {
      const hay = `${t.title ?? ''} ${t.id ?? ''}`.toLowerCase();
      expect(hay).toContain('drops');
    }
  });
});
