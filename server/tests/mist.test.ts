/**
 * server/tests/mist.test.ts — Mist adapter unit tests, NO network.
 *
 * The mapping helpers are tested against Mist-style org-stats JSON inlined
 * here; MistAdapter.pull() is exercised end-to-end with an in-memory fake
 * `fetch` (FetchLike injection) to cover the static `Token` auth header,
 * limit/page pagination (X-Page-Total driven, short page as the fallback),
 * site-UUID → name resolution, the per-site wireless roster, the ORG wired
 * roster (medium 'wired', all-or-nothing with the wireless half), the rich
 * per-site AP stats walk (radios/ports/env/LLDP, plus the num_clients
 * fallback for the Sites column when the roster is unread), the floor-plan
 * walk (maps + AP config placements), the org alarm search, the SITE-scoped
 * WLAN walk (with the cleartext-PSK scrub proof), the per-site per-metric
 * SLE summaries (partial failure included), the LAZY SLE drill-down
 * (classifiers/impacted/trend — never on the poll), the on-demand
 * deviceDetail by serial/mac/uuid, the firmware-version / licence-usage /
 * inventory enrichment reads, 429/Retry-After pacing, section-named
 * failures, and the secret-free call log.
 * The registry block covers what the poller relies on: freshness that
 * expires, and a stub plane that never claims a sync.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { PlaneState } from '../src/planes/types';
import type { FetchLike } from '../src/planes/mist';
import type { SsidForm } from '@hpe/shared';
import {
  MistAdapter,
  buildMistWlanPayload,
  mapApPortDetail,
  mapApRadioDetail,
  mapMistAlarm,
  mapMistApPosition,
  mapMistApStats,
  mapMistAuditLogEntry,
  mapMistClient,
  mapMistDevice,
  mapMistEnvStats,
  mapMistLicenseUsage,
  mapMistLldpUplink,
  mapMistMap,
  mapMistPortStats,
  mapMistRadioStats,
  mapMistRogueAp,
  mapMistSite,
  mapMistSle,
  mapMistSleImpactedAps,
  mapMistSleImpactedClients,
  mapMistSleSummary,
  mapMistSleTrend,
  mapMistWebhookSubscription,
  mapMistWiredClient,
  mapMistWlan,
  mistWlanDiffers,
  parseMistFirmwareTrains,
  readableMistWlanPayload,
  scrubMistAuditSnapshot,
} from '../src/planes/mist';

// -- Recorded fixtures (shapes as the Mist APIs return them) -------------------

const SITE_A = { id: 'site-uuid-a', name: 'Campus A' };
const SITE_B = { id: 'site-uuid-b', name: 'Lab B' };

describe('Mist authenticated connection probe', () => {
  it('uses Token auth for a bounded organisation device read', async () => {
    const calls: Array<{ url: string; authorization: string | null }> = [];
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push({
        url: String(url),
        authorization: new Headers(init?.headers).get('authorization'),
      });
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    };
    const adapter = new MistAdapter(
      { apiHost: 'https://api.mist.com', orgId: 'org-1', token: 'mist-secret' },
      {
        id: 'mist', linked: true, health: 'warning', lastSync: null,
        deviceCount: null, callsToday: 0, note: '', callBudget: null, token: null,
        consecutiveFailures: 0, nextAttemptAt: null,
      },
      () => undefined,
      fetchImpl,
      async () => undefined,
    );

    await expect(adapter.validateConnection()).resolves.toMatchObject({
      ok: true, authenticated: true, dataset: 'devices',
    });
    expect(calls).toEqual([{
      url: 'https://api.mist.com/api/v1/orgs/org-1/stats/devices?type=all&limit=1&page=1',
      authorization: 'Token mist-secret',
    }]);
  });
});

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
  // Present on some org stats payloads but NOT a field the adapter may read:
  // the live org's org-level rows do not carry it, so the suite proves it is
  // ignored rather than summed into the Sites 'Clients' column.
  num_clients: 17,
};
const SW_DISCONNECTED = {
  name: 'sw-cam01-1',
  model: 'EX4400',
  type: 'switch',
  serial: 'SER-002',
  mac: '5c:5b:35:00:00:02',
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

/** /api/v1/sites/{id}/wlans rows — the SITE-scoped WLAN payload. */
const WLAN_EAP = { ssid: 'MRDN-Clinical', vlan_id: 820, auth: { type: 'eap' }, enabled: true };
/** Deliberately carries the cleartext secrets the live payload carries — the
 *  suite proves none of these strings ever reach a mapped row. */
const WLAN_PSK = {
  ssid: 'MRDN-Guest',
  vlan_id: 812,
  auth: { type: 'psk', psk: 'cleartext-psk-DoNotLeak' },
  portal_api_secret: 'portal-secret-DoNotLeak',
  enabled: false,
};

/** A sle/.../metric/{metric}/summary body in the documented shape. */
function sleSummary(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    start: 1_767_225_600,
    end: 1_767_229_200,
    sle: { name: 'coverage', x_label: 'time', y_label: 'clients', interval: 600, samples: { total: [120, null, 80], degraded: [10, null, 10], value: [90, null, 90] } },
    impact: { num_users: 4, num_aps: 1, total_users: 120, total_aps: 12 },
    classifiers: [
      { name: 'signal-strength', interval: 600, x_label: 'time', y_label: 'clients', samples: { total: [12, 8], degraded: [12, 8], duration: [600, 600] }, impact: { num_users: 3, num_aps: 1, total_users: 120, total_aps: 12 } },
    ],
    events: [],
    ...over,
  };
}

/** /api/v1/orgs/{id}/devices/versions rows ({model, version, tag}). */
const VERSION_ROWS = [
  { model: 'AP45', version: '0.15.30112', tag: 'alpha' },
  { model: 'AP45', version: '0.14.29345', tag: 'suggested' },
  { model: 'EX4400', version: '23.4R2-S3' },
];

/** /api/v1/orgs/{id}/inventory rows. */
const INVENTORY_ROWS = [
  { mac: 'aabbcc001101', serial: 'SER-001', model: 'AP45', magic: 'CLAIMCODE12345AB', connected: true, site_id: 'site-uuid-a' },
  { mac: '5c5b35000002', serial: 'SER-002', model: 'EX4400', magic: 'WIR3DCLAIMC0DE9', connected: false, site_id: 'site-uuid-a' },
];

/** /api/v1/orgs/{id}/licenses/usages rows. */
const USAGE_ROWS = [
  { site_id: 'site-uuid-a', num_devices: 12, num_aps: 9, usages: { 'SUB-WLAN': 9, 'SUB-SW': 3 }, fully_loaded: { 'SUB-WLAN': 9, 'SUB-SW': 3 } },
  { site_id: 'site-uuid-b', num_devices: 2, usages: { 'SUB-WLAN': 2 } },
];

/** /api/v1/sites/{id}/stats/devices?type=ap row — the RICH per-AP stats shape. */
const AP_STATS_ROW = {
  name: 'ap-cam01-1',
  id: 'dev-uuid-1',
  mac: 'aa:bb:cc:00:11:01',
  serial: 'SER-001',
  site_id: 'site-uuid-a',
  num_clients: 17,
  cpu_util: 23,
  mem_total_kb: 997_376,
  mem_used_kb: 512_040,
  uptime: 3_945_600,
  rx_bps: 48_200_000,
  tx_bps: 12_400_000,
  ext_ip: '198.51.100.44',
  ip_stat: { dns: '10.44.1.10', gateway: '10.44.0.1', dhcp_server: '10.44.1.11' },
  power_src: 'PoE 802.3at',
  power_constrained: false,
  radio_stat: {
    band_5: { channel: 36, bandwidth: 40, power: 14, noise_floor: -96, util_all: 31, util_tx: 12, util_rx_in_bss: 9, util_rx_other_bss: 7, util_non_wifi: 3, num_clients: 12 },
    band_24: { channel: 6, bandwidth: 20, power: 11, noise_floor: -92, util_all: 58, util_tx: 22, util_rx_in_bss: 18, util_rx_other_bss: 14, util_non_wifi: 4, num_clients: 5 },
  },
  port_stat: { eth0: { up: true, speed: 1000, full_duplex: true, rx_bytes: 4_812_340_220, tx_bytes: 1_203_110_540, rx_errors: 0, tx_errors: 0, peak_bps: 812_000_000 } },
  env_stat: { ambient_temp: 23.8, pressure: 1004.2, humidity: 41, accel_x: 0, accel_y: 0, accel_z: 0 },
  lldp_stat: { system_name: 'CX6300-CORE', system_desc: 'HPE JL660A', port_id: '1/1/5', chassis_id: 'b8:d4:e7:00:63:01', mgmt_addr: '10.44.1.2' },
};

/** /api/v1/orgs/{id}/wired_clients/search `results` row. */
const WIRED_ROW = {
  mac: '3c52821e07a1',
  hostname: 'rsch-ws-07',
  ip: '10.44.22.31',
  switch_mac: '5c5b35000002',
  eth_port: 8,
  vlan_id: 822,
  auth_state: 'authenticated',
  rx_bytes: 98_122_044,
  tx_bytes: 44_120_911,
  uptime: 532_800,
  site_id: 'site-uuid-a',
};

/** /api/v1/sites/{id}/maps row. */
const MAP_ROW = {
  id: 'map-uuid-1',
  name: 'Campus A · floor 3',
  site_id: 'site-uuid-a',
  url: 'https://api.mist.com/api/v1/sites/site-uuid-a/maps/map-uuid-1.png',
  width: 1200,
  height: 800,
  width_m: 48,
  height_m: 32,
  orientation: 0,
};

/** /api/v1/sites/{id}/devices?type=ap config row (carries the map placement). */
const AP_CONFIG_ROW = {
  id: 'dev-uuid-1',
  name: 'ap-cam01-1',
  mac: 'aabbcc001101',
  map_id: 'map-uuid-1',
  x: 320,
  y: 240,
  adopted: true,
  radio_config: { band_24: { disabled: true }, band_5: {} },
};

/** A sle/.../summary-trend body in the documented shape. */
function sleTrendBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    start: 1_767_225_600,
    end: 1_767_229_200,
    interval: 600,
    samples: { total: [120, null, 80], degraded: [10, null, 10] },
    ...over,
  };
}

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
  /** Site-scoped WLANs (/sites/{id}/wlans) — defaults to an empty roster. */
  wlansBySite?: Record<string, unknown[]>;
  /** Per-site WLAN status overrides (e.g. { 'site-uuid-b': 500 }). */
  wlanStatusBySite?: Record<string, number>;
  /** Records every non-GET call on the WLAN endpoints (method, url, parsed
   *  body) so the direct-write suite can assert exactly what went on the
   *  wire — including that the PSK travelled ONLY in the write body. */
  wlanWrites?: { method: string; url: string; site: string; wlanId: string | null; body: unknown }[];
  /** Status answered for POST/PUT/DELETE on the WLAN endpoints (default 200). */
  wlanWriteStatus?: number;
  /** Write echo: default returns the sent body (Mist's answer to a write);
   *  'unreadable' answers 200 with no JSON — "written, not confirmed". */
  wlanWriteBody?: 'echo' | 'unreadable';
  /** SLE summaries keyed `${siteUuid}|${metric}` — { status, body }. A site/
   *  metric with no entry answers 404 (the site does not score that metric). */
  sle?: Record<string, { status?: number; body?: unknown }>;
  /** SLE drill reads keyed `${siteUuid}|${metric}|${kind}` where kind is
   *  classifiers|impacted-users|impacted-aps|summary-trend — 404 by default
   *  (the drill is not scored). */
  sleDrill?: Record<string, { status?: number; body?: unknown }>;
  /** /orgs/{id}/devices/versions — defaults to an empty roster. */
  versions?: unknown;
  versionsStatus?: number;
  /** /orgs/{id}/licenses/usages — defaults to an empty roster. */
  usages?: unknown;
  usagesStatus?: number;
  /** /orgs/{id}/inventory — defaults to an empty roster. */
  inventory?: unknown[];
  inventoryStatus?: number;
  /** /orgs/{id}/wired_clients/search rows — defaults to an empty roster. */
  wiredClients?: unknown[];
  wiredStatus?: number;
  /** Site-scoped AP stats (/sites/{id}/stats/devices?type=ap) — defaults to
   *  an empty roster per site. */
  apStatsBySite?: Record<string, unknown[]>;
  apStatsStatusBySite?: Record<string, number>;
  /** Site floor plans (/sites/{id}/maps) — defaults to 200 [] (the live
   *  org's honest zero-maps answer). */
  mapsBySite?: Record<string, unknown[]>;
  mapsStatusBySite?: Record<string, number>;
  /** Site rogue/neighbor report (/sites/{id}/insights/rogues) — defaults to
   *  200 [] (nothing in earshot). */
  roguesBySite?: Record<string, unknown[]>;
  roguesStatusBySite?: Record<string, number>;
  /** Org audit log (/orgs/{id}/logs/search) — defaults to 200 {results: []}. */
  logsSearch?: unknown;
  logsStatus?: number;
  /** Org webhook subscriptions (/orgs/{id}/webhooks) — defaults to 200 []. */
  webhooks?: unknown[];
  webhookStatus?: number;
  /** Records every non-GET call on the org webhooks endpoint so the
   *  registration tests assert exactly what went on the wire — including
   *  that the secret travelled ONLY in the write body. */
  webhookWrites?: { method: string; url: string; body: unknown }[];
  /** Status answered for POST/PUT on the org webhooks endpoint (default 200). */
  webhookWriteStatus?: number;
  /** Site AP config walk (/sites/{id}/devices?type=ap) — defaults empty. */
  deviceConfigBySite?: Record<string, unknown[]>;
  deviceConfigStatusBySite?: Record<string, number>;
  /** Single-device reads keyed by device uuid, for the on-demand
   *  deviceDetail path — stats and config separately. */
  deviceStatsByUuid?: Record<string, { status?: number; body?: unknown }>;
  deviceConfigByUuid?: Record<string, { status?: number; body?: unknown }>;
  seenAuth?: { value: string | null };
  seenUrls?: string[];
}

