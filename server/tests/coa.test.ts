/**
 * server/tests/coa.test.ts — the ticket-gated ClearPass CoA block, NO network.
 *
 * Service-level tests construct CoaService instances against per-test tmp data
 * dirs with an injected adapter (a real ClearPassAdapter over a fake fetch)
 * and demo flag. Route-level tests boot createApp() on an ephemeral port like
 * routes.test.ts. HPE_SETTINGS_PATH and HPE_DATA_DIR point at a tmp dir so no
 * singleton ever touches the real data/ — env vars are set before the app
 * modules are imported, so imports are dynamic inside beforeAll.
 */

import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CoaClient } from '../src/services/coa';
import type { PlaneState } from '../src/planes/types';
import type { AlertRow } from '@hpe/shared';

let CoaService: typeof import('../src/services/coa').CoaService;
let ClearPassAdapter: typeof import('../src/planes/clearpass').ClearPassAdapter;
let createApp: typeof import('../src/index').createApp;

let tmpDir: string;
let server: Server;
let base: string;

let dirCounter = 0;
function freshDataDir(): string {
  return join(tmpDir, `d${dirCounter++}`);
}

const WIRED: CoaClient = { mac: '00:1b:c5:09:7f:22', name: 'infusion-4A-12', plane: 'LOCAL' };

/** Raised in beforeAll so the write gate knows a real ticket id (NET-4201). */
const RAISE_ALERT: AlertRow = {
  sev: 'P2',
  tone: 'warning',
  title: 'coa gate test alert',
  detail: 'raised so the ticket gate has a real id',
  siteId: 'campus-01',
  siteName: 'Campus-01 — Meridian HQ',
  plane: 'CENTRAL',
  state: 'open',
  age: '1m',
  device: 'sw-acc-3f-2',
};

function stateRef(): PlaneState {
  return { id: 'clearpass', linked: true, health: 'warning', lastSync: null, deviceCount: null, callsToday: 0, note: null };
}

/** A ClearPassAdapter whose outbound calls are answered by `responder`. */
function fakeAdapter(
  responder: (url: string, init?: RequestInit) => Promise<{ status: number; body?: unknown }>,
  seen?: Array<{ url: string; init?: RequestInit }>,
): InstanceType<typeof ClearPassAdapter> {
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    seen?.push({ url, init });
    const r = await responder(url, init);
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status });
  }) as typeof fetch;
  return new ClearPassAdapter({ host: 'cppm.example.local', token: 'tok-123' }, stateRef(), () => {}, fetchImpl);
}

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
  tmpDir = mkdtempSync(join(tmpdir(), 'hpe-coa-'));
  process.env.HPE_SETTINGS_PATH = join(tmpDir, 'settings.json');
  process.env.HPE_DATA_DIR = join(tmpDir, 'data');
  ({ CoaService } = await import('../src/services/coa'));
  ({ ClearPassAdapter } = await import('../src/planes/clearpass'));
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

describe('CoaService gating', () => {
  const lookup = (c: CoaClient | null) => () => c;

  it('requires a ticket and a MAC before anything else', async () => {
    const svc = new CoaService({ dataDir: freshDataDir(), lookupClient: lookup(WIRED), demoMode: () => true });
    await expect(svc.block(WIRED.mac, '')).rejects.toMatchObject({ status: 400, message: expect.stringContaining('ticket') });
    await expect(svc.block('', 'NET-4201')).rejects.toMatchObject({ status: 400, message: expect.stringContaining('MAC') });
  });

  it('rejects a ticket id the portal does not know, naming it — and logs nothing', async () => {
    const dataDir = freshDataDir();
    const svc = new CoaService({ dataDir, lookupClient: lookup(WIRED), demoMode: () => true });
    await expect(svc.block(WIRED.mac, 'NET-0000-BOGUS')).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining("unknown ticket 'NET-0000-BOGUS'"),
    });
    expect(logLines(dataDir)).toEqual([]); // a bogus reference is never audit-logged as real
  });

  it('404s a client the session inventory does not know', async () => {
    const svc = new CoaService({ dataDir: freshDataDir(), lookupClient: lookup(null), demoMode: () => true });
    await expect(svc.block('de:ad:be:ef:00:01', 'NET-4201')).rejects.toMatchObject({ status: 404 });
  });

  it('demo mode validates and audit-logs without pushing', async () => {
    const dataDir = freshDataDir();
    const svc = new CoaService({ dataDir, lookupClient: lookup(WIRED), demoMode: () => true });
    const res = await svc.block(WIRED.mac, 'NET-4201');
    expect(res.ok).toBe(true);
    expect(res.applied).toBe(false);
    expect(res.message).toContain('demo mode');
    const lines = logLines(dataDir);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ event: 'coa-disconnect', ticket: 'NET-4201', kind: 'client' });
    expect(statSync(join(dataDir, 'change-log.jsonl')).mode & 0o777).toBe(0o600);
  });

  it('409s when ClearPass is not linked (no adapter)', async () => {
    const svc = new CoaService({ dataDir: freshDataDir(), lookupClient: lookup(WIRED), demoMode: () => false, adapter: null });
    await expect(svc.block(WIRED.mac, 'NET-4201')).rejects.toMatchObject({ status: 409, message: expect.stringContaining('not linked') });
  });
});

