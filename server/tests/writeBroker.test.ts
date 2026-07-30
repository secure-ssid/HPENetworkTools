/**
 * server/tests/writeBroker.test.ts — the brokered-write pipeline, NO network.
 *
 * Service-level tests construct WriteBroker instances against per-test tmp
 * data dirs with an injected transport (a fake CentralAdapter.request) and,
 * where timing matters, an injected clock. Tests not about the ticket gate
 * inject a permissive knownTicket — the gate itself has its own describe.
 * Route-level tests boot createApp() on an ephemeral port like routes.test.ts.
 *
 * HPE_SETTINGS_PATH and HPE_DATA_DIR point at a tmp dir so neither the
 * settings singleton nor the writeBroker singleton (constructed at import)
 * ever touches the real data/ — the env vars must be set before the app
 * modules are imported, so imports are dynamic inside beforeAll.
 */

import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_PORT_FORM,
  DEFAULT_SSID_FORM,
  DEFAULT_VLAN_FORM,
  blastRadiusFor,
  configPreviewFor,
  previewMetaFor,
  type AlertRow,
} from '@hpe/shared';
import type { BrokerTransport } from '../src/services/writeBroker';

let WriteBroker: typeof import('../src/services/writeBroker').WriteBroker;
let SettingsStore: typeof import('../src/config/settings').SettingsStore;
let PlaneRegistry: typeof import('../src/planes/registry').PlaneRegistry;
let createApp: typeof import('../src/index').createApp;

let tmpDir: string;
let server: Server;
let base: string;

let dirCounter = 0;
function freshDataDir(): string {
  return join(tmpDir, `d${dirCounter++}`);
}

/** Raised in beforeAll so the default ticket gate knows a real raised id. */
const RAISE_ALERT: AlertRow = {
  sev: 'P2',
  tone: 'warning',
  title: 'broker gate test alert',
  detail: 'raised so the ticket gate has a real id',
  siteId: 'campus-01',
  siteName: 'Campus-01 — Meridian HQ',
  plane: 'CENTRAL',
  state: 'open',
  age: '1m',
  device: 'sw-core-a',
};
let raisedTicketId = '';

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'hpe-broker-'));
  process.env.HPE_SETTINGS_PATH = join(tmpDir, 'settings.json');
  process.env.HPE_DATA_DIR = join(tmpDir, 'data');
  ({ WriteBroker } = await import('../src/services/writeBroker'));
  ({ SettingsStore } = await import('../src/config/settings'));
  ({ PlaneRegistry } = await import('../src/planes/registry'));
  ({ createApp } = await import('../src/index'));
  const { ticketStore } = await import('../src/services/tickets');
  raisedTicketId = ticketStore.raiseFromAlert(RAISE_ALERT).id;
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

function transportWith(status: number, body: unknown = {}): BrokerTransport & { calls: { method: string; path: string }[] } {
  const calls: { method: string; path: string }[] = [];
  return {
    calls,
    request: async (method, path) => {
      calls.push({ method, path });
      return { status, body };
    },
  };
}

/** A 200 transport whose PUT blocks until releasePut() — for in-flight push tests. */
function gatedTransport() {
  const calls: { method: string; path: string }[] = [];
  let releasePut!: () => void;
  let markPutStarted!: () => void;
  const putStarted = new Promise<void>((resolve) => {
    markPutStarted = resolve;
  });
  const transport: BrokerTransport & { calls: typeof calls } = {
    calls,
    request: async (method, path) => {
      calls.push({ method, path });
      if (method === 'PUT') {
        markPutStarted();
        await new Promise<void>((resolve) => {
          releasePut = resolve;
        });
      }
      return { status: 200, body: {} };
    },
  };
  return { transport, calls, putStarted, releasePut: () => releasePut() };
}

/** Tests not about the ticket gate inject a permissive one; the gate itself has its own describe. */
const anyTicket = () => true;

async function postJson(path: string, payload: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return { status: res.status, body: await res.json() };
}

