/**
 * server/src/planes/mist.ts — Juniper Mist cloud adapter (read-only).
 *
 * The Mist plane (README integration table: inventory, clients, SLE, alarms;
 * read-only — config stays in the Mist dashboard, the portal never fakes an
 * edit form). Static API-token auth — `Authorization: Token <token>` on every
 * call, nothing to refresh (verified against the official OpenAPI spec at
 * mistsys/mist_openapi and the mistapi_python SDK).
 *
 * Verified surface:
 *   sites    GET /api/v1/orgs/{orgId}/sites?limit=N&page=N
 *   devices  GET /api/v1/orgs/{orgId}/stats/devices?type=all&limit=N&page=N
 *            one org-wide call carries name/model/version/serial/mac/site_id/
 *            status(connected|disconnected)/num_clients per device — the best
 *            fit for this adapter.
 *   alarms   GET /api/v1/orgs/{orgId}/alarms/search?duration=1d&limit=N&page=N
 *            search envelope `{ results: [...], total }` — extractRows and
 *            extractTotal read both that and the bare-array list shape.
 *   clients  GET /api/v1/sites/{siteId}/stats/clients?limit=N&page=N
 *            Mist publishes no org-wide client roster, so this is one call per
 *            site per cycle (design/NtSystems.dc.html:284 records exactly this
 *            path) — see CLIENT_SITE_BUDGET for the quota arithmetic.
 *   paging   limit+page (1-based). X-Page-Total/Limit/Page carry the
 *            authoritative totals; when the gateway trims an oversized `limit`
 *            the short-page heuristic alone would stop after page 1, so the
 *            headers (and the search envelope's `total`) drive the walk and
 *            the short-page rule is only the fallback.
 *   limits   README:462 caps this plane at 20,000 calls/day; a 429 is paced
 *            with Retry-After rather than failing the cycle outright.
 *
 * num_clients rides on every device-stats row and is summed per site: when the
 * roster is unavailable (>CLIENT_SITE_BUDGET sites, or a failed walk) it is the
 * only client fact this plane gives away for free, so the Sites 'Clients'
 * column and the plane note report it — labelled 'reported by devices', never
 * as a session roster.
 *
 * DEFERRED (needs a live Mist org to verify the shapes before it can ship):
 *   subscriptions  GET /api/v1/orgs/{orgId}/licenses (+ /licenses/usages) —
 *                  Mist DOES publish org entitlements, so the Licences screen
 *                  loses the Mist SUB rows until this section lands. The
 *                  device row's `licence: 'unknown'` says "not read", not
 *                  "does not exist".
 *   config         no SSID/VLAN read, so capabilities().configRead is false.
 *
 * Failure policy: `sites` and `devices` are the inventory this plane exists
 * for — either failing throws, naming the section. `clients` and `alarms` are
 * additional datasets: a failure there OMITS the key (never an empty array),
 * notes the section as unavailable and holds the plane at 'warning', so
 * downstream reads it as unknown instead of as an authoritative zero
 * (README:469 rule 1 and its corollary).
 *
 * Security: the token travels in the Authorization header only, never in a
 * URL; the call log records method + path + ms + status, never headers.
 */

import type {
  AlertRow,
  ClientRow,
  ClientType,
  DeviceRow,
  DeviceType,
  PlaneDatasetKey,
  SiteRow,
  Tone,
} from '@hpe/shared';
import { formatCount } from '@hpe/shared';
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
 * Mist has no org-wide client roster, so the clients section costs one call
 * per site per cycle. README:462 caps this plane at 20,000 calls/day and the
 * default 60s cadence is 1,440 cycles/day — roughly 13 calls a cycle for the
 * whole plane. Past this many sites the fan-out would eat the org's quota, so
 * the section is reported unavailable rather than half-fetched: a roster
 * covering some sites, read as complete, is the lie rule 1 forbids.
 */
const CLIENT_SITE_BUDGET = 8;

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

/**
 * Mist org device-stats row → DeviceRow. `siteNameById` resolves the Mist
 * site UUID to its display name (from the sites section); unknown ids land on
 * the 'multiple' pseudo-site via siteIdForName(null).
 */
