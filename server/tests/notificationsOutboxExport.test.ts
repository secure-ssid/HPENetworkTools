/**
 * Loop 101 — GET /api/notifications/outbox/export + /report/export
 * (metadata only; never payload/email bodies).
 * Loop 119 — optional q= triage on outbox + report export (never bodies).
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Request } from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NotificationOutboxEntry, ReportOutboxEntry } from '@hpe/shared';

let server: Server;
let base: string;
let tmpDir: string;

beforeAll(async () => {
  const testRoot = resolve(process.cwd(), '.agent-tmp');
  mkdirSync(testRoot, { recursive: true });
  tmpDir = mkdtempSync(join(testRoot, 'notifications-outbox-export-'));
  process.env.HPE_SETTINGS_PATH = join(tmpDir, 'settings.json');
  process.env.HPE_DATA_DIR = join(tmpDir, 'data');
  const { createApp } = await import('../src/index');
  server = createApp().listen(0, '127.0.0.1');
  await new Promise<void>((resolveListen) => server.once('listening', resolveListen));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.HPE_SETTINGS_PATH;
  delete process.env.HPE_DATA_DIR;
});

function req(query: Record<string, unknown> = {}): Request {
  return { query } as Request;
}

async function sendJson(method: string, path: string, body?: unknown) {
  const r = await fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, unknown> };
}

describe('notification outbox exports (Loop 101)', () => {
  it('GET /api/notifications/outbox/export is summary CSV without bodies/secrets', async () => {
    const r = await fetch(`${base}/api/notifications/outbox/export`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type') ?? '').toMatch(/text\/csv/);
    const text = await r.text();
    const header = text.split('\n')[0] ?? '';
    expect(header).toContain('at');
    expect(header).toContain('endpoint');
    expect(header).toContain('eventKind');
    expect(header).toContain('fingerprint');
    expect(header).toContain('title');
    // Never payload body column or signing material.
    expect(header).not.toMatch(/\bbody\b/i);
    expect(text).not.toMatch(/hmac|password|bearer\s+[A-Za-z0-9]|client_secret/i);
  });

  it('GET /api/notifications/report/export is outbox metadata without email bodies', async () => {
    // Force a demo send so the report outbox has at least one entry.
    await fetch(`${base}/api/notifications/report/send`, { method: 'POST' });

    const r = await fetch(`${base}/api/notifications/report/export`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type') ?? '').toMatch(/text\/csv/);
    const text = await r.text();
    const header = text.split('\n')[0] ?? '';
    expect(header).toContain('at');
    expect(header).toContain('subject');
    expect(header).toContain('recipients');
    expect(header).toContain('demo');
    expect(header).not.toMatch(/\btext\b|\bhtml\b/i);
    expect(text).toMatch(/Fleet Summary Report/i);
    expect(text).not.toMatch(/BEGIN CERTIFICATE|password|smtp|secret/i);
    // Body content from the report (DEVICES section) must not appear.
    const dataRows = text.trim().split('\n').slice(1).filter(Boolean);
    expect(dataRows.length).toBeGreaterThan(0);
    for (const line of dataRows) {
      expect(line).not.toMatch(/\bDEVICES\b/);
    }
  });

  it('filterNotificationOutbox q= matches metadata only, never body (Loop 119)', async () => {
    const { filterNotificationOutbox } = await import('../src/routes/notifications');
    const entries = [
      {
        id: 'ob-1',
        at: '2026-08-04T00:00:00.000Z',
        endpointId: 'ep-1',
        endpointName: 'noc-slack',
        contentType: 'application/json',
        demo: true as const,
        body: 'SECRET_PAYLOAD_BODY_SHOULD_NOT_MATCH',
        event: {
          id: 'ev-1',
          kind: 'fired',
          at: '2026-08-04T00:00:00.000Z',
          fingerprint: 'fp-alpha',
          plane: 'central',
          device: 'core-sw-1',
          title: 'Uplink down',
          sev: 'critical',
          state: 'open',
          siteName: 'HQ',
          age: '1m',
          count: 1,
        },
      },
      {
        id: 'ob-2',
        at: '2026-08-04T00:01:00.000Z',
        endpointId: 'ep-2',
        endpointName: 'pager',
        contentType: 'application/json',
        demo: true as const,
        body: 'another body',
        event: {
          id: 'ev-2',
          kind: 'resolved',
          at: '2026-08-04T00:01:00.000Z',
          fingerprint: 'fp-beta',
          plane: 'mist',
          device: 'ap-22',
          title: 'AP offline',
          sev: 'warning',
          state: 'cleared',
          siteName: 'Branch',
          age: '2m',
          count: 2,
        },
      },
    ] as NotificationOutboxEntry[];

    expect(filterNotificationOutbox(req({ q: 'noc-slack' }), entries).map((e) => e.id)).toEqual(['ob-1']);
    expect(filterNotificationOutbox(req({ q: '  MIST  ' }), entries).map((e) => e.id)).toEqual(['ob-2']);
    expect(filterNotificationOutbox(req({ q: 'fp-alpha' }), entries).map((e) => e.id)).toEqual(['ob-1']);
    // Body content must never be searchable.
    expect(filterNotificationOutbox(req({ q: 'SECRET_PAYLOAD_BODY' }), entries)).toEqual([]);
    expect(filterNotificationOutbox(req({ q: '' }), entries)).toHaveLength(2);
    expect(filterNotificationOutbox(req({}), entries)).toHaveLength(2);
  });

  it('filterReportOutbox q= matches subject/recipients/id only (Loop 119)', async () => {
    const { filterReportOutbox } = await import('../src/routes/notifications');
    const entries = [
      {
        id: 'rp-1',
        at: '2026-08-04T00:00:00.000Z',
        subject: 'Fleet Summary Report — HQ',
        recipients: ['ops@example.com', 'noc@example.com'],
        text: 'DEVICES section must never match',
        html: '<b>DEVICES</b>',
        demo: true as const,
      },
      {
        id: 'rp-2',
        at: '2026-08-04T00:01:00.000Z',
        subject: 'Fleet Summary Report — Branch',
        recipients: ['branch@example.com'],
        text: 'more body',
        html: '<p>more</p>',
        demo: true as const,
      },
    ] as ReportOutboxEntry[];

    expect(filterReportOutbox(req({ q: 'ops@' }), entries).map((e) => e.id)).toEqual(['rp-1']);
    expect(filterReportOutbox(req({ q: 'branch' }), entries).map((e) => e.id)).toEqual(['rp-2']);
    expect(filterReportOutbox(req({ q: 'DEVICES' }), entries)).toEqual([]);
    expect(filterReportOutbox(req({ q: '' }), entries)).toHaveLength(2);
  });

  it('GET outbox list+export honour q= after demo test-send (Loop 119)', async () => {
    const created = await sendJson('POST', '/api/notifications/endpoints', {
      name: 'outbox-q-endpoint',
      url: 'https://hooks.example.com/outbox-q',
      template: 'slack',
    });
    expect(created.status).toBe(201);
    const id = (created.body.endpoint as { id: string }).id;
    await sendJson('POST', `/api/notifications/endpoints/${id}/test`);

    const list = await fetch(`${base}/api/notifications/outbox`);
    expect(list.status).toBe(200);
    const all = (await list.json()) as { entries: Array<{ endpointName: string }> };
    // Demo mode should land the test in the outbox.
    expect(all.entries.some((e) => e.endpointName === 'outbox-q-endpoint')).toBe(true);

    const hit = await fetch(`${base}/api/notifications/outbox?q=outbox-q-endpoint`);
    const hitBody = (await hit.json()) as { entries: Array<{ endpointName: string }> };
    expect(hitBody.entries.length).toBeGreaterThan(0);
    for (const e of hitBody.entries) {
      expect(e.endpointName.toLowerCase()).toContain('outbox-q-endpoint');
    }

    const miss = await fetch(`${base}/api/notifications/outbox?q=zz-no-such-outbox-zz`);
    const missBody = (await miss.json()) as { entries: unknown[] };
    expect(missBody.entries.length).toBe(0);

    const csv = await fetch(`${base}/api/notifications/outbox/export?q=outbox-q-endpoint`);
    expect(csv.status).toBe(200);
    const text = await csv.text();
    expect(text.toLowerCase()).toContain('outbox-q-endpoint');
    expect(text).not.toMatch(/hooks\.example\.com|password|secret|hmac/i);
  });

  it('GET report/export honours q= subject filter (Loop 119)', async () => {
    await fetch(`${base}/api/notifications/report/send`, { method: 'POST' });

    const all = await fetch(`${base}/api/notifications/report/export`);
    expect(all.status).toBe(200);
    const allText = await all.text();
    expect(allText.toLowerCase()).toMatch(/fleet/);

    const hit = await fetch(`${base}/api/notifications/report/export?q=fleet`);
    expect(hit.status).toBe(200);
    const hitText = await hit.text();
    expect(hitText.toLowerCase()).toContain('fleet');
    // Still metadata only.
    expect(hitText).not.toMatch(/\bDEVICES\b|BEGIN CERTIFICATE|password/i);

    const miss = await fetch(`${base}/api/notifications/report/export?q=zz-no-such-subject-zz`);
    expect(miss.status).toBe(200);
    const missText = await miss.text();
    const dataRows = missText.trim().split('\n').slice(1).filter(Boolean);
    expect(dataRows.length).toBe(0);
  });

  it('OpenAPI documents outbox + report export q= (Loop 119)', async () => {
    const r = await fetch(`${base}/api/openapi.json`);
    expect(r.status).toBe(200);
    const spec = (await r.json()) as {
      paths: Record<string, { get?: { parameters?: Array<{ name?: string }> } }>;
    };
    const outboxParams = spec.paths['/api/notifications/outbox/export']?.get?.parameters ?? [];
    expect(outboxParams.some((p) => p.name === 'q')).toBe(true);
    const reportParams = spec.paths['/api/notifications/report/export']?.get?.parameters ?? [];
    expect(reportParams.some((p) => p.name === 'q')).toBe(true);
  });
});
