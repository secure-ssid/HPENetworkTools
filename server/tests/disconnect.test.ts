/**
 * server/tests/disconnect.test.ts — the ticket-gated client disconnect, NO network.
 *
 * Same conventions as reboot.test.ts: service-level tests use injected
 * lookups / transport / demo flag against per-test tmp data dirs; route-level
 * tests boot createApp() on an ephemeral port with HPE_SETTINGS_PATH and
 * HPE_DATA_DIR pointed at tmp (set before the dynamic imports in beforeAll).
 */

import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DisconnectClient } from '../src/services/disconnect';
import type { AlertRow } from '@hpe/shared';

let DisconnectService: typeof import('../src/services/disconnect').DisconnectService;
let createApp: typeof import('../src/index').createApp;

let tmpDir: string;
let server: Server;
let base: string;

let dirCounter = 0;
function freshDataDir(): string {
  return join(tmpDir, `d${dirCounter++}`);
}

const WIRELESS: DisconnectClient = { mac: 'aa:bb:cc:dd:ee:01', name: 'ipad-01', attach: 'ap-1f-04', plane: 'CENTRAL' };
const AP_DEVICE = { type: 'ap', plane: 'CENTRAL', serial: 'CN77K2X0AB' };
const GW_DEVICE = { type: 'gateway', plane: 'CENTRAL', serial: 'CN99GW0XYZ' };

/** Raised in beforeAll so the write gate knows a real ticket id (NET-4201). */
const RAISE_ALERT: AlertRow = {
  sev: 'P2',
  tone: 'warning',
  title: 'disconnect gate test alert',
  detail: 'raised so the ticket gate has a real id',
  siteId: 'campus-01',
  siteName: 'Campus-01 — Meridian HQ',
  plane: 'CENTRAL',
  state: 'open',
  age: '1m',
  device: 'ap-1f-04',
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
  tmpDir = mkdtempSync(join(tmpdir(), 'hpe-disconnect-'));
  process.env.HPE_SETTINGS_PATH = join(tmpDir, 'settings.json');
  process.env.HPE_DATA_DIR = join(tmpDir, 'data');
  ({ DisconnectService } = await import('../src/services/disconnect'));
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

describe('DisconnectService gating', () => {
  it('requires a ticket before anything else', async () => {
    const svc = new DisconnectService({
      dataDir: freshDataDir(),
      lookupClient: () => WIRELESS,
      lookupDevice: () => AP_DEVICE,
      demoMode: () => true,
    });
    await expect(svc.disconnect(WIRELESS.mac, '')).rejects.toMatchObject({ status: 400, message: expect.stringContaining('ticket') });
  });

  it('rejects a ticket id the portal does not know, naming it — and logs nothing', async () => {
    const dataDir = freshDataDir();
    const svc = new DisconnectService({ dataDir, lookupClient: () => WIRELESS, lookupDevice: () => AP_DEVICE, demoMode: () => true });
    await expect(svc.disconnect(WIRELESS.mac, 'NET-0000-BOGUS')).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining("unknown ticket 'NET-0000-BOGUS'"),
    });
    expect(logLines(dataDir)).toEqual([]); // a bogus reference is never audit-logged as real
  });

  it('404s on a client the session inventory does not know', async () => {
    const svc = new DisconnectService({ dataDir: freshDataDir(), lookupClient: () => null, demoMode: () => true });
    await expect(svc.disconnect('00:00:00:00:00:00', 'NET-4201')).rejects.toMatchObject({ status: 404 });
  });

  it('demo mode validates and audit-logs without pushing', async () => {
    const dataDir = freshDataDir();
    const svc = new DisconnectService({ dataDir, lookupClient: () => WIRELESS, lookupDevice: () => AP_DEVICE, demoMode: () => true });
    const res = await svc.disconnect(WIRELESS.mac, 'NET-4201');
    expect(res.ok).toBe(true);
    expect(res.applied).toBe(false);
    expect(res.message).toContain('demo mode');
    expect(logLines(dataDir)[0]).toMatchObject({ event: 'disconnect', ticket: 'NET-4201', kind: 'client' });
    expect(statSync(join(dataDir, 'change-log.jsonl')).mode & 0o777).toBe(0o600);
  });

  it('409s non-Central clients with an honest hand-off', async () => {
    const svc = new DisconnectService({
      dataDir: freshDataDir(),
      lookupClient: () => ({ ...WIRELESS, plane: 'MIST' }),
      demoMode: () => false,
    });

    await expect(svc.disconnect(WIRELESS.mac, 'NET-4201')).rejects.toMatchObject({ status: 409, message: expect.stringContaining('MIST') });
  });

  it('rejects an ambiguous attachment name with safe candidates and no action', async () => {
    const seen: string[] = [];
    const svc = new DisconnectService({
      dataDir: freshDataDir(),
      lookupClient: () => WIRELESS,
      listDevices: () => [
        { name: WIRELESS.attach, type: 'ap', plane: 'CENTRAL', serial: 'SERIAL-A' },
        { name: WIRELESS.attach, type: 'ap', plane: 'CENTRAL', serial: 'SERIAL-B' },
      ],
      demoMode: () => false,
      knownTicket: () => true,
      transport: {
        request: async (_method, path) => {
          seen.push(path);
          return { status: 202, body: {} };
        },
      },
    });
    await expect(svc.disconnect(WIRELESS.mac, 'NET-4201')).rejects.toMatchObject({
      status: 409,
      details: {
        candidates: [
          { plane: 'CENTRAL', serial: 'SERIAL-A' },
          { plane: 'CENTRAL', serial: 'SERIAL-B' },
        ],
      },
    });
    expect(seen).toEqual([]);
  });

  it('409s when the attachment device is not an AP or gateway', async () => {
    const svc = new DisconnectService({
      dataDir: freshDataDir(),
      lookupClient: () => WIRELESS,
      lookupDevice: () => ({ type: 'switch', plane: 'CENTRAL', serial: 'SN1' }),
      demoMode: () => false,
    });
    await expect(svc.disconnect(WIRELESS.mac, 'NET-4201')).rejects.toMatchObject({ status: 409, message: expect.stringContaining('ClearPass CoA') });
  });

  it('409s when Central is not linked (no transport)', async () => {
    const svc = new DisconnectService({
      dataDir: freshDataDir(),
      lookupClient: () => WIRELESS,
      lookupDevice: () => AP_DEVICE,
      demoMode: () => false,
      transport: null,
    });
    await expect(svc.disconnect(WIRELESS.mac, 'NET-4201')).rejects.toMatchObject({ status: 409, message: expect.stringContaining('not linked') });
  });
});

