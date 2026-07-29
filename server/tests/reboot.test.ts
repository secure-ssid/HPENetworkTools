/**
 * server/tests/reboot.test.ts — the ticket-gated reboot action, NO network.
 *
 * Service-level tests construct RebootService instances against per-test tmp
 * data dirs with an injected transport (a fake CentralAdapter.request), an
 * injected device lookup and an injected demo flag. Route-level tests boot
 * createApp() on an ephemeral port like routes.test.ts.
 *
 * HPE_SETTINGS_PATH and HPE_DATA_DIR point at a tmp dir so neither the
 * settings singleton nor the rebootService singleton (constructed at import)
 * ever touches the real data/ — the env vars must be set before the app
 * modules are imported, so imports are dynamic inside beforeAll.
 */

import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RebootDevice } from '../src/services/reboot';
import type { AlertRow } from '../../shared';

let RebootService: typeof import('../src/services/reboot').RebootService;
let createApp: typeof import('../src/index').createApp;
let createDevicesRouter: typeof import('../src/routes/devices').createDevicesRouter;
let tmpDir: string;
let server: Server;
let base: string;

let dirCounter = 0;
function freshDataDir(): string {
  return join(tmpDir, `d${dirCounter++}`);
}

const AP: RebootDevice = { name: 'ap-lobby-01', type: 'ap', plane: 'CENTRAL', serial: 'CN77K2X0AB' };

/** Raised in beforeAll so the write gate knows a real ticket id (NET-4201). */
const RAISE_ALERT: AlertRow = {
  sev: 'P2',
  tone: 'warning',
  title: 'reboot gate test alert',
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
  tmpDir = mkdtempSync(join(tmpdir(), 'hpe-reboot-'));
  process.env.HPE_SETTINGS_PATH = join(tmpDir, 'settings.json');
  process.env.HPE_DATA_DIR = join(tmpDir, 'data');
  ({ RebootService } = await import('../src/services/reboot'));
  ({ createApp } = await import('../src/index'));
  ({ createDevicesRouter } = await import('../src/routes/devices'));
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

describe('RebootService gating', () => {
  const lookup = (d: RebootDevice | null) => () => d;

  it('requires a ticket before anything else', async () => {
    const svc = new RebootService({ dataDir: freshDataDir(), lookupDevice: lookup(AP), demoMode: () => true });
    await expect(svc.reboot('ap-lobby-01', '')).rejects.toMatchObject({ status: 400, message: expect.stringContaining('ticket') });
  });

  it('rejects a ticket id the portal does not know, naming it — and logs nothing', async () => {
    const dataDir = freshDataDir();
    const svc = new RebootService({ dataDir, lookupDevice: lookup(AP), demoMode: () => true });
    await expect(svc.reboot('ap-lobby-01', 'NET-0000-BOGUS')).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining("unknown ticket 'NET-0000-BOGUS'"),
    });
    expect(logLines(dataDir)).toEqual([]); // a bogus reference is never audit-logged as real
  });

  it('accepts a raised ticket and, in demo mode, a fixture-queue id', async () => {
    const svc = new RebootService({ dataDir: freshDataDir(), lookupDevice: lookup(AP), demoMode: () => true });
    expect((await svc.reboot('ap-lobby-01', 'NET-4201')).ok).toBe(true); // raised in beforeAll
    expect((await svc.reboot('ap-lobby-01', 'NET-4188')).ok).toBe(true); // fixture queue, demo mode on
  });

  it('404s on a device the inventory does not know', async () => {
    const svc = new RebootService({ dataDir: freshDataDir(), lookupDevice: lookup(null), demoMode: () => true });
    await expect(svc.reboot('ap-nope', 'NET-4201')).rejects.toMatchObject({ status: 404 });
  });

  it('demo mode validates and audit-logs without pushing', async () => {
    const dataDir = freshDataDir();
    const svc = new RebootService({ dataDir, lookupDevice: lookup(AP), demoMode: () => true });
    const res = await svc.reboot('ap-lobby-01', 'NET-4201');
    expect(res.ok).toBe(true);
    expect(res.applied).toBe(false);
    expect(res.message).toContain('demo mode');
    const lines = logLines(dataDir);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ event: 'reboot', ticket: 'NET-4201', kind: 'reboot' });
    expect(statSync(join(dataDir, 'change-log.jsonl')).mode & 0o777).toBe(0o600);
  });

  it('409s non-Central devices with an honest hand-off', async () => {
    const svc = new RebootService({
      dataDir: freshDataDir(),
      lookupDevice: lookup({ name: 'sw-agg-01', type: 'switch', plane: 'LOCAL' }),
      demoMode: () => false,
    });
    await expect(svc.reboot('sw-agg-01', 'NET-4201')).rejects.toMatchObject({ status: 409, message: expect.stringContaining('SSH session') });
  });

  it('409s Central devices without a serial on record', async () => {
    const svc = new RebootService({
      dataDir: freshDataDir(),
      lookupDevice: lookup({ name: 'ap-lobby-02', type: 'ap', plane: 'CENTRAL' }),
      demoMode: () => false,
    });
    await expect(svc.reboot('ap-lobby-02', 'NET-4201')).rejects.toMatchObject({ status: 409, message: expect.stringContaining('serial') });
  });

  it('409s when Central is not linked (no transport)', async () => {
    const svc = new RebootService({
      dataDir: freshDataDir(),
      lookupDevice: lookup(AP),
      demoMode: () => false,
      transport: null,
    });
    await expect(svc.reboot('ap-lobby-01', 'NET-4201')).rejects.toMatchObject({ status: 409, message: expect.stringContaining('not linked') });
  });
});

