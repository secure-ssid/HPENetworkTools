/**
 * server/src/planes/central.ts — HPE Aruba Networking Central (new) adapter.
 *
 * First REAL plane adapter: OAuth2 client-credentials auth + the classic
 * monitoring read APIs, mapped into the normalized shared row types so the
 * poller cache and the reconciliation layer can consume them.
 *
 * Endpoint candidates (namespaces vary by Central release; 404 on a candidate
 * is tolerated by trying the next one and remembering which path worked):
 *
 *   section        candidates (tried in order)                                              paging
 *   aps            /monitoring/v1/aps, /network-monitoring/v1alpha1/aps                      offset/limit 200
 *   switches       /monitoring/v1/switches, /network-monitoring/v1alpha1/switches            offset/limit 200
 *   gateways       /monitoring/v1/gateways, /network-monitoring/v1alpha1/gateways            offset/limit 200
 *   sites          /central/v2/sites, /central/v1/sites, /network-config/v1alpha1/sites      offset/limit 100 (v1alpha1 cap)
 *   clients        /network-monitoring/v1/clients                                            CURSOR `next`, limit 500
 *                  /monitoring/v1/clients, /network-monitoring/v1alpha1/clients              offset/limit 500
 *   notifications  /central/v1/notifications, /monitoring/v1/notifications,
 *                  /network-notifications/v1/alerts                                          offset/limit 100
 *
 * Classic-only params (calculate_total on classic clients) ride as per-candidate
 * extraQuery so they never leak onto the v1alpha1 paths, which 400 on unknown
 * params — one section error fails the whole pull, so a stray param is fatal.
 *
 * Paging: only an explicitly-total-named key ('total'/'total_count') is trusted
 * as the grand total. `count` is NOT — the v1alpha1 payloads report it as the
 * number of rows in THIS response, so reading it as the total stops the walk
 * after page one (500 of 4,982 clients). With no total the loop falls back to
 * the full-page heuristic, which terminates on the first short page.
 *
 * Paging (cursor): the GA clients endpoint does NOT paginate on offset — it
 * hands back a `next` token and IGNORES `offset` entirely (verified against a
 * live tenant: `?offset=2&limit=2` returns page ONE again). Candidates marked
 * `paging: 'cursor'` therefore walk on `?next=<token>` and stop when the
 * payload reports `next: null`; walking them on offset would re-read page one
 * forever and drop every client past the first page.
 *
 * Failure policy:
 *   - all candidates 404 → section "missing": devices sub-sections tolerate it
 *     individually (but all three missing → pull fails); every other missing
 *     section is OMITTED from the PlanePull rather than reported as an empty
 *     array, because "we could not read it" is not "there are none" — the
 *     poller's datasetReported()/lastSyncFor() must see it as unknown.
 *   - a section whose walk hit the page cap (or handed over fewer rows than it
 *     reported) is "truncated": the rows are kept, the note says so.
 *   - either case holds the plane at 'warning' — a partial read never stamps
 *     itself healthy and complete (README honesty rule 1).
 *   - 429 is retried with backoff (Retry-After honoured) before it counts as a
 *     failure, and pages are paced so one section is not a burst.
 *   - a transport-level failure (abort/DNS/reset) on one page is retried once:
 *     a single slow 500-row page must not discard the sections that already
 *     succeeded. High-volume sections also get a longer timeout than the
 *     10s default (SECTION_TIMEOUT_MS).
 *   - any other HTTP/network error → pull() throws naming the section, so the
 *     poller marks the plane degraded and keeps serving the last good cache.
 *   - every missing/truncated section is also named in PlanePull.partial, so
 *     the registry/poller can hold the plane at 'warning' and skip attributing
 *     freshness to a dataset that was not fully read.
 *
 * Mapping decisions:
 *   - status 'Up'/'Down' → state 'up'/'down' with success/danger tones;
 *     anything else passes through lowercased with a neutral tone.
 *   - firmwareApproved: the portal does NOT know the approved train, so the
 *     honest default is true. Operators can declare one per device family via
 *     settings.planes.central.approvedFirmware as a comma map of
 *     family=prefix pairs (e.g. 'cx=10.13,ap=10.6'); family matches
 *     case-insensitively against "<type> <model>", firmware must start with
 *     the prefix. Families not covered by the map stay approved=true.
 *   - site mapping: siteIdFor(name) resolves the canonical SiteId; unknown
 *     names get a generated 'ext-<slug>' id (LOCAL GAP — SiteId is a closed
 *     union over the fixture sites and cannot name real estate; see
 *     externalSiteId). Rows with no site land on the 'multiple' pseudo-site.
 *   - licence: 'unknown' — Central's monitoring endpoints do not report
 *     licences; GreenLake is the licence reconciliation source today.
 *
 * ON-DEMAND DETAIL READS (clientDetail/deviceDetail/siteTopology) are NOT part
 * of pull() and must never be called from the poller. pull() reads a few flat
 * lists on the 60s timer; Central models one client across ~8 endpoints and one
 * device across many /{id}/subresource endpoints, so those are fetched for the
 * ONE object being viewed, behind a TTL cache, with a shorter timeout and no
 * 429 backoff. See the block above clientDetail() for the per-object call cost
 * and the endpoint-by-endpoint reasoning (including why /clients-usage MUST
 * carry the macAddress filter — unfiltered it is tenant-wide).
 *
 * DEFERRED (needs a live tenant to verify the shapes before it can ship):
 *   licences  /platform/licensing/v1/subscriptions +
 *             /platform/device_inventory/v1/devices → serial→licence map, so
 *             the Devices Licence column stops reading "Not reported" for the
 *             plane README:459 names as a licence source. Pair it with a
 *             longer refresh than inventory: it is another paged section on a
 *             quota'd gateway.
 *   config    SSID/VLAN/port reads (PlanePull.config) — until then
 *             capabilities().configRead is false and Configure honestly
 *             labels its inventory 'observed'.
 *   - reconciliationIssue: false here — the reconcile service computes it.
 *   - localShell: false — cloud-claimed devices get no portal shell; shell is
 *     the local collector's job (README integration table). capabilities()
 *     states the same thing at plane level: no localShell, brokeredWrite yes
 *     (this adapter IS the write broker's transport), no configRead yet.
 *   - serial/macaddr are attached as DeviceIdentityHints so reconcileDevices
 *     can key on serial/MAC instead of display name; the management IP rides
 *     along as DeviceRow.ip when the plane reports one (search + terminal).
 *   - site rows carry the plane's own freshness as `sync` — Central's site
 *     object has no per-site sync time, but the adapter knows when it last
 *     read the plane, which is what the Sites column means.
 *
 * Security: secrets live only in the token POST body — never in URLs, never
 * in the recorded call log (method + path + ms + status only).
 */

import {
  type AlertRow,
  type ApTrendMetric,
  type ApTrendsLive,
  type ApTrendsSection,
  type ClientDetailLive,
  type ClientDetailSection,
  type ClientRow,
  type ClientTimelineEvent,
  type ClientType,
  type ConfigInventory,
  type DetailFetchState,
  type DetailSource,
  type DeviceDetailKind,
  type DeviceDetailLive,
  type DeviceDetailSection,
  type DevicePort,
  type DeviceRadio,
  type DeviceRow,
  type DeviceWlan,
  type HardwareTrendsSection,
  type InterfaceTrendsSection,
  type PlaneDatasetKey,
  type Sev,
  type SiteAppRow,
  type SiteApplicationsLive,
  type SiteAppsSection,
  type SsidApplyResult,
  type SsidBands,
  type SsidCatalog,
  type SsidCatalogSection,
  type SsidDependencyOption,
  type SsidForm,
  type SsidObject,
  type SsidProfileStepResult,
  type SsidScopeAssignmentResult,
  type SsidScopeCategory,
  type SsidScopeOption,
  type SsidSecurity,
  type SiteRow,
  type SiteTopologyLive,
  type SiteTopologySection,
  type SwitchHardwareTrendsLive,
  type SwitchInterfaceTrendsLive,
  type Tone,
  type TopologyDeviceNode,
  type TopologyLink,
  type TopologyLinkPort,
  type TrendWindow,
  type UsageSample,
  AP_TREND_METRICS,
  apTrendSpecs,
  byBytesDesc,
  countOf,
  interfaceTrendSpecs,
  normalizeSiteApp,
  normalizeTrendSet,
  normalizeTrendWindow,
} from '@hpe/shared';
import type { PlaneCredentials } from '../config/settings';
import type { DeviceIdentityHints } from '../services/reconcile';
import type { PlaneAdapter, PlaneCapabilities, PlanePull, PlaneState } from './types';
import {
  ageString,
  durationString,
  firmwareIsApproved,
  num,
  parseApprovedFirmware,
  parseTimestamp,
  sevFor,
  siteIdForName,
  str,
  type ApprovedFirmwareMap,
} from './format';
import {
  TokenManager,
  mintedTokenInfo,
  parseRateLimitResetAtMs,
  parseRetryAfterMs,
  realSleep,
  type FetchLike,
  type RecordCallFn,
  type SleepFn,
  httpsBase,
} from './transport';


const OUTBOUND_TIMEOUT_MS = 10_000;
/** High-volume sections (500-row client pages, 200-row inventory pages) need
 *  more than the default: an abort here costs the whole cycle, not one page. */
const SECTION_TIMEOUT_MS = 30_000;
/** Transport-level retries (abort/DNS/reset) per request, after the first try. */
const NETWORK_RETRIES = 1;
const NETWORK_RETRY_MS = 500;

/** 429 backoff: attempts after the first, exponential floor, and a hard cap. */
const RATE_LIMIT_RETRIES = 3;
const RATE_LIMIT_BASE_MS = 1_000;
const RATE_LIMIT_CAP_MS = 30_000;
/** Pacing between pages of one section so a 10-page walk is not a burst. */
const PAGE_PACING_MS = 150;

// -- On-demand detail reads (NOT poller work — see PlaneAdapter's contract) ---
/** Detail reads sit on the drawer's request path, so they get a SHORTER budget
 *  than a poll page: a slow subresource must never stall the one object a
 *  human is looking at. It degrades to the honest empty state instead. */
const DETAIL_TIMEOUT_MS = 8_000;
/** TTL for a cached detail payload. Long enough that re-opening a drawer (or
 *  two panes asking for the same object) costs zero calls, short enough that
 *  what the operator reads is still this minute's truth. */
const DETAIL_TTL_MS = 45_000;
/** Bounded LRU-ish cache so a long session cannot grow it without limit. */
const DETAIL_CACHE_MAX = 128;
/** Lookback for the mobility trail — README's "no roaming in the last 24h". */
const MOBILITY_WINDOW_SEC = 24 * 60 * 60;
/** Central caps mobility-trail at limit=100. ONE page is deliberate: the
 *  payload states `total`, so the roam COUNT is exact without walking the
 *  cursor, and the timeline only needs the newest events (default sort is
 *  occurredAt DESC). Walking would spend calls to render rows nobody scrolls to. */
const MOBILITY_PAGE_LIMIT = 100;
/** DPI applications page size (the endpoint's documented limit). */
const APPLICATIONS_PAGE_LIMIT = 200;
/** Cap on pages one applications read will walk: 10 x 200 = 2,000 rows,
 *  beyond which the table is honestly marked truncated rather than spending
 *  unbounded calls on a drawer's request path. */
const APPLICATIONS_MAX_PAGES = 10;

export type CentralDeviceRow = DeviceRow & DeviceIdentityHints;

// ---------------------------------------------------------------------------
// Row mapping (pure, exported for tests)
// ---------------------------------------------------------------------------

function deviceState(status: string | null): { state: string; stateTone: Tone } {
  const s = (status ?? '').trim().toLowerCase();
  // v1alpha1 says online/offline where classic says Up/Down — same meaning.
  if (s === 'up' || s === 'online') return { state: 'up', stateTone: 'success' };
  if (s === 'down' || s === 'offline') return { state: 'down', stateTone: 'danger' };
  return { state: s || 'unknown', stateTone: 'neutral' };
}

/** monitoring/v1 aps | switches | gateways row → DeviceRow (+ identity hints). */
export function mapCentralDevice(
  raw: unknown,
  kind: 'ap' | 'switch' | 'gateway',
  approved: ApprovedFirmwareMap = [],
): CentralDeviceRow | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  // v1alpha1 rows are camelCase (deviceName/serialNumber/macAddress/…).
  const name = str(r.name) ?? str(r.hostname) ?? str(r.deviceName) ?? str(r.serial) ?? str(r.serialNumber) ?? str(r.macaddr) ?? str(r.macAddress);
  if (!name) return null;
  const model = str(r.model) ?? 'unknown';
  const firmware = str(r.firmware_version ?? r.firmware ?? r.firmwareVersion ?? r.softwareVersion) ?? 'unknown';
  const { state, stateTone } = deviceState(str(r.status ?? r.state));
  const site = siteIdForName(str(r.site ?? r.site_name ?? r.siteName));
  const serial = str(r.serial ?? r.serialNumber);
  const mac = str(r.macaddr ?? r.mac ?? r.macAddress);
  const ip = str(r.ip_address ?? r.ip ?? r.ipAddress ?? r.ipv4);
  return {
    name,
    model,
    type: kind,
    siteId: site.siteId,
    siteName: site.siteName,
    plane: 'CENTRAL',
    planeTone: 'accent',
    state,
    stateTone,
    firmware,
    firmwareApproved: firmwareIsApproved(kind, model, firmware, approved),
    // New Central's unified inventory publishes the assigned service tier.
    // Legacy monitoring rows omit it, where 'unknown' still means "not read".
    licence: str(r.tier) ?? 'unknown',
    reconciliationIssue: false, // the reconcile service computes this
    localShell: false, // cloud-claimed — shell only via the local collector
    ...(serial ? { serial } : {}),
    ...(mac ? { mac } : {}),
    // The management IP is what the Devices search and the terminal's
    // resolveTarget() need; absent stays absent rather than becoming a lie.
    ...(ip ? { ip } : {}),
  };
}

/** New Central's unified device-inventory row. It includes claimed devices
 * that are not provisioned yet, unlike the legacy split monitoring lists. */
export function mapCentralInventoryDevice(
  raw: unknown,
  approved: ApprovedFirmwareMap = [],
): CentralDeviceRow | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const type = (str(r.deviceType ?? r.device_type ?? r.type) ?? '').toUpperCase();
  const kind =
    type.includes('ACCESS_POINT') || type === 'AP'
      ? 'ap'
      : type.includes('SWITCH') || type.includes('CX')
        ? 'switch'
        : type.includes('GATEWAY')
          ? 'gateway'
          : null;
  return kind === null ? null : mapCentralDevice(raw, kind, approved);
}

/**
 * central/v2/sites row → SiteRow (best effort; the live merge recomputes
 * counts/health). `sync` is the CALLER's stamp: Central's site object carries
 * no per-site sync time, so pull() passes the plane's own last successful read
 * (the freshness the Sites column actually means). Default '—' = never synced.
 */
export function mapCentralSite(raw: unknown, sync = '—'): SiteRow | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  // v1alpha1 (/network-config/v1alpha1/sites) rows use scopeName/collectionName.
  const name = str(r.site_name ?? r.name ?? r.scopeName ?? r.collectionName);
  if (!name) return null;
  const site = siteIdForName(name);
  return {
    id: site.siteId,
    name: site.siteName,
    subnet: str(r.subnet) ?? '—', // Central's site object has no subnet concept
    planes: [{ name: 'CENTRAL', tone: 'accent' }],
    mix: '—', // the live merge derives the mix from reconciled devices
    devices: num(r.device_count ?? r.devices ?? r.associated_devices ?? r.deviceCount) ?? 0,
    clients: '0',
    health: null, // the sites endpoint reports no health score — cannot assert
    healthPct: '—',
    tone: 'stale',
    alerts: '—',
    alertTone: 'neutral',
    sync,
  };
}

