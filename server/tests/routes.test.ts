/**
 * server/tests/routes.test.ts — in-process app on an ephemeral port.
 *
 * HPE_SETTINGS_PATH points at a tmp dir so the test never touches the real
 * data/settings.json. The env var must be set before the app modules are
 * imported (the settings singleton resolves its path at construction), so the
 * app is loaded with a dynamic import inside beforeAll.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let server: Server;
let base: string;
let tmpDir: string;
let mockCentral: Server;
let mockCentralBase: string;

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'hpe-routes-'));
  process.env.HPE_SETTINGS_PATH = join(tmpDir, 'settings.json');
  process.env.HPE_DATA_DIR = join(tmpDir, 'data'); // ticket writes land in tmp, never real data/
  const { createApp } = await import('../src/index');
  server = createApp().listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  // A tiny fake Central gateway for the connection-test paths: OAuth token
  // endpoint + a device sample query, nothing else.
  mockCentral = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.method === 'POST' && req.url === '/oauth2/token') {
      res.end(JSON.stringify({ access_token: 'mock-token', expires_in: 3600 }));
      return;
    }
    if (req.method === 'GET' && req.url?.startsWith('/monitoring/v1/aps')) {
      res.end(JSON.stringify({ aps: [], count: 0 }));
      return;
    }
    res.statusCode = 404;
    res.end('{}');
  });
  mockCentral.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => mockCentral.once('listening', resolve));
  mockCentralBase = `http://127.0.0.1:${(mockCentral.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await new Promise<void>((resolve) => mockCentral.close(() => resolve()));
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.HPE_SETTINGS_PATH;
  delete process.env.HPE_DATA_DIR;
});

async function getJson(path: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${path}`);
  return { status: res.status, body: await res.json() };
}

describe('routes', () => {
  it('GET /api/health', async () => {
    const { status, body } = await getJson('/api/health');
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
  });

  it('GET /api/overview returns the demo envelope and payload', async () => {
    const { status, body } = await getJson('/api/overview');
    expect(status).toBe(200);
    expect(body.dataSource).toBe('demo');
    expect(typeof body.syncedAt).toBe('string');
    expect(Number.isNaN(Date.parse(body.syncedAt))).toBe(false);
    expect(Array.isArray(body.stats)).toBe(true);
    expect(body.stats).toHaveLength(5);
    expect(Array.isArray(body.alerts)).toBe(true);
    expect(Array.isArray(body.sites)).toBe(true);
    expect(body.sites[0].siteId).toBeDefined();
    expect(Array.isArray(body.planes)).toBe(true);
    expect(Array.isArray(body.changes)).toBe(true);
    expect(Array.isArray(body.launchpad)).toBe(true);
  });

  it('GET /api/systems demo envelope matches the client contract (systems + syncHistory)', async () => {
    const { status, body } = await getJson('/api/systems');
    expect(status).toBe(200);
    expect(body.dataSource).toBe('demo');
    expect(Array.isArray(body.systems)).toBe(true);
    expect(body.systems.length).toBeGreaterThan(0);
    expect(Array.isArray(body.syncHistory)).toBe(true);
    expect(body.history).toBeUndefined();
    expect(Array.isArray(body.permissions)).toBe(true);
  });

  it('GET /api/settings masks secrets; PUT never echoes them', async () => {
    const initial = await getJson('/api/settings');
    expect(initial.status).toBe(200);
    expect(initial.body.demoMode).toBe(true);

    const secret = 'supersecretvalue';
    const put = await fetch(`${base}/api/settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ planes: { central: { gatewayBaseUrl: 'https://gw.example.com', clientId: 'id-1', clientSecret: secret } } }),
    });
    const putBody = (await put.json()) as any;
    expect(put.status).toBe(200);
    expect(JSON.stringify(putBody)).not.toContain(secret);
    expect(putBody.planes.central.clientSecret).toBe('••••••');

    const after = await getJson('/api/settings');
    expect(after.body.planes.central.clientId).toBe('id-1');
    expect(JSON.stringify(after.body)).not.toContain(secret);
  });

  it('credentials lifecycle: save re-inits the adapter, delete retires it', async () => {
    const { poller } = await import('../src/services/poller');
    const contributions = (poller as unknown as { contributions: Map<string, unknown> }).contributions;
    contributions.set('mist', { devices: [{ name: 'stale-before-replacement' }] });
    const secret = 'mist-secret-token-1234';
    const res = await fetch(`${base}/api/systems/mist/credentials`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ host: 'api.mist.example.com', token: secret }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.state.linked).toBe(true);
    expect(body.state.health).toBe('warning'); // stub adapter, honest about it
    expect(body.credentials.token).toBe('••••••');
    expect(JSON.stringify(body)).not.toContain(secret);
    expect(contributions.has('mist')).toBe(false);

    const state = await getJson('/api/systems/state');
    expect(state.status).toBe(200);
    expect(state.body.planes.mist.linked).toBe(true);
    expect(state.body.planes.central.linked).toBe(true); // saved via PUT /api/settings above
    expect(Array.isArray(state.body.history)).toBe(true);

    contributions.set('mist', { devices: [{ name: 'stale-before-retire' }] });
    const del = await fetch(`${base}/api/systems/mist`, { method: 'DELETE' });
    expect(del.status).toBe(200);
    const delBody = (await del.json()) as any;
    expect(delBody.state.linked).toBe(false);
    expect(delBody.state.health).toBe('unlinked');
    expect(contributions.has('mist')).toBe(false);
  });

  it('POST /api/systems/:plane/test without credentials is a 400', async () => {
    const res = await fetch(`${base}/api/systems/mist/test`, { method: 'POST' });
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.error).toMatch(/no credentials/);
  });

  it('test-then-save: complete body credentials are tested directly (central OAuth path)', async () => {
    // central also has stored creds from the earlier PUT /api/settings — but
    // they point at gw.example.com, so a 200 here proves the BODY set won.
    const res = await fetch(`${base}/api/systems/central/test`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ gatewayBaseUrl: mockCentralBase, clientId: 'body-id', clientSecret: 'body-secret' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.ok).toBe(true);
    expect(body.source).toBe('request');
    expect(body.message).toMatch(/authenticated via .+ — token received/);
  });

  it('central test falls back to the new-Central sample path and names the generation', async () => {
    // A gateway that only serves the v1alpha1 sample path (new-Central shape).
    const { createServer } = await import('node:http');
    const newCentral = createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      if (req.method === 'POST' && req.url === '/oauth2/token') {
        res.end(JSON.stringify({ access_token: 'mock-token', expires_in: 3600 }));
        return;
      }
      if (req.method === 'GET' && req.url?.startsWith('/network-monitoring/v1alpha1/aps')) {
        res.end(JSON.stringify({ aps: [], total: 0 }));
        return;
      }
      res.statusCode = 404;
      res.end('{}');
    });
    newCentral.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => newCentral.once('listening', resolve));
    try {
      const newBase = `http://127.0.0.1:${(newCentral.address() as AddressInfo).port}`;
      const res = await fetch(`${base}/api/systems/central/test`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ gatewayBaseUrl: newBase, clientId: 'id', clientSecret: 'secret' }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.ok).toBe(true);
      expect(body.message).toContain('new Central device sample ok');
    } finally {
      await new Promise<void>((resolve) => newCentral.close(() => resolve()));
    }
  });

  it('test-then-save: a generic plane tests body credentials it has nothing stored for', async () => {
    // 'classic' has nothing stored — without the body-creds path this is a 400.
    const res = await fetch(`${base}/api/systems/classic/test`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ host: mockCentralBase }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.ok).toBe(true);
    expect(body.source).toBe('request');
    expect(body.message).toMatch(/host reachable/);
  });

  it('falls back to stored credentials when the body carries none', async () => {
    const save = await fetch(`${base}/api/systems/clearpass/credentials`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ host: mockCentralBase }),
    });
    expect(save.status).toBe(200);

    const res = await fetch(`${base}/api/systems/clearpass/test`, { method: 'POST' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.ok).toBe(true);
    expect(body.source).toBe('stored');

    await fetch(`${base}/api/systems/clearpass`, { method: 'DELETE' }); // restore
  });

  it('incomplete submitted credentials are rejected instead of testing a different stored set', async () => {
    await fetch(`${base}/api/settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        planes: { central: { gatewayBaseUrl: 'http://127.0.0.1:1', clientId: 'stored-id', clientSecret: 'stored-secret' } },
      }),
    });
    const res = await fetch(`${base}/api/systems/central/test`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientId: 'partial-only' }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.error).toMatch(/submitted credentials.*incomplete/);

    // 'uxi' has nothing stored, and a clientId-only body is not testable.
    const none = await fetch(`${base}/api/systems/uxi/test`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientId: 'partial-only' }),
    });
    expect(none.status).toBe(400);
    const noneBody = (await none.json()) as any;
    expect(noneBody.error).toMatch(/submitted credentials.*incomplete/);
  });

  it('GET /api/sites/:siteId resolves a canonical id to a profile', async () => {
    const { status, body } = await getJson('/api/sites/riverside');
    expect(status).toBe(200);
    expect(body.dataSource).toBe('demo');
    expect(body.profile.name).toBe('Riverside Clinic');
    expect(body.site.id).toBe('riverside');

    const missing = await getJson('/api/sites/no-such-place');
    expect(missing.status).toBe(404);
  });

  it('demo site detail derives a profile from the site’s own row, never Warehouse-DC1’s', async () => {
    const dc2 = await getJson('/api/sites/warehouse-dc2');
    expect(dc2.status).toBe(200);
    expect(dc2.body.profile.name).toBe('Warehouse-DC2');
    expect(dc2.body.profile.siteId).toBe('warehouse-dc2');
    // The old local-only fallback answered with Warehouse-DC1's authored 18
    // devices / 96 clients for every site without a deep profile.
    expect(dc2.body.profile.deviceCount).toBe(String(dc2.body.site.devices));
    expect(dc2.body.profile.deviceCount).not.toBe('18');
    expect(dc2.body.profile.clients).toBe(dc2.body.site.clients);
    expect(dc2.body.profile.facts.find((f: any) => f.k === 'Subnets').v).toBe(dc2.body.site.subnet);
  });

  it('pseudo-site ids have no inventory row, so the site page 404s instead of fabricating one', async () => {
    for (const pseudo of ['core-services', 'workspace', 'multiple']) {
      const { status, body } = await getJson(`/api/sites/${pseudo}`);
      expect(status).toBe(404);
      expect(body.error).toMatch(/unknown site/i);
    }
  });

  it('POST /api/tickets/raise accepts a site-level alert that names no device or detail', async () => {
    const raise = await fetch(`${base}/api/tickets/raise`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'WAN down at Northgate — no device named',
        sev: 'P1',
        siteName: 'Northgate Clinic',
        plane: 'CENTRAL',
        age: '3m',
        state: 'open',
      }),
    });
    expect(raise.status).toBe(200);
    const ticket = ((await raise.json()) as any).ticket;
    expect(ticket.pri).toBe('P1');
    expect(ticket.siteName).toBe('Northgate Clinic');

    // Identity fields are still required — this is a relaxation, not a hole.
    const bad = await fetch(`${base}/api/tickets/raise`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sev: 'P1', siteName: 'Northgate Clinic', plane: 'CENTRAL', age: '3m', state: 'open' }),
    });
    expect(bad.status).toBe(400);
  });

  it('GET /api/devices/:name returns an honest demo 404 for an unknown fixture', async () => {
    const missing = await getJson('/api/devices/no-such-device');
    expect(missing.status).toBe(404);
    expect(missing.body.dataSource).toBe('demo');
    expect(missing.body.error).toMatch(/unknown device/i);
    expect(missing.body.error).toBeDefined();
  });

  it('live mode serves the reconciled shape (empty until planes actually sync)', async () => {
    await fetch(`${base}/api/settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ demoMode: false }),
    });
    try {
      const devices = await getJson('/api/devices');
      expect(devices.status).toBe(200);
      expect(devices.body.dataSource).toBe('live');
      expect(devices.body.devices).toEqual([]);
      expect(devices.body.reconciliation).toEqual({ doubleClaimed: 0, unclaimed: 0 });

      const sites = await getJson('/api/sites');
      expect(sites.status).toBe(200);
      expect(sites.body.dataSource).toBe('live');
      expect(sites.body.sites).toEqual([]);

      const alerts = await getJson('/api/alerts');
      expect(alerts.body.dataSource).toBe('live');
      expect(alerts.body.alerts).toEqual([]);
    } finally {
      await fetch(`${base}/api/settings`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ demoMode: true }),
      });
    }
  });

  it('POST /api/tickets/:id/notes persists the operator log; fixture promotion dedupes the queue', async () => {
    const post = (id: string, payload: unknown) =>
      fetch(`${base}/api/tickets/${id}/notes`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });

    expect((await post('NET-4188', { text: '   ' })).status).toBe(400);
    expect((await post('NET-4188', { text: 'x', kind: 'sideways' })).status).toBe(400);
    expect((await post('NET-9999', { text: 'x' })).status).toBe(404);

    const ok = await post('NET-4188', { text: 'checking the AP channel plan', kind: 'note' });
    expect(ok.status).toBe(200);
    const okBody = (await ok.json()) as any;
    expect(okBody.ticket.id).toBe('NET-4188');
    expect(okBody.ticket.notes).toHaveLength(1);

    // The promoted ticket appears exactly once in the merged queue, with its log.
    const q = await getJson('/api/tickets');
    const matching = (q.body.tickets as any[]).filter((t) => t.id === 'NET-4188');
    expect(matching).toHaveLength(1);
    expect(matching[0].notes[0]).toMatchObject({ kind: 'note', text: 'checking the AP channel plan' });
    expect(Number.isNaN(Date.parse(matching[0].notes[0].ts))).toBe(false);

    const action = await post('NET-4188', { text: 'Pin channels on ap-3f-12/14', kind: 'action' });
    expect(action.status).toBe(200);
    expect(((await action.json()) as any).ticket.notes).toHaveLength(2);
  });

  it('POST /api/tickets/:id/resolve closes a ticket idempotently; 404 for an unknown id', async () => {
    const post = (id: string) => fetch(`${base}/api/tickets/${id}/resolve`, { method: 'POST' });

    expect((await post('NET-9999')).status).toBe(404);

    // Raise, then resolve — the state flips and an action note lands in the log.
    const raise = await fetch(`${base}/api/tickets/raise`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'resolve route test alert',
        sev: 'P2',
        detail: 'raised to be resolved',
        siteName: 'Campus-01 — Meridian HQ',
        plane: 'CENTRAL',
        device: 'sw-test-1',
        age: 'now',
        state: 'open',
      }),
    });
    const id = ((await raise.json()) as any).ticket.id as string;

    const resolved = await post(id);
    expect(resolved.status).toBe(200);
    const body = (await resolved.json()) as any;
    expect(body.ticket.state).toBe('resolved');
    const notes = body.ticket.notes as any[];
    expect(notes[notes.length - 1]).toMatchObject({ kind: 'action', text: 'Ticket resolved' });

    // Idempotent — a second resolve returns the ticket without another note.
    const again = (await (await post(id)).json()) as any;
    expect(again.ticket.state).toBe('resolved');
    expect(again.ticket.notes).toHaveLength(notes.length);

    // The merged queue reflects the close.
    const q = await getJson('/api/tickets');
    expect((q.body.tickets as any[]).find((t) => t.id === id).state).toBe('resolved');
  });

  it('GET /api/search-index surfaces raised tickets in both modes and dedupes promoted fixtures', async () => {
    // A fresh raise lands in the store with a new id.
    const raise = await fetch(`${base}/api/tickets/raise`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'search-index test alert',
        sev: 'P3',
        detail: 'raised from a test',
        siteName: 'Campus-01 — Meridian HQ',
        plane: 'new-central',
        device: 'ap-3f-12',
        age: 'now',
        state: 'open',
      }),
    });
    expect(raise.status).toBe(200);
    const raisedId = ((await raise.json()) as any).ticket.id as string;

    // A fixture ticket promoted by an operator note must not appear twice.
    const promote = await fetch(`${base}/api/tickets/NET-4173/notes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'promoting for the search-index test', kind: 'note' }),
    });
    expect(promote.status).toBe(200);

    const demo = await getJson('/api/search-index');
    expect(demo.status).toBe(200);
    const demoEntries = demo.body.entries as any[];
    const hit = demoEntries.find((e) => e.kind === 'ticket' && e.arg === raisedId);
    expect(hit).toBeDefined();
    expect(hit.label).toContain('search-index test alert');
    expect(hit.view).toBe('tickets');
    expect(demoEntries.filter((e) => e.kind === 'ticket' && e.arg === 'NET-4173')).toHaveLength(1);

    // Live mode: raised tickets still lead the index alongside live-derived rows.
    await fetch(`${base}/api/settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ demoMode: false }),
    });
    try {
      const live = await getJson('/api/search-index');
      expect(live.body.dataSource).toBe('live');
      expect((live.body.entries as any[]).some((e) => e.kind === 'ticket' && e.arg === raisedId)).toBe(true);
    } finally {
      await fetch(`${base}/api/settings`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ demoMode: true }),
      });
    }
  });

  it('unknown API routes return a consistent { error } 404', async () => {
    const { status, body } = await getJson('/api/definitely-not-a-route');
    expect(status).toBe(404);
    expect(body.error).toBe('not found');
  });
});

/**
 * Live-mode screen contracts. The poller never runs in tests (createApp is
 * side-effect free), so contributions are seeded straight into its last-good
 * map — the same data shape a real adapter pull would leave behind.
 */
