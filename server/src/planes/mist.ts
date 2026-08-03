/**
 * server/src/planes/mist.ts — Juniper Mist cloud adapter.
 *
 * The Mist plane (README integration table: inventory, clients, SLE, alarms)
 * plus REVIEWED DIRECT SSID WRITES: site-scoped WLAN create/update/delete via
 * /api/v1/sites/{siteId}/wlans (verified against the live org with an
 * org-admin token), surfaced on Configure through the same review-gated
 * apply flow Central SSIDs use (server/src/services/ssidDirectWrite.ts).
 * Everything else stays read-only — the ticketed write broker never pushes
 * to Mist.
 * Static API-token auth — `Authorization: Token <token>` on every
 * call, nothing to refresh (verified against the official OpenAPI spec at
 * mistsys/mist_openapi and the mistapi_python SDK).
 *
 * Verified surface (probed against a live gc4 org — where this and an older
 * comment disagreed, the probe won):
 *   sites    GET /api/v1/orgs/{orgId}/sites?limit=N&page=N
 *   devices  GET /api/v1/orgs/{orgId}/stats/devices?type=all&limit=N&page=N
 *            one org-wide call carries name/model/version/serial/mac/site_id/
 *            status(connected|disconnected) per device — the best fit for
 *            this adapter. The org rows do NOT carry `num_clients` (an older
 *            revision of this header claimed they did; the live org proves
 *            otherwise). That field only rides on SITE-level
 *            /sites/{id}/stats/devices?type=ap rows (see `apstats` below).
 *   apstats  GET /api/v1/sites/{siteId}/stats/devices?type=ap&limit=N&page=N
 *            the RICH per-AP rows: num_clients, cpu_util, mem_total/used_kb,
 *            uptime, rx/tx_bps, ext_ip, ip_stat{dns,gateway,dhcp_server},
 *            env_stat{ambient_temp,pressure,humidity,accel_*}, port_stat
 *            (per-port up/speed/duplex/byte+error counters/peak_bps),
 *            radio_stat{band_24,band_5,band_6} (channel/bandwidth/power/
 *            noise_floor, util_* counters, num_clients), power_src and
 *            power_constrained — mapped whole into PlanePull.mistApStats.
 *            lldp_stat {system_name,system_desc,port_id,chassis_id,
 *            mgmt_addr} is the real AP → switch uplink edge (AP →
 *            "CX6300-CORE" 1/1/5 on the live org). num_clients here is what
 *            the org rows lack, so when the client roster was NOT read but
 *            this walk was, the Sites 'Clients' column falls back to the
 *            summed per-AP counts — labelled in the note, never blended with
 *            the roster count.
 *   alarms   GET /api/v1/orgs/{orgId}/alarms/search?duration=1d&limit=N&page=N
 *            search envelope `{ results: [...], total }` — extractRows and
 *            extractTotal read both that and the bare-array list shape.
 *   clients  GET /api/v1/sites/{siteId}/stats/clients?limit=N&page=N
 *            the WIRELESS roster, one call per site per cycle (design/
 *            NtSystems.dc.html:284 records exactly this path) — see
 *            SITE_FANOUT_BUDGET for the quota arithmetic. Roster rows carry
 *            the floor-plan position (x/y pixels, x_m/y_m meters, map_id) —
 *            x/y/mapId ride the ClientRow for the map renderer.
 *   wired    GET /api/v1/orgs/{orgId}/wired_clients/search?limit=N&page=N
 *            the WIRED roster — one ORG call (no fan-out), rows carry
 *            auth_state/eth_port/vlan_id/byte counters and the switch they
 *            attach to. Merged into the same ClientRow list with medium
 *            'wired'. The roster stays all-or-nothing: wireless failing
 *            omits the whole `clients` dataset (a wired-only roster read as
 *            complete is the lie rule 1 forbids); wired failing with the
 *            wireless read OK marks the dataset truncated.
 *   config   GET /api/v1/sites/{siteId}/wlans — WLANs are SITE-scoped: the
 *            org-level /orgs/{orgId}/wlans answers [] on a live org, so the
 *            walk is one call per site (budget-gated like the clients walk).
 *            SECURITY: the site WLAN payload carries `auth.psk` IN CLEARTEXT
 *            (and portal secrets on portal WLANs). mapMistWlan WHITELIST-maps
 *            fields — ssid/vlan/enabled/auth.type are the only ones read — so
 *            no secret can reach a pull, an API response, the config-backup
 *            service, a log line or the audit journal. The row's `note` says
 *            a PSK exists and is redacted; the secret itself never moves.
 *   maps     GET /api/v1/sites/{siteId}/maps + GET /sites/{siteId}/devices
 *            ?type=ap — floor plans (url, width/height px + meters,
 *            orientation) joined with the AP config placements (x/y/map_id)
 *            into PlanePull.mistMaps. The live org publishes ZERO maps
 *            (200 []) — a real, shippable empty; the demo world authors one.
 *   rogues   GET /api/v1/sites/{siteId}/insights/rogues — the per-site
 *            rogue/neighbor BSSID report: ssid, bssid, channel, avg_rssi,
 *            num_aps (how many of the site's APs heard it) and seen_on_lan —
 *            the on-your-wire flag, the actual alarm (a rogue on your own
 *            wired infrastructure; everything else is just a neighbor).
 *            One call per site, budget-gated like the other site walks,
 *            mapped into PlanePull.mistRogues (see MistPlanePullExtras).
 *   audit    GET /api/v1/orgs/{orgId}/logs/search — the ORG admin change log
 *            (who changed what, when, with before/after snapshots), paged.
 *            NOT polled: mistAuditLog() reads it on the Systems drawer's
 *            request path, like the SLE drill-down. The before/after
 *            snapshots can carry a cleartext WLAN PSK, so every secret-shaped
 *            value is redacted at the mapper (same discipline as `config`).
 *   webhooks GET /api/v1/orgs/{orgId}/webhooks + POST/PUT …/webhooks(/{id}) —
 *            the org's webhook subscriptions, for the receiver's
 *            AUTO-REGISTRATION (services/mistWebhooks.ts): a REVIEWED write
 *            pointing a subscription at the portal's /api/hooks/mist
 *            receiver, exactly the class of org config change the reviewed
 *            direct-write gate exists for. The subscription's signing secret
 *            is write-only: it is sent on the write, never logged, never
 *            echoed, and the list/detail mapper reads only its presence.
 *   sle      GET /api/v1/sites/{siteId}/sle/site/{siteId}/metric/{metric}/summary
 *            The working SLE surface: the org-insights endpoint this adapter
 *            first targeted (/orgs/{orgId}/insights/site) 404s with an HTML
 *            page on a live org, so that call was removed — the per-site
 *            summaries ARE the SLE API (fixed metric set, SLE_METRICS, one
 *            call per metric per site). A failed metric is omitted and the
 *            rest still land; only a total failure marks the section
 *            unavailable. The richer classifier/impact detail rides on
 *            MistSleRow.metrics.
 *   sle drill GET .../metric/{metric}/classifiers | impacted-users |
 *            impacted-aps | summary-trend — same /sle/ family, verified 200.
 *            NOT polled: mistSleMetricDetail() reads them on the drill-down
 *            request path for the ONE metric an operator opens.
 *   detail   GET /sites/{siteId}/stats/devices/{uuid}?type=ap and
 *            GET /sites/{siteId}/devices/{uuid} — the ON-DEMAND per-AP read
 *            behind deviceDetail(). Keyed by the device UUID
 *            (00000000-0000-0000-1000-<mac>), NOT the mac — the mac path
 *            404s. serial/mac → uuid joins come from the org stats rows.
 *   firmware GET /api/v1/orgs/{orgId}/devices/versions — per-model available
 *            trains ({model, version, tag}); a row tagged 'suggested' wins.
 *            This is what makes `firmwareApproved` a real verdict instead of
 *            a placeholder: false only when the running train is known AND
 *            differs from the recommendation. `fwupdate`/`auto_upgrade_stat`
 *            status words on the stats rows ride through verbatim.
 *   licenses GET /api/v1/orgs/{orgId}/licenses/usages — per-site consumption
 *            ({site_id, num_devices, usages, fully_loaded}), exposed as
 *            PlanePull.mistLicenseUsages.
 *   inventory GET /api/v1/orgs/{orgId}/inventory?limit=N&page=N — the claim
 *            code (`magic`) and `connected` flag per device, joined onto the
 *            stats rows by mac/serial as DeviceRow.claimCode (and a state
 *            backfill for rows whose stats status was absent).
 *   paging   limit+page (1-based). X-Page-Total/Limit/Page carry the
 *            authoritative totals; when the gateway trims an oversized `limit`
 *            the short-page heuristic alone would stop after page 1, so the
 *            headers (and the search envelope's `total`) drive the walk and
 *            the short-page rule is only the fallback.
 *   limits   README:462 caps this plane at 20,000 calls/day; a 429 is paced
 *            with Retry-After rather than failing the cycle outright.
 *
 * DEFERRED: subscriptions — /orgs/{orgId}/licenses (the entitlement list) is
 *   still not mapped into SubscriptionRow[] for the Licences screen (only the
 *   per-site USAGE rows are read, above). The device row's
 *   `licence: 'unknown'` says "not read", not "does not exist".
 *
 * Failure policy: `sites` and `devices` are the inventory this plane exists
 * for — either failing throws, naming the section. `clients`, `alarms`,
 * `config`, `sle`, `licenses`, `apstats`, `maps` and `rogues` are additional
 * datasets:
 * a failure there OMITS the key (never an empty array), notes the section as
 * unavailable and holds the plane at 'warning', so downstream reads it as
 * unknown instead of as an authoritative zero (README:469 rule 1 and its
 * corollary). The wired roster shares the `clients` dataset: its failure
 * alone marks `clients` truncated rather than unavailable. The firmware and
 * inventory reads are ENRICHMENT for the device rows, not datasets: a
 * failure there costs the claim codes and real firmware verdicts for the
 * cycle — recorded in the call log, not in `partial`.
 *
 * Security: the token travels in the Authorization header only, never in a
 * URL; the call log records method + path + ms + status, never headers. WLAN
 * secrets are whitelist-scrubbed at the mapper (see `config` above); the
 * claim code is a device-claim secret and is never logged either.
 */

import type {
  AlertRow,
  ClientRow,
  ClientType,
  ConfigInventory,
  DetailFetchState,
  DeviceDetailKind,
  DeviceDetailLive,
  DeviceDetailSection,
  DevicePort,
  DeviceRadio,
  DeviceRow,
  DeviceType,
  MistApEnvStats,
  MistApLldpUplink,
  MistApPortStats,
  MistApRadioStats,
  MistApStatsRow,
  MistAuditLogLive,
  MistAuditLogRow,
  MistAuditLogSection,
  MistLicenseUsageRow,
  MistRogueApRow,
  MistSiteMap,
  MistSiteMapAp,
  MistSleClassifier,
  MistSleDrillSection,
  MistSleImpact,
  MistSleImpactedAp,
  MistSleImpactedClient,
  MistSleMetric,
  MistSleMetricDetail,
  MistSleRow,
  MistSleTrend,
  MistWebhookSubscription,
  PlaneDatasetKey,
  SiteRow,
  SiteTopologyLive,
  SiteTopologySection,
  SsidApplyResult,
  SsidBands,
  SsidCatalog,
  SsidForm,
  SsidObject,
  SsidProfileStepResult,
  SsidScopeAssignmentResult,
  Tone,
  TopologyDeviceNode,
  TopologyLink,
} from '@hpe/shared';
import { formatCount, mistSsidSecurityRefusal } from '@hpe/shared';
import type { PlaneCredentials } from '../config/settings';
import type { PlaneAdapter, PlaneCapabilities, PlanePull, PlaneState } from './types';
import {
  ageString,
  durationString,
  parseTimestamp,
  sevFor,
  siteIdForName,
} from './format';
import {
  parseRetryAfterMs,
  type FetchLike,
  type RecordCallFn,
  type SleepFn,
  httpsBase,
} from './transport';

// Re-exported so tests can type an in-memory fake fetch against this adapter.
export type { FetchLike } from './transport';

const OUTBOUND_TIMEOUT_MS = 10_000;
const PAGE_LIMIT = 1000; // Mist's documented maximum page size
const MAX_PAGES = 25;

/** 429 backoff: attempts after the first, exponential floor, and a hard cap. */
const RATE_LIMIT_RETRIES = 3;
const RATE_LIMIT_BASE_MS = 1_000;
const RATE_LIMIT_CAP_MS = 30_000;
/** Pacing between calls so a multi-page / multi-site walk is not a burst. */
const CALL_PACING_MS = 150;

/**
 * Mist fans out per site for six datasets — the wireless client roster (1
 * call per site), the site-scoped WLANs (1), the rich AP stats (1), the
 * floor-plan pair (maps + AP config, 2), the rogue/neighbor report (1) and
 * the SLE summaries (SLE_METRICS.length). README:462 caps this plane at
 * 20,000 calls/day and the default 60s cadence is 1,440 cycles/day, so every
 * per-site walk shares one budget: past this many sites the fan-out is
 * refused up front and the section reports unavailable rather than fetched
 * for some sites and read as complete — the lie rule 1 forbids. At the
 * budget the walks cost 8×(1+1+1+2+1+6)=96 calls a cycle worst case, which
 * the 429 pacing/backoff absorbs on orgs that size; smaller orgs stay well
 * under the quota. The wired roster is an ORG call (no fan-out) and does
 * not count here.
 */
const SITE_FANOUT_BUDGET = 8;

/** The SLE metrics pulled per site — the set verified against a live org
 *  (GET .../sle/site/{id}/metrics publishes the full supported list; this
 *  fixed set keeps the fan-out bounded and every one of these answered 200).
 *  'wan' is deliberately not among them: WAN SLE rides a different product
 *  surface, so MistSleRow.wan stays null rather than inventing a source. */
const SLE_METRICS = ['time-to-connect', 'roaming', 'ap-availability', 'ap-health', 'capacity', 'coverage'] as const;

const realSleep: SleepFn = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

// ---------------------------------------------------------------------------
// Defensive field readers — unknown/extra fields ignored, missing → null
// ---------------------------------------------------------------------------

function str(v: unknown): string | null {
  if (typeof v === 'string' && v.trim().length > 0) return v.trim();
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return null;
}

function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim().length > 0 && !Number.isNaN(Number(v))) return Number(v);
  return null;
}

/** Mist puts prose in string arrays too (`reasons`, `hostnames`) — join them. */
function strList(v: unknown): string | null {
  if (!Array.isArray(v)) return null;
  const parts = v.map(str).filter((s): s is string => s !== null);
  return parts.length > 0 ? parts.join(' · ') : null;
}

/** MAC keys for cross-referencing: case- and separator-insensitive. */
function macKey(v: string | null): string | null {
  if (v === null) return null;
  const hex = v.toLowerCase().replace(/[^0-9a-f]/g, '');
  return hex.length > 0 ? hex : null;
}

// ---------------------------------------------------------------------------
// Row mapping (pure, exported for tests)
// ---------------------------------------------------------------------------

/** Mist device-stats type vocabulary → the shared DeviceType. */
function deviceTypeFor(raw: string | null): DeviceType {
  const s = (raw ?? '').toLowerCase();
  if (s === 'ap') return 'ap';
  if (s === 'switch') return 'switch';
  if (s === 'gateway') return 'gateway';
  return 'ap'; // mist stats rows are APs when the discriminator is absent
}

/** Identity hints for the reconcile service (the pattern central uses). */
export type MistDeviceRow = DeviceRow & { serial?: string; mac?: string };

/** What the org inventory read adds to one stats row: the claim code and the
 *  connected flag, keyed to the device by mac/serial. Either side null when
 *  the inventory record did not carry it. */
export interface MistInventoryHint {
  claimCode: string | null;
  connected: boolean | null;
}

/**
 * Mist org device-stats row → DeviceRow. `siteNameById` resolves the Mist
 * site UUID to its display name (from the sites section); unknown ids land on
 * the 'multiple' pseudo-site via siteIdForName(null).
 *
 * `firmwareByModel` (model → recommended train, from /devices/versions) is
 * what makes `firmwareApproved` a verdict: false ONLY when the running train
 * is known and differs from the recommendation. No recommendation, or an
 * unknown running version, keeps true — the boolean cannot say "unknown", so
 * it asserts nothing it cannot prove (see Device.firmwareTarget). `hint`
 * carries the inventory enrichment: the claim code rides through, and
 * `connected` backfills state only when the stats row carried NO status word
 * at all — a word the stats row does say ('upgrading') always wins.
 */