function clientTypeFor(r: Record<string, unknown>, os: string | null): ClientType {
  const s = [
    os,
    str(r.category),
    str(r.function),
    str(r.vendor),
    str(r.manufacturer),
    // GA spellings. clientFunction/clientCategory are Central's own
    // classification ('E-Reader', 'Media Streaming', 'Network Infrastructure')
    // and clientTags carries its ML verdict ('ml-IoT'); without them every
    // GA row whose OS reads 'Unclassified' landed in UNKNOWN.
    str(r.clientCategory),
    str(r.clientFunction),
    str(r.clientVendor),
    str(r.clientManufacturer),
    str(r.clientTags),
  ]
    .filter((value): value is string => value !== null)
    .join(' ')
    .toLowerCase();
  // 'E-Reader' (Kindle) is a reading tablet — the closest honest bucket in the
  // shared vocabulary, which has no e-reader of its own.
  if (/ipad|tablet|e-?reader/.test(s)) return 'tablet';
  // 'voip' BEFORE 'phone': every VoIP vocabulary ('VoIP Phone', 'IP Phone',
  // 'SIP handset', the literal 'phone system') contains 'phone', so a generic
  // phone test first makes this branch unreachable and buries desk handsets
  // among the mobiles. \b guards keep 'iPhone' out of the IP-phone alternative.
  if (/voip|voice|\bsip\b|\bip ?phone\b|phone system|handset/.test(s)) return 'voip';
  if (/iphone|android|smart ?phone|\bmobile\b|\bphone\b/.test(s)) return 'phone';
  if (/windows|mac ?os|linux|ubuntu|chrome/.test(s)) return 'laptop';
  if (/print/.test(s)) return 'printer';
  // BEFORE media: Central's 'Video Surveillance' clientFunction contains
  // 'video', so the media test below would claim a security camera.
  if (/surveillance|\bcctv\b/.test(s)) return 'imaging';
  // 'Gaming Platform' is an entertainment endpoint — media is the only bucket
  // the shared vocabulary offers for one.
  if (/roku|smart ?tv|television|audio|video|media streaming|gaming/.test(s)) return 'media';
  if (/camera|imaging|x-?ray/.test(s)) return 'imaging';
  if (/medical|infusion|clinical/.test(s)) return 'medical';
  // 'Home Automation'/'Smart Home'/'Energy Monitoring' are Central's words for
  // building-systems endpoints; 'ml-IoT' is its ML tag for the same family.
  if (/sensor|building|thermostat|lighting|iot|home automation|smart home|energy monitoring/.test(s))
    return 'building';
  // Deliberately NOT mapped: 'Network Switching' / 'Network Infrastructure'
  // (an uplinked switch or gateway seen as a client) has no honest match in
  // the shared vocabulary, so it stays unknown rather than being forced.
  return 'unknown';
}

function clientMedium(r: Record<string, unknown>): 'wired' | 'wireless' {
  // GA rows say it outright in clientConnectionType; on those rows `type` is
  // the resource kind ('network-monitoring/client-monitoring'), which names
  // neither medium, and the SSID lives under wlanName — so without this the
  // whole GA wireless roster fell through to 'wired'.
  const conn = (str(r.clientConnectionType) ?? '').toLowerCase();
  if (conn.includes('wireless')) return 'wireless';
  if (conn.includes('wired')) return 'wired';
  // v1alpha1 rows carry an explicit type ('Wireless'/'Wired') — trust it
  // before the ssid/network inference below.
  const t = (str(r.type) ?? '').toLowerCase();
  if (t.includes('wireless')) return 'wireless';
  if (t.includes('wired')) return 'wired';
  const kind = (str(r.client_type) ?? str(r.connection) ?? str(r.medium) ?? '').toLowerCase();
  if (kind.includes('wireless') || kind.includes('wifi') || kind.includes('802.11')) return 'wireless';
  if (kind.includes('wired') || kind.includes('ethernet')) return 'wired';
  return str(r.ssid ?? r.network ?? r.essid ?? r.wlanName) ? 'wireless' : 'wired';
}

function clientHealth(r: Record<string, unknown>): {
  health: string;
  healthTone: Tone;
  quality: number | null;
  problem: boolean;
} {
  const n = num(r.health);
  if (n !== null) {
    const tone: Tone = n >= 70 ? 'success' : n >= 40 ? 'warning' : 'danger';
    return { health: String(n), healthTone: tone, quality: n, problem: n < 70 };
  }
  const s = (str(r.health) ?? str(r.status) ?? '').toLowerCase();
  if (/good|healthy|ok|up/.test(s)) return { health: s, healthTone: 'success', quality: null, problem: false };
  if (/poor|fair|degraded/.test(s)) return { health: s, healthTone: 'warning', quality: null, problem: true };
  if (/bad|fail|crit|down/.test(s)) return { health: s, healthTone: 'danger', quality: null, problem: true };
  return { health: s || '—', healthTone: 'neutral', quality: null, problem: false };
}

/** monitoring/v1/clients row → ClientRow; shape variance tolerated per-field. */
export function mapCentralClient(raw: unknown, nowMs: number = Date.now()): ClientRow | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  // macAddress is the v1alpha1 spelling (mapCentralDevice reads all three):
  // dropping it discarded EVERY row of a camelCase clients payload as junk.
  const mac = str(r.macaddr ?? r.mac ?? r.macAddress);
  if (!mac) return null; // a client row without a MAC is junk
  // v1alpha1 rows are camelCase (userName/hostName/modelOs/siteName/ipv4/…);
  // GA names the OS clientOperatingSystem ('Apple iPad', 'Roku TV').
  const os = str(r.os ?? r.os_type ?? r.modelOs ?? r.clientOperatingSystem);
  const site = siteIdForName(str(r.site ?? r.site_name ?? r.siteName));
  const { health, healthTone, quality, problem } = clientHealth(r);
  const sessionSec = num(r.session_age ?? r.session_seconds ?? r.uptime);
  // Neither camelCase path reports session seconds — derive it from the
  // association timestamp (v1alpha1: connectedSince, GA: connectedAt).
  const connectedSinceMs = sessionSec === null ? parseTimestamp(r.connectedSince ?? r.connectedAt) : null;
  const rssi = num(r.rssi ?? r.signal_strength ?? r.signalStrength);
  const snr = num(r.snr ?? r.signal_db ?? r.signalDb);
  // Radio facts under BOTH shapes, like every other field here: the classic
  // path is tried first, so camelCase-only reads left `link` at '—' for a
  // classic tenant that had the band and channel on the wire.
  const band = str(r.wirelessBand ?? r.band ?? r.radio_band);
  const channel = str(r.wirelessChannel ?? r.channel);
  // Only add units/prefixes to a BARE value — a plane that already says
  // '5 GHz' or '149E (80 MHz)' is quoted verbatim.
  const bandText = band === null ? null : /^\d+(\.\d+)?$/.test(band) ? `${band} GHz` : band;
  const channelText = channel === null ? null : /^\d+$/.test(channel) ? `ch ${channel}` : channel;
  // The classic clients endpoint reports `speed` in Mbps (v1alpha1: txRate).
  const tput = num(r.speed ?? r.txRate ?? r.tx_rate);
  return {
    // clientName is the GA display name ('DESKTOP-O48COOH', 'ChimePro-1c');
    // it falls back to the MAC on the plane's side, which is our last resort too.
    name: str(r.username ?? r.userName) ?? str(r.hostname ?? r.hostName) ?? str(r.name ?? r.clientName) ?? mac,
    model: os ?? 'unknown',
    type: clientTypeFor(r, os),
    mac,
    ip: str(r.ip_address ?? r.ip ?? r.ipv4) ?? 'pending',
    medium: clientMedium(r),
    siteId: site.siteId,
    siteName: site.siteName,
    group: str(r.group_name ?? r.group) ?? '—',
    attach: str(r.associated_device ?? r.ap_name ?? r.switch_name ?? r.nas ?? r.nas_name ?? r.connectedTo) ?? '—',
    // wlanName is the GA spelling of the SSID; it sits before the port keys so
    // a wireless GA row reads as its network rather than as a blank port.
    where: str(r.ssid ?? r.network ?? r.essid ?? r.wlanName ?? r.port ?? r.interface ?? r.interface_name) ?? '—',
    plane: 'CENTRAL',
    planeTone: 'accent',
    healthTone,
    // per-field str(): v1alpha1 sends authentication:'' and GA sends
    // authenticationType:'' (?? would not skip either), but both fill
    // keyManagement ('WPA2-PSK', 'WPA3-SAE') on wireless rows.
    auth:
      str(r.auth_method) ??
      str(r.auth) ??
      str(r.authentication) ??
      str(r.authenticationType) ??
      str(r.keyManagement) ??
      '—',
    authBy: '—', // the clients endpoint does not name the authenticator; ClearPass rows will
    role: str(r.role) ?? '—',
    vlan: str(r.vlan ?? r.vlan_id ?? r.vlanId) ?? '—',
    health,
    session:
      sessionSec !== null
        ? durationString(sessionSec)
        : connectedSinceMs !== null
          ? durationString((nowMs - connectedSinceMs) / 1000)
          : (str(r.session) ?? '—'),
    problem,
    link: [bandText, channelText].filter((value): value is string => value !== null).join(' · ') || '—',
    rssi: rssi !== null ? `${rssi} dBm` : '—',
    snr: snr !== null ? `${snr} dB` : '—',
    retries: '—',
    tput: tput !== null ? `${tput} Mbps` : '—',
    roams: '—',
    quality,
    zone: '—',
    closet: '—',
  };
}

const SEV_TONE: Record<Sev, Tone> = { P1: 'danger', P2: 'warning', P3: 'info' };

/**
 * v1alpha1 alert rows carry no device-name field, but the summary leads with
 * it ('Device LR655 configuration is out of sync…'). Only that exact leading
 * pattern is claimed — anything else stays honestly unnamed.
 */
function deviceFromDetail(detail: string | null): string {
  if (!detail) return '';
  return /^Device\s+(\S+)/.exec(detail)?.[1] ?? '';
}

/** central/v1/notifications row → AlertRow. */
export function mapCentralNotification(raw: unknown, nowMs: number = Date.now()): AlertRow | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  // v1alpha1 `type` is the category path ('network-notifications/alerts'),
  // not a title — `name` ('Config Out of Sync') outranks it there; classic
  // rows carry the title in `type`, so it stays as the last resort.
  const title = str(r.title ?? r.notification_type ?? r.name ?? r.type);
  // v1alpha1 (/network-notifications/v1/alerts) rows: summary/rootCause/createdAt/siteName.
  const detail = str(r.description ?? r.message ?? r.details ?? r.summary ?? r.rootCause);
  if (!title && !detail) return null;
  const sev = sevFor(str(r.severity ?? r.level ?? r.priority));
  const ts = parseTimestamp(r.timestamp ?? r.created_time ?? r.ts ?? r.time ?? r.createdAt);
  const stateRaw = (str(r.state ?? r.status) ?? '').toLowerCase();
  const acked = stateRaw.includes('ack') || r.is_ack === true || r.acknowledged === true;
  // v1alpha1 alerts come back status:'Cleared' once Central considers them
  // resolved — they must not surface as open.
  const cleared = /clear|resolv|clos/.test(stateRaw);
  const site = siteIdForName(str(r.site ?? r.site_name ?? r.siteName));
  const alertId = str(r.id ?? r.notification_id ?? r.alert_id ?? r.key);
  return {
    sev,
    tone: SEV_TONE[sev],
    title: title ?? 'Notification',
    detail: detail ?? '',
    siteId: site.siteId,
    siteName: site.siteName,
    plane: 'CENTRAL',
    state: acked ? 'acked' : cleared ? 'cleared' : 'open',
    age: ts !== null ? ageString(ts, nowMs) : '—',
    device: str(r.device ?? r.device_name ?? r.hostname ?? r.device_serial) ?? deviceFromDetail(detail),
    ...(alertId ? { alertId } : {}),
  };
}

function centralSecurityLabel(raw: string | null): string {
  const value = (raw ?? '').trim().toUpperCase();
  if (!value) return 'Not reported';
  const known: Record<string, string> = {
    OPEN: 'Open',
    ENHANCED_OPEN: 'Enhanced Open',
    WPA2_PERSONAL: 'WPA2-Personal',
    WPA2_ENTERPRISE: 'WPA2-Enterprise',
    WPA2_MPSK_LOCAL: 'WPA2-MPSK-Local',
    WPA3_SAE: 'WPA3-SAE',
    WPA3_ENTERPRISE: 'WPA3-Enterprise',
    WPA3_ENTERPRISE_CCM_128: 'WPA3-Enterprise',
  };
  return known[value] ?? value.replaceAll('_', '-');
}

/** A configured New Central WLAN profile. Scope maps are a separate API, so
 * the target note states that limitation instead of inventing an AP count. */
export function mapCentralSsid(raw: unknown): SsidObject | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const essid = r.essid && typeof r.essid === 'object' ? (r.essid as Record<string, unknown>) : {};
  const name = str(r.ssid) ?? str(essid.name);
  if (!name) return null;
  const vlanRange = Array.isArray(r['vlan-id-range'])
    ? r['vlan-id-range'].map((value) => str(value)).filter((value): value is string => value !== null)
    : [];
  const vlan = vlanRange.join(', ') || str(r.vlan ?? r.vlanId ?? r['vlan-id']) || 'Not reported';
  const enabled = typeof r.enable === 'boolean' ? r.enable : null;
  return {
    kind: 'ssid',
    origin: 'configured',
    name,
    vlan,
    security: centralSecurityLabel(str(r.opmode)),
    targets: `${enabled === null ? 'State not reported' : enabled ? 'Enabled profile' : 'Disabled profile'} · scope assignment not read`,
    plane: 'CENTRAL',
    tone: 'accent',
  };
}

// ---------------------------------------------------------------------------
// Direct SSID write — New Central network-config v1alpha1 (WLAN profile
// upsert + configuration assignment). Symmetric with mapCentralSsid above: that
// one reads the tenant's `opmode` string back into a display label,
// CENTRAL_SSID_OPMODE below is the reverse map this adapter writes.
// ---------------------------------------------------------------------------

/** SsidSecurity → the New Central 26.04 `opmode` enum. */
const CENTRAL_SSID_OPMODE: Record<SsidSecurity, string> = {
  'wpa3-enterprise': 'WPA3_ENTERPRISE_CCM_128',
  'wpa2-enterprise': 'WPA2_ENTERPRISE',
  'psk-portal': 'WPA2_PERSONAL',
  'wpa2-psk': 'WPA2_PERSONAL',
  open: 'OPEN',
};

const CENTRAL_SSID_RF_BAND: Record<SsidBands, string> = {
  '5+6': '5GHZ_6GHZ',
  all: 'BAND_ALL',
  '5': '5GHZ',
};

/**
 * Build the New Central 26.04 WLAN body from the reviewed form. The unique
 * profile name belongs in the request path; the item-write schema accepts
 * `essid.name` but not a redundant `ssid` body field.
 * `personal-security.wpa-passphrase` is the only secret-bearing
 * field and callers must send this object directly without logging it.
 *
 * A form missing a required dependency (role, server group, captive portal,
 * passphrase — see ssidDependencyRequirementsFor) still builds a body; the
 * caller (applySsidProfile) is what refuses to write until the review-gated
 * dependencies for the chosen security mode are present.
 */
export function buildWlanSsidPayload(form: SsidForm): Record<string, unknown> {
  const vlanId = form.vlan.trim();
  const body: Record<string, unknown> = {
    essid: { name: form.name, 'use-alias': false },
    enable: true,
    'hide-ssid': !form.broadcast,
    'forward-mode': 'FORWARD_MODE_BRIDGE',
    'rf-band': CENTRAL_SSID_RF_BAND[form.bands],
    'client-isolation': form.isolate,
    'vlan-id-range': vlanId ? [vlanId] : [],
    'vlan-selector': 'VLAN_RANGES',
    opmode: CENTRAL_SSID_OPMODE[form.security],
  };
  if (form.defaultRole) body['default-role'] = form.defaultRole;
  if (form.security === 'wpa2-psk' || form.security === 'psk-portal') {
    const passphrase = form.passphrase ?? '';
    body['personal-security'] = {
      'passphrase-format': passphrase.length === 64 && /^[0-9a-f]+$/i.test(passphrase) ? 'HEX' : 'STRING',
      'wpa-passphrase': passphrase,
    };
  }
  if (
    (form.security === 'wpa3-enterprise' || form.security === 'wpa2-enterprise') &&
    form.authServerGroupId
  ) {
    body['auth-server-group'] = form.authServerGroupId;
  }
  if (form.security === 'psk-portal' && form.captivePortalProfileId) {
    body['captive-portal'] = form.captivePortalProfileId;
    body['captive-portal-type'] = 'EXTERNAL_CP';
  }
  return body;
}

