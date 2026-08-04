/**
 * server/tests/notifications.test.ts — the notification store, notifier and routes.
 *
 * HPE_SETTINGS_PATH / HPE_DATA_DIR point at a tmp dir so the test never
 * touches real data/. The env vars must be set before the app modules are
 * imported (the notificationStore singleton resolves its dir at construction),
 * so everything from src/ is loaded with dynamic imports inside beforeAll —
 * the same harness silences.test.ts uses.
 *
 * Covered:
 *   store    — empty start, persistence across instances, 0600, secret
 *              redaction (write-only at the view boundary), the keep/clear/
 *              replace tri-state on update, delivery recorded ON the row;
 *   notifier — baseline sample sends nothing, fired/resolved transitions
 *              deliver, HMAC-SHA256 header verified against a capture server,
 *              send-time URL refusal (SSRF, never a silent skip), bounded
 *              retry with recorded backoff, no-retry on a plain 4xx, demo
 *              mode never dials and fills the labelled outbox instead;
 *   routes   — CRUD validation refuses (400) rather than repairs, 404s,
 *              audit lines on every mutation, demo test-send → outbox,
 *              status and outbox payloads.
 */

import { createHmac } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AlertRow, NotificationEvent } from '@hpe/shared';

let server: Server;
let base: string;
let tmpDir: string;
let dataDir: string;
let NotificationStore: typeof import('../src/services/notifierStore').NotificationStore;
let Notifier: typeof import('../src/services/notifier').Notifier;

function alertRow(over: Partial<AlertRow> = {}): AlertRow {
  return {
    sev: 'P1',
    tone: 'danger',
    title: 'Gateway down',
    detail: 'no keepalives for 5m',
    siteId: 'campus-01',
    siteName: 'Campus-01 HQ',
    plane: 'CENTRAL',
    state: 'open',
    age: '4m',
    device: 'gw-edge-1',
    ...over,
  };
}

function testEvent(over: Partial<NotificationEvent> = {}): NotificationEvent {
  return {
    id: 'evt-test',
    kind: 'fired',
    at: '2026-08-01T12:00:00.000Z',
    fingerprint: 'central|gw-edge-1|gateway down',
    plane: 'CENTRAL',
    device: 'gw-edge-1',
    title: 'Gateway down',
    sev: 'P1',
    state: 'open',
    siteName: 'Campus-01 HQ',
    age: '4m',
    count: 1,
    ...over,
  };
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

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'hpe-notifications-'));
  dataDir = join(tmpDir, 'data');
  process.env.HPE_SETTINGS_PATH = join(tmpDir, 'settings.json');
  process.env.HPE_DATA_DIR = dataDir;
  const storeMod = await import('../src/services/notifierStore');
  NotificationStore = storeMod.NotificationStore;
  const notifierMod = await import('../src/services/notifier');
  Notifier = notifierMod.Notifier;
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

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

