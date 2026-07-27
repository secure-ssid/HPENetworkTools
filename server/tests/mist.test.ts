/**
 * server/tests/mist.test.ts — Mist adapter unit tests, NO network.
 *
 * The mapping helpers are tested against Mist-style org-stats JSON inlined
 * here; MistAdapter.pull() is exercised end-to-end with an in-memory fake
 * `fetch` (FetchLike injection) to cover the static `Token` auth header,
 * limit/page pagination (short page ends the loop), site-UUID → name
 * resolution, section-named failures, and the secret-free call log.
 */

import { describe, expect, it } from 'vitest';
import type { PlaneState } from '../src/planes/types';
import type { FetchLike } from '../src/planes/mist';
import { MistAdapter, mapMistDevice, mapMistSite } from '../src/planes/mist';

// -- Recorded fixtures (shapes as the Mist APIs return them) -------------------

const SITE_A = { id: 'site-uuid-a', name: 'Campus A' };
const SITE_B = { id: 'site-uuid-b', name: 'Lab B' };

const AP_CONNECTED = {
  name: 'ap-cam01-1',
  model: 'AP45',
  type: 'ap',
  serial: 'SER-001',
  mac: 'aa:bb:cc:00:11:01',
  version: '0.14.29345',
  status: 'connected',
  site_id: 'site-uuid-a',
  num_clients: 17,
};
const SW_DISCONNECTED = {
  name: 'sw-cam01-1',
  model: 'EX4400',
  type: 'switch',
  serial: 'SER-002',
  status: 'disconnected',
  site_id: 'site-uuid-a',
};
const AP_UNKNOWN_SITE = {
  name: 'ap-lab-1',
  type: 'ap',
  status: 'connected',
  site_id: 'site-uuid-gone', // not in the sites section
};

function state(): PlaneState {
  return { id: 'mist', linked: true, health: 'warning', lastSync: null, deviceCount: null, callsToday: 0, note: null };
}

const CREDS = { apiHost: 'api.mist.com', orgId: 'org-123', token: 'mist-token-xyz' };

/** Fake fetch answering the sites and stats/devices paged GETs. */
function fakeFetch(opts: {
  sitePages?: unknown[][];
  devicePages?: unknown[][];
  siteStatus?: number;
  deviceStatus?: number;
  seenAuth?: { value: string | null };
  seenUrls?: string[];
}): FetchLike {
  const sitePages = opts.sitePages ?? [[SITE_A, SITE_B]];
  const devicePages = opts.devicePages ?? [[AP_CONNECTED, SW_DISCONNECTED]];
  let siteIdx = 0;
  let deviceIdx = 0;
  return async (url, init) => {
    const u = String(url);
    if (opts.seenUrls) opts.seenUrls.push(u);
    if (opts.seenAuth) opts.seenAuth.value = (init?.headers as Record<string, string>)?.authorization ?? null;
    if (u.includes('/stats/devices')) {
      const status = opts.deviceStatus ?? 200;
      if (status !== 200) return new Response('{}', { status });
      const page = devicePages[Math.min(deviceIdx, devicePages.length - 1)];
      deviceIdx += 1;
      return new Response(JSON.stringify(page), { status: 200 });
    }
    if (u.includes('/sites')) {
      const status = opts.siteStatus ?? 200;
      if (status !== 200) return new Response('{}', { status });
      const page = sitePages[Math.min(siteIdx, sitePages.length - 1)];
      siteIdx += 1;
      return new Response(JSON.stringify(page), { status: 200 });
    }
    return new Response('{}', { status: 404 });
  };
}

function makeAdapter(fetchImpl: FetchLike): { adapter: MistAdapter; calls: Array<{ path: string; code: string }>; st: PlaneState } {
  const calls: Array<{ path: string; code: string }> = [];
  const st = state();
  const adapter = new MistAdapter(CREDS, st, (c) => calls.push({ path: c.path, code: c.code }), fetchImpl);
  return { adapter, calls, st };
}

// -- mapping -------------------------------------------------------------------

describe('mapMistDevice', () => {
  const sites = new Map([
    ['site-uuid-a', 'Campus A'],
    ['site-uuid-b', 'Lab B'],
  ]);

  it('maps a connected AP with serial/mac hints', () => {
    const d = mapMistDevice(AP_CONNECTED, sites);
    expect(d).toMatchObject({
      name: 'ap-cam01-1',
      model: 'AP45',
      type: 'ap',
      plane: 'MIST',
      planeTone: 'info',
      state: 'up',
      stateTone: 'success',
      firmware: '0.14.29345',
      siteName: 'Campus A',
      serial: 'SER-001',
      mac: 'aa:bb:cc:00:11:01',
      localShell: false,
    });
  });

  it('maps disconnected to down/danger and resolves unknown sites to multiple', () => {
    expect(mapMistDevice(SW_DISCONNECTED, sites)).toMatchObject({ state: 'down', stateTone: 'danger', type: 'switch' });
    const d = mapMistDevice(AP_UNKNOWN_SITE, sites);
    expect(d?.siteId).toBe('multiple');
    expect(d?.state).toBe('up');
  });

  it('keeps an unrecognized status honest and drops nameless rows', () => {
    expect(mapMistDevice({ name: 'ap-x', status: 'upgrading' }, sites)).toMatchObject({
      state: 'upgrading',
      stateTone: 'neutral',
    });
    expect(mapMistDevice({ model: 'AP45' }, sites)).toBeNull();
    expect(mapMistDevice(null, sites)).toBeNull();
  });
});