describe('DisconnectService push', () => {
  it('posts the AP path with userMacAddress, the gateway path with clientMacAddress', async () => {
    const seen: string[] = [];
    const mk = (device: { type: string; plane: string; serial: string }) =>
      new DisconnectService({
        dataDir: freshDataDir(),
        lookupClient: () => WIRELESS,
        lookupDevice: () => device,
        demoMode: () => false,
        transport: {
          request: async (method, path, body) => {
            seen.push(`${method} ${path} ${JSON.stringify(body)}`);
            return { status: 202, body: {} };
          },
        },
      });
    const apRes = await mk(AP_DEVICE).disconnect(WIRELESS.mac, 'NET-4201');
    const gwRes = await mk(GW_DEVICE).disconnect(WIRELESS.mac, 'NET-4201');
    expect(apRes.applied).toBe(true);
    expect(gwRes.applied).toBe(true);
    expect(seen).toEqual([
      `POST /network-troubleshooting/v1/aps/${AP_DEVICE.serial}/disconnectUserByMacAddress {"userMacAddress":"${WIRELESS.mac}"}`,
      `POST /network-troubleshooting/v1/gateways/${GW_DEVICE.serial}/disconnectClientByMacAddress {"clientMacAddress":"${WIRELESS.mac}"}`,
    ]);
  });

  it('reports a non-202 honestly and logs the rejection', async () => {
    const dataDir = freshDataDir();
    const svc = new DisconnectService({
      dataDir,
      lookupClient: () => WIRELESS,
      lookupDevice: () => AP_DEVICE,
      demoMode: () => false,
      transport: { request: async () => ({ status: 500, body: {} }) },
    });
    const res = await svc.disconnect(WIRELESS.mac, 'NET-4201');
    expect(res.ok).toBe(false);
    expect(res.applied).toBe(false);
    expect(res.httpCode).toBe(500);
    expect(logLines(dataDir)[0]).toMatchObject({ result: 'rejected', httpCode: 500 });
  });
});

describe('POST /api/clients/:mac/disconnect (demo-mode app)', () => {
  it('400s without a ticket on a known client and 404s on an unknown MAC', async () => {
    // 8c:85:90:22:d1:04 is the fixture client 'j.alvarez' (CENTRAL, ap-3f-08).
    const noTicket = await fetch(`${base}/api/clients/${encodeURIComponent('8c:85:90:22:d1:04')}/disconnect`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(noTicket.status).toBe(400);

    const unknown = await fetch(`${base}/api/clients/${encodeURIComponent('00:00:00:00:00:00')}/disconnect`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ticket: 'NET-4201' }),
    });
    expect(unknown.status).toBe(404);
  });

  it('finds the fixture client whatever the MAC separator/case', async () => {
    // Same client as above ('8c:85:90:22:d1:04') in the formats planes actually report.
    for (const mac of ['8C-85-90-22-D1-04', '8c85.9022.d104']) {
      const res = await fetch(`${base}/api/clients/${encodeURIComponent(mac)}/disconnect`, {
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
