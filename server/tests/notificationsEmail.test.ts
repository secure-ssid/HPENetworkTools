/**
 * server/tests/notificationsEmail.test.ts — the email channel's store and
 * routes: SMTP config, the report schedule, the SSL watch list.
 *
 * HPE_SETTINGS_PATH / HPE_DATA_DIR point at a tmp dir so the test never
 * touches real data/. The env vars must be set before the app modules are
 * imported (the notificationStore singleton resolves its dir at
 * construction), so everything from src/ is loaded with dynamic imports
 * inside beforeAll — the same harness notifications.test.ts uses. The tmp
 * settings file defaults to demoMode, which is exactly what the demo-path
 * route tests want; the live send paths are covered one level down in
 * reports.test.ts with the service's seams injected.
 *
 * Covered:
 *   store  — SMTP redaction at the view boundary (the password NEVER in a
 *            view or its JSON), the keep/clear/replace tri-state,
 *            persistence + 0600, report defaults and the outcome fields
 *            (lastSentAt moves only on sent/demo), SSL hosts + probe
 *            outcomes, ladder state, the demo cert stamp;
 *   routes — validation refuses (400) rather than repairs, the password
 *            never in any response body, CRUD + audit lines, the demo
 *            test-send and force-report landing in the outbox, the preview
 *            rendering in every mode, SSL host add/dup/remove/probe-demo.
 */

