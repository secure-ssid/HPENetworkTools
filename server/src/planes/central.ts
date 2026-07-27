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
 *   clients        /monitoring/v1/clients, /network-monitoring/v1alpha1/clients              offset/limit 500
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
  siteDisplayName,
  siteIdFor,
  type AlertRow,
  type ClientRow,
  type ClientType,
  type DeviceRow,
  type PlaneDatasetKey,
  type Sev,
  type SiteId,
  type SiteRow,
  type Tone,
} from '../../../shared';
import type { PlaneCredentials } from '../config/settings';
import type { DeviceIdentityHints } from '../services/reconcile';
import type { PlaneAdapter, PlaneCapabilities, PlanePull, PlaneState, PlaneTokenInfo } from './types';

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

export type RecordCallFn = (call: { path: string; ms: number; code: string }) => void;
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;
export type SleepFn = (ms: number) => Promise<void>;

const realSleep: SleepFn = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export type CentralDeviceRow = DeviceRow & DeviceIdentityHints;

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

// ---------------------------------------------------------------------------
// Site identity
// ---------------------------------------------------------------------------

/**
 * LOCAL GAP (do not fix in shared/): shared SiteId is a closed union over the
 * fixture sites, so it cannot name a site only a real plane knows about. We
 * mint 'ext-<slug>' ids locally and cast. Consumers must treat SiteId as an
 * opaque string; these ids never collide with the canonical ones.
 */
export function externalSiteId(name: string): SiteId {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return `ext-${slug || 'unknown'}` as SiteId;
}

/**
 * Resolve a plane-reported site name to the canonical site join. Known
 * aliases get the canonical id + authored display name; unknown names keep
 * the plane's own display string under a generated 'ext-*' id; absent names
 * land on the 'multiple' pseudo-site (its documented purpose).
 */
export function siteIdForName(name: string | null): { siteId: SiteId; siteName: string } {
  if (name) {
    const known = siteIdFor(name);
    if (known) return { siteId: known, siteName: siteDisplayName(known) };
    return { siteId: externalSiteId(name), siteName: name };
  }
  return { siteId: 'multiple', siteName: siteDisplayName('multiple') };
}

// ---------------------------------------------------------------------------
// Approved firmware map ('cx=10.13,ap=10.6')
// ---------------------------------------------------------------------------

export type ApprovedFirmwareMap = [family: string, prefix: string][];

export function parseApprovedFirmware(spec: string | undefined): ApprovedFirmwareMap {
  if (!spec) return [];
  const out: ApprovedFirmwareMap = [];
  for (const part of spec.split(',')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const family = part.slice(0, eq).trim().toLowerCase();
    const prefix = part.slice(eq + 1).trim();
    if (family && prefix) out.push([family, prefix]);
  }
  return out;
}

/**
 * Honest default true: without an operator-declared train we cannot know a
 * firmware is unapproved, and flagging everything would be noise.
 */
export function firmwareIsApproved(
  type: string,
  model: string,
  firmware: string,
  approved: ApprovedFirmwareMap,
): boolean {
  if (approved.length === 0 || firmware === 'unknown') return true;
  const haystack = `${type} ${model}`.toLowerCase();
  const entry = approved.find(([family]) => haystack.includes(family));
  if (!entry) return true;
  return firmware.startsWith(entry[1]);
}

// ---------------------------------------------------------------------------
// Time helpers
// ---------------------------------------------------------------------------