export function mapMistDevice(
  raw: unknown,
  siteNameById: ReadonlyMap<string, string>,
  firmwareByModel: ReadonlyMap<string, string> = new Map(),
  hint?: MistInventoryHint,
): MistDeviceRow | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const name = str(r.name) ?? str(r.hostname) ?? str(r.serial) ?? str(r.mac);
  if (!name) return null;
  const status = (str(r.status) ?? '').toLowerCase();
  const { state, stateTone } =
    status === 'connected' || (status === '' && hint?.connected === true)
      ? { state: 'up', stateTone: 'success' as Tone }
      : status === 'disconnected' || (status === '' && hint?.connected === false)
        ? { state: 'down', stateTone: 'danger' as Tone }
        : { state: status || 'unknown', stateTone: 'neutral' as Tone };
  const siteUuid = str(r.site_id);
  const site = siteIdForName(siteUuid !== null ? (siteNameById.get(siteUuid) ?? null) : null);
  const serial = str(r.serial);
  const mac = str(r.mac);
  const ip = str(r.ip);
  const model = str(r.model) ?? 'unknown';
  const running = str(r.version);
  const recommended = firmwareByModel.get(model) ?? null;
  // The upgrade-state word the stats row itself reports, verbatim — Mist's
  // vocabulary ('inprogress', 'scheduled', …), never interpreted into prose.
  const fwupdate = r.fwupdate && typeof r.fwupdate === 'object' ? (r.fwupdate as Record<string, unknown>) : null;
  const autoUpgrade =
    r.auto_upgrade_stat && typeof r.auto_upgrade_stat === 'object' ? (r.auto_upgrade_stat as Record<string, unknown>) : null;
  const firmwareUpdate =
    str(fwupdate?.status) ?? str(fwupdate?.state) ?? str(autoUpgrade?.status) ?? str(autoUpgrade?.state);
  return {
    name,
    model,
    type: deviceTypeFor(str(r.type)),
    siteId: site.siteId,
    siteName: site.siteName,
    plane: 'MIST',
    planeTone: 'info',
    state,
    stateTone,
    firmware: running ?? 'unknown',
    // false asserts "known to be behind the recommended train"; true asserts
    // only "not KNOWN to be behind" — see the docblock above.
    firmwareApproved: recommended === null || running === null || running === recommended,
    // The org entitlement list (/licenses) is still not mapped into
    // SubscriptionRow[] — only per-site usage is read (see the header's
    // DEFERRED note) — so 'unknown' is honest, not a statement that Mist has
    // no licence API.
    licence: 'unknown',
    reconciliationIssue: false, // the reconcile service computes this
    localShell: false, // cloud-claimed — no portal shell
    ...(serial ? { serial } : {}),
    ...(mac ? { mac } : {}),
    // Management IP when the stats row carries one: the Devices search and the
    // terminal's resolveTarget() both key on it. Absent stays absent.
    ...(ip ? { ip } : {}),
    ...(recommended !== null ? { firmwareTarget: recommended } : {}),
    ...(firmwareUpdate !== null ? { firmwareUpdate } : {}),
    ...(hint?.claimCode ? { claimCode: hint.claimCode } : {}),
  };
}

/**
 * Mist org site row → SiteRow. Device and client counts ride along from the
 * stats sections; `clientCount` null means the clients roster was not read
 * (org stats rows carry no `num_clients`, and this adapter does not yet walk
 * the site-level stats that do), which renders '—' rather than a '0' the
 * adapter cannot stand behind. `sync` is the CALLER's stamp — the Mist
 * site object has no per-site sync time, so pull() passes the plane's own last
 * successful read (default '—' = never synced).
 */
export function mapMistSite(
  raw: unknown,
  deviceCount: number,
  clientCount: number | null = null,
  sync = '—',
): SiteRow | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const name = str(r.name);
  if (!name) return null;
  const site = siteIdForName(name);
  return {
    id: site.siteId,
    name: site.siteName,
    subnet: '—', // Mist's site object has no subnet concept
    planes: [{ name: 'MIST', tone: 'info' }],
    mix: '—', // the live merge derives the mix from reconciled devices
    devices: deviceCount,
    clients: clientCount === null ? '—' : formatCount(clientCount),
    health: null, // the sites endpoint reports no health score — cannot assert
    healthPct: '—',
    tone: 'stale',
    alerts: '—',
    alertTone: 'neutral',
    sync,
  };
}

/**
 * Client kind from the fields Mist populates (family/model/os/manufacture) —
 * the same vocabulary central's mapper reads, against Mist's field names.
 */
function clientTypeFor(r: Record<string, unknown>): ClientType {
  const s = [str(r.family), str(r.model), str(r.os), str(r.manufacture), str(r.device_type)]
    .filter((value): value is string => value !== null)
    .join(' ')
    .toLowerCase();
  if (/ipad|tablet/.test(s)) return 'tablet';
  // 'voip' BEFORE 'phone' (same reason as central's mapper): 'VoIP Phone' /
  // 'IP Phone' / 'SIP handset' all contain 'phone', so a generic phone test
  // first makes this branch unreachable. \b guards keep 'iPhone' out.
  if (/voip|voice|\bsip\b|\bip ?phone\b|handset/.test(s)) return 'voip';
  if (/iphone|android|smart ?phone|\bmobile\b|\bphone\b/.test(s)) return 'phone';
  if (/windows|mac ?os|linux|ubuntu|chrome/.test(s)) return 'laptop';
  if (/print/.test(s)) return 'printer';
  if (/roku|smart ?tv|television|audio|video|media/.test(s)) return 'media';
  if (/camera|imaging|x-?ray/.test(s)) return 'imaging';
  if (/medical|infusion|clinical/.test(s)) return 'medical';
  if (/sensor|building|thermostat|lighting|iot/.test(s)) return 'building';
  return 'unknown';
}

/**
 * Mist site client-stats row → ClientRow. `deviceNameByKey` maps an AP's MAC
 * or Mist id (both normalised) back to the inventory name, so `attach` reads
 * as a device the operator can click through to. This endpoint is the
 * wireless roster — Mist keeps wired clients on a separate surface, so the
 * medium is not inferred. The roster row also carries the floor-plan
 * position (x/y in map-image pixels, x_m/y_m in meters, map_id) — x/y/mapId
 * ride the row for the map renderer, set only as a complete position (both
 * coordinates AND the map they refer to; a partial one renders nothing).
 */
export function mapMistClient(
  raw: unknown,
  siteNameById: ReadonlyMap<string, string>,
  deviceNameByKey: ReadonlyMap<string, string> = new Map(),
): ClientRow | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const mac = str(r.mac);
  if (!mac) return null; // a client row without a MAC is junk
  const siteUuid = str(r.site_id);
  const site = siteIdForName(siteUuid !== null ? (siteNameById.get(siteUuid) ?? null) : null);
  const apKey = macKey(str(r.ap_mac)) ?? str(r.ap_id)?.toLowerCase() ?? null;
  const band = str(r.band);
  const channel = num(r.channel);
  const rssi = num(r.rssi);
  const snr = num(r.snr);
  const uptime = num(r.uptime);
  const vlan = str(r.vlan ?? r.vlan_id);
  const x = num(r.x);
  const y = num(r.y);
  const mapId = str(r.map_id);
  // Retries and throughput ARE on the roster row (per-direction frame/packet
  // counters and current bit rates) — compute from them, never assume.
  const txRetries = num(r.tx_retries);
  const rxRetries = num(r.rx_retries);
  const txPkts = num(r.tx_pkts);
  const rxPkts = num(r.rx_pkts);
  const txBps = num(r.tx_bps);
  const rxBps = num(r.rx_bps);
  // A percentage only when both sides of the ratio were reported; 0 packets
  // is not evidence of 0 retries.
  const retries =
    txRetries !== null && rxRetries !== null && txPkts !== null && rxPkts !== null && txPkts + rxPkts > 0
      ? `${(((txRetries + rxRetries) / (txPkts + rxPkts)) * 100).toFixed(1)}%`
      : '—';
  const tput =
    [txBps !== null ? `↑${rateString(txBps)}` : null, rxBps !== null ? `↓${rateString(rxBps)}` : null]
      .filter((v): v is string => v !== null)
      .join(' · ') || '—';
  return {
    name: str(r.username) ?? str(r.hostname) ?? mac,
    model: str(r.model) ?? str(r.os) ?? str(r.family) ?? 'unknown',
    type: clientTypeFor(r),
    mac,
    ip: str(r.ip) ?? 'pending',
    medium: 'wireless',
    siteId: site.siteId,
    siteName: site.siteName,
    group: str(r.group) ?? '—', // carried on the stats row; blank means ungrouped
    attach: (apKey !== null ? (deviceNameByKey.get(apKey) ?? null) : null) ?? str(r.ap_mac) ?? '—',
    where: str(r.ssid) ?? '—',
    plane: 'MIST',
    planeTone: 'info',
    auth: str(r.key_mgmt) ?? '—',
    authBy: '—', // the stats roster does not name the authenticator; ClearPass rows will
    role: '—',
    vlan: vlan ?? '—',
    // Mist scores clients through SLE, not on this row — no invented health.
    health: '—',
    healthTone: 'neutral',
    quality: null,
    problem: false,
    session: uptime !== null ? durationString(uptime) : '—',
    link:
      [band !== null ? `${band} GHz` : null, channel !== null ? `ch ${channel}` : null]
        .filter((value): value is string => value !== null)
        .join(' · ') || '—',
    rssi: rssi !== null ? `${rssi} dBm` : '—',
    snr: snr !== null ? `${snr} dB` : '—',
    retries,
    tput,
    roams: '—', // the roster carries no roam count; only SLE/journey endpoints do
    zone: '—',
    closet: '—',
    // A map dot needs all three: both coordinates and the map they refer to.
    // Anything partial stays absent rather than placing a guessed dot.
    ...(x !== null && y !== null && mapId !== null ? { x, y, mapId } : {}),
  };
}

/** bits/s → compact rate ('128 kbps', '42 Mbps'), matching the client-table convention. */
function rateString(bps: number): string {
  if (bps >= 1e9) return `${(bps / 1e9).toFixed(1)} Gbps`;
  if (bps >= 1e6) return `${Math.round(bps / 1e6)} Mbps`;
  if (bps >= 1e3) return `${Math.round(bps / 1e3)} kbps`;
  return `${Math.round(bps)} bps`;
}

/**
 * Mist org wired-clients search row (`/orgs/{org}/wired_clients/search`
 * `results` row) → ClientRow with medium 'wired'. The row names the switch it
 * attaches to (switch_mac/switch_id, resolved through `deviceNameByKey` like
 * the wireless roster's ap_mac) and the port (`eth_port`/`port_id`); its byte
 * counters are CUMULATIVE totals, not rates — one reading cannot become a
 * throughput number, so `tput` only fills from an actual bps field and stays
 * '—' otherwise. No wireless readings exist on a wired row: rssi/snr/retries
 * are '—', never an invented 0.
 */
export function mapMistWiredClient(
  raw: unknown,
  siteNameById: ReadonlyMap<string, string>,
  deviceNameByKey: ReadonlyMap<string, string> = new Map(),
): ClientRow | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const mac = str(r.mac);
  if (!mac) return null; // a client row without a MAC is junk
  const siteUuid = str(r.site_id);
  const site = siteIdForName(siteUuid !== null ? (siteNameById.get(siteUuid) ?? null) : null);
  const switchKey = macKey(str(r.switch_mac)) ?? str(r.switch_id)?.toLowerCase() ?? null;
  const port = str(r.eth_port) ?? str(r.port_id);
  const uptime = num(r.uptime);
  const txBps = num(r.tx_bps);
  const rxBps = num(r.rx_bps);
  const tput =
    [txBps !== null ? `↑${rateString(txBps)}` : null, rxBps !== null ? `↓${rateString(rxBps)}` : null]
      .filter((v): v is string => v !== null)
      .join(' · ') || '—';
  return {
    name: str(r.hostname) ?? str(r.username) ?? mac,
    model: str(r.model) ?? str(r.os) ?? str(r.family) ?? 'unknown',
    type: clientTypeFor(r),
    mac,
    ip: str(r.ip) ?? 'pending',
    medium: 'wired',
    siteId: site.siteId,
    siteName: site.siteName,
    group: '—', // config groups are a wireless construct; not on this row
    attach: (switchKey !== null ? (deviceNameByKey.get(switchKey) ?? null) : null) ?? str(r.switch_mac) ?? '—',
    where: port !== null ? `port ${port}` : '—',
    plane: 'MIST',
    planeTone: 'info',
    auth: str(r.auth_state) ?? '—',
    authBy: '—', // the search row does not name the authenticator
    role: '—',
    vlan: str(r.vlan_id ?? r.vlan) ?? '—',
    health: '—', // Mist scores wireless through SLE; a wired row carries no health
    healthTone: 'neutral',
    quality: null,
    problem: false,
    session: uptime !== null ? durationString(uptime) : '—',
    link: '—', // no negotiated speed on the search row
    rssi: '—',
    snr: '—',
    retries: '—',
    tput,
    roams: '—',
    zone: '—',
    closet: '—',
  };
}

// ---------------------------------------------------------------------------
// AP rich stats (site stats/devices?type=ap)
// ---------------------------------------------------------------------------

function bool(v: unknown): boolean | null {
  return typeof v === 'boolean' ? v : null;
}

function obj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** radio_stat key → display band. The suffix rides through on an
 *  unrecognized key rather than being dropped. */
function bandLabel(key: string): string {
  if (key === 'band_24') return '2.4 GHz';
  if (key === 'band_5') return '5 GHz';
  if (key === 'band_6') return '6 GHz';
  return key.replace(/^band_/, '');
}

/** Fixed band order so a pull is deterministic regardless of JSON key order. */
const RADIO_BAND_ORDER = ['band_24', 'band_5', 'band_6'];

/**
 * `radio_stat` → one MistApRadioStats per band, in fixed band order. A band
 * whose entry is not an object is skipped; every reading on the surviving
 * bands stays null-when-unreported.
 */
export function mapMistRadioStats(raw: unknown): MistApRadioStats[] {
  const stat = obj(raw);
  if (!stat) return [];
  const keys = Object.keys(stat).sort((a, b) => {
    const ia = RADIO_BAND_ORDER.indexOf(a);
    const ib = RADIO_BAND_ORDER.indexOf(b);
    return (ia === -1 ? RADIO_BAND_ORDER.length : ia) - (ib === -1 ? RADIO_BAND_ORDER.length : ib) || a.localeCompare(b);
  });
  const out: MistApRadioStats[] = [];
  for (const key of keys) {
    const band = obj(stat[key]);
    if (!band) continue;
    out.push({
      band: bandLabel(key),
      channel: num(band.channel),
      bandwidthMHz: num(band.bandwidth),
      powerDbm: num(band.power),
      noiseFloorDbm: num(band.noise_floor),
      utilAllPct: num(band.util_all),
      utilTxPct: num(band.util_tx),
      utilRxInBssPct: num(band.util_rx_in_bss),
      utilRxOtherBssPct: num(band.util_rx_other_bss),
      utilNonWifiPct: num(band.util_non_wifi),
      numClients: num(band.num_clients),
    });
  }
  return out;
}

/** `port_stat` → one MistApPortStats per port, sorted by port name. */
export function mapMistPortStats(raw: unknown): MistApPortStats[] {
  const stat = obj(raw);
  if (!stat) return [];
  const out: MistApPortStats[] = [];
  for (const key of Object.keys(stat).sort()) {
    const port = obj(stat[key]);
    if (!port) continue;
    out.push({
      name: str(port.name) ?? key,
      up: bool(port.up),
      speedMbps: num(port.speed),
      fullDuplex: bool(port.full_duplex),
      rxBytes: num(port.rx_bytes),
      txBytes: num(port.tx_bytes),
      rxErrors: num(port.rx_errors),
      txErrors: num(port.tx_errors),
      peakBps: num(port.peak_bps),
    });
  }
  return out;
}

/** `env_stat` → MistApEnvStats; null when the block is absent or every
 *  reading in it is — an AP without env sensors is "not reported", not 0°C. */
export function mapMistEnvStats(raw: unknown): MistApEnvStats | null {
  const stat = obj(raw);
  if (!stat) return null;
  const env: MistApEnvStats = {
    ambientTempC: num(stat.ambient_temp),
    pressureHpa: num(stat.pressure),
    humidityPct: num(stat.humidity),
    accelX: num(stat.accel_x),
    accelY: num(stat.accel_y),
    accelZ: num(stat.accel_z),
  };
  return Object.values(env).every((v) => v === null) ? null : env;
}

/** `lldp_stat` → the AP's uplink edge; null when absent or content-free. */
export function mapMistLldpUplink(raw: unknown): MistApLldpUplink | null {
  const stat = obj(raw);
  if (!stat) return null;
  const uplink: MistApLldpUplink = {
    systemName: str(stat.system_name),
    systemDesc: str(stat.system_desc),
    portId: str(stat.port_id),
    chassisId: str(stat.chassis_id),
    mgmtAddr: str(stat.mgmt_addr),
  };
  return Object.values(uplink).every((v) => v === null) ? null : uplink;
}

/** Radio number by band, the convention every radio UI renders (2.4→0,
 *  5→1, 6→2); an unrecognized band keeps its walk order. */