function desiredValueMatches(current: unknown, desired: unknown): boolean {
  if (Array.isArray(desired)) {
    return Array.isArray(current) && JSON.stringify(current) === JSON.stringify(desired);
  }
  if (desired && typeof desired === 'object') {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return false;
    const cur = current as Record<string, unknown>;
    return Object.entries(desired as Record<string, unknown>).every(([key, value]) =>
      desiredValueMatches(cur[key], value),
    );
  }
  return current === desired;
}

/** Compare only fields this request owns, including the write-only PSK when
 * Central returns it. If a tenant redacts the PSK, an explicitly supplied
 * passphrase safely forces a PATCH instead of incorrectly becoming a no-op. */
export function wlanProfileChanged(current: unknown, desired: Record<string, unknown>): boolean {
  const cur = current && typeof current === 'object' ? (current as Record<string, unknown>) : {};
  return Object.entries(desired).some(([field, value]) => !desiredValueMatches(cur[field], value));
}

/**
 * The mode-specific WLAN fields buildWlanSsidPayload() only ever adds, never
 * removes: switching security modes leaves the previous mode's field(s) on
 * the tenant unless this write explicitly drops them. Verified against the
 * New Central 26.04 network-config OpenAPI reference (developer.arubanetworks.com
 * /new-central): PATCH is a partial update of exactly the fields present in
 * the body — omitted fields are left untouched, not cleared — while PUT is
 * the documented full-object replace. Rather than guess at unconfirmed
 * null-clears-a-field enum semantics for 'auth-server-group'/'captive-portal-type'
 * (which may not even be nullable in the schema), a mode transition away from
 * a field this map owns uses a PUT built from GET-current merged with the
 * new desired body, with every managed field this write no longer wants
 * explicitly deleted before send — a full replace clears them for certain,
 * and merging in the current profile first preserves whatever unrelated
 * settings (e.g. anything Central defaults that this form never exposes)
 * that request would otherwise have wiped out.
 */
const MANAGED_MODE_FIELDS = ['personal-security', 'auth-server-group', 'captive-portal', 'captive-portal-type'] as const;

/** True for any value this adapter would consider "still set" on the tenant —
 *  present, non-null, and not an empty string/array/object. */
function isFieldSet(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value as Record<string, unknown>).length > 0;
  return true;
}

/** Which managed mode-fields are still set on `current` but absent from the
 * new `desired` body — i.e. left over from a security mode this write is
 * moving away from. An empty result means no clearing is required. */
export function staleManagedModeFields(current: unknown, desired: Record<string, unknown>): string[] {
  if (!current || typeof current !== 'object' || Array.isArray(current)) return [];
  const cur = current as Record<string, unknown>;
  return MANAGED_MODE_FIELDS.filter((field) => !(field in desired) && isFieldSet(cur[field]));
}

/** Build the full-object PUT body for a mode transition: the current profile
 * (so unrelated fields this form doesn't manage survive the replace) with
 * this write's desired fields applied on top, then every managed mode-field
 * the new mode does not want stripped so PUT's replace semantics actually
 * remove it from the tenant. */
export function buildWlanReplacementPayload(current: unknown, desired: Record<string, unknown>): Record<string, unknown> {
  const cur = current && typeof current === 'object' && !Array.isArray(current) ? (current as Record<string, unknown>) : {};
  const {
    ssid: _ssid,
    id: _id,
    metadata: _metadata,
    ['scope-id']: _scopeId,
    scopeId: _camelScopeId,
    scopeName: _scopeName,
    ...writableCurrent
  } = cur;
  const merged: Record<string, unknown> = { ...writableCurrent, ...desired };
  for (const field of MANAGED_MODE_FIELDS) {
    if (!(field in desired)) delete merged[field];
  }
  return merged;
}

/** Central may redact or omit this write-only field on GET. Keep the readable
 * personal-security fields (including passphrase-format) in verification. */
function readableWlanPayload(desired: Record<string, unknown>): Record<string, unknown> {
  const personalSecurity = desired['personal-security'];
  if (!personalSecurity || typeof personalSecurity !== 'object' || Array.isArray(personalSecurity)) return desired;
  const { ['wpa-passphrase']: _passphrase, ...readablePersonalSecurity } = personalSecurity as Record<string, unknown>;
  return { ...desired, 'personal-security': readablePersonalSecurity };
}

/** Every SsidCatalogSection — the "N/7 sections" denominator and the
 *  all-sections-unavailable answer for Classic Central. */
export const ALL_SSID_CATALOG_SECTIONS: readonly SsidCatalogSection[] = [
  'sites',
  'site-collections',
  'ap-groups',
  'aps',
  'roles',
  'authServerGroups',
  'captivePortalProfiles',
];

/** Rows from a sites/site-collections/device-groups read → scope options,
 *  pushing `section` onto `unavailable` when the read failed (rows === null)
 *  instead of silently returning an empty catalog entry for it. */
function sectionScopeOptions(
  rows: unknown[] | null,
  category: SsidScopeCategory,
  unavailable: SsidCatalogSection[],
  section: SsidCatalogSection,
): SsidScopeOption[] {
  if (rows === null) {
    unavailable.push(section);
    return [];
  }
  const out: SsidScopeOption[] = [];
  for (const raw of rows) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const id = str(r.id ?? r['scope-id'] ?? r.scopeId ?? r.name);
    if (!id) continue;
    const label = str(r.scopeName ?? r.name ?? r.label ?? r.description) ?? id;
    out.push({ id, label, category });
  }
  return out;
}

/** Scope-data DEVICE rows → individual AP assignment targets. A device's
 * Central scope-id is not its serial number; config-assignments requires the
 * former, while the serial remains useful only in the display label. */
function apScopeOptionsFrom(rows: unknown[]): SsidScopeOption[] {
  const out: SsidScopeOption[] = [];
  for (const raw of rows) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    if (str(r.type) !== 'DEVICE' || str(r.persona) !== 'CAMPUS_AP') continue;
    const meta = r.meta && typeof r.meta === 'object' ? (r.meta as Record<string, unknown>) : {};
    const id = str(r.scope_id ?? r.scopeId);
    if (!id) continue;
    const name = str(meta.hostname ?? meta.scope_name) ?? id;
    const model = str(meta.device_model);
    const serial = str(meta.serial_number);
    const details = [model, serial].filter((value): value is string => value !== null).join(' · ');
    out.push({ id, label: details ? `${name} (${details})` : name, category: 'ap' });
  }
  return out;
}

/** Rows from a roles/server-groups/captive-portal read → dependency options. */
function dependencyOptionsFrom(rows: unknown[]): SsidDependencyOption[] {
  const out: SsidDependencyOption[] = [];
  for (const raw of rows) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const id = str(r.name ?? r.id);
    if (!id) continue;
    const description = str(r.description);
    out.push({ id, label: description ? `${id} — ${description}` : id });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Detail-read mapping (pure, exported for tests)
//
// Every shape below was verified against the live tenant, not guessed. Central
// returns most per-object statistics as STRINGS ('9', '-98', '1500 bytes'), so
// each mapper normalizes to the contract's types; a value the plane omitted (or
// worded in a way we cannot parse) becomes null, never 0.
// ---------------------------------------------------------------------------

/**
 * Central addresses a client by colon-separated lowercase MAC. Rows may reach
 * us hyphenated, dotted or upper-cased, so canonicalize before it becomes both
 * a URL segment and a cache key — otherwise 'AA-BB-…' and 'aa:bb:…' are two
 * cache entries and two calls for one client. Anything that is not 12 hex
 * digits is passed through trimmed+lowercased rather than mangled; '' → null,
 * which the caller turns into "this plane cannot answer".
 */
export function normalizeCentralMac(mac: string | null | undefined): string | null {
  const raw = (mac ?? '').trim().toLowerCase();
  if (!raw) return null;
  const hex = raw.replace(/[^0-9a-f]/g, '');
  if (hex.length === 12) return (hex.match(/.{2}/g) as string[]).join(':');
  return raw;
}

/**
 * '5 mins' / '3 hours' → seconds. Central states the sampling interval in
 * words and picks it from the queried range (≤1 day → 5 min, else 3 hours),
 * so it must be read rather than assumed: getting it wrong scales the derived
 * throughput by 36x. An unrecognized wording → null, and the caller then
 * reports no throughput instead of a wrong one.
 */
export function parseUsageIntervalSec(interval: string | null): number | null {
  const s = (interval ?? '').trim().toLowerCase();
  const m = /^(\d+)\s*(sec|min|hour|day)/.exec(s);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = { sec: 1, min: 60, hour: 3600, day: 86400 }[m[2] as 'sec' | 'min' | 'hour' | 'day'];
  return n * unit;
}

/**
 * One MobilityDetails row → a timeline event. Central's mobility trail is
 * exclusively ROAM records (source AP → destination AP), so `kind` is 'roam';
 * the sentence is built from the plane's own words, never embellished.
 */
export function mapMobilityEvent(raw: unknown): ClientTimelineEvent | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const ts = str(r.occurredAt);
  if (!ts) return null; // an undated event cannot be placed on a timeline
  const from = str(r.sourceAp);
  const to = str(r.destinationAp);
  const band = str(r.radioBand);
  const toChannel = str(r.toChannel);
  const fromChannel = str(r.fromChannel);
  const wlan = str(r.wlanName);
  const proto = str(r.roamProtocol);
  const roamMs = num(r.roamTime);
  const where = from && to ? `roamed ${from} -> ${to}` : to ? `roamed to ${to}` : from ? `roamed from ${from}` : 'roamed';
  const channelText =
    fromChannel && toChannel && fromChannel !== toChannel ? `ch ${fromChannel} -> ${toChannel}` : toChannel ? `ch ${toChannel}` : null;
  const detail = [where, [band, channelText].filter(Boolean).join(' '), proto, roamMs !== null ? `${roamMs} ms` : null]
    .filter((v): v is string => typeof v === 'string' && v.length > 0)
    .join(', ');
  return {
    ts,
    kind: 'roam',
    detail,
    ...(to ? { device: to } : {}),
    rssiDbm: num(r.rssi),
    ...(band ? { band } : {}),
    ...(toChannel ? { channel: toChannel } : {}),
    ...(wlan ? { wlan } : {}),
  };
}

/**
 * A GetClientsUsage payload → oldest-first samples. `keys` names the columns
 * of each `data` tuple (['txUsage','rxUsage'] live) — it is READ, not assumed,
 * so a tenant that reorders them does not silently swap tx and rx.
 */
export function mapUsageSamples(body: unknown): UsageSample[] {
  if (!body || typeof body !== 'object') return [];
  const b = body as Record<string, unknown>;
  const keys = Array.isArray(b.keys) ? b.keys.map((k) => str(k)) : [];
  const txAt = keys.indexOf('txUsage');
  const rxAt = keys.indexOf('rxUsage');
  const samples = Array.isArray(b.samples) ? b.samples : [];
  const out: UsageSample[] = [];
  for (const s of samples) {
    if (!s || typeof s !== 'object') continue;
    const row = s as Record<string, unknown>;
    const ts = str(row.ts);
    if (!ts) continue;
    const data = Array.isArray(row.data) ? row.data : [];
    out.push({
      ts,
      txBytes: txAt >= 0 ? num(data[txAt]) : null,
      rxBytes: rxAt >= 0 ? num(data[rxAt]) : null,
    });
  }
  return out;
}

/** One AccessPointRadio row → DeviceRadio. `index` is the fallback radio
 *  number for a payload that omits radioNumber (live always sends it). */
export function mapCentralRadio(raw: unknown, index = 0): DeviceRadio | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const mac = str(r.macAddress);
  return {
    number: num(r.radioNumber) ?? index,
    band: str(r.band) ?? '',
    // '157E' / '213S' — the trailing letter is a bonding marker, so the plane's
    // own string is the only lossless representation.
    channel: str(r.channel) ?? '',
    bandwidth: str(r.bandwidth) ?? '',
    powerDbm: num(r.power),
    clients: num(r.clientCount),
    channelUtilPct: num(r.channelUtilization),
    rxUtilPct: num(r.rxUtilization),
    txUtilPct: num(r.txUtilization),
    retries: num(r.retries),
    drops: num(r.drops),
    noiseFloorDbm: num(r.noiseFloor),
    nonWifiInterference: num(r.nonWifiInterference),
    channelQuality: num(r.channelQuality),
    status: str(r.status) ?? '',
    mode: str(r.mode) ?? '',
    ...(mac ? { macAddress: mac } : {}),
  };
}

/** One WlanInfoV1 row → DeviceWlan. */
export function mapCentralWlan(raw: unknown): DeviceWlan | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const name = str(r.wlanName);
  if (!name) return null; // an unnamed WLAN row is junk
  return {
    name,
    status: str(r.status) ?? '',
    security: str(r.security) ?? '',
    securityLevel: str(r.securityLevel) ?? '',
    band: str(r.band) ?? '',
    // A bare id ('200') and a named VLAN both arrive here, hence a string.
    vlan: str(r.vlan) ?? '',
    clients: num(r.clientCount),
  };
}

/** Numeric VLAN ids out of an allowedVlanIds array; junk entries dropped. */
function vlanIdList(raw: unknown): number[] | null {
  if (!Array.isArray(raw)) return null;
  return raw.map((v) => num(v)).filter((v): v is number => v !== null);
}

/**
 * One SwitchInterface row → DevicePort. Verified on CX6300-CORE (SG30LMR164):
 * `speed` is already BITS PER SECOND here (1000000000 for a 1 Gb port), unlike
 * the gateway ports endpoint below, which reports Mbps as a string.
 */
export function mapCentralSwitchPort(raw: unknown): DevicePort | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const name = str(r.name) ?? str(r.id);
  if (!name) return null;
  const allowed = vlanIdList(r.allowedVlanIds);
  const connector = str(r.connector);
  const poeStatus = str(r.poeStatus);
  const poeClass = str(r.poeClass);
  const stpRole = str(r.stpPortRole);
  const stpState = str(r.stpPortState);
  const neighbour = str(r.neighbour);
  const neighbourPort = str(r.neighbourPort);
  const neighbourSerial = str(r.neighbourSerial);
  const neighbourType = str(r.neighbourType);
  const neighbourHealth = str(r.neighbourHealth);
  const lag = str(r.lag);
  return {
    name,
    status: str(r.status) ?? '',
    adminStatus: str(r.adminStatus) ?? '',
    operStatus: str(r.operStatus) ?? '',
    speedBps: num(r.speed),
    duplex: str(r.duplex) ?? '',
    vlanMode: str(r.vlanMode) ?? '',
    mtu: num(r.mtu),
    nativeVlan: num(r.nativeVlan),
    ...(connector ? { connector } : {}),
    // Present-and-empty is meaningful (the plane said "no tagged VLANs"), so
    // the key ships whenever the plane sent the array at all.
    ...(allowed ? { allowedVlanIds: allowed } : {}),
    ...(poeStatus ? { poeStatus } : {}),
    ...(poeClass ? { poeClass } : {}),
    ...(stpRole ? { stpRole } : {}),
    ...(stpState ? { stpState } : {}),
    ...(neighbour ? { neighbour } : {}),
    ...(neighbourPort ? { neighbourPort } : {}),
    ...(neighbourSerial ? { neighbourSerial } : {}),
    ...(neighbourType ? { neighbourType } : {}),
    ...(neighbourHealth ? { neighbourHealth } : {}),
    ...(lag ? { lag } : {}),
    ...(typeof r.uplink === 'boolean' ? { uplink: r.uplink } : {}),
  };
}

/**
 * One GatewayPortResponse row → DevicePort. A DIFFERENT shape from the switch
 * interface, and deliberately mapped separately:
 *   - `speed` is a STRING in Mbps ('1000') or the literal 'Auto' when the port
 *     is down — 'Auto' is not a speed, so it becomes null rather than 0, and a
 *     numeric value is scaled to bits per second.
 *   - `mtu` arrives as '1500 bytes'.
 *   - adminState is 'Enabled'/'Disabled' and operState 'Up'/'Down'; there is no
 *     rolled-up `status` field, so operState IS the port's status here.
 *   - the gateway ports endpoint reports NO neighbour, PoE or spanning-tree
 *     facts. Those keys stay ABSENT — a gateway port genuinely has no such
 *     reading, and an empty string would read as "the plane failed to report".
 */