describe('live-mode screen contracts', () => {
  let contributions: Map<string, unknown>;

  const setDemoMode = (demoMode: boolean) =>
    fetch(`${base}/api/settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ demoMode }),
    });

  const DEVICE = {
    name: 'sw-test-1',
    model: 'CX 8325',
    type: 'switch',
    siteId: 'campus-01',
    siteName: 'Campus-01 — Meridian HQ',
    plane: 'CENTRAL',
    planeTone: 'accent',
    state: 'up',
    stateTone: 'success',
    firmware: '10.13.0005',
    firmwareApproved: true,
    licence: 'Foundation',
    reconciliationIssue: false,
    localShell: false,
  };

  const SITE = {
    id: 'campus-01',
    name: 'Campus-01 — Meridian HQ',
    subnet: '10.1.0.0/16',
    planes: [{ name: 'CENTRAL', tone: 'accent' }],
    mix: '—',
    devices: 0,
    clients: '0',
    health: null,
    healthPct: '—',
    tone: 'stale',
    alerts: '—',
    alertTone: 'neutral',
    sync: '1m',
  };

  const clientRow = (mac: string, plane: string) => ({
    name: `client-via-${plane.toLowerCase()}`,
    model: 'ThinkPad X1',
    type: 'laptop',
    mac,
    ip: '10.1.4.55',
    medium: 'wireless',
    siteId: 'campus-01',
    siteName: 'Campus-01 — Meridian HQ',
    group: 'default',
    attach: 'MRDN-Corp',
    where: 'ap-1 · radio 1',
    plane,
    planeTone: 'neutral',
    auth: 'dot1x',
    authBy: 'ClearPass',
    role: 'employee',
    vlan: '110',
    health: 'good',
    healthTone: 'success',
    session: '2h',
    problem: false,
    link: 'up',
    rssi: '-52',
    snr: '38',
    retries: '2%',
    tput: '120 Mb',
    roams: '1',
    quality: 88,
    zone: '3rd floor',
    closet: 'IDF-3',
  });

  const alertRow = (over: Record<string, unknown>) => ({
    sev: 'P2',
    tone: 'warning',
    title: 'AP flapping',
    detail: 'ap-1 flapping on channel 36',
    siteId: 'campus-01',
    siteName: 'Campus-01 — Meridian HQ',
    plane: 'CENTRAL',
    state: 'open',
    age: '5m',
    device: 'ap-1',
    ...over,
  });

  beforeAll(async () => {
    const { poller } = await import('../src/services/poller');
    contributions = (poller as unknown as { contributions: Map<string, unknown> }).contributions;
    await setDemoMode(false);
  });

  afterAll(async () => {
    contributions.clear();
    await setDemoMode(true);
  });

  it('live /api/systems emits the client contract (systems + syncHistory)', async () => {
    const { status, body } = await getJson('/api/systems');
    expect(status).toBe(200);
    expect(body.dataSource).toBe('live');
    expect(Array.isArray(body.systems)).toBe(true);
    expect(body.systems).toHaveLength(9); // the screen's plane rows, from the registry
    const names = (body.systems as any[]).map((s) => s.name);
    expect(names).toContain('HPE Aruba Central');
    expect(names).toContain('Mist');
    const central = (body.systems as any[]).find((s) => s.name === 'HPE Aruba Central');
    expect(central.planeId).toBe('central'); // live rows name their plane so renames can't break the UI
    // Four facts, per the design: the fourth is credential freshness.
    expect(central.facts.map((f: any) => f.k)).toEqual(['Last sync', 'Devices', 'Calls today', 'Token']);
    expect(central.facts[3].v).not.toBe(''); // never blank — 'not reported' at worst
    expect(Array.isArray(central.pulls)).toBe(true);
    expect(typeof central.configText).toBe('string');
    expect(Array.isArray(body.syncHistory)).toBe(true);
    expect(body.history).toBeUndefined();
    expect(Array.isArray(body.permissions)).toBe(true);
  });

  it('live /api/overview rows carry the view-model fields (meta/siteId/plane)', async () => {
    contributions.set('central', {
      devices: [DEVICE],
      sites: [SITE],
      alerts: [alertRow({ alertId: 'a-1' })],
    });
    const { status, body } = await getJson('/api/overview');
    expect(status).toBe(200);
    expect(body.dataSource).toBe('live');
    // The row has no Site column, so meta must lead with the site (the
    // fixtures do the same) — otherwise a live alert cannot say where it is.
    expect(body.alerts[0].meta).toBe('Campus-01 — Meridian HQ · ap-1 flapping on channel 36');
    expect(body.alerts[0].plane).toBe('CENTRAL');
    const site = (body.sites as any[]).find((s) => s.siteId === 'campus-01');
    expect(site).toBeDefined();
    expect(site.plane).toContain('CENTRAL');
    expect(typeof site.devices).toBe('number');
    expect(typeof site.clients).toBe('string');
  });

  it('live /api/devices/:name serves cached facts and only attaches clients when sessions were reported', async () => {
    contributions.set('central', { devices: [DEVICE] });
    const ok = await getJson('/api/devices/sw-test-1');
    expect(ok.status).toBe(200);
    expect(ok.body.dataSource).toBe('live');
    expect(ok.body.device.name).toBe('sw-test-1');
    expect(ok.body.device.model).toBe('CX 8325');
    expect(ok.body.profile).toBeNull();
    expect(ok.body.config).toBeNull();
    expect(ok.body.clients).toBeNull();

    contributions.set('central', {
      devices: [DEVICE],
      clients: [{ ...clientRow('AA:BB:CC:DD:EE:FF', 'CENTRAL'), medium: 'wired', attach: 'sw-test-1', where: 'port 1/1/8' }],
    });
    const withClients = await getJson('/api/devices/sw-test-1');
    expect(withClients.body.clients.meta).toBe('1 active session');
    expect(withClients.body.clients.rows[0]).toMatchObject({
      name: 'client-via-central',
      state: 'good',
    });

    const missing = await getJson('/api/devices/no-such-device');
    expect(missing.status).toBe(404);
    expect(missing.body.error).toBeDefined();
  });

  it('live configure exposes the broker queue and computed stats; compliance stays honest', async () => {
    const { DEFAULT_VLAN_FORM } = await import('../../shared');
    contributions.clear();
    contributions.set('central', { devices: [DEVICE] });
    await setDemoMode(true);
    const queued = await fetch(`${base}/api/configure/queue`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'vlan', form: DEFAULT_VLAN_FORM, ticket: 'NET-4188' }),
    });
    expect(queued.status).toBe(200);
    const changeId = ((await queued.json()) as any).id as string;
    const demoConfigure = await getJson('/api/configure');
    expect((demoConfigure.body.queued as any[]).some((change) => change.ticket === 'NET-4188')).toBe(true);
    expect(demoConfigure.body.stats[0].value).toBe(String(demoConfigure.body.queued.length));
    await setDemoMode(false);
    try {
      const configure = await getJson('/api/configure');
      expect(configure.body.dataSource).toBe('live');
      expect((configure.body.queued as any[]).some((change) => change.ticket === 'NET-4188')).toBe(true);
      expect(configure.body.stats).toHaveLength(4);
      expect(configure.body.stats[0]).toMatchObject({
        label: 'Queued changes',
        value: String(configure.body.queued.length),
      });
      expect(configure.body.stats[2].value).toBe('—');
      expect(configure.body.inventoryMode).toBe('unavailable');

      contributions.set('central', {
        devices: [DEVICE],
        clients: [clientRow('AA:BB:CC:DD:EE:FF', 'CENTRAL')],
      });
      const observedConfigure = await getJson('/api/configure');
      expect(observedConfigure.body.inventoryMode).toBe('observed');
      expect(observedConfigure.body.ssids[0].origin).toBe('observed');
      expect(observedConfigure.body.vlans[0]).toMatchObject({ id: '110', origin: 'observed' });
      expect(observedConfigure.body.stats[2].value).not.toBe('—');

      const compliance = await getJson('/api/compliance');
      expect(compliance.body.dataSource).toBe('live');
      expect(compliance.body.findings).toEqual([]);
      expect(compliance.body.evidenceMode).toBe('coverage');
      expect(compliance.body.baselines).toHaveLength(5); // + plane freshness
      expect((compliance.body.baselines as any[]).map((b) => b.label)).toContain('Plane freshness');
      expect(compliance.body.stats[4]).toMatchObject({ label: 'Config drift', value: '—' });
      expect(compliance.body.diff).toContain('Running configuration drift cannot be evaluated');
    } finally {
      await fetch(`${base}/api/configure/discard`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ changeId }),
      });
    }
  });

  it('live clients dedupe across planes by normalised MAC; alerts by plane+id', async () => {
    contributions.set('central', {
      clients: [clientRow('AA:BB:CC:DD:EE:FF', 'CENTRAL')],
      alerts: [alertRow({ alertId: 'a-1' }), alertRow({ alertId: 'a-1' })],
    });
    contributions.set('mist', {
      clients: [clientRow('aabb.ccdd.eeff', 'MIST')], // same endpoint, other notation
      alerts: [alertRow({ alertId: 'm-9', plane: 'MIST', title: 'Mist alarm', detail: 'mist detail' })],
    });

    const clients = await getJson('/api/clients');
    expect(clients.status).toBe(200);
    expect(clients.body.dataSource).toBe('live');
    expect(clients.body.clients).toHaveLength(1);
    expect(clients.body.clients[0].mac).toBe('AA:BB:CC:DD:EE:FF'); // first plane's row wins
    expect(clients.body.stats[0].value).toBe('1'); // stats count the deduped list

    const alerts = await getJson('/api/alerts');
    expect(alerts.body.dataSource).toBe('live');
    expect(alerts.body.alerts).toHaveLength(2); // a-1 once + m-9
    expect((alerts.body.alerts as any[]).filter((a) => a.alertId === 'a-1')).toHaveLength(1);
  });

  it("live overview's Devices reachable names down devices before 'all verified'", async () => {
    const fleet = Array.from({ length: 9 }, (_, i) => ({
      ...DEVICE,
      name: `sw-fleet-${i}`,
      state: i === 8 ? 'down' : 'up',
      stateTone: i === 8 ? 'danger' : 'success',
    }));
    contributions.set('central', { devices: fleet, alerts: [] });
    const { status, body } = await getJson('/api/overview');
    expect(status).toBe(200);
    const stat = (body.stats as any[]).find((s) => s.label === 'Devices reachable');
    expect(stat.value).toBe('8 / 9');
    expect(stat.delta).toBe('▼ 1 down'); // the down device is named, not hidden
    expect(stat.tone).toBe('negative');
  });

  it('live site health has a warning band between ok (>=90) and bad (<70)', async () => {
    contributions.clear();
    const fleet = (upCount: number, total: number) =>
      Array.from({ length: total }, (_, i) => ({
        ...DEVICE,
        name: `sw-band-${i}`,
        state: i < upCount ? 'up' : 'down',
        stateTone: i < upCount ? 'success' : 'danger',
      }));

    contributions.set('central', {
      devices: [
        ...fleet(8, 9),
        { ...DEVICE, name: 'sw-state-unknown', state: 'unknown', stateTone: 'neutral' },
      ],
      alerts: [],
    });
    const warn = await getJson('/api/sites');
    const site89 = (warn.body.sites as any[]).find((s) => s.id === 'campus-01');
    expect(site89.healthPct).toBe('89%');
    expect(site89.tone).toBe('warn'); // 8/9 up is a warning, not a red site
    expect(site89.clients).toBe('—'); // no client dataset reported, not a false zero
    expect(site89.alerts).toBe('clear'); // an explicit empty alert dataset is a real clear

    contributions.set('central', { devices: fleet(8, 9) });
    const noAlerts = await getJson('/api/sites');
    expect((noAlerts.body.sites as any[]).find((s) => s.id === 'campus-01').alerts).toBe('—');

    contributions.set('central', { devices: fleet(1, 2), alerts: [] });
    const bad = await getJson('/api/sites');
    expect((bad.body.sites as any[]).find((s) => s.id === 'campus-01').tone).toBe('bad');

    contributions.set('central', { devices: fleet(9, 9), alerts: [] });
    const ok = await getJson('/api/sites');
    expect((ok.body.sites as any[]).find((s) => s.id === 'campus-01').tone).toBe('ok');
  });

  it('live /api/sites carries the four-Stat row, computed from the same merge', async () => {
    contributions.clear();
    contributions.set('central', { devices: [DEVICE], sites: [SITE] });
    const bare = await getJson('/api/sites');
    expect((bare.body.stats as any[]).map((s) => s.label)).toEqual([
      'Sites',
      'Devices',
      'Clients',
      'Sites with alerts',
    ]);
    expect(bare.body.stats[0].value).toBe('1');
    expect(bare.body.stats[1].value).toBe('1');
    expect(bare.body.stats[2].value).toBe('—'); // no client roster reported — never a false zero
    expect(bare.body.stats[3].value).toBe('—');

    contributions.set('central', {
      devices: [DEVICE],
      sites: [SITE],
      clients: [clientRow('AA:BB:CC:DD:EE:FF', 'CENTRAL')],
      alerts: [alertRow({ alertId: 'a-1' })],
    });
    const full = await getJson('/api/sites');
    expect(full.body.stats[2].value).toBe('1');
    expect(full.body.stats[3]).toMatchObject({ value: '1', tone: 'negative' });
  });

  it('live site rows badge every claiming plane and take Last sync from plane freshness', async () => {
    contributions.clear();
    contributions.set('central', { sites: [SITE], devices: [DEVICE] });
    contributions.set('aos8', {
      devices: [{ ...DEVICE, name: 'mc-lake-1', plane: 'AOS-8', planeTone: 'accent' }],
    });
    const withRow = await getJson('/api/sites');
    const site = (withRow.body.sites as any[]).find((s) => s.id === 'campus-01');
    // AOS-8 only ever appears through its devices — the adapter site rows
    // name Central alone, and dropping the badge destroys the whole point of
    // the "Managed by" column.
    expect((site.planes as any[]).map((p) => p.name).sort()).toEqual(['AOS-8', 'CENTRAL']);
    expect(site.sync).toBe('1m'); // an adapter that really stamps a per-site sync still wins

    contributions.delete('aos8');
    contributions.set('central', { devices: [DEVICE] }); // device-discovered site, no adapter row
    const skeleton = await getJson('/api/sites');
    // Central is linked but has never completed a sync: the column says so
    // rather than the structurally-dead '—' it could only ever print before.
    expect((skeleton.body.sites as any[])[0].sync).toBe('never');
  });

  it('live site detail carries "Devices at this site" and "Open here"', async () => {
    contributions.clear();
    contributions.set('central', {
      devices: [DEVICE],
      alerts: [alertRow({ alertId: 'a-1' }), alertRow({ alertId: 'a-2', state: 'acked', title: 'Already acked' })],
    });
    const { status, body } = await getJson('/api/sites/campus-01');
    expect(status).toBe(200);
    expect(body.profile).toBeNull(); // no plane reports an authored profile
    expect(body.devices).toEqual([
      {
        name: 'sw-test-1',
        model: 'CX 8325',
        plane: 'CENTRAL',
        planeTone: 'accent',
        role: '—',
        state: 'up',
        stateTone: 'success',
        uptime: '—',
      },
    ]);
    expect(body.alerts).toEqual([{ sev: 'P2', tone: 'warning', title: 'AP flapping', meta: 'central · 5m' }]);
  });

  it('live /api/devices sends real per-plane lane freshness, not an empty map', async () => {
    contributions.clear();
    contributions.set('central', { devices: [DEVICE] });
    const { body } = await getJson('/api/devices');
    expect(body.lanes.CENTRAL).toMatchObject({ mark: 'var(--nd-accent)', sync: 'never synced' });
    expect(typeof body.lanes.CENTRAL.note).toBe('string');
    expect(body.lanes.MIST).toBeUndefined(); // not linked — no lane claims otherwise
  });

  it('live licences emit all five Stat tiles the five-column grid needs', async () => {
    contributions.clear();
    contributions.set('central', { devices: [DEVICE] });
    const { body } = await getJson('/api/licenses');
    expect((body.stats as any[]).map((s) => s.label)).toEqual([
      'Subscriptions',
      'Assigned',
      'Unassigned',
      // ONE expiry horizon across the portal: the Overview tile, the fixtures
      // and design/NtLicenses all say ≤60d. greenlake's EXPIRING_SOON_DAYS
      // (90) stays the per-subscription badge threshold, a different question.
      'Expiring ≤60d',
      'Devices unlicensed',
    ]);
    expect(body.stats[4]).toMatchObject({ value: '0', tone: 'positive' });

    contributions.set('central', { devices: [{ ...DEVICE, licence: 'unknown' }] });
    const unknown = await getJson('/api/licenses');
    expect(unknown.body.stats[4]).toMatchObject({ value: '—', delta: 'no plane reports entitlements' });
  });

  it("live overview's Config drift comes from the evidence engine, not a hardwired dash", async () => {
    contributions.clear();
    contributions.set('central', { devices: [{ ...DEVICE, firmware: '' }] });
    const { body } = await getJson('/api/overview');
    const drift = (body.stats as any[]).find((s) => s.label === 'Config drift');
    expect(drift).toMatchObject({ value: '1', delta: 'live evidence coverage findings', tone: 'negative' });
  });

  it('live launchpad offers only planes and devices this estate actually has', async () => {
    contributions.clear();
    contributions.set('central', { devices: [{ ...DEVICE, localShell: true }] });
    const { body } = await getJson('/api/overview');
    const labels = (body.launchpad as any[]).map((row) => row.label);
    expect(labels).toContain('SSH to sw-test-1');
    expect(labels).toContain('Run compliance scan');
    expect(labels.some((l: string) => l.includes('Mist'))).toBe(false); // Mist is not linked
    expect(labels).not.toContain('Reconcile licences with GreenLake'); // GreenLake is not linked
  });

  it('a local-only device is coverage, not an ownership-reconciliation finding', async () => {
    contributions.clear();
    contributions.set('local', {
      devices: [{ ...DEVICE, name: 'sw-local-1', plane: 'LOCAL', planeTone: 'neutral' }],
    });
    const localOnly = await getJson('/api/compliance');
    expect((localOnly.body.findings as any[]).filter((f) => f.rule === 'inventory.reconciliation')).toEqual([]);

    // A genuine cross-plane double claim still is one.
    contributions.set('mist', {
      devices: [{ ...DEVICE, name: 'sw-local-1', plane: 'MIST', planeTone: 'info' }],
    });
    const doubled = await getJson('/api/compliance');
    const conflict = (doubled.body.findings as any[]).find((f) => f.rule === 'inventory.reconciliation');
    expect(conflict).toBeDefined();
    expect(conflict.detail).toBe('Two planes claim this device identity');
  });

  it('live systems rows project the plane pull, its sync log and the masked credential record', async () => {
    contributions.clear();
    contributions.set('central', {
      devices: [DEVICE],
      sites: [SITE],
      clients: [clientRow('AA:BB:CC:DD:EE:FF', 'CENTRAL')],
    });
    const { body } = await getJson('/api/systems');
    const central = (body.systems as any[]).find((s) => s.planeId === 'central');
    expect(central.sites).toEqual([
      { siteId: 'campus-01', name: 'Campus-01 — Meridian HQ', detail: '1 device · 1 client' },
    ]);
    expect(central.live).toEqual([
      { value: '1', label: 'devices claimed' },
      { value: '1', label: 'client sessions' },
    ]);
    // The Configuration tab's credential record — masked, never the secret.
    expect(central.configText).toContain('gatewayBaseUrl: http://127.0.0.1:1');
    expect(central.configText).toContain('clientId: stored-id');
    expect(central.configText).toContain('clientSecret: ••••••');
    expect(central.configText).not.toContain('stored-secret');
    expect(central.configText).toContain('scope: read only');
    expect(central.scope).toBe('read only'); // no write scope granted for this plane

    const unlinked = (body.systems as any[]).find((s) => s.planeId === 'mist');
    expect(unlinked.sites).toEqual([]);
    expect(unlinked.live).toEqual([]);
    expect(unlinked.scopeNote).toBe('no credentials stored');
  });

  it('the live capability matrix describes this deployment, not the fixture estate', async () => {
    const { body } = await getJson('/api/configure');
    const rows = body.capabilities as any[];
    const local = rows.find((r) => r.plane === 'Local switch collector');
    expect(local).toMatchObject({ mode: 'read only', note: 'not linked — no credentials stored' });
    const aos8 = rows.find((r) => r.plane === 'AOS-8 mobility master');
    expect(aos8.mode).toBe('read only'); // the fixture matrix advertises an ssh write path
    expect(rows.every((r) => typeof r.plane === 'string' && r.note.length > 0)).toBe(true);
  });

  it('a granted write scope promotes the plane on BOTH the systems badge and the matrix', async () => {
    await fetch(`${base}/api/settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ planes: { central: { scopes: 'read write:brokered' } } }),
    });
    try {
      const systems = await getJson('/api/systems');
      const central = (systems.body.systems as any[]).find((s) => s.planeId === 'central');
      expect(central.scope).toBe('read + broker');
      expect(central.scopeTone).toBe('accent');

      const configure = await getJson('/api/configure');
      const row = (configure.body.capabilities as any[]).find((r) => r.plane === 'HPE Aruba Central');
      expect(row).toMatchObject({ mode: 'brokered', tone: 'accent' });
    } finally {
      await fetch(`${base}/api/settings`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ planes: { central: { scopes: '' } } }),
      });
    }
  });

  it("a degraded plane's alerts and sessions are served unverified, never as current", async () => {
    const { registry } = await import('../src/planes/registry');
    contributions.clear();
    contributions.set('central', {
      alerts: [alertRow({ alertId: 'a-1' })],
      clients: [{ ...clientRow('AA:BB:CC:DD:EE:FF', 'CENTRAL'), quality: 20 }],
    });
    const fresh = await getJson('/api/alerts');
    expect(fresh.body.alerts[0].stale).toBeUndefined();
    expect((await getJson('/api/clients')).body.stats[4].value).toBe('1'); // poor experience, asserted

    registry.markSyncResult('central', false, { note: 'poll failed — showing last good data' });
    try {
      const stale = await getJson('/api/alerts');
      expect(stale.body.alerts[0].stale).toBe(true);
      expect(stale.body.alerts[0].age).toBe('5m'); // frozen at pull time, and now flagged as such

      const clients = await getJson('/api/clients');
      expect(clients.body.clients[0]).toMatchObject({ health: 'unverified', healthTone: 'neutral', problem: false });
      expect(clients.body.stats[4].value).toBe('0'); // an unverified session asserts nothing
    } finally {
      registry.reinitPlane('central'); // restore the plane's state for later tests
    }
  });

  it('the live change log names what changed and where, in local time', async () => {
    const { DEFAULT_VLAN_FORM } = await import('../../shared');
    // A brokered write references a raised ticket; demo mode also accepts the
    // fixture queue, so the change is queued there and read back live.
    await setDemoMode(true);
    const queued = await fetch(`${base}/api/configure/queue`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'vlan', form: DEFAULT_VLAN_FORM, ticket: 'NET-4188' }),
    });
    const changeId = ((await queued.json()) as any).id as string | undefined;
    await setDemoMode(false);
    try {
      expect(typeof changeId).toBe('string');
      const { body } = await getJson('/api/overview');
      const entry = (body.changes as any[])[0];
      const change = ((await (await fetch(`${base}/api/configure`)).json()) as any).queued.find(
        (c: any) => c.ticket === 'NET-4188',
      );
      // The audit line alone read 'queue vlan — ready'; the broker knows the
      // object and its blast radius, so the row says them.
      expect(entry.text).toBe(`${change.what} — ${change.where}`);
      expect(entry.who).toContain('NET-4188');
      // Local clock, like the header stamp beside it — a UTC slice reads as a
      // change that happened hours from now.
      expect(entry.time).toMatch(/^\d{2}:\d{2}$/);
      const expected = new Date();
      expect(Number(entry.time.slice(0, 2))).toBe(expected.getHours());
    } finally {
      await fetch(`${base}/api/configure/discard`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ changeId }),
      });
    }
  });

  it("the plane drawer's Recent events carry the registry's own log, not just polls", async () => {
    const { registry } = await import('../src/planes/registry');
    registry.recordEvent('central', { what: 'credentials updated', who: 'settings · operator' });
    const { body } = await getJson('/api/systems');
    const central = (body.systems as any[]).find((s) => s.planeId === 'central');
    const events = central.events as any[];
    expect(events[0]).toMatchObject({ what: 'credentials updated', who: 'settings · operator' });
    expect(events[0].time).toMatch(/^\d{2}:\d{2}$/); // local hh:mm, like every other stamp
  });

  it('a stale plane never lets a site claim its alerts are clear', async () => {
    const { registry } = await import('../src/planes/registry');
    contributions.clear();
    contributions.set('central', { devices: [DEVICE], sites: [SITE], alerts: [] });

    const fresh = await getJson('/api/sites');
    expect((fresh.body.sites as any[])[0].alerts).toBe('clear'); // an answered, empty feed IS clear

    registry.markSyncResult('central', false, { note: 'poll failed — showing last good data' });
    try {
      const stale = await getJson('/api/sites');
      const site = (stale.body.sites as any[])[0];
      // The feed the green badge would be read off is last-good, not current.
      expect(site.alerts).toBe('stale');
      expect(site.alertTone).toBe('neutral');

      // A real open row still wins — a behind plane must never HIDE an alert.
      contributions.set('central', {
        devices: [DEVICE],
        sites: [SITE],
        alerts: [alertRow({ alertId: 'a-1' })],
      });
      const open = await getJson('/api/sites');
      expect((open.body.sites as any[])[0].alerts).toBe('1 open');
      expect((open.body.sites as any[])[0].alertTone).toBe('warning');
    } finally {
      registry.reinitPlane('central');
    }
  });

  it('compliance names plane staleness as itself, and sorts findings by severity', async () => {
    const { registry } = await import('../src/planes/registry');
    contributions.clear();
    contributions.set('central', { devices: [{ ...DEVICE, firmware: '' }] });
    registry.markSyncResult('central', false, { note: 'poll failed — showing last good data' });
    try {
      const { body } = await getJson('/api/compliance');
      const findings = body.findings as any[];
      // med-severity rows lead: the table's first column is the Sev badge.
      expect(findings[0]).toMatchObject({
        sev: 'med',
        rule: 'scan.coverage.freshness',
        title: 'Device state unverified — plane is stale',
        detail: '1 device cannot be verified while CENTRAL is behind',
      });
      expect(findings.every((f, i) => i === 0 || f.sev === 'low')).toBe(true);
      // The old lump claimed the plane "did not supply this field" — false.
      expect(findings.some((f) => f.rule === 'scan.coverage.reachability')).toBe(false);
    } finally {
      registry.reinitPlane('central');
      contributions.clear();
    }
  });

  it('live overview names both down and unverified devices in one delta', async () => {
    const { registry } = await import('../src/planes/registry');
    contributions.clear();
    // One plane behind (its row cannot be asserted) and one answering with a
    // device that is genuinely down.
    contributions.set('central', { devices: [{ ...DEVICE, name: 'sw-behind-1' }] });
    contributions.set('mist', {
      devices: [{ ...DEVICE, name: 'sw-down-1', plane: 'MIST', planeTone: 'info', state: 'down', stateTone: 'danger' }],
    });
    registry.markSyncResult('central', false, { note: 'poll failed — showing last good data' });
    try {
      const { body } = await getJson('/api/overview');
      const stat = (body.stats as any[]).find((s) => s.label === 'Devices reachable');
      // Both halves of the gap between `up` and the total are named.
      expect(stat.delta).toBe('▼ 1 down · 1 unverified');
    } finally {
      registry.reinitPlane('central');
      contributions.clear();
    }
  });

  it('the Management planes panel carries the whole roster, linked first', async () => {
    contributions.clear();
    const { body } = await getJson('/api/overview');
    const planes = body.planes as any[];
    // "Planes linked N / 9" beside it must be reconcilable with the list.
    expect(planes).toHaveLength(9);
    const central = planes[0];
    expect(central.name).toBe('CENTRAL'); // linked planes lead
    const mist = planes.find((p) => p.name === 'MIST');
    expect(mist).toMatchObject({ state: 'not linked', tone: 'neutral' });
    expect(mist.scope).toBe('no credentials configured'); // the reason it is dark
  });

  it('live client rows are stitched to the policy plane by MAC', async () => {
    contributions.clear();
    contributions.set('central', {
      clients: [{ ...clientRow('AA:BB:CC:DD:EE:FF', 'CENTRAL'), auth: '—', authBy: '—', role: '—' }],
    });
    contributions.set('clearpass', {
      authEvents: [
        {
          time: '09:41',
          who: 'r.okafor',
          mac: 'aabb.ccdd.eeff', // same endpoint, ClearPass notation
          service: 'Corp 802.1X',
          method: 'EAP-TLS',
          result: 'reject',
          reason: 'certificate expired',
          role: 'quarantine',
          nas: 'sw-test-1',
          plane: 'CLEARPASS',
          tone: 'danger',
        },
      ],
    });
    const { body } = await getJson('/api/clients');
    expect(body.clients[0]).toMatchObject({
      auth: 'EAP-TLS', // the method the policy plane actually used
      authBy: 'sw-test-1', // the NAD that asked
      role: 'quarantine',
    });
    // Central never puts 'auth' in its health string — the decision is the fact.
    expect((body.stats as any[]).find((s) => s.label === 'Failing auth').value).toBe('1');
    contributions.clear();
  });

  it('observed Configure ports do not paint client health as a verified link state', async () => {
    contributions.clear();
    contributions.set('central', {
      clients: [
        {
          ...clientRow('AA:BB:CC:DD:EE:F1', 'CENTRAL'),
          medium: 'wired',
          attach: 'sw-test-1',
          where: 'port 1/1/8',
          health: '82',
          healthTone: 'success',
        },
      ],
    });
    const { body } = await getJson('/api/configure');
    const port = (body.ports as any[])[0];
    expect(port).toMatchObject({ state: 'unverified', tone: 'neutral' });
    expect(port.summary).toContain('client health 82'); // kept, but labelled
    contributions.clear();
  });

  it('auth stats never read an absent feed as a quiet network, or invent a rate', async () => {
    contributions.clear();
    const empty = await getJson('/api/auth-events');
    expect((empty.body.stats as any[]).map((s) => s.value)).toEqual(['—', '—', '—', '—', '—']);
    expect((empty.body.stats as any[]).every((s) => s.tone === 'neutral')).toBe(true);

    contributions.set('clearpass', {
      authEvents: [
        {
          time: '—',
          who: 'r.okafor',
          mac: 'AA:BB:CC:DD:EE:F2',
          service: 'Corp 802.1X',
          method: 'EAP-TLS',
          result: 'accept',
          reason: '—',
          role: 'employee',
          nas: 'sw-test-1',
          plane: 'CLEARPASS',
          tone: 'success',
        },
      ],
    });
    const untimed = await getJson('/api/auth-events');
    const stats = untimed.body.stats as any[];
    expect(stats[0]).toMatchObject({ value: '—' }); // auths/min needs a measured window
    expect(stats[0].delta).toContain('no timestamps');
    expect(stats[2].value).toBe('—'); // rejects/hour likewise
    expect(stats[1].value).toBe('100.0%'); // count-based tiles still answer
    contributions.clear();
  });

  it('live renewals honour the window the panel header claims', async () => {
    const { SUBSCRIPTIONS } = await import('../../shared');
    const day = 24 * 60 * 60 * 1000;
    contributions.clear();
    contributions.set('greenlake', {
      subscriptions: [
        { ...SUBSCRIPTIONS[0], name: 'Due soon', daysLeft: 20, expiresAtMs: Date.now() + 20 * day },
        { ...SUBSCRIPTIONS[0], name: 'Overdue', daysLeft: -3, expiresAtMs: Date.now() - 3 * day },
        { ...SUBSCRIPTIONS[0], name: 'Years out', daysLeft: 1200, expiresAtMs: Date.now() + 1200 * day },
      ],
    });
    const { body } = await getJson('/api/licenses');
    const names = (body.renewals as any[]).map((r) => r.what);
    expect(names.some((w: string) => w.startsWith('Overdue'))).toBe(true); // most urgent of all
    expect(names.some((w: string) => w.startsWith('Due soon'))).toBe(true);
    expect(names.some((w: string) => w.startsWith('Years out'))).toBe(false); // not "next 180 days"
    // The same horizon the Overview tile counts.
    expect((body.stats as any[])[3]).toMatchObject({ label: 'Expiring ≤60d', value: '1' });
    contributions.clear();
  });
});