function radioNumberFor(band: string, index: number): number {
  if (band === '2.4 GHz') return 0;
  if (band === '5 GHz') return 1;
  if (band === '6 GHz') return 2;
  return index;
}

/**
 * MistApRadioStats → the shared DeviceRadio the device page renders. Readings
 * Mist does not publish per radio (retries, drops, a channel-quality score)
 * stay null — never borrowed from a neighbour band. `status` is only ever
 * the config's DISABLED word; the stats row states no up/down of its own, so
 * an enabled radio reads '' (not stated), not a guessed 'UP'.
 */
export function mapApRadioDetail(
  radio: MistApRadioStats,
  index: number,
  disabledBands: ReadonlySet<string> = new Set(),
): DeviceRadio {
  return {
    number: radioNumberFor(radio.band, index),
    band: radio.band,
    channel: radio.channel !== null ? String(radio.channel) : '',
    bandwidth: radio.bandwidthMHz !== null ? `${radio.bandwidthMHz} MHz` : '',
    powerDbm: radio.powerDbm,
    clients: radio.numClients,
    channelUtilPct: radio.utilAllPct,
    rxUtilPct: radio.utilRxInBssPct,
    txUtilPct: radio.utilTxPct,
    retries: null, // not on the AP radio row
    drops: null,
    noiseFloorDbm: radio.noiseFloorDbm,
    nonWifiInterference: radio.utilNonWifiPct,
    channelQuality: null, // Mist publishes no per-radio quality score
    status: disabledBands.has(radio.band) ? 'DISABLED' : '',
    mode: '', // not reported on the stats row
  };
}

/**
 * MistApPortStats → the shared DevicePort, with the LLDP uplink named as the
 * port's neighbour (the AP's eth port IS the uplink side of that edge).
 * Counters the stats row does not carry (packets, drops) stay null.
 */
export function mapApPortDetail(port: MistApPortStats, lldp: MistApLldpUplink | null): DevicePort {
  const oper = port.up === null ? '' : port.up ? 'up' : 'down';
  return {
    name: port.name,
    status: oper,
    adminStatus: '', // not reported on the stats row
    operStatus: oper,
    speedBps: port.speedMbps !== null ? port.speedMbps * 1_000_000 : null,
    duplex: port.fullDuplex === null ? '' : port.fullDuplex ? 'full' : 'half',
    vlanMode: '', // an AP's eth0 carries the uplink trunk; not stated here
    counters: {
      rxBytes: port.rxBytes,
      txBytes: port.txBytes,
      rxPackets: null, // not on the AP port row
      txPackets: null,
      rxErrors: port.rxErrors,
      txErrors: port.txErrors,
      rxDropped: null,
      txDropped: null,
    },
    ...(lldp !== null
      ? {
          // The LLDP neighbour is by definition the far end of the uplink.
          uplink: true,
          ...(lldp.systemName !== null ? { neighbour: lldp.systemName } : {}),
          ...(lldp.portId !== null ? { neighbourPort: lldp.portId } : {}),
          ...(lldp.systemDesc !== null ? { neighbourType: lldp.systemDesc } : {}),
        }
      : {}),
  };
}

/**
 * One SITE-scoped AP stats row (GET /sites/{siteId}/stats/devices?type=ap) →
 * MistApStatsRow. Requires a name (or a mac to stand in for one); everything
 * else degrades field-by-field to null, so a lean row still maps and only
 * its absent readings stay unstated.
 */
export function mapMistApStats(
  raw: unknown,
  siteNameById: ReadonlyMap<string, string>,
): MistApStatsRow | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const name = str(r.name) ?? str(r.hostname) ?? str(r.mac);
  if (!name) return null;
  const siteUuid = str(r.site_id);
  const site = siteIdForName(siteUuid !== null ? (siteNameById.get(siteUuid) ?? null) : null);
  const ipStat = obj(r.ip_stat);
  return {
    deviceName: name,
    deviceUuid: str(r.id),
    mac: str(r.mac),
    serial: str(r.serial),
    siteId: site.siteId,
    siteName: site.siteName,
    numClients: num(r.num_clients),
    cpuUtilPct: num(r.cpu_util),
    memTotalKb: num(r.mem_total_kb),
    memUsedKb: num(r.mem_used_kb),
    uptimeSec: num(r.uptime),
    rxBps: num(r.rx_bps),
    txBps: num(r.tx_bps),
    extIp: str(r.ext_ip),
    dns: str(ipStat?.dns),
    gateway: str(ipStat?.gateway),
    dhcpServer: str(ipStat?.dhcp_server),
    powerSrc: str(r.power_src),
    powerConstrained: bool(r.power_constrained),
    radios: mapMistRadioStats(r.radio_stat),
    ports: mapMistPortStats(r.port_stat),
    env: mapMistEnvStats(r.env_stat),
    lldpUplink: mapMistLldpUplink(r.lldp_stat),
  };
}

// ---------------------------------------------------------------------------
// Floor plans (maps + AP config placements)
// ---------------------------------------------------------------------------

/**
 * One `/sites/{siteId}/maps` row → MistSiteMap with an empty `aps` list (the
 * placements join on afterwards, from the site device-config rows). The map
 * id is the join key — a row without one maps to null.
 */
export function mapMistMap(raw: unknown, siteNameById: ReadonlyMap<string, string>): MistSiteMap | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const mapId = str(r.id);
  if (!mapId) return null;
  const siteUuid = str(r.site_id);
  const site = siteIdForName(siteUuid !== null ? (siteNameById.get(siteUuid) ?? null) : null);
  return {
    siteId: site.siteId,
    siteName: site.siteName,
    mapId,
    name: str(r.name),
    imageUrl: str(r.url),
    widthPx: num(r.width),
    heightPx: num(r.height),
    widthM: num(r.width_m),
    heightM: num(r.height_m),
    orientationDeg: num(r.orientation),
    aps: [],
  };
}

/**
 * One site device-config row (`/sites/{siteId}/devices?type=ap`) → the AP's
 * placement on a map, or null when the row places the AP on no map (no
 * map_id — an unplaced AP is a real configuration state, not a failed map).
 * x/y null with a map_id means "assigned to the map, position not reported".
 */
export function mapMistApPosition(
  raw: unknown,
  deviceNameByKey: ReadonlyMap<string, string> = new Map(),
): { mapId: string; ap: MistSiteMapAp } | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const mapId = str(r.map_id);
  if (!mapId) return null;
  const mac = str(r.mac);
  const key = macKey(mac) ?? str(r.id)?.toLowerCase() ?? null;
  const name = str(r.name) ?? (key !== null ? (deviceNameByKey.get(key) ?? null) : null) ?? mac;
  if (!name) return null;
  return {
    mapId,
    ap: { deviceName: name, deviceUuid: str(r.id), mac, x: num(r.x), y: num(r.y) },
  };
}

// ---------------------------------------------------------------------------
// Rogue & neighbor APs (site insights/rogues)
// ---------------------------------------------------------------------------

/**
 * One `/sites/{siteId}/insights/rogues` row → MistRogueApRow. `bssid` is the
 * identity — a row without one maps to null. The row's own `site_id` wins;
 * `siteUuidHint` (the site whose walk returned the row) is the fallback,
 * because the report is site-scoped by URL and not every row repeats the id.
 * `seen_on_lan` is carried as a tri-state: true is the on-your-wire alarm,
 * false a plain neighbor, null "the row did not say" — never an assumed
 * safe-looking false.
 */
export function mapMistRogueAp(
  raw: unknown,
  siteNameById: ReadonlyMap<string, string>,
  siteUuidHint?: string,
): MistRogueApRow | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const bssid = str(r.bssid);
  if (!bssid) return null;
  const siteUuid = str(r.site_id) ?? siteUuidHint ?? null;
  const site = siteIdForName(siteUuid !== null ? (siteNameById.get(siteUuid) ?? null) : null);
  return {
    siteId: site.siteId,
    siteName: site.siteName,
    bssid,
    ssid: str(r.ssid),
    channel: num(r.channel),
    avgRssi: num(r.avg_rssi),
    numAps: num(r.num_aps),
    seenOnLan: bool(r.seen_on_lan),
  };
}

// ---------------------------------------------------------------------------
// Org audit log (logs/search — on-demand, behind mistAuditLog below)
// ---------------------------------------------------------------------------

/** Field names that mark secret material on a before/after snapshot — the
 *  same vocabulary WLAN_SECRET_KEY covers, plus tokens and API keys. Values
 *  under these keys are replaced with a marker, never copied. */
const AUDIT_SECRET_KEY = /psk|secret|passphrase|password|private[_-]?key|token|api[_-]?key/i;

/** The marker a redacted value becomes — says a value WAS there. */
const AUDIT_REDACTED = '<redacted by the portal>';

/** Cap on a serialized snapshot so a whale of a config object cannot make a
 *  drawer row unreadable; the truncation is stated, not silent. */
const AUDIT_SNAPSHOT_MAX_CHARS = 1200;

/**
 * before/after → compact JSON with every secret-shaped value replaced by the
 * redaction marker, recursively. null when the entry carried no snapshot at
 * all (absent is "not reported", distinct from an empty object). The audit
 * log's snapshots can hold a cleartext WLAN PSK — this scrub is the same
 * discipline mapMistWlan applies to the live WLAN read.
 */
export function scrubMistAuditSnapshot(raw: unknown): string | undefined {
  if (raw === null || raw === undefined) return undefined;
  const scrub = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(scrub);
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
        out[key] = AUDIT_SECRET_KEY.test(key) ? AUDIT_REDACTED : scrub(entry);
      }
      return out;
    }
    return value;
  };
  let text: string;
  try {
    text = JSON.stringify(scrub(raw));
  } catch {
    return undefined; // an unserializable snapshot is not reportable
  }
  if (text === undefined) return undefined;
  return text.length > AUDIT_SNAPSHOT_MAX_CHARS ? `${text.slice(0, AUDIT_SNAPSHOT_MAX_CHARS)}… (truncated)` : text;
}

/**
 * One `/orgs/{orgId}/logs/search` `results` row → MistAuditLogRow. `admin`
 * arrives as an email string on current payloads; the object spellings
 * ({email} / {name}) are accepted defensively. `timestamp` is epoch ms (or
 * seconds on older rows — parseTimestamp reads both). A row with neither an
 * id nor a message is junk. A site_id that does not resolve to a known site
 * stays null/null — "site-scoped, site unknown" is not the 'multiple'
 * pseudo-site.
 */
export function mapMistAuditLogEntry(
  raw: unknown,
  siteNameById: ReadonlyMap<string, string>,
): MistAuditLogRow | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const id = str(r.id ?? r.log_id);
  const message = str(r.message) ?? str(r.msg);
  if (!id && !message) return null;
  const adminObj = obj(r.admin);
  const ts = parseTimestamp(r.timestamp ?? r.created_time ?? r.time);
  const siteUuid = str(r.site_id);
  const siteName = siteUuid !== null ? (siteNameById.get(siteUuid) ?? null) : null;
  const site = siteIdForName(siteName);
  const before = scrubMistAuditSnapshot(r.before);
  const after = scrubMistAuditSnapshot(r.after);
  return {
    id,
    at: ts !== null ? new Date(ts).toISOString() : null,
    admin: str(r.admin) ?? str(adminObj?.email) ?? str(adminObj?.name),
    message: message ?? '—',
    siteId: siteName !== null ? site.siteId : null,
    siteName,
    ...(before !== undefined ? { before } : {}),
    ...(after !== undefined ? { after } : {}),
  };
}

// ---------------------------------------------------------------------------
// Org webhook subscriptions (the receiver's auto-registration surface)
// ---------------------------------------------------------------------------

/**
 * One `/orgs/{orgId}/webhooks` row → the SECRET-FREE subscription shape.
 * Whitelist-mapped like mapMistWlan: the subscription's `secret` is a
 * signing credential, so only its PRESENCE is read (`secretConfigured`) —
 * the value itself never enters a pull, a route response, a log line or the
 * audit journal. A row without an id cannot be addressed for an update and
 * maps to null.
 */
export function mapMistWebhookSubscription(raw: unknown): MistWebhookSubscription | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const id = str(r.id);
  if (!id) return null;
  const topics = Array.isArray(r.topics) ? r.topics.map(str).filter((t): t is string => t !== null) : [];
  return {
    id,
    name: str(r.name),
    url: str(r.url),
    topics,
    enabled: bool(r.enabled),
    secretConfigured: typeof r.secret === 'string' ? r.secret.length > 0 : null,
  };
}

// ---------------------------------------------------------------------------
// SLE drill-down (lazy per-metric reads)
// ---------------------------------------------------------------------------

/** Rows out of an impacted-users/-aps body: bare array, `{results: []}` or
 *  the endpoint's own `{users: []}` / `{aps: []}` spelling. */
function impactedRows(body: unknown, kind: 'users' | 'aps'): unknown[] {
  const rows = extractRows(body);
  if (rows.length > 0) return rows;
  const r = obj(body);
  return r && Array.isArray(r[kind]) ? (r[kind] as unknown[]) : [];
}

/** …/impacted-users body → the clients the metric names as hurt. */
export function mapMistSleImpactedClients(body: unknown): MistSleImpactedClient[] {
  const out: MistSleImpactedClient[] = [];
  for (const raw of impactedRows(body, 'users')) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const mac = str(r.mac);
    if (!mac) continue;
    out.push({
      mac,
      name: str(r.hostname) ?? str(r.username) ?? str(r.name),
      degraded: num(r.degraded) ?? num(r.num_degraded),
    });
  }
  return out;
}

/** …/impacted-aps body → the APs the metric names as hurt. */
export function mapMistSleImpactedAps(body: unknown): MistSleImpactedAp[] {
  const out: MistSleImpactedAp[] = [];
  for (const raw of impactedRows(body, 'aps')) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const mac = str(r.mac);
    if (!mac) continue;
    out.push({
      mac,
      name: str(r.name) ?? str(r.hostname),
      degraded: num(r.degraded) ?? num(r.num_degraded),
    });
  }
  return out;
}

/** An interval-count series verbatim, null entries preserved (an interval
 *  Mist reported no count for is a gap, not a 0). */
function nullableSeries(v: unknown): Array<number | null> {
  if (!Array.isArray(v)) return [];
  return v.map((item) => num(item));
}

/**
 * …/summary-trend body → MistSleTrend; null when the body carries no samples
 * object at all (a 200 with nothing readable is a failed read, not an empty
 * trend). Empty series are kept — "the window had no intervals" is a real
 * answer when Mist says it.
 */
export function mapMistSleTrend(body: unknown): MistSleTrend | null {
  const r = obj(body);
  const samples = obj(r?.samples);
  if (!r || !samples) return null;
  return {
    startSec: num(r.start),
    endSec: num(r.end),
    intervalSec: num(r.interval),
    total: nullableSeries(samples.total),
    degraded: nullableSeries(samples.degraded),
  };
}

/** 'device_down' / 'health-check-failed' → 'Device down' when no prose field exists. */
function humanizeAlarmType(raw: string): string {
  const words = raw.replace(/[_-]+/g, ' ').trim();
  return words.length === 0 ? raw : words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * Mist org alarm (alarms/search `results` row) → AlertRow. Mist severities are
 * 'critical'/'warn'/'info', which sevFor() already maps to P1/P2/P3; the
 * timestamp is epoch seconds (often fractional), which parseTimestamp reads.
 * An acked or resolved alarm must not surface as open.
 */
export function mapMistAlarm(
  raw: unknown,
  siteNameById: ReadonlyMap<string, string>,
  nowMs: number = Date.now(),
): AlertRow | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const typeRaw = str(r.type);
  const title = str(r.display_name) ?? (typeRaw !== null ? humanizeAlarmType(typeRaw) : null) ?? str(r.group);
  const detail = str(r.text) ?? str(r.details) ?? strList(r.reasons) ?? str(r.group);
  if (!title && !detail) return null;
  const sev = sevFor(str(r.severity));
  const ts = parseTimestamp(r.timestamp ?? r.last_seen ?? r.when ?? r.created_time);
  const statusRaw = (str(r.status) ?? '').toLowerCase();
  const acked = r.acked === true || statusRaw.includes('ack');
  const cleared = r.resolved === true || /clear|resolv|clos/.test(statusRaw);
  const siteUuid = str(r.site_id);
  const site = siteIdForName(siteUuid !== null ? (siteNameById.get(siteUuid) ?? null) : null);
  const alertId = str(r.id ?? r.alarm_id);
  return {
    sev,
    tone: sev === 'P1' ? 'danger' : sev === 'P2' ? 'warning' : 'info',
    title: title ?? 'Alarm',
    detail: detail ?? '',
    siteId: site.siteId,
    siteName: site.siteName,
    plane: 'MIST',
    // 'cleared' first: Mist leaves `acked` true on an alarm it later resolves,
    // and a resolved alarm reading 'acked' would keep it in the open queue.
    state: cleared ? 'cleared' : acked ? 'acked' : 'open',
    age: ts !== null ? ageString(ts, nowMs) : '—',
    device: strList(r.hostnames) ?? str(r.hostname) ?? strList(r.aps) ?? strList(r.switches) ?? '',
    ...(alertId ? { alertId } : {}),
  };
}