/** Fake fetch answering the sites, stats/devices (org + site-scoped, single
 *  and walk), alarms, clients (wireless + wired), site WLANs, SLE summaries
 *  and drill reads, maps, AP config walks, versions, usages and inventory
 *  GETs. Most-specific routes first: the site-scoped stats/devices walk must
 *  win over the org one, and the single-device reads over both. */
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
    // Single-device stats (the deviceDetail path) — before the site walk.
    const deviceStatsMatch = /\/api\/v1\/sites\/[^/]+\/stats\/devices\/([^/?]+)/.exec(u);
    if (deviceStatsMatch) {
      const entry = opts.deviceStatsByUuid?.[deviceStatsMatch[1]];
      if (!entry) return new Response('{}', { status: 404 });
      const status = entry.status ?? 200;
      if (status !== 200) return new Response('{}', { status });
      return new Response(JSON.stringify(entry.body ?? {}), { status: 200 });
    }
    // Per-site AP stats walk — before the org /stats/devices below.
    const apStatsMatch = /\/api\/v1\/sites\/([^/]+)\/stats\/devices/.exec(u);
    if (apStatsMatch) {
      const status = opts.apStatsStatusBySite?.[apStatsMatch[1]] ?? 200;
      if (status !== 200) return new Response('{}', { status });
      return new Response(JSON.stringify(opts.apStatsBySite?.[apStatsMatch[1]] ?? []), { status: 200 });
    }
    // Per-site SLE metric reads — summaries AND the drill-down family.
    // 'summary-trend' must precede 'summary' in the alternation: unanchored,
    // the shorter alternative would swallow the trend suffix.
    const sleMatch = /\/api\/v1\/sites\/([^/]+)\/sle\/site\/[^/]+\/metric\/([^/]+)\/(summary-trend|classifiers|impacted-users|impacted-aps|summary)/.exec(
      u,
    );
    if (sleMatch) {
      if (sleMatch[3] === 'summary') {
        const entry = opts.sle?.[`${sleMatch[1]}|${sleMatch[2]}`];
        if (!entry) return new Response('{}', { status: 404 });
        const status = entry.status ?? 200;
        if (status !== 200) return new Response('{}', { status });
        return new Response(JSON.stringify(entry.body ?? {}), { status: 200 });
      }
      const entry = opts.sleDrill?.[`${sleMatch[1]}|${sleMatch[2]}|${sleMatch[3]}`];
      if (!entry) return new Response('{}', { status: 404 });
      const status = entry.status ?? 200;
      if (status !== 200) return new Response('{}', { status });
      return new Response(JSON.stringify(entry.body ?? {}), { status: 200 });
    }
    // Per-site WLANs (the site-scoped config surface) — reads AND the direct
    // write path (create/update/delete). Writes are recorded, body included.
    const wlanMatch = /\/api\/v1\/sites\/([^/]+)\/wlans(?:\/([^/?]+))?/.exec(u);
    if (wlanMatch) {
      const method = (init?.method ?? 'GET').toUpperCase();
      if (method !== 'GET') {
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        opts.wlanWrites?.push({ method, url: u, site: wlanMatch[1], wlanId: wlanMatch[2] ?? null, body });
        const status = opts.wlanWriteStatus ?? 200;
        if (status !== 200) return new Response('{}', { status });
        if (method === 'DELETE') return new Response(JSON.stringify({}), { status: 200 });
        // Mist answers a write with the written object — the echo the adapter
        // verifies against. 'unreadable' models an echo that never arrived.
        if (opts.wlanWriteBody === 'unreadable') return new Response('', { status: 200 });
        return new Response(JSON.stringify(body ?? {}), { status: 200 });
      }
      const status = opts.wlanStatusBySite?.[wlanMatch[1]] ?? 200;
      if (status !== 200) return new Response('{}', { status });
      return new Response(JSON.stringify(opts.wlansBySite?.[wlanMatch[1]] ?? []), { status: 200 });
    }
    // Per-site floor plans.
    const mapsMatch = /\/api\/v1\/sites\/([^/]+)\/maps/.exec(u);
    if (mapsMatch) {
      const status = opts.mapsStatusBySite?.[mapsMatch[1]] ?? 200;
      if (status !== 200) return new Response('{}', { status });
      return new Response(JSON.stringify(opts.mapsBySite?.[mapsMatch[1]] ?? []), { status: 200 });
    }
    // Per-site rogue/neighbor report.
    const roguesMatch = /\/api\/v1\/sites\/([^/]+)\/insights\/rogues/.exec(u);
    if (roguesMatch) {
      const status = opts.roguesStatusBySite?.[roguesMatch[1]] ?? 200;
      if (status !== 200) return new Response('{}', { status });
      return new Response(JSON.stringify(opts.roguesBySite?.[roguesMatch[1]] ?? []), { status: 200 });
    }
    // Org audit log search.
    if (u.includes('/logs/search')) {
      const status = opts.logsStatus ?? 200;
      if (status !== 200) return new Response('{}', { status });
      const body = opts.logsSearch ?? { results: [], total: 0 };
      return new Response(JSON.stringify(body), { status: 200 });
    }
    // Org webhook subscriptions — the list read AND the registration write.
    if (u.includes('/webhooks')) {
      const method = (init?.method ?? 'GET').toUpperCase();
      if (method !== 'GET') {
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        opts.webhookWrites?.push({ method, url: u, body });
        const status = opts.webhookWriteStatus ?? 200;
        if (status !== 200) return new Response('{}', { status });
        // Mist answers a write with the written object — id added, exactly
        // the echo the mapper reads back (secret-free by construction).
        return new Response(JSON.stringify({ id: 'wh-new-1', ...(body ?? {}) }), { status: 200 });
      }
      const status = opts.webhookStatus ?? 200;
      if (status !== 200) return new Response('{}', { status });
      return new Response(JSON.stringify(opts.webhooks ?? []), { status: 200 });
    }
    // Single-device config (the deviceDetail path) — before the site walk.
    const deviceConfigMatch = /\/api\/v1\/sites\/[^/]+\/devices\/([^/?]+)/.exec(u);
    if (deviceConfigMatch) {
      const entry = opts.deviceConfigByUuid?.[deviceConfigMatch[1]];
      if (!entry) return new Response('{}', { status: 404 });
      const status = entry.status ?? 200;
      if (status !== 200) return new Response('{}', { status });
      return new Response(JSON.stringify(entry.body ?? {}), { status: 200 });
    }
    // Per-site AP config walk (the map placements).
    const siteDevicesMatch = /\/api\/v1\/sites\/([^/]+)\/devices/.exec(u);
    if (siteDevicesMatch) {
      const status = opts.deviceConfigStatusBySite?.[siteDevicesMatch[1]] ?? 200;
      if (status !== 200) return new Response('{}', { status });
      return new Response(JSON.stringify(opts.deviceConfigBySite?.[siteDevicesMatch[1]] ?? []), { status: 200 });
    }
    if (u.includes('/wired_clients/search')) {
      const status = opts.wiredStatus ?? 200;
      if (status !== 200) return new Response('{}', { status });
      const rows = opts.wiredClients ?? [];
      return new Response(JSON.stringify({ results: rows, total: rows.length }), { status: 200 });
    }
    if (u.includes('/devices/versions')) {
      const status = opts.versionsStatus ?? 200;
      if (status !== 200) return new Response('{}', { status });
      return new Response(JSON.stringify(opts.versions ?? []), { status: 200 });
    }
    if (u.includes('/licenses/usages')) {
      const status = opts.usagesStatus ?? 200;
      if (status !== 200) return new Response('{}', { status });
      return new Response(JSON.stringify(opts.usages ?? []), { status: 200 });
    }
    if (u.includes('/inventory')) {
      const status = opts.inventoryStatus ?? 200;
      if (status !== 200) return new Response('{}', { status });
      return new Response(JSON.stringify(opts.inventory ?? []), { status: 200 });
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

  it('stamps a real firmware verdict from the versions read: at, behind, and cannot-assert', () => {
    const trains = new Map([['AP45', '0.14.29345']]);
    // Running train equals the recommendation → approved, and the target rides along.
    expect(mapMistDevice(AP_CONNECTED, sites, trains)).toMatchObject({
      firmware: '0.14.29345',
      firmwareApproved: true,
      firmwareTarget: '0.14.29345',
    });
    // Known running train, known recommendation, they differ → behind.
    expect(mapMistDevice({ ...AP_CONNECTED, version: '0.13.20001' }, sites, trains)).toMatchObject({
      firmwareApproved: false,
      firmwareTarget: '0.14.29345',
    });
    // No recommendation for the model → true, but asserting nothing: no target.
    const noTrain = mapMistDevice(AP_CONNECTED, sites);
    expect(noTrain?.firmwareApproved).toBe(true);
    expect(noTrain).not.toHaveProperty('firmwareTarget');
    // A recommendation exists but the running train is unknown → still not
    // provably behind (the boolean cannot say "unknown").
    expect(mapMistDevice({ ...AP_CONNECTED, version: undefined }, sites, trains)).toMatchObject({
      firmware: 'unknown',
      firmwareApproved: true,
      firmwareTarget: '0.14.29345',
    });
  });

  it('carries the plane’s own upgrade-state word verbatim, and omits it when unreported', () => {
    expect(mapMistDevice({ ...AP_CONNECTED, fwupdate: { status: 'inprogress', progress: 42 } }, sites)?.firmwareUpdate).toBe(
      'inprogress',
    );
    expect(mapMistDevice({ ...AP_CONNECTED, auto_upgrade_stat: { status: 'scheduled' } }, sites)?.firmwareUpdate).toBe(
      'scheduled',
    );
    expect(mapMistDevice(AP_CONNECTED, sites)).not.toHaveProperty('firmwareUpdate');
  });

  it('rides the inventory claim code through, and backfills state from connected only when the stats row is silent', () => {
    const hint = { claimCode: 'CLAIMCODE12345AB', connected: false };
    expect(mapMistDevice(AP_CONNECTED, sites, new Map(), hint)).toMatchObject({
      claimCode: 'CLAIMCODE12345AB',
      // The stats row's own 'connected' word always wins over the hint.
      state: 'up',
    });
    // No status word at all → the inventory's connected flag is the only fact.
    expect(mapMistDevice({ name: 'ap-x' }, sites, new Map(), hint)).toMatchObject({ state: 'down', stateTone: 'danger' });
    expect(mapMistDevice({ name: 'ap-x' }, sites, new Map(), { claimCode: null, connected: true })).toMatchObject({
      state: 'up',
    });
    // No hint → the claim-code key stays absent rather than invented.
    expect(mapMistDevice(AP_CONNECTED, sites)).not.toHaveProperty('claimCode');
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

  it('maps retry percentage, current throughput and group from the roster counters', () => {
    const rich = {
      ...CLIENT_ROW,
      tx_retries: 2451,
      rx_retries: 525,
      tx_pkts: 22426,
      rx_pkts: 12414,
      tx_bps: 54340,
      rx_bps: 29023,
      group: 'clinical-floors',
    };
    const c = mapMistClient(rich, sites, devices);
    // (2451+525)/(22426+12414) = 8.542% — computed, never assumed.
    expect(c?.retries).toBe('8.5%');
    expect(c?.tput).toBe('↑54 kbps · ↓29 kbps');
    expect(c?.group).toBe('clinical-floors');
  });

  it('claims no retries, throughput or group when the roster does not carry them', () => {
    const c = mapMistClient(CLIENT_ROW, sites, devices);
    expect(c).toMatchObject({ retries: '—', tput: '—', roams: '—', group: '—' });
    // A packet count of zero is not evidence of 0 retries — the ratio is undefined.
    const zero = mapMistClient({ ...CLIENT_ROW, tx_retries: 0, rx_retries: 0, tx_pkts: 0, rx_pkts: 0 }, sites, devices);
    expect(zero?.retries).toBe('—');
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

describe('mapMistSleSummary', () => {
  it('derives the success fraction from the sample counts, not the value series', () => {
    // total 120+80=200, degraded 10+10=20 → 0.9. The value series' unit is
    // not stated on the wire, so the counts are the only honest source.
    const m = mapMistSleSummary('coverage', sleSummary());
    expect(m).toMatchObject({ name: 'coverage', success: 0.9, samples: 200, degraded: 20 });
  });

  it('maps impact and classifiers with their own impacts and summed series', () => {
    const m = mapMistSleSummary('coverage', sleSummary());
    expect(m?.impact).toEqual({ numUsers: 4, numAps: 1, totalUsers: 120, totalAps: 12 });
    expect(m?.classifiers).toHaveLength(1);
    expect(m?.classifiers[0]).toEqual({
      name: 'signal-strength',
      samples: 20,
      degraded: 20,
      durationSec: 1200,
      impact: { numUsers: 3, numAps: 1, totalUsers: 120, totalAps: 12 },
    });
  });

  it('keeps success null when a count series is absent — never an assumed 0', () => {
    const noDegraded = sleSummary({ sle: { samples: { total: [50] } } });
    expect(mapMistSleSummary('roaming', noDegraded)).toMatchObject({ success: null, samples: 50, degraded: null });
    // An empty window is not a perfect score.
    const empty = sleSummary({ sle: { samples: { total: [], degraded: [] } } });
    expect(mapMistSleSummary('roaming', empty)?.success).toBeNull();
  });

  it('returns null for a payload with nothing readable', () => {
    expect(mapMistSleSummary('coverage', null)).toBeNull();
    expect(mapMistSleSummary('coverage', 'nope')).toBeNull();
    expect(mapMistSleSummary('coverage', {})).toBeNull();
  });
});

describe('mapMistSle', () => {
  const sitesMap = new Map([['site-uuid-a', 'Campus A']]);

  it('assembles a site row from its metrics, averaging only the dimensions present', () => {
    const metrics = [
      mapMistSleSummary('coverage', sleSummary())!, // 0.9
      mapMistSleSummary('capacity', sleSummary({ sle: { samples: { total: [100], degraded: [20] } } }))!, // 0.8
      mapMistSleSummary('roaming', sleSummary({ sle: { samples: { total: [100], degraded: [30] } } }))!, // 0.7
      mapMistSleSummary('ap-health', sleSummary({ sle: { samples: { total: [100], degraded: [40] } } }))!, // 0.6
      // time-to-connect has no headline column — it rides in metrics only.
      mapMistSleSummary('time-to-connect', sleSummary({ sle: { samples: { total: [100], degraded: [50] } } }))!,
    ];
    const row = mapMistSle('site-uuid-a', metrics, sitesMap);
    expect(row).toMatchObject({
      siteName: 'Campus A',
      coverage: 0.9,
      capacity: 0.8,
      roaming: 0.7,
      apHealth: 0.6,
      wan: null, // no WAN metric in the verified set
    });
    expect(row?.overall).toBeCloseTo(0.75, 10);
    expect(row?.metrics).toHaveLength(5);
  });

  it('keeps a dimension whose summary held no countable samples at null, not 0', () => {
    const metrics = [mapMistSleSummary('coverage', sleSummary())!];
    expect(mapMistSle('site-uuid-a', metrics, sitesMap)).toMatchObject({ coverage: 0.9, capacity: null, overall: 0.9 });
  });

  it('returns null when no metric summary succeeded', () => {
    expect(mapMistSle('site-uuid-a', [], sitesMap)).toBeNull();
  });
});

describe('parseMistFirmwareTrains', () => {
  it('lets the suggested tag win regardless of row order, per model', () => {
    const trains = parseMistFirmwareTrains(VERSION_ROWS);
    expect(trains.get('AP45')).toBe('0.14.29345'); // suggested, not the alpha listed first
    expect(trains.get('EX4400')).toBe('23.4R2-S3'); // untagged rows still count
  });

  it('reads a search-style envelope and the recommended/latest spellings, skipping junk', () => {
    const trains = parseMistFirmwareTrains({
      results: [
        { model: 'AP32', recommended: '0.12.19001' },
        { model: 'AP43', latest: '0.14.29001' },
        { version: 'orphan' },
        'junk',
      ],
    });
    expect(trains.get('AP32')).toBe('0.12.19001');
    expect(trains.get('AP43')).toBe('0.14.29001');
    expect(trains.size).toBe(2);
  });
});

describe('mapMistLicenseUsage', () => {
  const sitesMap = new Map([['site-uuid-a', 'Campus A']]);

  it('maps a full usage row with Mist’s own service→count maps verbatim', () => {
    expect(mapMistLicenseUsage(USAGE_ROWS[0], sitesMap)).toEqual({
      siteId: expect.any(String),
      siteName: 'Campus A',
      numDevices: 12,
      numAps: 9,
      usages: { 'SUB-WLAN': 9, 'SUB-SW': 3 },
      fullyLoaded: { 'SUB-WLAN': 9, 'SUB-SW': 3 },
    });
  });

  it('keeps unreported counts and maps at null rather than an authoritative 0', () => {
    expect(mapMistLicenseUsage(USAGE_ROWS[1], sitesMap)).toMatchObject({
      siteName: 'Multiple', // site-uuid-b is not in this map → the pseudo-site
      numDevices: 2,
      numAps: null,
      usages: { 'SUB-WLAN': 2 },
      fullyLoaded: null,
    });
  });

  it('drops a row with no site attribution, and junk rows', () => {
    expect(mapMistLicenseUsage({ num_devices: 3 }, sitesMap)).toBeNull();
    expect(mapMistLicenseUsage(null, sitesMap)).toBeNull();
  });
});

describe('mapMistWlan', () => {
  it('maps a site WLAN to a configured SsidObject with the site attributed', () => {
    expect(mapMistWlan(WLAN_EAP, 'Campus A')).toMatchObject({
      kind: 'ssid',
      origin: 'configured',
      name: 'MRDN-Clinical',
      vlan: '820',
      security: 'WPA2-Enterprise',
      plane: 'MIST',
      tone: 'accent',
      targets: 'Campus A · enabled',
    });
  });

  it('maps disabled and unreported states into the site-attributed targets', () => {
    expect(mapMistWlan({ ...WLAN_EAP, enabled: false }, 'Lab B')?.targets).toBe('Lab B · disabled');
    expect(mapMistWlan({ ssid: 'guest', auth: { type: 'psk' } }, 'Lab B')?.targets).toBe('Lab B · state not reported');
    expect(mapMistWlan({ ssid: 'open-wifi', auth: { type: 'open' } }, 'Lab B')?.security).toBe('Open');
  });

  it('PROVES the cleartext PSK and portal secret never reach the mapped row', () => {
    const row = mapMistWlan(WLAN_PSK, 'Campus A');
    const serialized = JSON.stringify(row);
    expect(serialized).not.toContain('cleartext-psk-DoNotLeak');
    expect(serialized).not.toContain('portal-secret-DoNotLeak');
    expect(serialized).not.toContain('DoNotLeak');
    // …while the row still says, honestly, that a PSK exists and is redacted.
    expect(row).toMatchObject({ security: 'WPA2-PSK', targets: 'Campus A · disabled' });
    expect(row?.note).toContain('PSK set — redacted by the portal');
    expect(row?.note).toContain('secret material redacted by the portal');
  });

  it('sweeps secret-shaped keys defensively without ever copying their values', () => {
    const row = mapMistWlan(
      { ssid: 'corp', auth: { type: 'eap', private_key: 'PRIV-DoNotLeak', passphrase: 'pass-DoNotLeak' }, radius_secret: 'rad-DoNotLeak' },
      'Campus A',
    );
    expect(JSON.stringify(row)).not.toContain('DoNotLeak');
    expect(row?.note).toContain('secret material redacted by the portal');
    expect(row?.note).not.toContain('PSK');
    // A row carrying no secrets carries no redaction note at all.
    expect(mapMistWlan(WLAN_EAP, 'Campus A')).not.toHaveProperty('note');
  });

  it('drops a row with no ssid', () => {
    expect(mapMistWlan({ auth: { type: 'open' } }, 'Campus A')).toBeNull();
    expect(mapMistWlan(null, 'Campus A')).toBeNull();
  });
});

describe('mapMistWiredClient', () => {
  const sites = new Map([['site-uuid-a', 'Campus A']]);
  const devices = new Map([['5c5b35000002', 'sw-cam01-1']]);

  it('maps a wired session with the switch+port attachment and no invented wireless readings', () => {
    expect(mapMistWiredClient(WIRED_ROW, sites, devices)).toMatchObject({
      name: 'rsch-ws-07',
      mac: '3c52821e07a1',
      ip: '10.44.22.31',
      medium: 'wired',
      siteName: 'Campus A',
      attach: 'sw-cam01-1', // switch_mac resolved through the inventory
      where: 'port 8',
      plane: 'MIST',
      auth: 'authenticated',
      vlan: '822',
      session: '148h 0m',
      // Byte counters are cumulative — never rendered as a rate.
      tput: '—',
      rssi: '—',
      snr: '—',
      retries: '—',
      roams: '—',
      health: '—',
      quality: null,
    });
  });

  it('falls back to the raw switch mac when the switch is not in the inventory, and drops junk', () => {
    expect(mapMistWiredClient(WIRED_ROW, sites, new Map())?.attach).toBe('5c5b35000002');
    expect(mapMistWiredClient({ hostname: 'nameless' }, sites)).toBeNull();
    expect(mapMistWiredClient(null, sites)).toBeNull();
  });

  it('reads the port_id spelling and an absent auth state honestly', () => {
    const row = mapMistWiredClient({ mac: 'aa:bb:cc:00:00:09', port_id: 'ge-0/0/11' }, sites);
    expect(row).toMatchObject({ where: 'port ge-0/0/11', auth: '—', vlan: '—', ip: 'pending' });
  });
});

describe('mapMistApStats', () => {
  const sites = new Map([['site-uuid-a', 'Campus A']]);

  it('maps the full rich row: radios in band order, ports, env, LLDP uplink, load', () => {
    const row = mapMistApStats(AP_STATS_ROW, sites);
    expect(row).toMatchObject({
      deviceName: 'ap-cam01-1',
      deviceUuid: 'dev-uuid-1',
      mac: 'aa:bb:cc:00:11:01',
      serial: 'SER-001',
      siteName: 'Campus A',
      numClients: 17,
      cpuUtilPct: 23,
      memTotalKb: 997_376,
      memUsedKb: 512_040,
      uptimeSec: 3_945_600,
      extIp: '198.51.100.44',
      dns: '10.44.1.10',
      gateway: '10.44.0.1',
      dhcpServer: '10.44.1.11',
      powerSrc: 'PoE 802.3at',
      powerConstrained: false,
    });
    expect(row?.radios.map((r) => r.band)).toEqual(['2.4 GHz', '5 GHz']);
    expect(row?.radios[0]).toMatchObject({ channel: 6, bandwidthMHz: 20, noiseFloorDbm: -92, utilAllPct: 58, numClients: 5 });
    expect(row?.radios[1]).toMatchObject({ channel: 36, utilTxPct: 12, utilRxInBssPct: 9, utilRxOtherBssPct: 7, utilNonWifiPct: 3 });
    expect(row?.ports[0]).toMatchObject({ name: 'eth0', up: true, speedMbps: 1000, fullDuplex: true, rxErrors: 0 });
    expect(row?.env).toMatchObject({ ambientTempC: 23.8, pressureHpa: 1004.2, humidityPct: 41 });
    // The LLDP uplink — the real AP → switch edge the topology edges need.
    expect(row?.lldpUplink).toEqual({
      systemName: 'CX6300-CORE',
      systemDesc: 'HPE JL660A',
      portId: '1/1/5',
      chassisId: 'b8:d4:e7:00:63:01',
      mgmtAddr: '10.44.1.2',
    });
  });

  it('keeps every unreported reading null on a lean row — never an assumed 0', () => {
    const row = mapMistApStats({ name: 'ap-bare', mac: 'aa:bb:cc:00:00:01' }, sites);
    expect(row).toMatchObject({
      deviceName: 'ap-bare',
      numClients: null,
      cpuUtilPct: null,
      powerConstrained: null,
      radios: [],
      ports: [],
      env: null,
      lldpUplink: null,
    });
    expect(mapMistApStats(null, sites)).toBeNull();
    expect(mapMistApStats({ model: 'AP45' }, sites)).toBeNull(); // no name and no mac
  });

  it('reads defensive shapes: non-object radio/port/env/lldp blocks map to empty', () => {
    expect(mapMistRadioStats('junk')).toEqual([]);
    expect(mapMistRadioStats({ band_5: 'junk' })).toEqual([]);
    expect(mapMistPortStats(null)).toEqual([]);
    expect(mapMistEnvStats({})).toBeNull(); // a block with no readings is "not reported"
    expect(mapMistEnvStats('junk')).toBeNull();
    expect(mapMistLldpUplink({})).toBeNull();
    expect(mapMistLldpUplink(null)).toBeNull();
  });
});

describe('mapMistMap / mapMistApPosition', () => {
  const sites = new Map([['site-uuid-a', 'Campus A']]);

  it('maps a floor plan with its dimensions and hosted image url', () => {
    expect(mapMistMap(MAP_ROW, sites)).toEqual({
      siteId: expect.any(String),
      siteName: 'Campus A',
      mapId: 'map-uuid-1',
      name: 'Campus A · floor 3',
      imageUrl: MAP_ROW.url,
      widthPx: 1200,
      heightPx: 800,
      widthM: 48,
      heightM: 32,
      orientationDeg: 0,
      aps: [],
    });
  });

  it('drops a map row with no id — the map id is the join key', () => {
    expect(mapMistMap({ name: 'no-id' }, sites)).toBeNull();
    expect(mapMistMap(null, sites)).toBeNull();
  });

  it('maps an AP config row to its placement, and skips unplaced APs honestly', () => {
    expect(mapMistApPosition(AP_CONFIG_ROW)).toEqual({
      mapId: 'map-uuid-1',
      ap: { deviceName: 'ap-cam01-1', deviceUuid: 'dev-uuid-1', mac: 'aabbcc001101', x: 320, y: 240 },
    });
    // No map_id: an unplaced AP is a real configuration state, not a failed map.
    expect(mapMistApPosition({ id: 'dev-uuid-9', name: 'ap-unplaced' })).toBeNull();
    expect(mapMistApPosition(null)).toBeNull();
  });
});

describe('SLE drill-down mappers', () => {
  it('reads impacted users from the results envelope and the users spelling', () => {
    const rows = [
      { mac: 'de:ad:0b:14:65:22', hostname: 's.mehta', degraded: 31 },
      { mac: '6e:41:0d:99:2b:af' }, // no name, no degraded count — both honest
      { hostname: 'no-mac' }, // junk, dropped
    ];
    expect(mapMistSleImpactedClients({ results: rows })).toEqual([
      { mac: 'de:ad:0b:14:65:22', name: 's.mehta', degraded: 31 },
      { mac: '6e:41:0d:99:2b:af', name: null, degraded: null },
    ]);
    expect(mapMistSleImpactedClients({ users: rows })).toHaveLength(2);
    expect(mapMistSleImpactedClients('junk')).toEqual([]);
  });

  it('reads impacted APs by name or hostname', () => {
    expect(mapMistSleImpactedAps({ aps: [{ mac: 'aabbcc001101', name: 'ap-cam01-1', num_degraded: 7 }] })).toEqual([
      { mac: 'aabbcc001101', name: 'ap-cam01-1', degraded: 7 },
    ]);
    expect(mapMistSleImpactedAps(null)).toEqual([]);
  });

  it('maps a summary-trend body, preserving null intervals as gaps', () => {
    expect(mapMistSleTrend(sleTrendBody())).toEqual({
      startSec: 1_767_225_600,
      endSec: 1_767_229_200,
      intervalSec: 600,
      total: [120, null, 80],
      degraded: [10, null, 10],
    });
    // A 200 with no samples object is a failed read, not an empty trend.
    expect(mapMistSleTrend({ start: 1 })).toBeNull();
    expect(mapMistSleTrend(null)).toBeNull();
  });
});

describe('mapApRadioDetail / mapApPortDetail', () => {
  it('converts a radio with the band convention and only provable status words', () => {
    const radio = mapMistRadioStats(AP_STATS_ROW.radio_stat)[1]; // band_5
    expect(mapApRadioDetail(radio, 1)).toMatchObject({
      number: 1,
      band: '5 GHz',
      channel: '36',
      bandwidth: '40 MHz',
      powerDbm: 14,
      clients: 12,
      channelUtilPct: 31,
      noiseFloorDbm: -96,
      retries: null, // not on the AP radio row
      channelQuality: null,
      status: '', // the stats row states no up/down of its own
    });
    // Only the config's DISABLED word is provable.
    expect(mapApRadioDetail(radio, 1, new Set(['5 GHz'])).status).toBe('DISABLED');
    expect(mapApRadioDetail(mapMistRadioStats(AP_STATS_ROW.radio_stat)[0], 0).number).toBe(0); // 2.4 GHz
  });

  it('converts a port with counters and the LLDP uplink as its neighbour', () => {
    const port = mapMistPortStats(AP_STATS_ROW.port_stat)[0];
    const lldp = mapMistLldpUplink(AP_STATS_ROW.lldp_stat);
    expect(mapApPortDetail(port, lldp)).toMatchObject({
      name: 'eth0',
      operStatus: 'up',
      speedBps: 1_000_000_000, // Mist's Mbps → bits per second
      duplex: 'full',
      uplink: true,
      neighbour: 'CX6300-CORE',
      neighbourPort: '1/1/5',
      neighbourType: 'HPE JL660A',
      counters: { rxBytes: 4_812_340_220, txBytes: 1_203_110_540, rxErrors: 0, rxPackets: null },
    });
    // No LLDP: no neighbour, no uplink claim.
    const plain = mapApPortDetail(port, null);
    expect(plain).not.toHaveProperty('neighbour');
    expect(plain).not.toHaveProperty('uplink');
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

  const SLE_METRIC_NAMES = ['time-to-connect', 'roaming', 'ap-availability', 'ap-health', 'capacity', 'coverage'];

  /** SLE fake entries for one site: every metric answers `body` (default the
   *  shared summary) with `status` (default 200). */
  function sleFor(
    site: string,
    body: Record<string, unknown> = sleSummary(),
    status?: number,
  ): Record<string, { status?: number; body?: unknown }> {
    return Object.fromEntries(
      SLE_METRIC_NAMES.map((m) => [`${site}|${m}`, { body, ...(status !== undefined ? { status } : {}) }]),
    );
  }

  it('walks the per-site SLE summaries — never the dead org-insights call', async () => {
    const seenUrls: string[] = [];
    const { adapter, st } = makeAdapter(fakeFetch({ sle: sleFor('site-uuid-a'), seenUrls }));
    const pull = await adapter.pull();
    expect(pull.mistSle).toHaveLength(1); // site-b's metrics 404 — it scores nothing
    expect(pull.mistSle?.[0]).toMatchObject({ siteName: 'Campus A', coverage: 0.9, capacity: 0.9, overall: 0.9 });
    expect(pull.mistSle?.[0].metrics).toHaveLength(6);
    expect(pull.mistSle?.[0].metrics?.[0].classifiers[0]).toMatchObject({ name: 'signal-strength', samples: 20 });
    expect(st.note).toContain('1 SLE scores');
    expect(st.health).toBe('healthy'); // a clean SLE read must not degrade the plane
    // The working surface is the site summary; the org-insights endpoint this
    // section first targeted (404s on live orgs) is never called. The
    // /insights/rogues walk is a different, live surface — it IS expected.
    expect(seenUrls.some((u) => u.includes('/insights/site'))).toBe(false);
    expect(seenUrls.some((u) => u.includes('/api/v1/sites/site-uuid-a/sle/site/site-uuid-a/metric/coverage/summary'))).toBe(
      true,
    );
  });

  it('omits a failed metric while the site’s other metrics still land, marked truncated', async () => {
    const sle = sleFor('site-uuid-a');
    sle['site-uuid-a|capacity'] = { status: 500 };
    const { adapter, st } = makeAdapter(fakeFetch({ sle }));
    const pull = await adapter.pull();
    expect(pull.mistSle).toHaveLength(1);
    expect(pull.mistSle?.[0]).toMatchObject({ coverage: 0.9, capacity: null });
    expect(pull.mistSle?.[0].metrics).toHaveLength(5);
    expect(pull.devices).toHaveLength(2); // the inventory still lands
    expect(st.note).toContain('truncated: sle');
    expect(pull.partial).toEqual(expect.arrayContaining(['mistSle']));
    expect(st.health).toBe('warning'); // a half-read dataset is not a complete sync
  });

  it('counts a 200 with nothing readable as a failed metric, not as an empty answer', async () => {
    const sle = sleFor('site-uuid-a');
    sle['site-uuid-a|capacity'] = { body: { detail: 'unexpected' } };
    const { adapter, st } = makeAdapter(fakeFetch({ sle }));
    const pull = await adapter.pull();
    expect(pull.mistSle?.[0]).toMatchObject({ coverage: 0.9, capacity: null });
    expect(pull.mistSle?.[0].metrics).toHaveLength(5);
    expect(st.note).toContain('truncated: sle');
  });

  it('omits the SLE section only when EVERY metric read failed', async () => {
    const { adapter, st } = makeAdapter(
      fakeFetch({ sle: { ...sleFor('site-uuid-a', sleSummary(), 500), ...sleFor('site-uuid-b', sleSummary(), 500) } }),
    );
    const pull = await adapter.pull();
    expect(pull.mistSle).toBeUndefined(); // omitted, never a fabricated all-null table
    expect(pull.devices).toHaveLength(2); // the inventory still lands
    expect(st.note).toContain('not available: sle');
    expect(pull.partial).toEqual(expect.arrayContaining(['mistSle']));
  });

  it('treats an org whose sites score nothing as no SLE surface, not a failure', async () => {
    const { adapter, st } = makeAdapter(fakeFetch({})); // every metric 404s
    const pull = await adapter.pull();
    expect(pull.mistSle).toBeUndefined();
    expect(pull.partial ?? []).not.toContain('mistSle');
    expect(st.health).toBe('healthy'); // a missing feature surface is not a failed read
  });

  it('refuses the SLE fan-out past the site budget rather than reading half of it', async () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ id: `site-uuid-${i}`, name: `Site ${i}` }));
    const seenUrls: string[] = [];
    const { adapter, st } = makeAdapter(fakeFetch({ sitePages: [many], seenUrls }));
    const pull = await adapter.pull();
    expect(pull.mistSle).toBeUndefined();
    expect(seenUrls.some((u) => u.includes('/sle/'))).toBe(false);
    expect(st.note).toMatch(/not available:.*\bsle\b/);
  });

  it('omits an optional section it could not read instead of emptying it', async () => {
    const { adapter, st } = makeAdapter(fakeFetch({ alarmStatus: 500, clientStatus: 403 }));
    const pull = await adapter.pull();
    // Omitted, NOT [] — downstream must read them as unknown, never as zero.
    expect(pull.alerts).toBeUndefined();
    expect(pull.clients).toBeUndefined();
    expect(pull.devices).toHaveLength(2); // the inventory still lands
    // The org device-stats rows carry NO usable client fact (the live org
    // proves num_clients is not on them), and the AP-stats walk defaulted to
    // an empty read here — so there is no honest fallback and the column
    // reads '—', with no device-reported total invented in the note.
    expect(pull.sites?.[0].clients).toBe('—');
    expect(st.note).not.toContain('AP stats');
    expect(st.note).not.toContain('client sessions');
    expect(st.note).toContain('not available: alarms, clients');
    expect(st.health).toBe('warning'); // never promoted to healthy over a missing dataset
    // The datasets that could not be read are named for the registry/poller.
    expect(pull.partial).toEqual(expect.arrayContaining(['alerts', 'clients']));
  });

  it("reports '—', not 0, for every site's client column when the roster is refused", async () => {
    // Past the fan-out budget there is no roster AND the AP-stats walk is
    // refused by the same budget — so there is no honest fallback either:
    // '—' is the only answer.
    const many = Array.from({ length: 9 }, (_, i) => ({ id: `site-uuid-${i}`, name: `Site ${i}` }));
    const { adapter, st } = makeAdapter(fakeFetch({ sitePages: [many] }));
    const pull = await adapter.pull();
    expect(pull.clients).toBeUndefined();
    expect(pull.mistApStats).toBeUndefined();
    expect(pull.mistMaps).toBeUndefined();
    expect(pull.sites?.every((s) => s.clients === '—')).toBe(true);
    expect(st.note).not.toContain('AP stats');
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
    const deviceCalls = seenUrls.filter((u) => u.includes('/orgs/org-123/stats/devices'));
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
    expect(seenUrls.filter((u) => u.includes('/orgs/org-123/stats/devices'))).toHaveLength(3);
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

  it('claims read-only inventory PLUS configRead PLUS the reviewed direct SSID write', () => {
    const { adapter, st } = makeAdapter(fakeFetch({}));
    // brokeredWrite stays false — the ticketed broker never pushes to Mist;
    // the SSID write is the direct, review-gated path.
    expect(adapter.capabilities()).toEqual({ localShell: false, brokeredWrite: false, configRead: true, directWrite: true });
    // Published on the shared state too, so a consumer reading PlaneState sees it.
    expect(st.capabilities).toEqual({ localShell: false, brokeredWrite: false, configRead: true, directWrite: true });
  });

  it('walks the SITE-scoped WLANs and merges identical SSIDs across sites — never the org endpoint', async () => {
    const seenUrls: string[] = [];
    const { adapter, calls, st } = makeAdapter(
      fakeFetch({ wlansBySite: { 'site-uuid-a': [WLAN_EAP, WLAN_PSK], 'site-uuid-b': [WLAN_EAP] }, seenUrls }),
    );
    const pull = await adapter.pull();
    expect(pull.config?.mode).toBe('configured');
    expect(pull.config?.ssids).toHaveLength(2);
    expect(pull.config?.ssids?.[0]).toMatchObject({ name: 'MRDN-Clinical', targets: 'Campus A + Lab B · enabled' });
    expect(pull.config?.ssids?.[1]).toMatchObject({
      name: 'MRDN-Guest',
      targets: 'Campus A · disabled',
      note: expect.stringContaining('PSK set — redacted by the portal'),
    });
    // The org-level /wlans (empty on a live org) is never consulted.
    expect(seenUrls.some((u) => u.includes('/orgs/org-123/wlans'))).toBe(false);
    expect(seenUrls.some((u) => u.includes('/api/v1/sites/site-uuid-a/wlans'))).toBe(true);
    // THE SECURITY PROOF: the cleartext secrets on the site payload appear in
    // no mapped output and in no call-log line.
    expect(JSON.stringify(pull.config)).not.toContain('DoNotLeak');
    expect(calls.every((c) => !c.path.includes('DoNotLeak'))).toBe(true);
    expect(st.note ?? '').not.toContain('DoNotLeak');
  });

  it('reports ssids unavailable, all-or-nothing, when a site’s WLAN read fails', async () => {
    const { adapter, st } = makeAdapter(
      fakeFetch({ wlansBySite: { 'site-uuid-a': [WLAN_EAP] }, wlanStatusBySite: { 'site-uuid-b': 500 } }),
    );
    const pull = await adapter.pull();
    // Half an org's WLANs presented as the inventory is the lie the contract
    // forbids: the section reports its gap instead.
    expect(pull.config).toEqual({
      mode: 'configured',
      unavailable: ['ssids'],
      source: 'Mist /api/v1/sites/{site}/wlans · 2 sites',
    });
    expect(pull.devices?.length).toBeGreaterThan(0); // non-fatal to the inventory
    expect(st.note).toContain('not available: config');
    expect(pull.partial).toEqual(expect.arrayContaining(['config']));
  });

  it('refuses the WLAN fan-out past the site budget rather than reading half of it', async () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ id: `site-uuid-${i}`, name: `Site ${i}` }));
    const seenUrls: string[] = [];
    const { adapter } = makeAdapter(fakeFetch({ sitePages: [many], seenUrls }));
    const pull = await adapter.pull();
    expect(pull.config?.ssids).toBeUndefined();
    expect(pull.config?.unavailable).toEqual(['ssids']);
    expect(seenUrls.some((u) => u.includes('/wlans'))).toBe(false);
  });

  it('stamps real firmware verdicts from the versions read — at and behind', async () => {
    const { adapter } = makeAdapter(fakeFetch({ versions: VERSION_ROWS }));
    const pull = await adapter.pull();
    // AP45 runs exactly the suggested train; EX4400 carries no running version
    // on the stats row, so it cannot be proven behind (target still rides).
    expect(pull.devices?.[0]).toMatchObject({ firmware: '0.14.29345', firmwareApproved: true, firmwareTarget: '0.14.29345' });
    expect(pull.devices?.[1]).toMatchObject({ firmware: 'unknown', firmwareApproved: true, firmwareTarget: '23.4R2-S3' });

    const behind = makeAdapter(
      fakeFetch({ versions: VERSION_ROWS, devicePages: [[{ ...AP_CONNECTED, version: '0.13.20001' }, SW_DISCONNECTED]] }),
    );
    const behindPull = await behind.adapter.pull();
    expect(behindPull.devices?.[0]).toMatchObject({ firmware: '0.13.20001', firmwareApproved: false, firmwareTarget: '0.14.29345' });
  });

  it('treats a failed versions read as lost enrichment, not a failed pull', async () => {
    const { adapter, st } = makeAdapter(fakeFetch({ versionsStatus: 500 }));
    const pull = await adapter.pull();
    expect(pull.devices).toHaveLength(2);
    expect(pull.devices?.[0]).toMatchObject({ firmwareApproved: true }); // the cannot-assert default
    expect(pull.devices?.[0]).not.toHaveProperty('firmwareTarget');
    expect(st.health).toBe('healthy'); // enrichment loss is not a missing dataset
  });

  it('pulls per-site licence usages into the pull', async () => {
    const { adapter, st } = makeAdapter(fakeFetch({ usages: USAGE_ROWS }));
    const pull = await adapter.pull();
    expect(pull.mistLicenseUsages).toHaveLength(2);
    expect(pull.mistLicenseUsages?.[0]).toMatchObject({
      siteName: 'Campus A',
      numDevices: 12,
      usages: { 'SUB-WLAN': 9, 'SUB-SW': 3 },
    });
    expect(st.note).toContain('2 sites with licence usage');
    expect(st.health).toBe('healthy');
  });

  it('omits the usages section non-fatally when the read fails', async () => {
    const { adapter, st } = makeAdapter(fakeFetch({ usagesStatus: 500 }));
    const pull = await adapter.pull();
    expect(pull.mistLicenseUsages).toBeUndefined();
    expect(pull.devices).toHaveLength(2); // the inventory still lands
    expect(st.note).toContain('not available: licenses');
    expect(pull.partial).toEqual(expect.arrayContaining(['mistLicenseUsages']));
  });

  it('enriches devices with the inventory claim code, without inventing state', async () => {
    const { adapter } = makeAdapter(fakeFetch({ inventory: INVENTORY_ROWS }));
    const pull = await adapter.pull();
    // Joined by mac on the AP, by serial on the switch.
    expect(pull.devices?.[0]).toMatchObject({ name: 'ap-cam01-1', claimCode: 'CLAIMCODE12345AB', state: 'up' });
    expect(pull.devices?.[1]).toMatchObject({ name: 'sw-cam01-1', claimCode: 'WIR3DCLAIMC0DE9', state: 'down' });
  });

  it('treats a failed inventory read as lost enrichment, not a failed pull', async () => {
    const { adapter, st } = makeAdapter(fakeFetch({ inventoryStatus: 500 }));
    const pull = await adapter.pull();
    expect(pull.devices).toHaveLength(2);
    expect(pull.devices?.[0]).not.toHaveProperty('claimCode');
    expect(st.health).toBe('healthy'); // enrichment loss is not a missing dataset
  });

  it('walks the per-site AP rich stats into the pull — radios, ports, env, LLDP edge', async () => {
    const { adapter, st } = makeAdapter(fakeFetch({ apStatsBySite: { 'site-uuid-a': [AP_STATS_ROW] } }));
    const pull = await adapter.pull();
    expect(pull.mistApStats).toHaveLength(1);
    expect(pull.mistApStats?.[0]).toMatchObject({
      deviceName: 'ap-cam01-1',
      siteName: 'Campus A',
      numClients: 17,
      powerSrc: 'PoE 802.3at',
    });
    expect(pull.mistApStats?.[0].radios.map((r) => r.band)).toEqual(['2.4 GHz', '5 GHz']);
    // The LLDP uplink is the topology-edge data: AP → switch + port, on the pull.
    expect(pull.mistApStats?.[0].lldpUplink).toMatchObject({ systemName: 'CX6300-CORE', portId: '1/1/5' });
    expect(st.note).toContain('1 APs with rich stats');
    expect(st.health).toBe('healthy');
  });

  it('omits the AP stats section non-fatally when the walk fails', async () => {
    const { adapter, st } = makeAdapter(fakeFetch({ apStatsStatusBySite: { 'site-uuid-a': 500 } }));
    const pull = await adapter.pull();
    expect(pull.mistApStats).toBeUndefined();
    expect(pull.devices).toHaveLength(2); // the inventory still lands
    expect(st.note).toContain('not available: apstats');
    expect(pull.partial).toEqual(expect.arrayContaining(['mistApStats']));
  });

  it('refuses the AP-stats fan-out past the site budget rather than reading half of it', async () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ id: `site-uuid-${i}`, name: `Site ${i}` }));
    const seenUrls: string[] = [];
    const { adapter, st } = makeAdapter(fakeFetch({ sitePages: [many], seenUrls }));
    const pull = await adapter.pull();
    expect(pull.mistApStats).toBeUndefined();
    expect(seenUrls.some((u) => /\/sites\/[^/]+\/stats\/devices/.test(u))).toBe(false);
    expect(st.note).toMatch(/not available:.*\bapstats\b/);
  });

  it('falls back to the summed per-AP num_clients for the Sites column only when the roster is unread', async () => {
    // Roster 403, AP stats read OK: the site column gets the device-reported
    // sum, and the note names the source so it never reads as a roster count.
    const { adapter, st } = makeAdapter(
      fakeFetch({ clientStatus: 403, apStatsBySite: { 'site-uuid-a': [AP_STATS_ROW, { ...AP_STATS_ROW, id: 'dev-uuid-2', name: 'ap-cam01-2', num_clients: 8 }] } }),
    );
    const pull = await adapter.pull();
    expect(pull.clients).toBeUndefined();
    expect(pull.sites?.[0]).toMatchObject({ name: 'Campus A', clients: '25' }); // 17 + 8
    expect(pull.sites?.[1].clients).toBe('—'); // no AP rows at Lab B — no invented 0
    expect(st.note).toContain('client counts from AP stats (roster unavailable)');
    expect(st.note).toContain('not available: clients');

    // Roster read OK: the roster count wins and the AP-stats sum is never blended.
    const roster = makeAdapter(
      fakeFetch({ clientsBySite: { 'site-uuid-a': [CLIENT_ROW] }, apStatsBySite: { 'site-uuid-a': [AP_STATS_ROW] } }),
    );
    const rosterPull = await roster.adapter.pull();
    expect(rosterPull.sites?.[0].clients).toBe('1'); // the roster's, not 17
    expect(roster.st.note).not.toContain('AP stats (roster unavailable)');
  });

  it('refuses a per-site num_clients sum when any AP row withholds the field', async () => {
    const partial = { ...AP_STATS_ROW, id: 'dev-uuid-2', name: 'ap-cam01-2' };
    delete (partial as Record<string, unknown>).num_clients;
    const { adapter } = makeAdapter(
      fakeFetch({ clientStatus: 403, apStatsBySite: { 'site-uuid-a': [AP_STATS_ROW, partial] } }),
    );
    const pull = await adapter.pull();
    // 17 + unknown is not 17 — a partial sum reads as an undercount.
    expect(pull.sites?.[0].clients).toBe('—');
  });

  it('merges the org wired roster into the clients dataset with medium wired', async () => {
    const { adapter, st } = makeAdapter(
      fakeFetch({
        clientsBySite: { 'site-uuid-a': [CLIENT_ROW] },
        wiredClients: [WIRED_ROW],
      }),
    );
    const pull = await adapter.pull();
    expect(pull.clients).toHaveLength(2);
    expect(pull.clients?.map((c) => c.medium)).toEqual(['wireless', 'wired']);
    expect(pull.clients?.[1]).toMatchObject({ name: 'rsch-ws-07', attach: 'sw-cam01-1', where: 'port 8', siteName: 'Campus A' });
    expect(pull.sites?.[0]).toMatchObject({ clients: '2' }); // one roster, both media
    expect(st.note).toContain('2 client sessions (1 wired)');
    expect(st.health).toBe('healthy');
  });

  it('marks clients truncated — not unavailable — when only the wired half fails', async () => {
    const { adapter, st } = makeAdapter(
      fakeFetch({ clientsBySite: { 'site-uuid-a': [CLIENT_ROW] }, wiredStatus: 500 }),
    );
    const pull = await adapter.pull();
    expect(pull.clients).toHaveLength(1); // the wireless rows still ship
    expect(st.note).toContain('truncated: clients');
    expect(pull.partial).toEqual(expect.arrayContaining(['clients']));
    expect(st.health).toBe('warning');
  });

  it('omits the whole clients dataset when the wireless half fails — a wired-only roster is not the roster', async () => {
    const { adapter, st } = makeAdapter(fakeFetch({ clientStatus: 403, wiredClients: [WIRED_ROW] }));
    const pull = await adapter.pull();
    expect(pull.clients).toBeUndefined();
    expect(st.note).toContain('not available: clients');
    expect(st.note).not.toContain('truncated: clients'); // already named missing
    expect(pull.partial).toEqual(expect.arrayContaining(['clients']));
  });

  it('walks the floor plans and joins the AP config placements onto them', async () => {
    const { adapter, st } = makeAdapter(
      fakeFetch({
        mapsBySite: { 'site-uuid-a': [MAP_ROW] },
        deviceConfigBySite: { 'site-uuid-a': [AP_CONFIG_ROW] },
      }),
    );
    const pull = await adapter.pull();
    expect(pull.mistMaps).toHaveLength(1);
    expect(pull.mistMaps?.[0]).toMatchObject({
      siteName: 'Campus A',
      mapId: 'map-uuid-1',
      widthPx: 1200,
      heightPx: 800,
      widthM: 48,
      imageUrl: MAP_ROW.url,
    });
    expect(pull.mistMaps?.[0].aps).toEqual([
      { deviceName: 'ap-cam01-1', deviceUuid: 'dev-uuid-1', mac: 'aabbcc001101', x: 320, y: 240 },
    ]);
    expect(st.note).toContain('1 floor plans');
    expect(st.health).toBe('healthy');
  });

  it('ships an honest empty maps array — the live org answer is 200 []', async () => {
    const { adapter, st } = makeAdapter(fakeFetch({}));
    const pull = await adapter.pull();
    expect(pull.mistMaps).toEqual([]); // read, and genuinely nothing published
    expect(st.note).not.toContain('floor plans');
    expect(st.note).not.toContain('maps');
    expect(st.health).toBe('healthy'); // a missing feature surface is not a failed read
  });

  it('omits the maps section non-fatally when the walk fails', async () => {
    const { adapter, st } = makeAdapter(fakeFetch({ mapsStatusBySite: { 'site-uuid-a': 500 } }));
    const pull = await adapter.pull();
    expect(pull.mistMaps).toBeUndefined();
    expect(pull.devices).toHaveLength(2); // the inventory still lands
    expect(st.note).toContain('not available: maps');
    expect(pull.partial).toEqual(expect.arrayContaining(['mistMaps']));
  });

  it('leaves an AP off a map the maps walk did not return rather than inventing one', async () => {
    const { adapter } = makeAdapter(
      fakeFetch({
        mapsBySite: { 'site-uuid-a': [] }, // no maps published…
        deviceConfigBySite: { 'site-uuid-a': [AP_CONFIG_ROW] }, // …yet the AP claims a placement
      }),
    );
    const pull = await adapter.pull();
    expect(pull.mistMaps).toEqual([]); // the placement joins nothing
  });

  it('isComplete requires apiHost, orgId and token', () => {
    expect(MistAdapter.isComplete(CREDS)).toBe(true);
    expect(MistAdapter.isComplete({ apiHost: 'api.mist.com', token: 'x' })).toBe(false);
    expect(MistAdapter.isComplete({ apiHost: ' ', orgId: 'o', token: 't' })).toBe(false);
    expect(MistAdapter.isComplete(null)).toBe(false);
  });
});