// ---------------------------------------------------------------------------

describe('render pass-through', () => {
  it('renders byte-for-byte what the shared preview renderers produce', () => {
    const broker = new WriteBroker({ dataDir: freshDataDir(), transport: null, knownTicket: anyTicket });

    const ssid = broker.renderPayload('ssid', DEFAULT_SSID_FORM);
    expect(ssid.rendered).toBe(configPreviewFor('ssid', DEFAULT_SSID_FORM));
    expect(ssid.meta).toBe(previewMetaFor('ssid', DEFAULT_SSID_FORM));
    expect(ssid.blastRadius).toEqual(blastRadiusFor('ssid', DEFAULT_SSID_FORM));

    const port = broker.renderPayload('port', DEFAULT_PORT_FORM);
    expect(port.rendered).toBe(configPreviewFor('port', DEFAULT_PORT_FORM));
    expect(port.meta).toBe(previewMetaFor('port', DEFAULT_PORT_FORM));
    expect(port.blastRadius).toEqual(blastRadiusFor('port', DEFAULT_PORT_FORM));

    const vlan = broker.renderPayload('vlan', DEFAULT_VLAN_FORM);
    expect(vlan.rendered).toBe(configPreviewFor('vlan', DEFAULT_VLAN_FORM));
    expect(vlan.meta).toBe(previewMetaFor('vlan', DEFAULT_VLAN_FORM));
    expect(vlan.blastRadius).toEqual(blastRadiusFor('vlan', DEFAULT_VLAN_FORM));
  });

  it('rejects an unknown kind with a 400 BrokerError', () => {
    const broker = new WriteBroker({ dataDir: freshDataDir(), transport: null, knownTicket: anyTicket });
    try {
      broker.renderPayload('router', {});
      expect.unreachable();
    } catch (err) {
      expect((err as { status?: number }).status).toBe(400);
      expect((err as Error).message).toMatch(/kind must be one of/);
    }
  });

  it('rejects missing fields, unsupported enums, and VLAN ids outside 1-4094', () => {
    const broker = new WriteBroker({ dataDir: freshDataDir(), transport: null, knownTicket: anyTicket });
    expect(() => broker.renderPayload('ssid', { ...DEFAULT_SSID_FORM, name: '' })).toThrow(/must not be empty: name/);
    expect(() => broker.renderPayload('ssid', { ...DEFAULT_SSID_FORM, security: 'open-ish' })).toThrow(
      /unsupported SSID security/,
    );
    expect(() => broker.renderPayload('ssid', { ...DEFAULT_SSID_FORM, vlan: '4095' })).toThrow(/between 1 and 4094/);
    expect(() => broker.renderPayload('port', { ...DEFAULT_PORT_FORM, mode: 'hybrid' })).toThrow(
      /unsupported port mode/,
    );
    expect(() => broker.renderPayload('port', { ...DEFAULT_PORT_FORM, vlan: '0' })).toThrow(/between 1 and 4094/);
    expect(() => broker.renderPayload('vlan', { ...DEFAULT_VLAN_FORM, id: 'abc' })).toThrow(/between 1 and 4094/);
    expect(() => broker.renderPayload('vlan', { ...DEFAULT_VLAN_FORM, scope: 'everywhere' })).toThrow(
      /unsupported VLAN scope/,
    );
  });
});

