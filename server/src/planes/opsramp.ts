/**
 * server/src/planes/opsramp.ts — HPE OpsRamp AIOps/observability adapter.
 *
 * OpsRamp contributes managed resources (devices) and open alerts to the
 * portal's unified view. It has no write path here and no config inventory —
 * the plane is read-only observability, same posture as UXI and ClearPass's
 * monitoring surface, not a management console.
 *
 * Surface:
 *   auth      POST {baseUrl}/auth/oauth/token
 *             form grant_type=client_credentials&client_id=...&client_secret=...
 *             → { access_token, token_type, expires_in }, cached via the
 *             shared TokenManager (refresh at expiry−60s, single-flight).
 *   resources GET {baseUrl}/api/v2/tenants/{tenantId}/resources?pageSize=100&pageNo=N
 *             → { results: [...], totalResults }
 *   alerts    GET {baseUrl}/api/v2/tenants/{tenantId}/alerts?pageSize=100&pageNo=N&status=open
 *             → { results: [...], totalResults }
 *
 * Paging is capped at MAX_PAGES per section — a runaway `totalResults` must
 * not turn one poll tick into an unbounded walk against a tenant's resource
 * estate.
 */

import type { AlertRow, DeviceRow, DeviceType, Sev, Tone } from '@hpe/shared';
import { formatCount } from '@hpe/shared';
import type { PlaneCredentials } from '../config/settings';
import type { DeviceIdentityHints } from '../services/reconcile';
import type { PlaneAdapter, PlaneCapabilities, PlanePull, PlaneState } from './types';
import { ageString, parseTimestamp, sevFor, siteIdForName } from './format';
import { TokenManager, mintedTokenInfo, type FetchLike, type RecordCallFn } from './transport';

// Re-exported so tests can type an in-memory fake fetch against this adapter.
export type { FetchLike } from './transport';

const OUTBOUND_TIMEOUT_MS = 10_000;
const DEFAULT_BASE_URL = 'https://app.opsramp.net';
const PAGE_SIZE = 100;
/** A runaway `totalResults` must not turn one poll tick into an unbounded walk. */
const MAX_PAGES = 10;

// ---------------------------------------------------------------------------
// Defensive field readers — unknown/extra fields ignored, missing → null
// ---------------------------------------------------------------------------

function str(v: unknown): string | null {
  if (typeof v === 'string' && v.trim().length > 0) return v.trim();
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return null;
}

/**
 * OpsRamp's CRITICAL/HIGH/MEDIUM/LOW vocabulary → the design's P1/P2/P3.
 * The shared Sev type has no P4, so LOW and MEDIUM both land on P3 — the
 * lowest bucket the queue has, not a made-up fourth tier.
 */
export function opsRampSevFor(raw: string | null): Sev {
  const s = (raw ?? '').trim().toLowerCase();
  if (s === 'critical') return 'P1';
  if (s === 'high') return 'P2';
  if (s === 'medium' || s === 'low') return 'P3';
  return sevFor(raw);
}

const SEV_TONE: Record<Sev, Tone> = { P1: 'danger', P2: 'warning', P3: 'info' };

/** OpsRamp resource `type` vocabulary → the shared DeviceType; anything
 *  unrecognised is honestly 'unknown' rather than guessed. */
function deviceTypeFor(raw: string | null): DeviceType {
  const s = (raw ?? '').toLowerCase();
  if (/switch/.test(s)) return 'switch';
  if (/ap|access.?point|wireless/.test(s)) return 'ap';
  if (/gateway/.test(s)) return 'gateway';
  if (/controller/.test(s)) return 'controller';
  if (/sensor/.test(s)) return 'sensor';
  return 'policy';
}

// ---------------------------------------------------------------------------
// Row mapping (pure, exported for tests)
// ---------------------------------------------------------------------------

/** Identity hints for the reconcile service (the pattern central uses for serial/mac). */
export type OpsRampDeviceRow = DeviceRow & DeviceIdentityHints;