/** Case/separator-insensitive metric match: 'ap_health' / 'ap-health' /
 *  'ap health' all name the same SLE dimension. */
function normalizeClassifier(raw: string): string {
  return raw.toLowerCase().replace(/[\s_-]+/g, '');
}

/** Sum a per-interval sample series whose entries may be null. null when the
 *  series is absent or holds no countable value — never an assumed 0. */
function sumSeries(v: unknown): number | null {
  if (!Array.isArray(v)) return null;
  let total = 0;
  let seen = false;
  for (const item of v) {
    const n = num(item);
    if (n !== null) {
      total += n;
      seen = true;
    }
  }
  return seen ? total : null;
}

/** `sle_summary_impact` / `sle_classifier_impact` → MistSleImpact; null when
 *  the object carried none of the four counts. */
export function mapMistSleImpact(raw: unknown): MistSleImpact | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const impact: MistSleImpact = {
    numUsers: num(r.num_users),
    numAps: num(r.num_aps),
    totalUsers: num(r.total_users),
    totalAps: num(r.total_aps),
  };
  return Object.values(impact).every((v) => v === null) ? null : impact;
}

/** One `sle_classifier` entry — name plus its summed series and impact. */
export function mapMistSleClassifier(raw: unknown): MistSleClassifier | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const name = str(r.name);
  if (!name) return null;
  const samples = r.samples && typeof r.samples === 'object' ? (r.samples as Record<string, unknown>) : null;
  return {
    name,
    samples: sumSeries(samples?.total),
    degraded: sumSeries(samples?.degraded),
    durationSec: sumSeries(samples?.duration),
    impact: mapMistSleImpact(r.impact),
  };
}

/**
 * One site SLE summary (GET .../sle/site/{id}/metric/{metric}/summary) →
 * MistSleMetric. `success` is DERIVED from the summed sample counts
 * (1 − Σdegraded/Σtotal) rather than read off the `value` series, whose unit
 * the wire does not state; it stays null when either count is missing or the
 * window held no samples. Returns null for a payload with nothing readable —
 * a 200 the caller cannot stand behind is a failed read, not an empty one.
 */
export function mapMistSleSummary(metric: string, raw: unknown): MistSleMetric | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const sle = r.sle && typeof r.sle === 'object' ? (r.sle as Record<string, unknown>) : null;
  const samples = sle?.samples && typeof sle.samples === 'object' ? (sle.samples as Record<string, unknown>) : null;
  const total = sumSeries(samples?.total);
  const degraded = sumSeries(samples?.degraded);
  const impact = mapMistSleImpact(r.impact);
  const classifiers = (Array.isArray(r.classifiers) ? r.classifiers : [])
    .map(mapMistSleClassifier)
    .filter((c): c is MistSleClassifier => c !== null);
  if (total === null && degraded === null && impact === null && classifiers.length === 0) return null;
  return {
    name: metric,
    success: total !== null && degraded !== null && total > 0 ? 1 - degraded / total : null,
    samples: total,
    degraded,
    impact,
    classifiers,
  };
}

/**
 * One site's successful metric summaries → its MistSleRow. The four headline
 * dimensions read the matching metric's derived success fraction
 * (time-to-connect and ap-availability ride only in `metrics` — they have no
 * column of their own); `wan` stays null because the fixed metric set scores
 * no WAN dimension. `overall` averages only the dimensions present, so a
 * site a metric 404'd for is not penalised on a dimension Mist never scored.
 */
export function mapMistSle(
  siteUuid: string,
  metrics: readonly MistSleMetric[],
  siteNameById: ReadonlyMap<string, string>,
): MistSleRow | null {
  if (metrics.length === 0) return null;
  const name = siteNameById.get(siteUuid) ?? null;
  const site = siteIdForName(name);
  const byMetric = new Map(metrics.map((m) => [normalizeClassifier(m.name), m.success]));
  const coverage = byMetric.get('coverage') ?? null;
  const capacity = byMetric.get('capacity') ?? null;
  const roaming = byMetric.get('roaming') ?? null;
  const apHealth = byMetric.get('aphealth') ?? null;
  const present = [coverage, capacity, roaming, apHealth].filter((v): v is number => v !== null);
  const overall = present.length > 0 ? present.reduce((a, b) => a + b, 0) / present.length : null;
  return {
    siteId: site.siteId,
    siteName: site.siteName,
    coverage,
    capacity,
    roaming,
    apHealth,
    wan: null, // no WAN metric in the verified set — not a source we can read
    overall,
    metrics: [...metrics],
  };
}

/** Mist `wlans.auth.type` → the same display-label vocabulary Central's
 *  mapCentralSsid uses, so Configure rows read consistently across planes. */
function mistSecurityLabel(authType: string | null): string {
  const s = (authType ?? '').toLowerCase();
  if (s === 'eap' || s === '8021x' || s === 'dot1x') return 'WPA2-Enterprise';
  if (s === 'psk' || s === 'wpa2-psk' || s === 'wpa3-sae') return 'WPA2-PSK';
  if (s === 'open') return 'Open';
  return authType ?? 'Not reported';
}

/** Field names that mark secret material on a Mist WLAN payload — psk,
 *  portal_api_secret, RADIUS/shared secrets, private keys. Used ONLY to
 *  drive the redaction note; the values themselves are never read out. */
const WLAN_SECRET_KEY = /psk|secret|passphrase|password|private[_-]?key/i;

/** The enabled/disabled word a site WLAN row's `targets` ends with. */
function wlanStateWord(enabled: boolean | null): string {
  return enabled === null ? 'state not reported' : enabled ? 'enabled' : 'disabled';
}

/**
 * A Mist SITE WLAN (GET /sites/{siteId}/wlans row) → SsidObject. Mist has no
 * separate profile-name/broadcast-name split — `ssid` IS the identifier — so
 * both `name` and the broadcast label read the same field, and `targets`
 * names the site this WLAN is configured at plus its enabled state.
 *
 * SECURITY: the site payload carries `auth.psk` IN CLEARTEXT (and portal /
 * RADIUS secrets on WLANs that have them). This mapper WHITELIST-maps —
 * ssid, vlan_id, enabled and auth.type are the only fields read — so the
 * secret values can never flow into a pull, an API response, the
 * config-backup service, a log line or the audit journal. When secret
 * material is present the row's `note` says so ('PSK set — redacted…'),
 * because hiding that a PSK exists would be its own dishonesty.
 */
export function mapMistWlan(raw: unknown, siteName: string): SsidObject | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const name = str(r.ssid);
  if (!name) return null;
  const auth = r.auth && typeof r.auth === 'object' ? (r.auth as Record<string, unknown>) : {};
  const vlan = str(r.vlan_id) ?? '—';
  const enabled = typeof r.enabled === 'boolean' ? r.enabled : null;
  // Defensive sweep for the NOTE only: any secret-shaped field with a value
  // present, on the row or inside `auth`. Values are never copied anywhere.
  const secretKeys = new Set<string>();
  for (const scope of [r, auth]) {
    for (const [key, value] of Object.entries(scope)) {
      if (WLAN_SECRET_KEY.test(key) && typeof value === 'string' && value.length > 0) secretKeys.add(key);
    }
  }
  const notes: string[] = [];
  if ([...secretKeys].some((k) => /psk/i.test(k))) notes.push('PSK set — redacted by the portal');
  if ([...secretKeys].some((k) => !/psk/i.test(k))) notes.push('secret material redacted by the portal');
  return {
    kind: 'ssid',
    origin: 'configured',
    name,
    vlan,
    security: mistSecurityLabel(str(auth.type)),
    targets: `${siteName} · ${wlanStateWord(enabled)}`,
    plane: 'MIST',
    tone: 'accent',
    // The admin state rides the row so the edit drawer can seed its switch —
    // only when the payload reported it, never assumed.
    ...(enabled !== null ? { enabled } : {}),
    ...(notes.length > 0 ? { note: notes.join(' · ') } : {}),
  };
}

// ---------------------------------------------------------------------------
// Direct SSID write — site-scoped WLANs (/api/v1/sites/{site}/wlans).
// Symmetric with mapMistWlan above: that one reads a site WLAN into a display
// row, buildMistWlanPayload below is the reverse map this adapter writes.
// ---------------------------------------------------------------------------

/** SsidBands → Mist's `bands` array (dot11_band enum, OpenAPI-verified). */
const MIST_SSID_BANDS: Record<SsidBands, string[]> = {
  '5+6': ['5', '6'],
  all: ['24', '5', '6'],
  '5': ['5'],
};

export type MistWlanMapping =
  | { ok: true; payload: Record<string, unknown> }
  | { ok: false; reason: string };

/**
 * Build the site-scoped Mist WLAN body from the reviewed form. Only the
 * managed fields are asserted — everything else on the ~70-key row (dtim,
 * schedule, wxtag_ids, app_qos, portal, RADIUS servers, …) stays exactly as
 * the site has it.
 *
 * The mapping, and what is deliberately NOT mapped:
 *   name          → ssid
 *   vlan          → vlan_enabled: true + vlan_id (int 1-4094; the id only
 *                   applies server-side when vlan_enabled is set)
 *   wpa2-psk      → auth { type:'psk', psk: passphrase, pairwise:['wpa2-ccmp'] }
 *   open          → auth { type:'open' }
 *   bands         → bands ('5+6'→['5','6'], 'all'→['24','5','6'], '5'→['5'])
 *   broadcast=f   → hide_ssid: true
 *   isolate       → isolation (Mist's own client-isolation flag)
 *   enabled       → enabled, only when the form carries it — an edit that
 *                   never offered the switch must not assert an admin state
 *   wpa2/wpa3-enterprise, psk-portal → REFUSED (mistSsidSecurityRefusal):
 *                   enterprise rides the org's RADIUS auth_servers and a
 *                   captive portal is the WLAN's own `portal` object — a
 *                   Central server-group or portal-profile id can name
 *                   neither, and approximating one would be a silent edit.
 *   noDfs         → refused by the caller (an RF-profile change, not a WLAN
 *                   field) — the same refusal the Central path enforces.
 *   group         → never read: legacy CLI-preview field. The direct path
 *                   targets scopeIds, resolved to sites by uuid or name.
 *
 * SECURITY: `auth.psk` is the only secret-bearing field. Callers send this
 * object straight to Mist without logging it — it must never reach a log
 * line, an audit event, an error message, or a read-back.
 */
export function buildMistWlanPayload(form: SsidForm): MistWlanMapping {
  const refusal = mistSsidSecurityRefusal(form.security);
  if (refusal) return { ok: false, reason: refusal };
  const ssid = form.name.trim();
  if (!ssid) return { ok: false, reason: 'SSID name is required' };
  const vlanId = Number(form.vlan.trim());
  if (!Number.isInteger(vlanId) || vlanId < 1 || vlanId > 4094) {
    return { ok: false, reason: 'VLAN id must be a number between 1 and 4094' };
  }
  const payload: Record<string, unknown> = {
    ssid,
    vlan_enabled: true,
    vlan_id: vlanId,
    bands: MIST_SSID_BANDS[form.bands],
    hide_ssid: !form.broadcast,
    isolation: form.isolate,
    auth:
      form.security === 'wpa2-psk'
        ? { type: 'psk', psk: form.passphrase ?? '', pairwise: ['wpa2-ccmp'] }
        : { type: 'open' },
  };
  if (typeof form.enabled === 'boolean') payload.enabled = form.enabled;
  return { ok: true, payload };
}

/**
 * True when the managed fields on a read-back row differ from the desired
 * payload — the same subset-match discipline as central.ts's
 * wlanProfileChanged, with one addition: `auth.psk` is compared ONLY when the
 * desired payload carries it, and only ever in memory. A tenant that redacts
 * the key then forces a write instead of a false no-op (central.ts makes the
 * same call), and the value never reaches a log either way.
 */
export function mistWlanDiffers(current: unknown, desired: Record<string, unknown>): boolean {
  const cur = current && typeof current === 'object' ? (current as Record<string, unknown>) : {};
  return Object.entries(desired).some(([field, value]) => {
    if (field === 'auth') {
      const curAuth = cur.auth && typeof cur.auth === 'object' ? (cur.auth as Record<string, unknown>) : {};
      return Object.entries(value as Record<string, unknown>).some(
        ([k, v]) => JSON.stringify(curAuth[k] ?? null) !== JSON.stringify(v ?? null),
      );
    }
    // vlan_id comes back numeric or string depending on the tenant; compare
    // the canonical text of both.
    if (field === 'vlan_id') return str(cur.vlan_id) !== String(value);
    return JSON.stringify(cur[field] ?? null) !== JSON.stringify(value ?? null);
  });
}

/** The desired payload minus the write-only PSK — the shape a post-write
 *  read-back can honestly be verified against (the echo may redact the key,
 *  and the value must not be asserted on twice anyway). */
export function readableMistWlanPayload(desired: Record<string, unknown>): Record<string, unknown> {
  const auth = desired.auth && typeof desired.auth === 'object' ? { ...(desired.auth as Record<string, unknown>) } : {};
  delete auth.psk;
  return { ...desired, auth };
}

/**
 * `/orgs/{orgId}/devices/versions` body → model → recommended train. The
 * documented shape is a bare array of {model, version, tag} rows (a row
 * tagged 'suggested' is the recommendation; untagged rows are alternates),
 * parsed defensively: a search-style `{results: []}` envelope and the
 * `recommended`/`latest` field spellings are accepted too, and a 'suggested'
 * row always beats a plain one for the same model. Rows without both a model
 * and a version are skipped — a partial map only weakens verdicts back to
 * the "not known to be behind" default, it cannot invent one.
 */
export function parseMistFirmwareTrains(body: unknown): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of extractRows(body)) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const model = str(r.model);
    const version = str(r.version) ?? str(r.recommended) ?? str(r.latest) ?? str(r.latest_version);
    if (!model || !version) continue;
    const tag = (str(r.tag) ?? '').toLowerCase();
    if (tag === 'suggested' || !out.has(model)) out.set(model, version);
  }
  return out;
}

/** A service→count map as Mist's licence payloads carry them
 *  ({'SUB-MAN': 12}); null when the field is not an object or holds no
 *  numeric entry — never an empty map pretending to be data. */
function numberMap(v: unknown): Record<string, number> | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(v)) {
    const n = num(value);
    if (n !== null) out[key] = n;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * One `/orgs/{orgId}/licenses/usages` row → MistLicenseUsageRow. A row with
 * no site_id is not attributable to a site and is dropped; counts and maps
 * the row did not carry stay null (a 0 would read as "nothing consumed",
 * which the row did not say).
 */
export function mapMistLicenseUsage(
  raw: unknown,
  siteNameById: ReadonlyMap<string, string>,
): MistLicenseUsageRow | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const siteUuid = str(r.site_id);
  if (!siteUuid) return null;
  const site = siteIdForName(siteNameById.get(siteUuid) ?? null);
  return {
    siteId: site.siteId,
    siteName: site.siteName,
    numDevices: num(r.num_devices),
    numAps: num(r.num_aps),
    usages: numberMap(r.usages),
    fullyLoaded: numberMap(r.fully_loaded),
  };
}

/**
 * One `GET /api/v1/sites/{siteId}/topology` `results[]` entry → a graph node.
 * Mist's documented shape (mistsys/mist_openapi) carries id/mac/name/type —
 * no per-node connectivity or health verdict the way Central's topology does,
 * so `status`/`health` are left unstated rather than guessed.
 */
export function mapMistTopologyNode(raw: unknown): TopologyDeviceNode | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const mac = macKey(str(r.mac));
  // The graph key: Mist's node id is a MAC, not a device serial, but the
  // links below reference it the same way Central's links reference serials.
  const key = mac ?? str(r.id);
  if (!key) return null;
  const kind = str(r.type);
  const type = kind === 'ap' ? 'Access Point' : kind === 'switch' ? 'Switch' : kind === 'gateway' ? 'Gateway' : 'Unmanaged';
  const deviceFunction =
    kind === 'ap' ? 'Campus Access Point' : kind === 'switch' ? 'Access Switch' : kind === 'gateway' ? 'Mobility GW' : '-';
  return {
    serial: key,
    name: str(r.name) ?? mac ?? key,
    type,
    deviceFunction,
    status: '', // not stated by this endpoint's documented shape
    health: null,
    healthReason: null,
    model: null,
    ipv4: null,
    mac,
  };
}