describe('mapMistSite', () => {
  it('maps a site with its device count and no invented health', () => {
    const s = mapMistSite(SITE_A, 3);
    expect(s).toMatchObject({
      name: 'Campus A',
      planes: [{ name: 'MIST', tone: 'info' }],
      devices: 3,
      health: null,
      healthPct: '—',
    });
  });

  it('drops a site without a name', () => {
    expect(mapMistSite({ id: 'x' }, 0)).toBeNull();
  });
});

// -- pull() end-to-end -----------------------------------------------------------

describe('MistAdapter.pull', () => {
  it('sends the static Token header and pulls devices + sites', async () => {
    const seenAuth = { value: null as string | null };
    const { adapter, calls, st } = makeAdapter(fakeFetch({ seenAuth }));
    const pull = await adapter.pull();
    expect(seenAuth.value).toBe('Token mist-token-xyz');
    expect(pull.devices).toHaveLength(2);
    expect(pull.devices?.[0]).toMatchObject({ name: 'ap-cam01-1', state: 'up', siteName: 'Campus A' });
    expect(pull.devices?.[1]).toMatchObject({ name: 'sw-cam01-1', state: 'down' });
    expect(pull.sites).toHaveLength(2);
    expect(pull.sites?.[0]).toMatchObject({ name: 'Campus A', devices: 2 });
    expect(pull.sites?.[1]).toMatchObject({ name: 'Lab B', devices: 0 });
    expect(st.note).toContain('2 devices across 2 sites');
    expect(st.note).toContain('1 down');
    expect(st.note).toContain('client counts only');
    expect(st.health).toBe('healthy');
    // The call log carries method + path only — never the token.
    expect(calls.every((c) => !c.path.includes('mist-token-xyz'))).toBe(true);
  });

  it('counts devices on an aliased site and merges two sites aliasing to one canonical id', async () => {
    // 'Campus-01 HQ' and 'Campus-01' are both aliases of the campus-01 site id.
    const aliasA = { id: 'site-uuid-a1', name: 'Campus-01 HQ' };
    const aliasB = { id: 'site-uuid-a2', name: 'campus-01' };
    const devA = { ...AP_CONNECTED, site_id: 'site-uuid-a1' };
    const devB = { ...SW_DISCONNECTED, site_id: 'site-uuid-a2' };
    const { adapter } = makeAdapter(fakeFetch({ sitePages: [[aliasA, aliasB]], devicePages: [[devA, devB]] }));
    const pull = await adapter.pull();
    expect(pull.devices?.every((d) => d.siteName === 'Campus-01 — Meridian HQ')).toBe(true);
    expect(pull.sites).toHaveLength(1); // one canonical SiteRow, not two
    expect(pull.sites?.[0]).toMatchObject({ id: 'campus-01', name: 'Campus-01 — Meridian HQ', devices: 2 });
  });

  it('pages until a short page comes back', async () => {
    const full = Array.from({ length: 1000 }, (_, i) => ({ name: `ap-${i}`, type: 'ap', status: 'connected' }));
    const seenUrls: string[] = [];
    const { adapter } = makeAdapter(fakeFetch({ devicePages: [full, [AP_CONNECTED]], seenUrls }));
    const pull = await adapter.pull();
    expect(pull.devices).toHaveLength(1001);
    const deviceCalls = seenUrls.filter((u) => u.includes('/stats/devices'));
    expect(deviceCalls).toHaveLength(2);
    expect(deviceCalls[0]).toContain('limit=1000&page=1');
    expect(deviceCalls[1]).toContain('limit=1000&page=2');
  });

  it('fails the pull naming the section when sites errors', async () => {
    const { adapter } = makeAdapter(fakeFetch({ siteStatus: 401 }));
    await expect(adapter.pull()).rejects.toThrow("mist pull: section 'sites' failed");
  });

  it('fails the pull naming the section when devices errors', async () => {
    const { adapter } = makeAdapter(fakeFetch({ deviceStatus: 429 }));
    await expect(adapter.pull()).rejects.toThrow("mist pull: section 'devices' failed");
  });

  it('isComplete requires apiHost, orgId and token', () => {
    expect(MistAdapter.isComplete(CREDS)).toBe(true);
    expect(MistAdapter.isComplete({ apiHost: 'api.mist.com', token: 'x' })).toBe(false);
    expect(MistAdapter.isComplete({ apiHost: ' ', orgId: 'o', token: 't' })).toBe(false);
    expect(MistAdapter.isComplete(null)).toBe(false);
  });
});
