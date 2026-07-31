/**
 * server/src/planes/uxi.ts — HPE Aruba User Experience Insight adapter.
 *
 * The sensor plane (README integration table: synthetic test state + issues;
 * read-only). Sensors are mapped into the shared DeviceRow (type 'sensor') so
 * the UXI lane fills in live mode; each sensor's ongoing issues are mapped
 * into AlertRow so the Alerts screen sees UXI alongside Central.
 *
 * Verified surface (official OpenAPI spec at
 * https://api.capenetworks.com/docs/openapi.yaml + aruba/pyhpeuxi):
 *   auth     POST https://sso.common.cloud.hpe.com/as/token.oauth2
 *            HTTP Basic (clientId:clientSecret) + form grant_type=client_credentials
 *            → Bearer, cached via the shared TokenManager (refresh at
 *            expiry−60s, single-flight, invalidate + retry once on 401).
 *   sensors  GET /networking-uxi/v1alpha1/sensors
 *            → SensorsGetItem{id, serial, name, groupName, groupPath,
 *              modelNumber, wifiMacAddress, ethernetMacAddress, addressNote,
 *              longitude, latitude, notes, pcapMode, type} — the site lives in
 *              `groupName`, and serial/MAC are the reconcile identity hints.
 *   status   GET /networking-uxi/v1alpha1/sensors/{id}/status
 *            → {isOnline, isTesting, issues[{code, severity, status, timestamp,
 *              context{groupName, networkName, serviceTestName, …}}]}
 *              isOnline/isTesting are `boolean | null` and only `issues` is
 *              required — an omitted/null isOnline means "no answer", not down.
 *   paging   cursor: {items, count, next} — `limit=100` (the spec's maximum;
 *            the default is 50) followed through ?next= for ≤10 pages. A walk
 *            that ends with a cursor still in hand is TRUNCATED and says so:
 *            a partial inventory presented as a complete one makes every
 *            missing sensor look decommissioned.
 *
 * Honest gaps the note surfaces: there is NO historical test-results pull —
 * results leave UXI through push destinations (S3) only. The per-sensor status
 * read is capped at MAX_SENSOR_STATUSES with the cap named in the note when it
 * bites.
 *
 * Rate limits: the documented budget is 5 req/s per customer and the spec
 * lists 429 as a first-class answer on /sensors. Requests are paced to
 * REQUEST_GAP_MS apart and a 429 is retried once after Retry-After (capped),
 * with throttled status reads counted separately in the note — being throttled
 * is a different fact from a sensor that would not answer.
 *
 * Failure policy (mirrors clearpass):
 *   - the sensors list failing → pull() throws naming the section; there is
 *     nothing honest to degrade to.
 *   - one sensor's status read failing → that sensor keeps state 'unknown'
 *     and its issues are skipped (named in the note), never fatal.
 *   - EVERY status read failing → the inventory is still published (it is
 *     real), but the plane is left 'degraded': a sync that proved no live
 *     sensor state must not read as a fresh, healthy one.
 *
 * Security: the client secret lives only in the token POST's Basic header —
 * never in a URL; the call log records method + path + ms + status only.
 */

import type { AlertRow, DeviceRow, PlaneDatasetKey, Sev, SiteId, Tone } from '@hpe/shared';
import { formatCount } from '@hpe/shared';
import type { PlaneCredentials } from '../config/settings';
import type { DeviceIdentityHints } from '../services/reconcile';
import type { PlaneAdapter, PlaneCapabilities, PlanePull, PlaneState } from './types';
import {
  ageString,
  parseTimestamp,
  sevFor,
  siteIdForName,
} from './format';
import {
  TokenManager,
  mintedTokenInfo,
  parseRetryAfterMs,
  type FetchLike,
  type RecordCallFn,
  type SleepFn,
} from './transport';

// Re-exported so tests can type an in-memory fake fetch against this adapter.
export type { FetchLike } from './transport';

const OUTBOUND_TIMEOUT_MS = 10_000;
const TOKEN_URL = 'https://sso.common.cloud.hpe.com/as/token.oauth2';
const DEFAULT_BASE_URL = 'https://api.capenetworks.com';
const API_PREFIX = '/networking-uxi/v1alpha1';

/** Follow the cursor at most this far — a runaway `next` must not loop forever. */
const MAX_PAGES = 10;
/** The spec's maximum page size (default 50) — half the calls for one walk. */
const SENSOR_PAGE_LIMIT = 100;
/** Per-sensor status reads are capped; sensors beyond this keep state 'unknown'. */
export const MAX_SENSOR_STATUSES = 50;