export function mapMistDevice(raw: unknown, siteNameById: ReadonlyMap<string, string>): MistDeviceRow | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const name = str(r.name) ?? str(r.hostname) ?? str(r.serial) ?? str(r.mac);
  if (!name) return null;
  const status = (str(r.status) ?? '').toLowerCase();
  const { state, stateTone } =
    status === 'connected'
      ? { state: 'up', stateTone: 'success' as Tone }
      : status === 'disconnected'
        ? { state: 'down', stateTone: 'danger' as Tone }
        : { state: status || 'unknown', stateTone: 'neutral' as Tone };
  const siteUuid = str(r.site_id);
  const site = siteIdForName(siteUuid !== null ? (siteNameById.get(siteUuid) ?? null) : null);
  const serial = str(r.serial);
  const mac = str(r.mac);
  const ip = str(r.ip);
  return {
    name,
    model: str(r.model) ?? 'unknown',
    type: deviceTypeFor(str(r.type)),
    siteId: site.siteId,
    siteName: site.siteName,
    plane: 'MIST',
    planeTone: 'info',
    state,
    stateTone,
    firmware: str(r.version) ?? 'unknown',
    firmwareApproved: true, // Mist's stats API does not publish an approved train — honest default
    // Not reported by the device-stats row. Mist DOES publish org entitlements
    // at GET /api/v1/orgs/{orgId}/licenses (+ /licenses/usages), which this
    // adapter does not read yet — see the deferred subscriptions section — so
    // 'unknown' is honest, not a statement that Mist has no licence API.
    licence: 'unknown',
    reconciliationIssue: false, // the reconcile service computes this
    localShell: false, // cloud-claimed — no portal shell
    ...(serial ? { serial } : {}),
    ...(mac ? { mac } : {}),
    // Management IP when the stats row carries one: the Devices search and the
    // terminal's resolveTarget() both key on it. Absent stays absent.
    ...(ip ? { ip } : {}),
  };
}