// -- ON-DEMAND detail reads ----------------------------------------------------

describe('mapMistRogueAp', () => {
  const sites = new Map([
    ['site-uuid-a', 'Campus A'],
    ['site-uuid-b', 'Lab B'],
  ]);

  it('maps the full row, with the on-your-wire flag carried as a tri-state', () => {
    const row = mapMistRogueAp(
      { ssid: 'FREE-WIFI', bssid: '5c:5b:35:00:0e:77', channel: 6, avg_rssi: -48, num_aps: 2, seen_on_lan: true, site_id: 'site-uuid-a' },
      sites,
    );
    expect(row).toEqual({
      siteId: 'ext-campus-a',
      siteName: 'Campus A',
      bssid: '5c:5b:35:00:0e:77',
      ssid: 'FREE-WIFI',
      channel: 6,
      avgRssi: -48,
      numAps: 2,
      seenOnLan: true,
    });
    expect(mapMistRogueAp({ bssid: 'aa', seen_on_lan: false, site_id: 'site-uuid-a' }, sites)?.seenOnLan).toBe(false);
    // Absent flag stays null — never an assumed safe-looking false.
    expect(mapMistRogueAp({ bssid: 'aa', site_id: 'site-uuid-a' }, sites)?.seenOnLan).toBeNull();
  });

  it('falls back to the walk’s site when the row carries no site_id, and drops junk rows', () => {
    const row = mapMistRogueAp({ bssid: 'aa:bb', ssid: 'x' }, sites, 'site-uuid-b');
    expect(row).toMatchObject({ siteName: 'Lab B' });
    // A row's own site_id wins over the hint.
    expect(mapMistRogueAp({ bssid: 'aa', site_id: 'site-uuid-a' }, sites, 'site-uuid-b')?.siteName).toBe('Campus A');
    expect(mapMistRogueAp({ ssid: 'no-bssid' }, sites)).toBeNull();
    expect(mapMistRogueAp(null, sites)).toBeNull();
  });
});