describe('CoaService push', () => {
  const lookup = () => WIRED;

  it('posts the session-action disconnect path with the Bearer token and claims success on 2xx', async () => {
    const seen: Array<{ url: string; init?: RequestInit }> = [];
    const svc = new CoaService({
      dataDir: freshDataDir(),
      lookupClient: lookup,
      demoMode: () => false,
      adapter: fakeAdapter(async () => ({ status: 200, body: {} }), seen),
    });
    const res = await svc.block(WIRED.mac, 'NET-4201');
    expect(res.applied).toBe(true);
    expect(res.httpCode).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe('https://cppm.example.local/api/session-action/disconnect/mac/00%3A1b%3Ac5%3A09%3A7f%3A22');
    expect(seen[0].init?.method).toBe('POST');
    expect((seen[0].init?.headers as Record<string, string>).authorization).toBe('Bearer tok-123');
  });

  it('reports a non-2xx honestly and logs the rejection', async () => {
    const dataDir = freshDataDir();
    const svc = new CoaService({
      dataDir,
      lookupClient: lookup,
      demoMode: () => false,
      adapter: fakeAdapter(async () => ({ status: 404, body: { detail: 'no active session' } })),
    });
    const res = await svc.block(WIRED.mac, 'NET-4201');
    expect(res.ok).toBe(false);
    expect(res.applied).toBe(false);
    expect(res.httpCode).toBe(404);
    expect(res.message).toContain('HTTP 404');
    expect(res.message).toContain('no active session');
    expect(logLines(dataDir)[0]).toMatchObject({ result: 'rejected', httpCode: 404 });
  });

  /* A 2xx from the session-action endpoint is ClearPass saying it issued the
   * CoA to the NAD. It is not the NAD's answer — a Disconnect-NAK, an
   * unreachable NAD or a shared-secret mismatch are all invisible in it. The
   * success message used to read "<name>'s session is terminated at the NAD",
   * which asserted the one fact the response cannot carry, and contradicted
   * this module's own header promise that the portal never claims a block the
   * NAD did not confirm. This is the control an operator reaches for when a
   * client is compromised, so being wrong here is expensive. */
  it('does not claim the NAD terminated the session — a 2xx only means the CoA was issued', async () => {
    const svc = new CoaService({
      dataDir: freshDataDir(),
      lookupClient: lookup,
      demoMode: () => false,
      adapter: fakeAdapter(async () => ({ status: 200, body: {} })),
    });
    const res = await svc.block(WIRED.mac, 'NET-4201');
    expect(res.applied).toBe(true);
    expect(res.message).not.toContain('is terminated');
    expect(res.message).toContain('issued to the NAD');
    // And it must actively tell the operator the block is still unconfirmed,
    // rather than merely omitting the overclaim.
    expect(res.message).toMatch(/confirm the session has actually dropped/);
  });

  it('says the same unconfirmed thing on a 202 as on a 200 — neither carries the NAD reply', async () => {
    // CPPM versions differ on 200 vs 202 here, so the wording must not imply
    // that one of them is more final than the other.
    const messages: string[] = [];
    for (const status of [200, 202]) {
      const svc = new CoaService({
        dataDir: freshDataDir(),
        lookupClient: lookup,
        demoMode: () => false,
        adapter: fakeAdapter(async () => ({ status, body: {} })),
      });
      const res = await svc.block(WIRED.mac, 'NET-4201');
      expect(res.applied).toBe(true);
      expect(res.httpCode).toBe(status);
      messages.push(res.message.replace(`HTTP ${status}`, 'HTTP <code>'));
    }
    expect(messages[0]).toBe(messages[1]);
  });

  it('reports a network failure as an honest failure, not a throw', async () => {
    const svc = new CoaService({
      dataDir: freshDataDir(),
      lookupClient: lookup,
      demoMode: () => false,
      adapter: fakeAdapter(async () => {
        throw new Error('socket hang up');
      }),
    });
    const res = await svc.block(WIRED.mac, 'NET-4201');
    expect(res.ok).toBe(false);
    expect(res.message).toContain('socket hang up');
  });
});

describe('POST /api/clients/:mac/block (demo-mode app)', () => {
  it('400s without a ticket and 404s on an unknown client', async () => {
    const noTicket = await fetch(`${base}/api/clients/00:1b:c5:09:7f:22/block`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(noTicket.status).toBe(400);

    const unknown = await fetch(`${base}/api/clients/de:ad:be:ef:00:99/block`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ticket: 'NET-4201' }),
    });
    expect(unknown.status).toBe(404);
  });

  it('demo mode validates and logs against the fixture client', async () => {
    const res = await fetch(`${base}/api/clients/00:1b:c5:09:7f:22/block`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ticket: 'NET-4201' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; applied: boolean; message: string };
    expect(body.ok).toBe(true);
    expect(body.applied).toBe(false);
    expect(body.message).toContain('demo mode');
  });

  it('finds the fixture client whatever the MAC separator/case', async () => {
    // Same client as above ('00:1b:c5:09:7f:22') in the formats planes actually report.
    for (const mac of ['00-1B-C5-09-7F-22', '001b.c509.7f22']) {
      const res = await fetch(`${base}/api/clients/${encodeURIComponent(mac)}/block`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ticket: 'NET-4201' }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean };
      expect(body.ok).toBe(true);
    }
  });
});