describe('blend mode (demoMode + blendLive)', () => {
  let contributions: Map<string, unknown>;

  const putSettings = (patch: Record<string, unknown>) =>
    fetch(`${base}/api/settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    });

  const ALERT = {
    sev: 'P1',
    tone: 'danger',
    title: 'Real alert from Central',
    detail: 'gw-edge-1 tunnel down',
    siteId: 'campus-01',
    siteName: 'Campus-01 — Meridian HQ',
    plane: 'CENTRAL',
    state: 'open',
    age: '2m',
    device: 'gw-edge-1',
    alertId: 'blend-1',
  };

  const DEVICE = {
    name: 'sw-blend-1',
    model: 'CX 8325',
    type: 'switch',
    siteId: 'campus-01',
    siteName: 'Campus-01 — Meridian HQ',
    plane: 'CENTRAL',
    planeTone: 'accent',
    state: 'up',
    stateTone: 'success',
    firmware: '10.13.0005',
    firmwareApproved: true,
    licence: 'Foundation',
    reconciliationIssue: false,
    localShell: false,
  };

  beforeAll(async () => {
    const { poller } = await import('../src/services/poller');
    contributions = (poller as unknown as { contributions: Map<string, unknown> }).contributions;
    contributions.clear();
    await putSettings({ demoMode: true, blendLive: true });
  });

  afterAll(async () => {
    contributions.clear();
    await putSettings({ blendLive: false, demoMode: true });
  });

  it('swaps only the sections with live rows and names them in the envelope', async () => {
    contributions.set('central', { alerts: [ALERT] });

    const alerts = await getJson('/api/alerts');
    expect(alerts.body.dataSource).toBe('demo'); // blend stays a demo-mode envelope
    expect(alerts.body.blended).toEqual(['alerts']);
    expect(alerts.body.alerts).toHaveLength(1);
    expect(alerts.body.alerts[0].title).toBe('Real alert from Central');

    // No live clients seeded → the section stays on fixtures, unmarked.
    const clients = await getJson('/api/clients');
    expect(clients.body.dataSource).toBe('demo');
    expect(clients.body.blended).toBeUndefined();
    expect(clients.body.stats[0].value).toBe('4,982'); // fixture stat, not a live count

    // Overview: alerts swapped (view-model shape), sites still fixtures.
    // Stats + planes swap too — with central linked they derive from the
    // registry, and the fixture strip (404/418 devices, 6/7 planes) would
    // contradict the live estate.
    // The launchpad swaps too: the authored rows offer a Mist console and an
    // SSH target this estate does not have, and its device row would 404
    // against the swapped device section.
    const overview = await getJson('/api/overview');
    expect(overview.body.blended).toEqual(['stats', 'alerts', 'planes', 'changes', 'launchpad']);
    expect(overview.body.alerts[0].meta).toBe('Campus-01 — Meridian HQ · gw-edge-1 tunnel down');
    expect((overview.body.launchpad as any[]).some((row) => row.label === 'SSH to sw-core-a')).toBe(false);
    expect((overview.body.sites as any[]).some((s) => s.siteId === 'campus-01')).toBe(true);
  });

  it('device swaps carry the reconciliation block', async () => {
    contributions.set('central', { devices: [DEVICE] });
    const { status, body } = await getJson('/api/devices');
    expect(status).toBe(200);
    expect(body.blended).toEqual(['devices']);
    expect((body.devices as any[]).map((d) => d.name)).toContain('sw-blend-1');
    expect(body.reconciliation).toEqual({ doubleClaimed: 0, unclaimed: 0 });
  });

  it('device detail follows the swap: live row or 404, never a fixture config', async () => {
    contributions.set('central', { devices: [DEVICE] });
    const live = await getJson('/api/devices/sw-blend-1');
    expect(live.status).toBe(200);
    expect(live.body.device.name).toBe('sw-blend-1');
    expect(live.body.blended).toEqual(['devices']);
    expect(live.body.config).toBeNull(); // no plane reports a config — honest null
    // A fixture-only name must NOT serve its demo config once live rows lead.
    const bogus = await getJson('/api/devices/sw-core-a');
    expect(bogus.status).toBe(404);
  });

  it('auth events and licences blend as whole live sections with honest metadata', async () => {
    const { AUTH_EVENTS, SUBSCRIPTIONS } = await import('../../shared');
    const authEvent = { ...AUTH_EVENTS[0], who: 'live-auth-user' };
    const subscription = {
      ...SUBSCRIPTIONS[0],
      name: 'Live Foundation AP',
      qty: '10',
      assigned: '8',
      qtyValue: 10,
      assignedValue: 8,
      daysLeft: 20,
      expiresAtMs: Date.now() + 20 * 24 * 60 * 60 * 1000,
    };
    contributions.set('clearpass', { authEvents: [authEvent] });
    contributions.set('greenlake', { subscriptions: [subscription] });

    const auth = await getJson('/api/auth-events');
    expect(auth.body.dataSource).toBe('demo');
    expect(auth.body.blended).toEqual(['authEvents']);
    expect(auth.body.events).toEqual([authEvent]);
    expect(auth.body.stats[1].value).toBe('100.0%');

    const licenses = await getJson('/api/licenses');
    expect(licenses.body.dataSource).toBe('demo');
    expect(licenses.body.blended).toEqual(['licenses']);
    expect(licenses.body.subscriptions).toEqual([subscription]);
    expect(licenses.body.stats[0].value).toBe('1');
    expect(licenses.body.renewals).toHaveLength(1);
    expect(licenses.body.orphans).toEqual([]);
  });

  it('site detail follows the swap: live row by id or name, honest 404 otherwise', async () => {
    contributions.set('central', { devices: [DEVICE] });
    // DEVICE.siteId 'campus-01' → the live merge lists Campus-01.
    const byId = await getJson('/api/sites/campus-01');
    expect(byId.status).toBe(200);
    expect(byId.body.blended).toEqual(['sites']);
    expect(byId.body.profile).toBeNull(); // no plane reports a site profile — honest null
    expect(byId.body.site.name).toBe('Campus-01 — Meridian HQ');

    // The two core sections ride along with the live row — they are pure
    // per-site projections of the merge, not authored profile data.
    expect((byId.body.devices as any[]).map((d) => d.name)).toEqual(['sw-blend-1']);
    expect(Array.isArray(byId.body.alerts)).toBe(true);

    const byName = await getJson(`/api/sites/${encodeURIComponent('Campus-01 — Meridian HQ')}`);
    expect(byName.status).toBe(200);
    expect(byName.body.site.id).toBe('campus-01');

    // A fixture-only param must NOT serve its demo profile once live rows lead.
    const bogus = await getJson('/api/sites/no-such-place');
    expect(bogus.status).toBe(404);
    expect(bogus.body.error).toContain('not in the live inventory');
  });

  it('configure and compliance blend too — they were the last fixture-only screens', async () => {
    contributions.clear();
    contributions.set('central', {
      devices: [DEVICE],
      clients: [
        {
          name: 'blend-client',
          model: 'ThinkPad X1',
          type: 'laptop',
          mac: 'AA:BB:CC:DD:EE:01',
          ip: '10.1.4.60',
          medium: 'wireless',
          siteId: 'campus-01',
          siteName: 'Campus-01 — Meridian HQ',
          group: 'default',
          attach: 'MRDN-Corp',
          where: 'ap-blend · radio 1',
          plane: 'CENTRAL',
          planeTone: 'neutral',
          auth: 'dot1x',
          authBy: 'ClearPass',
          role: 'employee',
          vlan: '110',
          health: 'good',
          healthTone: 'success',
          session: '2h',
          problem: false,
          link: 'up',
          rssi: '-52',
          snr: '38',
          retries: '2%',
          tput: '120 Mb',
          roams: '1',
          quality: 88,
          zone: '3rd floor',
          closet: 'IDF-3',
        },
      ],
    });

    const compliance = await getJson('/api/compliance');
    expect(compliance.body.blended).toEqual(['compliance']);
    expect(compliance.body.evidenceMode).toBe('coverage');
    expect(compliance.body.diff).toContain('Live evidence coverage');

    const configure = await getJson('/api/configure');
    expect(configure.body.blended).toEqual(['configure']);
    expect(configure.body.inventoryMode).toBe('observed');
    expect((configure.body.ssids as any[]).every((s) => s.origin === 'observed')).toBe(true);
    const local = (configure.body.capabilities as any[]).find((r) => r.plane === 'Local switch collector');
    expect(local).toMatchObject({ mode: 'read only', note: 'not linked — no credentials stored' });
  });

  it('a blended envelope stamps the poll time, never "now"', async () => {
    contributions.clear();
    contributions.set('central', { alerts: [ALERT] });
    const blended = await getJson('/api/alerts');
    expect(blended.body.blended).toEqual(['alerts']);
    // The rows are real ClearPass/Central records last fetched at the poller's
    // stamp; a demo envelope's `now` would report them as just-synced. Nothing
    // has completed a poll in this harness, so the honest answer is null.
    expect(blended.body.syncedAt).toBeNull();

    // A section still on fixtures keeps the demo stamp — fixtures are current.
    const clients = await getJson('/api/clients');
    expect(clients.body.blended).toBeUndefined();
    expect(typeof clients.body.syncedAt).toBe('string');
  });

  it('blend off ignores live rows entirely', async () => {
    contributions.set('central', { alerts: [ALERT] });
    await putSettings({ blendLive: false });
    try {
      const { body } = await getJson('/api/alerts');
      expect(body.blended).toBeUndefined();
      expect((body.alerts as any[]).some((a) => a.title === 'Real alert from Central')).toBe(false);
      expect(body.alerts.length).toBeGreaterThan(1); // the fixture set
    } finally {
      await putSettings({ blendLive: true });
    }
  });
});

describe('per-section source overrides (sectionMode)', () => {
  let contributions: Map<string, unknown>;

  const putSettings = (patch: Record<string, unknown>) =>
    fetch(`${base}/api/settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    });

  const DEVICE = {
    name: 'sw-pinned-1',
    model: 'CX 8325',
    type: 'switch',
    siteId: 'campus-01',
    siteName: 'Campus-01 — Meridian HQ',
    plane: 'CENTRAL',
    planeTone: 'accent',
    state: 'up',
    stateTone: 'success',
    firmware: '10.13.0005',
    firmwareApproved: true,
    licence: 'Foundation',
    reconciliationIssue: false,
    localShell: false,
  };

  beforeAll(async () => {
    const { poller } = await import('../src/services/poller');
    contributions = (poller as unknown as { contributions: Map<string, unknown> }).contributions;
    contributions.clear();
    await putSettings({ demoMode: true, blendLive: false, sectionMode: {} });
  });

  afterAll(async () => {
    contributions.clear();
    await putSettings({ sectionMode: {}, blendLive: false, demoMode: true });
  });

  it('devices pinned live inside a demo portal; the envelope is honest per section', async () => {
    await putSettings({ sectionMode: { devices: 'live' } });

    const devices = await getJson('/api/devices');
    expect(devices.body.dataSource).toBe('live'); // the section's own source
    expect(devices.body.devices).toEqual([]);
    expect(devices.body.reconciliation).toEqual({ doubleClaimed: 0, unclaimed: 0 });

    const alerts = await getJson('/api/alerts');
    expect(alerts.body.dataSource).toBe('demo');
    expect(alerts.body.alerts.length).toBeGreaterThan(1); // fixtures

    // A live row from the cache lands on the pinned screen only.
    contributions.set('central', { devices: [DEVICE] });
    const seeded = await getJson('/api/devices');
    expect((seeded.body.devices as any[]).map((d) => d.name)).toEqual(['sw-pinned-1']);
    const sites = await getJson('/api/sites');
    expect(sites.body.dataSource).toBe('demo');
    expect((sites.body.sites as any[]).some((s) => s.id === 'riverside')).toBe(true); // fixtures
  });

  it('search index removes fixture drill-downs for live-pinned inventory sections', async () => {
    contributions.clear();
    await putSettings({ demoMode: true, blendLive: false, sectionMode: { devices: 'live' } });
    try {
      const empty = await getJson('/api/search-index');
      const emptyEntries = empty.body.entries as any[];
      expect(empty.body.dataSource).toBe('demo');
      expect(emptyEntries.some((entry) => ['device', 'mac', 'ip'].includes(entry.kind))).toBe(false);
      expect(emptyEntries.some((entry) => entry.kind === 'site' && entry.label === 'Riverside Clinic')).toBe(true);

      contributions.set('central', { devices: [DEVICE] });
      const seeded = await getJson('/api/search-index');
      const entries = seeded.body.entries as any[];
      expect(entries.filter((entry) => entry.kind === 'device').map((entry) => entry.label)).toEqual(['sw-pinned-1']);
      expect(entries.some((entry) => entry.label === 'sw-core-a')).toBe(false);
    } finally {
      contributions.clear();
      await putSettings({ sectionMode: {} });
    }
  });

  it('alerts pinned demo inside a live portal serves fixtures honestly', async () => {
    await putSettings({ demoMode: false, sectionMode: { alerts: 'demo' } });
    try {
      const alerts = await getJson('/api/alerts');
      expect(alerts.body.dataSource).toBe('demo');
      expect(alerts.body.alerts.length).toBeGreaterThan(1);

      const clients = await getJson('/api/clients');
      expect(clients.body.dataSource).toBe('live');
      expect(clients.body.clients).toEqual([]);
    } finally {
      await putSettings({ demoMode: true, sectionMode: {} });
    }
  });

  it('unknown sections and values are dropped; clearing the map restores the portal default', async () => {
    const put = await putSettings({ sectionMode: { devices: 'live', bogus: 'live', sites: 'sideways' } });
    const body = (await put.json()) as any;
    expect(body.sectionMode).toEqual({ devices: 'live' });

    await putSettings({ sectionMode: {} });
    const devices = await getJson('/api/devices');
    expect(devices.body.dataSource).toBe('demo'); // follows the portal again
    expect((devices.body.devices as any[]).some((d) => d.name === 'sw-core-a')).toBe(true);
  });

  it('a demo pin defeats the blend swap: fixtures, no blended flag; unpin blends again', async () => {
    contributions.set('central', { devices: [DEVICE] });
    await putSettings({ demoMode: true, blendLive: true, sectionMode: { devices: 'demo' } });
    try {
      const pinned = await getJson('/api/devices');
      expect(pinned.body.dataSource).toBe('demo');
      expect(pinned.body.blended).toBeUndefined();
      const names = (pinned.body.devices as any[]).map((d) => d.name);
      expect(names).toContain('sw-core-a'); // fixtures lead while pinned
      expect(names).not.toContain('sw-pinned-1');

      // Unpin → the section follows the blend again and live rows return.
      await putSettings({ sectionMode: {} });
      const unpinned = await getJson('/api/devices');
      expect(unpinned.body.blended).toEqual(['devices']);
      expect((unpinned.body.devices as any[]).map((d) => d.name)).toEqual(['sw-pinned-1']);
    } finally {
      contributions.clear();
      await putSettings({ sectionMode: {}, blendLive: false });
    }
  });

  it('systems pinned demo keeps fixtures under a live blend; unpin swaps to the registry rows', async () => {
    // A linked plane is what would swap the systems section under the blend.
    await putSettings({
      demoMode: true,
      blendLive: true,
      sectionMode: { systems: 'demo' },
      planes: { mist: { token: 'pin-test-token' } },
    });
    try {
      const pinned = await getJson('/api/systems');
      expect(pinned.body.dataSource).toBe('demo');
      expect(pinned.body.blended).toBeUndefined();
      const rows = pinned.body.systems as any[];
      expect(rows.some((s) => s.name === 'HPE Aruba Central')).toBe(true); // the fixture list
      expect(rows.every((s) => s.planeId === undefined)).toBe(true); // fixture rows carry no planeId

      // Unpin → the blend swaps the section to the live registry rows.
      await putSettings({ sectionMode: {} });
      const unpinned = await getJson('/api/systems');
      expect(unpinned.body.blended).toEqual(['systems']);
      expect((unpinned.body.systems as any[]).every((s) => typeof s.planeId === 'string')).toBe(true);
    } finally {
      await putSettings({ sectionMode: {}, blendLive: false, planes: { mist: null } });
    }
  });
});