describe('MistAdapter.pull — the rogues walk', () => {
  const ON_LAN = { ssid: 'FREE-WIFI', bssid: '5c:5b:35:00:0e:77', channel: 6, avg_rssi: -48, num_aps: 2, seen_on_lan: true };
  const NEIGHBOR = { ssid: 'CoffeeShop', bssid: 'b8:6a:f1:02:44:01', channel: 11, avg_rssi: -83, num_aps: 1, seen_on_lan: false };

  it('pulls the per-site rogue report and counts the on-your-wire rows in the note', async () => {
    const { adapter, st } = makeAdapter(
      fakeFetch({ roguesBySite: { 'site-uuid-a': [ON_LAN, NEIGHBOR], 'site-uuid-b': [NEIGHBOR] } }),
    );
    const pull = await adapter.pull();
    expect(pull.mistRogues).toHaveLength(3);
    expect(pull.mistRogues?.[0]).toMatchObject({ bssid: '5c:5b:35:00:0e:77', seenOnLan: true, siteName: 'Campus A' });
    expect(pull.mistRogues?.[2]).toMatchObject({ siteName: 'Lab B' }); // the walk's site, no site_id on the row
    expect(st.note).toContain('3 rogue/neighbor BSSIDs (1 on your wire)');
    expect(st.health).toBe('healthy');
  });

  it('a site with nothing in earshot is a real empty, not a failure', async () => {
    const { adapter, st } = makeAdapter(fakeFetch({}));
    const pull = await adapter.pull();
    expect(pull.mistRogues).toEqual([]); // present-and-empty: read, and nothing heard
    expect(st.note).not.toContain('rogue');
    expect(st.health).toBe('healthy');
  });

  it('a failed walk omits the dataset and names the section — never an empty array', async () => {
    const { adapter, st } = makeAdapter(fakeFetch({ roguesStatusBySite: { 'site-uuid-a': 500 } }));
    const pull = await adapter.pull();
    expect(pull.mistRogues).toBeUndefined();
    expect(st.note).toMatch(/not available:.*\brogues\b/);
    expect(pull.partial).toEqual(expect.arrayContaining(['mistRogues']));
    expect(st.health).toBe('warning');
  });

  it('refuses the fan-out past the site budget rather than reading half of it', async () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ id: `site-uuid-${i}`, name: `Site ${i}` }));
    const seenUrls: string[] = [];
    const { adapter, st } = makeAdapter(fakeFetch({ sitePages: [many], seenUrls }));
    const pull = await adapter.pull();
    expect(pull.mistRogues).toBeUndefined();
    expect(seenUrls.some((u) => u.includes('/insights/rogues'))).toBe(false);
    expect(st.note).toMatch(/not available:.*\brogues\b/);
    expect(pull.partial).toEqual(expect.arrayContaining(['mistRogues']));
  });
});