describe('ticket gate', () => {
  it('queue and dry-run refuse a blank ticket with a 400', async () => {
    const broker = new WriteBroker({ dataDir: freshDataDir(), transport: null, knownTicket: anyTicket });
    for (const ticket of ['', '   ']) {
      try {
        broker.queue('ssid', DEFAULT_SSID_FORM, ticket);
        expect.unreachable();
      } catch (err) {
        expect((err as { status?: number }).status).toBe(400);
        expect((err as Error).message).toMatch(/ticket reference required/);
      }
      await expect(broker.dryRun('ssid', DEFAULT_SSID_FORM, ticket)).rejects.toThrow(/ticket reference required/);
    }
  });

  it('queue and dry-run reject a ticket id the portal does not know, naming it', async () => {
    // The DEFAULT gate (no injection): the store in HPE_DATA_DIR plus, in
    // demo mode, the fixture queue. NET-0000-BOGUS is neither.
    const broker = new WriteBroker({ dataDir: freshDataDir(), transport: null });
    try {
      broker.queue('ssid', DEFAULT_SSID_FORM, 'NET-0000-BOGUS');
      expect.unreachable();
    } catch (err) {
      expect((err as { status?: number }).status).toBe(400);
      expect((err as Error).message).toContain("unknown ticket 'NET-0000-BOGUS'");
    }
    await expect(broker.dryRun('ssid', DEFAULT_SSID_FORM, 'NET-0000-BOGUS')).rejects.toThrow(/unknown ticket 'NET-0000-BOGUS'/);
    expect(broker.list()).toEqual([]); // a rejected reference never lands in the queue
  });

  it('the default gate accepts a raised ticket and, in demo mode, a fixture-queue id', () => {
    const broker = new WriteBroker({ dataDir: freshDataDir(), transport: null });
    expect(broker.queue('ssid', DEFAULT_SSID_FORM, raisedTicketId).ticket).toBe(raisedTicketId);
    expect(broker.queue('ssid', DEFAULT_SSID_FORM, 'NET-4188').ticket).toBe('NET-4188'); // fixture, demo mode on
  });
});

describe('queue state by plane link status', () => {
  it('console for a mist-only SSID, needs window when central is unlinked, ready + lease when linked', () => {
    const store = new SettingsStore(join(tmpDir, 'link-settings.json'));
    const reg = new PlaneRegistry(store);
    const broker = new WriteBroker({ registry: reg, dataDir: freshDataDir(), knownTicket: anyTicket });

    const unlinked = broker.queue('ssid', DEFAULT_SSID_FORM, 'NET-1');
    expect(unlinked.state).toBe('needs window');
    expect(unlinked.expiresAt).toBeNull();

    const consoleChange = broker.queue('ssid', { ...DEFAULT_SSID_FORM, plane: 'MIST' }, 'NET-1');
    expect(consoleChange.state).toBe('console');
    expect(consoleChange.where).toMatch(/Mist · read-only/);
    expect(consoleChange.expiresAt).toBeNull();

    store.update({
      planes: { central: { gatewayBaseUrl: 'https://gw.example.com', clientId: 'id', clientSecret: 'secret' } },
    });
    reg.reinitPlane('central');
    const ready = broker.queue('ssid', DEFAULT_SSID_FORM, 'NET-1');
    expect(ready.state).toBe('ready');
    expect(Date.parse(ready.expiresAt!) - Date.parse(ready.createdAt)).toBe(15 * 60 * 1000);
    expect(ready.rendered).toBe(configPreviewFor('ssid', DEFAULT_SSID_FORM));
  });

  it('persists the queue to change-queue.json (0600) and reloads it in a new instance', () => {
    const dataDir = freshDataDir();
    const a = new WriteBroker({ dataDir, transport: null, knownTicket: anyTicket });
    const change = a.queue('ssid', DEFAULT_SSID_FORM, 'NET-2');
    expect(statSync(join(dataDir, 'change-queue.json')).mode & 0o777).toBe(0o600);
    const b = new WriteBroker({ dataDir, transport: null, knownTicket: anyTicket });
    expect(b.list().map((c) => c.id)).toEqual([change.id]);
    expect(b.list()[0].ticket).toBe('NET-2');
  });

  it('does not mutate the in-memory queue when persistence fails', () => {
    const dataDir = freshDataDir();
    const broker = new WriteBroker({ dataDir, transport: null, knownTicket: anyTicket });
    const first = broker.queue('ssid', DEFAULT_SSID_FORM, 'NET-2');
    rmSync(dataDir, { recursive: true, force: true });
    writeFileSync(dataDir, 'blocks directory recreation');

    expect(() => broker.queue('vlan', DEFAULT_VLAN_FORM, 'NET-3')).toThrow();
    expect(broker.list().map((change) => change.id)).toEqual([first.id]);
  });
});