export function mapCentralGatewayPort(raw: unknown): DevicePort | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const name = str(r.name) ?? str(r.portNumber);
  if (!name) return null;
  const speedMbps = num(r.speed); // 'Auto' → null
  const connector = str(r.connectorType);
  const mtu = num(/^\d+/.exec(str(r.mtu) ?? '')?.[0] ?? null);
  const oper = str(r.operState) ?? '';
  const allowed = vlanIdList((str(r.vlan) ?? '').split(',').filter((v) => v.trim().length > 0));
  return {
    name,
    status: oper,
    adminStatus: str(r.adminState) ?? '',
    operStatus: oper,
    speedBps: speedMbps === null ? null : speedMbps * 1_000_000,
    duplex: str(r.duplex) ?? '',
    vlanMode: str(r.portType) ?? '',
    mtu,
    ...(connector ? { connector } : {}),
    ...(allowed && allowed.length > 0 ? { allowedVlanIds: allowed } : {}),
  };
}

/** One Topology `devices` entry → TopologyDeviceNode. */
export function mapTopologyNode(raw: unknown): TopologyDeviceNode | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  // Unmanaged nodes get a synthetic serial ('tpd_204c03ff61e2') — still the
  // key the links reference, so it is the graph key either way.
  const serial = str(r.serial);
  if (!serial) return null;
  const mac = str(r.mac);
  return {
    serial,
    name: str(r.name) ?? mac ?? serial,
    type: str(r.type) ?? '',
    deviceFunction: str(r.deviceFunction) ?? '',
    status: str(r.status) ?? '',
    // null is a REAL answer for an unmanaged node Central does not assess.
    health: str(r.health),
    healthReason: str(r.healthReason),
    model: str(r.model),
    ipv4: str(r.ipv4),
    mac,
    deployment: str(r.deployment),
    conductorSerial: str(r.conductorSerial),
    internet: typeof r.internet === 'boolean' ? r.internet : null,
    // 0 and null both mean "no stamp"; neither may be rendered as 1970.
    lastSeen: num(r.lastSeen),
  };
}

function mapTopologyPorts(raw: unknown): TopologyLinkPort[] {
  if (!Array.isArray(raw)) return [];
  const out: TopologyLinkPort[] = [];
  for (const p of raw) {
    if (!p || typeof p !== 'object') continue;
    const rec = p as Record<string, unknown>;
    const name = str(rec.name);
    if (!name) continue;
    out.push({
      name,
      index: num(rec.index),
      lag: str(rec.lag),
      health: str(rec.health),
      healthReason: str(rec.healthReason),
    });
  }
  return out;
}

/** One Topology `links` entry → TopologyLink (keyed by the node SERIALS). */
export function mapTopologyLink(raw: unknown): TopologyLink | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const from = str(r.from);
  const to = str(r.to);
  if (!from || !to) return null; // a half-attached edge cannot be drawn
  return {
    from,
    to,
    fromPorts: mapTopologyPorts(r.fromPortList),
    toPorts: mapTopologyPorts(r.toPortList),
    speedBps: num(r.speed),
    // 'Unknown' is Central's own verdict about an unmanaged far end — a real
    // answer, not a failed read.
    health: str(r.health),
    healthReason: str(r.healthReason),
    stpState: str(r.stpState),
    edgeType: str(r.edgeType),
    isSibling: typeof r.isSibling === 'boolean' ? r.isSibling : null,
  };
}

// ---------------------------------------------------------------------------
// Token manager — in-memory, refresh at expiry−60s, single-flight
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

type SectionKey =
  | 'deviceInventory'
  | 'aps'
  | 'switches'
  | 'gateways'
  | 'sites'
  | 'clients'
  | 'notifications'
  | 'ssids';

interface SectionCandidate {
  path: string;
  /** Per-candidate query extras — classic-only params (e.g. calculate_total)
   *  must NOT leak onto the v1alpha1 paths, which 400 on unknown params. */
  extraQuery?: string;
  /** How THIS endpoint pages. Default (absent) is offset/limit. 'cursor'
   *  means it ignores `offset` and hands back a `next` token instead — see
   *  the paging note in the file header. */
  paging?: 'cursor' | 'none';
}

interface SectionSpec {
  candidates: SectionCandidate[];
  limit: number;
  maxPages: number;
  /** Per-section request timeout; absent = OUTBOUND_TIMEOUT_MS. A 500-row
   *  client page legitimately takes longer than a 10s default allows. */
  timeoutMs?: number;
}

/** One section's rows plus whether the walk finished (see fetchSection). */
interface SectionResult {
  rows: unknown[];
  truncated: boolean;
}

const SECTIONS: Record<SectionKey, SectionSpec> = {
  deviceInventory: {
    candidates: [
      { path: '/network-monitoring/v1/device-inventory', paging: 'cursor' },
      { path: '/network-monitoring/v1alpha1/device-inventory', paging: 'cursor' },
    ],
    limit: 200,
    maxPages: 25,
    timeoutMs: SECTION_TIMEOUT_MS,
  },
  aps: {
    candidates: [{ path: '/monitoring/v1/aps' }, { path: '/network-monitoring/v1alpha1/aps' }],
    limit: 200,
    maxPages: 25,
    timeoutMs: SECTION_TIMEOUT_MS,
  },
  switches: {
    candidates: [{ path: '/monitoring/v1/switches' }, { path: '/network-monitoring/v1alpha1/switches' }],
    limit: 200,
    maxPages: 25,
    timeoutMs: SECTION_TIMEOUT_MS,
  },
  gateways: {
    candidates: [{ path: '/monitoring/v1/gateways' }, { path: '/network-monitoring/v1alpha1/gateways' }],
    limit: 200,
    maxPages: 25,
    timeoutMs: SECTION_TIMEOUT_MS,
  },
  sites: {
    candidates: [
      { path: '/network-config/v1/sites', paging: 'none' },
      { path: '/central/v2/sites' },
      { path: '/central/v1/sites' },
      { path: '/network-config/v1alpha1/sites' },
    ],
    limit: 100,
    maxPages: 10,
  },
  clients: {
    candidates: [
      // GA first: it is the only clients endpoint that reports per-client RF
      // (snr, band, channel, keyManagement) — the v1alpha1 alpha path answers
      // on the same tenants but omits snr entirely, which is why the Clients
      // table read 'not reported by CENTRAL' for a field Central does report.
      // It pages on a `next` cursor, NOT offset (see the header paging note).
      { path: '/network-monitoring/v1/clients', paging: 'cursor' },
      { path: '/monitoring/v1/clients', extraQuery: '&calculate_total=true' },
      { path: '/network-monitoring/v1alpha1/clients' },
    ],
    limit: 500,
    maxPages: 25,
    timeoutMs: SECTION_TIMEOUT_MS,
  },
  notifications: {
    candidates: [
      {
        path: '/network-notifications/v1/alerts',
        paging: 'cursor',
        extraQuery: `&filter=${encodeURIComponent("status eq 'Active'")}&sort=${encodeURIComponent('severity desc')}`,
      },
      { path: '/central/v1/notifications' },
      { path: '/monitoring/v1/notifications' },
    ],
    limit: 100,
    maxPages: 5,
  },
  ssids: {
    candidates: [{ path: '/network-config/v1/wlan-ssids', paging: 'none' }],
    limit: 100,
    maxPages: 1,
  },
};

/** Outbound verbs this adapter issues. PATCH is additive — used only by the
 *  direct SSID profile update path (applySsidProfile); every existing caller
 *  still passes GET/POST/PUT and is unaffected. DELETE is additive too — used
 *  only by the direct webhook-management path (server/src/services/
 *  centralWebhooks.ts's DELETE /network-services/v1/webhooks/{id}); every
 *  existing caller is unaffected. */
type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/**
 * One outbound response. Rate-limit metadata is additive — callers that only
 * read { status, body } are unaffected.
 */
export type CentralHttpBodyParse =
  | 'empty'
  | 'whitespace'
  | 'json-null'
  | 'json'
  | 'malformed-json'
  | 'non-json'
  | 'unreadable';

export interface CentralHttpResult {
  status: number;
  body: unknown;
  /** How the response bytes became `body`; never includes the raw body. */
  bodyParse: CentralHttpBodyParse;
  /** Trimmed Location response header, used by accepted async operations. */
  location?: string;
  retryAfterMs?: number;
  rateLimitResetAtMs?: number;
}

export type CentralRequestErrorKind = 'authentication' | 'transport' | 'service';

/** Secret-free failure classification for auth'd Central requests. */
export class CentralRequestError extends Error {
  constructor(
    readonly kind: CentralRequestErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'CentralRequestError';
  }
}

class HttpStatusError extends Error {
  constructor(
    readonly status: number,
    path: string,
  ) {
    super(`HTTP ${status} from ${path}`);
    this.name = 'HttpStatusError';
  }
}

/** Section key → the shared dataset it feeds (three inventory endpoints, one
 *  dataset; 'notifications' is the plane's word for the alerts dataset). */
const SECTION_DATASET: Record<SectionKey, PlaneDatasetKey> = {
  deviceInventory: 'devices',
  aps: 'devices',
  switches: 'devices',
  gateways: 'devices',
  sites: 'sites',
  clients: 'clients',
  notifications: 'alerts',
  ssids: 'config',
};

/**
 * Datasets this pull could not read in full — a 404-on-every-candidate section
 * OR one whose paged walk did not finish. Both are "we do not have the whole
 * picture", which is what PlanePull.partial exists to say; a truncated dataset
 * still ships its rows, so omission alone cannot express it.
 */
function partialDatasets(missing: readonly SectionKey[], truncated: readonly SectionKey[]): PlaneDatasetKey[] {
  const out = new Set<PlaneDatasetKey>();
  for (const s of [...missing, ...truncated]) out.add(SECTION_DATASET[s]);
  return [...out];
}

class SectionMissingError extends Error {
  constructor(readonly section: SectionKey) {
    super(`section '${section}': no candidate endpoint answered (all 404)`);
    this.name = 'SectionMissingError';
  }
}

/**
 * Payload keys the section endpoints use, tried before the first-array
 * heuristic. Order matters: each section's OWN key is listed before the
 * generic ones, so a devices payload that happens to carry a sibling
 * `alerts: []` still resolves on `aps`/`switches`/`gateways`. 'alerts' is
 * here because /network-notifications/v1/alerts — the third notifications
 * candidate — returns its rows under it; without it that section fell through
 * to "first array in property order" and could return `filters: []`.
 */
const PAYLOAD_KEYS = [
  'aps',
  'switches',
  'gateways',
  'devices',
  'sites',
  'clients',
  'notifications',
  'alerts',
  'applications',
  'items',
  'results',
  'wlan-ssid',
];

/**
 * Rows out of a collection body, or null when the payload carries no row
 * container at all.
 *
 * Null, not `[]`. A 200 whose body cannot be read is not evidence of zero
 * rows: an SSO interstitial, a truncated response, or an envelope shape this
 * build does not know would otherwise reach the screen as "this section has
 * none" — the one thing the portal must never say about data it did not read.
 * Callers turn null into a failed section. Mist has guarded its walk this way
 * since it was written, and sse/clearpass return null for the same reason;
 * this adapter and greenlake were the two that could not tell the difference.
 */
function extractRows(body: unknown): unknown[] | null {
  if (Array.isArray(body)) return body;
  if (body && typeof body === 'object') {
    const r = body as Record<string, unknown>;
    // A well-known payload key wins over an incidental array (e.g. `errors: []`)
    // that happens to precede it — the heuristic alone would zero the section.
    for (const k of PAYLOAD_KEYS) {
      if (Array.isArray(r[k])) return r[k];
    }
    for (const v of Object.values(r)) {
      if (Array.isArray(v)) return v;
    }
  }
  return null;
}

/**
 * The same read, but starting from how the bytes parsed.
 *
 * `bodyParse` already separates an absent body from an unreadable one, and
 * centralWebhooks has consulted it since it was added — an empty, blank or
 * literal-null list response is an honest empty collection there, a malformed
 * or non-JSON one is an error and never an empty success. The inventory pull,
 * which produces every device, client, site and alert row in the portal,
 * never asked. Same three cases, same three failures, one reader now.
 */
function rowsFromResponse(res: { body: unknown; bodyParse?: CentralHttpBodyParse }): unknown[] | null {
  switch (res.bodyParse) {
    case 'empty':
    case 'whitespace':
    case 'json-null':
      return [];
    case 'malformed-json':
    case 'non-json':
    case 'unreadable':
      return null;
    default:
      return extractRows(res.body);
  }
}

/**
 * A detail GET reduced to rows, or the note that explains their absence, so a
 * body that could not be read takes the SAME branch as a transport failure
 * instead of the one that renders 'empty'.
 */
function detailRows(
  res: { ok: true; body: unknown; bodyParse: CentralHttpBodyParse } | { ok: false; note: string },
): { rows: unknown[]; body: unknown } | { note: string } {
  if (!res.ok) return { note: res.note };
  const rows = rowsFromResponse(res);
  return rows === null ? { note: 'a 200 whose body carried no readable rows' } : { rows, body: res.body };
}

/**
 * A detail GET whose payload is read BY NAME rather than by row heuristic
 * (topology has two sibling arrays), or null when there is no object to read.
 */
function readableObjectBody(res: {
  body: unknown;
  bodyParse?: CentralHttpBodyParse;
}): Record<string, unknown> | null {
  switch (res.bodyParse) {
    case 'malformed-json':
    case 'non-json':
    case 'unreadable':
      return null;
    default:
      return res.body && typeof res.body === 'object' && !Array.isArray(res.body)
        ? (res.body as Record<string, unknown>)
        : null;
  }
}

/**
 * The trend payloads wrap their positional series differently per endpoint
 * (verified: bare for hardware-trends, trends.graph for AP trends, response
 * for interface-trends). Each candidate is a key path; the first object
 * carrying BOTH keys[] and samples[] wins. Null when no candidate does —
 * a 200 whose body cannot be read is a failed read, not an empty chart.
 */
function trendGraph(
  body: Record<string, unknown>,
  candidates: readonly (readonly string[])[],
): { keys: unknown; samples: unknown } | null {
  for (const path of candidates) {
    let cur: unknown = body;
    for (const key of path) {
      cur = cur && typeof cur === 'object' && !Array.isArray(cur) ? (cur as Record<string, unknown>)[key] : null;
    }
    if (cur && typeof cur === 'object' && !Array.isArray(cur)) {
      const graph = cur as Record<string, unknown>;
      if (Array.isArray(graph.keys) && Array.isArray(graph.samples)) {
        return { keys: graph.keys, samples: graph.samples };
      }
    }
  }
  return null;
}

/**
 * Grand total of the section, or null when the payload does not state one.
 * Deliberately does NOT read `count`: the v1alpha1 payloads report it as the
 * row count of the current response (see the fixture in central.test.ts —
 * `total: 1, count: 1, next: 1`), so trusting it as the total makes
 * `offset < total` false after page one and truncates the section to a single
 * page. Null is the honest answer; the paging loop then uses the full-page
 * heuristic, which terminates on the first short page.
 */
function extractTotal(body: unknown): number | null {
  if (body && typeof body === 'object') {
    const b = body as Record<string, unknown>;
    return num(b.total) ?? num(b.total_count) ?? num(b.totalCount);
  }
  return null;
}

/**
 * Cursor for the NEXT page of a cursor-paged candidate, or null when the
 * payload says this was the last one. Read only for `paging: 'cursor'`
 * candidates: the v1alpha1 payloads also carry a `next` key, but there it is
 * a page ordinal alongside a working `offset`, so reading it everywhere would
 * change how those sections walk. Live GA shape: `{ items, total, count,
 * next: "2" }` on a middle page and `next: null` on the last.
 */
function extractNextCursor(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  const nested = b.pagination ?? b._pagination;
  const raw =
    b.next ?? (nested && typeof nested === 'object' ? (nested as Record<string, unknown>).next : undefined);
  return str(raw);
}

// -- token endpoints: which OAuth server mints a token for this gateway -------

/**
 * New Central (devhub.arubanetworks.com/new-central): the regional gateways are
 * {region}.api.central.arubanetworks.com (us1…, de1…, internal…), and tokens
 * are minted by the HPE GreenLake common SSO — NOT by the gateway:
 *   POST https://sso.common.cloud.hpe.com/as/token.oauth2
 *   content-type application/x-www-form-urlencoded
 *   body grant_type=client_credentials&client_id&client_secret   (2h validity)
 * Classic Central (*-apigw*.central.arubanetworks.com) mints its own
 * POST {gateway}/oauth2/token (JSON body).
 * Detection is host-shape driven; a 404 from the primary falls through to the
 * other exactly once (docs drift both ways), and the winner is remembered.
 */