describe('mapMistAuditLogEntry', () => {
  const sites = new Map([['site-uuid-a', 'Campus A']]);

  it('maps admin/message/timestamp and resolves the site scope', () => {
    const row = mapMistAuditLogEntry(
      { id: 'log-1', admin: 'n.osei@example.com', message: "Updated WLAN 'MRDN'", timestamp: 1_785_000_000_000, site_id: 'site-uuid-a' },
      sites,
    );
    expect(row).toMatchObject({
      id: 'log-1',
      admin: 'n.osei@example.com',
      message: "Updated WLAN 'MRDN'",
      at: new Date(1_785_000_000_000).toISOString(),
      siteName: 'Campus A',
    });
    // Epoch seconds read as well as ms; an admin object resolves defensively.
    expect(
      mapMistAuditLogEntry({ id: 'l2', admin: { email: 'a@b.c' }, message: 'x', timestamp: 1_785_000_000 }, sites),
    ).toMatchObject({ admin: 'a@b.c', at: new Date(1_785_000_000_000).toISOString() });
    // An unresolvable site stays null/null — not the 'multiple' pseudo-site.
    const unscoped = mapMistAuditLogEntry({ id: 'l3', message: 'x', site_id: 'site-uuid-gone' }, sites);
    expect(unscoped).toMatchObject({ siteId: null, siteName: null });
    expect(mapMistAuditLogEntry({ timestamp: 1_785_000_000_000 }, sites)).toBeNull(); // no id, no message
  });

  it('redacts every secret-shaped value in before/after — the cleartext PSK never survives', () => {
    const row = mapMistAuditLogEntry(
      {
        id: 'log-9',
        message: 'Updated WLAN',
        before: { ssid: 'MRDN', auth: { type: 'psk', psk: 'super-secret-psk', nested: [{ shared_secret: 'abc' }] } },
        after: { ssid: 'MRDN', api_token: 'tok-123' },
      },
      sites,
    );
    expect(row?.before).toBeDefined();
    expect(row?.after).toBeDefined();
    expect(JSON.stringify(row)).not.toContain('super-secret-psk');
    expect(JSON.stringify(row)).not.toContain('tok-123');
    // The VALUES are gone; the key names stay (keys are not secrets — the
    // reviewer still sees WHICH field changed).
    expect(JSON.stringify(row)).not.toContain('"abc"');
    expect(row?.before).toContain('<redacted by the portal>');
    // The change itself is still visible — only the values are masked.
    expect(row?.before).toContain('MRDN');
  });

  it('scrubs standalone and truncates a whale of a snapshot with the truncation stated', () => {
    expect(scrubMistAuditSnapshot(null)).toBeUndefined();
    expect(scrubMistAuditSnapshot({ password: 'x', keep: 1 })).toBe('{"password":"<redacted by the portal>","keep":1}');
    const big = scrubMistAuditSnapshot({ pad: 'x'.repeat(5000) });
    expect(big).toContain('(truncated)');
    expect(big!.length).toBeLessThan(1300);
  });
});