describe('push', () => {
  it('a 404 on the push path is reported unverified — never success — and stays queued', async () => {
    const transport = transportWith(404, { error: 'not found' });
    const broker = new WriteBroker({ dataDir: freshDataDir(), transport, knownTicket: anyTicket });
    const change = broker.queue('ssid', DEFAULT_SSID_FORM, 'NET-3');

    const r = await broker.push(change.id);
    expect(r.ok).toBe(false);
    expect(r.applied).toBe(false);
    expect(r.httpCode).toBe(404);
    expect(r.message).toMatch(/push path unverified against this tenant/);
    expect(r.message).toMatch(/stays queued/);
    expect(broker.list().map((c) => c.id)).toContain(change.id);

    // One read-back GET per candidate (both 404), then the single PUT attempt.
    expect(transport.calls.filter((c) => c.method === 'GET')).toHaveLength(2);
    const puts = transport.calls.filter((c) => c.method === 'PUT');
    expect(puts).toHaveLength(1);
    expect(puts[0].path).toBe(`/configuration/v2/wlan/${DEFAULT_SSID_FORM.group}`);
  });

  it('a 500 from the plane is a failure, never success', async () => {
    const transport = transportWith(500, { error: 'boom' });
    const broker = new WriteBroker({ dataDir: freshDataDir(), transport, knownTicket: anyTicket });
    const change = broker.queue('port', DEFAULT_PORT_FORM, 'NET-4');

    const r = await broker.push(change.id);
    expect(r.ok).toBe(false);
    expect(r.applied).toBe(false);
    expect(r.httpCode).toBe(500);
    expect(r.message).toMatch(/Central answered HTTP 500/);
    expect(broker.list().map((c) => c.id)).toContain(change.id);
  });

  it('binds a port change to exact plane+serial and revalidates before issuing the action', async () => {
    let devices = [
      { name: 'duplicate-switch', plane: 'CENTRAL' as const, serial: 'SERIAL-A' },
      { name: 'duplicate-switch', plane: 'CENTRAL' as const, serial: 'SERIAL-B' },
    ];
    const transport = transportWith(200);
    const broker = new WriteBroker({
      dataDir: freshDataDir(),
      transport,
      knownTicket: anyTicket,
      listDevices: () => devices,
    });
    const form = {
      ...DEFAULT_PORT_FORM,
      device: 'duplicate-switch',
      plane: 'CENTRAL' as const,
      serial: 'SERIAL-B',
    };
    const change = broker.queue('port', form, 'NET-IDENTITY');
    await broker.push(change.id);
    expect(transport.calls.map((call) => call.path)).toEqual([
      '/configuration/v2/switch-port/SERIAL-B/1%2F1%2F14',
      '/configuration/v2/switch-port/SERIAL-B/1%2F1%2F14',
    ]);

    const staleTransport = transportWith(200);
    const staleBroker = new WriteBroker({
      dataDir: freshDataDir(),
      transport: staleTransport,
      knownTicket: anyTicket,
      listDevices: () => devices,
    });
    const stale = staleBroker.queue('port', form, 'NET-STALE');
    devices = devices.filter((device) => device.serial !== 'SERIAL-B');
    await expect(staleBroker.push(stale.id)).rejects.toMatchObject({ status: 404 });
    expect(staleTransport.calls).toEqual([]);
  });

  it('rejects an ambiguous legacy port target before queueing or transport', () => {
    const transport = transportWith(200);
    const broker = new WriteBroker({
      dataDir: freshDataDir(),
      transport,
      knownTicket: anyTicket,
      listDevices: () => [
        { name: 'duplicate-switch', plane: 'CENTRAL', serial: 'SERIAL-A' },
        { name: 'duplicate-switch', plane: 'LOCAL', serial: 'SERIAL-B' },
      ],
    });
    expect(() => broker.queue(
      'port',
      { ...DEFAULT_PORT_FORM, device: 'duplicate-switch' },
      'NET-AMBIGUOUS',
    )).toThrow(/pass plane and serial/);
    expect(transport.calls).toEqual([]);
  });

  it('a 2xx applies, dequeues, and keeps the read-back snapshot (0600)', async () => {
    const currentState = { wlans: [{ name: 'MRDN-Staff' }] };
    const dataDir = freshDataDir();
    const transport = transportWith(200, currentState);
    const broker = new WriteBroker({ dataDir, transport, knownTicket: anyTicket });
    const change = broker.queue('ssid', DEFAULT_SSID_FORM, 'NET-5');

    const r = await broker.push(change.id);
    expect(r.ok).toBe(true);
    expect(r.applied).toBe(true);
    expect(r.httpCode).toBe(200);
    expect(r.snapshot).toBe(true);
    expect(r.message).toMatch(/accepted by Central — HTTP 200/);
    expect(broker.list()).toHaveLength(0);

    const snap = broker.readSnapshot(change.id);
    expect(snap).not.toBeNull();
    expect(snap!.body).toEqual(currentState);
    expect(snap!.ticket).toBe('NET-5');
    expect(statSync(join(dataDir, 'snapshots', `${change.id}.json`)).mode & 0o777).toBe(0o600);
  });

  it('push after the 15-minute lease answers 409 "lease expired — re-queue"', async () => {
    let now = 1_000_000_000;
    const transport = transportWith(200);
    const broker = new WriteBroker({ dataDir: freshDataDir(), nowMs: () => now, transport, knownTicket: anyTicket });
    const change = broker.queue('ssid', DEFAULT_SSID_FORM, 'NET-6');
    expect(change.state).toBe('ready');

    now += 16 * 60 * 1000;
    try {
      await broker.push(change.id);
      expect.unreachable();
    } catch (err) {
      expect((err as { status?: number }).status).toBe(409);
      expect((err as Error).message).toMatch(/lease expired — re-queue/);
    }
    // Nothing was pushed, and the change stays queued for an explicit re-queue.
    expect(transport.calls).toHaveLength(0);
    expect(broker.list().map((c) => c.id)).toContain(change.id);
  });

  it('push refuses non-ready states and unknown ids', async () => {
    const transport = transportWith(200);
    const broker = new WriteBroker({ dataDir: freshDataDir(), transport, knownTicket: anyTicket });
    const consoleChange = broker.queue('ssid', { ...DEFAULT_SSID_FORM, plane: 'MIST' }, 'NET-7');
    await expect(broker.push(consoleChange.id)).rejects.toThrow(/read-only plane/);

    const store = new SettingsStore(join(tmpDir, 'push-window-settings.json'));
    const reg = new PlaneRegistry(store);
    // No transport override + no central creds → unwritable → 'needs window'.
    const windowBroker = new WriteBroker({ registry: reg, dataDir: freshDataDir(), knownTicket: anyTicket });
    const windowChange = windowBroker.queue('vlan', DEFAULT_VLAN_FORM, 'NET-7');
    expect(windowChange.state).toBe('needs window');
    await expect(windowBroker.push(windowChange.id)).rejects.toThrow(/only ready changes/);

    try {
      await broker.push('chg-no-such-id');
      expect.unreachable();
    } catch (err) {
      expect((err as { status?: number }).status).toBe(404);
    }
  });
});

