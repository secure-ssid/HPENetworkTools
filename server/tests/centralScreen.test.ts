/**
 * server/tests/centralScreen.test.ts — GET /api/central, the Central plane
 * screen's one payload.
 *
 * In-process app on an ephemeral port (the routes.test.ts pattern):
 * HPE_SETTINGS_PATH points at a tmp dir, demo mode is toggled through the
 * settings route, and the poller's contributions are seeded by hand for the
 * live-mode cases.
 *
 * Covered:
 *  (a) demo mode composes the authored estate's CENTRAL slice — plane
 *      status off the SYSTEMS row, fleet/sites/clients/alerts/WLANs off the
 *      fixtures, no notReported key (everything reported);
 *  (b) the demo alert queue is cut to CENTRAL and severity/age-sorted;
 *  (c) live mode composes from the central plane's OWN contribution
 *      (devices/clients/alerts/sites/config), carries the registry plane
 *      status verbatim, and names every dataset the pull did not carry in
 *      notReported — with the tiles over those datasets reading '—' rather
 *      than a zero the plane never claimed;
 *  (d) the firmware section is the plane's own verdict: behind-train rows
 *      carry the recommended train and the plane's upgrade word, approved
 *      rows stay out;
 *  (e) live stats derive health per site from known-state devices only.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let server: Server;
let base: string;
let tmpDir: string;
let contributions: Map<string, unknown>;

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'hpe-central-screen-'));
  process.env.HPE_SETTINGS_PATH = join(tmpDir, 'settings.json');
  process.env.HPE_DATA_DIR = join(tmpDir, 'data');
  const { createApp } = await import('../src/index');
  server = createApp().listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const { poller } = await import('../src/services/poller');
  contributions = (poller as unknown as { contributions: Map<string, unknown> }).contributions;
});

afterAll(async () => {
  contributions.clear();
  await fetch(`${base}/api/settings`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ demoMode: true }),
  });
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.HPE_SETTINGS_PATH;
  delete process.env.HPE_DATA_DIR;
});

async function getJson(path: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${path}`);
  return { status: res.status, body: await res.json() };
}

async function setDemoMode(demoMode: boolean): Promise<void> {
  await fetch(`${base}/api/settings`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ demoMode }),
  });
}

const DEVICE_UP = {
  name: 'ap-c-01',
  model: 'AP-635',
  type: 'ap',
  siteId: 'campus-01',
  siteName: 'Campus-01 — Meridian HQ',
  plane: 'CENTRAL',
  planeTone: 'accent',
  state: 'up',
  stateTone: 'success',
  firmware: '10.6.0.2',
  firmwareApproved: true,
  licence: 'Foundation',
  reconciliationIssue: false,
  localShell: false,
};

const DEVICE_BEHIND = {
  ...DEVICE_UP,
  name: 'sw-c-02',
  model: 'CX 6300M',
  type: 'switch',
  serial: 'SG00C0MM02',
  state: 'down',
  stateTone: 'danger',
  firmware: '10.6.0.1',
  firmwareApproved: false,
  firmwareTarget: '10.6.0.3',
  firmwareUpdate: 'inprogress',
};

const CLIENT = {
  name: 'm.central',
  model: 'MacBook Pro',
  type: 'laptop',
  mac: 'aa:bb:cc:dd:ee:01',
  ip: '10.42.14.99',
  medium: 'wireless',
  siteId: 'campus-01',
  siteName: 'Campus-01 — Meridian HQ',
  group: 'staff-wireless',
  attach: 'MRDN-Staff',
  where: 'ap-c-01 · radio 1',
  plane: 'CENTRAL',
  planeTone: 'accent',
  auth: 'dot1x',
  authBy: 'clearpass',
  role: 'employee',
  vlan: 'vlan 820',
  health: 'good',
  healthTone: 'success',
  session: '1h',
  problem: false,
  link: 'up',
  rssi: '-50',
  snr: '40',
  retries: '1%',
  tput: '400 Mb',
  roams: '0',
  quality: 90,
  zone: '3rd floor',
  closet: 'IDF-3',
};

const ALERT = {
  sev: 'P2',
  tone: 'warning',
  title: 'AP CPU high',
  detail: 'ap-c-01 over 90% for 15m',
  siteId: 'campus-01',
  siteName: 'Campus-01 — Meridian HQ',
  plane: 'CENTRAL',
  state: 'open',
  age: '15m',
  device: 'ap-c-01',
};

const SITE = {
  id: 'campus-01',
  name: 'Campus-01 — Meridian HQ',
  subnet: '—',
  planes: [{ name: 'CENTRAL', tone: 'accent' }],
  mix: '—',
  devices: 2,
  clients: '1',
  health: null,
  healthPct: '—',
  tone: 'stale',
  alerts: '—',
  alertTone: 'neutral',
  sync: '—',
};

const WLAN = {
  kind: 'ssid',
  name: 'MRDN-Staff',
  vlan: 'vlan 820',
  security: 'WPA3-Enterprise',
  targets: 'staff-wireless · 2 APs',
  plane: 'CENTRAL',
  tone: 'accent',
};

describe('GET /api/central — demo mode', () => {
  it('composes the authored estate’s CENTRAL slice', async () => {
    await setDemoMode(true);
    const { status, body } = await getJson('/api/central');
    expect(status).toBe(200);
    expect(body.dataSource).toBe('demo');
    expect(Number.isNaN(Date.parse(body.syncedAt))).toBe(false);

    // The plane status reads the authored SYSTEMS row, not a registry guess.
    expect(body.plane).toEqual({
      linked: true,
      health: 'healthy',
      tone: 'success',
      lastSync: '2026-07-26T11:59:00.000Z',
      note: null,
    });

    // Fleet: the demo estate's two Central APs, both up.
    expect(body.fleet.total).toBe(2);
    expect(body.fleet.byType).toEqual({ ap: 2 });
    expect(body.fleet.byState).toEqual({ up: 2 });

    // The one Central-badged site, with the plane's own counts.
    expect(body.sites).toHaveLength(1);
    expect(body.sites[0]).toEqual({
      siteId: 'campus-01',
      siteName: 'Campus-01 HQ',
      devices: 2,
      clients: 4,
      healthPct: 100,
      openAlerts: 2,
    });

    // Both Central APs are on their approved train — a real empty answer.
    expect(body.firmware).toEqual([]);

    // The three WLANs whose scope list names Central.
    expect(body.wlans.map((w: { name: string }) => w.name)).toEqual([
      'MRDN-Staff',
      'MRDN-Guest',
      'MRDN-IoT',
    ]);

    // Everything reported: the key stays absent rather than listing nothing.
    expect('notReported' in body).toBe(false);
  });

  it('cuts the demo alert queue to CENTRAL, severity/age-sorted, and counts it in the tiles', async () => {
    await setDemoMode(true);
    const { body } = await getJson('/api/central');
    expect(body.alerts.length).toBe(2);
    expect(body.alerts.every((a: { plane: string }) => a.plane === 'CENTRAL')).toBe(true);
    // Oldest unresolved first within the severity (compareAlerts) — 20m leads 9m.
    expect(body.alerts[0].age).toBe('20m');
    expect(body.alerts[1].age).toBe('9m');
    const openAlertsTile = body.stats.find((s: { label: string }) => s.label === 'Open alerts');
    expect(openAlertsTile.value).toBe('2');
  });
});

describe('GET /api/central — live mode', () => {
  beforeAll(async () => {
    await setDemoMode(false);
  });

  it('composes from the central contribution and passes the registry status through', async () => {
    contributions.set('central', {
      devices: [DEVICE_UP, DEVICE_BEHIND],
      clients: [CLIENT],
      alerts: [ALERT],
      sites: [SITE],
      config: { mode: 'configured', ssids: [WLAN] },
    });
    try {
      const { status, body } = await getJson('/api/central');
      expect(status).toBe(200);
      expect(body.dataSource).toBe('live');
      // The registry's own words — never polled, never linked in this test env.
      expect(body.plane.linked).toBe(false);
      expect(body.plane.health).toBe('unlinked');
      expect(body.plane.lastSync).toBeNull();

      expect(body.fleet.total).toBe(2);
      expect(body.fleet.byType).toEqual({ ap: 1, switch: 1 });
      expect(body.fleet.byState).toEqual({ up: 1, down: 1 });

      expect(body.sites).toEqual([
        {
          siteId: 'campus-01',
          siteName: 'Campus-01 — Meridian HQ',
          devices: 2,
          clients: 1,
          healthPct: 50,
          openAlerts: 1,
        },
      ]);

      expect(body.wlans).toEqual([WLAN]);
      expect(body.alerts).toHaveLength(1);
      expect(body.notReported).toEqual([]);
    } finally {
      contributions.delete('central');
    }
  });

  it('carries the firmware verdict with the recommended train and the plane’s upgrade word', async () => {
    contributions.set('central', { devices: [DEVICE_UP, DEVICE_BEHIND] });
    try {
      const { body } = await getJson('/api/central');
      expect(body.firmware).toEqual([
        {
          name: 'sw-c-02',
          model: 'CX 6300M',
          type: 'switch',
          siteId: 'campus-01',
          siteName: 'Campus-01 — Meridian HQ',
          serial: 'SG00C0MM02',
          firmware: '10.6.0.1',
          target: '10.6.0.3',
          update: 'inprogress',
        },
      ]);
    } finally {
      contributions.delete('central');
    }
  });

  it('names every dataset a thin pull did not carry, and the tiles read — rather than a false zero', async () => {
    contributions.set('central', { devices: [] });
    try {
      const { body } = await getJson('/api/central');
      expect(body.notReported).toEqual(['sites', 'clients', 'alerts', 'wlans']);
      const tile = (label: string) =>
        body.stats.find((s: { label: string }) => s.label === label);
      // Devices WAS reported — a real empty inventory.
      expect(tile('Devices').value).toBe('0');
      expect(tile('Devices').delta).toBe('none in this plane’s inventory');
      // The rest was not: '—', never a claimed zero.
      expect(tile('Clients').value).toBe('—');
      expect(tile('Clients').delta).toBe('no client roster reported');
      expect(tile('Open alerts').value).toBe('—');
      expect(tile('Open alerts').delta).toBe('no alert feed reported');
      expect(tile('Sites').delta).toBe('sites of the reported rows only');
      // Null counts flow through the site rows too — no invented zeros.
      expect(body.sites).toEqual([]);
    } finally {
      contributions.delete('central');
    }
  });

  it('flags an absent device inventory on the Devices tile itself', async () => {
    contributions.set('central', { clients: [CLIENT], alerts: [ALERT] });
    try {
      const { body } = await getJson('/api/central');
      expect(body.notReported).toContain('devices');
      const devicesTile = body.stats.find((s: { label: string }) => s.label === 'Devices');
      expect(devicesTile.value).toBe('—');
      expect(devicesTile.delta).toBe('no device inventory reported');
      // A site named by a reported client, with no devices to verify: null
      // health, never a fabricated percentage.
      expect(body.sites).toHaveLength(1);
      expect(body.sites[0].healthPct).toBeNull();
      expect(body.sites[0].devices).toBe(0);
      expect(body.sites[0].openAlerts).toBe(1);
      expect(body.sites[0].clients).toBe(1);
    } finally {
      contributions.delete('central');
    }
  });
});