describe('MistAdapter.mistAuditLog — the on-demand org audit read', () => {
  const LOGS = {
    results: [
      { id: 'log-old', admin: 'a@b.c', message: 'first', timestamp: 1_785_000_000_000 },
      { id: 'log-new', admin: 'd@e.f', message: 'latest', timestamp: 1_785_100_000_000, site_id: 'site-uuid-a' },
    ],
    total: 2,
  };

  it('reads the org log newest-first, capped, with the site scope resolved from the last pull', async () => {
    const { adapter } = makeAdapter(fakeFetch({ logsSearch: LOGS }));
    await adapter.pull(); // the site-name map rides the pull
    const detail = await adapter.mistAuditLog(25);
    expect(detail.source.sections.logs).toBe('ok');
    expect(detail.entries?.map((e) => e.id)).toEqual(['log-new', 'log-old']);
    expect(detail.entries?.[0]).toMatchObject({ siteName: 'Campus A' });
  });

  it('honours the limit and reports an empty org log honestly', async () => {
    const { adapter } = makeAdapter(fakeFetch({ logsSearch: LOGS }));
    const one = await adapter.mistAuditLog(1);
    expect(one.entries).toHaveLength(1);
    const { adapter: emptyAdapter } = makeAdapter(fakeFetch({}));
    const empty = await emptyAdapter.mistAuditLog(25);
    expect(empty.entries).toEqual([]);
    expect(empty.source.sections.logs).toBe('empty');
  });

  it('a failed search marks the section failed with the reason — never an empty log', async () => {
    const { adapter } = makeAdapter(fakeFetch({ logsStatus: 500 }));
    const detail = await adapter.mistAuditLog(25);
    expect(detail.entries).toBeUndefined();
    expect(detail.source.sections.logs).toBe('failed');
    expect(detail.source.note).toContain('500');
  });
});

describe('mapMistWebhookSubscription', () => {
  it('whitelist-maps the row: the secret’s presence only, never its value', () => {
    const row = mapMistWebhookSubscription({
      id: 'wh-1',
      name: 'portal',
      url: 'https://portal.example.com/api/hooks/mist',
      topics: ['alarms', 'device-updowns'],
      enabled: true,
      secret: 'the-actual-secret',
    });
    expect(row).toEqual({
      id: 'wh-1',
      name: 'portal',
      url: 'https://portal.example.com/api/hooks/mist',
      topics: ['alarms', 'device-updowns'],
      enabled: true,
      secretConfigured: true,
    });
    expect(JSON.stringify(row)).not.toContain('the-actual-secret');
    expect(mapMistWebhookSubscription({ id: 'w2', secret: '' })?.secretConfigured).toBe(false);
    expect(mapMistWebhookSubscription({ id: 'w3' })?.secretConfigured).toBeNull(); // not stated
    expect(mapMistWebhookSubscription({ name: 'no id' })).toBeNull();
  });
});

describe('MistAdapter webhook management — list and reviewed write', () => {
  const EXISTING = {
    id: 'wh-1',
    name: 'hpe-network-tools receiver',
    url: 'https://portal.example.com/api/hooks/mist',
    topics: ['alarms'],
    enabled: true,
    secret: 'live-secret',
  };

  it('lists the org subscriptions secret-free, and nulls on a failed read', async () => {
    const { adapter } = makeAdapter(fakeFetch({ webhooks: [EXISTING] }));
    const list = await adapter.listMistWebhooks();
    expect(list).toHaveLength(1);
    expect(list?.[0]).toMatchObject({ id: 'wh-1', secretConfigured: true });
    expect(JSON.stringify(list)).not.toContain('live-secret');

    const { adapter: failing } = makeAdapter(fakeFetch({ webhookStatus: 500 }));
    expect(await failing.listMistWebhooks()).toBeNull();
  });

  it('POSTs a create and PUTs an update, the secret only ever in the write body', async () => {
    const webhookWrites: { method: string; url: string; body: unknown }[] = [];
    const seenUrls: string[] = [];
    const { adapter, calls } = makeAdapter(fakeFetch({ webhookWrites, seenUrls }));

    const created = await adapter.writeMistWebhook(null, {
      url: 'https://portal.example.com/api/hooks/mist',
      name: 'hpe-network-tools receiver',
      topics: ['alarms', 'client-sessions', 'device-updowns'],
      enabled: true,
      secret: 'rotation-secret',
    });
    expect(created.ok).toBe(true);
    expect(webhookWrites).toHaveLength(1);
    expect(webhookWrites[0].method).toBe('POST');
    expect(webhookWrites[0].url).toContain('/api/v1/orgs/org-123/webhooks');
    expect(webhookWrites[0].body).toMatchObject({ url: 'https://portal.example.com/api/hooks/mist', secret: 'rotation-secret' });

    const updated = await adapter.writeMistWebhook('wh-1', {
      url: 'https://portal.example.com/api/hooks/mist',
      name: 'hpe-network-tools receiver',
      topics: ['alarms'],
      enabled: true,
    });
    expect(updated.ok).toBe(true);
    expect(webhookWrites[1].method).toBe('PUT');
    expect(webhookWrites[1].url).toContain('/webhooks/wh-1');
    // No secret in the form → no secret key asserted on the write at all.
    expect(webhookWrites[1].body).not.toHaveProperty('secret');
    // The call log carries method + path + status only — never the secret.
    expect(calls.every((c) => !c.path.includes('rotation-secret'))).toBe(true);
    // And a failed write reports its HTTP code without throwing.
    const { adapter: denied } = makeAdapter(fakeFetch({ webhookWriteStatus: 403 }));
    const failed = await denied.writeMistWebhook(null, {
      url: 'https://portal.example.com/api/hooks/mist',
      name: 'x',
      topics: ['alarms'],
      enabled: true,
    });
    expect(failed).toMatchObject({ ok: false, httpCode: 403 });
  });
});