describe('push concurrency + snapshot reuse', () => {
  it('a discard mid-push does not splice an unrelated change out of the queue', async () => {
    const dataDir = freshDataDir();
    const { transport, putStarted, releasePut } = gatedTransport();
    const broker = new WriteBroker({ dataDir, transport, knownTicket: anyTicket });
    const pushed = broker.queue('ssid', DEFAULT_SSID_FORM, 'NET-20');
    const bystander = broker.queue('vlan', DEFAULT_VLAN_FORM, 'NET-20');

    const p = broker.push(pushed.id);
    await putStarted; // the PUT is in flight against the plane
    broker.discard(pushed.id); // the operator discards the change mid-push
    releasePut();
    const r = await p;

    expect(r.ok).toBe(true);
    expect(r.applied).toBe(true);
    expect(r.message).toMatch(/discarded while the push was in flight/);
    // The unrelated queued change survives — splice(-1) must never fire.
    expect(broker.list().map((c) => c.id)).toEqual([bystander.id]);
    const raw = readFileSync(join(dataDir, 'change-log.jsonl'), 'utf8');
    expect(raw).toContain('"result":"applied (discarded mid-push)"');
  });

  it('a second push while one is in flight is refused 409 and the change applies once', async () => {
    const dataDir = freshDataDir();
    const { transport, calls, putStarted, releasePut } = gatedTransport();
    const broker = new WriteBroker({ dataDir, transport, knownTicket: anyTicket });
    const change = broker.queue('ssid', DEFAULT_SSID_FORM, 'NET-21');

    const p1 = broker.push(change.id);
    await putStarted;
    const persisted = JSON.parse(readFileSync(join(dataDir, 'change-queue.json'), 'utf8')) as Array<{
      id: string;
      state: string;
    }>;
    expect(persisted.find((item) => item.id === change.id)?.state).toBe('applying');
    try {
      await broker.push(change.id);
      expect.unreachable();
    } catch (err) {
      expect((err as { status?: number }).status).toBe(409);
      expect((err as Error).message).toMatch(/push already in flight/);
    }
    releasePut();
    const r = await p1;
    expect(r.applied).toBe(true);
    expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(1);

    // The guard released on exit — a later push is an ordinary 404, not a stuck 409.
    await expect(broker.push(change.id)).rejects.toThrow(/not in the queue/);
  });

  it('push reuses a fresh dry-run snapshot — no second read-back', async () => {
    const dataDir = freshDataDir();
    const transport = transportWith(200, { wlans: [{ name: 'MRDN-Staff' }] });
    const broker = new WriteBroker({ dataDir, transport, knownTicket: anyTicket });

    const dry = await broker.dryRun('ssid', DEFAULT_SSID_FORM, 'NET-22');
    expect(dry.snapshot).toBe(true);
    const getsAfterDryRun = transport.calls.filter((c) => c.method === 'GET').length;

    const change = broker.queue('ssid', DEFAULT_SSID_FORM, 'NET-22');
    expect(change.dryRunId).toMatch(/^dry-/);

    const r = await broker.push(change.id);
    expect(r.ok).toBe(true);
    expect(r.applied).toBe(true);
    expect(r.snapshot).toBe(true);
    expect(transport.calls.filter((c) => c.method === 'GET')).toHaveLength(getsAfterDryRun);
    expect(transport.calls.filter((c) => c.method === 'PUT')).toHaveLength(1);

    // Re-filed under the queued change's id, so rollback lookup by change id works.
    const snap = broker.readSnapshot(change.id);
    expect(snap).not.toBeNull();
    expect(snap!.ticket).toBe('NET-22');
  });

  it('saving a snapshot sweeps files past the 24h TTL', async () => {
    const dataDir = freshDataDir();
    const transport = transportWith(200, { wlans: [] });
    const broker = new WriteBroker({ dataDir, transport, knownTicket: anyTicket });

    await broker.dryRun('ssid', DEFAULT_SSID_FORM, 'NET-23');
    const dir = join(dataDir, 'snapshots');
    const [first] = readdirSync(dir);
    const stale = new Date(Date.now() - 25 * 60 * 60 * 1000); // older than the TTL
    utimesSync(join(dir, first), stale, stale);

    await broker.dryRun('ssid', DEFAULT_SSID_FORM, 'NET-23'); // the save triggers the sweep

    const files = readdirSync(dir);
    expect(files).toHaveLength(1);
    expect(files[0]).not.toBe(first); // the stale file is gone
  });
});

