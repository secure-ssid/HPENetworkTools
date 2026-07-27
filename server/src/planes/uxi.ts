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
 *   status   GET /networking-uxi/v1alpha1/sensors/{id}/status
 *            → {isOnline, isTesting, issues[{code, severity, status, timestamp,
 *              context{networkName, serviceTestName, …}}]}
 *   paging   cursor: {items, count, next} — follow ?next= until null (≤10 pages).
 *
 * Honest gaps the note surfaces: there is NO historical test-results pull —
 * results leave UXI through push destinations (S3) only. Rate limit is
 * 5 req/s per customer; status reads run sequentially, which stays under it
 * at any plausible sensor count, and the per-sensor status read is capped at
 * MAX_SENSOR_STATUSES with the cap named in the note when it bites.
 *
 * Failure policy (mirrors clearpass):
 *   - the sensors list failing → pull() throws naming the section; there is
 *     nothing honest to degrade to.
 *   - one sensor's status read failing → that sensor keeps state 'unknown'
 *     and its issues are skipped (named in the note), never fatal.
 *
 * Security: the client secret lives only in the token POST's Basic header —
 * never in a URL; the call log records method + path + ms + status only.
 */

import type { AlertRow, DeviceRow, Sev, Tone } from '../../../shared';
import type { PlaneCredentials } from '../config/settings';
import {
  TokenManager,
  ageString,
  parseTimestamp,
  sevFor,
  siteIdForName,
  type FetchLike,
  type RecordCallFn,
} from './central';
import type { PlaneAdapter, PlanePull, PlaneState } from './types';

// Re-exported so tests can type an in-memory fake fetch against this adapter.
export type { FetchLike } from './central';

const OUTBOUND_TIMEOUT_MS = 10_000;
const TOKEN_URL = 'https://sso.common.cloud.hpe.com/as/token.oauth2';
const DEFAULT_BASE_URL = 'https://api.capenetworks.com';
const API_PREFIX = '/networking-uxi/v1alpha1';

/** Follow the cursor at most this far — a runaway `next` must not loop forever. */
const MAX_PAGES = 10;
/** Per-sensor status reads are capped; sensors beyond this keep state 'unknown'. */
export const MAX_SENSOR_STATUSES = 50;

const SEV_TONE: Record<Sev, Tone> = { P1: 'danger', P2: 'warning', P3: 'info' };

/** UXI severity vocabulary (HIGH/MEDIUM/LOW) → the design's P1/P2/P3; anything else defers to central's sevFor. */
export function uxiSevFor(raw: string | null): Sev {
  const s = (raw ?? '').trim().toLowerCase();
  if (s === 'high') return 'P1';
  if (s === 'medium') return 'P2';
  if (s === 'low') return 'P3';
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

// ---------------------------------------------------------------------------
// Row mapping (pure, exported for tests)
// ---------------------------------------------------------------------------

/** Identity hint for the reconcile service (the pattern central uses for serial/mac). */
export type UxiDeviceRow = DeviceRow & { mac?: string };

/** UXI sensor list item (+ optional status) → DeviceRow. */
export function mapUxiSensor(raw: unknown, online: boolean | null): UxiDeviceRow | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const name = str(r.name) ?? str(r.id);
  if (!name) return null;
  const site = siteIdForName(str(r.site ?? r.site_name ?? r.group_name));
  const mac = str(r.mac_address ?? r.macAddress ?? r.mac);
  const state =
    online === null ? { state: 'unknown', stateTone: 'neutral' as Tone }
    : online ? { state: 'up', stateTone: 'success' as Tone }
    : { state: 'offline', stateTone: 'danger' as Tone };
  return {
    name,
    model: str(r.model) ?? 'UXI sensor',
    type: 'sensor',
    siteId: site.siteId,
    siteName: site.siteName,
    plane: 'UXI',
    planeTone: 'info',
    ...state,
    firmware: str(r.firmware_version ?? r.firmware) ?? 'unknown',
    firmwareApproved: true, // the UXI API does not publish an approved train — honest default
    licence: 'unknown', // UXI licensing lives in GreenLake, not in this API
    reconciliationIssue: false, // the reconcile service computes this
    localShell: false, // sensors are cloud-managed; no portal shell
    ...(mac ? { mac } : {}),
  };
}