/** Relative age string in the fixtures' vocabulary: '45s', '12m', '6h', '2d'. */
export function ageString(thenMs: number, nowMs: number = Date.now()): string {
  const sec = Math.max(0, Math.round((nowMs - thenMs) / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  return `${Math.floor(hr / 24)}d`;
}

/** Session-length display: '4h 12m', '37m', '50s'. */
export function durationString(totalSec: number): string {
  const sec = Math.max(0, Math.round(totalSec));
  const hr = Math.floor(sec / 3600);
  const min = Math.floor((sec % 3600) / 60);
  if (hr > 0) return `${hr}h ${min}m`;
  if (min > 0) return `${min}m`;
  return `${sec}s`;
}

/** Epoch seconds, epoch ms or ISO string → epoch ms; anything else → null. */
export function parseTimestamp(v: unknown): number | null {
  const n = num(v);
  if (n !== null) {
    if (n > 1e12) return n;
    if (n > 1e9) return n * 1000;
    return null;
  }
  const s = str(v);
  if (s) {
    const parsed = Date.parse(s);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return null;
}

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
    // Not on the monitoring row. Central DOES expose licensing
    // (/platform/licensing/v1/subscriptions, /platform/device_inventory/v1/devices),
    // which this adapter does not read — see the DEFERRED note in the header —
    // so 'unknown' means "not read", never "this device is unlicensed".
    licence: 'unknown',
    reconciliationIssue: false, // the reconcile service computes this
    localShell: false, // cloud-claimed — shell only via the local collector
    ...(serial ? { serial } : {}),
    ...(mac ? { mac } : {}),
    // The management IP is what the Devices search and the terminal's
    // resolveTarget() need; absent stays absent rather than becoming a lie.
    ...(ip ? { ip } : {}),
  };
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
  ]
    .filter((value): value is string => value !== null)
    .join(' ')
    .toLowerCase();
  if (/ipad|tablet/.test(s)) return 'tablet';
  // 'voip' BEFORE 'phone': every VoIP vocabulary ('VoIP Phone', 'IP Phone',
  // 'SIP handset', the literal 'phone system') contains 'phone', so a generic
  // phone test first makes this branch unreachable and buries desk handsets
  // among the mobiles. \b guards keep 'iPhone' out of the IP-phone alternative.
  if (/voip|voice|\bsip\b|\bip ?phone\b|phone system|handset/.test(s)) return 'voip';
  if (/iphone|android|smart ?phone|\bmobile\b|\bphone\b/.test(s)) return 'phone';
  if (/windows|mac ?os|linux|ubuntu|chrome/.test(s)) return 'laptop';
  if (/print/.test(s)) return 'printer';
  if (/roku|smart ?tv|television|audio|video|media streaming/.test(s)) return 'media';
  if (/camera|imaging|x-?ray/.test(s)) return 'imaging';
  if (/medical|infusion|clinical/.test(s)) return 'medical';
  if (/sensor|building|thermostat|lighting|iot/.test(s)) return 'building';
  return 'unknown';
}