describe('dry run', () => {
  it('linked target: read-back snapshot taken and reported', async () => {
    const transport = transportWith(200, { wlans: [] });
    const broker = new WriteBroker({ dataDir: freshDataDir(), transport, knownTicket: anyTicket });
    const r = await broker.dryRun('ssid', DEFAULT_SSID_FORM, 'NET-8');
    expect(r.ok).toBe(true);
    expect(r.reachable).toBe(true);
    expect(r.snapshot).toBe(true);
    expect(r.httpCode).toBe(200);
    expect(r.note).toBe('target reachable, current state snapshot taken');
    expect(r.rendered).toBe(configPreviewFor('ssid', DEFAULT_SSID_FORM));
  });

  it('linked target, all-404 read-back: reachable, nothing to snapshot', async () => {
    const transport = transportWith(404);
    const broker = new WriteBroker({ dataDir: freshDataDir(), transport, knownTicket: anyTicket });
    const r = await broker.dryRun('ssid', DEFAULT_SSID_FORM, 'NET-8');
    expect(r.ok).toBe(true);
    expect(r.reachable).toBe(true);
    expect(r.snapshot).toBe(false);
    expect(r.httpCode).toBe(404);
    expect(r.note).toMatch(/no existing object/);
  });

  it('unlinked target: honest render-only, no read-back attempted', async () => {
    const broker = new WriteBroker({ dataDir: freshDataDir(), transport: null, knownTicket: anyTicket });
    const r = await broker.dryRun('port', DEFAULT_PORT_FORM, 'NET-8');
    expect(r.ok).toBe(true);
    expect(r.reachable).toBeNull();
    expect(r.snapshot).toBe(false);
    expect(r.note).toMatch(/central not linked — render-only/);
  });

  it('read-only (mist-only) target: console hand-off, transport never called', async () => {
    const transport = transportWith(200);
    const broker = new WriteBroker({ dataDir: freshDataDir(), transport, knownTicket: anyTicket });
    const r = await broker.dryRun('ssid', { ...DEFAULT_SSID_FORM, plane: 'MIST' }, 'NET-8');
    expect(r.ok).toBe(true);
    expect(r.target).toBe('console');
    expect(r.reachable).toBeNull();
    expect(r.note).toMatch(/Mist is read-only/);
    expect(transport.calls).toHaveLength(0);
  });

  it('rollback snapshots expire after 24h — mtime check on read', async () => {
    let now = Date.now();
    const dataDir = freshDataDir();
    const transport = transportWith(200, { wlans: [] });
    const broker = new WriteBroker({ dataDir, nowMs: () => now, transport, knownTicket: anyTicket });
    const r = await broker.dryRun('ssid', DEFAULT_SSID_FORM, 'NET-9');
    expect(r.snapshot).toBe(true);

    const dir = join(dataDir, 'snapshots');
    const files = readdirSync(dir);
    expect(files).toHaveLength(1);
    const id = files[0].replace(/\.json$/, '');

    now += 25 * 60 * 60 * 1000; // past the 24h TTL (file mtime is real 'now')
    expect(broker.readSnapshot(id)).toBeNull();
    expect(readdirSync(dir)).toHaveLength(0); // stale snapshot removed on read
  });
});