/** The documented budget is 5 req/s per customer: 200 ms between requests. */
const REQUEST_GAP_MS = 200;
/** A 429 is retried once, after Retry-After — capped so a tick cannot stall. */
const RATE_LIMIT_RETRY_MS = 1_000;
const RATE_LIMIT_CAP_MS = 5_000;

const realSleep: SleepFn = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const SEV_TONE: Record<Sev, Tone> = { P1: 'danger', P2: 'warning', P3: 'info' };

/**
 * UXI severity vocabulary → the design's P1/P2/P3. The live enum
 * (`SensorStatusIssueSeverity`) is ERROR | WARNING | INFO — a failed synthetic
 * test is P1 evidence, not a P3 footnote. HIGH/MEDIUM/LOW are kept as tolerated
 * variants; anything else defers to central's sevFor.
 */
export function uxiSevFor(raw: string | null): Sev {
  const s = (raw ?? '').trim().toLowerCase();
  if (s === 'error' || s === 'high') return 'P1';
  if (s === 'warning' || s === 'medium') return 'P2';
  if (s === 'info' || s === 'low') return 'P3';
  return sevFor(raw);
}

// ---------------------------------------------------------------------------
// Defensive field readers — unknown/extra fields ignored, missing → null
// ---------------------------------------------------------------------------

function str(v: unknown): string | null {
  if (typeof v === 'string' && v.trim().length > 0) return v.trim();
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return null;
}

/** A vendor `boolean | null` field — anything that is not a boolean is "no answer". */
function bool(v: unknown): boolean | null {
  return typeof v === 'boolean' ? v : null;
}

// ---------------------------------------------------------------------------
// Row mapping (pure, exported for tests)
// ---------------------------------------------------------------------------

/** Identity hints for the reconcile service (the pattern central uses for serial/mac). */
export type UxiDeviceRow = DeviceRow & DeviceIdentityHints;

/** UXI sensor list item (+ optional status) → DeviceRow. */
export function mapUxiSensor(raw: unknown, online: boolean | null): UxiDeviceRow | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const name = str(r.name) ?? str(r.id);
  if (!name) return null;
  // The live item names its site in `groupName`; the snake_case forms are
  // tolerated variants from older/proxied deployments.
  const site = siteIdForName(str(r.groupName ?? r.site ?? r.site_name ?? r.group_name));
  // Ethernet first — it is the MAC the switch/ClearPass planes see for a
  // wired sensor, so it is the one reconcile can match on.
  const mac = str(r.ethernetMacAddress ?? r.wifiMacAddress ?? r.mac_address ?? r.macAddress ?? r.mac);
  const serial = str(r.serial);
  const state =
    online === null ? { state: 'unknown', stateTone: 'neutral' as Tone }
    : online ? { state: 'up', stateTone: 'success' as Tone }
    : { state: 'offline', stateTone: 'danger' as Tone };
  return {
    name,
    model: str(r.modelNumber ?? r.model) ?? 'UXI sensor',
    type: 'sensor',
    siteId: site.siteId,
    siteName: site.siteName,
    plane: 'UXI',
    planeTone: 'info',
    ...state,
    // The sensor item publishes no firmware field — 'unknown' is the honest
    // answer; the variants only catch a proxy that adds one.
    firmware: str(r.firmwareVersion ?? r.firmware_version ?? r.firmware) ?? 'unknown',
    firmwareApproved: true, // the UXI API does not publish an approved train — honest default
    licence: 'unknown', // UXI licensing lives in GreenLake, not in this API
    reconciliationIssue: false, // the reconcile service computes this
    localShell: false, // sensors are cloud-managed; no portal shell
    ...(serial ? { serial } : {}),
    ...(mac ? { mac } : {}),
  };
}

/** The sensor an issue was read from — its display name and resolved site. */
export interface UxiIssueSensor {
  name: string;
  siteId: SiteId;
  siteName: string;
}

/**
 * One sensor-status issue → AlertRow. `sensor` carries the display name the
 * alert is attributed to and the site it inherits when the issue's own context
 * names no group; `nowMs` anchors the age string (injected for tests).
 */
