/**
 * server/tests/ackAlert.test.ts — the ticket-gated alert acknowledge, NO network.
 *
 * Service-level tests construct AckAlertService instances against per-test tmp
 * data dirs with an injected transport and demo flag. Route-level tests boot
 * createApp() on an ephemeral port like routes.test.ts.
 *
 * HPE_SETTINGS_PATH and HPE_DATA_DIR point at a tmp dir so neither the
 * settings singleton nor the ackAlertService singleton (constructed at import)
 * ever touches the real data/ — the env vars must be set before the app
 * modules are imported, so imports are dynamic inside beforeAll.
 */

import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AckAlertTarget } from '../src/services/ackAlert';
import type { AlertRow } from '@hpe/shared';

let AckAlertService: typeof import('../src/services/ackAlert').AckAlertService;
let createApp: typeof import('../src/index').createApp;

let tmpDir: string;
let server: Server;
let base: string;

let dirCounter = 0;
function freshDataDir(): string {
  return join(tmpDir, `d${dirCounter++}`);
}

const ALERT: AckAlertTarget = { plane: 'CENTRAL', alertId: 'K1', title: 'AP ap-lobby-01 is down', device: 'ap-lobby-01' };

/** Raised in beforeAll so the write gate knows a real ticket id (NET-4201). */
const RAISE_ALERT: AlertRow = {
  sev: 'P1',
  tone: 'danger',
  title: 'AP ap-lobby-01 is down',
  detail: 'raised so the ticket gate has a real id',
  siteId: 'campus-01',
  siteName: 'Campus-01 — Meridian HQ',
  plane: 'CENTRAL',
  state: 'open',
  age: '1m',
  device: 'ap-lobby-01',
};

function logLines(dir: string): Array<Record<string, unknown>> {
  try {
    return readFileSync(join(dir, 'change-log.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  } catch {
    return [];
  }
}

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'hpe-ack-'));
  process.env.HPE_SETTINGS_PATH = join(tmpDir, 'settings.json');
  process.env.HPE_DATA_DIR = join(tmpDir, 'data');
  ({ AckAlertService } = await import('../src/services/ackAlert'));
  ({ createApp } = await import('../src/index'));
  // A raised ticket in the store: NET-4201 is a real id from here on.
  const { ticketStore } = await import('../src/services/tickets');
  ticketStore.raiseFromAlert(RAISE_ALERT);
  server = createApp().listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('AckAlertService gating', () => {
  it('requires a ticket before anything else', async () => {
    const svc = new AckAlertService({ dataDir: freshDataDir(), demoMode: () => true });
    await expect(svc.acknowledge(ALERT, '')).rejects.toMatchObject({ status: 400, message: expect.stringContaining('ticket') });
  });

  it('rejects a ticket id the portal does not know, naming it — and logs nothing', async () => {
    const dataDir = freshDataDir();
    const svc = new AckAlertService({ dataDir, demoMode: () => true });
    await expect(svc.acknowledge(ALERT, 'NET-0000-BOGUS')).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining("unknown ticket 'NET-0000-BOGUS'"),
    });
    expect(logLines(dataDir)).toEqual([]); // a bogus reference is never audit-logged as real
  });

  it('400s without a target and without a plane', async () => {
    const svc = new AckAlertService({ dataDir: freshDataDir(), demoMode: () => true });
    await expect(svc.acknowledge(null, 'NET-4201')).rejects.toMatchObject({ status: 400, message: expect.stringContaining('target') });
    await expect(svc.acknowledge({ title: 'x' }, 'NET-4201')).rejects.toMatchObject({ status: 400, message: expect.stringContaining('plane') });
  });

  it('demo mode validates and audit-logs without pushing', async () => {
    const dataDir = freshDataDir();
    const svc = new AckAlertService({ dataDir, demoMode: () => true });
    const res = await svc.acknowledge(ALERT, 'NET-4201');
    expect(res.ok).toBe(true);
    expect(res.applied).toBe(false);
    expect(res.message).toContain('demo mode');
    const lines = logLines(dataDir);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ event: 'alert-ack', ticket: 'NET-4201', kind: 'alert' });
    expect(statSync(join(dataDir, 'change-log.jsonl')).mode & 0o777).toBe(0o600);
  });

  it('409s non-Central alerts with an honest hand-off that names the UXI dashboard', async () => {
    const svc = new AckAlertService({ dataDir: freshDataDir(), demoMode: () => false });
    await expect(svc.acknowledge({ plane: 'UXI', title: 'Sensor offline' }, 'NET-4201')).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining('UXI dashboard'),
    });
    await expect(svc.acknowledge({ plane: 'MIST', title: 'AP down' }, 'NET-4201')).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining('mist console'),
    });
  });

  it('409s Central alerts with no plane key on record', async () => {
    const svc = new AckAlertService({ dataDir: freshDataDir(), demoMode: () => false });
    await expect(svc.acknowledge({ plane: 'CENTRAL', title: 'rogue AP detected' }, 'NET-4201')).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining('no plane key'),
    });
  });

  it('409s when Central is not linked (no transport)', async () => {
    const svc = new AckAlertService({ dataDir: freshDataDir(), demoMode: () => false, transport: null });
    await expect(svc.acknowledge(ALERT, 'NET-4201')).rejects.toMatchObject({ status: 409, message: expect.stringContaining('not linked') });
  });
});

