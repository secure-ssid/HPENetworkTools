/**
 * server/tests/maintenance.test.ts — the window store, the scheduler, and the routes.
 *
 * HPE_SETTINGS_PATH / HPE_DATA_DIR point at a tmp dir so the test never
 * touches real data/. The env vars must be set before the app modules are
 * imported (the store singletons resolve their dir at construction), so
 * everything from src/ is loaded with dynamic imports inside beforeAll — the
 * same harness silences.test.ts uses.
 *
 * Covered:
 *   store     — empty start, persistence across instances, 0600, expired
 *               flagged on read and never deleted, enable/disable, remove,
 *               the materialization stamp surviving a restart;
 *   scheduler — an active window materializes ONE silence through the real
 *               silence store (window reason, exact span end, windowId
 *               stamped), audit-logged 'maintenance-window'; a second tick
 *               does not double-materialize; an operator's silence deletion
 *               is not undone for that span; disabled/expired windows sit out;
 *               demo fixtures contribute VIRTUAL silences, demo mode only;
 *   queue     — a site-scoped window silence benches only its own site's
 *               group (the second partition phase);
 *   routes    — GET lists real + labelled fixture windows; POST validation
 *               (reason required and capped, a silence-expressible matcher
 *               required, sane once/weekly schedules); PATCH/DELETE + 404s;
 *               every mutation audit-logged.
 */

import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { isValidTimeZone, resolveServerTimeZone } from '@hpe/shared';
import type { AlertRow, MaintenanceWindow } from '@hpe/shared';

let server: Server;
let base: string;
let tmpDir: string;
let MaintenanceStore: typeof import('../src/services/maintenance').MaintenanceStore;
let MaintenanceService: typeof import('../src/services/maintenance').MaintenanceService;
let SilenceStore: typeof import('../src/services/silences').SilenceStore;
let alertQueueView: typeof import('../src/services/silences').alertQueueView;
let registerFixtureSilenceSource: typeof import('../src/services/silences').registerFixtureSilenceSource;

const T0 = Date.parse('2026-08-04T03:00:00.000Z'); // a Tuesday

function weeklyWindow(days: number[], startTime: string, endTime: string): MaintenanceWindow['schedule'] {
  return { kind: 'weekly', days, startTime, endTime, tz: 'UTC' };
}

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'hpe-maintenance-'));
  process.env.HPE_SETTINGS_PATH = join(tmpDir, 'settings.json');
  process.env.HPE_DATA_DIR = join(tmpDir, 'data');
  const mod = await import('../src/services/maintenance');
  MaintenanceStore = mod.MaintenanceStore;
  MaintenanceService = mod.MaintenanceService;
  const sil = await import('../src/services/silences');
  SilenceStore = sil.SilenceStore;
  alertQueueView = sil.alertQueueView;
  registerFixtureSilenceSource = sil.registerFixtureSilenceSource;
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
  registerFixtureSilenceSource(null);
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

