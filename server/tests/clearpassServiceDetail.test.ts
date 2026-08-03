/**
 * server/tests/clearpassServiceDetail.test.ts — the on-demand service detail
 * route (GET /api/clearpass/services/:id) behind the ClearPass screen's
 * Services-tab drawer, in all three modes: the authored fixture in demo, the
 * ClearPass adapter's read in live, and the blend rule (a live services
 * world is never served a fixture detail).
 *
 * Same harness as siteDetailMist.test.ts: an in-process app on an ephemeral
 * port with settings/data redirected to a tmp dir; live tests stub the
 * registry adapter's lazy method and seed the poller's contributions by hand.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { migrateLegacyPlaneRecord } from '@hpe/shared';

let server: Server;
let base: string;
let tmpDir: string;

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'hpe-cp-svc-detail-'));
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

const putSettings = (patch: Record<string, unknown>) =>
  fetch(`${base}/api/settings`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });

describe('GET /api/clearpass/services/:id — demo mode', () => {
  beforeAll(async () => {
    await putSettings({ demoMode: true, blendLive: false });
  });

  it('serves the authored fixture for a service the demo world recorded', async () => {
    const { status, body } = await getJson('/api/clearpass/services/svc-001');
    expect(status).toBe(200);
    expect(body.dataSource).toBe('demo');
    expect(body.serviceDetail.source).toMatchObject({ plane: 'clearpass', sections: { service: 'ok' } });
    expect(body.serviceDetail.service).toMatchObject({
      id: 'svc-001',
      name: 'MRDN Guest 802.1X',
      type: 'RADIUS',
      rulesMatchType: 'MATCHES_ALL',
      enforcementPolicy: 'MRDN Guest Portal Enforcement',
    });
    expect(body.serviceDetail.service.rulesConditions).toEqual([
      { type: 'Radius', name: 'Called-Station-Id', operator: 'CONTAINS', value: 'MRDN-Guest' },
    ]);
    // Nothing in a service definition is credential material — the route
    // serves the same whitelist the mapper enforces.
    expect(JSON.stringify(body.serviceDetail)).not.toMatch(/password|secret|hash/i);
  });

  it('404s a service the demo world did not author — never a fabricated detail', async () => {
    // svc-002 is a real collection row (the eduroam pilot) with no authored
    // detail object — the same honest 'not recorded' the SLE drill keeps.
    const { status, body } = await getJson('/api/clearpass/services/svc-002');
    expect(status).toBe(404);
    expect(body.error).toContain('svc-002');
  });
});

describe('GET /api/clearpass/services/:id — live and blend', () => {
  let contributions: Map<string, unknown>;
  let planes: { get(id: string): Record<string, unknown> };
  let clearDetailCache: () => void;
  const undo: Array<() => void> = [];

  function stub(plane: string, methods: Record<string, unknown>): void {
    const adapter = planes.get(plane);
    const keys = Object.keys(methods);
    for (const k of keys) adapter[k] = methods[k];
    undo.push(() => {
      for (const k of keys) delete adapter[k];
    });
  }

  const LIVE_SERVICE = {
    id: '4',
    name: 'Device Admin (TACACS+)',
    type: 'TACACS',
    template: 'TACACS+ Enforcement',
    enabled: true,
    hitCount: 96,
    orderNo: 8,
    description: 'switch shell',
    monitorMode: false,
    rulesMatchType: 'MATCHES_ALL',
    rulesConditions: [{ type: 'Connection', name: 'NAD-IP-Address', operator: 'EQUALS', value: '10.42.8.11' }],
    authMethods: ['TACACS+'],
    authSources: ['AD meridian.health', 'Local User Repository'],
    stripUsername: false,
    roleMappingPolicy: null,
    enforcementPolicy: 'Device Admin Enforcement',
    useCachedPolicyResults: false,
    postureEnabled: false,
    auditEnabled: true,
    profilerEnabled: false,
    acctProxyEnabled: false,
  };

  const livePayload = (id: string) => ({
    service: { ...LIVE_SERVICE, id },
    source: { plane: 'clearpass', at: new Date().toISOString(), sections: { service: 'ok' } },
  });

  beforeAll(async () => {
    const { poller } = await import('../src/services/poller');
    const { registry } = await import('../src/planes/registry');
    const screens = await import('../src/routes/screens');
    contributions = (poller as unknown as { contributions: Map<string, unknown> }).contributions;
    planes = registry as unknown as { get(id: string): Record<string, unknown> };
    clearDetailCache = screens.resetDetailCache;
    await putSettings({ demoMode: false, blendLive: false });
  });

  afterEach(async () => {
    while (undo.length > 0) undo.pop()!();
    contributions.clear();
    clearDetailCache();
    await putSettings({ demoMode: false, blendLive: false });
  });

  afterAll(async () => {
    contributions.clear();
    await putSettings({ demoMode: true, blendLive: false });
  });

  it('rides the adapter read, and serves a reopen from the TTL cache', async () => {
    const asked: string[] = [];
    stub('clearpass', {
      serviceDetail: async (id: string) => {
        asked.push(id);
        return livePayload(id);
      },
    });
    const first = await getJson('/api/clearpass/services/4');
    expect(first.status).toBe(200);
    expect(first.body.dataSource).toBe('live');
    expect(first.body.serviceDetail.service.name).toBe('Device Admin (TACACS+)');
    expect(first.body.serviceDetail.source.sections).toEqual({ service: 'ok' });
    expect(first.body.serviceDetail.source.cached).toBeFalsy();
    expect(JSON.stringify(first.body.serviceDetail)).not.toMatch(/password|secret|hash/i);

    const second = await getJson('/api/clearpass/services/4');
    expect(second.body.serviceDetail.source.cached).toBe(true);
    expect(asked).toEqual(['4']);
  });

  it('an adapter read that throws becomes a failed payload with the note — never an empty object', async () => {
    stub('clearpass', {
      serviceDetail: async () => {
        throw new Error('cppm unreachable');
      },
    });
    const { status, body } = await getJson('/api/clearpass/services/4');
    expect(status).toBe(200);
    expect(body.serviceDetail.service).toBeNull();
    expect(body.serviceDetail.source.sections).toEqual({ service: 'failed' });
    expect(body.serviceDetail.source.note).toContain('cppm unreachable');
  });

  it('an adapter without the capability is an honest null', async () => {
    // Nothing stubbed: the unconfigured ClearPass adapter has no serviceDetail.
    const { status, body } = await getJson('/api/clearpass/services/4');
    expect(status).toBe(200);
    expect(body.serviceDetail).toBeNull();
  });

  it('a plane at its stored daily call budget is not called, and the payload says why', async () => {
    const config = migrateLegacyPlaneRecord('clearpass', {
      publisher: 'cppm-01.meridian.health', token: 'cppm-token-1234', callBudget: '1',
    });
    expect(config).not.toBeNull();
    const [{ settings }, { registry }] = await Promise.all([
      import('../src/config/settings'),
      import('../src/planes/registry'),
    ]);
    settings.update({ connectors: { clearpass: config } });
    registry.reinitPlane('clearpass');
    try {
      registry.recordCall('clearpass', { path: 'GET /api/endpoint', ms: 1, code: '200' });
      const { status, body } = await getJson('/api/clearpass/services/4');
      expect(status).toBe(200);
      expect(body.serviceDetail.service).toBeNull();
      // Nothing attempted — an empty `sections` map is 'not-fetched', which is
      // the truth: we chose not to spend the call.
      expect(body.serviceDetail.source.sections).toEqual({});
      expect(body.serviceDetail.source.note).toContain('daily call budget');
    } finally {
      await fetch(`${base}/api/systems/clearpass`, { method: 'DELETE' });
    }
  });

  it('blend mode never serves a fixture detail over a live services world', async () => {
    await putSettings({ demoMode: true, blendLive: true });
    contributions.set('clearpass', {
      services: [{ id: 'live-1', name: 'Device Admin (TACACS+)', type: 'TACACS', description: null }],
    });
    const asked: string[] = [];
    stub('clearpass', {
      serviceDetail: async (id: string) => {
        asked.push(id);
        return livePayload(id);
      },
    });
    // The fixture HAS an answer for svc-001 — blend still rode the adapter,
    // because a demo-world detail for the live CPPM's estate is fabrication.
    const { status, body } = await getJson('/api/clearpass/services/svc-001');
    expect(status).toBe(200);
    expect(asked).toEqual(['svc-001']);
    expect(body.serviceDetail.service.id).toBe('svc-001');
    expect(body.serviceDetail.service.name).toBe('Device Admin (TACACS+)');
  });

  it('blend without live services keeps the fixture read — no plane call', async () => {
    await putSettings({ demoMode: true, blendLive: true });
    let calls = 0;
    stub('clearpass', {
      serviceDetail: async () => {
        calls += 1;
        return null;
      },
    });
    const { status, body } = await getJson('/api/clearpass/services/svc-001');
    expect(status).toBe(200);
    expect(calls).toBe(0);
    expect(body.serviceDetail.service.name).toBe('MRDN Guest 802.1X');
  });
});
