/**
 * server/tests/mist.test.ts — Mist adapter unit tests, NO network.
 *
 * The mapping helpers are tested against Mist-style org-stats JSON inlined
 * here; MistAdapter.pull() is exercised end-to-end with an in-memory fake
 * `fetch` (FetchLike injection) to cover the static `Token` auth header,
 * limit/page pagination (X-Page-Total driven, short page as the fallback),
 * site-UUID → name resolution, the per-site client roster, the org alarm
 * search, 429/Retry-After pacing, section-named failures, and the
 * secret-free call log. The registry block covers what the poller relies on:
 * freshness that expires, and a stub plane that never claims a sync.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { PlaneState } from '../src/planes/types';
import type { FetchLike } from '../src/planes/mist';
import { MistAdapter, mapMistAlarm, mapMistClient, mapMistDevice, mapMistSite } from '../src/planes/mist';

// -- Recorded fixtures (shapes as the Mist APIs return them) -------------------

const SITE_A = { id: 'site-uuid-a', name: 'Campus A' };
const SITE_B = { id: 'site-uuid-b', name: 'Lab B' };

const AP_CONNECTED = {
  name: 'ap-cam01-1',
  id: 'dev-uuid-1',
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

/** /api/v1/sites/{id}/stats/clients row (wireless roster). */
const CLIENT_ROW = {
  mac: '3c22fb410a19',
  hostname: 'okonjo-ipad',
  username: 'm.okonjo',
  family: 'iPad',
  model: 'iPad Pro',
  os: 'iOS 18.2',
  ip: '10.44.12.88',
  ssid: 'MRDN-Clinical',
  ap_mac: 'aabbcc001101',
  band: '5',
  channel: 36,
  vlan: 820,
  key_mgmt: 'WPA2/EAP',
  rssi: -52,
  snr: 41,
  uptime: 8040,
  site_id: 'site-uuid-a',
};

/** /api/v1/orgs/{id}/alarms/search `results` row. */
const ALARM_ROW = {
  id: 'alarm-1',
  type: 'device_down',
  group: 'infrastructure',
  severity: 'critical',
  text: 'sw-cam01-1 has been down for 12 minutes',
  timestamp: 1_767_225_600,
  site_id: 'site-uuid-a',
  hostnames: ['sw-cam01-1'],
  acked: false,
};

function state(): PlaneState {
  return { id: 'mist', linked: true, health: 'warning', lastSync: null, deviceCount: null, callsToday: 0, note: null };
}

const CREDS = { apiHost: 'api.mist.com', orgId: 'org-123', token: 'mist-token-xyz' };

interface FakeOpts {
  sitePages?: unknown[][];
  devicePages?: unknown[][];
  alarmPages?: unknown[][];
  clientsBySite?: Record<string, unknown[]>;
  siteStatus?: number;
  deviceStatus?: number;
  alarmStatus?: number;
  clientStatus?: number;
  /** Raw (non-JSON, or JSON of an unknown shape) body for the devices section. */
  deviceBody?: string;
  /** Extra response headers on the devices pages (X-Page-Total/Limit, Retry-After). */
  deviceHeaders?: Record<string, string>;
  /** Statuses answered in order by the devices section before the pages start. */
  deviceStatusSequence?: number[];
  seenAuth?: { value: string | null };
  seenUrls?: string[];
}