/**
 * Mist org site row → SiteRow. Device and client counts ride along from the
 * stats sections; `clientCount` null means the clients section was not read
 * AND no device reported a client total, which renders '—' rather than a '0'
 * the adapter cannot stand behind. `sync` is the CALLER's stamp — the Mist
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
 * medium is not inferred.
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
  return {
    name: str(r.username) ?? str(r.hostname) ?? mac,
    model: str(r.model) ?? str(r.os) ?? str(r.family) ?? 'unknown',
    type: clientTypeFor(r),
    mac,
    ip: str(r.ip) ?? 'pending',
    medium: 'wireless',
    siteId: site.siteId,
    siteName: site.siteName,
    group: '—', // Mist config groups are not carried on the stats row
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
    retries: '—',
    tput: '—',
    roams: '—',
    zone: '—',
    closet: '—',
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
   *   brokeredWrite false — README integration table: read-only. Config stays
   *                 in the Mist dashboard and the portal never fakes an edit.
   *   configRead    false — pull() reads inventory/clients/alarms only.
   */
  capabilities(): PlaneCapabilities {
    return { localShell: false, brokeredWrite: false, configRead: false };
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

    const devices = deviceRows
      .map((d) => mapMistDevice(d, siteNameById))
      .filter((d): d is MistDeviceRow => d !== null);

    // MAC/id → inventory name, so a client's `attach` names the AP it is on
    // rather than repeating a bare MAC. The same walk sums the per-device
    // `num_clients` the stats row already carries, keyed by the MAPPED site
    // name: it is the only client fact this plane gives away for free (the
    // roster costs one call per site and is refused past CLIENT_SITE_BUDGET),
    // so it is what keeps the Sites 'Clients' column from reading '—'.
    const deviceNameByKey = new Map<string, string>();
    const reportedClientsBySite = new Map<string, number>();
    let reportedClientTotal = 0;
    let reportedClientsSeen = false;
    for (const d of deviceRows) {
      if (!d || typeof d !== 'object') continue;
      const r = d as Record<string, unknown>;
      const reported = num(r.num_clients);
      if (reported !== null) {
        reportedClientsSeen = true;
        reportedClientTotal += reported;
        const uuid = str(r.site_id);
        const mapped = siteIdForName(uuid !== null ? (siteNameById.get(uuid) ?? null) : null);
        reportedClientsBySite.set(mapped.siteName, (reportedClientsBySite.get(mapped.siteName) ?? 0) + reported);
      }
      const name = str(r.name) ?? str(r.hostname);
      if (!name) continue;
      const mac = macKey(str(r.mac));
      if (mac) deviceNameByKey.set(mac, name);
      const id = str(r.id);
      if (id) deviceNameByKey.set(id.toLowerCase(), name);
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

    const clients = await this.pullClients(siteRows, siteNameById, deviceNameByKey, missing, truncated);

    // -- rows ----------------------------------------------------------------
    const countBySite = new Map<string, number>();
    for (const d of devices) {
      countBySite.set(d.siteName, (countBySite.get(d.siteName) ?? 0) + 1);
    }
    const clientsBySite = new Map<string, number>();
    for (const c of clients ?? []) {
      clientsBySite.set(c.siteName, (clientsBySite.get(c.siteName) ?? 0) + 1);
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
      // Roster count when we read the roster; otherwise the devices' own
      // reported total, which is a real plane fact rather than an assumed 0.
      const clientCount =
        clients !== null
          ? (clientsBySite.get(mapped.siteName) ?? 0)
          : reportedClientsSeen
            ? (reportedClientsBySite.get(mapped.siteName) ?? 0)
            : null;
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
    if (clients !== null) summary.push(`${formatCount(clients.length)} client sessions`);
    else if (reportedClientsSeen) {
      // Not a roster — the devices' own client totals. Said as such, because
      // the note is user-visible on Connected systems and in the drawer.
      summary.push(`${formatCount(reportedClientTotal)} clients reported by devices`);
    }
    if (alerts !== null) {
      summary.push(`${formatCount(alerts.filter((a) => a.state === 'open').length)} open alarms`);
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
      ...(clients === null ? {} : { clients }),
      ...(alerts === null ? {} : { alerts }),
      ...(partial.length > 0 ? { partial } : {}),
    };
  }

  // -- internals -------------------------------------------------------------

  /**
   * The clients section: one paged walk per site, all or nothing. Past
   * CLIENT_SITE_BUDGET sites the fan-out is refused up front (quota), and a
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
    if (siteUuids.length > CLIENT_SITE_BUDGET) {
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
   * All pages of a list endpoint. The authoritative row count comes from
   * X-Page-Total (or a search envelope's `total`) and the page size the server
   * actually used from X-Page-Limit — a gateway that trims `limit=1000` down
   * to 100 would otherwise look like a short page and end the walk after one
   * page. The short-page rule is the fallback when neither is published.
   * Capped at MAX_PAGES; a walk that ends with rows still outstanding is
   * reported as truncated rather than passed off as the whole dataset.
   */
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
    for (let attempt = 0; ; attempt += 1) {
      const res = await this.get(path);
      if (res.status !== 429 || attempt >= RATE_LIMIT_RETRIES) return res;
      const backoffMs = RATE_LIMIT_BASE_MS * 2 ** attempt;
      await this.sleep(Math.min(res.retryAfterMs ?? backoffMs, RATE_LIMIT_CAP_MS));
    }
  }

  /**
   * Timed outbound GET recorded in the plane's call log. The log carries
   * method + path + ms + status only — headers (and so the token) never.
   */
  private async get(path: string): Promise<MistResponse> {
    const started = Date.now();
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: 'GET',
        headers: {
          accept: 'application/json',
          authorization: `Token ${this.token}`,
        },
        signal: AbortSignal.timeout(OUTBOUND_TIMEOUT_MS),
      });
    } catch (err) {
      this.recordCall({ path: `GET ${path}`, ms: Date.now() - started, code: 'network-error' });
      throw new Error(`GET ${path} failed: ${(err as Error).message}`);
    }
    this.recordCall({ path: `GET ${path}`, ms: Date.now() - started, code: String(res.status) });
    let body: unknown = null;
    let parsed = false;
    try {
      body = await res.json();
      parsed = true;
    } catch {
      /* an unreadable body is reported by the caller — it is never zero rows */
    }
    const retryAfterMs = parseRetryAfterMs(res.headers.get('retry-after'));
    return {
      status: res.status,
      body,
      parsed,
      pageTotal: num(res.headers.get('x-page-total')),
      pageLimit: num(res.headers.get('x-page-limit')),
      ...(retryAfterMs !== null ? { retryAfterMs } : {}),
    };
  }
}
