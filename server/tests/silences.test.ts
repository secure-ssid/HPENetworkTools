/**
 * server/tests/silences.test.ts — the silence store and its routes.
 *
 * HPE_SETTINGS_PATH / HPE_DATA_DIR point at a tmp dir so the test never
 * touches real data/. The env vars must be set before the app modules are
 * imported (the silenceStore singleton resolves its dir at construction), so
 * everything from src/ is loaded with dynamic imports inside beforeAll — the
 * same harness routes.test.ts uses.
 *
 * Covered:
 *   store  — empty start, persistence across instances, 0600, stamped
 *            createdAt/until, expired annotated on read and filtered from
 *            active() but never deleted, remove() honest about unknown ids;
 *   routes — POST validation (reason required and capped, duration bounded,
 *            at least one matcher), 201 + audit line, GET, DELETE + audit,
 *            404 on unknown id;
 *   queue  — the /api/alerts payload serves deduped groups, and a silence
 *            moves a group OUT of the active list into `silenced` WITH its
 *            reason (suppression is visible, never invisible).
 */

import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { AlertSilence } from '@hpe/shared';

let server: Server;
let base: string;
let tmpDir: string;
let SilenceStore: typeof import('../src/services/silences').SilenceStore;
let silenceStore: typeof import('../src/services/silences').silenceStore;

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'hpe-silences-'));
  process.env.HPE_SETTINGS_PATH = join(tmpDir, 'settings.json');
  process.env.HPE_DATA_DIR = join(tmpDir, 'data');
  const mod = await import('../src/services/silences');
  SilenceStore = mod.SilenceStore;
  silenceStore = mod.silenceStore;
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

afterEach(() => {
  // The route tests share the singleton store; leave it empty for the next one.
  for (const s of silenceStore.list()) silenceStore.remove(s.id);
});