export const GREENLAKE_CCS_TOKEN_URL = 'https://sso.common.cloud.hpe.com/as/token.oauth2';

interface TokenEndpoint {
  url: string;
  formEncoded: boolean;
  label: string;
}

/** True for the new-Central gateway hostnames (incl. internal.api.…, cn1.….cn). */
export function isNewCentralGateway(baseUrl: string): boolean {
  return /^https:\/\/[a-z0-9-]+\.api\.central\.arubanetworks\.com(\.cn)?$/i.test(baseUrl);
}

function tokenCandidates(baseUrl: string): TokenEndpoint[] {
  const ccs: TokenEndpoint = { url: GREENLAKE_CCS_TOKEN_URL, formEncoded: true, label: 'GreenLake SSO' };
  const local: TokenEndpoint = { url: `${baseUrl}/oauth2/token`, formEncoded: false, label: 'gateway /oauth2/token' };
  return isNewCentralGateway(baseUrl) ? [ccs, local] : [local, ccs];
}

export class CentralAdapter implements PlaneAdapter {
  readonly id = 'central' as const;

  private readonly baseUrl: string;
  private readonly approved: ApprovedFirmwareMap;
  private readonly tokens: TokenManager;
  /** Section → candidate path that worked (tried first next time). */
  private readonly resolvedPath = new Map<SectionKey, SectionCandidate>();
  /** Token endpoint that worked (tried first next time). */
  private resolvedToken: TokenEndpoint | null = null;
  /** TTL cache for on-demand detail reads, keyed by object identity. This is
   *  the rate-limit guard: without it, every drawer open (and every re-render
   *  that re-asks) is another per-object call against a quota'd tenant. */
  private readonly detailCache = new Map<string, { expiresAtMs: number; value: unknown }>();
  /** Single-flight per key: two panes opening the same object at once share
   *  ONE round trip instead of racing two. */
  private readonly detailInflight = new Map<string, Promise<unknown>>();

  constructor(
    creds: PlaneCredentials,
    private readonly stateRef: PlaneState,
    private readonly recordCall: RecordCallFn,
    private readonly fetchImpl: FetchLike = (url, init) => fetch(url, init),
    /** Injectable so tests exercise backoff/pacing without real wall time. */
    private readonly sleep: SleepFn = realSleep,
    /** Injectable clock — the detail TTL cache and the mobility-trail lookback
     *  both read it, and a test must be able to move time without sleeping. */
    private readonly now: () => number = () => Date.now(),
  ) {
    if (!CentralAdapter.isComplete(creds)) {
      throw new Error('central requires gatewayBaseUrl, clientId and clientSecret');
    }
    this.baseUrl = httpsBase(creds.gatewayBaseUrl, 'the client secret is posted to mint a token and the bearer rides every call').replace(/\/+$/, '');
    this.approved = parseApprovedFirmware(creds.approvedFirmware);
    // Publish the capability statement on the shared state too: nothing calls
    // PlaneAdapter.capabilities() yet, and an unset field reads as "claims
    // nothing" — which for localShell is right, but brokeredWrite is real.
    this.stateRef.capabilities = this.capabilities();
    this.tokens = new TokenManager(async () => {
      const candidates = tokenCandidates(this.baseUrl);
      const ordered = this.resolvedToken
        ? [this.resolvedToken, ...candidates.filter((c) => c.url !== this.resolvedToken?.url)]
        : candidates;
      let lastMiss: string | null = null;
      let firstReject: { status: number; label: string } | null = null;
      for (let i = 0; i < ordered.length; i += 1) {
        const ep = ordered[i]!;
        const { status, body } = await this.httpAbsolute('POST', ep.url, {
          body: { grant_type: 'client_credentials', client_id: creds.clientId, client_secret: creds.clientSecret },
          formEncoded: ep.formEncoded,
        });
        if (status === 404) {
          lastMiss = `${ep.label} answered 404`;
          continue; // wrong generation of gateway for this account — try the other
        }
        const record = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
        const token = str(record.access_token);
        if (status !== 200 || !token) {
          const credentialReject = [400, 401, 403].includes(status);
          // 401 ALSO falls through, and only 401. The header above says the
          // docs drift both ways and that a miss falls through exactly once,
          // but the fall-through only fired on 404 — and a token endpoint
          // that EXISTS never answers 404 to a client_id it does not know: it
          // answers 401. So for the wrong-generation case the fallback was
          // written for, it could not fire. Host shape picks who goes first;
          // it does not get to be the last word.
          //
          // 400 and 403 do NOT fall through: an OAuth 400 (`invalid_client`)
          // is an endpoint that parsed the request and disowned the secrets,
          // and 403 is an authorisation answer, not "unknown client". Neither
          // is evidence that a different endpoint would do better, and there
          // is no reason to hand the secret to a second host to find out.
          if (status === 401 && i < ordered.length - 1) {
            firstReject ??= { status, label: ep.label };
            continue;
          }
          // Credential statuses are authentication failures; malformed/5xx
          // token answers are service failures. Neither exposes the body.
          const detail = firstReject
            ? `${firstReject.label} answered HTTP ${firstReject.status}, then ${ep.label} answered HTTP ${status}`
            : `${ep.label} answered HTTP ${status}`;
          throw new CentralRequestError(
            credentialReject ? 'authentication' : 'service',
            firstReject && credentialReject
              ? `auth: neither token endpoint accepted these credentials — ${detail}`
              : `auth: ${detail} without an access_token`,
          );
        }
        this.resolvedToken = ep;
        const published = num(record.expires_in);
        // Publish WHEN this credential dies (the registry could only publish
        // HOW it is obtained). A gateway that sends no expires_in leaves
        // expiresAt null — the 3600 below is a refresh-pacing default, not a
        // lifetime the plane ever claimed.
        this.stateRef.token = mintedTokenInfo(published);
        return { accessToken: token, expiresInSec: published ?? 3600 };
      }
      if (firstReject) {
        // Something answered and disowned the credentials; a 404 from the
        // alternate only means it does not exist, which is the weaker story.
        throw new CentralRequestError(
          'authentication',
          `auth: ${firstReject.label} answered HTTP ${firstReject.status} without an access_token` +
            (lastMiss ? ` (${lastMiss})` : ''),
        );
      }
      throw new CentralRequestError(
        'service',
        `auth: no token endpoint answered — ${lastMiss ?? 'no candidates'}`,
      );
    });
  }

  static isComplete(creds: PlaneCredentials | null): boolean {
    return (
      !!creds &&
      [creds.gatewayBaseUrl, creds.clientId, creds.clientSecret].every(
        (v) => typeof v === 'string' && v.trim().length > 0,
      )
    );
  }

  state(): PlaneState {
    return this.stateRef;
  }

  /**
   * What the portal can do with Central, stated honestly:
   *   localShell    false — cloud-claimed hardware gets no portal shell; the
   *                 recorded-SSH bridge is the local collector's / AOS-8
   *                 master's path, not this plane's.
   *   brokeredWrite true  — this adapter IS the write broker's transport
   *                 (writeBroker.ts resolves the CentralAdapter and pushes
   *                 through request()); the ticket + lease gate is the
   *                 broker's, not a capability statement.
   *   configRead    true on New Central — pull() reads configured WLAN
   *                 profiles. Classic gateways retain the observed fallback.
   *   directWrite   true on New Central — ssidCatalog()/applySsidProfile()
   *                 below are real; Classic Central is NOT writable via this
   *                 path (its config surface is the legacy /configuration/v2
   *                 namespace this adapter never learned to write correctly).
   */
  capabilities(): PlaneCapabilities {
    const newCentral = isNewCentralGateway(this.baseUrl);
    return {
      localShell: false,
      brokeredWrite: true,
      configRead: newCentral,
      directWrite: newCentral,
      activeDiagnostics: newCentral,
      alertFeed: true,
    };
  }

  // -- ON-DEMAND DETAIL READS ------------------------------------------------
  //
  // These are NOT poller work and must never be called from poller.ts. Central
  // models a client across ~8 endpoints and a device across many
  // /{id}/subresource endpoints; fanning those out over the inventory on the
  // 60s timer would be 9 devices x N subresources x 1440 polls/day against a
  // tenant that enforces a daily call budget. So:
  //   * every method reads for the ONE object being viewed,
  //   * behind a TTL cache + single-flight (DETAIL_TTL_MS),
  //   * with a per-call timeout SHORTER than the poll timeout, and
  //   * with NO 429 backoff loop — a rate-limited detail read degrades to the
  //     honest empty state immediately rather than holding a drawer open for
  //     30 seconds. The poller's own backoff still protects the quota.
  //
  // Call cost, worst case, per object per TTL window:
  //   client   2 (mobility-trail + clients-usage)
  //   AP       2 (radios + wlans)
  //   switch   1 (interfaces — Central returns ALL of them unpaged by default)
  //   gateway  1 (ports)
  //   topology 1
  //
  // A section that failed is reported as 'failed', NOT as an empty result: the
  // screen must be able to say the call broke instead of implying the plane has
  // nothing (shared/types.ts, the three-state note above DetailFetchState).

  /**
   * Per-client detail for ONE MAC.
   *
   *   rssi / roams / timeline  ← GET /clients/{mac}/mobility-trail
   *       Central's ONLY per-client RSSI source: the flat /clients row carries
   *       snr but no rssi, and the mobility trail stamps every roam with the
   *       signal it landed on. A stationary client answers 200 with zero events
   *       — that is "no roaming in the last 24h", not a failure, so `roams` is
   *       'ok' at 0 while `timeline` is 'empty'.
   *   tput / usageSeries       ← GET /clients-usage?filter=macAddress eq '…'
   *       VERIFIED live: unfiltered this endpoint is TENANT-WIDE (78 MB per
   *       5-min bucket on this tenant); with the macAddress filter it is the
   *       single client (984 B for a Roku, 128 B for a Pi). Attributing the
   *       unfiltered series to one client would be fabrication, so the filter
   *       is not optional. /clients-topn-usage is per-client too but is a
   *       LEADERBOARD — a client outside the top N is simply absent from it,
   *       which would read as "no throughput" for a quiet client.
   */
  async clientDetail(mac: string, medium?: ClientRow['medium']): Promise<ClientDetailLive | null> {
    const normalized = normalizeCentralMac(mac);
    if (!normalized) return null; // no MAC = nothing this plane can be asked about
    return this.cachedDetail(`client:${normalized}:${medium ?? 'unknown'}`, () =>
      this.readClientDetail(normalized, medium),
    );
  }

  /**
   * Per-device detail for ONE serial. `kind` decides which subresources are
   * worth asking for so we never spend a call on a guaranteed 404 (an AP has
   * no /interfaces, a switch has no /radios).
   */
  async deviceDetail(serial: string, kind: DeviceDetailKind): Promise<DeviceDetailLive | null> {
    const id = (serial ?? '').trim();
    if (!id) return null;
    return this.cachedDetail(`device:${kind}:${id}`, () => this.readDeviceDetail(id, kind));
  }

  /** The plane's link topology for ONE site — GET /topology/{site-id}. */
  async siteTopology(siteId: string): Promise<SiteTopologyLive | null> {
    const id = (siteId ?? '').trim();
    if (!id) return null;
    return this.cachedDetail(`topology:${id}`, () => this.readSiteTopology(id));
  }

  // -- DPI application visibility + hardware trends --------------------------
  //
  // Same on-demand contract as the detail reads above: fetched for the ONE
  // site/device being viewed, TTL-cached, never from the poller. The window
  // is validated against the 7-day cap BEFORE any call (a wider window 400s
  // the applications endpoint); a refusal costs no call and reads as
  // not-fetched + a note, never as a plane failure.
  //
  // NOTE ON WINDOWS: only the applications endpoint is verified to take
  // start/end, so only that read sends them. The trend endpoints are called
  // bare (verified one-call shapes); the requested window still rides in the
  // payload and the cache key, and the series' own timestamps say what the
  // plane actually returned.

  /** The DPI application table for ONE site over ONE window (paged). */
  async siteApplications(siteId: string, window: TrendWindow): Promise<SiteApplicationsLive | null> {
    const id = (siteId ?? '').trim();
    if (!id) return null;
    return this.cachedDetail(`apps:${id}:${window?.start}:${window?.end}`, () => this.readSiteApplications(id, window));
  }

  /** A switch's hardware gauges for ONE serial — ONE call. */
  async switchHardwareTrends(serial: string, window: TrendWindow): Promise<SwitchHardwareTrendsLive | null> {
    const id = (serial ?? '').trim();
    if (!id) return null;
    return this.cachedDetail(`hwtrends:${id}:${window?.start}:${window?.end}`, () =>
      this.readSwitchHardwareTrends(id, window),
    );
  }

  /** ONE AP metric trend for ONE serial — ONE call per metric. */
  async apTrends(serial: string, metric: ApTrendMetric, window: TrendWindow): Promise<ApTrendsLive | null> {
    const id = (serial ?? '').trim();
    // A metric outside the endpoint vocabulary is a caller bug, not a plane
    // question — null ("this plane cannot answer"), and it costs no call.
    if (!id || !AP_TREND_METRICS.includes(metric)) return null;
    return this.cachedDetail(`aptrends:${id}:${metric}:${window?.start}:${window?.end}`, () =>
      this.readApTrends(id, metric, window),
    );
  }

  /** A switch's interface byte/error counter trends for ONE serial — ONE call. */
  async switchInterfaceTrends(serial: string, window: TrendWindow): Promise<SwitchInterfaceTrendsLive | null> {
    const id = (serial ?? '').trim();
    if (!id) return null;
    return this.cachedDetail(`iftrends:${id}:${window?.start}:${window?.end}`, () =>
      this.readSwitchInterfaceTrends(id, window),
    );
  }

  // -- direct SSID write (New Central network-config v1alpha1) ---------------
  //
  // Also an on-demand read/write path, not poller work: the editor asks for
  // this ONCE per drawer open (catalog) and once per reviewed Apply click
  // (applySsidProfile), never on the 60s timer.

  /**
   * Everything the SSID editor's catalog needs: live scope choices (sites,
   * site collections, AP device groups, individual APs) and live security
   * dependencies (roles, authentication server groups, captive portals).
   * Classic Central answers with every section unavailable — capabilities()
   * already says directWrite is false there, this is the second,
   * defense-in-depth statement of the same fact.
   *
   * Every section read is candidate-tolerant like pull()'s sections (see
   * catalogRows): a 404/error on one section marks THAT section unavailable
   * without failing the rest of the catalog, so a tenant missing e.g. AAA
   * profiles still offers sites/roles instead of an all-or-nothing failure.
   */
  async ssidCatalog(): Promise<SsidCatalog> {
    if (!isNewCentralGateway(this.baseUrl)) {
      return {
        scopes: [],
        roles: [],
        authServerGroups: [],
        captivePortalProfiles: [],
        unavailable: [...ALL_SSID_CATALOG_SECTIONS],
        source: 'Central Classic — direct SSID configuration writes require the New Central gateway',
      };
    }
    const [siteRows, collectionRows, groupRows, scopeRows, roleRows, serverGroupRows, portalRows] = await Promise.all([
      this.catalogRows(['/network-config/v1alpha1/sites']),
      this.catalogRows(['/network-config/v1alpha1/site-collections']),
      this.catalogRows(['/network-config/v1alpha1/device-groups']),
      this.catalogRows(['/cnxdevice/v1/debug/get_scope_data']),
      this.catalogRows(['/network-config/v1alpha1/roles']),
      this.catalogRows(['/network-config/v1alpha1/server-groups']),
      this.catalogRows(['/network-config/v1alpha1/captive-portal']),
    ]);
    const unavailable: SsidCatalogSection[] = [];
    const scopes: SsidScopeOption[] = [
      ...sectionScopeOptions(siteRows, 'site', unavailable, 'sites'),
      ...sectionScopeOptions(collectionRows, 'site-collection', unavailable, 'site-collections'),
      ...sectionScopeOptions(groupRows, 'ap-group', unavailable, 'ap-groups'),
      ...(scopeRows === null ? (unavailable.push('aps'), []) : apScopeOptionsFrom(scopeRows)),
    ];
    const roles = roleRows === null ? (unavailable.push('roles'), []) : dependencyOptionsFrom(roleRows);
    const authServerGroups =
      serverGroupRows === null
        ? (unavailable.push('authServerGroups'), [])
        : dependencyOptionsFrom(serverGroupRows);
    const captivePortalProfiles = portalRows === null ? (unavailable.push('captivePortalProfiles'), []) : dependencyOptionsFrom(portalRows);
    const total = ALL_SSID_CATALOG_SECTIONS.length;
    return {
      scopes,
      roles,
      authServerGroups,
      captivePortalProfiles,
      unavailable,
      source: `Central /network-config/v1alpha1 · ${total - unavailable.length}/${total} sections`,
    };
  }