/**
 * One sensor-status issue → AlertRow. `sensorName` resolves the context's
 * sensor id to the display name; `nowMs` anchors the age string (injected
 * for tests).
 */
export function mapUxiIssue(raw: unknown, sensorName: string, nowMs: number = Date.now()): AlertRow | null {
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
  const site = siteIdForName(str(ctx.site ?? ctx.site_name));
  return {
    sev,
    tone: SEV_TONE[sev],
    title: code ?? 'UXI issue',
    detail,
    siteId: site.siteId,
    siteName: site.siteName,
    plane: 'UXI',
    state: /resolv|clos|clear/.test(statusRaw) ? 'acked' : 'open',
    age: ts !== null ? ageString(ts, nowMs) : '—',
    device: sensorName,
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

  constructor(
    creds: PlaneCredentials,
    private readonly stateRef: PlaneState,
    private readonly recordCall: RecordCallFn,
    private readonly fetchImpl: FetchLike = (url, init) => fetch(url, init),
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
      return { accessToken: token, expiresInSec: Number.isFinite(expires) ? expires : 7200 };
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

  async pull(): Promise<PlanePull> {
    let sensors: unknown[];
    try {
      sensors = await this.fetchAllSensors();
    } catch (err) {
      throw new Error(`uxi pull: section 'sensors' failed — ${(err as Error).message}`);
    }

    // Per-sensor status: sequential (the 5 req/s budget never comes close),
    // capped, and per-sensor failures are non-fatal — that sensor just keeps
    // state 'unknown' and contributes no issues.
    const onlineByName = new Map<string, boolean>();
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
        onlineByName.set(s.name, body.isOnline === true || body.is_online === true);
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

    const alerts = issues
      .map(({ issue, sensorName }) => mapUxiIssue(issue, sensorName))
      .filter((a): a is AlertRow => a !== null);

    const capped = named.length > MAX_SENSOR_STATUSES ? ` · status capped at ${MAX_SENSOR_STATUSES}` : '';
    const failed = statusFailures > 0 ? ` · ${statusFailures} status reads failed` : '';
    this.stateRef.note =
      `${devices.length.toLocaleString('en-US')} sensors · ${alerts.length.toLocaleString('en-US')} ongoing issues${capped}${failed}` +
      ' · historical results are push-only (S3)';
    if (this.stateRef.health === 'warning') this.stateRef.health = 'healthy'; // first sync done

    return { devices, alerts };
  }

  // -- internals -------------------------------------------------------------

  /** All sensors, following the {items, next} cursor up to MAX_PAGES. */
  private async fetchAllSensors(): Promise<unknown[]> {
    const out: unknown[] = [];
    let path: string | null = `${API_PREFIX}/sensors`;
    for (let page = 0; page < MAX_PAGES && path !== null; page += 1) {
      const res = await this.get(path);
      if (res.status < 200 || res.status >= 300) {
        throw new Error(`HTTP ${res.status} from ${path}`);
      }
      const parsed = parseSensorsPage(res.body);
      out.push(...parsed.items);
      path = parsed.next !== null ? `${API_PREFIX}/sensors?next=${encodeURIComponent(parsed.next)}` : null;
    }
    return out;
  }

  /** GET with a bearer token; one invalidation + retry on 401. */
  private async get(path: string): Promise<{ status: number; body: unknown }> {
    let res = await this.http(path, { token: await this.tokens.get() });
    if (res.status === 401) {
      this.tokens.invalidate();
      res = await this.http(path, { token: await this.tokens.get() });
    }
    return res;
  }

  /**
   * Timed outbound call recorded in the plane's call log. The log carries
   * method + path + ms + status only — never a body, so never a secret.
   */
  private async http(path: string, opts: { token: string }): Promise<{ status: number; body: unknown }> {
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
    return { status: res.status, body };
  }
}