export function mapUxiIssue(raw: unknown, sensor: UxiIssueSensor, nowMs: number = Date.now()): AlertRow | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const code = str(r.code);
  const ctx = (r.context && typeof r.context === 'object' ? r.context : {}) as Record<string, unknown>;
  const detail =
    str(r.message ?? r.detail) ??
    [str(ctx.service_test_name ?? ctx.serviceTestName), str(ctx.network_name ?? ctx.networkName)]
      .filter((v): v is string => v !== null)
      .join(' · ');
  if (!code && !detail) return null;
  const sev = uxiSevFor(str(r.severity));
  const ts = parseTimestamp(r.timestamp ?? r.created_at ?? r.time);
  const statusRaw = (str(r.status) ?? '').toLowerCase();
  // The issue context names the site in `groupName`; with none, the alert
  // inherits the site already resolved for the sensor it came from.
  const ctxSite = str(ctx.groupName ?? ctx.site ?? ctx.site_name);
  const site = ctxSite !== null ? siteIdForName(ctxSite) : { siteId: sensor.siteId, siteName: sensor.siteName };
  return {
    sev,
    tone: SEV_TONE[sev],
    title: code ?? 'UXI issue',
    detail,
    siteId: site.siteId,
    siteName: site.siteName,
    plane: 'UXI',
    // 'cleared' = the plane resolved it; 'acked' = a human acknowledged it
    // through the broker. UXI has no acknowledgement concept, so a closed
    // issue is cleared — calling it 'acked' would credit an operator action
    // that never happened (central.ts makes the same distinction).
    state: /resolv|clos|clear/.test(statusRaw) ? 'cleared' : 'open',
    age: ts !== null ? ageString(ts, nowMs) : '—',
    device: sensor.name,
  };
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

interface SensorsPage {
  items: unknown[];
  next: string | null;
}

function parseSensorsPage(body: unknown): SensorsPage {
  if (Array.isArray(body)) return { items: body, next: null };
  if (body && typeof body === 'object') {
    const r = body as Record<string, unknown>;
    const items = Array.isArray(r.items) ? r.items : [];
    const next = str(r.next);
    return { items, next };
  }
  return { items: [], next: null };
}

export class UxiAdapter implements PlaneAdapter {
  readonly id = 'uxi' as const;

  private readonly baseUrl: string;
  private readonly tokens: TokenManager;

  /** When the next outbound request may fire (the 5 req/s pacing gate). */
  private nextRequestAt = 0;
  /** 429s seen this pull — a throttle is a different fact from a dead sensor. */
  private throttled = 0;

  constructor(
    creds: PlaneCredentials,
    private readonly stateRef: PlaneState,
    private readonly recordCall: RecordCallFn,
    private readonly fetchImpl: FetchLike = (url, init) => fetch(url, init),
    /** Injectable so tests exercise pacing/backoff without real wall time. */
    private readonly sleep: SleepFn = realSleep,
  ) {
    if (!UxiAdapter.isComplete(creds)) {
      throw new Error('uxi requires clientId and clientSecret');
    }
    this.baseUrl = (creds.baseUrl?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, '');
    const basic = Buffer.from(`${creds.clientId}:${creds.clientSecret}`).toString('base64');
    this.tokens = new TokenManager(async () => {
      let res: Response;
      try {
        res = await this.fetchImpl(TOKEN_URL, {
          method: 'POST',
          headers: {
            accept: 'application/json',
            authorization: `Basic ${basic}`,
            'content-type': 'application/x-www-form-urlencoded',
          },
          body: 'grant_type=client_credentials',
          signal: AbortSignal.timeout(OUTBOUND_TIMEOUT_MS),
        });
      } catch (err) {
        throw new Error(`auth: token request failed — ${(err as Error).message}`);
      }
      let record: Record<string, unknown> = {};
      try {
        const body: unknown = await res.json();
        if (body && typeof body === 'object') record = body as Record<string, unknown>;
      } catch {
        /* a non-JSON token answer fails below as 'without an access_token' */
      }
      const token = str(record.access_token);
      const expires = Number(record.expires_in);
      if (res.status !== 200 || !token) {
        throw new Error(`auth: token endpoint answered HTTP ${res.status} without an access_token`);
      }
      // The credential's real expiry — the fact strip's fourth fact. A token
      // answer without expires_in publishes no lifetime, so expiresAt stays
      // null instead of inheriting the 7200 refresh-pacing default.
      const published = Number.isFinite(expires) ? expires : null;
      this.stateRef.token = mintedTokenInfo(published);
      return { accessToken: token, expiresInSec: published ?? 7200 };
    });
  }

  static isComplete(creds: PlaneCredentials | null): boolean {
    return (
      !!creds &&
      [creds.clientId, creds.clientSecret].every((v) => typeof v === 'string' && v.trim().length > 0)
    );
  }

  state(): PlaneState {
    return this.stateRef;
  }