describe('NotificationStore', () => {
  it('starts empty and persists across instances', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hpe-ntf-store-'));
    try {
      const a = new NotificationStore(dir);
      expect(a.list()).toEqual([]);
      a.create({ name: 'noc', url: 'https://hooks.example.com/x', template: 'slack', enabled: true });
      const b = new NotificationStore(dir);
      expect(b.list()).toHaveLength(1);
      expect(b.list()[0]!.name).toBe('noc');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes notifications.json with mode 0600', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hpe-ntf-store-'));
    try {
      const store = new NotificationStore(dir);
      store.create({ name: 'noc', url: 'https://hooks.example.com/x', template: 'slack', enabled: true });
      expect(statSync(join(dir, 'notifications.json')).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('redacts the secret at the view boundary — write-only, always', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hpe-ntf-store-'));
    try {
      const store = new NotificationStore(dir);
      store.create({ name: 'noc', url: 'https://hooks.example.com/x', template: 'slack', hmacSecret: 'topsecret', enabled: true });
      const view = store.views()[0]!;
      expect(view.hmacSecretConfigured).toBe(true);
      expect('hmacSecret' in view).toBe(false);
      expect(JSON.stringify(view)).not.toContain('topsecret');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('update keeps / replaces / clears the secret as a tri-state', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hpe-ntf-store-'));
    try {
      const store = new NotificationStore(dir);
      const e = store.create({ name: 'noc', url: 'https://hooks.example.com/x', template: 'slack', hmacSecret: 'one', enabled: true });
      // Absent keeps.
      expect(store.update(e.id, { name: 'renamed' })!.hmacSecret).toBe('one');
      // A string replaces.
      expect(store.update(e.id, { hmacSecret: 'two' })!.hmacSecret).toBe('two');
      // Null clears.
      const cleared = store.update(e.id, { hmacSecret: null })!;
      expect(cleared.hmacSecret).toBeUndefined();
      expect(store.views()[0]!.hmacSecretConfigured).toBe(false);
      // The name edit above really landed.
      expect(cleared.name).toBe('renamed');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('update and remove are honest about unknown ids', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hpe-ntf-store-'));
    try {
      const store = new NotificationStore(dir);
      expect(store.update('ntf-nope', { name: 'x' })).toBeNull();
      expect(store.remove('ntf-nope')).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('records the delivery outcome ON the endpoint row, surviving re-instantiation', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hpe-ntf-store-'));
    try {
      const store = new NotificationStore(dir);
      const e = store.create({ name: 'noc', url: 'https://hooks.example.com/x', template: 'slack', enabled: true });
      store.recordDelivery(e.id, { lastAttemptAt: '2026-08-01T12:00:00.000Z', lastResult: 'failed', lastError: 'HTTP 503 — 3 attempts', httpCode: 503 });
      const reread = new NotificationStore(dir).get(e.id)!;
      expect(reread.delivery?.lastResult).toBe('failed');
      expect(reread.delivery?.lastError).toBe('HTTP 503 — 3 attempts');
      // An edit must not launder the failure history.
      const edited = new NotificationStore(dir);
      edited.update(e.id, { name: 'renamed' });
      expect(edited.get(e.id)!.delivery?.lastResult).toBe('failed');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Notifier — transitions, HMAC, refusal, retry, demo outbox
// ---------------------------------------------------------------------------

describe('Notifier', () => {
  it('the first sample is a baseline: nothing sends for the standing queue', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hpe-ntf-live-'));
    try {
      const fetchSpy = vi.fn();
      const notifier = new Notifier({
        store: new NotificationStore(dir),
        sampleAlerts: () => [alertRow()],
        demoMode: () => false,
        fetchImpl: fetchSpy as never,
        dataDir: dir,
      });
      await notifier.sampleNow();
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('delivers a fired transition with the HMAC-SHA256 signature a receiver can verify', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hpe-ntf-live-'));
    // A real capture server records exactly what arrived.
    const captured: { headers: Record<string, string | string[] | undefined>; body: string }[] = [];
    const { createServer } = await import('node:http');
    const capture = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        captured.push({ headers: req.headers, body });
        res.writeHead(200).end();
      });
    }).listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => capture.once('listening', resolve));
    try {
      const url = `http://127.0.0.1:${(capture.address() as AddressInfo).port}/hook`;
      const store = new NotificationStore(dir);
      const endpoint = store.create({ name: 'noc', url, template: 'slack', hmacSecret: 'topsecret', enabled: true });
      const notifier = new Notifier({
        store,
        sampleAlerts: () => [],
        demoMode: () => false,
        dataDir: dir,
        allowInsecureUrlForTests: true,
      });
      const delivery = await notifier.deliver(store.get(endpoint.id)!, testEvent());
      expect(delivery.lastResult).toBe('delivered');
      expect(delivery.httpCode).toBe(200);
      expect(captured).toHaveLength(1);
      const got = captured[0]!;
      expect(got.headers['content-type']).toBe('application/json');
      expect(JSON.parse(got.body)).toEqual({ text: '[P1] FIRED: Gateway down — gw-edge-1 (CENTRAL · Campus-01 HQ)' });
      const expected = `sha256=${createHmac('sha256', 'topsecret').update(got.body).digest('hex')}`;
      expect(got.headers['x-hpe-signature-256']).toBe(expected);
      // The endpoint row records the success; the audit log records the send.
      expect(store.get(endpoint.id)!.delivery?.lastResult).toBe('delivered');
      const audit = readFileSync(join(dir, 'change-log.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as Record<string, unknown>);
      const sentLine = audit.find((e) => e.event === 'notification-sent');
      expect(sentLine).toBeTruthy();
      expect(sentLine!.httpCode).toBe(200);
      expect(String(sentLine!.result)).not.toContain('topsecret');
    } finally {
      await new Promise<void>((resolve) => capture.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a private/loopback URL at SEND time — recorded and audited, never a silent skip', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hpe-ntf-refuse-'));
    try {
      const store = new NotificationStore(dir);
      // Seeded directly (bypassing route validation, as a hand-edited file would).
      const endpoint = store.create({ name: 'metadata', url: 'http://169.254.169.254/latest/meta-data', template: 'generic', enabled: true });
      const fetchSpy = vi.fn();
      const notifier = new Notifier({
        store,
        sampleAlerts: () => [],
        demoMode: () => false,
        fetchImpl: fetchSpy as never,
        dataDir: dataDir,
      });
      const delivery = await notifier.deliver(store.get(endpoint.id)!, testEvent());
      expect(delivery.lastResult).toBe('failed');
      expect(delivery.lastError).toContain('refused');
      expect(fetchSpy).not.toHaveBeenCalled();
      const failures = auditEvents().filter((e) => e.event === 'notification-failed');
      expect(failures.length).toBeGreaterThan(0);
      expect(String(failures[failures.length - 1]!.result)).toContain('refused');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('retries with the recorded backoff and recovers, honestly counting attempts', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hpe-ntf-retry-'));
    try {
      const store = new NotificationStore(dir);
      const endpoint = store.create({ name: 'noc', url: 'https://hooks.example.com/flaky', template: 'generic', enabled: true });
      const sleeps: number[] = [];
      let calls = 0;
      const fetchImpl = vi.fn(async () => {
        calls += 1;
        return new Response('err', { status: calls < 3 ? 500 : 200 });
      });
      const notifier = new Notifier({
        store,
        sampleAlerts: () => [],
        demoMode: () => false,
        fetchImpl: fetchImpl as never,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
        dataDir,
      });
      const delivery = await notifier.deliver(store.get(endpoint.id)!, testEvent());
      expect(delivery.lastResult).toBe('delivered');
      expect(fetchImpl).toHaveBeenCalledTimes(3);
      expect(sleeps).toEqual([1_000, 4_000]);
      const sent = auditEvents().filter((e) => e.event === 'notification-sent');
      expect(String(sent[sent.length - 1]!.result)).toContain('after 3 attempts');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('gives up after the bounded attempts and records the failure verbatim', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hpe-ntf-retry-'));
    try {
      const store = new NotificationStore(dir);
      const endpoint = store.create({ name: 'noc', url: 'https://hooks.example.com/down', template: 'generic', enabled: true });
      const fetchImpl = vi.fn(async () => new Response('err', { status: 503 }));
      const notifier = new Notifier({
        store,
        sampleAlerts: () => [],
        demoMode: () => false,
        fetchImpl: fetchImpl as never,
        sleep: async () => {},
        dataDir,
      });
      const delivery = await notifier.deliver(store.get(endpoint.id)!, testEvent());
      expect(delivery.lastResult).toBe('failed');
      expect(delivery.lastError).toBe('HTTP 503 — 3 attempts');
      expect(delivery.httpCode).toBe(503);
      expect(fetchImpl).toHaveBeenCalledTimes(3);
      expect(store.get(endpoint.id)!.delivery?.lastResult).toBe('failed');
      expect(auditEvents().filter((e) => e.event === 'notification-failed').length).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does NOT retry a plain 4xx — one attempt, no theatre', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hpe-ntf-retry-'));
    try {
      const store = new NotificationStore(dir);
      const endpoint = store.create({ name: 'noc', url: 'https://hooks.example.com/gone', template: 'generic', enabled: true });
      const sleeps: number[] = [];
      const fetchImpl = vi.fn(async () => new Response('nope', { status: 404 }));
      const notifier = new Notifier({
        store,
        sampleAlerts: () => [],
        demoMode: () => false,
        fetchImpl: fetchImpl as never,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
        dataDir,
      });
      const delivery = await notifier.deliver(store.get(endpoint.id)!, testEvent());
      expect(delivery.lastResult).toBe('failed');
      expect(delivery.lastError).toBe('HTTP 404 — 1 attempt');
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(sleeps).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('demo mode never dials: the rendered payload lands in the labelled outbox', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hpe-ntf-demo-'));
    try {
      const store = new NotificationStore(dir);
      const endpoint = store.create({ name: 'noc', url: 'https://hooks.example.com/demo', template: 'ntfy', enabled: true });
      const fetchSpy = vi.fn();
      const notifier = new Notifier({
        store,
        sampleAlerts: () => [],
        demoMode: () => true,
        fetchImpl: fetchSpy as never,
        dataDir,
      });
      const delivery = await notifier.deliver(store.get(endpoint.id)!, testEvent());
      expect(delivery.lastResult).toBe('demo');
      expect(fetchSpy).not.toHaveBeenCalled();
      const outbox = notifier.outbox();
      expect(outbox).toHaveLength(1);
      expect(outbox[0]!.demo).toBe(true);
      expect(outbox[0]!.endpointName).toBe('noc');
      expect(outbox[0]!.contentType).toContain('text/plain');
      expect(outbox[0]!.body).toContain('FIRED: Gateway down');
      expect(store.get(endpoint.id)!.delivery?.lastResult).toBe('demo');
      expect(auditEvents().filter((e) => e.event === 'notification-demo').length).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('sampleNow diffs against the previous sample: fired then resolved', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hpe-ntf-diff-'));
    try {
      const store = new NotificationStore(dir);
      store.create({ name: 'noc', url: 'https://hooks.example.com/diff', template: 'generic', enabled: true });
      let rows: AlertRow[] = [];
      const notifier = new Notifier({
        store,
        sampleAlerts: () => rows,
        demoMode: () => true, // outbox, never the network
        dataDir,
      });
      await notifier.sampleNow(); // baseline over an empty queue
      rows = [alertRow()];
      await notifier.sampleNow();
      rows = [];
      await notifier.sampleNow();
      const kinds = notifier.outbox().map((o) => o.event.kind);
      expect(kinds).toEqual(['resolved', 'fired']); // outbox is newest-first
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

describe('notification routes', () => {
  afterEach(async () => {
    // The route tests share the singleton store; leave it empty for the next one.
    const { body } = await getJson('/api/notifications/endpoints');
    for (const e of body.endpoints ?? []) {
      await sendJson('DELETE', `/api/notifications/endpoints/${e.id}`);
    }
  });

  it('POST validates and refuses rather than repairs', async () => {
    const missing = await sendJson('POST', '/api/notifications/endpoints', { url: 'https://hooks.example.com/x', template: 'slack' });
    expect(missing.status).toBe(400);
    expect(missing.body.error).toContain('name is required');

    const http = await sendJson('POST', '/api/notifications/endpoints', { name: 'n', url: 'http://hooks.example.com/x', template: 'slack' });
    expect(http.status).toBe(400);
    expect(http.body.error).toContain('HTTPS');

    const loopback = await sendJson('POST', '/api/notifications/endpoints', { name: 'n', url: 'https://127.0.0.1/hook', template: 'slack' });
    expect(loopback.status).toBe(400);

    const badTemplate = await sendJson('POST', '/api/notifications/endpoints', { name: 'n', url: 'https://hooks.example.com/x', template: 'pagerduty' });
    expect(badTemplate.status).toBe(400);

    const emptySecret = await sendJson('POST', '/api/notifications/endpoints', { name: 'n', url: 'https://hooks.example.com/x', template: 'slack', hmacSecret: '' });
    expect(emptySecret.status).toBe(400);
    expect(emptySecret.body.error).toContain('non-empty');
  });

  it('POST creates (201, secret redacted) and writes an audit line', async () => {
    const res = await sendJson('POST', '/api/notifications/endpoints', {
      name: 'noc-slack',
      url: 'https://hooks.example.com/slack',
      template: 'slack',
      hmacSecret: 's3cret',
    });
    expect(res.status).toBe(201);
    expect(res.body.endpoint.name).toBe('noc-slack');
    expect(res.body.endpoint.hmacSecretConfigured).toBe(true);
    expect('hmacSecret' in res.body.endpoint).toBe(false);
    const created = auditEvents().filter((e) => e.event === 'notification-endpoint-created');
    expect(created.length).toBeGreaterThan(0);
    expect(String(created[created.length - 1]!.result)).toContain('noc-slack');
    expect(String(created[created.length - 1]!.result)).not.toContain('s3cret');
  });

  it('GET lists endpoints with secrets redacted', async () => {
    await sendJson('POST', '/api/notifications/endpoints', { name: 'a', url: 'https://a.example.com/hook', template: 'generic' });
    const res = await getJson('/api/notifications/endpoints');
    expect(res.status).toBe(200);
    expect(res.body.endpoints).toHaveLength(1);
    expect(res.body.endpoints[0].hmacSecretConfigured).toBe(false);
    expect(JSON.stringify(res.body)).not.toContain('hmacSecret"');
  });

  it('PUT edits, keeps/clears the secret, 404s unknown ids and validates the merged form', async () => {
    const created = await sendJson('POST', '/api/notifications/endpoints', {
      name: 'noc',
      url: 'https://hooks.example.com/x',
      template: 'slack',
      hmacSecret: 'keepme',
    });
    const id = created.body.endpoint.id;

    const unknown = await sendJson('PUT', '/api/notifications/endpoints/ntf-nope', { name: 'x' });
    expect(unknown.status).toBe(404);

    // Name edit keeps the stored secret.
    const renamed = await sendJson('PUT', `/api/notifications/endpoints/${id}`, { name: 'renamed' });
    expect(renamed.status).toBe(200);
    expect(renamed.body.endpoint.name).toBe('renamed');
    expect(renamed.body.endpoint.hmacSecretConfigured).toBe(true);

    // Merged validation: a bad URL in an otherwise fine edit is refused.
    const badUrl = await sendJson('PUT', `/api/notifications/endpoints/${id}`, { url: 'http://insecure.example.com/x' });
    expect(badUrl.status).toBe(400);

    // hmacSecret: null clears; the audit line says so without carrying it.
    const cleared = await sendJson('PUT', `/api/notifications/endpoints/${id}`, { hmacSecret: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.endpoint.hmacSecretConfigured).toBe(false);
    const updates = auditEvents().filter((e) => e.event === 'notification-endpoint-updated');
    expect(String(updates[updates.length - 1]!.result)).toContain('cleared');
    expect(JSON.stringify(updates)).not.toContain('keepme');
  });

  it('DELETE removes, 404s unknown ids and audits', async () => {
    const created = await sendJson('POST', '/api/notifications/endpoints', { name: 'noc', url: 'https://hooks.example.com/x', template: 'ntfy' });
    const id = created.body.endpoint.id;
    const missing = await sendJson('DELETE', '/api/notifications/endpoints/ntf-nope');
    expect(missing.status).toBe(404);
    const res = await sendJson('DELETE', `/api/notifications/endpoints/${id}`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(auditEvents().filter((e) => e.event === 'notification-endpoint-deleted').length).toBeGreaterThan(0);
    expect((await getJson('/api/notifications/endpoints')).body.endpoints).toHaveLength(0);
  });

  it('demo test-send answers honestly and the payload lands in the outbox', async () => {
    const created = await sendJson('POST', '/api/notifications/endpoints', { name: 'noc', url: 'https://hooks.example.com/demo', template: 'slack' });
    const id = created.body.endpoint.id;
    const test = await sendJson('POST', `/api/notifications/endpoints/${id}/test`);
    expect(test.status).toBe(200);
    expect(test.body.ok).toBe(true);
    expect(test.body.demo).toBe(true);
    expect(test.body.message).toContain('nothing was sent');

    const outbox = await getJson('/api/notifications/outbox');
    expect(outbox.status).toBe(200);
    expect(outbox.body.demoMode).toBe(true);
    const entry = outbox.body.entries.find((e: { endpointId: string }) => e.endpointId === id);
    expect(entry).toBeTruthy();
    expect(entry.demo).toBe(true);
    expect(entry.event.kind).toBe('test');
    expect(JSON.parse(entry.body).text).toContain('TEST');

    // The endpoint row itself says "demo", never "delivered".
    const list = await getJson('/api/notifications/endpoints');
    expect(list.body.endpoints[0].delivery.lastResult).toBe('demo');

    const missing = await sendJson('POST', '/api/notifications/endpoints/ntf-nope/test');
    expect(missing.status).toBe(404);
  });

  it('GET /api/notifications/status reports demo mode, the sampler and per-endpoint delivery', async () => {
    await sendJson('POST', '/api/notifications/endpoints', { name: 'noc', url: 'https://hooks.example.com/x', template: 'teams' });
    const res = await getJson('/api/notifications/status');
    expect(res.status).toBe(200);
    expect(res.body.demoMode).toBe(true);
    // createApp never starts the sampler (startServer does) — and says so.
    expect(res.body.sampling.running).toBe(false);
    expect(res.body.endpoints).toHaveLength(1);
    expect(res.body.endpoints[0].delivery).toBeNull();
  });

  it('GET /api/notifications/deliveries lists attempt outcomes without payload bodies', async () => {
    const created = await sendJson('POST', '/api/notifications/endpoints', {
      name: 'noc',
      url: 'https://hooks.example.com/demo',
      template: 'slack',
    });
    const id = created.body.endpoint.id as string;
    await sendJson('POST', `/api/notifications/endpoints/${id}/test`);
    const res = await getJson('/api/notifications/deliveries');
    expect(res.status).toBe(200);
    expect(res.body.demoMode).toBe(true);
    expect(Array.isArray(res.body.entries)).toBe(true);
    expect(res.body.entries.length).toBeGreaterThan(0);
    const entry = res.body.entries[0];
    expect(entry.endpointId).toBe(id);
    expect(entry.result).toBe('demo');
    expect(entry.test).toBe(true);
    expect(entry.body).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain('"text"');
  });
});