describe('change log', () => {
  it('records dry-run/queue/push/discard lines (0600), ticket + result + httpCode, no secrets', async () => {
    const dataDir = freshDataDir();
    const transport = transportWith(200, {});
    const broker = new WriteBroker({ dataDir, transport, knownTicket: anyTicket });

    await broker.dryRun('ssid', DEFAULT_SSID_FORM, 'NET-10');
    const pushed = broker.queue('ssid', DEFAULT_SSID_FORM, 'NET-10');
    await broker.push(pushed.id);
    const discarded = broker.queue('vlan', DEFAULT_VLAN_FORM, 'NET-11');
    broker.discard(discarded.id);

    const logFile = join(dataDir, 'change-log.jsonl');
    expect(statSync(logFile).mode & 0o777).toBe(0o600);
    const raw = readFileSync(logFile, 'utf8');
    const lines = raw
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>);

    expect(lines.map((l) => l.event)).toEqual(['dry-run', 'queue', 'push', 'queue', 'discard']);
    expect(lines.find((l) => l.event === 'push')).toMatchObject({
      changeId: pushed.id,
      ticket: 'NET-10',
      kind: 'ssid',
      result: 'applied',
      httpCode: 200,
    });
    for (const l of lines) {
      expect(typeof l.ts).toBe('string');
      expect(Number.isNaN(Date.parse(l.ts as string))).toBe(false);
      expect(l.ticket).toMatch(/^NET-/);
    }
    // No payload bodies in the audit trail — so no secrets can leak into it.
    expect(raw).not.toMatch(/secret|clientSecret|Bearer|passphrase/i);
  });
});