  /**
   * Direct New Central SSID apply — idempotent upsert + configuration assignment.
   * A successfully created/updated profile is NEVER rolled back just because
   * a later assignment fails (architecture rule): `ok` requires BOTH the
   * profile step and every assignment to succeed; a profile success with any
   * assignment trouble is reported `partial`, never `ok`.
   *
   * Sequence:
   *   1. GET the named profile.
   *   2. absent  → POST to the named profile path ('created');
   *      present → a security-mode transition leaving a stale
   *                auth-server-group/captive-portal(-type)/personal-security
   *                field behind → PUT a full replacement built from the
   *                current profile (see buildWlanReplacementPayload) so the
   *                obsolete field is authoritatively cleared;
   *                otherwise PATCH only when the written fields actually
   *                differ ('updated'), else 'unchanged' — no write for no
   *                change.
   *   3. verify with a fresh GET, confirming both the requested fields AND
   *      the absence of any stale mode field; a write this adapter cannot
   *      confirm is reported unverified, never claimed successful.
   *   4. only once the profile step is ok: read existing CAMPUS_AP config
   *      assignments for this profile and POST only the ones missing.
   */
  async applySsidProfile(form: SsidForm): Promise<SsidApplyResult> {
    const name = form.name.trim();
    if (!isNewCentralGateway(this.baseUrl)) {
      return {
        ok: false,
        partial: false,
        profile: {
          ok: false,
          action: 'failed',
          verified: false,
          message: 'Central Classic is not writable via this path — direct SSID writes require the New Central gateway',
        },
        assignments: [],
      };
    }
    if (!name) {
      return {
        ok: false,
        partial: false,
        profile: { ok: false, action: 'failed', verified: false, message: 'SSID name is required' },
        assignments: [],
      };
    }

    const path = `/network-config/v1alpha1/wlan-ssids/${encodeURIComponent(name)}`;
    const desired = buildWlanSsidPayload(form);
    const requestedPassphrase =
      (form.security === 'wpa2-psk' || form.security === 'psk-portal') &&
      typeof form.passphrase === 'string';
    const getRes = await this.request('GET', path);
    let action: SsidProfileStepResult['action'];
    let profileOk: boolean;
    let httpCode: number | undefined = getRes.status;
    let message: string;
    if (getRes.status === 404) {
      // The item PUT operation is the documented create-or-replace path.
      // Collection POST uses a different wrapped schema and must not be sent
      // to this item URL.
      const putRes = await this.request('PUT', path, desired);
      httpCode = putRes.status;
      profileOk = putRes.status >= 200 && putRes.status < 300;
      action = profileOk ? 'created' : 'failed';
      message = profileOk ? `profile created — HTTP ${putRes.status}` : `profile create failed — HTTP ${putRes.status}`;
    } else if (getRes.status >= 200 && getRes.status < 300) {
      const staleFields = staleManagedModeFields(getRes.body, desired);
      if (!requestedPassphrase && staleFields.length === 0 && !wlanProfileChanged(getRes.body, desired)) {
        action = 'unchanged';
        profileOk = true;
        message = 'profile already matches the desired configuration — no write needed';
      } else if (staleFields.length > 0) {
        // A security-mode transition (e.g. portal → PSK, enterprise → open):
        // PATCH only ever touches fields present in the body, so the
        // previous mode's field(s) — auth-server-group, captive-portal(-type),
        // personal-security — would otherwise survive untouched. PUT is the
        // documented full-object replace, so a body built from the current
        // profile with this write's fields applied and the stale field(s)
        // deleted is the authoritative way to clear them without guessing at
        // unconfirmed null-clears-a-field enum semantics.
        const replacement = buildWlanReplacementPayload(getRes.body, desired);
        const putRes = await this.request('PUT', path, replacement);
        httpCode = putRes.status;
        profileOk = putRes.status >= 200 && putRes.status < 300;
        action = profileOk ? 'updated' : 'failed';
        message = profileOk
          ? `profile replaced — HTTP ${putRes.status} (cleared obsolete ${staleFields.join(', ')} from the previous security mode)`
          : `profile replace failed — HTTP ${putRes.status}`;
      } else {
        const patchRes = await this.request('PATCH', path, desired);
        httpCode = patchRes.status;
        profileOk = patchRes.status >= 200 && patchRes.status < 300;
        action = profileOk ? 'updated' : 'failed';
        message = profileOk ? `profile updated — HTTP ${patchRes.status}` : `profile update failed — HTTP ${patchRes.status}`;
      }
    } else {
      action = 'failed';
      profileOk = false;
      message = `could not read the existing profile — HTTP ${getRes.status}`;
    }

    let verified = false;
    if (profileOk) {
      const verifyRes = await this.request('GET', path);
      const readBack = verifyRes.status >= 200 && verifyRes.status < 300 ? verifyRes.body : undefined;
      const matches = readBack !== undefined && !wlanProfileChanged(readBack, readableWlanPayload(desired));
      // Verification is not just "does the read-back contain what we asked
      // for" — a stale auth-server-group/captive-portal(-type)/personal-security
      // field left over from a prior security mode must be confirmed absent
      // too, or a still-present obsolete field would silently pass review.
      const remainingStale = readBack !== undefined ? staleManagedModeFields(readBack, desired) : [];
      verified = matches && remainingStale.length === 0;
      if (!verified) {
        profileOk = false;
        if (readBack === undefined) {
          message = `${message}; verification read-back failed — HTTP ${verifyRes.status}`;
        } else if (!matches) {
          message = `${message}; verification read-back did not match the requested profile`;
        } else {
          message = `${message}; verification read-back still had obsolete ${remainingStale.join(', ')} field(s) from the previous security mode`;
        }
      }
    }

    const profile: SsidProfileStepResult = {
      ok: profileOk,
      action,
      verified,
      message,
      ...(httpCode !== undefined ? { httpCode } : {}),
    };

    const scopeIds = form.scopeIds ?? [];
    const assignments: SsidScopeAssignmentResult[] = [];
    if (profileOk) {
      const existing = await this.existingScopeAssignments(name);
      // A failed read does not change what we attempt, only what we can claim
      // about it afterwards. Every message below carries the caveat so the
      // operator can tell "assigned" from "re-assigned, possibly needlessly"
      // and, more importantly, a real failure from a duplicate conflict.
      const unchecked = existing === null;
      const caveat = unchecked
        ? '; the existing-assignment check could not be read first, so this may duplicate one already in place'
        : '';
      for (const scopeId of scopeIds) {
        if (existing?.has(scopeId)) {
          assignments.push({ scopeId, label: scopeId, ok: true, skipped: true, message: 'already assigned — no write needed' });
          continue;
        }
        const res = await this.request('POST', '/network-config/v1alpha1/config-assignments', {
          'config-assignment': [
            {
              'scope-id': scopeId,
              'device-function': 'CAMPUS_AP',
              'profile-type': 'wlan-ssids',
              'profile-instance': name,
            },
          ],
        });
        const ok = res.status >= 200 && res.status < 300;
        assignments.push({
          scopeId,
          label: scopeId,
          ok,
          httpCode: res.status,
          message: ok
            ? `assignment accepted — HTTP ${res.status}${caveat}`
            : `assignment failed — HTTP ${res.status}${caveat}`,
        });
      }
      await this.confirmScopeAssignments(name, assignments);
    }

    const allAssigned = scopeIds.length > 0 && assignments.every((a) => a.ok);
    const ok = profileOk && allAssigned;
    return { ok, partial: profileOk && !ok, profile, assignments };
  }

  /**
   * Best-effort catalog GET: try each candidate path in order, tolerating a
   * 404 by trying the next one — same tolerance pull()'s sections use. Any
   * OTHER non-2xx or a transport error stops trying further candidates for
   * an endpoint this build has not verified against a live tenant, and
   * reports "could not read" (null) rather than guessing at more paths.
   */
  private async catalogRows(candidates: string[]): Promise<unknown[] | null> {
    for (const path of candidates) {
      try {
        const res = await this.request('GET', path);
        if (res.status >= 200 && res.status < 300) return rowsFromResponse(res);
        if (res.status === 404) continue;
        return null;
      } catch {
        return null;
      }
    }
    return null;
  }

  /**
   * Existing CAMPUS_AP configuration assignments for one profile — makes
   * assignment idempotent (only POST what is missing).
   *
   * Answers null when the read could not be made, rather than an empty set.
   * The two are opposite facts: an empty set means "nothing is assigned yet",
   * a null means "we do not know what is assigned". Both lead to the same
   * *action* — attempt every requested scope, which is never worse than
   * assigning it — but they must not lead to the same *report*. A POST that
   * then fails because the assignment already existed would otherwise reach
   * the operator as a plain assignment failure, telling them a write did not
   * land when the desired state was in fact already correct.
   */
  /**
   * Re-read the assignment list and say, per assignment we actually wrote,
   * whether it is there.
   *
   * The profile half of this apply has always verified itself by reading the
   * object back and refusing to claim success when the read-back disagreed.
   * The assignment half did not, even though the reader it needs is the same
   * one called moments earlier to skip duplicates — so a POST answered 202
   * (or a 200 Central did not honour) was reported as `assigned`, and an SSID
   * that is not actually broadcasting at a site looked like a finished
   * rollout.
   *
   * A read that fails leaves `verified` undefined rather than false: an
   * assignment list we could not fetch is not an empty one, and downgrading a
   * write we simply did not look at would trade one wrong claim for another.
   */
  private async confirmScopeAssignments(
    resource: string,
    assignments: SsidScopeAssignmentResult[],
  ): Promise<void> {
    const written = assignments.filter((a) => a.ok && !a.skipped);
    if (written.length === 0) return;
    const after = await this.existingScopeAssignments(resource);
    if (after === null) {
      for (const a of written) {
        a.message = `${a.message}; could not re-read the assignment list to confirm it landed`;
      }
      return;
    }
    for (const a of written) {
      a.verified = after.has(a.scopeId);
      if (a.verified) {
        a.message = `${a.message} — confirmed present on re-read`;
      } else {
        a.ok = false;
        a.message =
          `${a.message}, but the assignment is absent when the list is read back. ` +
          `Central may still be applying it; do not treat this SSID as live at this scope until it appears.`;
      }
    }
  }

  private async existingScopeAssignments(resource: string): Promise<Set<string> | null> {
    try {
      const res = await this.request('GET', '/network-config/v1alpha1/config-assignments');
      if (res.status < 200 || res.status >= 300) return null;
      const rows = rowsFromResponse(res);
      if (rows === null) return null;
      const out = new Set<string>();
      for (const raw of rows) {
        if (!raw || typeof raw !== 'object') continue;
        const r = raw as Record<string, unknown>;
        const scopeId = str(r['scope-id'] ?? r.scopeId);
        if (
          scopeId &&
          str(r['device-function'] ?? r.deviceFunction) === 'CAMPUS_AP' &&
          str(r['profile-type'] ?? r.profileType) === 'wlan-ssids' &&
          str(r['profile-instance'] ?? r.profileInstance) === resource
        ) {
          out.add(scopeId);
        }
      }
      return out;
    } catch {
      return null;
    }
  }

  async pull(): Promise<PlanePull> {
    const missing: SectionKey[] = [];
    const truncated: SectionKey[] = [];

    // New Central's unified inventory includes claimed/unprovisioned hardware.
    // Classic tenants fall back to the split AP/switch/gateway monitoring APIs.
    let inventoryRows: unknown[] | null = null;
    try {
      const inventory = await this.fetchSection('deviceInventory');
      inventoryRows = inventory.rows;
      if (inventory.truncated) truncated.push('deviceInventory');
    } catch (err) {
      if (!(err instanceof SectionMissingError)) {
        throw new Error(`central pull: section 'devices' failed — ${(err as Error).message}`);
      }
    }

    let deviceParts: [unknown[], unknown[], unknown[]] = [[], [], []];
    if (inventoryRows === null) {
      const [legacyAps, legacySwitches, legacyGateways] = await Promise.all(
        (['aps', 'switches', 'gateways'] as const).map(async (key) => {
          try {
            const section = await this.fetchSection(key);
            if (section.truncated) truncated.push(key);
            return section.rows;
          } catch (err) {
            if (err instanceof SectionMissingError) {
              missing.push(key);
              return [] as unknown[];
            }
            throw new Error(`central pull: section 'devices/${key}' failed — ${(err as Error).message}`);
          }
        }),
      );
      deviceParts = [legacyAps, legacySwitches, legacyGateways];
      const deviceSections: SectionKey[] = ['aps', 'switches', 'gateways'];
      if (deviceSections.every((s) => missing.includes(s))) {
        throw new Error("central pull: section 'devices' failed — no inventory endpoint answered (404 on every candidate)");
      }
    }
    const [apRows, switchRows, gatewayRows] = deviceParts;

    const readConfig = isNewCentralGateway(this.baseUrl);
    const [siteRows, clientRows, notificationRows, ssidRows] = await Promise.all([
      this.optionalSection('sites', missing, truncated),
      this.optionalSection('clients', missing, truncated),
      this.optionalSection('notifications', missing, truncated),
      readConfig ? this.optionalSection('ssids', missing, truncated) : Promise.resolve([]),
    ]);

    const devices =
      inventoryRows === null
        ? [
            ...apRows.map((r) => mapCentralDevice(r, 'ap', this.approved)),
            ...switchRows.map((r) => mapCentralDevice(r, 'switch', this.approved)),
            ...gatewayRows.map((r) => mapCentralDevice(r, 'gateway', this.approved)),
          ].filter((d): d is CentralDeviceRow => d !== null)
        : inventoryRows
            .map((r) => mapCentralInventoryDevice(r, this.approved))
            .filter((d): d is CentralDeviceRow => d !== null);
    // The site object has no per-site sync time, so the honest stamp is the
    // plane's own: when this adapter last completed a read. lastSync is written
    // by the poller AFTER pull() resolves, so cycle 1 legitimately says '—' and
    // every later cycle reports the previous successful read — which is exactly
    // what a relative "Last sync" means. NOT .map(mapCentralSite): map passes
    // the index as the 2nd arg, which mapCentralSite reads as `sync`.
    const lastSyncMs = this.stateRef.lastSync !== null ? Date.parse(this.stateRef.lastSync) : Number.NaN;
    const syncStamp = Number.isNaN(lastSyncMs) ? '—' : ageString(lastSyncMs);
    const sites = siteRows.map((r) => mapCentralSite(r, syncStamp)).filter((s): s is SiteRow => s !== null);
    // NOT .map(mapCentralClient): map passes the index as the 2nd arg, which
    // mapCentralClient reads as nowMs — same leak that zeroed alert ages below.
    const clients = clientRows.map((r) => mapCentralClient(r)).filter((c): c is ClientRow => c !== null);
    // siteIdForName() mints an opaque 'ext-<slug>' from the NAME and drops the
    // plane's own site id, but the topology endpoint is keyed by that id — so
    // keep the join here, off the raw rows, while both halves are still in hand.
    this.rememberNativeSiteIds(siteRows, ['siteId', 'site_id', 'scopeId', 'id']);
    this.rememberNativeSiteIds(clientRows, ['siteId', 'site_id']);
    // NOT .map(mapCentralNotification): map passes the index as the 2nd arg,
    // which mapCentralNotification reads as nowMs — every age became '0s'.
    const alerts = notificationRows.map((r) => mapCentralNotification(r)).filter((a): a is AlertRow => a !== null);
    const ssids = ssidRows.map((r) => mapCentralSsid(r)).filter((ssid): ssid is SsidObject => ssid !== null);
    const config: ConfigInventory | undefined =
      readConfig && !missing.includes('ssids')
        ? {
            mode: 'configured',
            ssids,
            source: 'Central /network-config/v1/wlan-ssids',
            unavailable: ['vlans', 'ports'],
          }
        : undefined;

    // A count is an assertion of fact, so only sections we actually read get
    // one — "0 clients" for a section that 404'd would be a lie.
    const summary = [countOf(devices.length, 'device')];
    if (!missing.includes('sites')) summary.push(countOf(sites.length, 'site'));
    if (!missing.includes('clients')) summary.push(countOf(clients.length, 'client'));
    if (config) summary.push(countOf(ssids.length, 'SSID'));
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

    // Missing sections are OMITTED, not emptied: downstream datasetReported()
    // /lastSyncFor() must read them as unknown rather than as an authoritative
    // zero with a fresh sync stamp. `devices` always ships — an all-404
    // inventory already threw above, so a partial merge is a real read.
    const partial = partialDatasets(missing, truncated);
    return {
      devices,
      ...(missing.includes('sites') ? {} : { sites }),
      ...(missing.includes('clients') ? {} : { clients }),
      ...(missing.includes('notifications') ? {} : { alerts }),
      ...(config ? { config } : {}),
      ...(partial.length > 0 ? { partial } : {}),
    };
  }

