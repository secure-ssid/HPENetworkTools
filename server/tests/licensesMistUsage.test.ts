/**
 * server/tests/licensesMistUsage.test.ts — the /api/licenses payload's Mist
 * per-site licence-usage section across the three source modes.
 *
 * The adapter reads GET /api/v1/orgs/{org}/licenses/usages into
 * PlanePull.mistLicenseUsages (covered in mist.test.ts); these tests pin the
 * ROUTE wiring: the demo envelope carries the authored MIST_LICENSE_USAGES,
 * a live/blend payload carries what the Mist contribution actually holds, and
 * "Mist reported nothing" is null — never the fixtures, never a zero.
 *
 * In-process app on an ephemeral port; HPE_SETTINGS_PATH/HPE_DATA_DIR point at
 * a tmp dir so the test never touches the real data/ files (the env vars must
 * be set before the app modules are imported — dynamic import in beforeAll).
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MIST_LICENSE_USAGES, SUBSCRIPTIONS } from '@hpe/shared';

let server: Server;
let base: string;
let tmpDir: string;
let contributions: Map<string, unknown>;

const putSettings = (patch: Record<string, unknown>) =>
  fetch(`${base}/api/settings`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'hpe-licenses-mist-'));
  process.env.HPE_SETTINGS_PATH = join(tmpDir, 'settings.json');
  process.env.HPE_DATA_DIR = join(tmpDir, 'data'); // writes land in tmp, never real data/
  process.env.HPE_CREDENTIAL_INDEX_WAIT_MS = '0';
  const { createApp } = await import('../src/index');
  server = createApp().listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const { poller } = await import('../src/services/poller');
  contributions = (poller as unknown as { contributions: Map<string, unknown> }).contributions;
});

afterAll(async () => {
  contributions.clear();
  await putSettings({ demoMode: true, blendLive: false });
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

/** What the live adapter's read maps to, verbatim (mist.test.ts USAGE_ROWS). */
const LIVE_USAGE = {
  siteId: 'campus-02',
  siteName: 'Campus-02 Research',
  numDevices: 12,
  numAps: 9,
  usages: { 'SUB-WLAN': 9, 'SUB-SW': 3 },
  fullyLoaded: { 'SUB-WLAN': 9, 'SUB-SW': 3 },
};

/** One GreenLake subscription so the blend swap has a live section to swap in. */
const LIVE_SUBSCRIPTION = {
  ...SUBSCRIPTIONS[0],
  name: 'Live Foundation AP',
  qty: '10',
  assigned: '8',
  qtyValue: 10,
  assignedValue: 8,
  daysLeft: 20,
  expiresAtMs: Date.now() + 20 * 24 * 60 * 60 * 1000,
};

describe('licences payload — Mist per-site usage', () => {
  it('demo mode serves the authored usage rows, Southpoint zero intact', async () => {
    const { status, body } = await getJson('/api/licenses');
    expect(status).toBe(200);
    expect(body.dataSource).toBe('demo');
    expect(body.mistLicenseUsages).toEqual(MIST_LICENSE_USAGES);
    // The orphan story, kept: four wired SUBs purchased for Southpoint consume
    // nothing — an explicit reported 0 against a fully-loaded demand of 4,
    // which is not the same fact as a service the row never named.
    const southpoint = (body.mistLicenseUsages as any[]).find((u) => u.siteId === 'southpoint');
    expect(southpoint.usages['SUB-SW']).toBe(0);
    expect(southpoint.fullyLoaded['SUB-SW']).toBe(4);
    expect(southpoint.numDevices).toBe(15);
    expect(southpoint.numAps).toBe(10);
  });

  it('live mode carries what the Mist contribution holds, verbatim', async () => {
    await putSettings({ demoMode: false });
    try {
      contributions.clear();
      contributions.set('mist', { mistLicenseUsages: [LIVE_USAGE] });
      const { body } = await getJson('/api/licenses');
      expect(body.dataSource).toBe('live');
      expect(body.mistLicenseUsages).toEqual([LIVE_USAGE]);
    } finally {
      await putSettings({ demoMode: true });
    }
  });

  it('live mode says null, not fixtures and not zero, when Mist reported nothing', async () => {
    await putSettings({ demoMode: false });
    try {
      // A Mist contribution without the usages key (the read failed this
      // cycle) — and then no Mist contribution at all. Both are "not
      // reported": the key must be present and null, so the screen can say so
      // instead of hiding or painting the demo rows over a live payload.
      contributions.clear();
      contributions.set('mist', { devices: [] });
      const unread = await getJson('/api/licenses');
      expect(unread.body.mistLicenseUsages).toBeNull();

      contributions.clear();
      const absent = await getJson('/api/licenses');
      expect(absent.body.mistLicenseUsages).toBeNull();
    } finally {
      await putSettings({ demoMode: true });
    }
  });

  it('blend mode swaps the usage rows with the section, and never to fixtures', async () => {
    await putSettings({ demoMode: true, blendLive: true });
    try {
      contributions.clear();
      contributions.set('greenlake', { subscriptions: [LIVE_SUBSCRIPTION] });
      contributions.set('mist', { mistLicenseUsages: [LIVE_USAGE] });
      const swapped = await getJson('/api/licenses');
      expect(swapped.body.dataSource).toBe('demo'); // blend stays a demo envelope
      expect(swapped.body.blended).toEqual(['licenses']);
      expect(swapped.body.mistLicenseUsages).toEqual([LIVE_USAGE]);

      // The swap with Mist silent: the payload is real GreenLake data, and the
      // usage section must not keep the authored rows underneath it.
      contributions.set('mist', { devices: [] });
      const silent = await getJson('/api/licenses');
      expect(silent.body.blended).toEqual(['licenses']);
      expect(silent.body.mistLicenseUsages).toBeNull();
    } finally {
      contributions.clear();
      await putSettings({ blendLive: false, demoMode: true });
    }
  });

  it('demo mode keeps the fixtures while the blend has nothing live to swap', async () => {
    await putSettings({ demoMode: true, blendLive: true });
    try {
      contributions.clear(); // no subscriptions contributed → no swap
      const { body } = await getJson('/api/licenses');
      expect(body.blended).toBeUndefined();
      expect(body.mistLicenseUsages).toEqual(MIST_LICENSE_USAGES);
    } finally {
      await putSettings({ blendLive: false, demoMode: true });
    }
  });
});