/** Fake fetch answering the sites, stats/devices, alarms and clients GETs. */
function fakeFetch(opts: FakeOpts): FetchLike {
  const sitePages = opts.sitePages ?? [[SITE_A, SITE_B]];
  const devicePages = opts.devicePages ?? [[AP_CONNECTED, SW_DISCONNECTED]];
  const alarmPages = opts.alarmPages ?? [[]];
  const clientsBySite = opts.clientsBySite ?? {};
  let siteIdx = 0;
  let deviceIdx = 0;
  let alarmIdx = 0;
  let statusIdx = 0;
  return async (url, init) => {
    const u = String(url);
    if (opts.seenUrls) opts.seenUrls.push(u);
    if (opts.seenAuth) opts.seenAuth.value = (init?.headers as Record<string, string>)?.authorization ?? null;
    // Per-site client roster — checked before the org /sites list below.
    const clientMatch = /\/api\/v1\/sites\/([^/]+)\/stats\/clients/.exec(u);
    if (clientMatch) {
      const status = opts.clientStatus ?? 200;
      if (status !== 200) return new Response('{}', { status });
      return new Response(JSON.stringify(clientsBySite[clientMatch[1]] ?? []), { status: 200 });
    }
    if (u.includes('/alarms/search')) {
      const status = opts.alarmStatus ?? 200;
      if (status !== 200) return new Response('{}', { status });
      const page = alarmPages[Math.min(alarmIdx, alarmPages.length - 1)];
      alarmIdx += 1;
      return new Response(JSON.stringify({ results: page, total: page.length }), { status: 200 });
    }
    if (u.includes('/stats/devices')) {
      if (opts.deviceStatusSequence && statusIdx < opts.deviceStatusSequence.length) {
        const seq = opts.deviceStatusSequence[statusIdx];
        statusIdx += 1;
        return new Response('{}', { status: seq, headers: opts.deviceHeaders });
      }
      const status = opts.deviceStatus ?? 200;
      if (status !== 200) return new Response('{}', { status });
      if (opts.deviceBody !== undefined) return new Response(opts.deviceBody, { status: 200 });
      const page = devicePages[Math.min(deviceIdx, devicePages.length - 1)];
      deviceIdx += 1;
      return new Response(JSON.stringify(page), { status: 200, headers: opts.deviceHeaders });
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

function makeAdapter(
  fetchImpl: FetchLike,
  sleep: (ms: number) => Promise<void> = async () => {},
): { adapter: MistAdapter; calls: Array<{ path: string; code: string }>; st: PlaneState } {
  const calls: Array<{ path: string; code: string }> = [];
  const st = state();
  const adapter = new MistAdapter(CREDS, st, (c) => calls.push({ path: c.path, code: c.code }), fetchImpl, sleep);
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

  it('carries the management IP when the stats row has one, and omits it otherwise', () => {
    // Devices search and terminal resolveTarget() both key on it.
    expect(mapMistDevice({ ...AP_CONNECTED, ip: '10.44.1.20' }, sites)?.ip).toBe('10.44.1.20');
    expect(mapMistDevice(AP_CONNECTED, sites)).not.toHaveProperty('ip');
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
    const s = mapMistSite(SITE_A, 3, 41);
    expect(s).toMatchObject({
      name: 'Campus A',
      planes: [{ name: 'MIST', tone: 'info' }],
      devices: 3,
      clients: '41',
      health: null,
      healthPct: '—',
    });
  });

  it('renders an em dash, not 0, when no client count is known at all', () => {
    expect(mapMistSite(SITE_A, 3)?.clients).toBe('—');
  });

  it("carries the caller's sync stamp, and '—' when the plane has never synced", () => {
    // Mist's site object has no per-site sync time, so the stamp is the
    // plane's own freshness — the adapter must not invent one per site.
    expect(mapMistSite(SITE_A, 3, 41, '45s')?.sync).toBe('45s');
    expect(mapMistSite(SITE_A, 3)?.sync).toBe('—');
  });

  it('drops a site without a name', () => {
    expect(mapMistSite({ id: 'x' }, 0)).toBeNull();
  });
});

describe('mapMistClient', () => {
  const sites = new Map([['site-uuid-a', 'Campus A']]);
  const devices = new Map([['aabbcc001101', 'ap-cam01-1']]);

  it('maps a wireless session and resolves the AP name from ap_mac', () => {
    expect(mapMistClient(CLIENT_ROW, sites, devices)).toMatchObject({
      name: 'm.okonjo',
      model: 'iPad Pro',
      type: 'tablet',
      mac: '3c22fb410a19',
      ip: '10.44.12.88',
      medium: 'wireless',
      siteName: 'Campus A',
      attach: 'ap-cam01-1',
      where: 'MRDN-Clinical',
      plane: 'MIST',
      planeTone: 'info',
      auth: 'WPA2/EAP',
      vlan: '820',
      session: '2h 14m',
      link: '5 GHz · ch 36',
      rssi: '-52 dBm',
      snr: '41 dB',
    });
  });

  it('invents no health score and drops a session without a MAC', () => {
    const c = mapMistClient(CLIENT_ROW, sites, devices);
    expect(c).toMatchObject({ health: '—', healthTone: 'neutral', quality: null, problem: false });
    expect(mapMistClient({ hostname: 'nameless' }, sites)).toBeNull();
    expect(mapMistClient(null, sites)).toBeNull();
  });

  it('falls back to the raw AP mac when the device is not in the inventory', () => {
    expect(mapMistClient(CLIENT_ROW, sites, new Map())?.attach).toBe('aabbcc001101');
  });

  it('types a desk handset as voip, not as a mobile phone', () => {
    // Every VoIP vocabulary contains 'phone', so a generic phone test first
    // made the 'voip' bucket unreachable and hid voice endpoints among mobiles.
    const voip = { mac: 'aa:bb:cc:00:00:01', family: 'VoIP Phone', manufacture: 'Mitel' };
    expect(mapMistClient(voip, sites)?.type).toBe('voip');
    expect(mapMistClient({ mac: 'aa:bb:cc:00:00:02', family: 'IP Phone' }, sites)?.type).toBe('voip');
    // …without swallowing the real mobiles.
    expect(mapMistClient({ mac: 'aa:bb:cc:00:00:03', model: 'iPhone 15' }, sites)?.type).toBe('phone');
    expect(mapMistClient({ mac: 'aa:bb:cc:00:00:04', family: 'Android Phone' }, sites)?.type).toBe('phone');
  });
});

describe('mapMistAlarm', () => {
  const sites = new Map([['site-uuid-a', 'Campus A']]);
  const now = Date.parse('2026-01-01T00:12:00Z');

  it('maps a critical alarm to an open P1 row with its site and age', () => {
    expect(mapMistAlarm(ALARM_ROW, sites, now)).toMatchObject({
      sev: 'P1',
      tone: 'danger',
      title: 'Device down',
      detail: 'sw-cam01-1 has been down for 12 minutes',
      siteName: 'Campus A',
      plane: 'MIST',
      state: 'open',
      age: '12m',
      device: 'sw-cam01-1',
      alertId: 'alarm-1',
    });
  });

  it('maps mist severities and keeps acked/resolved alarms out of the open queue', () => {
    expect(mapMistAlarm({ ...ALARM_ROW, severity: 'warn' }, sites, now)?.sev).toBe('P2');
    expect(mapMistAlarm({ ...ALARM_ROW, severity: 'info' }, sites, now)?.sev).toBe('P3');
    expect(mapMistAlarm({ ...ALARM_ROW, acked: true }, sites, now)?.state).toBe('acked');
    // Mist leaves `acked` set on an alarm it later resolves — resolved wins.
    expect(mapMistAlarm({ ...ALARM_ROW, acked: true, status: 'resolved' }, sites, now)?.state).toBe('cleared');
  });

  it('reads the reasons array when there is no prose field, and drops empty rows', () => {
    const r = mapMistAlarm({ type: 'dfs_radar', reasons: ['radar on ch 116', 'moved to ch 36'] }, sites, now);
    expect(r).toMatchObject({ title: 'Dfs radar', detail: 'radar on ch 116 · moved to ch 36', age: '—' });
    expect(mapMistAlarm({ severity: 'info' }, sites, now)).toBeNull();
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
    expect(st.health).toBe('healthy');
    // The call log carries method + path only — never the token.
    expect(calls.every((c) => !c.path.includes('mist-token-xyz'))).toBe(true);
  });

  it('pulls the per-site client roster and counts sessions onto the site rows', async () => {
    const { adapter, st } = makeAdapter(
      fakeFetch({ clientsBySite: { 'site-uuid-a': [CLIENT_ROW, { ...CLIENT_ROW, mac: 'de:ad:0b:14:65:22' }] } }),
    );
    const pull = await adapter.pull();
    expect(pull.clients).toHaveLength(2);
    expect(pull.clients?.[0]).toMatchObject({ name: 'm.okonjo', plane: 'MIST', attach: 'ap-cam01-1' });
    expect(pull.sites?.[0]).toMatchObject({ name: 'Campus A', clients: '2' });
    expect(pull.sites?.[1]).toMatchObject({ name: 'Lab B', clients: '0' });
    expect(st.note).toContain('2 client sessions');
    expect(st.health).toBe('healthy');
  });

  it('pulls org alarms and reports the open count', async () => {
    const { adapter, st } = makeAdapter(
      fakeFetch({ alarmPages: [[ALARM_ROW, { ...ALARM_ROW, id: 'alarm-2', acked: true }]] }),
    );
    const pull = await adapter.pull();
    expect(pull.alerts).toHaveLength(2);
    expect(pull.alerts?.[0]).toMatchObject({ plane: 'MIST', sev: 'P1', state: 'open', siteName: 'Campus A' });
    expect(pull.alerts?.[1]).toMatchObject({ state: 'acked' });
    expect(st.note).toContain('1 open alarms');
  });

  it('omits an optional section it could not read instead of emptying it', async () => {
    const { adapter, st } = makeAdapter(fakeFetch({ alarmStatus: 500, clientStatus: 403 }));
    const pull = await adapter.pull();
    // Omitted, NOT [] — downstream must read them as unknown, never as zero.
    expect(pull.alerts).toBeUndefined();
    expect(pull.clients).toBeUndefined();
    expect(pull.devices).toHaveLength(2); // the inventory still lands
    // No roster, but the device-stats rows DO report num_clients (17 on the AP,
    // absent on the switch) — a real plane fact, so the column reports it and
    // the note says where it came from. It is never called a session roster.
    expect(pull.sites?.[0].clients).toBe('17');
    expect(st.note).toContain('17 clients reported by devices');
    expect(st.note).toContain('not available: alarms, clients');
    expect(st.note).not.toContain('client sessions');
    expect(st.health).toBe('warning'); // never promoted to healthy over a missing dataset
    // The datasets that could not be read are named for the registry/poller.
    expect(pull.partial).toEqual(expect.arrayContaining(['alerts', 'clients']));
  });

  it("reports '—', not 0, for a site whose devices report no client count at all", async () => {
    // Same failure, but nothing on the wire carries num_clients: the adapter
    // has no client fact to stand behind, so the column must stay empty.
    const { adapter, st } = makeAdapter(
      fakeFetch({
        devicePages: [[{ ...AP_CONNECTED, num_clients: undefined }, SW_DISCONNECTED]],
        alarmStatus: 500,
        clientStatus: 403,
      }),
    );
    const pull = await adapter.pull();
    expect(pull.sites?.[0].clients).toBe('—');
    expect(st.note).not.toContain('reported by devices');
  });

  it('refuses the client fan-out past the daily-call budget rather than reading half of it', async () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ id: `site-uuid-${i}`, name: `Site ${i}` }));
    const seenUrls: string[] = [];
    const { adapter, st } = makeAdapter(fakeFetch({ sitePages: [many], seenUrls }));
    const pull = await adapter.pull();
    expect(pull.clients).toBeUndefined();
    expect(seenUrls.some((u) => u.includes('/stats/clients'))).toBe(false);
    expect(st.note).toContain('not available: clients');
    expect(st.health).toBe('warning');
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

  it('follows X-Page-Total when the gateway trims the requested page size', async () => {
    // 300 rows for a limit=1000 request: the short-page rule alone would stop
    // after page 1 and report a third of the inventory as the whole of it.
    const page = (n: number) => Array.from({ length: 300 }, (_, i) => ({ name: `ap-${n}-${i}`, status: 'connected' }));
    const seenUrls: string[] = [];
    const { adapter, st } = makeAdapter(
      fakeFetch({
        devicePages: [page(1), page(2), page(3)],
        deviceHeaders: { 'x-page-total': '900', 'x-page-limit': '300' },
        seenUrls,
      }),
    );
    const pull = await adapter.pull();
    expect(pull.devices).toHaveLength(900);
    expect(seenUrls.filter((u) => u.includes('/stats/devices'))).toHaveLength(3);
    expect(st.note).not.toContain('truncated');
  });

  it('reports a walk that ends with rows outstanding as truncated instead of complete', async () => {
    const page = Array.from({ length: 10 }, (_, i) => ({ name: `ap-${i}`, status: 'connected' }));
    const { adapter, st } = makeAdapter(
      fakeFetch({ devicePages: [page, []], deviceHeaders: { 'x-page-total': '900', 'x-page-limit': '10' } }),
    );
    const pull = await adapter.pull();
    expect(pull.devices).toHaveLength(10);
    expect(st.note).toContain('truncated: devices');
    expect(st.health).toBe('warning'); // a partial inventory is not a healthy sync
  });

  it('fails the section on a 200 whose body cannot be read', async () => {
    const { adapter } = makeAdapter(fakeFetch({ deviceBody: '<html>sso interstitial</html>' }));
    await expect(adapter.pull()).rejects.toThrow(/section 'devices' failed — unreadable body/);
  });

  it('fails the section on a 200 whose envelope carries no rows container', async () => {
    // `{}` is not "zero devices" — it is a shape we cannot read, and stamping
    // it as an empty successful sync would wipe the last good Mist data.
    const { adapter } = makeAdapter(fakeFetch({ deviceBody: '{"detail":"unexpected"}' }));
    await expect(adapter.pull()).rejects.toThrow(/section 'devices' failed — unreadable body/);
  });

  it('paces a 429 with Retry-After and completes the pull on the retry', async () => {
    const slept: number[] = [];
    const { adapter, calls } = makeAdapter(
      fakeFetch({ deviceStatusSequence: [429], deviceHeaders: { 'retry-after': '2' } }),
      async (ms) => {
        slept.push(ms);
      },
    );
    const pull = await adapter.pull();
    expect(slept).toContain(2000); // Retry-After wins over the exponential floor
    expect(pull.devices).toHaveLength(2);
    // Both attempts are recorded, so the Activity tab shows the real 429.
    expect(calls.filter((c) => c.code === '429')).toHaveLength(1);
  });

  it('fails the pull naming the section when sites errors', async () => {
    const { adapter } = makeAdapter(fakeFetch({ siteStatus: 401 }));
    await expect(adapter.pull()).rejects.toThrow("mist pull: section 'sites' failed");
  });

  it('fails the pull naming the section when devices errors', async () => {
    const { adapter } = makeAdapter(fakeFetch({ deviceStatus: 429 }));
    await expect(adapter.pull()).rejects.toThrow("mist pull: section 'devices' failed");
  });

  it("stamps site rows with the plane's own freshness once it has synced", async () => {
    const { adapter, st } = makeAdapter(fakeFetch({}));
    // Cycle 1: the poller has not stamped lastSync yet, so '—' is the honest
    // answer — the adapter must not invent a sync time it does not have.
    expect((await adapter.pull()).sites?.[0].sync).toBe('—');
    st.lastSync = new Date(Date.now() - 45_000).toISOString();
    // Cycle 2 reports the previous successful read, which is what a relative
    // "Last sync" means on the Sites screen.
    expect((await adapter.pull()).sites?.[0].sync).toBe('45s');
  });

  it('claims no shell and no write: Mist is a read-only cloud plane', () => {
    const { adapter, st } = makeAdapter(fakeFetch({}));
    expect(adapter.capabilities()).toEqual({ localShell: false, brokeredWrite: false, configRead: false });
    // Published on the shared state too, so a consumer reading PlaneState sees it.
    expect(st.capabilities).toEqual({ localShell: false, brokeredWrite: false, configRead: false });
  });

  it('isComplete requires apiHost, orgId and token', () => {
    expect(MistAdapter.isComplete(CREDS)).toBe(true);
    expect(MistAdapter.isComplete({ apiHost: 'api.mist.com', token: 'x' })).toBe(false);
    expect(MistAdapter.isComplete({ apiHost: ' ', orgId: 'o', token: 't' })).toBe(false);
    expect(MistAdapter.isComplete(null)).toBe(false);
  });
});