  // -- detail-read internals -------------------------------------------------

  /**
   * TTL cache + single-flight around one detail read.
   *
   * A cache HIT re-stamps `source.cached = true` so the screen can say the
   * numbers are up to 45s old rather than implying a fresh call. Expired
   * entries are swept on access, and the map is capped so a long-lived process
   * that opens hundreds of drawers cannot grow it without bound.
   *
   * A FAILED read is cached too — deliberately. Without that, a drawer that
   * re-renders on every keystroke turns one broken endpoint into a call storm
   * against the exact tenant that is already unhappy.
   */
  private async cachedDetail<T>(key: string, load: () => Promise<T>): Promise<T> {
    const nowMs = this.now();
    const hit = this.detailCache.get(key);
    if (hit && hit.expiresAtMs > nowMs) {
      const value = hit.value as T & { source: DetailSource<string> };
      return { ...value, source: { ...value.source, cached: true } } as T;
    }
    const inflight = this.detailInflight.get(key);
    if (inflight) return inflight as Promise<T>;
    const promise = load()
      .then((value) => {
        this.detailCache.set(key, { expiresAtMs: this.now() + DETAIL_TTL_MS, value });
        this.sweepDetailCache();
        return value;
      })
      .finally(() => {
        this.detailInflight.delete(key);
      });
    this.detailInflight.set(key, promise as Promise<unknown>);
    return promise;
  }

  private sweepDetailCache(): void {
    const nowMs = this.now();
    for (const [k, v] of this.detailCache) {
      if (v.expiresAtMs <= nowMs) this.detailCache.delete(k);
    }
    // Insertion order = oldest first, so dropping from the front evicts the
    // least recently stored entry.
    while (this.detailCache.size > DETAIL_CACHE_MAX) {
      const oldest = this.detailCache.keys().next();
      if (oldest.done) break;
      this.detailCache.delete(oldest.value);
    }
  }

  /**
   * One detail GET. Same bearer handling as authedGet (one invalidate + retry
   * on 401) but DELIBERATELY without its 429 backoff and network retry: those
   * exist so a poll cycle survives, and on a drawer's request path they would
   * only turn a rate limit into a 30-second stall. Never throws — a transport
   * failure comes back as `ok:false` with a short, secret-free reason.
   */
  private async detailGet(
    path: string,
  ): Promise<{ ok: true; body: unknown; bodyParse: CentralHttpBodyParse } | { ok: false; note: string }> {
    try {
      let res = await this.http('GET', path, { token: await this.tokens.get(), timeoutMs: DETAIL_TIMEOUT_MS });
      if (res.status === 401) {
        this.tokens.invalidate();
        res = await this.http('GET', path, { token: await this.tokens.get(), timeoutMs: DETAIL_TIMEOUT_MS });
      }
      if (res.status < 200 || res.status >= 300) return { ok: false, note: `HTTP ${res.status}` };
      return { ok: true, body: res.body, bodyParse: res.bodyParse };
    } catch (err) {
      // http() prefixes the label; keep only the cause so the note stays a
      // sentence a human reads, and never a URL or a credential.
      const raw = (err as Error).message;
      return { ok: false, note: raw.slice(raw.indexOf('failed: ') + 8) || 'request failed' };
    }
  }

  private async readClientDetail(mac: string, medium?: ClientRow['medium']): Promise<ClientDetailLive> {
    const startedMs = this.now();
    const startAt = new Date(startedMs - MOBILITY_WINDOW_SEC * 1000).toISOString();
    const seg = encodeURIComponent(mac);
    // `end-at` is deliberately OMITTED — it defaults to Central's own current
    // timestamp. Sending our clock's "now" 400s the endpoint whenever the two
    // disagree by even a few minutes (verified live).
    const [trail, usage] = await Promise.all([
      medium === 'wired'
        ? Promise.resolve(null)
        : this.detailGet(
            `/network-monitoring/v1/clients/${seg}/mobility-trail?limit=${MOBILITY_PAGE_LIMIT}&start-at=${encodeURIComponent(startAt)}`,
          ),
      this.detailGet(
        `/network-monitoring/v1/clients-usage?filter=${encodeURIComponent(`macAddress eq '${mac}'`)}`,
      ),
    ]);

    const sections: Partial<Record<ClientDetailSection, DetailFetchState>> = {};
    const notes: string[] = [];
    const out: ClientDetailLive = { mac, source: { plane: 'central', at: '', sections } };

    const trailRead = trail === null ? null : detailRows(trail);
    if (trailRead === null) {
      // Ethernet clients have no mobility trail, RSSI, or roam count. Leave
      // those sections not-fetched rather than spending a call or presenting
      // an empty wireless result as a wired-client statistic.
    } else if ('note' in trailRead) {
      // Reached by an unreadable 200 as well as a transport failure. `roams`
      // is published as 'ok' below whatever the number is, so a body we could
      // not read would otherwise have become a confident "0 roams".
      sections.rssi = 'failed';
      sections.roams = 'failed';
      sections.timeline = 'failed';
      notes.push(`mobility trail: ${trailRead.note}`);
    } else {
      const rows = trailRead.rows;
      const events = rows
        .map((r) => mapMobilityEvent(r))
        .filter((e): e is ClientTimelineEvent => e !== null);
      // `total` is the roam count for the whole window; one page of 100 is
      // enough to RENDER the newest events without paying to walk the cursor
      // just to count them.
      const total = extractTotal(trailRead.body);
      // A page limit is not a window total. When Central states a `total` the
      // count is exact whatever the page held; when it does not, all the
      // portal counted is one page, and a FULL page is the evidence that
      // there was more behind it. A SHORT page is the whole answer and is not
      // qualified — the same discipline the JSONL readers use, where
      // truncation is only claimed once something past the limit is seen.
      const pageFull = rows.length >= MOBILITY_PAGE_LIMIT;
      out.timeline = events;
      out.roams = total ?? events.length;
      out.roamsAtLeast = total === null && pageFull;
      // The list is capped by the same page the count came from, and is capped
      // INDEPENDENTLY of it: a stated total of 340 makes `roams` exact and
      // still leaves 240 events unfetched. Rows that arrived but would not map
      // are missing from the list too, which is why the stated total is
      // compared against the mapped length rather than the raw one.
      out.timelineTruncated = total !== null ? total > events.length : pageFull;
      out.roamsWindowSec = MOBILITY_WINDOW_SEC;
      // 0 roams is a REAL answer for a stationary client, so `roams` is 'ok'
      // while the (genuinely empty) event list is 'empty'.
      sections.roams = 'ok';
      sections.timeline = events.length > 0 ? 'ok' : 'empty';
      const signal = events.find((e) => typeof e.rssiDbm === 'number');
      out.rssi = signal?.rssiDbm ?? null;
      sections.rssi = out.rssi === null ? 'empty' : 'ok';
    }

    if (!usage.ok) {
      sections.tput = 'failed';
      sections.usageSeries = 'failed';
      notes.push(`usage: ${usage.note}`);
    } else {
      const samples = mapUsageSamples(usage.body);
      const intervalSec = parseUsageIntervalSec(
        usage.body && typeof usage.body === 'object' ? str((usage.body as Record<string, unknown>).interval) : null,
      );
      out.usageSeries = samples;
      sections.usageSeries = samples.length > 0 ? 'ok' : 'empty';
      if (samples.length > 0 && intervalSec !== null) {
        const bytes = samples.reduce((sum, s) => sum + (s.txBytes ?? 0) + (s.rxBytes ?? 0), 0);
        const windowSec = samples.length * intervalSec;
        // Central reports usage TOTALS per bucket, never an instantaneous
        // rate, so this is an AVERAGE — tputWindowSec is what the renderer
        // must label it with ("avg over 3h"), never "current rate".
        out.tput = (bytes * 8) / windowSec;
        out.tputWindowSec = windowSec;
        sections.tput = 'ok';
      } else {
        out.tput = null;
        sections.tput = 'empty';
      }
    }

    out.source.at = new Date(this.now()).toISOString();
    out.source.cached = false;
    out.source.note = notes.length > 0 ? notes.join('; ') : null;
    return out;
  }

  private async readDeviceDetail(serial: string, kind: DeviceDetailKind): Promise<DeviceDetailLive> {
    const seg = encodeURIComponent(serial);
    const sections: Partial<Record<DeviceDetailSection, DetailFetchState>> = {};
    const notes: string[] = [];
    const out: DeviceDetailLive = { serial, kind, source: { plane: 'central', at: '', sections } };

    if (kind === 'ap') {
      const [radios, wlans] = await Promise.all([
        this.detailGet(`/network-monitoring/v1/aps/${seg}/radios`),
        this.detailGet(`/network-monitoring/v1/aps/${seg}/wlans`),
      ]);
      const radiosRead = detailRows(radios);
      if ('note' in radiosRead) {
        sections.radios = 'failed';
        notes.push(`radios: ${radiosRead.note}`);
      } else {
        const rows = radiosRead.rows
          .map((r, i) => mapCentralRadio(r, i))
          .filter((r): r is DeviceRadio => r !== null)
          // Central hands them back unordered (1, 0, 2 live); radio 0 first is
          // what an operator expects to read.
          .sort((a, b) => a.number - b.number);
        out.radios = rows;
        sections.radios = rows.length > 0 ? 'ok' : 'empty';
      }
      const wlansRead = detailRows(wlans);
      if ('note' in wlansRead) {
        sections.wlans = 'failed';
        notes.push(`wlans: ${wlansRead.note}`);
      } else {
        const rows = wlansRead.rows
          .map((r) => mapCentralWlan(r))
          .filter((w): w is DeviceWlan => w !== null);
        out.wlans = rows;
        sections.wlans = rows.length > 0 ? 'ok' : 'empty';
      }
    } else {
      // Switches page on offset/limit but "fetch all by default" (verified: 28
      // of 28 interfaces in one unparameterized response), and the gateway
      // ports list is short by construction — so neither is walked. Sending no
      // paging params is both the cheapest and the most complete read.
      const path =
        kind === 'switch'
          ? `/network-monitoring/v1/switches/${seg}/interfaces`
          : `/network-monitoring/v1/gateways/${seg}/ports`;
      const ports = await this.detailGet(path);
      const portsRead = detailRows(ports);
      if ('note' in portsRead) {
        sections.ports = 'failed';
        notes.push(`ports: ${portsRead.note}`);
      } else {
        const map = kind === 'switch' ? mapCentralSwitchPort : mapCentralGatewayPort;
        const rows = portsRead.rows
          .map((r) => map(r))
          .filter((p): p is DevicePort => p !== null);
        out.ports = rows;
        sections.ports = rows.length > 0 ? 'ok' : 'empty';
      }
    }

    out.source.at = new Date(this.now()).toISOString();
    out.source.cached = false;
    out.source.note = notes.length > 0 ? notes.join('; ') : null;
    return out;
  }

  /**
   * Central's own site id, keyed by the portal SiteId this adapter mints.
   * Populated from raw rows during pull(); the topology endpoint is keyed by
   * the plane's id ('79244870000394240'), never by the site NAME.
   */
  private readonly nativeSiteIds = new Map<string, string>();

  private rememberNativeSiteIds(rows: unknown[], idKeys: readonly string[]): void {
    for (const raw of rows) {
      if (!raw || typeof raw !== 'object') continue;
      const r = raw as Record<string, unknown>;
      const name = str(r.siteName ?? r.site_name ?? r.site ?? r.scopeName ?? r.collectionName ?? r.name);
      if (!name) continue;
      const native = idKeys.map((k) => str(r[k])).find((v) => v !== null && !/^ext-/.test(v));
      if (!native) continue;
      this.nativeSiteIds.set(siteIdForName(name).siteId, native);
    }
  }

  private async readSiteTopology(siteId: string): Promise<SiteTopologyLive> {
    // The endpoint is keyed by the PLANE's site id. Callers reach here with
    // either the portal's 'ext-<slug>' id or the plane's display name (the
    // route falls back to site.name), so resolve both spellings before giving
    // up — passing a name straight through is what made this a silent 404.
    const native =
      this.nativeSiteIds.get(siteId) ?? this.nativeSiteIds.get(siteIdForName(siteId).siteId) ?? siteId;
    const res = await this.detailGet(`/network-monitoring/v1/topology/${encodeURIComponent(native)}`);
    const sections: Partial<Record<SiteTopologySection, DetailFetchState>> = {};
    const out: SiteTopologyLive = { siteId, source: { plane: 'central', at: '', sections } };
    const topologyBody = res.ok ? readableObjectBody(res) : null;
    if (!res.ok) {
      sections.nodes = 'failed';
      sections.links = 'failed';
      out.source.note = `topology: ${res.note}`;
    } else if (topologyBody === null) {
      sections.nodes = 'failed';
      sections.links = 'failed';
      out.source.note = 'topology: a 200 whose body carried no readable topology';
    } else {
      // Read `devices`/`links` BY NAME, not through extractRows' first-array
      // heuristic: this payload has two sibling arrays and the heuristic would
      // pick whichever the tenant happens to serialize first.
      const body = topologyBody;
      const nodes = (Array.isArray(body.devices) ? body.devices : [])
        .map((d) => mapTopologyNode(d))
        .filter((n): n is TopologyDeviceNode => n !== null);
      const links = (Array.isArray(body.links) ? body.links : [])
        .map((l) => mapTopologyLink(l))
        .filter((l): l is TopologyLink => l !== null);
      out.nodes = nodes;
      out.links = links;
      out.isolatedDevicesCount = num(body.isolatedDevicesCount);
      out.isolatedHealth = str(body.isolatedHealth);
      sections.nodes = nodes.length > 0 ? 'ok' : 'empty';
      sections.links = links.length > 0 ? 'ok' : 'empty';
      out.source.note = null;
    }
    out.source.at = new Date(this.now()).toISOString();
    out.source.cached = false;
    return out;
  }

  /**
   * The applications endpoint is keyed by the PLANE's site id, exactly like
   * topology — resolve the native id remembered during pull() before falling
   * back to what the caller passed.
   */
  private async readSiteApplications(siteId: string, window: TrendWindow): Promise<SiteApplicationsLive> {
    const native =
      this.nativeSiteIds.get(siteId) ?? this.nativeSiteIds.get(siteIdForName(siteId).siteId) ?? siteId;
    const sections: Partial<Record<SiteAppsSection, DetailFetchState>> = {};
    const out: SiteApplicationsLive = {
      siteId,
      window: { start: window?.start ?? '', end: window?.end ?? '' },
      source: { plane: 'central', at: '', sections },
    };

    const w = normalizeTrendWindow(window?.start, window?.end);
    if (!w.ok) {
      // Refused BEFORE spending a call: sections stay 'not-fetched' (we chose
      // not to ask) and the note says why — a caller mistake, not a plane
      // failure.
      out.source.note = `applications: ${w.error}`;
      out.source.at = new Date(this.now()).toISOString();
      out.source.cached = false;
      return out;
    }
    out.window = w.window;

    // Paged walk (limit=200&offset). A page-1 failure fails the section; a
    // mid-walk failure or a short-of-total finish keeps the rows already
    // read and marks the table truncated — a prefix of the ranking, never
    // presented as the whole of it.
    const rows: unknown[] = [];
    let truncated = false;
    let failed: string | null = null;
    let offset = 0;
    let statedTotal: number | null = null;
    for (let page = 0; page < APPLICATIONS_MAX_PAGES; page += 1) {
      const res = await this.detailGet(
        `/network-monitoring/v1/applications?site_id=${encodeURIComponent(native)}` +
          `&start=${encodeURIComponent(w.window.start)}&end=${encodeURIComponent(w.window.end)}` +
          `&limit=${APPLICATIONS_PAGE_LIMIT}&offset=${offset}`,
      );
      const pageRows = res.ok ? rowsFromResponse(res) : null;
      if (!res.ok || pageRows === null) {
        const note = res.ok ? 'a 200 whose body carried no readable rows' : res.note;
        if (page === 0) failed = note;
        else truncated = true;
        break;
      }
      rows.push(...pageRows);
      statedTotal = extractTotal(res.body) ?? statedTotal;
      const lastPage = pageRows.length < APPLICATIONS_PAGE_LIMIT || (statedTotal !== null && rows.length >= statedTotal);
      if (lastPage) break;
      offset += pageRows.length;
      if (page === APPLICATIONS_MAX_PAGES - 1) truncated = true; // a full last page: more rows exist
    }
    // The endpoint stated a total it never handed over — same truncation
    // rule as the poller's section walks.
    if (failed === null && statedTotal !== null && rows.length < statedTotal) truncated = true;

    if (failed !== null) {
      sections.apps = 'failed';
      out.source.note = `applications: ${failed}`;
    } else {
      const apps = byBytesDesc(rows.map((r) => normalizeSiteApp(r)).filter((a): a is SiteAppRow => a !== null));
      out.apps = apps;
      sections.apps = apps.length > 0 ? 'ok' : 'empty';
      if (truncated) out.truncated = true;
      out.source.note = truncated
        ? 'applications: the paged walk did not finish — the table is a prefix of the full ranking'
        : null;
    }
    out.source.at = new Date(this.now()).toISOString();
    out.source.cached = false;
    return out;
  }