describe('AckAlertService push', () => {
  it('posts the notifications clear path and claims success only on 202', async () => {
    const seen: Array<{ method: string; path: string; body: unknown }> = [];
    const svc = new AckAlertService({
      dataDir: freshDataDir(),
      demoMode: () => false,
      transport: {
        request: async (method, path, body) => {
          seen.push({ method, path, body });
          return { status: 202, body: {} };
        },
      },
      // The re-read is stubbed out here; this test is about the request that
      // goes out. Left unstubbed it would reach the process-wide poller.
      syncNow: async () => 'skipped',
      contributions: () => new Map(),
    });
    const res = await svc.acknowledge(ALERT, 'NET-4201');
    expect(res.applied).toBe(true);
    expect(res.httpCode).toBe(202);
    expect(seen).toEqual([
      {
        method: 'POST',
        path: '/network-notifications/v1/alerts/clear',
        body: {
          keys: ['K1'],
          reason: 'NET-4201',
          notes: 'acknowledged from the HPE Network Tools portal; ticket NET-4201',
        },
      },
    ]);
  });

  it('reports a non-202 honestly and logs the rejection', async () => {
    const dataDir = freshDataDir();
    const svc = new AckAlertService({
      dataDir,
      demoMode: () => false,
      transport: { request: async () => ({ status: 404, body: {} }) },
    });
    const res = await svc.acknowledge(ALERT, 'NET-4201');
    expect(res.ok).toBe(false);
    expect(res.applied).toBe(false);
    expect(res.httpCode).toBe(404);
    expect(res.message).toContain('HTTP 404');
    expect(logLines(dataDir)[0]).toMatchObject({ result: 'rejected', httpCode: 404 });
  });

  it('reports a transport exception as an honest failure, not a throw', async () => {
    const svc = new AckAlertService({
      dataDir: freshDataDir(),
      demoMode: () => false,
      transport: {
        request: async () => {
          throw new Error('socket hang up');
        },
      },
    });
    const res = await svc.acknowledge(ALERT, 'NET-4201');
    expect(res.ok).toBe(false);
    expect(res.message).toContain('socket hang up');
  });
});

describe('POST /api/alerts/ack (demo-mode app)', () => {
  it('400s without a ticket and without a target', async () => {
    const noTicket = await fetch(`${base}/api/alerts/ack`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ alert: { plane: 'CENTRAL', alertId: 'K1' } }),
    });
    expect(noTicket.status).toBe(400);

    const noTarget = await fetch(`${base}/api/alerts/ack`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ticket: 'NET-4201' }),
    });
    expect(noTarget.status).toBe(400);
  });
});