describe('hidden demo devices', () => {
  const putSettings = (patch: Record<string, unknown>) =>
    fetch(`${base}/api/settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    });

  afterAll(async () => {
    await putSettings({ hiddenDemoDevices: [] });
  });

  it('hides pruned fixtures from the demo inventory, sanitises the list, restores on clear', async () => {
    const put = await putSettings({ hiddenDemoDevices: ['sw-core-a', 'ap-riv-01', 123, ' ', 'sw-core-a'] });
    const putBody = (await put.json()) as any;
    expect(putBody.hiddenDemoDevices).toEqual(['sw-core-a', 'ap-riv-01']); // deduped, non-strings dropped

    const { status, body } = await getJson('/api/devices');
    expect(status).toBe(200);
    expect(body.dataSource).toBe('demo');
    const names = (body.devices as any[]).map((d) => d.name);
    expect(names).not.toContain('sw-core-a');
    expect(names).not.toContain('ap-riv-01');
    expect(names).toContain('sw-core-b'); // the rest of the fixture set stays
    expect(body.hiddenDevices).toEqual(['sw-core-a', 'ap-riv-01']);

    await putSettings({ hiddenDemoDevices: [] });
    const restored = await getJson('/api/devices');
    expect((restored.body.devices as any[]).map((d) => d.name)).toContain('sw-core-a');
    expect(restored.body.hiddenDevices).toEqual([]);
  });

  it('a pruned fixture leaves the site page too — one inventory, two screens', async () => {
    const before = await getJson('/api/sites/campus-01');
    const names = (before.body.profile.devices as any[]).map((d) => d.name);
    expect(names).toContain('sw-core-a');
    const total = Number(before.body.profile.deviceCount.replace(/,/g, ''));

    await putSettings({ hiddenDemoDevices: ['sw-core-a'] });
    try {
      const after = await getJson('/api/sites/campus-01');
      expect((after.body.profile.devices as any[]).map((d) => d.name)).not.toContain('sw-core-a');
      // The headline count moves with it — the two screens describe one estate.
      expect(Number(after.body.profile.deviceCount.replace(/,/g, ''))).toBe(total - 1);
    } finally {
      await putSettings({ hiddenDemoDevices: [] });
    }
  });
});

describe('demo Configure serves the authored queue, not an empty broker', () => {
  it('renders the design\'s three queued changes and keeps the fixture stat deltas', async () => {
    const { QUEUED_CHANGES, CONFIGURE_STATS } = await import('../../shared');
    const { status, body } = await getJson('/api/configure');
    expect(status).toBe(200);
    expect(body.dataSource).toBe('demo');
    // Without this the section rendered a bare '0' header while the fixtures
    // the design specifies sat unused.
    const tickets = (body.queued as any[]).map((c) => c.ticket);
    for (const change of QUEUED_CHANGES) expect(tickets).toContain(change.ticket);
    expect(body.stats[0].value).toBe(String((body.queued as any[]).length));
    expect(body.stats[0].delta).toContain('need a window');
    // The authored inventory's own deltas survive — re-deriving them printed
    // 'live evidence coverage findings' over a fixture screen.
    expect(body.stats[2]).toEqual(CONFIGURE_STATS[2]);
    expect(body.stats[3]).toEqual(CONFIGURE_STATS[3]);
  });
});