  /**
   * UXI is a cloud sensor plane: the portal cannot open a shell on a sensor,
   * the write broker has nothing to push to it (the API is read-only here) and
   * it publishes no SSID/VLAN/port configuration.
   */
  capabilities(): PlaneCapabilities {
    return { localShell: false, brokeredWrite: false, configRead: false };
  }

  async pull(): Promise<PlanePull> {
    this.throttled = 0;
    let sensors: unknown[];
    let truncated = false;
    try {
      const page = await this.fetchAllSensors();
      sensors = page.items;
      truncated = page.truncated;
    } catch (err) {
      throw new Error(`uxi pull: section 'sensors' failed — ${(err as Error).message}`);
    }

    // Per-sensor status: sequential and paced to the documented 5 req/s,
    // capped, and per-sensor failures are non-fatal — that sensor just keeps
    // state 'unknown' and contributes no issues. isOnline/isTesting are
    // `boolean | null` and the body may omit them entirely, so both are kept
    // tri-state: null is "the sensor did not say", never "down".
    const onlineByName = new Map<string, boolean | null>();
    const testingByName = new Map<string, boolean | null>();
    const issues: Array<{ issue: unknown; sensorName: string }> = [];
    let statusFailures = 0;
    const named = sensors
      .map((s) => (s && typeof s === 'object' ? (s as Record<string, unknown>) : {}))
      .map((r) => ({ id: str(r.id), name: str(r.name) ?? str(r.id) }));
    for (const s of named.slice(0, MAX_SENSOR_STATUSES)) {
      if (!s.id || !s.name) continue;
      try {
        const res = await this.get(`${API_PREFIX}/sensors/${encodeURIComponent(s.id)}/status`);
        if (res.status < 200 || res.status >= 300) {
          statusFailures += 1;
          continue;
        }
        const body = res.body && typeof res.body === 'object' ? (res.body as Record<string, unknown>) : {};
        onlineByName.set(s.name, bool(body.isOnline ?? body.is_online));
        testingByName.set(s.name, bool(body.isTesting ?? body.is_testing));
        if (Array.isArray(body.issues)) {
          for (const issue of body.issues) issues.push({ issue, sensorName: s.name });
        }
      } catch {
        statusFailures += 1;
      }
    }

    const devices = sensors
      .map((s) => {
        const r = s && typeof s === 'object' ? (s as Record<string, unknown>) : {};
        const name = str(r.name) ?? str(r.id);
        return mapUxiSensor(s, name !== null ? (onlineByName.get(name) ?? null) : null);
      })
      .filter((d): d is UxiDeviceRow => d !== null);

    // An issue inherits the site of the sensor it was read from unless its own
    // context names a group — the sensor row is where groupName was resolved.
    const sensorByName = new Map<string, UxiIssueSensor>(
      devices.map((d) => [d.name, { name: d.name, siteId: d.siteId, siteName: d.siteName }]),
    );
    const alerts = issues
      .map(({ issue, sensorName }) =>
        mapUxiIssue(issue, sensorByName.get(sensorName) ?? { name: sensorName, ...siteIdForName(null) }),
      )
      .filter((a): a is AlertRow => a !== null);

    // Online but not testing is a real UXI condition — a sensor that is up and
    // running nothing proves nothing, so the note says so rather than hiding it.
    const idle = [...testingByName].filter(
      ([name, testing]) => testing === false && onlineByName.get(name) === true,
    ).length;
    const capped = named.length > MAX_SENSOR_STATUSES ? ` · status capped at ${MAX_SENSOR_STATUSES}` : '';
    const failed = statusFailures > 0 ? ` · ${statusFailures} status reads failed` : '';
    const throttleNote = this.throttled > 0 ? ` · ${this.throttled} throttled (429)` : '';
    const idleNote = idle > 0 ? ` · ${formatCount(idle)} idle (online, not testing)` : '';
    // The page cap stopping a walk that still had a cursor is silent data loss
    // unless it is named: those sensors are not gone, they were never read.
    const truncNote = truncated ? ` · inventory truncated at ${formatCount(devices.length)} (page cap ${MAX_PAGES})` : '';
    this.stateRef.note =
      `${formatCount(devices.length)} sensors · ${formatCount(alerts.length)} ongoing issues${idleNote}${truncNote}${capped}${failed}${throttleNote}` +
      ' · historical results are push-only (S3)';

    // A pull that read the inventory but proved NO live sensor state is not a
    // healthy sync: the rows are real, their state is not. Degrading here is
    // what makes the devices render 'unverified' rather than silently stale.
    if (statusFailures > 0 && onlineByName.size === 0) {
      this.stateRef.health = 'degraded';
    } else if (this.stateRef.health === 'warning') {
      this.stateRef.health = 'healthy'; // first sync done
    }

    /* Issues arrive from the per-sensor status call, so a sensor whose status
       was never read contributes no issues — and there is nothing in the
       alerts array to show for it. Both gaps do that: the status loop stops at
       MAX_SENSOR_STATUSES, and any sensor that answered non-2xx is skipped.
       "4 ongoing issues" then describes the sensors that were asked, not the
       estate, and until the pull says so the plane reports it green with a
       fresh stamp behind it. The note already carried the numbers; partial[]
       is what stops them being read as the whole picture. */
    const partial: PlaneDatasetKey[] = [
      ...(truncated ? (['devices'] as const) : []),
      ...(named.length > MAX_SENSOR_STATUSES || statusFailures > 0 ? (['alerts'] as const) : []),
    ];
    return partial.length > 0 ? { devices, alerts, partial } : { devices, alerts };
  }