// -- Registry wiring and freshness ------------------------------------------------

/** Run `fn` against a registry backed by a throwaway settings file. */
async function withRegistry(
  planes: Record<string, Record<string, string>>,
  fn: (reg: import('../src/planes/registry').PlaneRegistry) => void | Promise<void>,
): Promise<void> {
  const tmpDir = mkdtempSync(join(tmpdir(), 'hpe-mist-'));
  process.env.HPE_SETTINGS_PATH = join(tmpDir, 'settings.json');
  try {
    const { SettingsStore } = await import('../src/config/settings');
    const { PlaneRegistry } = await import('../src/planes/registry');
    const store = new SettingsStore();
    store.update({ planes, pollIntervalSec: 60 });
    await fn(new PlaneRegistry(store));
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.HPE_SETTINGS_PATH;
  }
}

describe('registry wiring', () => {
  it('builds the real MistAdapter when credentials are complete', async () => {
    await withRegistry({ mist: CREDS }, (reg) => {
      expect(reg.get('mist')).toBeInstanceOf(MistAdapter);
      const st = reg.state('mist');
      expect(st.linked).toBe(true);
      expect(st.health).toBe('warning');
      expect(st.note).toBe('credentials saved — first sync pending');
      // A linked plane that has never synced is serving no rows, so there is
      // nothing on screen to mark unverified — `reason` carries the fact and
      // the Sites "Last sync" column prints 'never' from lastSync.
      expect(st).toMatchObject({ stale: false, ageSec: null, reason: 'never-synced' });
    });
  });

  it('expires freshness on the clock: an aged last sync reads stale and degraded', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      await withRegistry({ mist: CREDS }, (reg) => {
        // A completed pull is what clears the 'first sync pending' warning —
        // the adapter writes it on the state the registry handed it. Without
        // this the plane is stale for a different reason ('partial'), which
        // would hide the clock expiry this test is about.
        reg.markSyncResult('mist', true, { deviceCount: 2 });
        expect(reg.state('mist')).toMatchObject({ stale: true, reason: 'partial', ageSec: 0 });
        reg.get('mist').state().health = 'healthy';
        expect(reg.state('mist')).toMatchObject({ stale: false, ageSec: 0, reason: null });
        expect(reg.staleAfterSec()).toBe(180); // 3 × the 60s poll interval

        vi.setSystemTime(new Date('2026-01-01T00:02:00Z')); // 120s — inside the window
        expect(reg.state('mist')).toMatchObject({ stale: false, ageSec: 120, health: 'healthy' });

        // 4 minutes with no successful poll and nothing thrown: skipped ticks
        // record no failure, so only the clock can catch this.
        vi.setSystemTime(new Date('2026-01-01T00:04:00Z'));
        const aged = reg.state('mist');
        expect(aged).toMatchObject({ stale: true, ageSec: 240, health: 'degraded', reason: 'aged-out' });
        expect(reg.states().mist.stale).toBe(true);
        // The STORED health is untouched, so the next good poll still restores it.
        reg.markSyncResult('mist', true, { deviceCount: 2 });
        expect(reg.state('mist')).toMatchObject({ stale: false, health: 'healthy' });
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('leaves an unlinked plane alone — it has nothing to be stale about', async () => {
    await withRegistry({ mist: CREDS }, (reg) => {
      expect(reg.state('aos10')).toMatchObject({ linked: false, health: 'unlinked', stale: false, ageSec: null });
    });
  });

  it('holds a plane at warning when a pull could not read a whole dataset', async () => {
    await withRegistry({ mist: CREDS }, (reg) => {
      reg.markSyncResult('mist', false, {});
      expect(reg.state('mist').health).toBe('degraded');
      // A partial pull is a real sync, but not a complete one — it must not
      // restore the healthy badge over a dataset that was never fetched.
      reg.markSyncResult('mist', true, { deviceCount: 2, partial: ['clients'] });
      const st = reg.state('mist');
      expect(st.health).toBe('warning');
      expect(st.lastSync).not.toBeNull();
    });
  });

  it('never stamps a stub plane as synced — no lastSync, no calls, no log entry', async () => {
    await withRegistry({ classic: { baseUrl: 'classic.example.com' } }, async (reg) => {
      const { StubAdapter } = await import('../src/planes/registry');
      expect(reg.get('classic')).toBeInstanceOf(StubAdapter);
      // Exactly what the poller does on a successful tick.
      reg.recordCall('classic', { path: 'poll()', ms: 2, code: 'ok' });
      reg.markSyncResult('classic', true, { deviceCount: 0 });
      const st = reg.state('classic');
      expect(st.lastSync).toBeNull();
      expect(st.callsToday).toBe(0);
      expect(reg.recentCalls('classic')).toHaveLength(0);
      expect(st.note).toBe('credentials saved — sync adapter not yet implemented (stub)');
      // A real outbound call (a connection test) is still counted.
      reg.recordCall('classic', { path: 'GET /ping', ms: 4, code: '200' });
      expect(reg.state('classic').callsToday).toBe(1);
    });
  });
});