/** OpsRamp resource list item → DeviceRow. */
export function mapOpsRampResource(raw: unknown): OpsRampDeviceRow | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const name = str(r.hostName ?? r.name);
  if (!name) return null;
  const availability = (str(r.availability) ?? '').toLowerCase();
  const state =
    availability === 'up'
      ? { state: 'up', stateTone: 'success' as Tone }
      : availability === 'down'
        ? { state: 'down', stateTone: 'danger' as Tone }
        : { state: 'unknown', stateTone: 'neutral' as Tone };
  const site = siteIdForName(str(r.site ?? r.siteName ?? r.location));
  const serial = str(r.serialNumber ?? r.serial);
  const mac = str(r.macAddress ?? r.mac);
  return {
    name,
    model: str(r.model ?? r.make) ?? 'unknown',
    type: deviceTypeFor(str(r.type)),
    siteId: site.siteId,
    siteName: site.siteName,
    plane: 'OPSRAMP',
    planeTone: 'info',
    ...state,
    // OpsRamp's resource item publishes no firmware field.
    firmware: 'unknown',
    firmwareApproved: true, // no approved-train concept published here
    licence: 'unknown', // OpsRamp licensing is not read by this adapter
    reconciliationIssue: false, // the reconcile service computes this
    localShell: false, // cloud-managed observability; no portal shell
    ...(str(r.ipAddress ?? r.ip) ? { ip: str(r.ipAddress ?? r.ip)! } : {}),
    ...(serial ? { serial } : {}),
    ...(mac ? { mac } : {}),
  };
}

/** One OpsRamp alert → AlertRow. `nowMs` anchors the age string (injected for tests). */
export function mapOpsRampAlert(raw: unknown, nowMs: number = Date.now()): AlertRow | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const title = str(r.subject ?? r.title);
  if (!title) return null;
  const sev = opsRampSevFor(str(r.severity));
  const ts = parseTimestamp(r.createdTime ?? r.created_time ?? r.createdAt);
  const statusRaw = (str(r.status) ?? '').toLowerCase();
  const site = siteIdForName(str(r.site ?? r.siteName));
  return {
    sev,
    tone: SEV_TONE[sev],
    title,
    detail: str(r.description ?? r.detail) ?? title,
    siteId: site.siteId,
    siteName: site.siteName,
    plane: 'OPSRAMP',
    // OpsRamp models no acknowledgement concept here — a non-open alert is
    // treated as cleared (the same distinction uxi.ts draws), never 'acked',
    // which would credit a human action that never happened.
    state: statusRaw === 'open' ? 'open' : 'cleared',
    age: ts !== null ? ageString(ts, nowMs) : '—',
    device: str(r.resourceName) ?? 'unknown',
    alertId: str(r.id) ?? undefined,
  };
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

/** One page's shape — `{ results, totalResults }`; null when the body carries
 *  no readable results array (a sign-in page or an empty non-JSON answer). */
function parsePage(body: unknown): { results: unknown[]; totalResults: number | null } | null {
  if (!body || typeof body !== 'object') return null;
  const r = body as Record<string, unknown>;
  if (!Array.isArray(r.results)) return null;
  const total = typeof r.totalResults === 'number' && Number.isFinite(r.totalResults) ? r.totalResults : null;
  return { results: r.results, totalResults: total };
}

export class OpsRampAdapter implements PlaneAdapter {
  readonly id = 'opsramp' as const;

  private readonly baseUrl: string;
  private readonly tenantId: string;
  private readonly tokens: TokenManager;