import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let server: Server;
let base: string;
let tmpDir: string;
let dataDir: string;
let NotificationStore: typeof import('../src/services/notifierStore').NotificationStore;

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'hpe-email-routes-'));
  dataDir = join(tmpDir, 'data');
  process.env.HPE_SETTINGS_PATH = join(tmpDir, 'settings.json');
  process.env.HPE_DATA_DIR = dataDir;
  NotificationStore = (await import('../src/services/notifierStore')).NotificationStore;
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
    return readFileSync(join(dataDir, 'change-log.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

describe('NotificationStore — email channel', () => {
  it('redacts the SMTP password at the view boundary — write-only, always', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hpe-email-store-'));
    try {
      const store = new NotificationStore(dir);
      store.setSmtp({ host: 'smtp.example.com', port: 587, user: 'svc', password: 'topsecret', from: 'r@example.com', tls: true });
      const view = store.smtpView()!;
      expect(view.passwordConfigured).toBe(true);
      expect('password' in view).toBe(false);
      expect(JSON.stringify(view)).not.toContain('topsecret');
      // The internal row keeps it — the mailer needs it.
      expect(store.smtp()!.password).toBe('topsecret');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the password tri-state: absent keeps, a string replaces, null clears', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hpe-email-store-'));
    try {
      const store = new NotificationStore(dir);
      store.setSmtp({ host: 'smtp.example.com', port: 587, password: 'one', from: 'r@example.com', tls: true });
      // Absent keeps (an edit that never touched the field).
      store.setSmtp({ host: 'smtp2.example.com', port: 25, from: 'r@example.com', tls: false });
      expect(store.smtp()!.password).toBe('one');
      expect(store.smtp()!.host).toBe('smtp2.example.com');
      // A string replaces.
      store.setSmtp({ host: 'smtp2.example.com', port: 25, password: 'two', from: 'r@example.com', tls: false });
      expect(store.smtp()!.password).toBe('two');
      // Null clears.
      store.setSmtp({ host: 'smtp2.example.com', port: 25, password: null, from: 'r@example.com', tls: false });
      expect(store.smtp()!.password).toBeUndefined();
      expect(store.smtpView()!.passwordConfigured).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('persists across instances at 0600, and clearSmtp removes the row', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hpe-email-store-'));
    try {
      const store = new NotificationStore(dir);
      store.setSmtp({ host: 'smtp.example.com', port: 587, from: 'r@example.com', tls: true });
      expect(statSync(join(dir, 'notification-email.json')).mode & 0o777).toBe(0o600);
      const reread = new NotificationStore(dir);
      expect(reread.smtp()!.host).toBe('smtp.example.com');
      expect(reread.clearSmtp()!.host).toBe('smtp.example.com');
      expect(new NotificationStore(dir).smtp()).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('report defaults, a schedule patch, and honest outcome fields', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hpe-email-store-'));
    try {
      const store = new NotificationStore(dir);
      expect(store.report()).toMatchObject({ enabled: false, frequency: 'daily', hour: 6, recipients: [] });
      store.setReport({ enabled: true, frequency: 'weekly', hour: 7, recipients: ['noc@example.com'] });
      expect(store.report()).toMatchObject({ enabled: true, frequency: 'weekly', hour: 7 });
      // A skipped fire: lastAttemptAt moves, lastSentAt must NOT.
      store.recordReportFire({ at: '2026-08-02T06:00:00.000Z', result: 'skipped', error: 'SMTP is not configured' });
      let report = store.report();
      expect(report.lastAttemptAt).toBe('2026-08-02T06:00:00.000Z');
      expect(report.lastSentAt).toBeUndefined();
      expect(report.lastError).toBe('SMTP is not configured');
      // A sent fire: lastSentAt moves, the error clears. A schedule edit
      // must not launder any of it.
      store.recordReportFire({ at: '2026-08-03T06:00:00.000Z', result: 'sent' });
      store.setReport({ hour: 8 });
      report = store.report();
      expect(report.lastResult).toBe('sent');
      expect(report.lastSentAt).toBe('2026-08-03T06:00:00.000Z');
      expect(report.lastError).toBeUndefined();
      expect(report.hour).toBe(8);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('SSL hosts: add, probe outcome on the row, remove — persisted', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hpe-email-store-'));
    try {
      const store = new NotificationStore(dir);
      const host = store.addSslHost({ host: 'vpn.example.com', port: 443 });
      store.recordSslProbe(host.id, { at: '2026-08-02T06:00:00.000Z', ok: false, error: 'connection refused' });
      const reread = new NotificationStore(dir);
      expect(reread.sslHosts()).toHaveLength(1);
      expect(reread.sslHosts()[0]!.lastProbe).toMatchObject({ ok: false, error: 'connection refused' });
      expect(reread.removeSslHost(host.id)!.host).toBe('vpn.example.com');
      expect(reread.removeSslHost('ssl-nope')).toBeNull();
      expect(new NotificationStore(dir).sslHosts()).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the ladder state and the demo cert stamp round-trip', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hpe-email-store-'));
    try {
      const store = new NotificationStore(dir);
      expect(store.expiryLadderState()).toEqual({});
      store.saveExpiryLadderState({ 'sub|SKU|AP@2026-09-16': 60 });
      store.setDemoCertExpiresAt('2026-08-23T12:00:00.000Z');
      const reread = new NotificationStore(dir);
      expect(reread.expiryLadderState()).toEqual({ 'sub|SKU|AP@2026-09-16': 60 });
      expect(reread.demoCertExpiresAt()).toBe('2026-08-23T12:00:00.000Z');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Routes — SMTP
// ---------------------------------------------------------------------------

describe('SMTP routes', () => {
  it('GET starts null; validation refuses junk rather than repairing it', async () => {
    expect((await getJson('/api/notifications/smtp')).body.smtp).toBeNull();
    for (const [payload, match] of [
      [{ from: 'r@example.com', tls: true }, 'host is required'],
      [{ host: 'smtp.example.com', tls: true }, 'from is required'],
      [{ host: 'smtp.example.com', from: 'r@example.com' }, 'tls must be a boolean'],
      [{ host: 'https://smtp.example.com', from: 'r@example.com', tls: true }, 'hostname'],
      [{ host: 'smtp.example.com', from: 'junk', tls: true }, 'from'],
      [{ host: 'smtp.example.com', from: 'r@example.com', tls: true, port: 0 }, 'port'],
      [{ host: 'smtp.example.com', from: 'r@example.com', tls: true, password: '' }, 'send null to clear'],
    ] as const) {
      const { status, body } = await sendJson('PUT', '/api/notifications/smtp', payload);
      expect(status).toBe(400);
      expect(body.error).toContain(match);
    }
  });

  it('PUT saves, the view redacts, an edit keeps the password, DELETE removes', async () => {
    const saved = await sendJson('PUT', '/api/notifications/smtp', {
      host: 'smtp.example.com',
      port: 587,
      user: 'svc-reports',
      password: 's3cret!',
      from: 'reports@example.com',
      tls: true,
    });
    expect(saved.status).toBe(200);
    expect(saved.body.smtp).toMatchObject({ host: 'smtp.example.com', port: 587, user: 'svc-reports', passwordConfigured: true, tls: true });
    expect(JSON.stringify(saved.body)).not.toContain('s3cret!');

    // An edit that never touches the password keeps it (passwordConfigured
    // stays true); the response never carries it.
    const edited = await sendJson('PUT', '/api/notifications/smtp', {
      host: 'smtp2.example.com',
      port: 25,
      from: 'reports@example.com',
      tls: false,
    });
    expect(edited.status).toBe(200);
    expect(edited.body.smtp).toMatchObject({ host: 'smtp2.example.com', port: 25, passwordConfigured: true });
    // Clearing is explicit.
    const cleared = await sendJson('PUT', '/api/notifications/smtp', {
      host: 'smtp2.example.com',
      port: 25,
      password: null,
      from: 'reports@example.com',
      tls: false,
    });
    expect(cleared.body.smtp.passwordConfigured).toBe(false);

    const removed = await sendJson('DELETE', '/api/notifications/smtp');
    expect(removed.status).toBe(200);
    expect((await sendJson('DELETE', '/api/notifications/smtp')).status).toBe(404);
    const events = auditEvents().filter((e) => String(e.event).startsWith('notification-smtp'));
    expect(events.length).toBeGreaterThanOrEqual(3);
    expect(JSON.stringify(events)).not.toContain('s3cret!');
  });

  it('the test-send in demo mode answers demo and lands in the report outbox', async () => {
    await sendJson('PUT', '/api/notifications/smtp', {
      host: 'smtp.example.com',
      from: 'reports@example.com',
      tls: true,
      password: 'never-in-a-response',
    });
    const { status, body } = await sendJson('POST', '/api/notifications/smtp/test', {});
    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: true, demo: true });
    expect(JSON.stringify(body)).not.toContain('never-in-a-response');
    const report = await getJson('/api/notifications/report');
    expect(report.body.demoMode).toBe(true);
    expect(report.body.entries.some((e: { subject: string }) => e.subject === 'HPE Network Tools — SMTP test')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Routes — report
// ---------------------------------------------------------------------------

describe('report routes', () => {
  it('GET serves the defaults; PUT validates the merged result', async () => {
    const { body } = await getJson('/api/notifications/report');
    expect(body.config).toMatchObject({ enabled: false, frequency: 'daily', hour: 6, recipients: [] });
    for (const [payload, match] of [
      [{ hour: 24 }, '0 and 23'],
      [{ frequency: 'hourly' }, 'daily or weekly'],
      [{ recipients: ['noc@example.com', 'junk'] }, 'junk'],
      [{ recipients: 'noc@example.com' }, 'list'],
    ] as const) {
      const res = await sendJson('PUT', '/api/notifications/report', payload);
      expect(res.status).toBe(400);
      expect(res.body.error).toContain(match);
    }
    const saved = await sendJson('PUT', '/api/notifications/report', {
      enabled: true,
      frequency: 'weekly',
      hour: 7,
      recipients: ['noc@example.com'],
    });
    expect(saved.status).toBe(200);
    expect(saved.body.config).toMatchObject({ enabled: true, frequency: 'weekly', hour: 7, recipients: ['noc@example.com'] });
    expect(auditEvents().some((e) => e.event === 'notification-report-updated')).toBe(true);
  });

  it('force-send in demo mode renders into the outbox and records demo', async () => {
    const { status, body } = await sendJson('POST', '/api/notifications/report/send');
    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: true, demo: true });
    const report = await getJson('/api/notifications/report');
    expect(report.body.config.lastResult).toBe('demo');
    expect(report.body.entries.some((e: { subject: string }) => e.subject.startsWith('Fleet Summary Report — '))).toBe(true);
  });

  it('the preview renders in every mode, with the fixtures clearly demo', async () => {
    const { status, body } = await getJson('/api/notifications/report/preview');
    expect(status).toBe(200);
    expect(body.report.subject).toMatch(/^Fleet Summary Report — \d{4}-\d{2}-\d{2}$/);
    expect(body.report.demo).toBe(true);
    expect(body.report.totalDevices).toBeGreaterThan(0);
    expect(typeof body.report.text).toBe('string');
    expect(body.report.text).toContain('DEVICES');
    // The demo fixtures include an expiring subscription — the report's own
    // showcase of the ≤90d section.
    expect(body.report.expiring.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Routes — SSL watch list
// ---------------------------------------------------------------------------

describe('SSL host routes', () => {
  it('add validates the target, refuses duplicates, removes honestly', async () => {
    expect((await sendJson('POST', '/api/notifications/ssl-hosts', {})).status).toBe(400);
    expect((await sendJson('POST', '/api/notifications/ssl-hosts', { host: 'bad host.com' })).status).toBe(400);
    expect((await sendJson('POST', '/api/notifications/ssl-hosts', { host: 'vpn.example.com:99999' })).status).toBe(400);

    const added = await sendJson('POST', '/api/notifications/ssl-hosts', { host: 'VPN.example.com' });
    expect(added.status).toBe(201);
    expect(added.body.host).toMatchObject({ host: 'vpn.example.com', port: 443 });

    const dup = await sendJson('POST', '/api/notifications/ssl-hosts', { host: 'vpn.example.com:443' });
    expect(dup.status).toBe(400);
    expect(dup.body.error).toContain('already on the watch list');

    const list = await getJson('/api/notifications/ssl-hosts');
    expect(list.body.hosts).toHaveLength(1);

    // Demo mode: the probe-now button answers honestly, never dials.
    const probe = await sendJson('POST', `/api/notifications/ssl-hosts/${added.body.host.id}/probe`);
    expect(probe.status).toBe(200);
    expect(probe.body).toMatchObject({ demo: true });

    const removed = await sendJson('DELETE', `/api/notifications/ssl-hosts/${added.body.host.id}`);
    expect(removed.status).toBe(200);
    expect((await sendJson('DELETE', `/api/notifications/ssl-hosts/${added.body.host.id}`)).status).toBe(404);
    expect((await getJson('/api/notifications/ssl-hosts')).body.hosts).toHaveLength(0);
  });

  it('GET /api/notifications/ssl-hosts/export returns watch-list CSV without PEMs (Loop 96)', async () => {
    const added = await sendJson('POST', '/api/notifications/ssl-hosts', { host: 'edge.example.com:8443' });
    expect(added.status).toBe(201);

    const r = await fetch(`${base}/api/notifications/ssl-hosts/export`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type') ?? '').toMatch(/text\/csv/);
    const text = await r.text();
    const header = text.split('\n')[0] ?? '';
    expect(header).toContain('host');
    expect(header).toContain('port');
    expect(header).toContain('probeOk');
    expect(header).toContain('notAfter');
    expect(text).toMatch(/edge\.example\.com/);
    expect(text).toMatch(/8443/);
    expect(text).not.toMatch(/BEGIN CERTIFICATE|PRIVATE KEY|password|secret|hmac/i);

    await sendJson('DELETE', `/api/notifications/ssl-hosts/${(added.body.host as { id: string }).id}`);
  });

  it('GET /api/notifications/ssl-hosts and export honour q= text filter (Loop 116)', async () => {
    const a = await sendJson('POST', '/api/notifications/ssl-hosts', { host: 'alpha-edge.example.com:8443' });
    const b = await sendJson('POST', '/api/notifications/ssl-hosts', { host: 'beta-core.example.com' });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);

    const all = await getJson('/api/notifications/ssl-hosts');
    expect((all.body.hosts as unknown[]).length).toBeGreaterThanOrEqual(2);

    const hit = await getJson('/api/notifications/ssl-hosts?q=alpha-edge');
    expect(hit.status).toBe(200);
    const hitHosts = hit.body.hosts as Array<{ host: string }>;
    expect(hitHosts.length).toBeGreaterThan(0);
    for (const h of hitHosts) expect(h.host).toMatch(/alpha-edge/i);

    const miss = await getJson('/api/notifications/ssl-hosts?q=zz-no-such-host-zz');
    expect((miss.body.hosts as unknown[]).length).toBe(0);

    const csv = await fetch(`${base}/api/notifications/ssl-hosts/export?q=alpha-edge`);
    expect(csv.status).toBe(200);
    const text = await csv.text();
    expect(text).toMatch(/alpha-edge/i);
    expect(text).not.toMatch(/beta-core/i);
    expect(text).not.toMatch(/BEGIN CERTIFICATE|PRIVATE KEY|password|secret/i);

    await sendJson('DELETE', `/api/notifications/ssl-hosts/${(a.body.host as { id: string }).id}`);
    await sendJson('DELETE', `/api/notifications/ssl-hosts/${(b.body.host as { id: string }).id}`);
  });
});