async function getJson(path: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${path}`);
  return { status: res.status, body: await res.json() };
}

async function sendJson(method: string, path: string, payload?: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

function auditEvents(): Record<string, unknown>[] {
  try {
    return readFileSync(join(tmpDir, 'data', 'change-log.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

describe('SilenceStore', () => {
  it('starts empty and persists across instances', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hpe-sil-store-'));
    try {
      const store = new SilenceStore(dir);
      expect(store.list()).toEqual([]);
      const s = store.create({ device: 'gw-edge-1', reason: 'ISP window', durationMinutes: 60 });
      expect(s.id).toMatch(/^sil-/);
      expect(new SilenceStore(dir).list()).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes the store file with mode 0600', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hpe-sil-store-'));
    try {
      new SilenceStore(dir).create({ plane: 'AOS-10', reason: 'x', durationMinutes: 60 });
      expect(statSync(join(dir, 'silences.json')).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('stamps createdAt and computes until from durationMinutes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hpe-sil-store-'));
    try {
      const now = Date.parse('2026-08-01T04:00:00.000Z');
      const s = new SilenceStore(dir).create({ titleContains: 'flap', reason: 'x', durationMinutes: 480 }, now);
      expect(s.createdAt).toBe('2026-08-01T04:00:00.000Z');
      expect(s.until).toBe('2026-08-01T12:00:00.000Z');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('flags expired silences on read, filters them from active(), and never deletes them', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hpe-sil-store-'));
    try {
      const store = new SilenceStore(dir);
      const liveAt = Date.parse('2026-08-01T04:00:00.000Z');
      store.create({ device: 'a', reason: 'old', durationMinutes: 60 }, liveAt - 120 * 60_000);
      store.create({ device: 'b', reason: 'current', durationMinutes: 60 }, liveAt);
      const listed = store.list(liveAt);
      expect(listed).toHaveLength(2); // the expired one is still listed…
      expect(listed.find((s) => s.reason === 'old')?.expired).toBe(true);
      expect(listed.find((s) => s.reason === 'current')?.expired).toBe(false);
      // …it just never applies again.
      expect(store.active(liveAt).map((s) => s.reason)).toEqual(['current']);
      // And it is still on disk for the next instance — expiry is not deletion.
      expect(new SilenceStore(dir).list(liveAt)).toHaveLength(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('removes by id and answers null for an unknown id', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hpe-sil-store-'));
    try {
      const store = new SilenceStore(dir);
      const s = store.create({ device: 'a', reason: 'x', durationMinutes: 60 });
      expect(store.remove('sil-nope')).toBeNull();
      expect(store.remove(s.id)?.id).toBe(s.id);
      expect(store.list()).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

describe('silence routes', () => {
  it('GET /api/silences starts empty', async () => {
    const { status, body } = await getJson('/api/silences');
    expect(status).toBe(200);
    expect(body.silences).toEqual([]);
  });

  it('POST /api/silences requires a reason', async () => {
    const { status, body } = await sendJson('POST', '/api/silences', { device: 'gw-edge-1', durationMinutes: 60 });
    expect(status).toBe(400);
    expect(body.error).toContain('reason required');
  });

  it('POST /api/silences refuses an over-length reason rather than truncating it', async () => {
    const { status, body } = await sendJson('POST', '/api/silences', {
      device: 'gw-edge-1',
      reason: 'x'.repeat(501),
      durationMinutes: 60,
    });
    expect(status).toBe(400);
    expect(body.error).toContain('the limit is 500');
  });

  it('POST /api/silences requires at least one matcher', async () => {
    const { status, body } = await sendJson('POST', '/api/silences', { reason: 'x', durationMinutes: 60 });
    expect(status).toBe(400);
    expect(body.error).toContain('at least one matcher');
  });

  it('POST /api/silences bounds the duration — silences are time-boxed', async () => {
    for (const durationMinutes of [0, -5, '60', 90 * 24 * 60 + 1]) {
      const { status, body } = await sendJson('POST', '/api/silences', { device: 'a', reason: 'x', durationMinutes });
      expect(status).toBe(400);
      expect(body.error).toContain('time-boxed');
    }
  });

  it('POST /api/silences creates, lists, audit-logs and deletes a silence', async () => {
    const created = await sendJson('POST', '/api/silences', {
      plane: 'AOS-10',
      device: 'gw-edge-1',
      reason: 'ISP maintenance window',
      durationMinutes: 480,
    });
    expect(created.status).toBe(201);
    const silence = created.body.silence as AlertSilence;
    expect(silence.id).toMatch(/^sil-/);
    expect(Date.parse(silence.until)).toBeGreaterThan(Date.parse(silence.createdAt));

    const listed = await getJson('/api/silences');
    expect(listed.body.silences).toHaveLength(1);
    expect(listed.body.silences[0].expired).toBe(false);

    const createLines = auditEvents().filter((e) => e.event === 'alert-silence');
    expect(createLines).toHaveLength(1);
    expect(createLines[0].changeId).toBe(silence.id);
    expect(createLines[0].ticket).toBe('—'); // not a brokered write — nothing leaves the portal
    expect(String(createLines[0].result)).toContain('ISP maintenance window');

    const removed = await sendJson('DELETE', `/api/silences/${silence.id}`);
    expect(removed.status).toBe(200);
    expect(removed.body.ok).toBe(true);
    expect((await getJson('/api/silences')).body.silences).toEqual([]);
    expect(auditEvents().filter((e) => e.event === 'alert-unsilence')).toHaveLength(1);
  });

  it('DELETE /api/silences/:id answers 404 for an unknown id and audits nothing', async () => {
    const before = auditEvents().length;
    const { status, body } = await sendJson('DELETE', '/api/silences/sil-nope');
    expect(status).toBe(404);
    expect(body.error).toContain('unknown silence');
    expect(auditEvents()).toHaveLength(before);
  });
});

// ---------------------------------------------------------------------------
// The /api/alerts queue view (demo fixtures: the tunnel-flap alert fires ×3)
// ---------------------------------------------------------------------------

describe('the /api/alerts payload', () => {
  it('serves deduped groups with counts', async () => {
    const { status, body } = await getJson('/api/alerts');
    expect(status).toBe(200);
    expect(Array.isArray(body.groups)).toBe(true);
    expect(body.silenced).toEqual([]);
    const flap = (body.groups as any[]).find((g) => g.latest.title.includes('tunnel flap'));
    expect(flap.count).toBe(3);
    expect(flap.firstSeen).toBe('55m');
    expect(flap.lastSeen).toBe('12m');
    const dhcp = (body.groups as any[]).find((g) => g.latest.title.includes('DHCP pool'));
    expect(dhcp.count).toBe(2);
    // The flat list keeps every firing, so nothing the groups collapse is lost.
    expect((body.alerts as any[]).filter((a) => a.title.includes('tunnel flap'))).toHaveLength(3);
  });

  it('moves a silenced group OUT of the active list into silenced — with its reason', async () => {
    await sendJson('POST', '/api/silences', {
      device: 'gw-edge-1',
      reason: 'tunnel rekey work',
      durationMinutes: 60,
    });
    const { body } = await getJson('/api/alerts');
    expect((body.groups as any[]).some((g) => g.latest.title.includes('tunnel flap'))).toBe(false);
    expect((body.alerts as any[]).some((a) => a.title.includes('tunnel flap'))).toBe(false);
    expect(body.silenced).toHaveLength(1);
    expect(body.silenced[0].group.count).toBe(3);
    expect(body.silenced[0].silence.reason).toBe('tunnel rekey work');
    // The banner derives from the active rows, so a silenced P1 could never
    // headline the queue — here the benched group simply cannot appear.
    expect(JSON.stringify(body.correlation ?? {})).not.toContain('tunnel flap');
  });

  it('restores the group after an unsilence', async () => {
    const created = await sendJson('POST', '/api/silences', {
      titleContains: 'tunnel flap',
      reason: 'x',
      durationMinutes: 60,
    });
    await sendJson('DELETE', `/api/silences/${created.body.silence.id}`);
    const { body } = await getJson('/api/alerts');
    expect(body.silenced).toEqual([]);
    expect((body.groups as any[]).some((g) => g.latest.title.includes('tunnel flap'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The Overview respects the same silences (routes/screens.ts + overviewModel)
// ---------------------------------------------------------------------------

describe('the /api/overview payload', () => {
  const openAlertsTile = (body: any) => (body.stats as any[]).find((s) => s.label === 'Open alerts');

  it('demo: a silenced panel row leaves "Needs you now" and the tile says so', async () => {
    const before = await getJson('/api/overview');
    expect(before.body.alerts).toHaveLength(5); // the authored panel rows
    expect(openAlertsTile(before.body)).toMatchObject({ value: '7', delta: '▲ 2 critical' });

    // The P2 'sw-core-a PSU 2 absent' row is one of the seven the tile counts.
    await sendJson('POST', '/api/silences', {
      titleContains: 'PSU 2 absent',
      reason: 'PSU on order',
      durationMinutes: 60,
    });
    const hushed = await getJson('/api/overview');
    const titles = (hushed.body.alerts as any[]).map((a) => a.title);
    expect(titles).toHaveLength(4);
    expect(titles.some((t: string) => t.includes('PSU 2 absent'))).toBe(false);
    // The tile drops the hushed row and NAMES the hush — the estate must not
    // read quieter than it is.
    expect(openAlertsTile(hushed.body)).toMatchObject({
      value: '6',
      delta: '▲ 2 critical · 1 silenced',
      tone: 'negative',
    });
  });

  it('demo: silencing both P1s turns the tile critical line into none-critical-plus-silenced', async () => {
    await sendJson('POST', '/api/silences', {
      device: 'mm-lake-1',
      reason: 'cluster rebuild',
      durationMinutes: 60,
    });
    await sendJson('POST', '/api/silences', {
      titleContains: 'sync stalled',
      reason: 'classic gateway being replaced',
      durationMinutes: 60,
    });
    const { body } = await getJson('/api/overview');
    const titles = (body.alerts as any[]).map((a) => a.title);
    expect(titles).toHaveLength(3); // the P2/P3 rows are all that is left
    expect(titles.every((t: string) => !t.includes('mm-lake-1') && !t.includes('sync stalled'))).toBe(true);
    expect(openAlertsTile(body)).toMatchObject({
      value: '5',
      delta: 'none critical · 2 silenced',
    });
    // The P1s are benched, not gone — the Alerts screen still lists them under
    // SILENCED, so the two screens tell one story.
    const alerts = await getJson('/api/alerts');
    expect(alerts.body.silenced.length).toBeGreaterThan(0);
  });

  it('demo: an unsilence restores the panel and the tile exactly', async () => {
    const created = await sendJson('POST', '/api/silences', {
      titleContains: 'PSU 2 absent',
      reason: 'PSU on order',
      durationMinutes: 60,
    });
    await sendJson('DELETE', `/api/silences/${created.body.silence.id}`);
    const { body } = await getJson('/api/overview');
    expect(body.alerts).toHaveLength(5);
    expect(openAlertsTile(body)).toMatchObject({ value: '7', delta: '▲ 2 critical' });
  });

  it('demoOverviewQueue: an expired silence hushes nothing', async () => {
    const { demoOverviewQueue } = await import('../src/routes/screens/overviewModel');
    silenceStore.create({ device: 'sw-core-a', reason: 'already over', durationMinutes: 1 }, Date.now() - 120_000);
    const queue = demoOverviewQueue();
    expect(queue.alerts).toHaveLength(5);
    expect(queue.stats.find((s) => s.label === 'Open alerts')).toMatchObject({ value: '7', delta: '▲ 2 critical' });
  });
});