describe('MistAdapter.deviceDetail', () => {
  const detailOpts: FakeOpts = {
    deviceStatsByUuid: { 'dev-uuid-1': { body: AP_STATS_ROW } },
    deviceConfigByUuid: { 'dev-uuid-1': { body: AP_CONFIG_ROW } },
  };

  it('reads radios, ports and the LLDP neighbour for one AP by serial', async () => {
    const { adapter } = makeAdapter(fakeFetch(detailOpts));
    await adapter.pull(); // builds the serial/mac → uuid joins
    const detail = await adapter.deviceDetail('SER-001', 'ap');
    expect(detail).toMatchObject({ serial: 'SER-001', kind: 'ap' });
    expect(detail?.source.sections).toMatchObject({ radios: 'ok', ports: 'ok' });
    expect(detail?.radios).toHaveLength(2);
    // The config read supplies the only provable status word: band_24 disabled.
    expect(detail?.radios?.[0]).toMatchObject({ number: 0, band: '2.4 GHz', channel: '6', status: 'DISABLED' });
    expect(detail?.radios?.[1]).toMatchObject({ number: 1, band: '5 GHz', channel: '36', status: '' });
    expect(detail?.ports?.[0]).toMatchObject({
      name: 'eth0',
      operStatus: 'up',
      speedBps: 1_000_000_000,
      uplink: true,
      neighbour: 'CX6300-CORE',
      neighbourPort: '1/1/5',
    });
    // The per-AP WLAN list is not on this surface — 'wlans' stays not-fetched
    // rather than borrowing the site's WLANs as the AP's.
    expect(detail?.source.sections).not.toHaveProperty('wlans');
    expect(detail).not.toHaveProperty('wlans');
  });

  it('resolves the same AP by mac and by Mist device uuid, never by a name guess', async () => {
    const { adapter } = makeAdapter(fakeFetch(detailOpts));
    await adapter.pull();
    expect((await adapter.deviceDetail('aa:bb:cc:00:11:01', 'ap'))?.radios).toHaveLength(2);
    expect((await adapter.deviceDetail('dev-uuid-1', 'ap'))?.radios).toHaveLength(2);
  });

  it('returns null for an identity this plane never synced, and for non-AP kinds', async () => {
    const { adapter } = makeAdapter(fakeFetch(detailOpts));
    await adapter.pull();
    expect(await adapter.deviceDetail('SER-999', 'ap')).toBeNull();
    expect(await adapter.deviceDetail('SER-001', 'switch')).toBeNull(); // only the AP surface is verified
    expect(await adapter.deviceDetail('  ', 'ap')).toBeNull();
  });

  it('fails the sections with the 404 named when Mist stops reporting the AP', async () => {
    const { adapter } = makeAdapter(fakeFetch({})); // single-device reads 404 by default
    await adapter.pull();
    const detail = await adapter.deviceDetail('SER-001', 'ap');
    expect(detail?.source.sections).toMatchObject({ radios: 'failed', ports: 'failed' });
    expect(detail?.source.note).toContain('HTTP 404');
    expect(detail).not.toHaveProperty('radios');
  });

  it('keeps the radios when only the config read fails — the enable words are the loss', async () => {
    const { adapter } = makeAdapter(
      fakeFetch({ deviceStatsByUuid: detailOpts.deviceStatsByUuid, deviceConfigByUuid: { 'dev-uuid-1': { status: 500 } } }),
    );
    await adapter.pull();
    const detail = await adapter.deviceDetail('SER-001', 'ap');
    expect(detail?.source.sections).toMatchObject({ radios: 'ok', ports: 'ok' });
    expect(detail?.radios?.[0].status).toBe(''); // no DISABLED word without the config read
    expect(detail?.source.note).toContain('device config: HTTP 500');
  });
});