/* 202 Accepted is Central agreeing to consider the request, and the alerts
 * list on screen is served from the poller cache — so without a re-read the
 * operator is told the acknowledge succeeded while looking at the very alert
 * it was supposed to clear, still open. Worse, the screen used to rewrite the
 * row to 'acked' on the strength of the 202 alone, which is an acceptance
 * presented as a completed change. */
describe('AckAlertService clear verification', () => {
  const accepting = (
    over: Partial<ConstructorParameters<typeof AckAlertService>[0]> = {},
  ): InstanceType<typeof AckAlertService> =>
    new AckAlertService({
      dataDir: freshDataDir(),
      demoMode: () => false,
      transport: { request: async () => ({ status: 202, body: {} }) },
      syncNow: async () => 'ok',
      contributions: () => new Map(),
      ...over,
    });

  const pullWith = (alerts: unknown[] | undefined, partial?: string[]) =>
    () => new Map([['central', { ...(alerts === undefined ? {} : { alerts }), ...(partial ? { partial } : {}) }]]) as never;

  it('reports the alert cleared when the re-read no longer lists it', async () => {
    const res = await accepting({ contributions: pullWith([{ alertId: 'OTHER' }]) })
      .acknowledge(ALERT, 'NET-4201');

    expect(res.cleared).toBe('cleared');
    expect(res.message).toContain('has cleared');
  });

  // The case the whole re-read exists for: accepted, and demonstrably not done.
  it('says the acknowledge has not taken effect when the alert is still listed', async () => {
    const res = await accepting({ contributions: pullWith([{ alertId: 'K1' }]) })
      .acknowledge(ALERT, 'NET-4201');

    expect(res.cleared).toBe('still-open');
    expect(res.message).toContain('still open');
    // Still an accepted push — the acknowledge was not rejected.
    expect(res.applied).toBe(true);
  });

  it('does not treat a poll that never completed as evidence either way', async () => {
    const res = await accepting({ syncNow: async () => 'error', contributions: pullWith([]) })
      .acknowledge(ALERT, 'NET-4201');

    expect(res.cleared).toBe('unknown');
  });

  // An absent alerts field is Central declining to say. Reading it as an
  // empty list would turn "we did not ask" into "there are none left".
  it('does not read an unreported alerts field as an empty alerts list', async () => {
    const res = await accepting({ contributions: pullWith(undefined) }).acknowledge(ALERT, 'NET-4201');

    expect(res.cleared).toBe('unknown');
  });

  // A truncated list cannot be searched for an absence.
  it('declines to conclude anything from a partial alerts dataset', async () => {
    const res = await accepting({ contributions: pullWith([], ['alerts']) }).acknowledge(ALERT, 'NET-4201');

    expect(res.cleared).toBe('unknown');
  });

  it('records the unconfirmed outcome in the audit log rather than a plain acknowledged', async () => {
    const dataDir = freshDataDir();
    await accepting({ dataDir, contributions: pullWith([{ alertId: 'K1' }]) }).acknowledge(ALERT, 'NET-4201');

    const log = readFileSync(join(dataDir, 'change-log.jsonl'), 'utf8');
    expect(log).toContain('accepted (unconfirmed — alert still open on re-read)');
  });

  it('records a confirmed clear as acknowledged', async () => {
    const dataDir = freshDataDir();
    await accepting({ dataDir, contributions: pullWith([]) }).acknowledge(ALERT, 'NET-4201');

    const log = readFileSync(join(dataDir, 'change-log.jsonl'), 'utf8');
    expect(log).toContain('acknowledged (cleared on re-read)');
  });

  // Must not over-apply: a rejected push never claims to have re-read anything.
  it('leaves the verification absent when Central refused the acknowledge', async () => {
    const res = await accepting({
      transport: { request: async () => ({ status: 403, body: {} }) },
    }).acknowledge(ALERT, 'NET-4201');

    expect(res.cleared).toBeUndefined();
    expect(res.applied).toBe(false);
  });
});