// ---------------------------------------------------------------------------
// Route level — the /api/configure/* endpoints against createApp()
// ---------------------------------------------------------------------------

describe('configure routes', () => {
  it('POST /api/configure/render needs no ticket', async () => {
    const { status, body } = await postJson('/api/configure/render', { kind: 'ssid', form: DEFAULT_SSID_FORM });
    expect(status).toBe(200);
    expect(body.rendered).toBe(configPreviewFor('ssid', DEFAULT_SSID_FORM));
    expect(body.meta).toBe(previewMetaFor('ssid', DEFAULT_SSID_FORM));
    expect(Array.isArray(body.blastRadius)).toBe(true);
  });

  it('ticket gate: dry-run and queue answer 400 {error} without a ticket', async () => {
    const dry = await postJson('/api/configure/dry-run', { kind: 'ssid', form: DEFAULT_SSID_FORM });
    expect(dry.status).toBe(400);
    expect(dry.body.error).toMatch(/ticket reference required/);

    const queued = await postJson('/api/configure/queue', { kind: 'ssid', form: DEFAULT_SSID_FORM, ticket: '  ' });
    expect(queued.status).toBe(400);
    expect(queued.body.error).toMatch(/ticket reference required/);

    const badKind = await postJson('/api/configure/render', { kind: 'router', form: {} });
    expect(badKind.status).toBe(400);
    expect(badKind.body.error).toMatch(/kind must be one of/);
  });

  it('queue → list → push (409 not ready) → discard round trip', async () => {
    const queued = await postJson('/api/configure/queue', {
      kind: 'vlan',
      form: DEFAULT_VLAN_FORM,
      ticket: 'NET-4188', // a fixture-queue id — the gate accepts it in demo mode
    });
    expect(queued.status).toBe(200);
    expect(queued.body.state).toBe('needs window'); // no central creds in the test settings
    expect(queued.body.where).toMatch(/local collector/);
    expect(queued.body.rendered).toBe(configPreviewFor('vlan', DEFAULT_VLAN_FORM));
    expect(queued.body.expiresAt).toBeNull();

    const list = await fetch(`${base}/api/configure/queue`);
    const listBody = (await list.json()) as any;
    expect(list.status).toBe(200);
    expect(listBody.changes.map((c: any) => c.id)).toContain(queued.body.id);

    const push = await postJson('/api/configure/push', { changeId: queued.body.id });
    expect(push.status).toBe(409);
    expect(push.body.error).toMatch(/only ready changes/);

    const missing = await postJson('/api/configure/push', { changeId: 'chg-nope' });
    expect(missing.status).toBe(404);
    expect(missing.body.error).toMatch(/not in the queue/);

    const discarded = await postJson('/api/configure/discard', { changeId: queued.body.id });
    expect(discarded.status).toBe(200);
    expect(discarded.body.ok).toBe(true);

    const after = await fetch(`${base}/api/configure/queue`);
    const afterBody = (await after.json()) as any;
    expect(afterBody.changes).toHaveLength(0);
  });
});