/** One node's `links[]` entries → TopologyLink, keyed by the near node's MAC/id. */
export function mapMistTopologyLinks(raw: unknown, nearKey: string): TopologyLink[] {
  if (!Array.isArray(raw)) return [];
  const out: TopologyLink[] = [];
  for (const l of raw) {
    if (!l || typeof l !== 'object') continue;
    const rec = l as Record<string, unknown>;
    const farKey = macKey(str(rec.mac));
    if (!farKey) continue;
    const portId = str(rec.port_id);
    out.push({
      from: nearKey,
      to: farKey,
      fromPorts: [],
      toPorts: portId ? [{ name: portId }] : [],
      speedBps: null,
      // Mist's topology endpoint does not publish a link-level health
      // verdict in the documented shape — null, not a fabricated 'Good'.
      health: null,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

/** Rows are a bare array on list endpoints; search endpoints wrap in `results`. */
function extractRows(body: unknown): unknown[] {
  if (Array.isArray(body)) return body;
  if (body && typeof body === 'object') {
    const r = body as Record<string, unknown>;
    if (Array.isArray(r.results)) return r.results;
  }
  return [];
}

/** Grand total from a search envelope, or null when the payload states none. */
function extractTotal(body: unknown): number | null {
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    return num((body as Record<string, unknown>).total);
  }
  return null;
}

/** True when the body is a shape extractRows can actually read rows out of. */
function isRowContainer(body: unknown): boolean {
  if (Array.isArray(body)) return true;
  if (body && typeof body === 'object') return Array.isArray((body as Record<string, unknown>).results);
  return false;
}

/** The inventory hint for one stats row, looked up by mac first, then
 *  serial — the two keys the inventory read keys its rows on. */
function inventoryHintFor(
  raw: unknown,
  hints: ReadonlyMap<string, MistInventoryHint> | null,
): MistInventoryHint | undefined {
  if (hints === null || !raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const mac = macKey(str(r.mac));
  if (mac !== null) {
    const hit = hints.get(`mac:${mac}`);
    if (hit) return hit;
  }
  const serial = str(r.serial)?.toLowerCase();
  return serial ? hints.get(`serial:${serial}`) : undefined;
}

interface MistResponse {
  status: number;
  body: unknown;
  /** The body was readable JSON — a 200 that is not is not a zero-row answer. */
  parsed: boolean;
  /** X-Page-Total: the authoritative row count for the whole query. */
  pageTotal: number | null;
  /** X-Page-Limit: the page size the server actually used (it trims ours). */
  pageLimit: number | null;
  retryAfterMs?: number;
}

/** One paged walk: the merged rows plus whether the walk actually finished. */
interface FetchAllResult {
  rows: unknown[];
  truncated: boolean;
}

/** Section label → the shared dataset it feeds ('alarms' is Mist's word for alerts). */
const SECTION_DATASET: Record<string, PlaneDatasetKey> = {
  sites: 'sites',
  devices: 'devices',
  clients: 'clients',
  alarms: 'alerts',
  config: 'config',
  sle: 'mistSle',
  licenses: 'mistLicenseUsages',
  apstats: 'mistApStats',
  maps: 'mistMaps',
  rogues: 'mistRogues',
};

/**
 * Datasets this pull could not read in full — a section that failed outright
 * OR one whose paged walk did not finish. Both mean "not the whole picture",
 * which is what PlanePull.partial exists to say; a truncated dataset still
 * ships its rows, so omitting the key cannot express it.
 */
function partialDatasets(missing: readonly string[], truncated: readonly string[]): PlaneDatasetKey[] {
  const out = new Set<PlaneDatasetKey>();
  for (const s of [...missing, ...truncated]) {
    const key = SECTION_DATASET[s];
    if (key) out.add(key);
  }
  return [...out];
}

export class MistAdapter implements PlaneAdapter {
  readonly id = 'mist' as const;

  private readonly baseUrl: string;
  private readonly orgId: string;
  private readonly token: string;
  /** Portal site key (name and 'ext-<slug>' id) → Mist's native site UUID,
   *  refreshed on every pull() — the topology endpoint is keyed by the
   *  latter, but callers only hold the former (see central.ts's twin map). */
  private readonly nativeSiteIds = new Map<string, string>();
  /** serial/mac/uuid → the device's native refs (site UUID + device UUID),
   *  refreshed on every pull() from the org stats rows — the on-demand
   *  detail reads are keyed by Mist's device UUID, but callers hold the
   *  serial off the reconciled row (or the mac/uuid off a deep link). */
  private readonly deviceRefs = new Map<string, { siteUuid: string; deviceUuid: string }>();
  /** Mist site UUID → display name, refreshed on every pull() alongside
   *  nativeSiteIds — the on-demand audit-log read resolves site-scoped
   *  entries through it (pull()'s own siteNameById is local to the pull). */
  private readonly siteNamesByUuid = new Map<string, string>();

  constructor(
    creds: PlaneCredentials,
    private readonly stateRef: PlaneState,
    private readonly recordCall: RecordCallFn,
    private readonly fetchImpl: FetchLike = (url, init) => fetch(url, init),
    /** Injectable so tests exercise backoff/pacing without real wall time. */
    private readonly sleep: SleepFn = realSleep,
  ) {
    if (!MistAdapter.isComplete(creds)) {
      throw new Error('mist requires apiHost, orgId and token');
    }
    this.baseUrl = httpsBase(creds.apiHost, 'the API token is sent on every request').replace(/\/+$/, '');
    this.orgId = creds.orgId.trim();
    this.token = creds.token;
    // Publish the capability statement on the shared state too: nothing calls
    // PlaneAdapter.capabilities() yet, and this plane must never be mistaken
    // for one the portal can shell into or write to.
    this.stateRef.capabilities = this.capabilities();
  }

  static isComplete(creds: PlaneCredentials | null): boolean {
    return (
      !!creds &&
      [creds.apiHost, creds.orgId, creds.token].every((v) => typeof v === 'string' && v.trim().length > 0)
    );
  }

  /**
   * What the portal can do with Mist, stated honestly:
   *   localShell    false — cloud-claimed hardware; no collector or jump-host
   *                 path exists for it, so the recorded-SSH gate must not open.
   *   brokeredWrite false — the ticketed write broker never pushes to Mist.
   *   configRead    true — pull() reads the site-scoped WLANs back
   *                 (readConfig() below) into PlanePull.config.
   *   directWrite   true — ssidCatalog()/applySsidProfile()/deleteSiteWlan()
   *                 below are real: site-scoped WLAN create/update/delete via
   *                 /api/v1/sites/{site}/wlans, verified against the live org.
   *                 The review gate is the caller's (ssidDirectWrite.ts), not
   *                 a capability this flag grants on its own.
   */
  capabilities(): PlaneCapabilities {
    return { localShell: false, brokeredWrite: false, configRead: true, directWrite: true };
  }

  state(): PlaneState {
    return this.stateRef;
  }

  async pull(): Promise<PlanePull> {
    const org = encodeURIComponent(this.orgId);
    const missing: string[] = []; // sections that could not be read at all
    const truncated: string[] = []; // sections whose walk did not finish

    // -- required sections: this plane's inventory ---------------------------
    let sitesRead: FetchAllResult;
    try {
      sitesRead = await this.fetchAll(`/api/v1/orgs/${org}/sites`);
    } catch (err) {
      throw new Error(`mist pull: section 'sites' failed — ${(err as Error).message}`);
    }
    if (sitesRead.truncated) truncated.push('sites');
    const siteRows = sitesRead.rows;

    let devicesRead: FetchAllResult;
    try {
      devicesRead = await this.fetchAll(`/api/v1/orgs/${org}/stats/devices?type=all`);
    } catch (err) {
      throw new Error(`mist pull: section 'devices' failed — ${(err as Error).message}`);
    }
    if (devicesRead.truncated) truncated.push('devices');
    const deviceRows = devicesRead.rows;

    const siteNameById = new Map<string, string>();
    for (const s of siteRows) {
      if (!s || typeof s !== 'object') continue;
      const r = s as Record<string, unknown>;
      const id = str(r.id);
      const name = str(r.name);
      if (id && name) siteNameById.set(id, name);
    }
    // Refreshed wholesale each cycle: a site renamed/removed on the Mist side
    // must not leave a stale uuid answering for a name that no longer maps to it.
    this.nativeSiteIds.clear();
    this.siteNamesByUuid.clear();
    for (const [uuid, name] of siteNameById) {
      this.siteNamesByUuid.set(uuid, name);
      const mapped = siteIdForName(name);
      this.nativeSiteIds.set(mapped.siteName, uuid);
      this.nativeSiteIds.set(mapped.siteId, uuid);
    }

    // -- device enrichment (best-effort, never at the inventory's expense) ----
    // Two org reads that make the device rows say more: the per-model
    // recommended firmware trains (real `firmwareApproved` verdicts) and the
    // org inventory (claim codes, connected backfill). Either failing costs
    // the enrichment for the cycle — recorded in the call log, not in
    // `partial`, because the device rows themselves still ship complete.
    const firmwareTrains = await this.readFirmwareTrains(org);
    const inventoryHints = await this.readInventoryHints(org);
    const devices = deviceRows
      .map((d) => mapMistDevice(d, siteNameById, firmwareTrains ?? undefined, inventoryHintFor(d, inventoryHints)))
      .filter((d): d is MistDeviceRow => d !== null);

    // MAC/id → inventory name, so a client's `attach` names the AP it is on
    // rather than repeating a bare MAC. (No client counts are summed here:
    // the org stats rows carry no `num_clients` — see the header.)
    const deviceNameByKey = new Map<string, string>();
    // Refreshed wholesale each cycle alongside nativeSiteIds: the on-demand
    // detail reads (deviceDetail) are keyed by Mist's device UUID, and these
    // are the joins from the identities a caller actually holds.
    this.deviceRefs.clear();
    for (const d of deviceRows) {
      if (!d || typeof d !== 'object') continue;
      const r = d as Record<string, unknown>;
      const name = str(r.name) ?? str(r.hostname);
      if (name) {
        const mac = macKey(str(r.mac));
        if (mac) deviceNameByKey.set(mac, name);
        const id = str(r.id);
        if (id) deviceNameByKey.set(id.toLowerCase(), name);
      }
      const deviceUuid = str(r.id);
      const siteUuid = str(r.site_id);
      if (deviceUuid && siteUuid) {
        const ref = { siteUuid, deviceUuid };
        this.deviceRefs.set(`uuid:${deviceUuid.toLowerCase()}`, ref);
        const serial = str(r.serial)?.toLowerCase();
        if (serial) this.deviceRefs.set(`serial:${serial}`, ref);
        const mac = macKey(str(r.mac));
        if (mac) this.deviceRefs.set(`mac:${mac}`, ref);
      }
    }

    // -- optional sections: extra datasets, never at the inventory's expense --
    // A failure here omits the key (not an empty array) and notes the section,
    // so downstream reads it as unknown rather than as an authoritative zero.
    let alerts: AlertRow[] | null = null;
    try {
      const read = await this.fetchAll(`/api/v1/orgs/${org}/alarms/search?duration=1d`);
      if (read.truncated) truncated.push('alarms');
      alerts = read.rows.map((a) => mapMistAlarm(a, siteNameById)).filter((a): a is AlertRow => a !== null);
    } catch {
      missing.push('alarms'); // the status is already in the call log
    }

    const wireless = await this.pullClients(siteRows, siteNameById, deviceNameByKey, missing, truncated);
    const wired = await this.pullWiredClients(org, siteNameById, deviceNameByKey, wireless === null, truncated);
    // The roster is wireless + wired. A wireless failure omits the WHOLE
    // dataset — a wired-only list read as "the clients" is the lie rule 1
    // forbids; a wired failure with the wireless read OK ships the wireless
    // rows marked truncated (partial already names the dataset).
    const clients = wireless !== null ? [...wireless, ...(wired ?? [])] : null;

    // -- AP rich stats + floor plans (optional, non-fatal) ---------------------
    // Two more budget-gated per-site walks, same all-or-nothing contract as
    // the roster. The AP stats rows are also the ONLY surface carrying a
    // per-device num_clients (see the header) — pullApStats keeps them whole
    // so the Sites 'Clients' fallback below sums complete sites only.
    const mistApStats = await this.pullApStats(siteRows, siteNameById, missing, truncated);
    const mistMaps = await this.pullMaps(siteRows, siteNameById, deviceNameByKey, missing, truncated);

    // The rogue/neighbor report: one more budget-gated per-site walk, same
    // all-or-nothing contract as the roster/AP-stats walks. The on-your-wire
    // flag is the alarm half of it — a rogue on your own wire is the finding
    // the SiteDetail section leads with.
    const mistRogues = await this.pullRogues(siteRows, siteNameById, missing, truncated);

    // Config read is additive too: a failed site-WLAN walk must not touch
    // device/client/alarm inventory, it just reports its own gap via
    // ConfigInventory.unavailable (readConfig() below never throws).
    const config = await this.readConfig(siteRows, siteNameById);
    if (config.unavailable?.includes('ssids')) missing.push('config');

    // -- SLE (optional, non-fatal) --------------------------------------------
    // Service Level Expectations — the platform's headline per-site score,
    // from the site-scoped per-metric summaries (the org-insights call this
    // section first used 404s on live orgs; the dead call was removed).
    // pullSle() omits the section only on a TOTAL failure; a site row lands
    // with whichever metrics succeeded.
    const mistSle = await this.pullSle(siteRows, siteNameById, missing, truncated);

    // -- Licence usages (optional, non-fatal) ----------------------------------
    // Per-site consumption, one un-paginated org read. A failure omits the
    // key and names the section, same contract as alarms.
    let mistLicenseUsages: MistLicenseUsageRow[] | null = null;
    try {
      const body = await this.fetchRaw(`/api/v1/orgs/${org}/licenses/usages`);
      if (Array.isArray(body)) {
        mistLicenseUsages = body
          .map((u) => mapMistLicenseUsage(u, siteNameById))
          .filter((u): u is MistLicenseUsageRow => u !== null);
      } else {
        missing.push('licenses');
      }
    } catch {
      missing.push('licenses'); // the status is already in the call log
    }

    // -- rows ----------------------------------------------------------------
    const countBySite = new Map<string, number>();
    for (const d of devices) {
      countBySite.set(d.siteName, (countBySite.get(d.siteName) ?? 0) + 1);
    }
    const clientsBySite = new Map<string, number>();
    for (const c of clients ?? []) {
      clientsBySite.set(c.siteName, (clientsBySite.get(c.siteName) ?? 0) + 1);
    }
    // The AP-stats fallback for the Sites 'Clients' column, per MAPPED site:
    // the summed per-AP num_clients, but ONLY for a site whose every AP row
    // reported the field — a partial sum reads as an undercount, which is
    // worse than '—'. Used only when the roster itself was not read.
    const apClientsBySite = new Map<string, number>();
    if (mistApStats !== null) {
      const rowsBySite = new Map<string, MistApStatsRow[]>();
      for (const row of mistApStats) {
        const list = rowsBySite.get(row.siteName) ?? [];
        list.push(row);
        rowsBySite.set(row.siteName, list);
      }
      for (const [siteName, rows] of rowsBySite) {
        if (rows.length > 0 && rows.every((row) => row.numClients !== null)) {
          apClientsBySite.set(siteName, rows.reduce((sum, row) => sum + (row.numClients ?? 0), 0));
        }
      }
    }
    // Key the lookup by the MAPPED site name (same mapping the devices use) —
    // an aliased Mist name would otherwise count 0, and two Mist sites that
    // alias to one canonical id merge into a single SiteRow.
    // The site object has no per-site sync time, so the honest stamp is the
    // plane's own: when this adapter last completed a read. lastSync is written
    // by the poller AFTER pull() resolves, so cycle 1 legitimately says '—' and
    // every later cycle reports the previous successful read.
    const lastSyncMs = this.stateRef.lastSync !== null ? Date.parse(this.stateRef.lastSync) : Number.NaN;
    const syncStamp = Number.isNaN(lastSyncMs) ? '—' : ageString(lastSyncMs);
    const sites: SiteRow[] = [];
    const seenSiteIds = new Set<string>();
    for (const s of siteRows) {
      const r = s && typeof s === 'object' ? (s as Record<string, unknown>) : {};
      const mapped = siteIdForName(str(r.name));
      // The roster count when we read the roster. When the roster was NOT
      // read, the site AP-stats rows' summed num_clients is the only honest
      // fallback (complete sites only, computed above) — the org stats rows
      // carry no per-device client total, so without either, '—' is the
      // honest answer (never an assumed 0).
      const clientCount =
        clients !== null
          ? (clientsBySite.get(mapped.siteName) ?? 0)
          : (apClientsBySite.get(mapped.siteName) ?? null);
      const row = mapMistSite(s, countBySite.get(mapped.siteName) ?? 0, clientCount, syncStamp);
      if (row === null || seenSiteIds.has(row.id)) continue;
      seenSiteIds.add(row.id);
      sites.push(row);
    }

    // A count is an assertion of fact, so only sections we actually read get
    // one — "0 client sessions" for a section we never fetched would be a lie.
    const down = devices.filter((d) => d.state === 'down').length;
    const summary = [
      `${formatCount(devices.length)} devices across ${formatCount(sites.length)} sites`,
    ];
    if (down > 0) summary.push(`${formatCount(down)} down`);
    if (clients !== null) {
      const wiredCount = wired?.length ?? 0;
      summary.push(
        `${formatCount(clients.length)} client sessions${wiredCount > 0 ? ` (${formatCount(wiredCount)} wired)` : ''}`,
      );
    } else if (apClientsBySite.size > 0) {
      // The Sites column is showing device-reported sums, not a roster count
      // — the note must name the source, or the number reads as the roster's.
      summary.push('client counts from AP stats (roster unavailable)');
    }
    if (alerts !== null) {
      summary.push(`${formatCount(alerts.filter((a) => a.state === 'open').length)} open alarms`);
    }
    if (config.ssids && config.ssids.length > 0) summary.push(`${formatCount(config.ssids.length)} SSIDs`);
    if (mistSle !== null) summary.push(`${formatCount(mistSle.length)} SLE scores`);
    if (mistLicenseUsages !== null && mistLicenseUsages.length > 0) {
      summary.push(`${formatCount(mistLicenseUsages.length)} sites with licence usage`);
    }
    if (mistApStats !== null && mistApStats.length > 0) {
      summary.push(`${formatCount(mistApStats.length)} APs with rich stats`);
    }
    if (mistMaps !== null && mistMaps.length > 0) {
      summary.push(`${formatCount(mistMaps.length)} floor plans`);
    }
    if (mistRogues !== null && mistRogues.length > 0) {
      const onLan = mistRogues.filter((r) => r.seenOnLan === true).length;
      summary.push(
        `${formatCount(mistRogues.length)} rogue/neighbor BSSIDs${onLan > 0 ? ` (${formatCount(onLan)} on your wire)` : ''}`,
      );
    }
    if (missing.length > 0) summary.push(`not available: ${missing.join(', ')}`);
    if (truncated.length > 0) summary.push(`truncated: ${truncated.join(', ')}`);
    this.stateRef.note = summary.join(' · ');
    if (missing.length > 0 || truncated.length > 0) {
      // A dataset we could not read — or could not finish reading — must not
      // stamp the plane healthy and complete. 'warning' survives the poller's
      // markSyncResult(), which only restores a 'degraded' plane.
      this.stateRef.health = 'warning';
    } else if (this.stateRef.health === 'warning') {
      this.stateRef.health = 'healthy'; // first sync done
    }

    const partial = partialDatasets(missing, truncated);
    return {
      devices,
      sites,
      config,
      ...(clients === null ? {} : { clients }),
      ...(alerts === null ? {} : { alerts }),
      ...(mistSle !== null ? { mistSle } : {}),
      ...(mistLicenseUsages !== null ? { mistLicenseUsages } : {}),
      ...(mistApStats !== null ? { mistApStats } : {}),
      ...(mistMaps !== null ? { mistMaps } : {}),
      ...(mistRogues !== null ? { mistRogues } : {}),
      ...(partial.length > 0 ? { partial } : {}),
    };
  }

  /**
   * The plane's link topology for ONE site — GET /api/v1/sites/{siteId}/topology
   * (mistsys/mist_openapi). Callers (detailCache.ts's liveSiteTopology) hold
   * only the portal's site key (name, or the 'ext-<slug>' id minted from it);
   * nativeSiteIds (built fresh every pull()) resolves that back to Mist's
   * site UUID the endpoint actually wants.
   *
   * Returns null — not a failed read — when the site is unknown to this
   * plane, or when Mist answers 404: not every site has a topology graph, and
   * an absent graph is not evidence this adapter could not read one.
   */
  async siteTopology(siteId: string): Promise<SiteTopologyLive | null> {
    const id = (siteId ?? '').trim();
    if (!id) return null;
    const native = this.nativeSiteIds.get(id) ?? this.nativeSiteIds.get(siteIdForName(id).siteId) ?? null;
    if (native === null) return null; // not a Mist site — nothing this plane can answer
    const res = await this.get(`/api/v1/sites/${encodeURIComponent(native)}/topology`);
    if (res.status === 404) return null; // Mist does not publish a graph for every site
    const sections: Partial<Record<SiteTopologySection, DetailFetchState>> = {};
    const out: SiteTopologyLive = { siteId: id, source: { plane: 'mist', at: new Date().toISOString(), sections } };
    if (res.status < 200 || res.status >= 300 || !res.parsed) {
      sections.nodes = 'failed';
      sections.links = 'failed';
      out.source.note = `topology: HTTP ${res.status}`;
      return out;
    }
    const body = res.body && typeof res.body === 'object' ? (res.body as Record<string, unknown>) : {};
    const results = Array.isArray(body.results) ? body.results : null;
    if (results === null) {
      sections.nodes = 'failed';
      sections.links = 'failed';
      out.source.note = 'topology: a 200 whose body carried no readable `results` array';
      return out;
    }
    const nodes: TopologyDeviceNode[] = [];
    const links: TopologyLink[] = [];
    for (const item of results) {
      const node = mapMistTopologyNode(item);
      if (!node) continue;
      nodes.push(node);
      const rec = item as Record<string, unknown>;
      links.push(...mapMistTopologyLinks(rec.links, node.serial));
    }
    out.nodes = nodes;
    out.links = links;
    sections.nodes = nodes.length > 0 ? 'ok' : 'empty';
    sections.links = links.length > 0 ? 'ok' : 'empty';
    return out;
  }

  /**
   * Per-device detail for ONE Mist AP — the site-scoped UUID reads:
   * stats/devices/{uuid}?type=ap (radios, ports, LLDP uplink) plus the
   * device config (the radio enable/disable words the stats row does not
   * carry). Callers hold the reconciled row's serial; deviceRefs (rebuilt
   * every pull) joins serial/mac/uuid → the native refs. Unknown identity or
   * a non-AP kind returns null — this plane genuinely cannot answer those.
   *
   * Radios/ports come from the SAME row shape pullApStats maps, so the
   * detail agrees with the polled dataset by construction. A 404 means Mist
   * stopped reporting the AP (gone or re-claimed) — the sections fail with
   * that said, because "the plane has nothing" and "the plane says the
   * device is gone" are different sentences on screen.
   */
  async deviceDetail(serial: string, kind: DeviceDetailKind): Promise<DeviceDetailLive | null> {
    const id = (serial ?? '').trim();
    if (!id || kind !== 'ap') return null;
    const ref = this.deviceRefFor(id);
    if (ref === null) return null; // not a device this plane has synced
    const sections: Partial<Record<DeviceDetailSection, DetailFetchState>> = {};
    const out: DeviceDetailLive = {
      serial: id,
      kind,
      source: { plane: 'mist', at: new Date().toISOString(), sections },
    };
    const statsPath = `/api/v1/sites/${encodeURIComponent(ref.siteUuid)}/stats/devices/${encodeURIComponent(ref.deviceUuid)}?type=ap`;
    let statsBody: unknown;
    try {
      const res = await this.get(statsPath);
      if (res.status === 404) {
        sections.radios = 'failed';
        sections.ports = 'failed';
        out.source.note = 'device stats: HTTP 404 — Mist is not reporting this AP (gone, or re-claimed)';
        return out;
      }
      if (res.status < 200 || res.status >= 300 || !res.parsed) {
        sections.radios = 'failed';
        sections.ports = 'failed';
        out.source.note = `device stats: HTTP ${res.status}`;
        return out;
      }
      statsBody = res.body;
    } catch (err) {
      sections.radios = 'failed';
      sections.ports = 'failed';
      out.source.note = `device stats: ${(err as Error).message}`;
      return out;
    }
    const r = obj(statsBody) ?? {};
    const radioStats = mapMistRadioStats(r.radio_stat);
    const portStats = mapMistPortStats(r.port_stat);
    const env = mapMistEnvStats(r.env_stat);
    const lldp = mapMistLldpUplink(r.lldp_stat);

    // The config read is an ENHANCEMENT on top of the stats row: it carries
    // the admin enable/disable word per radio band that the stats row does
    // not. Its failure costs those words, never the whole read.
    const disabledBands = new Set<string>();
    try {
      const res = await this.get(
        `/api/v1/sites/${encodeURIComponent(ref.siteUuid)}/devices/${encodeURIComponent(ref.deviceUuid)}`,
      );
      if (res.status >= 200 && res.status < 300 && res.parsed) {
        const radioConfig = obj(obj(res.body)?.radio_config);
        if (radioConfig) {
          for (const key of Object.keys(radioConfig)) {
            if (obj(radioConfig[key])?.disabled === true) disabledBands.add(bandLabel(key));
          }
        }
      } else {
        out.source.note = `device config: HTTP ${res.status} — radio enable words not read`;
      }
    } catch (err) {
      out.source.note = `device config: ${(err as Error).message} — radio enable words not read`;
    }

    out.radios = radioStats.map((radio, index) => mapApRadioDetail(radio, index, disabledBands));
    sections.radios = out.radios.length > 0 ? 'ok' : 'empty';
    out.ports = portStats.map((port) => mapApPortDetail(port, lldp));
    sections.ports = out.ports.length > 0 ? 'ok' : 'empty';
    if (radioStats.length === 0 && portStats.length === 0 && env === null && lldp === null) {
      // A 200 with nothing readable is not an AP detail — say so.
      out.source.note = [out.source.note, 'the stats row carried no radio/port/env/lldp readings']
        .filter((n): n is string => !!n)
        .join(' · ');
    }
    return out;
  }

  /**
   * The SLE drill-down behind ONE metric at ONE site — classifiers,
   * impacted clients/APs and the summary trend, read LAZILY on the
   * drill-down request path (the poll reads only the per-metric summaries).
   * Same /sle/ family the poll verifies, same 404 semantics: a 404 means
   * the site does not score that drill (an honest 'empty', not a failure).
   * Unknown site → null, the "this plane cannot answer" contract.
   */
  async mistSleMetricDetail(siteId: string, metric: string): Promise<MistSleMetricDetail | null> {
    const id = (siteId ?? '').trim();
    const m = (metric ?? '').trim();
    if (!id || !m) return null;
    const native = this.nativeSiteIds.get(id) ?? this.nativeSiteIds.get(siteIdForName(id).siteId) ?? null;
    if (native === null) return null; // not a Mist site — nothing this plane can answer
    const site = siteIdForName(id);
    const sections: Partial<Record<MistSleDrillSection, DetailFetchState>> = {};
    const out: MistSleMetricDetail = {
      siteId: site.siteId,
      siteName: site.siteName,
      metric: m,
      source: { plane: 'mist', at: new Date().toISOString(), sections },
    };
    const base = `/api/v1/sites/${encodeURIComponent(native)}/sle/site/${encodeURIComponent(native)}/metric/${encodeURIComponent(m)}`;
    const failures: string[] = [];

    const classifiers = await this.drillGet(`${base}/classifiers`);
    if (classifiers.state === 'answered') {
      const rows = extractRows(classifiers.body)
        .map(mapMistSleClassifier)
        .filter((c): c is MistSleClassifier => c !== null);
      out.classifiers = rows;
      sections.classifiers = rows.length > 0 ? 'ok' : 'empty';
    } else {
      sections.classifiers = classifiers.state === 'not-found' ? 'empty' : 'failed';
      if (classifiers.state === 'failed') failures.push(`classifiers: ${classifiers.error}`);
    }

    const impactedUsers = await this.drillGet(`${base}/impacted-users`);
    if (impactedUsers.state === 'answered') {
      const rows = mapMistSleImpactedClients(impactedUsers.body);
      out.impactedClients = rows;
      sections.impactedClients = rows.length > 0 ? 'ok' : 'empty';
    } else {
      sections.impactedClients = impactedUsers.state === 'not-found' ? 'empty' : 'failed';
      if (impactedUsers.state === 'failed') failures.push(`impacted-users: ${impactedUsers.error}`);
    }

    const impactedAps = await this.drillGet(`${base}/impacted-aps`);
    if (impactedAps.state === 'answered') {
      const rows = mapMistSleImpactedAps(impactedAps.body);
      out.impactedAps = rows;
      sections.impactedAps = rows.length > 0 ? 'ok' : 'empty';
    } else {
      sections.impactedAps = impactedAps.state === 'not-found' ? 'empty' : 'failed';
      if (impactedAps.state === 'failed') failures.push(`impacted-aps: ${impactedAps.error}`);
    }

    const trend = await this.drillGet(`${base}/summary-trend`);
    if (trend.state === 'answered') {
      const mapped = mapMistSleTrend(trend.body);
      if (mapped !== null) {
        out.trend = mapped;
        sections.trend = 'ok';
      } else {
        sections.trend = 'failed'; // a 200 with nothing readable is a failed read
        failures.push('summary-trend: a 200 whose body carried no readable samples');
      }
    } else {
      sections.trend = trend.state === 'not-found' ? 'empty' : 'failed';
      if (trend.state === 'failed') failures.push(`summary-trend: ${trend.error}`);
    }

    if (failures.length > 0) out.source.note = failures.join(' · ');
    return out;
  }

  /**
   * The org's latest admin changes — GET /api/v1/orgs/{orgId}/logs/search
   * (paged). Read ON DEMAND for the Systems drawer's Mist section, never on
   * the poll: the drawer is the only consumer, and an org-wide search call
   * every 60s for a panel nobody has open is exactly the spend the on-demand
   * rule exists to prevent. Newest first, capped at `limit`.
   *
   * Never throws: a failed read marks the section 'failed' with the reason
   * (an audit log that cannot be read is not an empty one); site-scoped
   * entries resolve through the last pull's site map — before the first
   * pull, site names stay honestly null.
   */
  async mistAuditLog(limit = 25): Promise<MistAuditLogLive> {
    const sections: Partial<Record<MistAuditLogSection, DetailFetchState>> = {};
    const out: MistAuditLogLive = { source: { plane: 'mist', at: new Date().toISOString(), sections } };
    let read: FetchAllResult;
    try {
      read = await this.fetchAll(`/api/v1/orgs/${encodeURIComponent(this.orgId)}/logs/search`);
    } catch (err) {
      sections.logs = 'failed';
      out.source.note = `audit log: ${(err as Error).message}`;
      return out;
    }
    const entries = read.rows
      .map((row) => mapMistAuditLogEntry(row, this.siteNamesByUuid))
      .filter((row): row is MistAuditLogRow => row !== null);
    // Newest first; entries with no timestamp settle at the end in a stable
    // order rather than pretending to be current.
    entries.sort((a, b) => (b.at === null ? -1 : Date.parse(b.at)) - (a.at === null ? -1 : Date.parse(a.at)));
    out.entries = entries.slice(0, Math.max(1, limit));
    sections.logs = entries.length > 0 ? 'ok' : 'empty';
    return out;
  }

  /**
   * The org's webhook subscriptions, secret-free — the list half of the
   * receiver's auto-registration (services/mistWebhooks.ts orchestrates; the
   * review gate and the audit line are the CALLER's, exactly like the direct
   * SSID write path). null when the read failed — "we do not know the
   * subscriptions" is a different fact from "the org has none", and the
   * caller refuses to write in the first case.
   */
  async listMistWebhooks(): Promise<MistWebhookSubscription[] | null> {
    try {
      const read = await this.fetchAll(`/api/v1/orgs/${encodeURIComponent(this.orgId)}/webhooks`);
      return read.rows.map(mapMistWebhookSubscription).filter((s): s is MistWebhookSubscription => s !== null);
    } catch {
      return null; // the status is already in the call log
    }
  }

  /**
   * The write half of auto-registration: POST /orgs/{org}/webhooks when
   * `existingId` is null, PUT …/webhooks/{existingId} otherwise. The body
   * carries ONLY the managed fields (url/topics/enabled/name, plus `secret`
   * when a rotation was reviewed) — and the secret, when present, exists
   * nowhere else: not in the call log (method + path + status only, as
   * always), not in the return value, not in the audit journal.
   *
   * The response echoes the written object on current tenants; it is mapped
   * through the same secret-free mapper, so even an echo that carried the
   * secret back could not leak it downstream.
   */
  async writeMistWebhook(
    existingId: string | null,
    form: { url: string; name: string; topics: string[]; enabled: true; secret?: string },
  ): Promise<{ httpCode: number; ok: boolean; subscription: MistWebhookSubscription | null }> {
    const org = encodeURIComponent(this.orgId);
    const body: Record<string, unknown> = {
      name: form.name,
      url: form.url,
      topics: form.topics,
      enabled: form.enabled,
    };
    if (typeof form.secret === 'string' && form.secret.length > 0) body.secret = form.secret;
    const res = existingId
      ? await this.pacedRequest('PUT', `/api/v1/orgs/${org}/webhooks/${encodeURIComponent(existingId)}`, body)
      : await this.pacedRequest('POST', `/api/v1/orgs/${org}/webhooks`, body);
    const ok = res.status >= 200 && res.status < 300;
    return {
      httpCode: res.status,
      ok,
      subscription: ok ? mapMistWebhookSubscription(res.body) : null,
    };
  }

  // -- internals -------------------------------------------------------------

  /** serial / mac / uuid → the device's native refs, or null when no synced
   *  device matches (the "this plane cannot answer" case for detail reads). */
  private deviceRefFor(identity: string): { siteUuid: string; deviceUuid: string } | null {
    const bySerial = this.deviceRefs.get(`serial:${identity.toLowerCase()}`);
    if (bySerial) return bySerial;
    const byUuid = this.deviceRefs.get(`uuid:${identity.toLowerCase()}`);
    if (byUuid) return byUuid;
    const mac = macKey(identity);
    return mac !== null ? (this.deviceRefs.get(`mac:${mac}`) ?? null) : null;
  }

  /**
   * One drill-down read with the three honest outcomes separated:
   * 'answered' (2xx + readable JSON), 'not-found' (404 — the site does not
   * score that drill, an honest empty) and 'failed' (anything else,
   * transport included — get() throws on network errors). Never throws.
   */
  private async drillGet(
    path: string,
  ): Promise<{ state: 'answered'; body: unknown } | { state: 'not-found' } | { state: 'failed'; error: string }> {
    try {
      const res = await this.get(path);
      if (res.status === 404) return { state: 'not-found' };
      if (res.status < 200 || res.status >= 300) return { state: 'failed', error: `HTTP ${res.status}` };
      if (!res.parsed) return { state: 'failed', error: 'unreadable body' };
      return { state: 'answered', body: res.body };
    } catch (err) {
      return { state: 'failed', error: (err as Error).message };
    }
  }

  /**
   * The clients section: one paged walk per site, all or nothing. Past
   * SITE_FANOUT_BUDGET sites the fan-out is refused up front (quota), and a
   * failure part-way through discards what was read — half an org's roster
   * presented as the roster is worse than saying it is unavailable.
   */
  private async pullClients(
    siteRows: readonly unknown[],
    siteNameById: ReadonlyMap<string, string>,
    deviceNameByKey: ReadonlyMap<string, string>,
    missing: string[],
    truncated: string[],
  ): Promise<ClientRow[] | null> {
    const siteUuids = siteRows
      .map((s) => (s && typeof s === 'object' ? str((s as Record<string, unknown>).id) : null))
      .filter((id): id is string => id !== null);
    if (siteUuids.length > SITE_FANOUT_BUDGET) {
      missing.push('clients');
      return null;
    }
    const rows: unknown[] = [];
    let short = false;
    try {
      for (const uuid of siteUuids) {
        const read = await this.fetchAll(`/api/v1/sites/${encodeURIComponent(uuid)}/stats/clients`);
        if (read.truncated) short = true;
        rows.push(...read.rows);
      }
    } catch {
      missing.push('clients'); // the status is already in the call log
      return null;
    }
    if (short) truncated.push('clients');
    return rows.map((c) => mapMistClient(c, siteNameById, deviceNameByKey)).filter((c): c is ClientRow => c !== null);
  }

  /**
   * The wired roster: ONE org-wide search call (no fan-out, so no site
   * budget), mapped to ClientRow with medium 'wired' and merged into the
   * same `clients` dataset by pull(). A failure costs only the wired half:
   * `clients` is marked truncated — unless the wireless roster already
   * failed (`wirelessFailed`), in which case the dataset is already named
   * missing and this adds nothing. Returns null on failure, never an empty
   * list pretending the org has no wired clients.
   */
  private async pullWiredClients(
    org: string,
    siteNameById: ReadonlyMap<string, string>,
    deviceNameByKey: ReadonlyMap<string, string>,
    wirelessFailed: boolean,
    truncated: string[],
  ): Promise<ClientRow[] | null> {
    try {
      const read = await this.fetchAll(`/api/v1/orgs/${org}/wired_clients/search`);
      if (read.truncated) truncated.push('clients');
      return read.rows
        .map((c) => mapMistWiredClient(c, siteNameById, deviceNameByKey))
        .filter((c): c is ClientRow => c !== null);
    } catch {
      if (!wirelessFailed) truncated.push('clients'); // the status is already in the call log
      return null;
    }
  }

  /**
   * The AP rich-stats section: one paged walk per site of
   * stats/devices?type=ap — the radios/ports/env/LLDP/cpu/mem rows, and the
   * only surface carrying a per-device num_clients. Budget-gated and
   * all-or-nothing like the roster walk: a failure part-way through discards
   * what was read, because a partial walk would also poison the per-site
   * num_clients sums the Sites column falls back to.
   */
  private async pullApStats(
    siteRows: readonly unknown[],
    siteNameById: ReadonlyMap<string, string>,
    missing: string[],
    truncated: string[],
  ): Promise<MistApStatsRow[] | null> {
    const siteUuids = siteRows
      .map((s) => (s && typeof s === 'object' ? str((s as Record<string, unknown>).id) : null))
      .filter((id): id is string => id !== null);
    if (siteUuids.length === 0) return null; // no sites — nothing to walk
    if (siteUuids.length > SITE_FANOUT_BUDGET) {
      missing.push('apstats');
      return null;
    }
    const rows: unknown[] = [];
    let short = false;
    try {
      for (const uuid of siteUuids) {
        const read = await this.fetchAll(`/api/v1/sites/${encodeURIComponent(uuid)}/stats/devices?type=ap`);
        if (read.truncated) short = true;
        rows.push(...read.rows);
      }
    } catch {
      missing.push('apstats'); // the status is already in the call log
      return null;
    }
    if (short) truncated.push('apstats');
    return rows.map((d) => mapMistApStats(d, siteNameById)).filter((d): d is MistApStatsRow => d !== null);
  }

  /**
   * The floor-plan section: per site, the maps walk plus the AP config walk
   * (which carries each AP's x/y/map_id placement), joined into one
   * MistSiteMap per map. Budget-gated, paced, all-or-nothing. A site with no
   * maps answers 200 [] — a REAL empty the payload keeps (the live org
   * publishes zero maps); an AP placed on a map the maps walk did not return
   * is left off rather than given an invented map row.
   */
  private async pullMaps(
    siteRows: readonly unknown[],
    siteNameById: ReadonlyMap<string, string>,
    deviceNameByKey: ReadonlyMap<string, string>,
    missing: string[],
    truncated: string[],
  ): Promise<MistSiteMap[] | null> {
    const siteUuids = siteRows
      .map((s) => (s && typeof s === 'object' ? str((s as Record<string, unknown>).id) : null))
      .filter((id): id is string => id !== null);
    if (siteUuids.length === 0) return null; // no sites — nothing to walk
    if (siteUuids.length > SITE_FANOUT_BUDGET) {
      missing.push('maps');
      return null;
    }
    const maps: MistSiteMap[] = [];
    const positions: Array<{ mapId: string; ap: MistSiteMapAp }> = [];
    let short = false;
    try {
      for (const uuid of siteUuids) {
        const mapsRead = await this.fetchAll(`/api/v1/sites/${encodeURIComponent(uuid)}/maps`);
        if (mapsRead.truncated) short = true;
        for (const raw of mapsRead.rows) {
          const map = mapMistMap(raw, siteNameById);
          if (map !== null) maps.push(map);
        }
        await this.sleep(CALL_PACING_MS); // quota'd plane — pace the pair
        const configRead = await this.fetchAll(`/api/v1/sites/${encodeURIComponent(uuid)}/devices?type=ap`);
        if (configRead.truncated) short = true;
        for (const raw of configRead.rows) {
          const pos = mapMistApPosition(raw, deviceNameByKey);
          if (pos !== null) positions.push(pos);
        }
      }
    } catch {
      missing.push('maps'); // the status is already in the call log
      return null;
    }
    if (short) truncated.push('maps');
    const byMapId = new Map(maps.map((m) => [m.mapId, m]));
    for (const { mapId, ap } of positions) byMapId.get(mapId)?.aps.push(ap);
    return maps;
  }

  /**
   * The rogue/neighbor section: one paged walk per site of
   * insights/rogues — the BSSIDs the site's APs hear, with the on-your-wire
   * flag. Budget-gated and all-or-nothing like the other per-site walks: a
   * rogue report covering some sites, read as complete, is the lie rule 1
   * forbids. A site with nothing in earshot answers 200 [] — a REAL empty
   * the payload keeps.
   */
  private async pullRogues(
    siteRows: readonly unknown[],
    siteNameById: ReadonlyMap<string, string>,
    missing: string[],
    truncated: string[],
  ): Promise<MistRogueApRow[] | null> {
    const siteUuids = siteRows
      .map((s) => (s && typeof s === 'object' ? str((s as Record<string, unknown>).id) : null))
      .filter((id): id is string => id !== null);
    if (siteUuids.length === 0) return null; // no sites — nothing to walk
    if (siteUuids.length > SITE_FANOUT_BUDGET) {
      missing.push('rogues');
      return null;
    }
    const out: MistRogueApRow[] = [];
    let short = false;
    try {
      for (const uuid of siteUuids) {
        const read = await this.fetchAll(`/api/v1/sites/${encodeURIComponent(uuid)}/insights/rogues`);
        if (read.truncated) short = true;
        for (const raw of read.rows) {
          const row = mapMistRogueAp(raw, siteNameById, uuid);
          if (row !== null) out.push(row);
        }
      }
    } catch {
      missing.push('rogues'); // the status is already in the call log
      return null;
    }
    if (short) truncated.push('rogues');
    return out;
  }

  /**
   * The SLE section: one summary read per metric per site, from the fixed
   * SLE_METRICS set. Per-metric policy, stated precisely:
   *   - 404            → the site does not score that metric (no WAN edge, no
   *                      data) — an honest absence, NOT a failed read;
   *   - other failure  → that metric is omitted and counted; the site's other
   *                      metrics still land, and the section is marked
   *                      truncated so the plane does not stamp a half-read
   *                      dataset as a complete sync;
   *   - every read failed → the section is omitted and named unavailable —
   *                      never a fabricated all-null table.
   * Past SITE_FANOUT_BUDGET sites the fan-out (metrics × sites a cycle) is
   * refused up front, same quota rule as the clients walk.
   */
  private async pullSle(
    siteRows: readonly unknown[],
    siteNameById: ReadonlyMap<string, string>,
    missing: string[],
    truncated: string[],
  ): Promise<MistSleRow[] | null> {
    const siteUuids = siteRows
      .map((s) => (s && typeof s === 'object' ? str((s as Record<string, unknown>).id) : null))
      .filter((id): id is string => id !== null);
    if (siteUuids.length === 0) return null; // no sites — nothing to score
    if (siteUuids.length > SITE_FANOUT_BUDGET) {
      missing.push('sle');
      return null;
    }
    const rows: MistSleRow[] = [];
    let failures = 0;
    let successes = 0;
    for (const uuid of siteUuids) {
      const metrics: MistSleMetric[] = [];
      for (const metric of SLE_METRICS) {
        await this.sleep(CALL_PACING_MS); // quota'd plane — pace the fan-out
        const path = `/api/v1/sites/${encodeURIComponent(uuid)}/sle/site/${encodeURIComponent(uuid)}/metric/${metric}/summary`;
        try {
          const mapped = mapMistSleSummary(metric, await this.fetchRaw(path));
          if (mapped === null) {
            failures += 1; // a 200 with nothing readable is a failed read
          } else {
            metrics.push(mapped);
            successes += 1;
          }
        } catch (err) {
          if (!(err instanceof Error && err.message.includes('HTTP 404'))) failures += 1;
        }
      }
      const row = mapMistSle(uuid, metrics, siteNameById);
      if (row !== null) rows.push(row);
    }
    if (successes === 0 && failures > 0) {
      missing.push('sle');
      return null;
    }
    if (failures > 0) truncated.push('sle');
    // Every metric 404'd (an org with no SLE surface) reads as no rows and no
    // note — a missing feature surface is not a failed read.
    return rows.length > 0 ? rows : null;
  }

  /**
   * Site-scoped WLANs — the Configure screen's inventory for this plane.
   * `/orgs/{orgId}/wlans` answers [] on a live org (WLANs are SITE-scoped),
   * so this walks the sites like pullClients does: budget-gated, paced, and
   * all-or-nothing — a WLAN inventory covering some sites, read as complete,
   * is the lie rule 1 forbids. Non-fatal: a failure reports
   * `unavailable: ['ssids']` rather than failing pull(), same contract every
   * other optional section in this file uses.
   *
   * The same SSID configured identically at several sites merges into ONE row
   * whose `targets` names every site ('Campus A + Lab B · enabled') — that is
   * also what keeps the Configure screen's plane|name dedupe from hiding
   * sites. Rows that differ (state, vlan, security) stay separate.
   */
  private async readConfig(
    siteRows: readonly unknown[],
    siteNameById: ReadonlyMap<string, string>,
  ): Promise<ConfigInventory> {
    const siteUuids = siteRows
      .map((s) => (s && typeof s === 'object' ? str((s as Record<string, unknown>).id) : null))
      .filter((id): id is string => id !== null);
    const source = `Mist /api/v1/sites/{site}/wlans · ${siteUuids.length} sites`;
    if (siteUuids.length > SITE_FANOUT_BUDGET) return { mode: 'configured', unavailable: ['ssids'], source };
    try {
      const bySsid = new Map<string, { row: SsidObject; sites: string[] }>();
      for (const uuid of siteUuids) {
        await this.sleep(CALL_PACING_MS); // quota'd plane — pace the walk
        const body = await this.fetchRaw(`/api/v1/sites/${encodeURIComponent(uuid)}/wlans`);
        if (!Array.isArray(body)) throw new Error('unreadable body');
        const siteName = siteNameById.get(uuid) ?? uuid;
        for (const raw of body) {
          const row = mapMistWlan(raw, siteName);
          if (row === null) continue;
          const state = row.targets.slice(row.targets.lastIndexOf(' · ') + 3);
          const key = `${row.name}|${row.vlan}|${row.security}|${state}`.toLowerCase();
          const existing = bySsid.get(key);
          if (existing) {
            existing.sites.push(siteName);
            existing.row.targets = `${existing.sites.join(' + ')} · ${state}`;
            if (row.note && !existing.row.note?.includes(row.note)) {
              existing.row.note = existing.row.note ? `${existing.row.note} · ${row.note}` : row.note;
            }
          } else {
            bySsid.set(key, { row, sites: [siteName] });
          }
        }
      }
      return { mode: 'configured', ssids: [...bySsid.values()].map((v) => v.row), source };
    } catch {
      return { mode: 'configured', unavailable: ['ssids'], source };
    }
  }

  /**
   * Per-model recommended firmware trains (`/orgs/{orgId}/devices/versions`),
   * or null when the read failed — ENRICHMENT for the device rows, so a
   * failure costs the real firmware verdicts for the cycle (recorded in the
   * call log) but never fails the pull or empties a dataset.
   */
  private async readFirmwareTrains(org: string): Promise<Map<string, string> | null> {
    try {
      return parseMistFirmwareTrains(await this.fetchRaw(`/api/v1/orgs/${org}/devices/versions`));
    } catch {
      return null; // the status is already in the call log
    }
  }

  /**
   * Org inventory hints (`/orgs/{orgId}/inventory`) keyed 'mac:<hex>' /
   * 'serial:<lower>' for a stats row to look itself up, or null when the
   * read failed — best-effort ENRICHMENT like readFirmwareTrains: claim
   * codes and the connected backfill are absent this cycle, never a failed
   * pull. A truncated walk simply means some devices carry no hint.
   */
  private async readInventoryHints(org: string): Promise<Map<string, MistInventoryHint> | null> {
    try {
      const read = await this.fetchAll(`/api/v1/orgs/${org}/inventory`);
      const hints = new Map<string, MistInventoryHint>();
      for (const raw of read.rows) {
        if (!raw || typeof raw !== 'object') continue;
        const r = raw as Record<string, unknown>;
        const hint: MistInventoryHint = {
          claimCode: str(r.magic),
          connected: typeof r.connected === 'boolean' ? r.connected : null,
        };
        if (hint.claimCode === null && hint.connected === null) continue;
        const mac = macKey(str(r.mac));
        if (mac) hints.set(`mac:${mac}`, hint);
        const serial = str(r.serial)?.toLowerCase();
        if (serial) hints.set(`serial:${serial}`, hint);
      }
      return hints;
    } catch {
      return null; // the status is already in the call log
    }
  }

  /**
   * All pages of a list endpoint. The authoritative row count comes from
   * X-Page-Total (or a search envelope's `total`) and the page size the server
   * actually used from X-Page-Limit — a gateway that trims `limit=1000` down
   * to 100 would otherwise look like a short page and end the walk after one
   * page. The short-page rule is the fallback when neither is published.
   * Capped at MAX_PAGES; a walk that ends with rows still outstanding is
   * reported as truncated rather than passed off as the whole dataset.
   */
  /**
   * GET → parsed JSON body directly, no pagination walk. For single-page
   * endpoints like the versions/usages reads and the per-site WLAN/SLE
   * summaries — a 429 is still paced, and a non-2xx or unreadable body
   * throws so the caller's catch marks the section unavailable rather than
   * presenting it as an empty result.
   */
  private async fetchRaw(path: string): Promise<unknown> {
    const res = await this.pacedGet(path);
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`HTTP ${res.status} from ${path}`);
    }
    if (!res.parsed) {
      throw new Error(`unreadable body from ${path}`);
    }
    return res.body;
  }

  // -- direct SSID write (site-scoped WLANs) ---------------------------------
  //
  // Also an on-demand read/write path, not poller work: the editor asks for
  // this ONCE per drawer open (ssidCatalog) and once per reviewed Apply click
  // (applySsidProfile), never on the 60s timer. The review gate and the audit
  // line are the CALLER's — server/src/services/ssidDirectWrite.ts refuses to
  // reach this adapter without an explicit review confirmation, exactly like
  // the Central path; these methods never decide on their own that a write
  // has been reviewed, and never log a payload (the PSK discipline from
  // buildMistWlanPayload applies to every line below).

  /**
   * Everything the SSID editor's catalog needs for a Mist write: the org's
   * sites as the ONLY scope choices (Mist WLANs are site-scoped). The Central
   * dependency sections (roles, authentication server groups, captive-portal
   * profiles) come back EMPTY, not 'unavailable' — Mist has no such catalogs,
   * so there is nothing here that could fail to be read; the security modes
   * that would need them are refused by buildMistWlanPayload with the reason
   * stated. A sites read that fails is the one genuine 'unavailable'.
   */
  async ssidCatalog(): Promise<SsidCatalog> {
    const sites = await this.readOrgSiteList();
    if (sites === null) {
      return {
        scopes: [],
        roles: [],
        authServerGroups: [],
        captivePortalProfiles: [],
        unavailable: ['sites'],
        source: 'Mist /api/v1/orgs/{org}/sites — could not be read',
      };
    }
    return {
      scopes: sites.map((site) => ({ id: site.uuid, label: site.name, category: 'site' as const })),
      roles: [],
      authServerGroups: [],
      captivePortalProfiles: [],
      unavailable: [],
      source: `Mist /api/v1/sites/{site}/wlans · ${sites.length} sites`,
    };
  }

  /**
   * Direct Mist SSID apply — one site-scoped WLAN upsert per selected site.
   * Mist has no profile/assignment split: the WLAN itself is written at each
   * site, so the SsidApplyResult's per-scope "assignments" ARE the writes
   * (ok/partial/verified semantics identical to the Central path's, and a
   * write that landed at one site is NEVER rolled back because another
   * failed).
   *
   * Sequence (nothing is written before every check that can refuse has run):
   *   1. Map the form. An unrepresentable security mode (enterprise, portal)
   *      is REFUSED with the reason — never approximated.
   *   2. Read the org's sites and resolve EVERY selected scope (uuid or exact
   *      site name). An unknown scope refuses the whole apply.
   *   3. Per site: read the site's WLANs, then POST a create when the SSID is
   *      absent, skip when the managed fields already match (idempotent — no
   *      write for no change), or PUT the current row merged with the managed
   *      fields (PUT is the documented full-object update; merging keeps the
   *      ~60 unmanaged keys — dtim, schedule, portal, RADIUS — exactly as the
   *      site has them, and replacing `auth` wholesale clears a previous
   *      mode's key material on a security-mode transition).
   *   4. Verify from the write's own echo (Mist returns the written object;
   *      on a quota'd plane a second GET per site is not free). The echo is
   *      compared against the psk-stripped desired payload — the write-only
   *      key is never asserted on, logged, or echoed into a message. An echo
   *      that does not match is reported unverified, never claimed applied.
   */
  async applySsidProfile(form: SsidForm): Promise<SsidApplyResult> {
    const mapped = buildMistWlanPayload(form);
    if (!mapped.ok) {
      return {
        ok: false,
        partial: false,
        profile: { ok: false, action: 'failed', verified: false, message: mapped.reason },
        assignments: [],
      };
    }
    const desired = mapped.payload;
    const name = (desired.ssid as string) ?? form.name.trim();

    const sites = await this.readOrgSiteList();
    if (sites === null) {
      return {
        ok: false,
        partial: false,
        profile: {
          ok: false,
          action: 'failed',
          verified: false,
          message: 'could not read the org’s sites to resolve the selected scope — nothing was written',
        },
        assignments: [],
      };
    }
    // Resolve EVERY scope before ANY write: a scope this org does not report
    // refuses the apply rather than writing the sites that did resolve.
    const targets: { uuid: string; name: string }[] = [];
    const unknown: string[] = [];
    for (const scopeId of form.scopeIds ?? []) {
      const site = sites.find((s) => s.uuid === scopeId) ?? sites.find((s) => s.name === scopeId) ?? null;
      if (site) targets.push(site);
      else unknown.push(scopeId);
    }
    if (unknown.length > 0 || targets.length === 0) {
      return {
        ok: false,
        partial: false,
        profile: {
          ok: false,
          action: 'failed',
          verified: false,
          message:
            unknown.length > 0
              ? `scope ${unknown.map((s) => `'${s}'`).join(', ')} is not a site this org reports — nothing was written`
              : 'no scope selected — nothing was written',
        },
        assignments: [],
      };
    }

    const readableDesired = readableMistWlanPayload(desired);
    const ordered: SsidScopeAssignmentResult[] = [];
    const written: { action: 'created' | 'updated'; verified: boolean | undefined }[] = [];
    for (const site of targets) {
      const outcome = await this.writeSiteWlan(site, name, desired, readableDesired);
      ordered.push(outcome.assignment);
      if (outcome.action === 'created' || outcome.action === 'updated') {
        written.push({ action: outcome.action, verified: outcome.verified });
      }
    }

    const failedCount = ordered.filter((a) => !a.ok).length;
    const allVerified = written.length > 0 && written.every((w) => w.verified === true);
    let action: SsidProfileStepResult['action'];
    if (written.length === 0) action = failedCount > 0 ? 'failed' : 'unchanged';
    else if (written.every((w) => w.action === 'created') && failedCount === 0) action = 'created';
    else action = 'updated';
    const profileOk = action === 'failed' ? false : written.length === 0 ? true : allVerified;
    const createdCount = written.filter((w) => w.action === 'created').length;
    const updatedCount = written.length - createdCount;
    const unconfirmedCount = written.filter((w) => w.verified !== true).length;
    const parts: string[] = [];
    if (createdCount > 0) parts.push(`created at ${createdCount} ${createdCount === 1 ? 'site' : 'sites'}`);
    if (updatedCount > 0) parts.push(`updated at ${updatedCount} ${updatedCount === 1 ? 'site' : 'sites'}`);
    if (failedCount > 0) parts.push(`failed at ${failedCount} ${failedCount === 1 ? 'site' : 'sites'}`);
    const profile: SsidProfileStepResult = {
      ok: profileOk,
      action,
      verified: written.length === 0 ? action !== 'failed' : allVerified,
      message:
        action === 'unchanged'
          ? 'every selected site already matches the desired WLAN — no write needed'
          : action === 'failed'
            ? 'the write failed at every selected site'
            : `site-scoped WLAN · ${parts.join(' · ')}` +
              (unconfirmedCount > 0
                ? ` · the read-back at ${unconfirmedCount} ${unconfirmedCount === 1 ? 'site' : 'sites'} did not confirm the write`
                : ''),
    };
    const ok = profileOk && ordered.length > 0 && ordered.every((a) => a.ok);
    return { ok, partial: profileOk && !ok, profile, assignments: ordered };
  }

  /**
   * DELETE /api/v1/sites/{site}/wlans/{wlanId} — verified against the live
   * org. No screen exposes WLAN deletion yet; the surface is implemented and
   * tested here so the directWrite capability never claims less than the
   * adapter can actually do. The path carries ids only — no payload, no
   * secret, and the call log records method + path + status as always.
   */
  async deleteSiteWlan(siteUuid: string, wlanId: string): Promise<{ ok: boolean; httpCode: number; message: string }> {
    const res = await this.pacedRequest(
      'DELETE',
      `/api/v1/sites/${encodeURIComponent(siteUuid)}/wlans/${encodeURIComponent(wlanId)}`,
    );
    const ok = res.status >= 200 && res.status < 300;
    return {
      ok,
      httpCode: res.status,
      message: ok ? `WLAN deleted — HTTP ${res.status}` : `WLAN delete failed — HTTP ${res.status}`,
    };
  }

  /**
   * One site's create/update/upsert for the named WLAN. The per-site outcome
   * rides as an SsidScopeAssignmentResult — Mist's site-scoped write IS the
   * assignment in the shared apply vocabulary.
   */
  private async writeSiteWlan(
    site: { uuid: string; name: string },
    name: string,
    desired: Record<string, unknown>,
    readableDesired: Record<string, unknown>,
  ): Promise<{
    assignment: SsidScopeAssignmentResult;
    action: 'created' | 'updated' | 'unchanged' | 'failed';
    verified: boolean | undefined;
  }> {
    const base = `/api/v1/sites/${encodeURIComponent(site.uuid)}/wlans`;
    const listRes = await this.pacedGet(base);
    if (listRes.status < 200 || listRes.status >= 300 || !Array.isArray(listRes.body)) {
      return {
        assignment: {
          scopeId: site.uuid,
          label: site.name,
          ok: false,
          httpCode: listRes.status,
          message: `could not read the site’s existing WLANs — HTTP ${listRes.status}`,
        },
        action: 'failed',
        verified: undefined,
      };
    }
    const current = listRes.body.find(
      (row) => row && typeof row === 'object' && str((row as Record<string, unknown>).ssid) === name,
    ) as Record<string, unknown> | undefined;

    /** Verify from the write's own echo: a parsed object is compared against
     *  the psk-stripped desired payload; no readable object → undefined
     *  ("written, not confirmed"), which is NOT false — an unreadable echo is
     *  not a contradicting one. */
    const verify = (res: { body: unknown; parsed: boolean }): boolean | undefined => {
      if (!res.parsed || !res.body || typeof res.body !== 'object' || Array.isArray(res.body)) return undefined;
      return !mistWlanDiffers(res.body, readableDesired);
    };

    if (!current) {
      const postRes = await this.pacedRequest('POST', base, desired);
      const ok = postRes.status >= 200 && postRes.status < 300;
      const verified = ok ? verify(postRes) : undefined;
      return {
        assignment: {
          scopeId: site.uuid,
          label: site.name,
          ok,
          httpCode: postRes.status,
          ...(ok ? { verified } : {}),
          message: ok ? `WLAN created — HTTP ${postRes.status}` : `WLAN create failed — HTTP ${postRes.status}`,
        },
        action: ok ? 'created' : 'failed',
        verified,
      };
    }

    if (!mistWlanDiffers(current, desired)) {
      return {
        assignment: {
          scopeId: site.uuid,
          label: site.name,
          ok: true,
          skipped: true,
          message: 'already matches the desired WLAN — no write needed',
        },
        action: 'unchanged',
        verified: true,
      };
    }

    const wlanId = str(current.id);
    if (!wlanId) {
      return {
        assignment: {
          scopeId: site.uuid,
          label: site.name,
          ok: false,
          message: 'the existing WLAN row carried no id — it cannot be addressed for an update, and nothing was written',
        },
        action: 'failed',
        verified: undefined,
      };
    }
    // PUT is the documented full-object update: the current row carries the
    // ~60 unmanaged fields through untouched while the managed set (and the
    // wholesale-replaced `auth`) is asserted.
    const putRes = await this.pacedRequest('PUT', `${base}/${encodeURIComponent(wlanId)}`, { ...current, ...desired });
    const ok = putRes.status >= 200 && putRes.status < 300;
    const verified = ok ? verify(putRes) : undefined;
    return {
      assignment: {
        scopeId: site.uuid,
        label: site.name,
        ok,
        httpCode: putRes.status,
        ...(ok ? { verified } : {}),
        message: ok ? `WLAN updated — HTTP ${putRes.status}` : `WLAN update failed — HTTP ${putRes.status}`,
      },
      action: ok ? 'updated' : 'failed',
      verified,
    };
  }

  /**
   * The org's sites as {uuid, name} pairs — the scope-resolution source for
   * BOTH the catalog and the apply, read fresh each time (a renamed/removed
   * site must not resolve from a stale cache). Null when the read failed:
   * "we do not know the sites" is a different fact from "the org has none".
   */
  private async readOrgSiteList(): Promise<{ uuid: string; name: string }[] | null> {
    try {
      const read = await this.fetchAll(`/api/v1/orgs/${encodeURIComponent(this.orgId)}/sites`);
      const sites: { uuid: string; name: string }[] = [];
      for (const raw of read.rows) {
        if (!raw || typeof raw !== 'object') continue;
        const r = raw as Record<string, unknown>;
        const id = str(r.id);
        const name = str(r.name);
        if (id && name) sites.push({ uuid: id, name });
      }
      return sites;
    } catch {
      return null; // the status is already in the call log
    }
  }

  private async fetchAll(path: string): Promise<FetchAllResult> {
    const sep = path.includes('?') ? '&' : '?';
    const out: unknown[] = [];
    let total: number | null = null;
    let effectiveLimit = PAGE_LIMIT;
    let page = 1;
    for (; page <= MAX_PAGES; page += 1) {
      if (page > 1) await this.sleep(CALL_PACING_MS); // quota'd plane — pace the walk
      const res = await this.pacedGet(`${path}${sep}limit=${PAGE_LIMIT}&page=${page}`);
      if (res.status < 200 || res.status >= 300) {
        throw new Error(`HTTP ${res.status} from ${path} (page ${page})`);
      }
      // A 200 whose body we cannot read is not evidence of zero rows — an SSO
      // interstitial, a truncated response or an envelope shape we do not know
      // must fail the section, not silently empty it.
      if (!res.parsed || !isRowContainer(res.body)) {
        throw new Error(`unreadable body from ${path} (page ${page})`);
      }
      const rows = extractRows(res.body);
      out.push(...rows);
      if (page === 1) {
        total = res.pageTotal ?? extractTotal(res.body);
        if (res.pageLimit !== null && res.pageLimit > 0) effectiveLimit = res.pageLimit;
      }
      if (total !== null) {
        if (out.length >= total) return { rows: out, truncated: false };
        if (rows.length === 0) return { rows: out, truncated: true }; // stated a total it never handed over
        continue;
      }
      if (rows.length < effectiveLimit) return { rows: out, truncated: false };
    }
    // Fell out of the loop: MAX_PAGES pages of full pages, more still to come.
    return { rows: out, truncated: true };
  }

  /**
   * GET with a bounded backoff on 429 so the documented 20k/day rate limit
   * paces the poll instead of destroying the whole cycle. Retry-After
   * (delta-seconds or HTTP-date) wins over the exponential floor; every
   * attempt is still recorded, so the Activity tab shows the real 429s.
   */
  private async pacedGet(path: string): Promise<MistResponse> {
    return this.pacedRequest('GET', path);
  }

  /** The 429 backoff above, generalized over the write verbs the direct SSID
   *  path uses. Writes get the same pacing discipline as reads — a 429 on a
   *  POST/PUT/DELETE is retried, never failed through to the operator on the
   *  first attempt. */
  private async pacedRequest(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<MistResponse> {
    for (let attempt = 0; ; attempt += 1) {
      const res = await this.request(method, path, body);
      if (res.status !== 429 || attempt >= RATE_LIMIT_RETRIES) return res;
      const backoffMs = RATE_LIMIT_BASE_MS * 2 ** attempt;
      await this.sleep(Math.min(res.retryAfterMs ?? backoffMs, RATE_LIMIT_CAP_MS));
    }
  }

  private async get(path: string): Promise<MistResponse> {
    return this.request('GET', path);
  }

  /**
   * Timed outbound call recorded in the plane's call log. The log carries
   * method + path + ms + status only — headers (and so the token) never, and
   * the request body (which can carry a WLAN PSK on the write path) never:
   * the body is stringified straight into the fetch init and exists nowhere
   * else.
   */
  private async request(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<MistResponse> {
    const started = Date.now();
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: {
          accept: 'application/json',
          authorization: `Token ${this.token}`,
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(OUTBOUND_TIMEOUT_MS),
      });
    } catch (err) {
      this.recordCall({ path: `${method} ${path}`, ms: Date.now() - started, code: 'network-error' });
      throw new Error(`${method} ${path} failed: ${(err as Error).message}`);
    }
    this.recordCall({ path: `${method} ${path}`, ms: Date.now() - started, code: String(res.status) });
    let responseBody: unknown = null;
    let parsed = false;
    try {
      responseBody = await res.json();
      parsed = true;
    } catch {
      /* an unreadable body is reported by the caller — it is never zero rows */
    }
    const retryAfterMs = parseRetryAfterMs(res.headers.get('retry-after'));
    return {
      status: res.status,
      body: responseBody,
      parsed,
      pageTotal: num(res.headers.get('x-page-total')),
      pageLimit: num(res.headers.get('x-page-limit')),
      ...(retryAfterMs !== null ? { retryAfterMs } : {}),
    };
  }
}