function auditEvents(dir: string): Record<string, unknown>[] {
  try {
    return readFileSync(join(dir, 'change-log.jsonl'), 'utf8')
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

describe('MaintenanceStore', () => {
  it('starts empty, persists across instances, writes 0600', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hpe-mw-store-'));
    try {
      const store = new MaintenanceStore(dir);
      expect(store.list()).toEqual([]);
      const w = store.create(
        { reason: 'ISP cutover', matchers: { device: 'gw-edge-1' }, schedule: weeklyWindow([2], '02:00', '04:00'), enabled: true, createdBy: 'operator' },
        T0,
      );
      expect(w.id).toMatch(/^mw-/);
      expect(w.createdAt).toBe('2026-08-04T03:00:00.000Z');
      expect(statSync(join(dir, 'maintenance-windows.json')).mode & 0o777).toBe(0o600);
      expect(new MaintenanceStore(dir).list()).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('flags an expired one-shot on read and never deletes it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hpe-mw-store-'));
    try {
      const store = new MaintenanceStore(dir);
      store.create(
        {
          reason: 'done last week',
          matchers: { device: 'a' },
          schedule: { kind: 'once', start: '2026-07-01T02:00:00.000Z', end: '2026-07-01T04:00:00.000Z' },
          enabled: true,
          createdBy: 'operator',
        },
        Date.parse('2026-07-01T00:00:00.000Z'),
      );
      const listed = store.list(T0);
      expect(listed).toHaveLength(1);
      expect(listed[0].expired).toBe(true);
      expect(new MaintenanceStore(dir).list(T0)).toHaveLength(1); // still on disk
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('enables/disables, removes, and keeps the materialization stamp across instances', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hpe-mw-store-'));
    try {
      const store = new MaintenanceStore(dir);
      const w = store.create(
        { reason: 'x', matchers: { device: 'a' }, schedule: weeklyWindow([2], '02:00', '04:00'), enabled: true, createdBy: 'operator' },
        T0,
      );
      expect(store.setEnabled(w.id, false)?.enabled).toBe(false);
      expect(store.setEnabled('mw-nope', false)).toBeNull();
      store.markMaterialized(w.id, '2026-08-04T02:00:00.000Z');
      expect(new MaintenanceStore(dir).get(w.id)?.lastMaterialized).toBe('2026-08-04T02:00:00.000Z');
      expect(store.remove(w.id)?.id).toBe(w.id);
      expect(store.remove(w.id)).toBeNull();
      expect(store.list()).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Scheduler — windows materialize through the real silence store
// ---------------------------------------------------------------------------

describe('MaintenanceService', () => {
  function harness() {
    const dir = mkdtempSync(join(tmpdir(), 'hpe-mw-svc-'));
    const store = new MaintenanceStore(dir);
    const silences = new SilenceStore(dir);
    const service = new MaintenanceService({ store, silences, dataDir: dir, nowMs: () => T0, demoMode: () => false });
    return { dir, store, silences, service };
  }

  it('an active window materializes exactly one silence, audit-logged as a window', () => {
    const { dir, store, silences, service } = harness();
    try {
      const w = store.create(
        { reason: 'AP firmware staging', matchers: { device: 'ap-3f-12' }, schedule: weeklyWindow([2], '02:00', '04:00'), enabled: true, createdBy: 'operator' },
        T0,
      );
      expect(service.tick().materialized).toBe(1);
      const raised = silences.list(T0);
      expect(raised).toHaveLength(1);
      expect(raised[0].reason).toBe('AP firmware staging');
      expect(raised[0].device).toBe('ap-3f-12');
      expect(raised[0].until).toBe('2026-08-04T04:00:00.000Z'); // the span's exact end
      expect(raised[0].windowId).toBe(w.id);
      expect(store.get(w.id)?.lastMaterialized).toBe('2026-08-04T02:00:00.000Z');
      // …and a second tick for the same span raises nothing.
      expect(service.tick().materialized).toBe(0);
      expect(silences.list(T0)).toHaveLength(1);
      const audit = auditEvents(dir).filter((e) => e.event === 'maintenance-window');
      expect(audit).toHaveLength(1);
      expect(audit[0].changeId).toBe(raised[0].id);
      expect(String(audit[0].result)).toContain(w.id);
      expect(audit[0].ticket).toBe('—'); // not a brokered write
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('an operator deleting the silence is not re-silenced for the rest of the span', () => {
    const { dir, store, silences, service } = harness();
    try {
      store.create(
        { reason: 'x', matchers: { device: 'a' }, schedule: weeklyWindow([2], '02:00', '04:00'), enabled: true, createdBy: 'operator' },
        T0,
      );
      service.tick();
      const raised = silences.list(T0)[0];
      silences.remove(raised.id);
      expect(service.tick().materialized).toBe(0); // the stamp holds
      expect(silences.list(T0)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('disabled, upcoming and expired windows materialize nothing; a matcher-less one never could', () => {
    const { dir, store, silences, service } = harness();
    try {
      store.create(
        { reason: 'disabled', matchers: { device: 'a' }, schedule: weeklyWindow([2], '02:00', '04:00'), enabled: false, createdBy: 'operator' },
        T0,
      );
      store.create(
        { reason: 'upcoming', matchers: { device: 'b' }, schedule: weeklyWindow([2], '05:00', '06:00'), enabled: true, createdBy: 'operator' },
        T0,
      );
      store.create(
        {
          reason: 'expired',
          matchers: { device: 'c' },
          schedule: { kind: 'once', start: '2026-07-01T02:00:00.000Z', end: '2026-07-01T04:00:00.000Z' },
          enabled: true,
          createdBy: 'operator',
        },
        T0,
      );
      expect(service.tick().materialized).toBe(0);
      expect(silences.list(T0)).toEqual([]);
      expect(auditEvents(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the window silence expires on its own at the window’s end', () => {
    const { dir, store, silences, service } = harness();
    try {
      store.create(
        { reason: 'x', matchers: { device: 'a' }, schedule: weeklyWindow([2], '02:00', '04:00'), enabled: true, createdBy: 'operator' },
        T0,
      );
      service.tick();
      const end = Date.parse('2026-08-04T04:00:00.000Z');
      expect(silences.active(end - 1)).toHaveLength(1);
      expect(silences.active(end)).toHaveLength(0); // expired, not deleted
      expect(silences.list(end)).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('demo fixtures contribute VIRTUAL silences — demo mode only, never persisted', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hpe-mw-svc-'));
    try {
      const demo = new MaintenanceService({ store: new MaintenanceStore(dir), silences: new SilenceStore(dir), dataDir: dir, nowMs: () => T0, demoMode: () => true });
      const virtual = demo.fixtureSilences(T0);
      expect(virtual.some((s) => s.id === 'mw-sil-mw-demo-ap3f')).toBe(true);
      expect(virtual.every((s) => s.windowId?.startsWith('mw-demo-'))).toBe(true);
      expect(new SilenceStore(dir).list(T0)).toEqual([]); // nothing written
      const live = new MaintenanceService({ store: new MaintenanceStore(dir), silences: new SilenceStore(dir), dataDir: dir, nowMs: () => T0, demoMode: () => false });
      expect(live.fixtureSilences(T0)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// The queue view — site-scoped window silences narrow to their site
// ---------------------------------------------------------------------------

describe('alertQueueView with a site-scoped silence', () => {
  const row = (device: string, site: string, siteId: AlertRow['siteId']): AlertRow => ({
    sev: 'P2',
    tone: 'warning',
    title: 'Wi-Fi drops, 3rd floor east — 22 clients',
    detail: 'dfs radar events',
    siteId,
    siteName: site,
    plane: 'MIST',
    state: 'open',
    age: '10m',
    device,
  });

  it('benches only the group at the named site', () => {
    registerFixtureSilenceSource(() => [
      {
        id: 'mw-sil-test',
        titleContains: 'Wi-Fi drops',
        site: 'Campus-02 Research',
        reason: 'window hush',
        createdAt: new Date(T0 - 60_000).toISOString(),
        until: new Date(T0 + 60_000).toISOString(),
        windowId: 'mw-test',
      },
    ]);
    const view = alertQueueView(
      [row('ap-3f-12', 'Campus-02 Research', 'campus-02'), row('ap-9f-01', 'Northgate Annex', 'northgate')],
      T0,
    );
    expect(view.silenced).toHaveLength(1);
    expect(view.silenced[0].group.latest.siteName).toBe('Campus-02 Research');
    expect(view.groups.map((g) => g.latest.siteName)).toEqual(['Northgate Annex']);
    // The benched firing leaves the flat rows too — the queue and its counts
    // always agree.
    expect(view.alerts.map((a) => a.device)).toEqual(['ap-9f-01']);
  });
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

describe('maintenance-window routes', () => {
  const created: string[] = [];

  afterEach(async () => {
    for (const id of created.splice(0)) await sendJson('DELETE', `/api/maintenance-windows/${id}`);
  });

  it('GET lists the demo fixtures, labelled, when the store is empty', async () => {
    const { status, body } = await getJson('/api/maintenance-windows');
    expect(status).toBe(200);
    const ids = (body.windows as any[]).map((w) => w.id);
    expect(ids).toContain('mw-demo-ap3f');
    expect(ids).toContain('mw-demo-firmware');
    for (const w of body.windows) {
      expect(w.demo).toBe(true);
      expect(['active', 'upcoming', 'expired']).toContain(w.state);
    }
    const ap = (body.windows as any[]).find((w) => w.id === 'mw-demo-ap3f');
    expect(ap.state).toBe('active');
    expect(typeof ap.spanStart).toBe('string');
  });

  it('GET /api/maintenance-windows/export returns CSV (Loop 93) and honours state=', async () => {
    const csv = await fetch(`${base}/api/maintenance-windows/export`);
    expect(csv.status).toBe(200);
    expect(csv.headers.get('content-type') ?? '').toMatch(/text\/csv/);
    const text = await csv.text();
    const header = text.split('\n')[0] ?? '';
    expect(header).toContain('id');
    expect(header).toContain('reason');
    expect(header).toContain('schedule');
    expect(header).toContain('state');
    expect(text).toContain('mw-demo-ap3f');
    expect(text).not.toMatch(/api[_-]?key\s*[:=]|bearer\s+[a-z0-9._-]+|password|secret/i);

    const active = await fetch(`${base}/api/maintenance-windows/export?state=active`);
    expect(active.status).toBe(200);
    const activeText = await active.text();
    expect(activeText).toContain('mw-demo-ap3f');
    // Firmware demo fixture is upcoming, not active.
    expect(activeText).not.toContain('mw-demo-firmware');

    const enabledOff = await fetch(`${base}/api/maintenance-windows/export?enabled=0`);
    expect(enabledOff.status).toBe(200);
    // Demo fixtures are enabled; disabled filter should be headers-only or no demo ids.
    const offText = await enabledOff.text();
    expect(offText.split('\n')[0]).toContain('id');
    expect(offText).not.toContain('mw-demo-ap3f');
  });

  it('GET /api/maintenance-windows and export honour q= text filter (Loop 114)', async () => {
    const { filterMaintenanceWindows } = await import('../src/routes/maintenance');
    const sample = [
      {
        id: 'mw-loop114-ap',
        enabled: true,
        state: 'active' as const,
        reason: 'RF survey night window',
        matchers: { device: 'ap-floor-loop114', plane: 'MIST' },
        schedule: { kind: 'once' as const, start: '2027-01-01T00:00:00.000Z', end: '2027-01-01T01:00:00.000Z' },
        createdAt: '2026-08-04T00:00:00.000Z',
      },
      {
        id: 'mw-loop114-core',
        enabled: true,
        state: 'upcoming' as const,
        reason: 'Core switch cutover',
        matchers: { device: 'sw-core-1', site: 'HQ' },
        schedule: { kind: 'once' as const, start: '2027-02-01T00:00:00.000Z', end: '2027-02-01T02:00:00.000Z' },
        createdAt: '2026-08-04T00:00:00.000Z',
      },
    ];
    expect(
      filterMaintenanceWindows({ query: { q: 'survey' } }, sample as any).map((w) => w.id),
    ).toEqual(['mw-loop114-ap']);
    expect(
      filterMaintenanceWindows({ query: { q: 'MIST' } }, sample as any).map((w) => w.id),
    ).toEqual(['mw-loop114-ap']);
    expect(
      filterMaintenanceWindows({ query: { q: 'sw-core' } }, sample as any).map((w) => w.id),
    ).toEqual(['mw-loop114-core']);
    expect(filterMaintenanceWindows({ query: { q: 'nope' } }, sample as any)).toEqual([]);
    expect(filterMaintenanceWindows({ query: {} }, sample as any)).toHaveLength(2);
    // unknown state is a no-op (full list)
    expect(filterMaintenanceWindows({ query: { state: 'bogus' } }, sample as any)).toHaveLength(2);

    const list = await fetch(`${base}/api/maintenance-windows?q=ap3f`);
    expect(list.status).toBe(200);
    const body = (await list.json()) as { windows: Array<{ id: string }> };
    expect(body.windows.some((w) => w.id === 'mw-demo-ap3f')).toBe(true);
    expect(body.windows.every((w) => /ap3f|ap-3f|3f/i.test(JSON.stringify(w)))).toBe(true);

    const csv = await fetch(`${base}/api/maintenance-windows/export?q=firmware&state=upcoming`);
    expect(csv.status).toBe(200);
    const text = await csv.text();
    expect(text).toContain('mw-demo-firmware');
    expect(text).not.toContain('mw-demo-ap3f');
  });

  it('POST requires a reason and caps it', async () => {
    const noReason = await sendJson('POST', '/api/maintenance-windows', {
      matchers: { device: 'a' },
      schedule: { kind: 'once', start: '2027-01-01T02:00:00.000Z', end: '2027-01-01T04:00:00.000Z' },
    });
    expect(noReason.status).toBe(400);
    expect(noReason.body.error).toContain('reason required');
    const tooLong = await sendJson('POST', '/api/maintenance-windows', {
      reason: 'x'.repeat(501),
      matchers: { device: 'a' },
      schedule: { kind: 'once', start: '2027-01-01T02:00:00.000Z', end: '2027-01-01T04:00:00.000Z' },
    });
    expect(tooLong.status).toBe(400);
    expect(tooLong.body.error).toContain('the limit is 500');
  });

  it('POST requires a silence-expressible matcher — site alone cannot hush', async () => {
    const none = await sendJson('POST', '/api/maintenance-windows', {
      reason: 'x',
      matchers: {},
      schedule: { kind: 'once', start: '2027-01-01T02:00:00.000Z', end: '2027-01-01T04:00:00.000Z' },
    });
    expect(none.status).toBe(400);
    expect(none.body.error).toContain('plane, device or titleSubstring');
    const siteOnly = await sendJson('POST', '/api/maintenance-windows', {
      reason: 'x',
      matchers: { site: 'Campus-02 Research' },
      schedule: { kind: 'once', start: '2027-01-01T02:00:00.000Z', end: '2027-01-01T04:00:00.000Z' },
    });
    expect(siteOnly.status).toBe(400);
  });

  it('POST refuses broken schedules with named problems', async () => {
    const base = { reason: 'x', matchers: { device: 'a' } };
    const inverted = await sendJson('POST', '/api/maintenance-windows', {
      ...base,
      schedule: { kind: 'once', start: '2027-01-01T04:00:00.000Z', end: '2027-01-01T02:00:00.000Z' },
    });
    expect(inverted.status).toBe(400);
    expect(inverted.body.error).toContain('end after it starts');
    const noDays = await sendJson('POST', '/api/maintenance-windows', {
      ...base,
      schedule: { kind: 'weekly', days: [], startTime: '02:00', endTime: '04:00' },
    });
    expect(noDays.status).toBe(400);
    expect(noDays.body.error).toContain('weekday');
    const zeroLength = await sendJson('POST', '/api/maintenance-windows', {
      ...base,
      schedule: { kind: 'weekly', days: [6], startTime: '02:00', endTime: '02:00' },
    });
    expect(zeroLength.status).toBe(400);
    expect(zeroLength.body.error).toContain('same');
    const badTz = await sendJson('POST', '/api/maintenance-windows', {
      ...base,
      schedule: { kind: 'weekly', days: [6], startTime: '02:00', endTime: '04:00', tz: 'Mars/Olympus' },
    });
    expect(badTz.status).toBe(400);
    expect(badTz.body.error).toContain('unknown time zone');
    const badKind = await sendJson('POST', '/api/maintenance-windows', { ...base, schedule: { kind: 'monthly' } });
    expect(badKind.status).toBe(400);
    expect(badKind.body.error).toContain('once');
  });

  it('a weekly window created without a zone comes back pinned to one', async () => {
    const res = await sendJson('POST', '/api/maintenance-windows', {
      reason: 'core switch stack firmware',
      matchers: { device: 'sw-core-1' },
      schedule: { kind: 'weekly', days: [6], startTime: '02:00', endTime: '04:00' },
    });
    expect(res.status).toBe(201);
    const w = res.body.window as MaintenanceWindow;
    created.push(w.id);
    // Unpinned, '02:00' means whatever zone this process is restarted into.
    // The operator chose 02:00 on the clock the server was keeping when they
    // pressed the button, and that intent is only knowable at that moment.
    const schedule = w.schedule as Extract<MaintenanceWindow['schedule'], { kind: 'weekly' }>;
    expect(schedule.tz).toBeTruthy();
    expect(isValidTimeZone(schedule.tz!)).toBe(true);
    expect(schedule.tz).toBe(resolveServerTimeZone());

    // It survives the round-trip to disk, which is the point — the pin has to
    // outlive the process that made it.
    const listed = await getJson('/api/maintenance-windows');
    const back = (listed.body.windows as any[]).find((x) => x.id === w.id);
    expect(back.schedule.tz).toBe(schedule.tz);
  });

  it('an explicit zone is never overwritten by the server\'s own', async () => {
    const res = await sendJson('POST', '/api/maintenance-windows', {
      reason: 'London DC power work',
      matchers: { device: 'gw-lon-1' },
      schedule: { kind: 'weekly', days: [0], startTime: '01:00', endTime: '05:00', tz: 'Europe/London' },
    });
    expect(res.status).toBe(201);
    const w = res.body.window as MaintenanceWindow;
    created.push(w.id);
    expect((w.schedule as any).tz).toBe('Europe/London');
  });

  it('POST creates, GET annotates, PATCH toggles, DELETE removes — all audited', async () => {
    const before = auditEvents(join(tmpDir, 'data')).length;
    const createdRes = await sendJson('POST', '/api/maintenance-windows', {
      reason: 'ISP cutover, ticket NET-4211',
      matchers: { device: 'gw-edge-1', site: 'Campus-01 HQ' },
      // Tomorrow's weekday in UTC, 22:00-23:00: strictly ahead of any instant
      // today, so 'upcoming' holds whatever time the suite actually runs at.
      // (The overnight-crossing case this once posted is covered properly, at a
      // pinned `now`, in maintenanceWindows.test.ts.)
      schedule: { kind: 'weekly', days: [(new Date().getUTCDay() + 1) % 7], startTime: '22:00', endTime: '23:00', tz: 'UTC' },
    });
    expect(createdRes.status).toBe(201);
    const w = createdRes.body.window as MaintenanceWindow;
    expect(w.id).toMatch(/^mw-/);
    expect(w.enabled).toBe(true);
    created.push(w.id);

    const listed = await getJson('/api/maintenance-windows');
    const annotated = (listed.body.windows as any[]).find((x) => x.id === w.id);
    expect(annotated.demo).toBeUndefined();
    expect(annotated.state).toBe('upcoming');
    expect(typeof annotated.spanStart).toBe('string');

    const toggled = await sendJson('PATCH', `/api/maintenance-windows/${w.id}`, { enabled: false });
    expect(toggled.status).toBe(200);
    expect(toggled.body.window.enabled).toBe(false);
    expect((await sendJson('PATCH', `/api/maintenance-windows/${w.id}`, { note: 'x' })).status).toBe(400);
    expect((await sendJson('PATCH', '/api/maintenance-windows/mw-nope', { enabled: false })).status).toBe(404);

    const removed = await sendJson('DELETE', `/api/maintenance-windows/${w.id}`);
    expect(removed.status).toBe(200);
    expect(removed.body.ok).toBe(true);
    created.pop();
    expect((await sendJson('DELETE', `/api/maintenance-windows/${w.id}`)).status).toBe(404);

    const lines = auditEvents(join(tmpDir, 'data')).slice(before);
    const events = lines.filter((e) => e.event === 'maintenance-window').map((e) => String(e.result));
    expect(events.some((r) => r.includes('created'))).toBe(true);
    expect(events.some((r) => r.includes('disabled'))).toBe(true);
    expect(events.some((r) => r.includes('deleted'))).toBe(true);
    expect(lines.every((e) => e.ticket === '—')).toBe(true); // not brokered writes
  });

  it('the demo fixtures are not writable through the API', async () => {
    expect((await sendJson('PATCH', '/api/maintenance-windows/mw-demo-ap3f', { enabled: false })).status).toBe(404);
    expect((await sendJson('DELETE', '/api/maintenance-windows/mw-demo-ap3f')).status).toBe(404);
  });
});