  constructor(
    creds: PlaneCredentials,
    private readonly stateRef: PlaneState,
    private readonly recordCall: RecordCallFn,
    private readonly fetchImpl: FetchLike = (url, init) => fetch(url, init),
  ) {
    if (!OpsRampAdapter.isComplete(creds)) {
      throw new Error('opsramp requires tenantId, clientId and clientSecret');
    }
    this.baseUrl = (creds.baseUrl?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.tenantId = creds.tenantId.trim();
    const clientId = creds.clientId;
    const clientSecret = creds.clientSecret;
    this.tokens = new TokenManager(async () => {
      let res: Response;
      try {
        res = await this.fetchImpl(`${this.baseUrl}/auth/oauth/token`, {
          method: 'POST',
          headers: {
            accept: 'application/json',
            'content-type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({
            grant_type: 'client_credentials',
            client_id: clientId,
            client_secret: clientSecret,
          }).toString(),
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
      const published = Number.isFinite(expires) ? expires : null;
      this.stateRef.token = mintedTokenInfo(published);
      return { accessToken: token, expiresInSec: published ?? 3600 };
    });
  }

  static isComplete(creds: PlaneCredentials | null): boolean {
    return (
      !!creds &&
      [creds.tenantId, creds.clientId, creds.clientSecret].every(
        (v) => typeof v === 'string' && v.trim().length > 0,
      )
    );
  }

  state(): PlaneState {
    return this.stateRef;
  }

  /**
   * OpsRamp is cloud observability: the portal cannot open a shell on a
   * monitored resource, the write broker has nothing to push (this API is
   * read-only here), and it publishes no SSID/VLAN/port configuration. It
   * DOES contribute alerts, so alertFeed is the one true capability.
   */
  capabilities(): PlaneCapabilities {
    return { localShell: false, brokeredWrite: false, configRead: false, alertFeed: true };
  }

  async pull(): Promise<PlanePull> {
    let resourcesTruncated = false;
    let alertsTruncated = false;
    const rawResources = await this.fetchAll('resources');
    resourcesTruncated = rawResources.truncated;
    const rawAlerts = await this.fetchAll('alerts', '&status=open');
    alertsTruncated = rawAlerts.truncated;

    const devices = rawResources.items
      .map(mapOpsRampResource)
      .filter((d): d is OpsRampDeviceRow => d !== null);
    const alerts = rawAlerts.items
      .map((a) => mapOpsRampAlert(a))
      .filter((a): a is AlertRow => a !== null);

    const truncNote =
      (resourcesTruncated ? ` · resources truncated (page cap ${MAX_PAGES})` : '') +
      (alertsTruncated ? ` · alerts truncated (page cap ${MAX_PAGES})` : '');
    this.stateRef.note =
      `${formatCount(devices.length)} resources · ${formatCount(alerts.length)} open alerts${truncNote}`;

    if (this.stateRef.health === 'warning') this.stateRef.health = 'healthy'; // first sync done

    const partial = [
      ...(resourcesTruncated ? (['devices'] as const) : []),
      ...(alertsTruncated ? (['alerts'] as const) : []),
    ];
    return partial.length > 0 ? { devices, alerts, partial } : { devices, alerts };
  }

  // -- internals -------------------------------------------------------------

  /**
   * All items for one section (`resources` or `alerts`), paging pageNo 1..N
   * up to MAX_PAGES. `truncated` is true when the cap stopped the walk before
   * `totalResults` was reached — the caller must never publish that as a
   * complete inventory.
   */
  private async fetchAll(
    section: 'resources' | 'alerts',
    extraQuery = '',
  ): Promise<{ items: unknown[]; truncated: boolean }> {
    const out: unknown[] = [];
    let pageNo = 1;
    let total: number | null = null;
    for (; pageNo <= MAX_PAGES; pageNo += 1) {
      const path = `/api/v2/tenants/${encodeURIComponent(this.tenantId)}/${section}?pageSize=${PAGE_SIZE}&pageNo=${pageNo}${extraQuery}`;
      const res = await this.get(path);
      if (res.status < 200 || res.status >= 300) {
        throw new Error(`HTTP ${res.status} from ${path}`);
      }
      const parsed = parsePage(res.body);
      if (parsed === null) throw new Error(`unreadable body from ${path} (page ${pageNo})`);
      out.push(...parsed.results);
      total = parsed.totalResults;
      if (parsed.results.length === 0) break;
      if (total !== null && out.length >= total) break;
    }
    const truncated = total !== null && out.length < total;
    return { items: out, truncated };
  }

  /** GET with a bearer token; one invalidation + retry on 401. */
  private async get(path: string): Promise<{ status: number; body: unknown }> {
    let res = await this.http(path, await this.tokens.get());
    if (res.status === 401) {
      this.tokens.invalidate();
      res = await this.http(path, await this.tokens.get());
    }
    return res;
  }

  /**
   * Timed outbound call recorded in the plane's call log. The log carries
   * method + path + ms + status only — never a body, so never a secret.
   */
  private async http(path: string, token: string): Promise<{ status: number; body: unknown }> {
    const started = Date.now();
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: 'GET',
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${token}`,
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