  private async readSwitchHardwareTrends(serial: string, window: TrendWindow): Promise<SwitchHardwareTrendsLive> {
    const sections: Partial<Record<HardwareTrendsSection, DetailFetchState>> = {};
    const out: SwitchHardwareTrendsLive = {
      serial,
      window: { start: window?.start ?? '', end: window?.end ?? '' },
      source: { plane: 'central', at: '', sections },
    };
    const w = normalizeTrendWindow(window?.start, window?.end);
    if (!w.ok) {
      out.source.note = `hardware-trends: ${w.error}`;
      out.source.at = new Date(this.now()).toISOString();
      out.source.cached = false;
      return out;
    }
    out.window = w.window;

    const res = await this.detailGet(`/network-monitoring/v1/switches/${encodeURIComponent(serial)}/hardware-trends`);
    const body = res.ok ? readableObjectBody(res) : null;
    const graph = body ? trendGraph(body, [[], ['response']]) : null;
    if (!res.ok) {
      sections.hardware = 'failed';
      out.source.note = `hardware-trends: ${res.note}`;
    } else if (graph === null) {
      sections.hardware = 'failed';
      out.source.note = 'hardware-trends: a 200 whose body carried no readable trend graph';
    } else {
      const set = normalizeTrendSet(graph.keys, graph.samples);
      out.trends = set;
      sections.hardware = set.ok ? 'ok' : 'empty';
      out.source.note = null;
    }
    out.source.at = new Date(this.now()).toISOString();
    out.source.cached = false;
    return out;
  }

  private async readApTrends(serial: string, metric: ApTrendMetric, window: TrendWindow): Promise<ApTrendsLive> {
    const sections: Partial<Record<ApTrendsSection, DetailFetchState>> = {};
    const out: ApTrendsLive = {
      serial,
      metric,
      window: { start: window?.start ?? '', end: window?.end ?? '' },
      source: { plane: 'central', at: '', sections },
    };
    const w = normalizeTrendWindow(window?.start, window?.end);
    if (!w.ok) {
      out.source.note = `${metric}-trends: ${w.error}`;
      out.source.at = new Date(this.now()).toISOString();
      out.source.cached = false;
      return out;
    }
    out.window = w.window;

    const res = await this.detailGet(
      `/network-monitoring/v1/aps/${encodeURIComponent(serial)}/${metric}-trends`,
    );
    const body = res.ok ? readableObjectBody(res) : null;
    const graph = body ? trendGraph(body, [['trends', 'graph'], ['trends'], ['graph'], []]) : null;
    if (!res.ok) {
      sections.trends = 'failed';
      out.source.note = `${metric}-trends: ${res.note}`;
    } else if (graph === null) {
      sections.trends = 'failed';
      out.source.note = `${metric}-trends: a 200 whose body carried no readable trend graph`;
    } else {
      const keyNames = (graph.keys as unknown[]).filter((k): k is string => typeof k === 'string');
      const set = normalizeTrendSet(graph.keys, graph.samples, apTrendSpecs(metric, keyNames));
      out.trends = set;
      sections.trends = set.ok ? 'ok' : 'empty';
      out.source.note = null;
    }
    out.source.at = new Date(this.now()).toISOString();
    out.source.cached = false;
    return out;
  }

  private async readSwitchInterfaceTrends(serial: string, window: TrendWindow): Promise<SwitchInterfaceTrendsLive> {
    const sections: Partial<Record<InterfaceTrendsSection, DetailFetchState>> = {};
    const out: SwitchInterfaceTrendsLive = {
      serial,
      window: { start: window?.start ?? '', end: window?.end ?? '' },
      source: { plane: 'central', at: '', sections },
    };
    const w = normalizeTrendWindow(window?.start, window?.end);
    if (!w.ok) {
      out.source.note = `interface-trends: ${w.error}`;
      out.source.at = new Date(this.now()).toISOString();
      out.source.cached = false;
      return out;
    }
    out.window = w.window;

    const res = await this.detailGet(`/network-monitoring/v1/switches/${encodeURIComponent(serial)}/interface-trends`);
    const body = res.ok ? readableObjectBody(res) : null;
    const graph = body ? trendGraph(body, [['response'], []]) : null;
    if (!res.ok) {
      sections.interfaces = 'failed';
      out.source.note = `interface-trends: ${res.note}`;
    } else if (graph === null) {
      sections.interfaces = 'failed';
      out.source.note = 'interface-trends: a 200 whose body carried no readable trend graph';
    } else {
      const keyNames = (graph.keys as unknown[]).filter((k): k is string => typeof k === 'string');
      const set = normalizeTrendSet(graph.keys, graph.samples, interfaceTrendSpecs(keyNames));
      out.trends = set;
      sections.interfaces = set.ok ? 'ok' : 'empty';
      out.source.note = null;
    }
    out.source.at = new Date(this.now()).toISOString();
    out.source.cached = false;
    return out;
  }

  // -- internals -------------------------------------------------------------

  /** Missing (all-404) → empty + note; anything else → throw naming the section. */
  private async optionalSection(
    section: SectionKey,
    missing: SectionKey[],
    truncated: SectionKey[],
  ): Promise<unknown[]> {
    try {
      const result = await this.fetchSection(section);
      if (result.truncated) truncated.push(section);
      return result.rows;
    } catch (err) {
      if (err instanceof SectionMissingError) {
        missing.push(section);
        return [];
      }
      throw new Error(`central pull: section '${section}' failed — ${(err as Error).message}`);
    }
  }

  /**
   * Page through one section, tolerating 404 by trying the next candidate
   * path. Returns the merged rows of every page plus whether the walk actually
   * finished — hitting the page cap, or being handed fewer rows than the
   * endpoint claims exist, is silent data loss unless it is reported.
   * Remembers the working path.
   */
  private async fetchSection(section: SectionKey): Promise<SectionResult> {
    const spec = SECTIONS[section];
    const resolved = this.resolvedPath.get(section);
    const candidates = resolved
      ? [resolved, ...spec.candidates.filter((c) => c.path !== resolved.path)]
      : spec.candidates;

    for (const cand of candidates) {
      // A cursor endpoint ignores `offset`, so sending it would only be noise
      // on the wire (and a stray param is fatal on the strict namespaces).
      const byCursor = cand.paging === 'cursor';
      const unpaged = cand.paging === 'none';
      const firstPath = unpaged
        ? `${cand.path}${cand.extraQuery ? `?${cand.extraQuery.replace(/^&/, '')}` : ''}`
        : byCursor
          ? `${cand.path}?limit=${spec.limit}${cand.extraQuery ?? ''}`
          : `${cand.path}?offset=0&limit=${spec.limit}${cand.extraQuery ?? ''}`;
      const first = await this.authedGet(firstPath, spec.timeoutMs);
      if (first.status === 404) continue; // release variance — try the alternate namespace
      if (first.status < 200 || first.status >= 300) throw new HttpStatusError(first.status, firstPath);

      const rows = rowsFromResponse(first);
      if (rows === null) throw new Error(`unreadable body from ${firstPath}`);
      const total = extractTotal(first.body);
      let cursor = byCursor ? extractNextCursor(first.body) : null;
      let offset = rows.length;
      let lastPageSize = rows.length;
      let page = 1;
      // Cursor walks end when the endpoint stops handing back a `next`; offset
      // walks end on the first short page (or once the stated total is covered).
      const hasMore = (): boolean =>
        unpaged ? false : byCursor ? cursor !== null : lastPageSize >= spec.limit && (total === null || offset < total);
      while (page < spec.maxPages && hasMore()) {
        // Pace the walk: the gateway is quota'd and a 10-page client pull
        // fired back-to-back is exactly what earns the 429.
        await this.sleep(PAGE_PACING_MS);
        const path = byCursor
          ? `${cand.path}?limit=${spec.limit}&next=${encodeURIComponent(cursor as string)}${cand.extraQuery ?? ''}`
          : `${cand.path}?offset=${offset}&limit=${spec.limit}${cand.extraQuery ?? ''}`;
        const res = await this.authedGet(path, spec.timeoutMs);
        // Page 1 worked, so the path is valid: a failure here fails the section.
        if (res.status < 200 || res.status >= 300) throw new HttpStatusError(res.status, path);
        const pageRows = rowsFromResponse(res);
        if (pageRows === null) throw new Error(`unreadable body from ${path} (page ${page + 1})`);
        if (pageRows.length === 0) break;
        rows.push(...pageRows);
        offset += pageRows.length;
        lastPageSize = pageRows.length;
        cursor = byCursor ? extractNextCursor(res.body) : null;
        page += 1;
      }
      this.resolvedPath.set(section, cand);
      // Incomplete either way: the page cap cut a still-unfinished walk short,
      // or the endpoint stated a total it never handed over.
      const cappedOut = page >= spec.maxPages && hasMore();
      const shortOfTotal = total !== null && rows.length < total;
      return { rows, truncated: cappedOut || shortOfTotal };
    }
    throw new SectionMissingError(section);
  }

  /**
   * GET with a bearer token; one invalidation + retry on 401, a bounded
   * backoff on 429 so a rate limit paces the poll instead of destroying the
   * whole cycle, and ONE retry on a transport failure (abort/DNS/reset) so a
   * single slow page does not discard the sections that already succeeded.
   * Retry-After (delta-seconds or HTTP-date) wins over the exponential floor;
   * every attempt is still recorded, so the Activity tab shows the real 429s
   * and the real network errors.
   */
  private async authedGet(path: string, timeoutMs?: number): Promise<CentralHttpResult> {
    const opts = timeoutMs !== undefined ? { timeoutMs } : {};
    let networkTries = 0;
    for (let attempt = 0; ; attempt += 1) {
      let res: CentralHttpResult;
      try {
        res = await this.http('GET', path, { ...opts, token: await this.tokens.get() });
        if (res.status === 401) {
          this.tokens.invalidate();
          res = await this.http('GET', path, { ...opts, token: await this.tokens.get() });
        }
      } catch (err) {
        // Transport-level, not a status: retry once, then let the section fail
        // honestly (the failed attempt is already in the call log).
        if (networkTries >= NETWORK_RETRIES) throw err;
        networkTries += 1;
        await this.sleep(NETWORK_RETRY_MS);
        continue;
      }
      if (res.status !== 429 || attempt >= RATE_LIMIT_RETRIES) return res;
      const backoffMs = RATE_LIMIT_BASE_MS * 2 ** attempt;
      await this.sleep(Math.min(res.retryAfterMs ?? backoffMs, RATE_LIMIT_CAP_MS));
    }
  }

  /**
   * Public auth'd request for the write broker (additive — pull() above is
   * untouched). Same bearer handling as authedGet, for GET read-backs and
   * PUT/POST brokered writes; one invalidation + retry on 401. The caller
   * interprets the status — a non-2xx is returned, never thrown.
   */
  async request(
    method: HttpMethod,
    path: string,
    body?: unknown,
  ): Promise<CentralHttpResult> {
    const opts = { token: await this.tokens.get(), ...(body !== undefined ? { body } : {}) };
    let res = await this.http(method, path, opts);
    if (res.status === 401) {
      this.tokens.invalidate();
      res = await this.http(method, path, { ...opts, token: await this.tokens.get() });
    }
    return res;
  }

  /**
   * Timed outbound call recorded in the plane's call log. The log carries
   * method + path + ms + status only — never a body, so never a secret.
   */
  private async http(
    method: HttpMethod,
    path: string,
    opts: { token?: string; body?: unknown; timeoutMs?: number } = {},
  ): Promise<CentralHttpResult> {
    return this.httpAbsolute(method, `${this.baseUrl}${path}`, opts);
  }

  /**
   * http() against a full URL — needed for the GreenLake SSO token endpoint,
   * which lives off-gateway. formEncoded switches the body to
   * application/x-www-form-urlencoded (PingFederate requires it; the gateway's
   * own /oauth2/token takes JSON). `timeoutMs` is additive and defaults to
   * OUTBOUND_TIMEOUT_MS, so the write broker / reboot / disconnect / ackAlert
   * callers are unaffected.
   */
  private async httpAbsolute(
    method: HttpMethod,
    url: string,
    opts: { token?: string; body?: unknown; formEncoded?: boolean; timeoutMs?: number } = {},
  ): Promise<CentralHttpResult> {
    const started = Date.now();
    const label = `${method} ${url.replace(/^https?:\/\/[^/]+/i, '') || '/'}`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method,
        headers: {
          accept: 'application/json',
          ...(opts.body !== undefined
            ? { 'content-type': opts.formEncoded ? 'application/x-www-form-urlencoded' : 'application/json' }
            : {}),
          ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
        },
        body:
          opts.body === undefined
            ? undefined
            : opts.formEncoded
              ? new URLSearchParams(opts.body as Record<string, string>).toString()
              : JSON.stringify(opts.body),
        signal: AbortSignal.timeout(opts.timeoutMs ?? OUTBOUND_TIMEOUT_MS),
      });
    } catch {
      this.recordCall({ path: label, ms: Date.now() - started, code: 'network-error' });
      throw new CentralRequestError('transport', `${label} transport failed`);
    }
    this.recordCall({ path: label, ms: Date.now() - started, code: String(res.status) });
    let body: unknown = null;
    let bodyParse: CentralHttpBodyParse;
    try {
      const rawBody = await res.text();
      const trimmedBody = rawBody.trim();
      if (rawBody.length === 0) {
        bodyParse = 'empty';
      } else if (trimmedBody.length === 0) {
        bodyParse = 'whitespace';
      } else {
        try {
          body = JSON.parse(trimmedBody) as unknown;
          bodyParse = body === null ? 'json-null' : 'json';
        } catch {
          const contentType = (res.headers.get('content-type') ?? '').split(';', 1)[0].trim().toLowerCase();
          bodyParse =
            contentType === 'application/json' || contentType.endsWith('+json')
              ? 'malformed-json'
              : 'non-json';
        }
      }
    } catch {
      // Preserve the old shared-helper behavior (status plus a null body)
      // while making the failed body read distinguishable to strict callers.
      bodyParse = 'unreadable';
    }
    // Additive field: existing callers ({ status, body }) are unaffected.
    const retryAfterMs = parseRetryAfterMs(res.headers.get('retry-after'), this.now());
    const rateLimitResetAtMs = parseRateLimitResetAtMs(
      res.headers.get('x-ratelimit-reset') ?? res.headers.get('ratelimit-reset'),
      this.now(),
    );
    const locationHeader = res.headers.get('location')?.trim();
    return {
      status: res.status,
      body,
      bodyParse,
      ...(locationHeader ? { location: locationHeader } : {}),
      ...(retryAfterMs !== null ? { retryAfterMs } : {}),
      ...(rateLimitResetAtMs !== null ? { rateLimitResetAtMs } : {}),
    };
  }
}