function clientMedium(r: Record<string, unknown>): 'wired' | 'wireless' {
  // v1alpha1 rows carry an explicit type ('Wireless'/'Wired') — trust it
  // before the ssid/network inference below.
  const t = (str(r.type) ?? '').toLowerCase();
  if (t.includes('wireless')) return 'wireless';
  if (t.includes('wired')) return 'wired';
  const conn = (str(r.client_type) ?? str(r.connection) ?? str(r.medium) ?? '').toLowerCase();
  if (conn.includes('wireless') || conn.includes('wifi') || conn.includes('802.11')) return 'wireless';
  if (conn.includes('wired') || conn.includes('ethernet')) return 'wired';
  return str(r.ssid ?? r.network ?? r.essid) ? 'wireless' : 'wired';
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
  // v1alpha1 rows are camelCase (userName/hostName/modelOs/siteName/ipv4/…).
  const os = str(r.os ?? r.os_type ?? r.modelOs);
  const site = siteIdForName(str(r.site ?? r.site_name ?? r.siteName));
  const { health, healthTone, quality, problem } = clientHealth(r);
  const sessionSec = num(r.session_age ?? r.session_seconds ?? r.uptime);
  // v1alpha1 reports no session seconds — derive it from connectedSince (ISO).
  const connectedSinceMs = sessionSec === null ? parseTimestamp(r.connectedSince) : null;
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
    name: str(r.username ?? r.userName) ?? str(r.hostname ?? r.hostName) ?? str(r.name) ?? mac,
    model: os ?? 'unknown',
    type: clientTypeFor(r, os),
    mac,
    ip: str(r.ip_address ?? r.ip ?? r.ipv4) ?? 'pending',
    medium: clientMedium(r),
    siteId: site.siteId,
    siteName: site.siteName,
    group: str(r.group_name ?? r.group) ?? '—',
    attach: str(r.associated_device ?? r.ap_name ?? r.switch_name ?? r.nas ?? r.nas_name ?? r.connectedTo) ?? '—',
    where: str(r.ssid ?? r.network ?? r.essid ?? r.port ?? r.interface ?? r.interface_name) ?? '—',
    plane: 'CENTRAL',
    planeTone: 'accent',
    healthTone,
    // per-field str(): v1alpha1 sends authentication:'' (?? would not skip it)
    // but fills keyManagement ('WPA2-PSK', 'WPA3-SAE') on wireless rows.
    auth: str(r.auth_method) ?? str(r.auth) ?? str(r.authentication) ?? str(r.keyManagement) ?? '—',
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

/** Central severity vocabulary → the design's P1/P2/P3. */
export function sevFor(raw: string | null): Sev {
  const s = (raw ?? '').toLowerCase();
  if (/crit|emerg|major|alert|p1/.test(s)) return 'P1';
  if (/warn|minor|p2/.test(s)) return 'P2';
  return 'P3';
}

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

// ---------------------------------------------------------------------------
// Token manager — in-memory, refresh at expiry−60s, single-flight
// ---------------------------------------------------------------------------

export interface TokenResponse {
  accessToken: string;
  expiresInSec: number;
}

export class TokenManager {
  private token: string | null = null;
  private validUntilMs = 0;
  private inflight: Promise<string> | null = null;

  constructor(
    private readonly fetchToken: () => Promise<TokenResponse>,
    private readonly nowMs: () => number = () => Date.now(),
    private readonly refreshMarginSec = 60,
  ) {}

  /** Cached bearer token; refreshes at expiry − margin. Concurrent callers share one fetch. */
  async get(): Promise<string> {
    if (this.token !== null && this.nowMs() < this.validUntilMs) return this.token;
    this.inflight ??= this.fetchToken()
      .then(({ accessToken, expiresInSec }) => {
        this.token = accessToken;
        const ttlSec = Math.max(0, expiresInSec - this.refreshMarginSec);
        this.validUntilMs = this.nowMs() + ttlSec * 1000;
        return accessToken;
      })
      .finally(() => {
        this.inflight = null;
      });
    return this.inflight;
  }

  /** Drop the cached token (after a 401) so the next get() re-authenticates. */
  invalidate(): void {
    this.token = null;
    this.validUntilMs = 0;
  }
}

/**
 * The credential-freshness fact for a token that was just minted: the REAL
 * expiry the plane published (not the manager's earlier refresh point, which is
 * an internal margin) plus a source label, so the Systems fact strip can read
 * 'rotates 12 Aug' instead of 'no expiry published'. The registry seeds
 * PlaneState.token with the source alone — only the adapter's token manager
 * ever learns when the credential dies, so only it can fill the expiry in.
 *
 * SECURITY: expiry + label ONLY. /api/systems/state serves PlaneState unmasked,
 * so the token itself (or any fragment of it) must never reach this struct.
 * A plane that publishes no `expires_in` keeps `expiresAt: null` rather than
 * having a lifetime invented for it.
 */
export function mintedTokenInfo(
  expiresInSec: number | null,
  source = 'oauth client_credentials',
  nowMs: number = Date.now(),
): PlaneTokenInfo {
  const ttl = expiresInSec !== null && Number.isFinite(expiresInSec) && expiresInSec > 0 ? expiresInSec : null;
  return { expiresAt: ttl === null ? null : new Date(nowMs + ttl * 1000).toISOString(), source };
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

type SectionKey = 'aps' | 'switches' | 'gateways' | 'sites' | 'clients' | 'notifications';

interface SectionCandidate {
  path: string;
  /** Per-candidate query extras — classic-only params (e.g. calculate_total)
   *  must NOT leak onto the v1alpha1 paths, which 400 on unknown params. */
  extraQuery?: string;
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
    candidates: [{ path: '/central/v2/sites' }, { path: '/central/v1/sites' }, { path: '/network-config/v1alpha1/sites' }],
    // v1alpha1/sites 400s PAGE_LIMIT_SIZE_EXCEEDED at limit=200 — cap is 100.
    limit: 100,
    maxPages: 10,
  },
  clients: {
    candidates: [
      { path: '/monitoring/v1/clients', extraQuery: '&calculate_total=true' },
      { path: '/network-monitoring/v1alpha1/clients' },
    ],
    limit: 500,
    maxPages: 25,
    timeoutMs: SECTION_TIMEOUT_MS,
  },
  notifications: {
    candidates: [
      { path: '/central/v1/notifications' },
      { path: '/monitoring/v1/notifications' },
      { path: '/network-notifications/v1/alerts' },
    ],
    limit: 100,
    maxPages: 5,
  },
};

/**
 * One outbound response. `retryAfterMs` is additive — callers that only read
 * { status, body } (the write broker, reboot/disconnect/ackAlert) are
 * unaffected; only the 429 backoff in authedGet consumes it.
 */
interface HttpResult {
  status: number;
  body: unknown;
  retryAfterMs?: number;
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
  aps: 'devices',
  switches: 'devices',
  gateways: 'devices',
  sites: 'sites',
  clients: 'clients',
  notifications: 'alerts',
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
  'sites',
  'clients',
  'notifications',
  'alerts',
  'items',
  'results',
];

function extractRows(body: unknown): unknown[] {
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
  return [];
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

/** Retry-After is delta-seconds or an HTTP-date; both → ms, anything else null. */
export function parseRetryAfterMs(header: string | null, nowMs: number = Date.now()): number | null {
  const raw = str(header);
  if (!raw) return null;
  const secs = num(raw);
  if (secs !== null) return Math.max(0, secs * 1000);
  const at = Date.parse(raw);
  return Number.isNaN(at) ? null : Math.max(0, at - nowMs);
}

function withScheme(base: string): string {
  return /^https?:\/\//i.test(base) ? base : `https://${base}`;
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

  constructor(
    creds: PlaneCredentials,
    private readonly stateRef: PlaneState,
    private readonly recordCall: RecordCallFn,
    private readonly fetchImpl: FetchLike = (url, init) => fetch(url, init),
    /** Injectable so tests exercise backoff/pacing without real wall time. */
    private readonly sleep: SleepFn = realSleep,
  ) {
    if (!CentralAdapter.isComplete(creds)) {
      throw new Error('central requires gatewayBaseUrl, clientId and clientSecret');
    }
    this.baseUrl = withScheme(creds.gatewayBaseUrl).replace(/\/+$/, '');
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
      for (const ep of ordered) {
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
          // 400/401/… = the endpoint is right and the credentials are wrong —
          // falling through would just double-report a bad secret.
          throw new Error(`auth: ${ep.label} answered HTTP ${status} without an access_token`);
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
      throw new Error(`auth: no token endpoint answered — ${lastMiss ?? 'no candidates'}`);
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
   *   configRead    false — pull() reads monitoring only; PlanePull.config
   *                 stays unset, so Configure keeps labelling its inventory
   *                 'observed' instead of claiming a real config read.
   */
  capabilities(): PlaneCapabilities {
    return { localShell: false, brokeredWrite: true, configRead: false };
  }

  async pull(): Promise<PlanePull> {
    const missing: SectionKey[] = [];
    const truncated: SectionKey[] = [];

    // Devices: the three classic inventory endpoints, merged. A sub-endpoint
    // that 404s on every candidate is tolerated (tenant/release may not have
    // it); all three missing means the base URL or release is wrong → fail.
    const deviceParts = await Promise.all(
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
    const deviceSections: SectionKey[] = ['aps', 'switches', 'gateways'];
    if (deviceSections.every((s) => missing.includes(s))) {
      throw new Error("central pull: section 'devices' failed — no inventory endpoint answered (404 on every candidate)");
    }
    const [apRows, switchRows, gatewayRows] = deviceParts;

    const [siteRows, clientRows, notificationRows] = await Promise.all([
      this.optionalSection('sites', missing, truncated),
      this.optionalSection('clients', missing, truncated),
      this.optionalSection('notifications', missing, truncated),
    ]);

    const devices = [
      ...apRows.map((r) => mapCentralDevice(r, 'ap', this.approved)),
      ...switchRows.map((r) => mapCentralDevice(r, 'switch', this.approved)),
      ...gatewayRows.map((r) => mapCentralDevice(r, 'gateway', this.approved)),
    ].filter((d): d is CentralDeviceRow => d !== null);
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
    // NOT .map(mapCentralNotification): map passes the index as the 2nd arg,
    // which mapCentralNotification reads as nowMs — every age became '0s'.
    const alerts = notificationRows.map((r) => mapCentralNotification(r)).filter((a): a is AlertRow => a !== null);

    // A count is an assertion of fact, so only sections we actually read get
    // one — "0 clients" for a section that 404'd would be a lie.
    const summary = [`${devices.length.toLocaleString('en-US')} devices`];
    if (!missing.includes('sites')) summary.push(`${sites.length.toLocaleString('en-US')} sites`);
    if (!missing.includes('clients')) summary.push(`${clients.length.toLocaleString('en-US')} clients`);
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
      ...(partial.length > 0 ? { partial } : {}),
    };
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
      const firstPath = `${cand.path}?offset=0&limit=${spec.limit}${cand.extraQuery ?? ''}`;
      const first = await this.authedGet(firstPath, spec.timeoutMs);
      if (first.status === 404) continue; // release variance — try the alternate namespace
      if (first.status < 200 || first.status >= 300) throw new HttpStatusError(first.status, firstPath);

      const rows = extractRows(first.body);
      const total = extractTotal(first.body);
      let offset = rows.length;
      let lastPageSize = rows.length;
      let page = 1;
      while (page < spec.maxPages && lastPageSize >= spec.limit && (total === null || offset < total)) {
        // Pace the walk: the gateway is quota'd and a 10-page client pull
        // fired back-to-back is exactly what earns the 429.
        await this.sleep(PAGE_PACING_MS);
        const path = `${cand.path}?offset=${offset}&limit=${spec.limit}${cand.extraQuery ?? ''}`;
        const res = await this.authedGet(path, spec.timeoutMs);
        // Page 1 worked, so the path is valid: a failure here fails the section.
        if (res.status < 200 || res.status >= 300) throw new HttpStatusError(res.status, path);
        const pageRows = extractRows(res.body);
        if (pageRows.length === 0) break;
        rows.push(...pageRows);
        offset += pageRows.length;
        lastPageSize = pageRows.length;
        page += 1;
      }
      this.resolvedPath.set(section, cand);
      // Incomplete either way: the page cap cut a still-full walk short, or the
      // endpoint stated a total it never handed over.
      const cappedOut = page >= spec.maxPages && lastPageSize >= spec.limit;
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
  private async authedGet(path: string, timeoutMs?: number): Promise<{ status: number; body: unknown }> {
    const opts = timeoutMs !== undefined ? { timeoutMs } : {};
    let networkTries = 0;
    for (let attempt = 0; ; attempt += 1) {
      let res: HttpResult;
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
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: unknown }> {
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
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    opts: { token?: string; body?: unknown; timeoutMs?: number } = {},
  ): Promise<HttpResult> {
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
    method: 'GET' | 'POST' | 'PUT',
    url: string,
    opts: { token?: string; body?: unknown; formEncoded?: boolean; timeoutMs?: number } = {},
  ): Promise<HttpResult> {
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
    } catch (err) {
      this.recordCall({ path: label, ms: Date.now() - started, code: 'network-error' });
      throw new Error(`${label} failed: ${(err as Error).message}`);
    }
    this.recordCall({ path: label, ms: Date.now() - started, code: String(res.status) });
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      /* tolerate a non-JSON body — status is what we needed */
    }
    // Additive field: existing callers ({ status, body }) are unaffected.
    const retryAfterMs = parseRetryAfterMs(res.headers.get('retry-after'));
    return { status: res.status, body, ...(retryAfterMs !== null ? { retryAfterMs } : {}) };
  }
}
