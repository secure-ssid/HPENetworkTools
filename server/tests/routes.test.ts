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
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

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

  it('demo inventory descendants inherit a degraded fixture plane state', async () => {
    const groups = await getJson('/api/inventory/tree?parent=system%3Aclassic');
    expect(groups.status).toBe(200);
    expect(groups.body.nodes.length).toBeGreaterThan(0);
    expect(groups.body.nodes.every((node: any) => node.status === 'stale' && node.tone === 'warning')).toBe(true);

    const sites = await getJson('/api/inventory/tree?parent=system-sites%3Aclassic');
    expect(sites.status).toBe(200);
    expect(sites.body.nodes.length).toBeGreaterThan(0);
    expect(sites.body.nodes.every((node: any) => node.status === 'stale' && node.tone === 'warning')).toBe(true);
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

  it('demo device detail names its evidence source, so an empty list can never read as a clean pass', async () => {
    const { body } = await getJson('/api/devices/sw-core-a');
    expect(body.evidence.mode).toBe('demo'); // authored checks, and the payload says so
    expect(body.evidence.checks).toEqual(body.profile.checks);
    expect(body.terminal.quickCommands.length).toBeGreaterThan(0);
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

  const saveCreds = (plane: string, creds: Record<string, string>) =>
    fetch(`${base}/api/systems/${plane}/credentials`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(creds),
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
    expect(body.systems).toHaveLength(10); // the screen's plane rows, from the registry
    const names = (body.systems as any[]).map((s) => s.name);
    expect(names).toContain('HPE Aruba Central');
    expect(names).toContain('Mist');
    const central = (body.systems as any[]).find((s) => s.name === 'HPE Aruba Central');
    expect(central.planeId).toBe('central'); // live rows name their plane so renames can't break the UI
    // Four facts, per the design: the fourth is credential freshness.
    expect(central.facts.map((f: any) => f.k)).toEqual(['Last sync', 'Devices', 'Calls today', 'Token']);
    expect(central.facts[3].v).not.toBe(''); // never blank — 'not reported' at worst
    const sse = (body.systems as any[]).find((s) => s.planeId === 'sse');
    expect(sse.facts.map((f: any) => f.k)).toEqual(['Last sync', 'Objects', 'Calls today', 'Token']);
    expect(Array.isArray(central.pulls)).toBe(true);
    expect(typeof central.configText).toBe('string');
    expect(Array.isArray(body.syncHistory)).toBe(true);
    expect(body.history).toBeUndefined();
    expect(Array.isArray(body.permissions)).toBe(true);
  });

  it('serves a bounded lazy inventory root and paged system search', async () => {
    const root = await getJson('/api/inventory/tree');
    expect(root.status).toBe(200);
    expect(root.body.parentId).toBeNull();
    expect(root.body.nodes).toHaveLength(1);
    expect(root.body.nodes[0]).toMatchObject({
      id: 'group:systems',
      kind: 'group',
      label: 'Connected systems',
      hasChildren: true,
    });

    // Planes that hold no credentials collapse behind one 'Not linked' node,
    // so the systems branch lists what actually answers plus that one group.
    const systems = await getJson('/api/inventory/tree?parent=group%3Asystems');
    expect(systems.status).toBe(200);
    const dormantGroup = systems.body.nodes.find((node: any) => node.id === 'group:dormant');
    expect(dormantGroup).toMatchObject({ kind: 'group', label: 'Not linked', status: 'unlinked' });
    expect(systems.body.nodes.filter((node: any) => node.kind === 'system').every((node: any) => node.status !== 'unlinked')).toBe(true);

    // The dormant branch itself is paged like every other branch.
    const dormant = await getJson('/api/inventory/tree?parent=group%3Adormant&limit=2');
    expect(dormant.status).toBe(200);
    expect(dormant.body.nodes).toHaveLength(2);
    expect(dormant.body.nextCursor).toBe('2');
    expect(dormant.body.nodes.every((node: any) => node.kind === 'system')).toBe(true);
    expect(dormant.body.nodes.every((node: any) => node.parentId === 'group:dormant')).toBe(true);

    const next = await getJson('/api/inventory/tree?parent=group%3Adormant&limit=2&cursor=2');
    expect(next.status).toBe(200);
    expect(next.body.nodes).toHaveLength(2);
    expect(next.body.nodes[0].id).not.toBe(dormant.body.nodes[0].id);

    const node = await getJson(`/api/inventory/node?id=${encodeURIComponent(dormant.body.nodes[0].id)}`);
    expect(node.status).toBe(200);
    expect(node.body.id).toBe(dormant.body.nodes[0].id);

    const rootNode = await getJson('/api/inventory/node?id=group%3Asystems');
    expect(rootNode.status).toBe(200);
    expect(rootNode.body).toMatchObject({ id: 'group:systems', kind: 'group', label: 'Connected systems' });

    const dormantNode = await getJson('/api/inventory/node?id=group%3Adormant');
    expect(dormantNode.status).toBe(200);
    expect(dormantNode.body).toMatchObject({ id: 'group:dormant', kind: 'group', label: 'Not linked' });
  });

  it("propagates a degraded plane's read state to its inventory descendants", async () => {
    const { registry } = await import('../src/planes/registry');
    const mutableState = registry.get('central').state();
    const previousState = { ...mutableState };
    const inventoryDevice = { ...DEVICE, serial: 'SERIAL-XYZ-123', mac: 'AA:BB:CC:DD:EE:99' };
    contributions.clear();
    contributions.set('central', { sites: [SITE], devices: [inventoryDevice] });
    Object.assign(mutableState, {
      linked: true,
      health: 'healthy',
      lastSync: new Date().toISOString(),
      note: null,
      consecutiveFailures: 0,
      nextAttemptAt: null,
    });

    const freshSites = await getJson('/api/inventory/tree?parent=system-sites%3Acentral');
    const freshDevices = await getJson('/api/inventory/tree?parent=system-devices%3Acentral');
    expect(freshSites.body.nodes[0].status).toBe('current');
    expect(freshDevices.body.nodes[0].status).toBe('current');

    const siteChildren = await getJson(
      `/api/inventory/tree?parent=${encodeURIComponent(`site:central:${SITE.id}`)}`,
    );
    expect(siteChildren.body.nodes[0].id).not.toBe(freshDevices.body.nodes[0].id);

    const serialSearch = await getJson('/api/inventory/search?q=SERIAL-XYZ-123&limit=10');
    expect(serialSearch.status).toBe(200);
    expect(serialSearch.body.nodes).toContainEqual(
      expect.objectContaining({
        label: inventoryDevice.name,
        identity: expect.objectContaining({ serial: inventoryDevice.serial }),
      }),
    );
    const serialNode = serialSearch.body.nodes.find((node: any) => node.identity?.serial === inventoryDevice.serial);
    const exactSerialNode = await getJson(`/api/inventory/node?id=${encodeURIComponent(serialNode.id)}`);
    expect(exactSerialNode.status).toBe(200);
    expect(exactSerialNode.body.id).toBe(serialNode.id);

    const macSearch = await getJson(`/api/inventory/search?q=${encodeURIComponent(inventoryDevice.mac)}&limit=10`);
    expect(macSearch.body.nodes).toContainEqual(expect.objectContaining({ id: serialNode.id }));

    mutableState.health = 'degraded';
    mutableState.note = 'poll failed — showing last good data';
    try {
      const groups = await getJson('/api/inventory/tree?parent=system%3Acentral');
      const staleSites = await getJson('/api/inventory/tree?parent=system-sites%3Acentral');
      const staleDevices = await getJson('/api/inventory/tree?parent=system-devices%3Acentral');
      expect(groups.body.nodes).toEqual([
        expect.objectContaining({ label: 'Sites', status: 'failed', tone: 'danger' }),
        expect.objectContaining({ label: 'Devices', status: 'failed', tone: 'danger' }),
      ]);
      expect(staleSites.body.nodes[0]).toMatchObject({ status: 'failed', tone: 'danger' });
      expect(staleDevices.body.nodes[0]).toMatchObject({ status: 'failed', tone: 'danger' });
    } finally {
      Object.assign(mutableState, previousState);
      contributions.clear();
    }
  });

  it('keeps cached SSE descendants expandable when their parent plane is stale', async () => {
    const { registry } = await import('../src/planes/registry');
    const mutableState = registry.get('sse').state();
    const previousState = { ...mutableState };
    contributions.clear();
    contributions.set('sse', {
      sse: {
        kinds: {
          users: {
            rows: [{ kind: 'users', id: 'user-1', name: 'Cached user', raw: {} }],
            total: 1,
            truncated: false,
          },
        },
        unavailable: [],
      },
    });
    Object.assign(mutableState, {
      linked: true,
      health: 'degraded',
      lastSync: new Date().toISOString(),
      note: 'poll failed — showing last good data',
    });

    try {
      const kinds = await getJson('/api/inventory/tree?parent=system%3Asse');
      const users = kinds.body.nodes.find((node: any) => node.identity?.sseKind === 'users');
      expect(users).toMatchObject({ status: 'failed', hasChildren: true, childCount: 1 });

      const objects = await getJson('/api/inventory/tree?parent=sse-kind%3Ausers');
      expect(objects.body.nodes[0]).toMatchObject({ label: 'Cached user', status: 'failed' });
    } finally {
      Object.assign(mutableState, previousState);
      contributions.clear();
    }
  });

  it('rejects malformed inventory parents and cursors instead of returning an unbounded or failed response', async () => {
    expect((await getJson('/api/inventory/tree?parent=site%3A%25')).status).toBe(400);
    expect((await getJson('/api/inventory/tree?cursor=-1')).status).toBe(400);
    expect((await getJson('/api/inventory/search?limit=0')).status).toBe(400);
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
    // …and the site rides along as DATA too, so a renderer can link it
    // instead of parsing the prose fragment back out of `meta`.
    expect(body.alerts[0].siteName).toBe('Campus-01 — Meridian HQ');
    expect(body.alerts[0].siteId).toBe('campus-01');
    const site = (body.sites as any[]).find((s) => s.siteId === 'campus-01');
    expect(site).toBeDefined();
    expect(site.plane).toContain('CENTRAL');
    expect(typeof site.devices).toBe('number');
    expect(typeof site.clients).toBe('string');
  });

  it('an overview alert with no reported site sends no site fields at all', async () => {
    contributions.clear();
    contributions.set('central', {
      // 'core-services' is one of the bookkeeping ids alert rows file under:
      // it has no site page, so linking it would be a dead jump.
      alerts: [alertRow({ alertId: 'a-2', siteId: 'core-services', siteName: '—' })],
    });
    const { body } = await getJson('/api/overview');
    expect(body.alerts[0].meta).toBe('ap-1 flapping on channel 36'); // no '—' prefix
    expect(body.alerts[0].siteName).toBeUndefined(); // omitted, never blank
    expect(body.alerts[0].siteId).toBeUndefined();
  });

  it("live overview's Needs-you-now drops cleared rows and leads with the unacked worst", async () => {
    contributions.clear();
    contributions.set('central', {
      alerts: [
        // A plane that has resolved a P1 is not asking for anyone: a 50-day-old
        // cleared row under "Needs you now" overstates the workload (README §2).
        alertRow({ alertId: 'c-1', sev: 'P1', tone: 'danger', title: 'Gateway down', state: 'cleared', age: '50d' }),
        alertRow({ alertId: 'a-1', sev: 'P1', tone: 'danger', title: 'Acked P1', state: 'acked', age: '9h' }),
        alertRow({ alertId: 'o-1', sev: 'P1', tone: 'danger', title: 'Open P1', state: 'open', age: '2h' }),
        alertRow({ alertId: 'o-2', title: 'Open P2', state: 'open', age: '30m' }),
      ],
    });
    const { body } = await getJson('/api/overview');
    expect((body.alerts as any[]).map((a) => a.title)).toEqual(['Open P1', 'Acked P1', 'Open P2']);
    // The stat tile counts only what is open, and it must not disagree with
    // the panel it sits above.
    const open = (body.stats as any[]).find((s) => s.label === 'Open alerts');
    expect(open.value).toBe('2');

    // …and a tenant whose every alert is cleared gets the panel's empty state,
    // not a wall of stale P1s (the live shape of this estate today).
    contributions.set('central', {
      alerts: [alertRow({ alertId: 'c-2', sev: 'P1', tone: 'danger', state: 'cleared', age: '51d' })],
    });
    const cleared = await getJson('/api/overview');
    expect(cleared.body.alerts).toEqual([]);
    expect((cleared.body.stats as any[]).find((s) => s.label === 'Open alerts').value).toBe('0');
  });

  it('live system rows carry a console URL only for a plane whose stored endpoint IS its console', async () => {
    const saved = await saveCreds('clearpass', { publisher: 'cppm-01.meridian.health', token: 'cppm-token-1234' });
    expect(saved.status).toBe(200);
    try {
      const { body } = await getJson('/api/systems');
      const rows = body.systems as any[];
      const clearpass = rows.find((s) => s.planeId === 'clearpass');
      // A bare host is the operator's own record — served as its https origin,
      // never decorated with an invented console path.
      expect(clearpass.consoleUrl).toBe('https://cppm-01.meridian.health');
      // Central stores an API GATEWAY and GreenLake a workspace id; neither is
      // a console, so "Open console" must stay inert rather than open a page
      // that is not one. The collector has no console at all.
      for (const planeId of ['central', 'greenlake', 'local', 'mist']) {
        expect(rows.find((s) => s.planeId === planeId).consoleUrl).toBeUndefined();
      }
    } finally {
      await fetch(`${base}/api/systems/clearpass`, { method: 'DELETE' });
    }
  });

  it('a stored console endpoint is served as an origin — no path, no userinfo', async () => {
    const saved = await saveCreds('aos8', {
      master: 'https://admin:hunter2@10.48.0.10:4343/screens/wms/wms.login',
      username: 'ro',
      password: 'pw-12345678',
    });
    expect(saved.status).toBe(200);
    try {
      const { body } = await getJson('/api/systems');
      const aos8 = (body.systems as any[]).find((s) => s.planeId === 'aos8');
      expect(aos8.consoleUrl).toBe('https://10.48.0.10:4343');
    } finally {
      await fetch(`${base}/api/systems/aos8`, { method: 'DELETE' });
    }
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
      // A server-listed change is only actionable if the row can name it: no
      // id, and every change queued before a reload is unpushable forever.
      const listed = (configure.body.queued as any[]).find((change) => change.ticket === 'NET-4188');
      expect(listed.id).toBe(changeId);
      expect(listed.expiresAt === null || typeof listed.expiresAt === 'string').toBe(true);
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

      contributions.set('central', {
        devices: [DEVICE],
        clients: [
          clientRow('AA:BB:CC:DD:EE:FF', 'CENTRAL'),
          {
            ...clientRow('AA:BB:CC:DD:EE:11', 'CENTRAL'),
            medium: 'wired',
            attach: 'sw-test-1',
            where: 'port 1/1/8',
          },
        ],
        config: {
          mode: 'configured',
          source: 'Central /network-config/v1/wlan-ssids',
          ssids: [
            {
              kind: 'ssid',
              origin: 'configured',
              name: 'Central-Staff',
              vlan: '820',
              security: 'WPA3-Enterprise',
              targets: 'Enabled profile · scope assignment not read',
              plane: 'CENTRAL',
              tone: 'accent',
            },
          ],
          unavailable: ['vlans', 'ports'],
        },
      });
      const configured = await getJson('/api/configure');
      expect(configured.body.inventoryMode).toBe('configured');
      expect(configured.body.ssids).toEqual([
        expect.objectContaining({ name: 'Central-Staff', origin: 'configured' }),
      ]);
      expect(configured.body.ports[0].origin).toBe('observed');
      expect(configured.body.vlans[0]).toMatchObject({ id: '110', origin: 'observed' });
      expect(configured.body.stats[2].delta).toContain('configured SSIDs');
      expect(configured.body.stats[2].delta).toContain('observed ports');

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

  it('unassigned inventory stays on Devices without becoming a fake site', async () => {
    contributions.clear();
    contributions.set('central', {
      sites: [SITE],
      devices: [
        DEVICE,
        { ...DEVICE, name: 'claimed-unassigned', serial: 'UNASSIGNED-1', siteId: 'multiple', siteName: 'Multiple' },
      ],
    });
    const devices = await getJson('/api/devices');
    expect((devices.body.devices as any[]).map((device) => device.name)).toContain('claimed-unassigned');

    const sites = await getJson('/api/sites');
    expect((sites.body.sites as any[]).map((site) => site.id)).toEqual(['campus-01']);
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

  it('live site detail derives the "Local reachability" panel instead of leaving it NOT REPORTED', async () => {
    contributions.clear();
    contributions.set('central', { devices: [DEVICE] });
    const { body } = await getJson('/api/sites/campus-01');
    // No local collector credentials in this deployment: the panel asserts
    // nothing at all, and the share is null — NOT 0%, which would claim every
    // device here failed to answer a probe the portal never sent.
    expect(body.reachability).toMatchObject({
      collector: 'not linked',
      collectorTone: 'neutral',
      reachValue: null,
      core: null,
    });
    expect(body.reachability.collectorNote).toContain('no device at this site has been probed directly');
  });

  it('a linked collector reports its real share, and only offers a core it could actually shell', async () => {
    contributions.clear();
    const saved = await saveCreds('local', { host: 'jump-01.meridian.health', username: 'svc-portal', password: 'pw-12345678' });
    expect(saved.status).toBe(200);
    try {
      contributions.set('local', {
        devices: [
          { ...DEVICE, name: 'sw-core-x', plane: 'LOCAL', planeTone: 'accent', localShell: true, ip: '10.1.0.5' },
          // Same collector, but no management IP — the bridge would refuse to
          // dial it, so it must never be the terminal target.
          { ...DEVICE, name: 'sw-core-y', plane: 'LOCAL', planeTone: 'accent', localShell: true },
        ],
      });
      const { body } = await getJson('/api/sites/campus-01');
      expect(body.reachability.reachValue).toBe(100); // both rows are collector-claimed
      expect(body.reachability.collector).not.toBe('not linked');
      expect(body.reachability.core).toBe('sw-core-x');
      expect(body.reachability.collectorNote).toContain('2 of 2 devices');
    } finally {
      await fetch(`${base}/api/systems/local`, { method: 'DELETE' });
      contributions.clear();
    }
  });

  it('live device detail carries per-device evidence and only ships a shell block it can honour', async () => {
    contributions.clear();
    const CONTROLLER = {
      ...DEVICE,
      name: 'mc-lake-1',
      type: 'controller',
      plane: 'AOS-8',
      planeTone: 'accent',
      localShell: true,
    };
    contributions.set('central', { devices: [{ ...DEVICE, firmware: '' }] });
    const cloud = await getJson('/api/devices/sw-test-1');
    // The same five rules /api/compliance runs, evaluated for this one device.
    expect(cloud.body.evidence.mode).toBe('live');
    expect((cloud.body.evidence.checks as any[]).map((c) => c.rule)).toEqual([
      'scan.coverage.identity',
      'scan.coverage.freshness',
      'scan.coverage.reachability',
      'scan.coverage.firmware',
      'inventory.reconciliation',
    ]);
    const firmware = (cloud.body.evidence.checks as any[]).find((c) => c.rule === 'scan.coverage.firmware');
    expect(firmware).toMatchObject({ mark: 'fail', label: 'CENTRAL reported no firmware version' });
    expect((cloud.body.evidence.checks as any[]).find((c) => c.rule === 'scan.coverage.identity').mark).toBe('pass');
    // localShell false — no banner may promise a session the bridge refuses.
    expect(cloud.body.terminal).toBeUndefined();

    contributions.clear();
    // The collector credentials ARE the shell path: with none stored, no live
    // device can be dialled at all, so the row's own claim is not enough.
    contributions.set('aos8', { devices: [{ ...CONTROLLER, ip: '10.48.0.10' }] });
    const noCreds = await getJson('/api/devices/mc-lake-1');
    expect(noCreds.body.device.localShell).toBe(false);
    expect(noCreds.body.terminal).toBeUndefined();

    const savedLocal = await saveCreds('local', { host: 'jump-01.meridian.health', username: 'svc-portal', password: 'pw-12345678' });
    expect(savedLocal.status).toBe(200);
    try {
      contributions.set('aos8', { devices: [{ ...CONTROLLER, ip: '10.48.0.10' }] });
      const shell = await getJson('/api/devices/mc-lake-1');
      // Class comes from the row's device TYPE (controller → AOS chips), never
      // the demo name-prefix rules, so route and screen cannot disagree.
      expect(shell.body.device.localShell).toBe(true);
      expect(shell.body.terminal.quickCommands).toContain('show ap database');
      expect(shell.body.terminal.banner.length).toBeGreaterThan(0);

      // Same credentials, same claim — but the inventory names no management
      // IP, so resolveTarget() would refuse to dial and the gate must close
      // rather than render a terminal that can never open.
      contributions.set('aos8', { devices: [CONTROLLER] });
      const noIp = await getJson('/api/devices/mc-lake-1');
      expect(noIp.body.device.localShell).toBe(false);
      expect(noIp.body.terminal).toBeUndefined();

      contributions.set('aos8', { devices: [{ ...CONTROLLER, ip: '10.48.0.11', name: 'ap-test-1', type: 'ap' }] });
      const ap = await getJson('/api/devices/ap-test-1');
      expect(ap.body.device.localShell).toBe(false);
      expect(ap.body.terminal).toBeUndefined(); // cloud-claimed class has no shell at all
    } finally {
      await fetch(`${base}/api/systems/local`, { method: 'DELETE' });
      contributions.clear();
    }
  });

  it('a plane that reports no local shell overrides a row that claims one', async () => {
    contributions.clear();
    // Mist's adapter answers capabilities().localShell === false: it describes
    // hardware the portal has no bridge to. A row claiming otherwise cannot
    // conjure a session, so both the served flag and the shell block say no —
    // DeviceDetail drives its WS attempt off `device.localShell` alone.
    const saved = await saveCreds('mist', { apiHost: 'api.mist.example.com', orgId: 'org-1', token: 'mist-token-1234' });
    expect(saved.status).toBe(200);
    const savedLocal = await saveCreds('local', { host: 'jump-01.meridian.health', username: 'svc-portal', password: 'pw-12345678' });
    expect(savedLocal.status).toBe(200);
    try {
      contributions.set('mist', {
        devices: [{ ...DEVICE, name: 'sw-mist-1', plane: 'MIST', planeTone: 'info', localShell: true, ip: '10.42.9.9' }],
      });
      const { body } = await getJson('/api/devices/sw-mist-1');
      expect(body.device.localShell).toBe(false); // corrected to what the portal can do
      expect(body.terminal).toBeUndefined(); // …and no shell block is offered
    } finally {
      await fetch(`${base}/api/systems/mist`, { method: 'DELETE' });
      await fetch(`${base}/api/systems/local`, { method: 'DELETE' });
      contributions.clear();
    }
  });

  it('one claimant with a shell path is enough — a peer plane saying no does not erase it', async () => {
    contributions.clear();
    // The union is ANY, not ALL (reconcile.ts unionLocalShell), and the gate
    // downstream is what keeps that honest: Mist claims this controller and
    // answers capabilities().localShell === false, AOS-8 claims the same box and
    // reports a shell. ALL would lose a working shell to Mist's disclaimer; ANY
    // cannot offer a broken one, because the collector credentials still have to
    // be there for the gate to open.
    const saved = await saveCreds('mist', { apiHost: 'api.mist.example.com', orgId: 'org-1', token: 'mist-token-1234' });
    expect(saved.status).toBe(200);
    const savedAos8 = await saveCreds('aos8', { master: 'https://10.48.0.10:4343', username: 'ro', password: 'pw-12345678' });
    expect(savedAos8.status).toBe(200);
    const CONTROLLER = { ...DEVICE, name: 'mc-both-1', type: 'controller', ip: '10.48.0.10' };
    try {
      contributions.set('mist', { devices: [{ ...CONTROLLER, plane: 'MIST', planeTone: 'info', localShell: false }] });
      contributions.set('aos8', { devices: [{ ...CONTROLLER, plane: 'AOS-8', planeTone: 'accent', localShell: true }] });
      const noCreds = await getJson('/api/devices/mc-both-1');
      expect(noCreds.body.device.claimedBy).toEqual(['MIST', 'AOS-8']);
      expect(noCreds.body.device.localShell).toBe(false); // no collector credentials — no shell path at all

      const savedLocal = await saveCreds('local', { host: 'jump-01.meridian.health', username: 'svc-portal', password: 'pw-12345678' });
      expect(savedLocal.status).toBe(200);
      const { body } = await getJson('/api/devices/mc-both-1');
      expect(body.device.localShell).toBe(true);
      expect(body.terminal.quickCommands).toContain('show ap database');
    } finally {
      await fetch(`${base}/api/systems/mist`, { method: 'DELETE' });
      await fetch(`${base}/api/systems/aos8`, { method: 'DELETE' });
      await fetch(`${base}/api/systems/local`, { method: 'DELETE' });
      contributions.clear();
    }
  });

  it('live auth rows badge the plane that owns the NAS, not the reporting policy plane', async () => {
    contributions.clear();
    const event = {
      time: '09:41:02',
      who: 'r.okafor',
      mac: 'AA:BB:CC:DD:EE:01',
      service: 'Corp dot1x',
      method: 'dot1x',
      result: 'accept',
      reason: '—',
      role: 'employee',
      nas: 'sw-test-1',
      plane: 'CLEARPASS',
      tone: 'success',
    };
    contributions.set('clearpass', { authEvents: [event, { ...event, mac: 'AA:BB:CC:DD:EE:02', nas: 'unknown-nas' }] });
    const noDevices = await getJson('/api/auth-events');
    // Nothing to join against: the reporter's own truthful label stays.
    expect((noDevices.body.events as any[]).map((e) => e.plane)).toEqual(['CLEARPASS', 'CLEARPASS']);

    contributions.set('central', { devices: [DEVICE] });
    const joined = await getJson('/api/auth-events');
    expect((joined.body.events as any[])[0].plane).toBe('CENTRAL'); // unique match on the NAS name
    expect((joined.body.events as any[])[1].plane).toBe('CLEARPASS'); // no match — never a guess
  });

  it('the live alert queue carries a derived correlation banner, or an explicit null', async () => {
    contributions.clear();
    contributions.set('central', { devices: [DEVICE] });
    const quiet = await getJson('/api/alerts');
    expect(quiet.body.correlation).toBeNull(); // nothing open — no banner renders

    contributions.set('central', {
      alerts: [alertRow({ alertId: 'p1', sev: 'P1', tone: 'danger', title: 'Gateway down' })],
    });
    const p1 = await getJson('/api/alerts');
    expect(p1.body.correlation).toMatchObject({ tone: 'danger', title: 'Gateway down' });
    expect(p1.body.correlation.body).toContain('Campus-01 — Meridian HQ');

    contributions.set('central', {
      alerts: [
        alertRow({ alertId: 'p1', sev: 'P1', tone: 'danger', title: 'Gateway down' }),
        alertRow({ alertId: 'behind', title: 'AP offline', plane: 'MIST', stale: true }),
      ],
    });
    const withStale = await getJson('/api/alerts');
    // Second finding: a row whose plane is behind is unverified, not current.
    expect(withStale.body.correlation.title).toBe('Gateway down — and MIST is stale');
    expect(withStale.body.correlation.body).toContain('frozen at pull time');
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

  it('the entitlement join drives "Devices unlicensed" and the orphan/gap rows', async () => {
    contributions.clear();
    contributions.set('central', {
      devices: [
        { ...DEVICE, serial: 'SG01ABC123' },
        { ...DEVICE, name: 'sw-test-2', serial: 'SG01ABC124' },
        { ...DEVICE, name: 'sw-quiet-1', serial: 'SG01ABC125' },
      ],
    });
    contributions.set('greenlake', {
      subscriptions: [
        {
          name: 'Foundation AP',
          sku: 'SUB-AP-FND',
          plane: 'GREENLAKE',
          term: '3y',
          qty: '100',
          assigned: '0',
          pct: '0%',
          expires: '2027-01-01',
          status: 'idle',
          planeTone: 'info',
          tone: 'neutral',
          assignedValue: 0,
        },
      ],
      assignments: [
        { serial: 'SG01ABC123', deviceName: 'sw-test-1', assigned: true, subscriptionKey: 'K1' },
        // Racked and reported, but the entitlement plane says it holds none.
        { serial: 'SG01ABC124', deviceName: 'sw-test-2', assigned: false, subscriptionKey: null },
        // Reported by the entitlement plane, in no plane's inventory.
        { serial: 'SG09ZZZ999', deviceName: 'sw-decommissioned', assigned: true, subscriptionKey: 'K2' },
        // Tri-state: the plane never said. An unknown must not be counted as
        // unlicensed, or every silent row inflates the tile.
        { serial: 'SG01ABC125', deviceName: 'sw-quiet-1', subscriptionKey: 'K3' },
      ],
    });
    const { body } = await getJson('/api/licenses');
    expect(body.stats[4]).toMatchObject({ label: 'Devices unlicensed', value: '1', tone: 'negative' });
    expect(body.stats[4].delta).toBe('3 of 4 assignments state an entitlement');
    const tags = (body.orphans as any[]).map((o) => o.tag);
    expect(tags).toEqual(['orphan', 'gap', 'idle']);
    expect((body.orphans as any[])[0].detail).toContain('sw-decommissioned');
    expect((body.orphans as any[])[1].what).toBe('1 device with no active subscription');

    // A plane that could not read the feed sends no assignments key at all —
    // the tile must fall back to what the device rows say, and the reclaim
    // list must stay empty rather than claiming a clean estate.
    contributions.set('greenlake', { subscriptions: [] });
    const noFeed = await getJson('/api/licenses');
    expect(noFeed.body.stats[4].delta).toBe('3 of 3 devices carry an entitlement');
    expect(noFeed.body.orphans).toEqual([]);
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
    // The row claims a shell and names a dialable IP, but no collector
    // credentials are stored — the credentials ARE the shell path, so the
    // terminal would refuse. A Launchpad row here is a control that cannot act.
    const SHELL_ROW = { ...DEVICE, name: 'sw-shell-1', plane: 'LOCAL', planeTone: 'neutral', localShell: true, ip: '10.1.0.9' };
    contributions.set('local', { devices: [SHELL_ROW] });
    const noCreds = await getJson('/api/overview');
    const noCredLabels = (noCreds.body.launchpad as any[]).map((row) => row.label);
    expect(noCredLabels.some((l: string) => l.startsWith('SSH to'))).toBe(false);
    expect(noCredLabels).toContain('Run compliance scan');

    const savedLocal = await saveCreds('local', { host: 'jump-01.meridian.health', username: 'svc-portal', password: 'pw-12345678' });
    expect(savedLocal.status).toBe(200);
    try {
      contributions.set('local', { devices: [SHELL_ROW] });
      const { body } = await getJson('/api/overview');
      const labels = (body.launchpad as any[]).map((row) => row.label);
      // Same gate the device page uses, so the row cannot land on a page that
      // then says there is no shell here.
      expect(labels).toContain('SSH to sw-shell-1');
      expect(labels).toContain('Run compliance scan');
      expect(labels.some((l: string) => l.includes('Mist'))).toBe(false); // Mist is not linked
      expect(labels).not.toContain('Reconcile licences with GreenLake'); // GreenLake is not linked

      // …and the device page agrees: one gate, one answer.
      const detail = await getJson('/api/devices/sw-shell-1');
      expect(detail.body.device.localShell).toBe(true);
      expect(detail.body.terminal.quickCommands.length).toBeGreaterThan(0);
    } finally {
      await fetch(`${base}/api/systems/local`, { method: 'DELETE' });
      contributions.clear();
    }
  });

  it('the served inventory carries the live shell gate, not the plane row claim', async () => {
    contributions.clear();
    // /api/devices is where every other live consumer gets its rows, so the
    // correction belongs on the way out of the merge — not on the one endpoint
    // that happens to render it.
    const CLAIMED = { ...DEVICE, name: 'sw-claimed-1', plane: 'LOCAL', planeTone: 'neutral', localShell: true, ip: '10.1.0.7' };
    contributions.set('local', { devices: [CLAIMED] });
    const noCreds = await getJson('/api/devices');
    expect((noCreds.body.devices as any[])[0]).toMatchObject({ name: 'sw-claimed-1', localShell: false });

    const savedLocal = await saveCreds('local', { host: 'jump-01.meridian.health', username: 'svc-portal', password: 'pw-12345678' });
    expect(savedLocal.status).toBe(200);
    try {
      contributions.set('local', { devices: [CLAIMED, { ...CLAIMED, name: 'sw-claimed-2', ip: undefined }] });
      const withCreds = await getJson('/api/devices');
      const rows = withCreds.body.devices as any[];
      expect(rows.find((d) => d.name === 'sw-claimed-1').localShell).toBe(true);
      // Same claim, same credentials — but no management IP to dial.
      expect(rows.find((d) => d.name === 'sw-claimed-2').localShell).toBe(false);
    } finally {
      await fetch(`${base}/api/systems/local`, { method: 'DELETE' });
      contributions.clear();
    }
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

  it('a badge that names no registry plane asserts neither staleness nor a sync stamp', async () => {
    const { registry } = await import('../src/planes/registry');
    contributions.clear();
    // 'THIRD-PARTY' is the one Plane label with no registry plane behind it.
    // Both callers of the shared label→plane map (reconcile.planeIdForLabel)
    // must resolve it to undefined: it can neither drag the site into 'stale'
    // — the site's own alert feed answered, empty — nor supply the freshness
    // stamp the adapter row declined to give ('—', never a borrowed one).
    contributions.set('central', {
      devices: [],
      sites: [{ ...SITE, id: 'partner-lab', name: 'Partner Lab', planes: [{ name: 'THIRD-PARTY', tone: 'neutral' }], sync: '—' }],
      alerts: [],
    });
    // Central is behind, but it badges nothing here, so it must not colour this row.
    registry.markSyncResult('central', false, { note: 'poll failed — showing last good data' });
    try {
      const { body } = await getJson('/api/sites');
      const site = (body.sites as any[]).find((s) => s.id === 'partner-lab');
      expect(site).toBeDefined();
      expect(site.planes).toEqual([{ name: 'THIRD-PARTY', tone: 'neutral' }]);
      expect(site.alerts).toBe('clear');
      expect(site.alertTone).toBe('success');
      expect(site.sync).toBe('—'); // not 'never', and not central's stamp
    } finally {
      registry.reinitPlane('central');
      contributions.clear();
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
    // "Planes linked N / 10" beside it must be reconcilable with the list.
    expect(planes).toHaveLength(10);
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

  it('a duplicate name across the blended live rows is rejected honestly, not picked first', async () => {
    contributions.set('central', { devices: [{ ...DEVICE, name: 'sw-blend-dup', serial: 'BLEND-A' }] });
    contributions.set('mist', {
      devices: [{ ...DEVICE, name: 'sw-blend-dup', serial: 'BLEND-B', plane: 'MIST', planeTone: 'info' }],
    });
    const ambiguous = await getJson('/api/devices/sw-blend-dup');
    expect(ambiguous.status).toBe(409);
    expect((ambiguous.body.candidates as any[]).map((c) => c.serial).sort()).toEqual(['BLEND-A', 'BLEND-B']);

    const resolved = await getJson('/api/devices/sw-blend-dup?serial=BLEND-B');
    expect(resolved.status).toBe(200);
    expect(resolved.body.device.plane).toBe('MIST');
    contributions.delete('mist');
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
    // The demo estate's reconciliation counts ride on the payload like every
    // other mode's, so the screen reads one key instead of a demo fallback.
    expect(body.reconciliation).toEqual({ doubleClaimed: 3, unclaimed: 14 });

    await putSettings({ hiddenDemoDevices: [] });
    const restored = await getJson('/api/devices');
    expect((restored.body.devices as any[]).map((d) => d.name)).toContain('sw-core-a');
    expect(restored.body.hiddenDevices).toEqual([]);
  });

  it('a pruned fixture leaves the site page too — one inventory, two screens', async () => {
    const before = await getJson('/api/sites/campus-01');
    const names = (before.body.profile.devices as any[]).map((d) => d.name);
    expect(names).toContain('sw-core-a');
    expect(before.body.profile.core).toBe('sw-core-a');
    const total = Number(before.body.profile.deviceCount.replace(/,/g, ''));

    await putSettings({ hiddenDemoDevices: ['sw-core-a'] });
    try {
      const after = await getJson('/api/sites/campus-01');
      expect((after.body.profile.devices as any[]).map((d) => d.name)).not.toContain('sw-core-a');
      // The headline count moves with it — the two screens describe one estate.
      expect(Number(after.body.profile.deviceCount.replace(/,/g, ''))).toBe(total - 1);
      // …and so does the reachability panel's terminal target: offering a
      // shell on a device the operator pruned would dial a row this portal no
      // longer holds. '' is the profile's documented "no core known" value.
      expect(after.body.profile.core).toBe('');
    } finally {
      await putSettings({ hiddenDemoDevices: [] });
    }
  });

  it('pruning some other device leaves the core terminal target alone', async () => {
    await putSettings({ hiddenDemoDevices: ['sw-core-b'] });
    try {
      const { body } = await getJson('/api/sites/campus-01');
      expect((body.profile.devices as any[]).map((d) => d.name)).not.toContain('sw-core-b');
      expect(body.profile.core).toBe('sw-core-a'); // still in the inventory, still shellable
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

/**
 * On-demand per-object detail reads.
 *
 * A control plane models one client across ~8 endpoints and one device across
 * many /{id}/subresource endpoints, so the flat lists the poller reads cannot
 * carry signal, roam trail, per-radio RF, per-port wiring or link topology.
 * These fetch that for the ONE object being opened — and, just as importantly,
 * refuse to fetch it for anything else.
 *
 * The adapters are stubbed on the registry's live instances, so what is under
 * test is the ROUTE's contract: when it calls a plane, when it declines to,
 * and how each outcome is worded.
 */
describe('on-demand per-object detail reads', () => {
  let contributions: Map<string, unknown>;
  let planes: { get(id: string): Record<string, unknown> };
  let clearDetailCache: () => void;
  const undo: Array<() => void> = [];

  const setDemoMode = (demoMode: boolean) =>
    fetch(`${base}/api/settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ demoMode }),
    });

  const AP = {
    name: 'ap-detail-1',
    model: 'AP-735',
    type: 'ap',
    siteId: 'campus-01',
    siteName: 'Campus-01 — Meridian HQ',
    plane: 'CENTRAL',
    planeTone: 'accent',
    state: 'up',
    stateTone: 'success',
    firmware: '10.6.0000',
    firmwareApproved: true,
    licence: 'Foundation',
    reconciliationIssue: false,
    localShell: false,
    serial: 'PHT5M520SZ',
  };
  const SW = { ...AP, name: 'sw-detail-1', model: 'CX 6300', type: 'switch', serial: 'SG30LMR164' };
  const NO_SERIAL = { ...AP, name: 'ap-no-serial', serial: undefined };

  const MAC = '3C:A9:AB:7C:A9:51';
  const CLIENT = {
    name: 'cam-front-door',
    model: 'AXIS P32',
    type: 'unknown',
    mac: MAC,
    ip: '10.1.4.7',
    medium: 'wireless',
    siteId: 'campus-01',
    siteName: 'Campus-01 — Meridian HQ',
    group: '—',
    attach: 'MRDN-Corp',
    where: 'ap-detail-1 · radio 1',
    plane: 'CENTRAL',
    planeTone: 'accent',
    auth: 'psk',
    authBy: '—',
    role: '—',
    vlan: '110',
    health: 'good',
    healthTone: 'success',
    session: '3h',
    problem: false,
    link: 'up',
    rssi: '—',
    snr: '—',
    retries: '—',
    tput: '—',
    roams: '—',
    quality: null,
    zone: '—',
    closet: '—',
  };

  const source = (sections: Record<string, string>) => ({
    plane: 'central',
    at: new Date().toISOString(),
    sections,
  });

  const GRAPH = (siteId: string) => ({
    siteId,
    nodes: [
      { serial: 'SG30LMR164', name: 'sw-detail-1', type: 'Switch', deviceFunction: 'Access Switch', status: 'ONLINE', health: 'Good', healthReason: 'DEVICE_STATUS', model: 'CX 6300', ipv4: '10.1.0.2', mac: null },
      { serial: 'PHT5M520SZ', name: 'ap-detail-1', type: 'Access Point', deviceFunction: 'Campus Access Point', status: 'ONLINE', health: 'Good', healthReason: 'DEVICE_STATUS', model: 'AP-735', ipv4: '10.1.4.3', mac: null },
    ],
    links: [
      {
        from: 'PHT5M520SZ',
        to: 'SG30LMR164',
        fromPorts: [{ name: 'eth0' }],
        toPorts: [{ name: '1/1/12' }],
        speedBps: 5000000000,
        health: 'Good',
      },
    ],
    source: source({ nodes: 'ok', links: 'ok' }),
  });

  /** Attach stub methods to a plane's LIVE adapter instance and register the
   *  teardown, so a test never leaves a capability behind for the next one. */
  function stub(plane: string, methods: Record<string, unknown>): void {
    const adapter = planes.get(plane);
    const keys = Object.keys(methods);
    for (const k of keys) adapter[k] = methods[k];
    undo.push(() => {
      for (const k of keys) delete adapter[k];
    });
  }

  beforeAll(async () => {
    const { poller } = await import('../src/services/poller');
    const { registry } = await import('../src/planes/registry');
    const screens = await import('../src/routes/screens');
    contributions = (poller as unknown as { contributions: Map<string, unknown> }).contributions;
    planes = registry as unknown as { get(id: string): Record<string, unknown> };
    clearDetailCache = screens.resetDetailCache;
    await setDemoMode(false);
  });

  afterEach(() => {
    while (undo.length > 0) undo.pop()!();
    contributions.clear();
    // The TTL cache is process-wide by design — one drawer open must not be
    // paid for twice. Tests must not inherit each other's cached answers.
    clearDetailCache();
  });

  afterAll(async () => {
    contributions.clear();
    await setDemoMode(true);
  });

  it('the polled clients list issues no per-object read at all', async () => {
    contributions.set('central', { clients: [CLIENT] });
    let calls = 0;
    stub('central', {
      clientDetail: async () => {
        calls += 1;
        return null;
      },
    });
    const { status, body } = await getJson('/api/clients');
    expect(status).toBe(200);
    expect(body.clients).toHaveLength(1);
    // The clients screen refreshes on the poll interval. If a request that
    // names no client still cost a per-object call, one open screen would be
    // 1440 calls a day on its own — the regression this whole path avoids.
    expect(calls).toBe(0);
    expect(body.detail).toBeUndefined();
    expect(body.topology).toBeUndefined();
  });

  it('naming one client opens the detail path and serves what the plane answered', async () => {
    contributions.set('central', { clients: [CLIENT] });
    const asked: string[] = [];
    stub('central', {
      clientDetail: async (mac: string) => {
        asked.push(mac);
        return {
          mac,
          rssi: -58,
          roams: 0,
          roamsWindowSec: 86400,
          timeline: [],
          source: source({ rssi: 'ok', roams: 'empty', timeline: 'empty' }),
        };
      },
    });
    const { status, body } = await getJson(`/api/clients?mac=${encodeURIComponent(MAC)}`);
    expect(status).toBe(200);
    expect(asked).toEqual([MAC]); // exactly one object, the one being opened
    expect(body.client.mac).toBe(MAC);
    expect(body.detail.rssi).toBe(-58);
    // Zero roams for a stationary camera is a REAL answer: 'empty', which the
    // route passes through untouched. It is neither 'failed' nor 'not-fetched',
    // and it must never render as "no source".
    expect(body.detail.roams).toBe(0);
    expect(body.detail.source.sections.roams).toBe('empty');
    // The list rides along, so opening a drawer is still one request.
    expect(body.clients).toHaveLength(1);
  });

  it('the path form /api/clients/:mac serves the identical envelope', async () => {
    contributions.set('central', { clients: [CLIENT] });
    stub('central', {
      clientDetail: async (mac: string) => ({ mac, rssi: -58, source: source({ rssi: 'ok' }) }),
    });
    const query = await getJson(`/api/clients?mac=${encodeURIComponent(MAC)}`);
    clearDetailCache();
    const path = await getJson(`/api/clients/${encodeURIComponent(MAC)}`);
    expect(path.status).toBe(200);
    expect(path.body.detail.rssi).toBe(query.body.detail.rssi);
    expect(path.body.client.mac).toBe(query.body.client.mac);
    expect(path.body.clients).toEqual(query.body.clients);
  });

  it('a MAC that is not in the roster answers with the roster and no plane call', async () => {
    contributions.set('central', { clients: [CLIENT] });
    let calls = 0;
    stub('central', {
      clientDetail: async () => {
        calls += 1;
        return null;
      },
    });
    const { status, body } = await getJson('/api/clients/aa:bb:cc:dd:ee:ff');
    expect(status).toBe(200);
    // Not a 404: the roster IS the answer to "show me this session" — it is
    // current, and this MAC is not on it. Nothing is asked of the plane about
    // a client the portal has no row for.
    expect(body.client).toBeNull();
    expect(body.detail).toBeNull();
    expect(body.clients).toHaveLength(1);
    expect(calls).toBe(0);
  });

  it('a second open inside the TTL is served from cache, not a second plane call', async () => {
    contributions.set('central', { clients: [CLIENT] });
    let calls = 0;
    stub('central', {
      clientDetail: async (mac: string) => {
        calls += 1;
        return { mac, rssi: -58, source: source({ rssi: 'ok' }) };
      },
    });
    const first = await getJson(`/api/clients?mac=${encodeURIComponent(MAC)}`);
    const second = await getJson(`/api/clients?mac=${encodeURIComponent(MAC)}`);
    expect(calls).toBe(1);
    expect(first.body.detail.source.cached).toBeFalsy();
    // The second answer says it is cached rather than pretending to be a fresh
    // read — the drawer can date it honestly.
    expect(second.body.detail.source.cached).toBe(true);
    expect(second.body.detail.rssi).toBe(-58);
  });

  it('a read that breaks is reported as FAILED, not as nothing to report', async () => {
    contributions.set('central', { clients: [CLIENT] });
    stub('central', {
      clientDetail: async () => {
        throw new Error('central token refresh failed');
      },
    });
    const { status, body } = await getJson(`/api/clients?mac=${encodeURIComponent(MAC)}`);
    expect(status).toBe(200); // a detail read is an enhancement, never a 500
    expect(body.detail.source.sections).toEqual({
      rssi: 'failed',
      tput: 'failed',
      roams: 'failed',
      timeline: 'failed',
      usageSeries: 'failed',
    });
    expect(body.detail.source.note).toContain('central token refresh failed');
    // Nothing was invented to fill the gap.
    expect(body.detail.rssi).toBeUndefined();
    expect(body.detail.timeline).toBeUndefined();
  });

  it('a plane with no detail capability keeps the honest empty state', async () => {
    // 'classic' has no stored credentials here, so its adapter is the
    // unconfigured one — it claims no per-object capability at all.
    contributions.set('classic', { clients: [{ ...CLIENT, plane: 'CLASSIC', planeTone: 'info' }] });
    const { status, body } = await getJson(`/api/clients?mac=${encodeURIComponent(MAC)}`);
    expect(status).toBe(200);
    // null = "this plane cannot answer" — the screen keeps the empty state it
    // already had, and nothing claims the plane was asked and had nothing.
    expect(body.detail).toBeNull();
    expect(body.client.mac).toBe(MAC);
  });

  /**
   * SIGNAL / RETRIES / WIRING — the three drawer rows that are JOINS, not
   * fields.
   *
   * Central's Client schema carries no rssi and no retries: `retries` lives on
   * the AP RADIO, and the physical uplink lives on the site graph. These cover
   * the joins the route performs after the client read, and — just as much —
   * what it refuses to invent when a join does not land.
   */
  const WIFI = {
    ...CLIENT,
    mac: '00:23:A7:3D:A0:42',
    attach: 'ap-detail-1', // the AP NAME — the client row carries no serial
    link: '2.4 GHz · 6 (20 MHz)',
    snr: '48 dB',
  };
  const WIRED = {
    ...CLIENT,
    mac: '2C:F0:5D:A1:AA:5F',
    medium: 'wired',
    attach: 'sw-detail-1',
    where: '1/1/18',
    link: '—',
    snr: '—',
  };
  /** Both radios of the attached AP: the client is on 2.4 GHz channel 6, so
   *  0.51 is its retry figure and 2.39 belongs to the other radio. */
  const RADIOS = [
    { number: 0, band: '5 GHz', channel: '40E', noiseFloorDbm: -97, retries: 2.39, channelQuality: 99, channelUtilPct: 4, clients: 0 },
    { number: 1, band: '2.4 GHz', channel: '6', noiseFloorDbm: -97, retries: 0.51, channelQuality: 98, channelUtilPct: 11, clients: 5 },
  ];
  const wifiDrawer = (mac: string) => getJson(`/api/clients?mac=${encodeURIComponent(mac)}`);

  it('RETRIES comes from the radio the client is actually on, never the AP’s other radio', async () => {
    contributions.set('central', { devices: [AP, SW], clients: [WIFI] });
    const asked: Array<[string, string]> = [];
    stub('central', {
      clientDetail: async (mac: string) => ({ mac, rssi: null, source: source({ rssi: 'empty' }) }),
      deviceDetail: async (serial: string, kind: string) => {
        asked.push([serial, kind]);
        return { serial, kind, radios: RADIOS, source: source({ radios: 'ok' }) };
      },
      siteTopology: async (siteId: string) => GRAPH(siteId),
    });
    const { status, body } = await wifiDrawer(WIFI.mac);
    expect(status).toBe(200);
    // The client row names an AP, not a serial — the roster supplies the key.
    expect(asked).toEqual([['PHT5M520SZ', 'ap']]);
    expect(body.detail.servingRadio.radioNumber).toBe(1);
    expect(body.detail.servingRadio.retries).toBe(0.51); // NOT the 5 GHz radio's 2.39
    expect(body.detail.servingRadio.noiseFloorDbm).toBe(-97);
    expect(body.detail.servingRadio.apName).toBe('ap-detail-1');
    expect(body.detail.source.sections.servingRadio).toBe('ok');
  });

  it('SIGNAL is derived from snr + the serving radio’s noise floor, and a reported rssi wins', async () => {
    contributions.set('central', { devices: [AP, SW], clients: [WIFI] });
    stub('central', {
      clientDetail: async (mac: string) => ({ mac, rssi: null, source: source({ rssi: 'empty' }) }),
      deviceDetail: async (serial: string, kind: string) => ({ serial, kind, radios: RADIOS, source: source({ radios: 'ok' }) }),
      siteTopology: async (siteId: string) => GRAPH(siteId),
    });
    const derived = await wifiDrawer(WIFI.mac);
    // 48 dB over a -97 dBm floor. Arithmetic, not a plane reading — which is
    // why the section still says the PLANE reported none: 'empty' beside a
    // number is how the drawer knows to label it derived.
    expect(derived.body.detail.rssi).toBe(-49);
    expect(derived.body.detail.source.sections.rssi).toBe('empty');

    clearDetailCache();
    while (undo.length > 0) undo.pop()!();
    stub('central', {
      // A roam gives the mobility trail a real per-client rssi.
      clientDetail: async (mac: string) => ({ mac, rssi: -58, source: source({ rssi: 'ok' }) }),
      deviceDetail: async (serial: string, kind: string) => ({ serial, kind, radios: RADIOS, source: source({ radios: 'ok' }) }),
      siteTopology: async (siteId: string) => GRAPH(siteId),
    });
    const reported = await wifiDrawer(WIFI.mac);
    // A reading is never overwritten with a derivation.
    expect(reported.body.detail.rssi).toBe(-58);
    expect(reported.body.detail.source.sections.rssi).toBe('ok');
  });

  it('WIRING reads the SWITCH end of the AP uplink, whichever end of the link the AP is on', async () => {
    contributions.set('central', { devices: [AP, SW], clients: [WIFI] });
    const graph = GRAPH('campus-01');
    stub('central', {
      clientDetail: async (mac: string) => ({ mac, source: source({ rssi: 'empty' }) }),
      deviceDetail: async (serial: string, kind: string) => ({ serial, kind, radios: RADIOS, source: source({ radios: 'ok' }) }),
      siteTopology: async () => graph,
    });
    const apFirst = await wifiDrawer(WIFI.mac);
    expect(apFirst.body.detail.wiring).toMatchObject({
      apSerial: 'PHT5M520SZ',
      switchName: 'sw-detail-1',
      switchSerial: 'SG30LMR164',
      port: '1/1/12', // the SWITCH's port, not the AP's 'eth0'
    });
    expect(apFirst.body.detail.source.sections.wiring).toBe('ok');

    // Central draws the link FROM the switch, so live graphs arrive the other
    // way round. Same cable, same answer — the port must still be the switch's.
    clearDetailCache();
    graph.links = [
      {
        from: 'SG30LMR164',
        to: 'PHT5M520SZ',
        fromPorts: [{ name: '1/1/8' }],
        toPorts: [{ name: 'eth0' }],
        speedBps: 2500000000,
        health: 'Good',
      },
    ];
    const switchFirst = await wifiDrawer(WIFI.mac);
    expect(switchFirst.body.detail.wiring.port).toBe('1/1/8');
    expect(switchFirst.body.detail.wiring.switchName).toBe('sw-detail-1');
  });

  it('a wired session is asked for no radio at all and gets no wireless joins', async () => {
    contributions.set('central', { devices: [AP, SW], clients: [WIRED] });
    let radioCalls = 0;
    let requestedMedium: 'wired' | 'wireless' | undefined;
    stub('central', {
      clientDetail: async (mac: string, medium?: 'wired' | 'wireless') => {
        requestedMedium = medium;
        return { mac, source: source({}) };
      },
      deviceDetail: async (serial: string, kind: string) => {
        radioCalls += 1;
        return { serial, kind, radios: RADIOS, source: source({ radios: 'ok' }) };
      },
      siteTopology: async (siteId: string) => GRAPH(siteId),
    });
    const { status, body } = await wifiDrawer(WIRED.mac);
    expect(status).toBe(200);
    // A wired client has no serving radio, and its switch port is on its own
    // row (attach + where) — there is no hop to join and no call to spend.
    expect(requestedMedium).toBe('wired');
    expect(radioCalls).toBe(0);
    expect(body.detail.servingRadio).toBeUndefined();
    expect(body.detail.wiring).toBeUndefined();
    expect(body.detail.rssi).toBeUndefined();
    expect(body.detail.source.sections.servingRadio).toBeUndefined();
  });

  it('an unmatchable radio leaves SIGNAL and RETRIES blank instead of borrowing another radio’s', async () => {
    // The AP moved to a band this client is not on: no honest match exists.
    contributions.set('central', { devices: [AP, SW], clients: [WIFI] });
    stub('central', {
      clientDetail: async (mac: string) => ({ mac, rssi: null, source: source({ rssi: 'empty' }) }),
      deviceDetail: async (serial: string, kind: string) => ({
        serial,
        kind,
        radios: [
          { number: 0, band: '5 GHz', channel: '40E', noiseFloorDbm: -97, retries: 2.39 },
          { number: 2, band: '6 GHz', channel: '37', noiseFloorDbm: -96, retries: 1.1 },
        ],
        source: source({ radios: 'ok' }),
      }),
      siteTopology: async (siteId: string) => ({ ...GRAPH(siteId), links: [] }),
    });
    const { body } = await wifiDrawer(WIFI.mac);
    expect(body.detail.servingRadio).toBeUndefined();
    // 'empty' = we asked and no radio matched. Nothing was borrowed from the
    // 5 GHz radio, so the signal row stays as blank as it was.
    expect(body.detail.source.sections.servingRadio).toBe('empty');
    expect(body.detail.rssi).toBeNull();
    // A graph that carries no link for this AP says so, and invents no path.
    expect(body.detail.wiring).toBeUndefined();
    expect(body.detail.source.sections.wiring).toBe('empty');
  });

  it('a device page reads that ONE device, asking only for the subresources its kind has', async () => {
    contributions.set('central', { devices: [AP, SW] });
    const asked: Array<[string, string]> = [];
    stub('central', {
      deviceDetail: async (serial: string, kind: string) => {
        asked.push([serial, kind]);
        return {
          serial,
          kind,
          radios: [{ number: 0, band: '5 GHz', channel: '157E', retries: 3 }],
          wlans: [],
          source: source({ radios: 'ok', wlans: 'empty' }),
        };
      },
      siteTopology: async () => null, // the graph is a separate test
    });
    const { status, body } = await getJson('/api/devices/ap-detail-1');
    expect(status).toBe(200);
    // One device, not the estate — and an AP is never asked for switch ports.
    expect(asked).toEqual([['PHT5M520SZ', 'ap']]);
    expect(body.detail.radios[0].channel).toBe('157E');
    expect(body.detail.source.sections.wlans).toBe('empty');
    expect(body.device.name).toBe('ap-detail-1');
  });

  it('a switch is asked as a switch, and a row with no serial is not asked about at all', async () => {
    contributions.set('central', { devices: [SW, NO_SERIAL] });
    const asked: Array<[string, string]> = [];
    stub('central', {
      deviceDetail: async (serial: string, kind: string) => {
        asked.push([serial, kind]);
        return { serial, kind, ports: [], source: source({ ports: 'empty' }) };
      },
      siteTopology: async () => null, // the graph is a separate test
    });
    const sw = await getJson('/api/devices/sw-detail-1');
    expect(sw.status).toBe(200);
    expect(asked).toEqual([['SG30LMR164', 'switch']]);
    const bare = await getJson('/api/devices/ap-no-serial');
    expect(bare.status).toBe(200);
    // No serial = no key to ask about. Guessing one would spend a call on a
    // certain 404 and could name another device's radios.
    expect(bare.body.detail).toBeNull();
    expect(asked).toHaveLength(1);
  });

  // -- Duplicate display name identity (fix-device-detail-identity) -------
  //
  // Reconciliation keys on serial first (services/reconcile.ts identityKey),
  // NOT name, so two planes each claiming a physically distinct device under
  // the SAME display name reconcile to TWO rows, not one. `/api/devices/:name`
  // used to `.find` the first row with that name — these tests prove the
  // route now resolves the exact plane+serial pair a row link carries, and
  // refuses to guess when a bare name cannot tell the two apart.
  describe('duplicate display names resolve by plane+serial, never by first match', () => {
    const DUP_CENTRAL = { ...AP, name: 'ap-dup', serial: 'DUP-CENTRAL-001' };
    const DUP_MIST = { ...AP, name: 'ap-dup', serial: 'DUP-MIST-002', plane: 'MIST', planeTone: 'info' };

    function seedDuplicates(): void {
      contributions.set('central', { devices: [DUP_CENTRAL] });
      contributions.set('mist', { devices: [DUP_MIST] });
    }

    it('a serial query resolves its own row even though the name is shared', async () => {
      seedDuplicates();
      const central = await getJson('/api/devices/ap-dup?serial=DUP-CENTRAL-001');
      expect(central.status).toBe(200);
      expect(central.body.device.plane).toBe('CENTRAL');
      expect(central.body.device.serial).toBe('DUP-CENTRAL-001');

      const mist = await getJson('/api/devices/ap-dup?serial=DUP-MIST-002');
      expect(mist.status).toBe(200);
      expect(mist.body.device.plane).toBe('MIST');
      expect(mist.body.device.serial).toBe('DUP-MIST-002');
    });

    it('diagnostics eligibility targets the exact serial the resolved row carries', async () => {
      seedDuplicates();
      const central = await getJson('/api/devices/ap-dup?serial=DUP-CENTRAL-001');
      const mist = await getJson('/api/devices/ap-dup?serial=DUP-MIST-002');
      // Same name on both rows — the field DiagnosticsPanel keys eligibility
      // and audit matching on (plane+serial) must still point at two
      // different physical devices.
      expect(central.body.device.name).toBe(mist.body.device.name);
      expect([central.body.device.plane, central.body.device.serial]).not.toEqual([
        mist.body.device.plane,
        mist.body.device.serial,
      ]);
    });

    it('a plane query narrows an otherwise-ambiguous name when that alone is unique', async () => {
      seedDuplicates();
      const byPlane = await getJson('/api/devices/ap-dup?plane=MIST');
      expect(byPlane.status).toBe(200);
      expect(byPlane.body.device.serial).toBe('DUP-MIST-002');
    });

    it('a bare duplicate name is rejected honestly, never resolved to whichever row sorts first', async () => {
      seedDuplicates();
      const { status, body } = await getJson('/api/devices/ap-dup');
      expect(status).toBe(409);
      expect(body.error).toMatch(/ap-dup/);
      expect(body.error).toMatch(/plane and serial/i);
      const serials = (body.candidates as any[]).map((c) => c.serial).sort();
      expect(serials).toEqual(['DUP-CENTRAL-001', 'DUP-MIST-002']);
    });

    it('a unique legacy name-only link still resolves — backward compatibility is real, not assumed', async () => {
      contributions.set('central', { devices: [AP, SW] });
      const { status, body } = await getJson('/api/devices/ap-detail-1');
      expect(status).toBe(200);
      expect(body.device.serial).toBe('PHT5M520SZ');
    });

    it('an unknown serial 404s rather than falling back to a name match', async () => {
      seedDuplicates();
      const { status, body } = await getJson('/api/devices/ap-dup?serial=NO-SUCH-SERIAL');
      expect(status).toBe(404);
      expect(body.error).toBeDefined();
    });

    it('a plane query matches a double-claimed row by ANY claiming plane, not just its display plane', async () => {
      // sw-both is claimed by both CENTRAL and CLASSIC — reconciliation picks
      // CENTRAL (higher priority) for the display `plane` field, but the row
      // still carries CLASSIC in `claimedBy`. A second, unrelated device
      // shares the name from MIST, making the bare name ambiguous.
      contributions.set('central', { devices: [{ ...AP, name: 'sw-both', serial: 'SHARED-SN' }] });
      contributions.set('classic', {
        devices: [{ ...AP, name: 'sw-both', serial: 'SHARED-SN', plane: 'CLASSIC', planeTone: 'warning' }],
      });
      contributions.set('mist', {
        devices: [{ ...AP, name: 'sw-both', serial: 'OTHER-MIST-SN', plane: 'MIST', planeTone: 'info' }],
      });
      const ambiguous = await getJson('/api/devices/sw-both');
      expect(ambiguous.status).toBe(409);

      // ?plane=CLASSIC is NOT the merged row's display plane (CENTRAL outranks
      // CLASSIC), yet it still resolves — claimedBy, not just `plane`, is
      // consulted.
      const byPlane = await getJson('/api/devices/sw-both?plane=CLASSIC');
      expect(byPlane.status).toBe(200);
      expect(byPlane.body.device.serial).toBe('SHARED-SN');
      expect(byPlane.body.device.plane).toBe('CENTRAL');
      expect(byPlane.body.device.claimedBy).toEqual(expect.arrayContaining(['CENTRAL', 'CLASSIC']));
      contributions.delete('classic');
      contributions.delete('mist');
    });
  });

  it('a live site page carries the plane link graph and leaves the collector panel alone', async () => {
    contributions.set('central', { devices: [AP, SW] });
    const asked: string[] = [];
    stub('central', {
      siteTopology: async (siteId: string) => {
        asked.push(siteId);
        return GRAPH(siteId);
      },
    });
    const { status, body } = await getJson('/api/sites/campus-01');
    expect(status).toBe(200);
    // The wiring fact the flat lists cannot carry: this AP hangs off that
    // switch port.
    expect(body.topology.links[0].toPorts[0].name).toBe('1/1/12');
    expect(body.topology.source.sections.links).toBe('ok');
    // SiteReachability is a statement about the LOCAL collector. A cloud
    // plane's graph must not be laundered into it — that would credit a claim
    // the collector never made.
    expect(body.reachability.collector).toBe('not linked');
    // screens.ts holds no plane site id: central.ts mints the portal id from
    // the site NAME and keeps no id of its own, so the name is the join key
    // and the adapter owns the name -> id resolution.
    expect(asked).toEqual(['Campus-01 — Meridian HQ']);
  });

  it('preserves authoritative empty and failed site topology outcomes', async () => {
    contributions.set('central', { devices: [AP, SW] });
    stub('central', {
      siteTopology: async (siteId: string) => ({
        siteId,
        nodes: [],
        links: [],
        source: source({ nodes: 'empty', links: 'empty' }),
      }),
    });
    const empty = await getJson('/api/sites/campus-01');
    expect(empty.status).toBe(200);
    expect(empty.body.topology.nodes).toEqual([]);
    expect(empty.body.topology.links).toEqual([]);
    expect(empty.body.topology.source.sections).toEqual({ nodes: 'empty', links: 'empty' });

    clearDetailCache();
    while (undo.length > 0) undo.pop()!();
    stub('central', {
      siteTopology: async () => {
        throw new Error('central topology unavailable');
      },
    });
    const failed = await getJson('/api/sites/campus-01');
    expect(failed.status).toBe(200);
    expect(failed.body.topology.nodes).toBeUndefined();
    expect(failed.body.topology.links).toBeUndefined();
    expect(failed.body.topology.source.sections).toEqual({ nodes: 'failed', links: 'failed' });
    expect(failed.body.topology.source.note).toContain('central topology unavailable');
  });

  it('the site graph is read once and shared by the site page, the device page and the client drawer', async () => {
    contributions.set('central', { devices: [AP, SW], clients: [CLIENT] });
    let calls = 0;
    stub('central', {
      siteTopology: async (siteId: string) => {
        calls += 1;
        return GRAPH(siteId);
      },
    });
    const site = await getJson('/api/sites/campus-01');
    const device = await getJson('/api/devices/ap-detail-1');
    const client = await getJson(`/api/clients?mac=${encodeURIComponent(MAC)}`);
    expect(site.body.topology.links).toHaveLength(1);
    expect(device.body.topology.links).toHaveLength(1);
    expect(client.body.topology.links).toHaveLength(1);
    expect(site.body.topology.source.cached).toBeFalsy();
    expect(device.body.topology.source.cached).toBe(true);
    expect(client.body.topology.source.cached).toBe(true);
    // Three pages, one call. Without the shared cache this is three per open.
    expect(calls).toBe(1);
  });

  it('a plane at its stored daily call budget is not called, and the payload says why', async () => {
    const saved = await fetch(`${base}/api/systems/classic/credentials`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ host: 'airwave-01.meridian.health', callBudget: '0' }),
    });
    expect(saved.status).toBe(200);
    try {
      // Saved credentials clear that plane's contributions, so seed after.
      contributions.set('classic', { clients: [{ ...CLIENT, plane: 'CLASSIC', planeTone: 'info' }] });
      let calls = 0;
      stub('classic', {
        clientDetail: async () => {
          calls += 1;
          return null;
        },
      });
      const { status, body } = await getJson(`/api/clients?mac=${encodeURIComponent(MAC)}`);
      expect(status).toBe(200);
      expect(calls).toBe(0);
      // Nothing attempted — an empty `sections` map is 'not-fetched' for every
      // section, which is the truth: we chose not to spend the call.
      expect(body.detail.source.sections).toEqual({});
      expect(body.detail.source.note).toContain('daily call budget');
    } finally {
      await fetch(`${base}/api/systems/classic`, { method: 'DELETE' });
    }
  });

  it('demo mode names a client without spending a plane call', async () => {
    await setDemoMode(true);
    try {
      let calls = 0;
      stub('central', {
        clientDetail: async () => {
          calls += 1;
          return null;
        },
      });
      const { status, body } = await getJson(`/api/clients?mac=${encodeURIComponent(MAC)}`);
      expect(status).toBe(200);
      expect(body.dataSource).toBe('demo');
      // Demo rows are authored and complete; there is no live object behind a
      // fixture MAC to read, and the payload is exactly what it always was.
      expect(calls).toBe(0);
      expect(body.detail).toBeUndefined();
      expect(body.client).toBeUndefined();
      expect((body.clients as any[]).length).toBeGreaterThan(0);
    } finally {
      await setDemoMode(false);
    }
  });
});

/**
 * The listener must stay off the network by default. This portal brokers
 * production configuration changes and bridges SSH to switches while having no
 * authentication of its own, so a default of 0.0.0.0 would publish that
 * surface to every host that can route to the box.
 */
describe('bind host safety', () => {
  it('treats every loopback spelling as off-network', async () => {
    const { isLoopbackHost } = await import('../src/index');
    for (const host of ['127.0.0.1', 'localhost', 'LOCALHOST', '::1', '[::1]', '127.0.1.1']) {
      expect(isLoopbackHost(host)).toBe(true);
    }
  });

  it('treats a routable bind as on-network so it can be warned about', async () => {
    const { isLoopbackHost } = await import('../src/index');
    for (const host of ['0.0.0.0', '10.0.0.5', '192.168.1.20', '::']) {
      expect(isLoopbackHost(host)).toBe(false);
    }
  });
});