  // -- internals -------------------------------------------------------------

  /**
   * All sensors, at the spec's maximum page size, following the {items, next}
   * cursor up to MAX_PAGES. `truncated` is true when the cap stopped the walk
   * with a cursor still in hand — the caller must never publish that as a
   * complete inventory.
   */
  private async fetchAllSensors(): Promise<{ items: unknown[]; truncated: boolean }> {
    const out: unknown[] = [];
    let path: string | null = `${API_PREFIX}/sensors?limit=${SENSOR_PAGE_LIMIT}`;
    let page = 0;
    for (; page < MAX_PAGES && path !== null; page += 1) {
      const res = await this.get(path);
      if (res.status < 200 || res.status >= 300) {
        throw new Error(`HTTP ${res.status} from ${path}`);
      }
      const parsed = parseSensorsPage(res.body);
      out.push(...parsed.items);
      // Both params ride the cursor path: dropping `limit` would silently
      // reset the server to its default page size mid-walk.
      path =
        parsed.next !== null
          ? `${API_PREFIX}/sensors?limit=${SENSOR_PAGE_LIMIT}&next=${encodeURIComponent(parsed.next)}`
          : null;
    }
    return { items: out, truncated: path !== null };
  }

  /**
   * GET with a bearer token; one invalidation + retry on 401, and one retry
   * after Retry-After on a 429 (capped, so a throttle paces the poll instead
   * of failing it). Requests are paced to the documented 5 req/s.
   */
  private async get(path: string): Promise<{ status: number; body: unknown }> {
    let res = await this.paced(path);
    if (res.status === 401) {
      this.tokens.invalidate();
      res = await this.paced(path);
    }
    if (res.status === 429) {
      this.throttled += 1;
      await this.sleep(Math.min(res.retryAfterMs ?? RATE_LIMIT_RETRY_MS, RATE_LIMIT_CAP_MS));
      res = await this.paced(path);
      if (res.status === 429) this.throttled += 1;
    }
    return res;
  }

  /**
   * One request, not before the pacing gate opens. The vendor budget is 5
   * req/s per CUSTOMER, so a sequential loop of local-latency calls can breach
   * it easily — the header used to claim otherwise.
   */
  private async paced(path: string): Promise<{ status: number; body: unknown; retryAfterMs?: number }> {
    const wait = this.nextRequestAt - Date.now();
    if (wait > 0) await this.sleep(wait);
    this.nextRequestAt = Date.now() + REQUEST_GAP_MS;
    return this.http(path, { token: await this.tokens.get() });
  }

  /**
   * Timed outbound call recorded in the plane's call log. The log carries
   * method + path + ms + status only — never a body, so never a secret.
   */
  private async http(
    path: string,
    opts: { token: string },
  ): Promise<{ status: number; body: unknown; retryAfterMs?: number }> {
    const started = Date.now();
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: 'GET',
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${opts.token}`,
        },
        signal: AbortSignal.timeout(OUTBOUND_TIMEOUT_MS),
      });
    } catch (err) {
      this.recordCall({ path: `GET ${path}`, ms: Date.now() - started, code: 'network-error' });
      throw new Error(`GET ${path} failed: ${(err as Error).message}`);
    }
    this.recordCall({ path: `GET ${path}`, ms: Date.now() - started, code: String(res.status) });
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      /* tolerate a non-JSON body — status is what we needed */
    }
    // Additive: callers that read { status, body } are unaffected.
    const retryAfterMs = parseRetryAfterMs(res.headers.get('retry-after'));
    return { status: res.status, body, ...(retryAfterMs !== null ? { retryAfterMs } : {}) };
  }
}
