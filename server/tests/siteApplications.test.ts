/**
 * server/tests/siteApplications.test.ts — the on-demand Central DPI
 * applications route, in both modes.
 *
 * Same harness as siteDetailMist.test.ts: an in-process app on an ephemeral
 * port with settings/data redirected to a tmp dir; live tests seed the
 * poller's contributions by hand and stub the Central adapter's lazy method.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

let server: Server;
let base: string;
let tmpDir: string;

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'hpe-site-apps-'));
  process.env.HPE_SETTINGS_PATH = join(tmpDir, 'settings.json');
  process.env.HPE_DATA_DIR = join(tmpDir, 'data');
  process.env.HPE_CREDENTIAL_INDEX_WAIT_MS = '0';
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
  delete process.env.HPE_CREDENTIAL_INDEX_WAIT_MS;
});

async function getJson(path: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${path}`);
  return { status: res.status, body: await res.json() };
}

describe('site applications route — demo mode', () => {
  it('GET /api/sites/campus-01/applications serves the authored DPI table, ranked and folded', async () => {
    const { status, body } = await getJson('/api/sites/campus-01/applications');
    expect(status).toBe(200);
    expect(body.dataSource).toBe('demo');

    const apps = body.applications;
    expect(apps.siteId).toBe('campus-01');
    expect(apps.window).toEqual({ start: '2026-07-25T12:00:00.000Z', end: '2026-07-26T12:00:00.000Z' });
    expect(apps.source).toMatchObject({ plane: 'central', sections: { apps: 'ok' } });

    // Ranked by total bytes desc, not by authored order; the risk words fold
    // into the portal's buckets while the plane's own word rides along.
    expect(apps.apps[0].name).toBe('Microsoft 365');
    expect(apps.apps.map((a: { name: string }) => a.name)).toContain('unknown-tcp-4410');
    const byName = Object.fromEntries(apps.apps.map((a: { name: string }) => [a.name, a]));
    expect(byName['BitTorrent']).toMatchObject({ risk: 'suspicious', riskRaw: 'high' });
    expect(byName['Tor']).toMatchObject({ risk: 'suspicious', riskRaw: 'very_high' });
    expect(byName['unknown-tcp-4410']).toMatchObject({ risk: 'moderate', riskRaw: 'medium' });
    expect(byName['Windows Update']).toMatchObject({ risk: 'trustworthy', riskRaw: 'safe' });
    // The plane reported NTP's presence but no byte counters — a null total
    // in the ranking, never a zero, and it sorts last.
    expect(apps.apps[apps.apps.length - 1]).toMatchObject({ name: 'NTP', totalBytes: null });
    // The verified dead fields arrive as nulls, never as data.
    expect(byName['Microsoft 365'].experience).toBeNull();
    expect(byName['Microsoft 365'].tlsVersion).toBeNull();
  });

  it('the demo route 404s a site the demo world did not author a table for', async () => {
    const { status, body } = await getJson('/api/sites/campus-02/applications');
    expect(status).toBe(404);
    expect(body.error).toContain("no application visibility recorded for 'campus-02'");
  });

  it('the demo route 404s an unknown site rather than fabricating one', async () => {
    const { status } = await getJson('/api/sites/no-such-place/applications');
    expect(status).toBe(404);
  });
});

describe('site applications route — live mode', () => {
  let contributions: Map<string, unknown>;
  let planes: { get(id: string): Record<string, unknown> };
  let clearDetailCache: () => void;
  const undo: Array<() => void> = [];

  const CENTRAL_SWITCH = {
    name: 'sw-live-1',
    model: 'CX 6300M',
    type: 'switch',
    siteId: 'campus-01',
    siteName: 'Campus-01 HQ',
    plane: 'CENTRAL',
    planeTone: 'accent',
    state: 'up',
    stateTone: 'success',
    firmware: '10.13.1005',
    firmwareApproved: true,
    licence: 'SUB-FND',
    reconciliationIssue: false,
    localShell: false,
    serial: 'SG30LMR164',
  };

  const LIVE_APPS = {
    siteId: 'Campus-01 HQ',
    window: { start: '2026-07-27T12:00:00.000Z', end: '2026-07-28T12:00:00.000Z' },
    apps: [
      {
        id: 'app-0365',
        name: 'Microsoft 365',
        riskRaw: 'trusted',
        risk: 'trustworthy',
        state: 'active',
        rxBytes: 4_230_000_000,
        txBytes: 810_000_000,
        totalBytes: 5_040_000_000,
        categories: ['Collaboration', 'Web'],
        applicationHostType: 'cloud',
        destLocation: ['US'],
        experience: null,
        lastUsedAt: '2026-07-28T11:59:00.000Z',
        tlsVersion: null,
        certificateExpiryAt: null,
      },
    ],
    source: { plane: 'central', at: new Date().toISOString(), sections: { apps: 'ok' } },
  };

  function stub(plane: string, methods: Record<string, unknown>): void {
    const adapter = planes.get(plane);
    const keys = Object.keys(methods);
    for (const k of keys) adapter[k] = methods[k];
    undo.push(() => {
      for (const k of keys) delete adapter[k];
    });
  }

  const setDemoMode = (demoMode: boolean) =>
    fetch(`${base}/api/settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ demoMode }),
    });

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
    clearDetailCache();
  });

  afterAll(async () => {
    contributions.clear();
    await setDemoMode(true);
  });

  it('calls the adapter once with the topology-style site key and serves the second open from the TTL cache', async () => {
    contributions.set('central', { devices: [CENTRAL_SWITCH] });
    const asked: [string, { start: string; end: string }][] = [];
    stub('central', {
      siteApplications: async (siteId: string, window: { start: string; end: string }) => {
        asked.push([siteId, window]);
        return LIVE_APPS;
      },
    });
    const first = await getJson('/api/sites/campus-01/applications?start=2026-07-27T12:00:00.000Z&end=2026-07-28T12:00:00.000Z');
    expect(first.status).toBe(200);
    expect(first.body.applications.apps[0].name).toBe('Microsoft 365');
    expect(first.body.applications.source.sections).toEqual({ apps: 'ok' });
    expect(first.body.applications.source.cached).toBeFalsy();

    const second = await getJson('/api/sites/campus-01/applications?start=2026-07-27T12:00:00.000Z&end=2026-07-28T12:00:00.000Z');
    expect(second.status).toBe(200);
    expect(second.body.applications.source.cached).toBe(true);
    // A non-numeric portal site id joins on the site NAME — the adapter owns
    // the native site-id resolution, same as siteTopology. The requested
    // window rides through verbatim.
    expect(asked).toEqual([
      ['Campus-01 — Meridian HQ', { start: '2026-07-27T12:00:00.000Z', end: '2026-07-28T12:00:00.000Z' }],
    ]);
  });

  it('defaults to a 24h window when the request names no bounds', async () => {
    contributions.set('central', { devices: [CENTRAL_SWITCH] });
    const asked: { start: string; end: string }[] = [];
    stub('central', {
      siteApplications: async (_siteId: string, window: { start: string; end: string }) => {
        asked.push(window);
        return LIVE_APPS;
      },
    });
    const { status } = await getJson('/api/sites/campus-01/applications');
    expect(status).toBe(200);
    expect(asked).toHaveLength(1);
    const span = Date.parse(asked[0]!.end) - Date.parse(asked[0]!.start);
    expect(span).toBe(24 * 60 * 60 * 1000);
  });

  it('an adapter read that throws becomes a failed payload with the note — never an empty table', async () => {
    contributions.set('central', { devices: [CENTRAL_SWITCH] });
    stub('central', {
      siteApplications: async () => {
        throw new Error('central dpi unavailable');
      },
    });
    const { status, body } = await getJson('/api/sites/campus-01/applications');
    expect(status).toBe(200);
    expect(body.applications.apps).toBeUndefined();
    expect(body.applications.source.sections).toEqual({ apps: 'failed' });
    expect(body.applications.source.note).toContain('central dpi unavailable');
  });

  it('an adapter without the capability is an honest null, and an unknown site is a 404', async () => {
    contributions.set('central', { devices: [CENTRAL_SWITCH] });
    const noCapability = await getJson('/api/sites/campus-01/applications');
    expect(noCapability.status).toBe(200);
    expect(noCapability.body.applications).toBeNull();

    const unknown = await getJson('/api/sites/no-such-place/applications');
    expect(unknown.status).toBe(404);
  });
});