describe('RebootService push', () => {
  const lookup = (d: RebootDevice) => () => d;

  it('posts the troubleshooting path per device type and claims success only on 202', async () => {
    const seen: string[] = [];
    for (const [type, tb] of [['ap', 'aps'], ['switch', 'cx'], ['gateway', 'gateways']] as const) {
      const svc = new RebootService({
        dataDir: freshDataDir(),
        lookupDevice: lookup({ name: `d-${type}`, type, plane: 'CENTRAL', serial: 'SN1' }),
        demoMode: () => false,
        transport: {
          request: async (method, path) => {
            seen.push(`${method} ${path}`);
            return { status: 202, body: {} };
          },
        },
      });
      const res = await svc.reboot(`d-${type}`, 'NET-4201');
      expect(res.applied).toBe(true);
      expect(res.httpCode).toBe(202);
    }
    expect(seen).toEqual([
      'POST /network-troubleshooting/v1/aps/SN1/reboot',
      'POST /network-troubleshooting/v1/cx/SN1/reboot',
      'POST /network-troubleshooting/v1/gateways/SN1/reboot',
    ]);
  });

  it('reports a non-202 honestly and logs the rejection', async () => {
    const dataDir = freshDataDir();
    const svc = new RebootService({
      dataDir,
      lookupDevice: lookup(AP),
      demoMode: () => false,
      transport: { request: async () => ({ status: 404, body: {} }) },
    });
    const res = await svc.reboot('ap-lobby-01', 'NET-4201');
    expect(res.ok).toBe(false);
    expect(res.applied).toBe(false);
    expect(res.httpCode).toBe(404);
    expect(res.message).toContain('HTTP 404');
    expect(logLines(dataDir)[0]).toMatchObject({ result: 'rejected', httpCode: 404 });
  });

  it('reports a transport exception as an honest failure, not a throw', async () => {
    const svc = new RebootService({
      dataDir: freshDataDir(),
      lookupDevice: lookup(AP),
      demoMode: () => false,
      transport: {
        request: async () => {
          throw new Error('socket hang up');
        },
      },
    });
    const res = await svc.reboot('ap-lobby-01', 'NET-4201');
    expect(res.ok).toBe(false);
    expect(res.message).toContain('socket hang up');
  });

  it('targets the exact plane+serial among duplicate display names and audits that identity', async () => {
    const dataDir = freshDataDir();
    const seen: string[] = [];
    const devices: RebootDevice[] = [
      { name: 'shared-ap', type: 'ap', plane: 'CENTRAL', serial: 'SERIAL-A' },
      { name: 'shared-ap', type: 'ap', plane: 'CENTRAL', serial: 'SERIAL-B' },
    ];
    const svc = new RebootService({
      dataDir,
      listDevices: () => devices,
      demoMode: () => false,
      knownTicket: () => true,
      transport: {
        request: async (method, path) => {
          seen.push(`${method} ${path}`);
          return { status: 202, body: {} };
        },
      },
    });

    const result = await svc.reboot('shared-ap', 'NET-4201', {
      plane: 'CENTRAL',
      serial: 'SERIAL-B',
    });
    expect(result).toMatchObject({ applied: true, plane: 'CENTRAL', serial: 'SERIAL-B' });
    expect(seen).toEqual(['POST /network-troubleshooting/v1/aps/SERIAL-B/reboot']);
    expect(logLines(dataDir)[0]).toMatchObject({
      event: 'reboot',
      device: 'shared-ap',
      plane: 'CENTRAL',
      serial: 'SERIAL-B',
    });
  });

  it('rejects ambiguous legacy names with safe candidates and issues no action', async () => {
    const seen: string[] = [];
    const svc = new RebootService({
      dataDir: freshDataDir(),
      listDevices: () => [
        { name: 'shared-ap', type: 'ap', plane: 'CENTRAL', serial: 'SERIAL-A' },
        { name: 'shared-ap', type: 'ap', plane: 'MIST', serial: 'SERIAL-B' },
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

    await expect(svc.reboot('shared-ap', 'NET-4201')).rejects.toMatchObject({
      status: 409,
      details: {
        candidates: [
          { plane: 'CENTRAL', serial: 'SERIAL-A' },
          { plane: 'MIST', serial: 'SERIAL-B' },
        ],
      },
    });
    expect(seen).toEqual([]);
  });

  it('keeps unique legacy compatibility but never falls back from stale or mismatched identity', async () => {
    const seen: string[] = [];
    const svc = new RebootService({
      dataDir: freshDataDir(),
      listDevices: () => [AP],
      demoMode: () => false,
      knownTicket: () => true,
      transport: {
        request: async (_method, path) => {
          seen.push(path);
          return { status: 202, body: {} };
        },
      },
    });

    expect((await svc.reboot(AP.name, 'NET-4201')).applied).toBe(true);
    await expect(svc.reboot(AP.name, 'NET-4201', {
      plane: 'CENTRAL',
      serial: 'STALE-SERIAL',
    })).rejects.toMatchObject({ status: 404 });
    await expect(svc.reboot('different-route-name', 'NET-4201', {
      plane: 'CENTRAL',
      serial: AP.serial,
    })).rejects.toMatchObject({ status: 409 });
    expect(seen).toEqual(['/network-troubleshooting/v1/aps/CN77K2X0AB/reboot']);
  });
});

describe('POST /api/devices/:name/reboot (demo-mode app)', () => {
  it('400s without a ticket and 404s on an unknown device', async () => {
    const noTicket = await fetch(`${base}/api/devices/ap-1f-04/reboot`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(noTicket.status).toBe(400);

    const unknown = await fetch(`${base}/api/devices/not-a-device/reboot`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ticket: 'NET-4201' }),
    });
    expect(unknown.status).toBe(404);
  });

  it('returns 409 candidate metadata for an ambiguous legacy action and accepts an exact identity', async () => {
    const seen: string[] = [];
    const service = new RebootService({
      dataDir: freshDataDir(),
      listDevices: () => [
        { name: 'shared-ap', type: 'ap', plane: 'CENTRAL', serial: 'SERIAL-A' },
        { name: 'shared-ap', type: 'ap', plane: 'CENTRAL', serial: 'SERIAL-B' },
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
    const express = (await import('express')).default;
    const app = express();
    app.use(express.json());
    app.use('/api', createDevicesRouter(service));
    const identityServer = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => identityServer.once('listening', resolve));
    const identityBase = `http://127.0.0.1:${(identityServer.address() as AddressInfo).port}`;
    try {
      const ambiguous = await fetch(`${identityBase}/api/devices/shared-ap/reboot`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ticket: 'NET-4201' }),
      });
      expect(ambiguous.status).toBe(409);
      expect(await ambiguous.json()).toMatchObject({
        candidates: [
          { plane: 'CENTRAL', serial: 'SERIAL-A' },
          { plane: 'CENTRAL', serial: 'SERIAL-B' },
        ],
      });
      expect(seen).toEqual([]);

      const exact = await fetch(`${identityBase}/api/devices/shared-ap/reboot`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ticket: 'NET-4201',
          plane: 'CENTRAL',
          serial: 'SERIAL-B',
        }),
      });
      expect(exact.status).toBe(200);
      expect(seen).toEqual(['/network-troubleshooting/v1/aps/SERIAL-B/reboot']);
    } finally {
      await new Promise<void>((resolve) => identityServer.close(() => resolve()));
    }
  });
});