describe('MistAdapter.mistSleMetricDetail', () => {
  const drillOpts: FakeOpts = {
    sleDrill: {
      'site-uuid-a|coverage|classifiers': {
        body: {
          results: [
            { name: 'signal-strength', samples: { total: [12, 8], degraded: [12, 8], duration: [600, 600] }, impact: { num_users: 3, num_aps: 1, total_users: 120, total_aps: 12 } },
          ],
        },
      },
      'site-uuid-a|coverage|impacted-users': { body: { results: [{ mac: 'de:ad:0b:14:65:22', hostname: 's.mehta', degraded: 31 }] } },
      'site-uuid-a|coverage|impacted-aps': { body: { results: [{ mac: 'aabbcc001101', name: 'ap-cam01-1', degraded: 7 }] } },
      'site-uuid-a|coverage|summary-trend': { body: sleTrendBody() },
    },
  };

  it('reads classifiers, impacted clients/APs and the trend lazily for one metric', async () => {
    const seenUrls: string[] = [];
    const { adapter } = makeAdapter(fakeFetch({ ...drillOpts, seenUrls }));
    await adapter.pull();
    // The poll itself never touches the drill family — only the summaries.
    expect(seenUrls.some((u) => /classifiers|impacted-users|impacted-aps|summary-trend/.test(u))).toBe(false);

    const detail = await adapter.mistSleMetricDetail('Campus A', 'coverage');
    expect(detail).toMatchObject({ siteName: 'Campus A', metric: 'coverage' });
    expect(detail?.source.sections).toEqual({ classifiers: 'ok', impactedClients: 'ok', impactedAps: 'ok', trend: 'ok' });
    expect(detail?.classifiers?.[0]).toMatchObject({ name: 'signal-strength', samples: 20, degraded: 20, durationSec: 1200 });
    expect(detail?.impactedClients).toEqual([{ mac: 'de:ad:0b:14:65:22', name: 's.mehta', degraded: 31 }]);
    expect(detail?.impactedAps).toEqual([{ mac: 'aabbcc001101', name: 'ap-cam01-1', degraded: 7 }]);
    expect(detail?.trend).toMatchObject({ intervalSec: 600, total: [120, null, 80] });
    expect(seenUrls.some((u) => u.includes('/metric/coverage/classifiers'))).toBe(true);
    expect(seenUrls.some((u) => u.includes('/metric/coverage/summary-trend'))).toBe(true);
  });

  it('reads drill 404s as honest empties and names real failures', async () => {
    const { adapter } = makeAdapter(fakeFetch({ sleDrill: { 'site-uuid-a|capacity|classifiers': { status: 500 } } }));
    await adapter.pull();
    const detail = await adapter.mistSleMetricDetail('Campus A', 'capacity');
    // classifiers 500 → failed; the other three 404 (the drill is not scored) → empty.
    expect(detail?.source.sections).toEqual({ classifiers: 'failed', impactedClients: 'empty', impactedAps: 'empty', trend: 'empty' });
    expect(detail?.source.note).toContain('classifiers: HTTP 500');
    expect(detail).not.toHaveProperty('classifiers');
    expect(detail).not.toHaveProperty('trend');
  });

  it('returns null for a site this plane does not hold, and for blank input', async () => {
    const { adapter } = makeAdapter(fakeFetch({}));
    await adapter.pull();
    expect(await adapter.mistSleMetricDetail('Nowhere', 'coverage')).toBeNull();
    expect(await adapter.mistSleMetricDetail('Campus A', '  ')).toBeNull();
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

  it('keeps incomplete legacy credentials unlinked instead of creating a stub', async () => {
    await withRegistry({ classic: { baseUrl: 'classic.example.com' } }, async (reg) => {
      const { UnconfiguredAdapter } = await import('../src/planes/registry');
      expect(reg.get('classic')).toBeInstanceOf(UnconfiguredAdapter);
      const st = reg.state('classic');
      expect(st.linked).toBe(false);
      expect(st.health).toBe('unlinked');
      expect(st.lastSync).toBeNull();
      expect(st.callsToday).toBe(0);
      expect(reg.recentCalls('classic')).toHaveLength(0);
      expect(st.note).toBe('no credentials configured');
    });
  });
});

// ---------------------------------------------------------------------------
// Direct SSID write — payload mapping, catalog, apply, delete.
// ---------------------------------------------------------------------------

/** A Mist-targeted form as the reviewed editor submits it (the service has
 *  already validated name/vlan/passphrase by the time the adapter sees one). */
function mistSsidForm(over: Partial<SsidForm> = {}): SsidForm {
  return {
    name: 'MRDN-Research',
    vlan: '822',
    security: 'wpa2-psk',
    group: '',
    bands: 'all',
    broadcast: true,
    isolate: false,
    noDfs: false,
    plane: 'MIST',
    scopeIds: ['site-uuid-a'],
    passphrase: 'correct-horse-battery',
    ...over,
  };
}

describe('buildMistWlanPayload — the SsidForm → Mist WLAN mapping', () => {
  it('maps every managed field for wpa2-psk, verbatim', () => {
    const mapped = buildMistWlanPayload(mistSsidForm({ enabled: true }));
    expect(mapped).toEqual({
      ok: true,
      payload: {
        ssid: 'MRDN-Research',
        vlan_enabled: true,
        vlan_id: 822, // numeric — not the display string
        bands: ['24', '5', '6'],
        hide_ssid: false,
        isolation: false,
        enabled: true,
        auth: { type: 'psk', psk: 'correct-horse-battery', pairwise: ['wpa2-ccmp'] },
      },
    });
  });

  it('maps every band selection to the dot11_band enum', () => {
    expect(buildMistWlanPayload(mistSsidForm({ bands: '5+6' }))).toMatchObject({ payload: { bands: ['5', '6'] } });
    expect(buildMistWlanPayload(mistSsidForm({ bands: '5' }))).toMatchObject({ payload: { bands: ['5'] } });
    expect(buildMistWlanPayload(mistSsidForm({ bands: 'all' }))).toMatchObject({ payload: { bands: ['24', '5', '6'] } });
  });

  it('maps broadcast=false → hide_ssid and isolate → isolation', () => {
    expect(buildMistWlanPayload(mistSsidForm({ broadcast: false, isolate: true }))).toMatchObject({
      payload: { hide_ssid: true, isolation: true },
    });
  });

  it('maps open to a psk-less auth object — no secret field appears at all', () => {
    const mapped = buildMistWlanPayload(mistSsidForm({ security: 'open', passphrase: undefined }));
    expect(mapped).toMatchObject({ ok: true, payload: { auth: { type: 'open' } } });
    expect(JSON.stringify(mapped)).not.toContain('psk');
  });

  it('omits enabled unless the form asserts it — an edit that never showed the switch changes no state', () => {
    const mapped = buildMistWlanPayload(mistSsidForm());
    expect(mapped.ok).toBe(true);
    expect(mapped.ok ? mapped.payload : {}).not.toHaveProperty('enabled');
    expect(buildMistWlanPayload(mistSsidForm({ enabled: false }))).toMatchObject({ payload: { enabled: false } });
  });

  it('REFUSES enterprise and portal modes with the reason — never approximates', () => {
    for (const security of ['wpa2-enterprise', 'wpa3-enterprise'] as const) {
      const mapped = buildMistWlanPayload(mistSsidForm({ security, passphrase: undefined }));
      expect(mapped.ok).toBe(false);
      if (!mapped.ok) expect(mapped.reason).toMatch(/RADIUS/);
    }
    const portal = buildMistWlanPayload(mistSsidForm({ security: 'psk-portal', passphrase: undefined }));
    expect(portal.ok).toBe(false);
    if (!portal.ok) expect(portal.reason).toMatch(/portal/i);
  });

  it('refuses a VLAN that is not a real id instead of sending it', () => {
    expect(buildMistWlanPayload(mistSsidForm({ vlan: 'abc' })).ok).toBe(false);
    expect(buildMistWlanPayload(mistSsidForm({ vlan: '4095' })).ok).toBe(false);
    expect(buildMistWlanPayload(mistSsidForm({ vlan: '' })).ok).toBe(false);
  });
});

describe('mistWlanDiffers / readableMistWlanPayload — idempotency and verification', () => {
  const desired = buildMistWlanPayload(mistSsidForm({ enabled: true }));

  it('ignores unmanaged fields — a ~70-key live row with matching managed fields is NOT a diff', () => {
    if (!desired.ok) throw new Error('expected a mappable form');
    const liveRow = { dtim: 2, wxtag_ids: ['t1'], schedule: {}, app_qos: {}, ...desired.payload };
    expect(mistWlanDiffers(liveRow, desired.payload)).toBe(false);
  });

  it('flags a drifted managed field', () => {
    if (!desired.ok) throw new Error('expected a mappable form');
    expect(mistWlanDiffers({ ...desired.payload, vlan_id: 100 }, desired.payload)).toBe(true);
    expect(mistWlanDiffers({ ...desired.payload, enabled: false }, desired.payload)).toBe(true);
    expect(mistWlanDiffers({ ...desired.payload, bands: ['5'] }, desired.payload)).toBe(true);
  });

  it('compares vlan_id across the numeric/string spellings a tenant can return', () => {
    if (!desired.ok) throw new Error('expected a mappable form');
    expect(mistWlanDiffers({ ...desired.payload, vlan_id: '822' }, desired.payload)).toBe(false);
  });

  it('compares the PSK in memory when both sides carry it, and forces a write when the read-back redacts it', () => {
    if (!desired.ok) throw new Error('expected a mappable form');
    const withSamePsk = { ...desired.payload, auth: { type: 'psk', psk: 'correct-horse-battery', pairwise: ['wpa2-ccmp'] } };
    expect(mistWlanDiffers(withSamePsk, desired.payload)).toBe(false);
    const withOtherPsk = { ...desired.payload, auth: { type: 'psk', psk: 'something-else', pairwise: ['wpa2-ccmp'] } };
    expect(mistWlanDiffers(withOtherPsk, desired.payload)).toBe(true);
    // A tenant that redacts the key must not become a false no-op (central.ts
    // makes the same call: redacted + explicitly supplied → write).
    const redacted = { ...desired.payload, auth: { type: 'psk', pairwise: ['wpa2-ccmp'] } };
    expect(mistWlanDiffers(redacted, desired.payload)).toBe(true);
  });

  it('readableMistWlanPayload strips exactly the write-only key', () => {
    if (!desired.ok) throw new Error('expected a mappable form');
    const readable = readableMistWlanPayload(desired.payload);
    expect(JSON.stringify(readable)).not.toContain('correct-horse-battery');
    expect(readable.auth).toEqual({ type: 'psk', pairwise: ['wpa2-ccmp'] });
    expect(mistWlanDiffers({ ...desired.payload, auth: { type: 'psk', psk: 'ANYTHING', pairwise: ['wpa2-ccmp'] } }, readable)).toBe(false);
  });
});

describe('MistAdapter.ssidCatalog — the site-scoped scope catalog', () => {
  it('offers exactly the org’s sites, with the Central dependency sections genuinely absent', async () => {
    const { adapter } = makeAdapter(fakeFetch({}));
    const catalog = await adapter.ssidCatalog();
    expect(catalog.scopes).toEqual([
      { id: 'site-uuid-a', label: 'Campus A', category: 'site' },
      { id: 'site-uuid-b', label: 'Lab B', category: 'site' },
    ]);
    // Mist has no role/server-group/portal catalogs — empty, NOT 'unavailable'.
    expect(catalog.roles).toEqual([]);
    expect(catalog.authServerGroups).toEqual([]);
    expect(catalog.captivePortalProfiles).toEqual([]);
    expect(catalog.unavailable).toEqual([]);
    expect(catalog.source).toContain('/api/v1/sites/{site}/wlans');
  });

  it('names sites unavailable — and nothing else — when the org read fails', async () => {
    const { adapter } = makeAdapter(fakeFetch({ siteStatus: 500 }));
    const catalog = await adapter.ssidCatalog();
    expect(catalog.scopes).toEqual([]);
    expect(catalog.unavailable).toEqual(['sites']);
    expect(catalog.source).toMatch(/could not be read/);
  });
});

describe('MistAdapter.applySsidProfile — the reviewed site-scoped write', () => {
  it('creates the WLAN at the selected site and verifies the echo', async () => {
    const wlanWrites: { method: string; url: string; site: string; wlanId: string | null; body: unknown }[] = [];
    const { adapter } = makeAdapter(fakeFetch({ wlansBySite: { 'site-uuid-a': [] }, wlanWrites }));
    const result = await adapter.applySsidProfile(mistSsidForm({ enabled: true }));
    expect(result).toMatchObject({
      ok: true,
      partial: false,
      profile: { ok: true, action: 'created', verified: true },
    });
    expect(result.assignments).toHaveLength(1);
    expect(result.assignments[0]).toMatchObject({ scopeId: 'site-uuid-a', ok: true, verified: true, httpCode: 200 });
    expect(wlanWrites).toHaveLength(1);
    expect(wlanWrites[0].method).toBe('POST');
    expect(wlanWrites[0].url).toContain('/api/v1/sites/site-uuid-a/wlans');
    expect(wlanWrites[0].body).toMatchObject({
      ssid: 'MRDN-Research',
      vlan_enabled: true,
      vlan_id: 822,
      bands: ['24', '5', '6'],
      auth: { type: 'psk', psk: 'correct-horse-battery', pairwise: ['wpa2-ccmp'] },
    });
  });

  it('updates an existing WLAN with the CURRENT row merged through — unmanaged fields survive verbatim', async () => {
    const current = {
      id: 'wlan-1',
      ssid: 'MRDN-Research',
      vlan_id: 100, // drifted — the update must correct it
      enabled: true,
      bands: ['24', '5', '6'],
      hide_ssid: false,
      isolation: false,
      dtim: 4, // unmanaged — must ride through untouched
      wxtag_ids: ['tag-9'],
      auth: { type: 'psk', psk: 'correct-horse-battery', pairwise: ['wpa2-ccmp'] },
    };
    const wlanWrites: { method: string; url: string; site: string; wlanId: string | null; body: unknown }[] = [];
    const { adapter } = makeAdapter(fakeFetch({ wlansBySite: { 'site-uuid-a': [current] }, wlanWrites }));
    const result = await adapter.applySsidProfile(mistSsidForm({ enabled: true }));
    expect(result.profile).toMatchObject({ ok: true, action: 'updated', verified: true });
    expect(result.ok).toBe(true);
    expect(wlanWrites).toHaveLength(1);
    expect(wlanWrites[0].method).toBe('PUT');
    expect(wlanWrites[0].url).toContain('/api/v1/sites/site-uuid-a/wlans/wlan-1');
    expect(wlanWrites[0].body).toMatchObject({ vlan_id: 822, dtim: 4, wxtag_ids: ['tag-9'] });
  });

  it('is idempotent: a matching WLAN (PSK included) is skipped and nothing is written', async () => {
    const current = {
      id: 'wlan-1',
      ssid: 'MRDN-Research',
      vlan_enabled: true,
      vlan_id: 822,
      enabled: true,
      bands: ['24', '5', '6'],
      hide_ssid: false,
      isolation: false,
      auth: { type: 'psk', psk: 'correct-horse-battery', pairwise: ['wpa2-ccmp'] },
    };
    const wlanWrites: { method: string; url: string; site: string; wlanId: string | null; body: unknown }[] = [];
    const { adapter } = makeAdapter(fakeFetch({ wlansBySite: { 'site-uuid-a': [current] }, wlanWrites }));
    const result = await adapter.applySsidProfile(mistSsidForm({ enabled: true }));
    expect(result.profile).toMatchObject({ action: 'unchanged', ok: true });
    expect(result.assignments[0]).toMatchObject({ ok: true, skipped: true });
    expect(result.ok).toBe(true);
    expect(wlanWrites).toHaveLength(0);
  });

  it('writes every selected site — created at one, updated at another, outcomes per site', async () => {
    const current = {
      id: 'wlan-9',
      ssid: 'MRDN-Research',
      vlan_id: 100,
      enabled: true,
      bands: ['24', '5', '6'],
      hide_ssid: false,
      isolation: false,
      auth: { type: 'psk', psk: 'correct-horse-battery', pairwise: ['wpa2-ccmp'] },
    };
    const wlanWrites: { method: string; url: string; site: string; wlanId: string | null; body: unknown }[] = [];
    const { adapter } = makeAdapter(
      fakeFetch({ wlansBySite: { 'site-uuid-a': [], 'site-uuid-b': [current] }, wlanWrites }),
    );
    const result = await adapter.applySsidProfile(mistSsidForm({ scopeIds: ['site-uuid-a', 'site-uuid-b'], enabled: true }));
    expect(result.ok).toBe(true);
    expect(result.profile).toMatchObject({ action: 'updated', ok: true });
    expect(result.assignments.map((a) => a.scopeId)).toEqual(['site-uuid-a', 'site-uuid-b']);
    expect(wlanWrites.map((w) => w.method)).toEqual(['POST', 'PUT']);
  });

  it('a site that refuses the write is partial, never rolled back, and named in its own row', async () => {
    // Second site's LIST read 500s — that site's write is never attempted.
    const { adapter } = makeAdapter(
      fakeFetch({ wlansBySite: { 'site-uuid-a': [], 'site-uuid-b': [] }, wlanStatusBySite: { 'site-uuid-b': 500 } }),
    );
    const result = await adapter.applySsidProfile(mistSsidForm({ scopeIds: ['site-uuid-a', 'site-uuid-b'], enabled: true }));
    expect(result.ok).toBe(false);
    expect(result.partial).toBe(true);
    expect(result.profile.ok).toBe(true); // the payload applied at site A stands
    expect(result.assignments[0]).toMatchObject({ scopeId: 'site-uuid-a', ok: true });
    expect(result.assignments[1]).toMatchObject({ scopeId: 'site-uuid-b', ok: false, httpCode: 500 });
  });

  it('a write that fails at EVERY site is failed, not partial', async () => {
    const { adapter } = makeAdapter(fakeFetch({ wlansBySite: { 'site-uuid-a': [] }, wlanWriteStatus: 500 }));
    const result = await adapter.applySsidProfile(mistSsidForm());
    expect(result).toMatchObject({
      ok: false,
      partial: false,
      profile: { ok: false, action: 'failed', verified: false },
    });
    expect(result.assignments[0]).toMatchObject({ ok: false, httpCode: 500 });
  });

  it('a write whose echo never arrives is "written, not confirmed" — verified undefined, NOT claimed', async () => {
    const { adapter } = makeAdapter(fakeFetch({ wlansBySite: { 'site-uuid-a': [] }, wlanWriteBody: 'unreadable' }));
    const result = await adapter.applySsidProfile(mistSsidForm());
    expect(result.assignments[0]).toMatchObject({ ok: true, httpCode: 200 });
    expect(result.assignments[0].verified).toBeUndefined();
    expect(result.ok).toBe(false);
    expect(result.partial).toBe(false);
    expect(result.profile).toMatchObject({ ok: false, action: 'created', verified: false });
    expect(result.profile.message).toMatch(/did not confirm/);
  });

  it('refuses an unknown scope BEFORE writing anything — by id AND by name', async () => {
    const wlanWrites: { method: string; url: string; site: string; wlanId: string | null; body: unknown }[] = [];
    const seenUrls: string[] = [];
    const { adapter } = makeAdapter(fakeFetch({ wlanWrites, seenUrls }));
    const result = await adapter.applySsidProfile(
      mistSsidForm({ scopeIds: ['site-uuid-a', 'no-such-site'] }),
    );
    expect(result.ok).toBe(false);
    expect(result.profile.action).toBe('failed');
    expect(result.profile.message).toContain('no-such-site');
    expect(result.assignments).toEqual([]);
    expect(wlanWrites).toHaveLength(0);
    // Only the org sites read happened — no per-site WLAN read, no write.
    expect(seenUrls.some((u) => u.includes('/wlans'))).toBe(false);
    // The same scope resolves by exact site NAME, for forms that carry one.
    const byName = await adapter.applySsidProfile(mistSsidForm({ scopeIds: ['Campus A'] }));
    expect(byName.assignments[0].scopeId).toBe('site-uuid-a');
  });

  it('refuses enterprise/portal modes before ANY call — no sites read, no write', async () => {
    const seenUrls: string[] = [];
    const { adapter } = makeAdapter(fakeFetch({ seenUrls }));
    const enterprise = await adapter.applySsidProfile(
      mistSsidForm({ security: 'wpa2-enterprise', passphrase: undefined }),
    );
    expect(enterprise).toMatchObject({ ok: false, partial: false, profile: { action: 'failed' } });
    expect(enterprise.profile.message).toMatch(/RADIUS/);
    expect(seenUrls).toHaveLength(0);

    const portal = await adapter.applySsidProfile(mistSsidForm({ security: 'psk-portal', passphrase: undefined }));
    expect(portal.ok).toBe(false);
    expect(portal.profile.message).toMatch(/portal/i);
    expect(seenUrls).toHaveLength(0);
  });

  it('fails honestly when the org’s sites cannot be read to resolve the scope', async () => {
    const { adapter } = makeAdapter(fakeFetch({ siteStatus: 500 }));
    const result = await adapter.applySsidProfile(mistSsidForm());
    expect(result).toMatchObject({ ok: false, partial: false, profile: { action: 'failed' } });
    expect(result.profile.message).toMatch(/could not read the org’s sites/);
  });

  it('PROVES the PSK rides only the write body — never a result, a message, or the call log', async () => {
    const CANARY = 'correct-horse-battery';
    const wlanWrites: { method: string; url: string; site: string; wlanId: string | null; body: unknown }[] = [];
    const { adapter, calls, st } = makeAdapter(fakeFetch({ wlansBySite: { 'site-uuid-a': [] }, wlanWrites }));
    const result = await adapter.applySsidProfile(mistSsidForm({ passphrase: CANARY }));
    // Sanity: the secret genuinely went to Mist (otherwise the proof is vacuous).
    expect(JSON.stringify(wlanWrites[0].body)).toContain(CANARY);
    // …and nowhere else the portal controls.
    expect(JSON.stringify(result)).not.toContain(CANARY);
    expect(result.profile.message).not.toContain(CANARY);
    expect(result.assignments.every((a) => !a.message.includes(CANARY))).toBe(true);
    expect(calls.every((c) => !c.path.includes(CANARY))).toBe(true);
    expect(st.note ?? '').not.toContain(CANARY);
  });
});

describe('MistAdapter.deleteSiteWlan — the verified DELETE surface', () => {
  it('issues DELETE on the item path and reports the code', async () => {
    const wlanWrites: { method: string; url: string; site: string; wlanId: string | null; body: unknown }[] = [];
    const { adapter, calls } = makeAdapter(fakeFetch({ wlanWrites }));
    const res = await adapter.deleteSiteWlan('site-uuid-a', 'wlan-1');
    expect(res).toMatchObject({ ok: true, httpCode: 200 });
    expect(wlanWrites).toEqual([
      { method: 'DELETE', url: expect.stringContaining('/api/v1/sites/site-uuid-a/wlans/wlan-1'), site: 'site-uuid-a', wlanId: 'wlan-1', body: undefined },
    ]);
    expect(calls.some((c) => c.path.startsWith('DELETE /api/v1/sites/site-uuid-a/wlans/wlan-1') && c.code === '200')).toBe(true);
  });

  it('a refused delete is reported, not swallowed', async () => {
    const { adapter } = makeAdapter(fakeFetch({ wlanWriteStatus: 404 }));
    const res = await adapter.deleteSiteWlan('site-uuid-a', 'wlan-gone');
    expect(res).toMatchObject({ ok: false, httpCode: 404 });
    expect(res.message).toMatch(/delete failed/);
  });
});
