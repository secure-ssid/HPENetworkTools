/**
 * server/src/planes/edgeconnect.ts — HPE Aruba EdgeConnect SD-WAN adapter.
 *
 * The SD-WAN plane (README integration table: appliances, alarms; read-only
 * — the portal never fakes a config-push form for the Orchestrator). Talks to
 * the EdgeConnect Orchestrator's own REST API at /gms/rest/v1.0/, on-prem or
 * hosted by the customer, same shape as AOS-8/AOS-CX rather than a cloud
 * OAuth plane.
 *
 * Verified surface (Orchestrator REST API v1.0):
 *   login    POST   /gms/rest/v1.0/authentication/login  body {user, password}
 *            → { token } (+ possibly a Set-Cookie the WebUI also honours, but
 *              the documented API contract is the header token, so that is
 *              the only credential this adapter carries forward).
 *            Every later call sends the token back as `X-AUTH-TOKEN`. The
 *            token has no published TTL, so it is cached until a call answers
 *            401 (session dropped/expired on the Orchestrator side) — dropped,
 *            re-minted once, and the call retried once.
 *   logout   DELETE /gms/rest/v1.0/authentication/logout (+ X-AUTH-TOKEN).
 *            Best-effort, fired on dispose() so a credential re-save or an
 *            unlink does not leave a session open on the Orchestrator.
 *   appliances GET /gms/rest/v1.0/appliances → array of appliance objects.
 *   alarms     GET /gms/rest/v1.0/alarms?limit=100 → array of alarm objects.
 *
 * TLS: an Orchestrator commonly serves a self-signed certificate out of the
 * box (same as AOS-8/AOS-CX), so the default transport is a small node:https
 * fetch with rejectUnauthorized OFF (set creds.verifyTls = 'true' to enforce
 * chain verification).
 *
 * Mapping decisions:
 *   - type: 'gateway'. An EdgeConnect appliance terminates WAN tunnels and
 *     routes branch traffic — the closest DeviceType the shared model has to
 *     an SD-WAN edge box, the same choice AOS-10's VPN-concentrator rows make.
 *   - site: the appliance's own `site` field is the only place-of-installation
 *     column this API publishes (siteIdForName mints an 'ext-*' id for a name
 *     the portal does not know); an appliance with none lands on the
 *     'multiple' pseudo-site, its documented purpose.
 *   - state: normal → up, degraded → warning, down → down. Anything else is
 *     reported as-is with a neutral tone rather than guessed into one of the
 *     three — an Orchestrator that adds a fourth word should not be silently
 *     folded into one of these.
 *   - localShell: false. The Orchestrator's API is a management read; there is
 *     no jump-host path from this portal to an appliance's own shell.
 *   - alertFeed: true — alarms are this plane's second dataset, and the whole
 *     reason it participates in the Alerts queue.
 *
 * Failure policy (mirrors aoscx/aos8): login failing, or the appliances read
 * failing, → pull() throws — an inventory nobody could read is never
 * published as an empty-but-healthy one. Alarms are additive on top of the
 * appliance inventory (the plane's core claim is the SD-WAN fleet, not the
 * alarm feed), so a failed alarms read is named in `partial` and the note,
 * never silently dropped.
 */

import * as https from 'node:https';
import type { AlertRow, DeviceRow, Tone } from '@hpe/shared';
import type { PlaneCredentials } from '../config/settings';
import type { ConnectionProbeResult, PlaneAdapter, PlaneCapabilities, PlanePull, PlaneState } from './types';
import { ageString, parseTimestamp, sevFor, siteIdForName } from './format';
import { type FetchLike, type RecordCallFn, httpsBase } from './transport';

// Re-exported so tests can type an in-memory fake fetch against this adapter.
export type { FetchLike } from './transport';

const OUTBOUND_TIMEOUT_MS = 10_000;
const REST_ROOT = '/gms/rest/v1.0';

// ---------------------------------------------------------------------------
// Default transport: node:https so per-connection TLS verification can be
// relaxed for an Orchestrator's factory self-signed cert (global fetch/undici
// offers no per-call switch without an undici Agent dependency) — identical
// to aos8.ts/aoscx.ts's copy, duplicated rather than shared for the same
// reason those two do not share theirs (transport.ts's header).
// ---------------------------------------------------------------------------

function httpsFetch(verifyTls: boolean): FetchLike {
  return (url, init) =>
    new Promise<Response>((resolve, reject) => {
      const u = new URL(url);
      const req = https.request(
        {
          hostname: u.hostname,
          port: u.port || 443,
          path: u.pathname + u.search,
          method: init?.method ?? 'GET',
          headers: init?.headers as Record<string, string> | undefined,
          rejectUnauthorized: verifyTls,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            const code = res.statusCode ?? 502;
            const status = code >= 200 && code <= 599 ? code : 502;
            resolve(new Response(Buffer.concat(chunks), { status }));
          });
        },
      );
      req.on('error', reject);
      const signal = init?.signal ?? null;
      if (signal) {
        if (signal.aborted) {
          req.destroy(new Error('request aborted'));
          return;
        }
        signal.addEventListener('abort', () => req.destroy(new Error('request aborted')));
      }
      if (typeof init?.body === 'string') req.write(init.body);
      req.end();
    });
}

// ---------------------------------------------------------------------------
// Defensive field readers — unknown/extra fields ignored, missing → null
// ---------------------------------------------------------------------------

function str(v: unknown): string | null {
  if (typeof v === 'string' && v.trim().length > 0) return v.trim();
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return null;
}

function obj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

// ---------------------------------------------------------------------------
// Row mapping (pure, exported for tests)
// ---------------------------------------------------------------------------

/** Orchestrator appliance `state` word → portal state vocabulary. */
function stateForAppliance(raw: string | null): { state: string; stateTone: Tone } {
  const s = (raw ?? '').trim().toLowerCase();
  if (s === 'normal') return { state: 'up', stateTone: 'success' };
  if (s === 'degraded') return { state: 'warning', stateTone: 'warning' };
  if (s === 'down') return { state: 'down', stateTone: 'danger' };
  return { state: s || 'unknown', stateTone: 'neutral' };
}

/** `GET /gms/rest/v1.0/appliances` row → DeviceRow. */
export function mapEdgeConnectAppliance(raw: unknown): DeviceRow | null {
  const r = obj(raw);
  if (!r) return null;
  const name = str(r.hostName);
  if (!name) return null;
  const { state, stateTone } = stateForAppliance(str(r.state));
  const site = siteIdForName(str(r.site));
  const serial = str(r.serialNum);
  const ip = str(r.ip);
  return {
    name,
    model: str(r.model) ?? 'unknown',
    type: 'gateway',
    siteId: site.siteId,
    siteName: site.siteName,
    plane: 'EDGECONNECT',
    planeTone: 'accent',
    state,
    stateTone,
    firmware: str(r.softwareVersion) ?? 'unknown',
    // The Orchestrator publishes no fleet-wide 'approved train' of its own —
    // an operator-declared approvedFirmware map is not part of this API, so
    // unknown is never presented as off-train (README honesty rule).
    firmwareApproved: true,
    licence: 'n/a — EdgeConnect',
    reconciliationIssue: false, // the reconcile service computes this
    localShell: false,
    ...(ip ? { ip } : {}),
    ...(serial ? { serial } : {}),
  };
}

/** `GET /gms/rest/v1.0/alarms` row → AlertRow. */
export function mapEdgeConnectAlarm(raw: unknown, nowMs: number = Date.now()): AlertRow | null {
  const r = obj(raw);
  if (!r) return null;
  const title = str(r.description);
  if (!title) return null;
  const sev = sevFor(str(r.severity));
  const raisedAt = parseTimestamp(r.raisedAt);
  const clearedAt = str(r.clearedAt);
  const site = siteIdForName(null);
  const alertId = str(r.id);
  return {
    sev,
    tone: sev === 'P1' ? 'danger' : sev === 'P2' ? 'warning' : 'info',
    title,
    detail: title,
    siteId: site.siteId,
    siteName: site.siteName,
    plane: 'EDGECONNECT',
    state: clearedAt ? 'cleared' : 'open',
    age: raisedAt !== null ? ageString(raisedAt, nowMs) : '—',
    device: str(r.sourceHostname) ?? str(r.sourceId) ?? '',
    ...(alertId ? { alertId } : {}),
  };
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export class EdgeConnectAdapter implements PlaneAdapter {
  private readonly baseUrl: string;
  /** Static API key (preferred — no session lifecycle). Null when using username/password. */
  private readonly apiKey: string | null;
  private readonly username: string;
  private readonly password: string;
  private token: string | null = null;

  constructor(
    readonly id: 'edgeconnect',
    private readonly stateRef: PlaneState,
    creds: PlaneCredentials,
    private readonly recordCall: RecordCallFn,
    private readonly fetchImpl: FetchLike = httpsFetch(creds.verifyTls === 'true'),
  ) {
    if (!EdgeConnectAdapter.isComplete(creds)) {
      throw new Error('edgeconnect requires baseUrl plus either an apiKey or username/password');
    }
    this.baseUrl = httpsBase(creds.baseUrl, 'the api key or login password rides every call').replace(/\/+$/, '');
    // API key path (preferred for automation — no session to manage)
    const key = typeof creds.apiKey === 'string' ? creds.apiKey.trim() : '';
    this.apiKey = key || null;
    this.username = this.apiKey ? '' : creds.username.trim();
    this.password = this.apiKey ? '' : creds.password;
  }

  static isComplete(creds: PlaneCredentials | null): boolean {
    if (!creds) return false;
    const hasUrl = typeof creds.baseUrl === 'string' && creds.baseUrl.trim().length > 0;
    if (!hasUrl) return false;
    // API key OR username+password
    const hasApiKey = typeof creds.apiKey === 'string' && creds.apiKey.trim().length > 0;
    const hasUserPass =
      [creds.username, creds.password].every((v) => typeof v === 'string' && v.trim().length > 0);
    return hasApiKey || hasUserPass;
  }

  state(): PlaneState {
    return this.stateRef;
  }

  /**
   * EdgeConnect contributes an alarm feed (README: alerts among its
   * datasets) but has no portal shell path and no config-write surface — the
   * Orchestrator is a read-only fleet view here, same posture as ClearPass.
   */
  capabilities(): PlaneCapabilities {
    return { localShell: false, brokeredWrite: false, configRead: false, alertFeed: true };
  }

  async validateConnection(): Promise<ConnectionProbeResult> {
    try {
      await this.getArray('/appliances', 'GET /appliances');
      return { ok: true, authenticated: true, dataset: 'devices', message: 'EdgeConnect credentials accepted; Appliances readable', status: 200 };
    } catch (err) {
      const message = (err as Error).message;
      const status = Number(/HTTP (\d{3})/.exec(message)?.[1] ?? 0) || undefined;
      if (status === 403) return { ok: false, authenticated: true, dataset: 'devices', message: 'EdgeConnect credentials are valid but lack Appliances privileges', status };
      if (status === 401 || message.includes('credentials rejected')) return { ok: false, authenticated: false, dataset: 'devices', message: 'EdgeConnect rejected the credentials', ...(status ? { status } : {}) };
      return { ok: false, authenticated: false, dataset: 'devices', message: 'EdgeConnect Appliances probe failed', ...(status ? { status } : {}) };
    }
  }

  /**
   * Hand the Orchestrator its session back before this adapter is dropped
   * (credentials re-saved, plane unlinked). Never throws — logout() swallows
   * its own errors — so a re-link is never blocked by the Orchestrator being
   * unreachable.
   */
  async dispose(): Promise<void> {
    if (this.apiKey) return; // API key sessions have no server-side logout
    const token = this.token;
    this.token = null;
    if (token) await this.logout(token);
  }

  async pull(): Promise<PlanePull> {
    let applianceRows: unknown[];
    try {
      applianceRows = await this.getArray('/appliances', 'GET /appliances');
    } catch (err) {
      throw new Error(`edgeconnect pull: 'appliances' failed — ${(err as Error).message}`);
    }
    const devices = applianceRows.map((r) => mapEdgeConnectAppliance(r)).filter((d): d is DeviceRow => d !== null);

    let alerts: AlertRow[] = [];
    let alarmsError: string | null = null;
    try {
      const alarmRows = await this.getArray('/alarms?limit=100', 'GET /alarms?limit=100');
      alerts = alarmRows.map((r) => mapEdgeConnectAlarm(r)).filter((a): a is AlertRow => a !== null);
    } catch (err) {
      alarmsError = (err as Error).message;
    }

    this.stateRef.note =
      `${devices.length} appliance${devices.length === 1 ? '' : 's'}` +
      (alarmsError === null ? ` · ${alerts.length} alarms` : ` · alarms unavailable (${alarmsError})`);
    this.stateRef.health = alarmsError === null ? 'healthy' : 'warning';

    return {
      devices,
      alerts,
      ...(alarmsError !== null ? { partial: ['alerts' as const] } : {}),
    };
  }

  // -- internals -------------------------------------------------------------

  /**
   * One GET through the REST API.
   * - API key mode: send `X-AUTH-TOKEN` on every call, no session lifecycle.
   * - Session mode: a 401 means the token died (Orchestrator restart, session
   *   cleared by an admin) — drop the cached token, re-login once, retry once.
   * A body that is not a JSON array is a failure, never an empty table.
   */
  private async getArray(path: string, logPath: string): Promise<unknown[]> {
    if (this.apiKey) {
      const res = await this.get(path, logPath, this.apiKey);
      if (res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res.status} from ${logPath}`);
      if (res.parseError) throw new Error(`non-JSON body from ${logPath} (HTTP ${res.status}, ${res.parseError})`);
      if (!Array.isArray(res.body)) throw new Error(`unexpected (non-array) body from ${logPath}`);
      return res.body;
    }
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const token = await this.login();
      const res = await this.get(path, logPath, token);
      if (res.status === 401) {
        this.token = null;
        if (attempt === 0) continue;
        throw new Error(`HTTP 401 from ${logPath} after re-login`);
      }
      if (res.status < 200 || res.status >= 300) {
        throw new Error(`HTTP ${res.status} from ${logPath}`);
      }
      if (res.parseError) {
        throw new Error(`non-JSON body from ${logPath} (HTTP ${res.status}, ${res.parseError})`);
      }
      if (!Array.isArray(res.body)) throw new Error(`unexpected (non-array) body from ${logPath}`);
      return res.body;
    }
    throw new Error(`unreachable retry state for ${logPath}`);
  }

  /** Cached auth token; a dropped cache re-authenticates on next use. */
  private async login(): Promise<string> {
    if (this.token) return this.token;

    const started = Date.now();
    const logPath = `POST ${REST_ROOT}/authentication/login`;
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${REST_ROOT}/authentication/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ user: this.username, password: this.password }),
        signal: AbortSignal.timeout(OUTBOUND_TIMEOUT_MS),
      });
    } catch (err) {
      this.recordCall({ path: logPath, ms: Date.now() - started, code: 'network-error' });
      throw new Error(`login failed: ${(err as Error).message}`);
    }
    this.recordCall({ path: logPath, ms: Date.now() - started, code: String(res.status) });
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`login failed: HTTP ${res.status} — credentials rejected or wrong Orchestrator address`);
    }
    let body: unknown = null;
    try {
      body = await res.json();
    } catch (err) {
      throw new Error(`login failed: non-JSON response (${(err as Error).message})`);
    }
    const token = str(obj(body)?.token);
    if (!token) throw new Error('login failed: no token in the response');
    this.token = token;
    return token;
  }

  /**
   * Best-effort session release. A failed logout is never fatal (the token
   * then simply ages out as it did before), so this never throws into pull().
   */
  private async logout(token: string): Promise<void> {
    const started = Date.now();
    const logPath = `DELETE ${REST_ROOT}/authentication/logout`;
    try {
      const res = await this.fetchImpl(`${this.baseUrl}${REST_ROOT}/authentication/logout`, {
        method: 'DELETE',
        headers: { accept: 'application/json', 'X-AUTH-TOKEN': token },
        signal: AbortSignal.timeout(OUTBOUND_TIMEOUT_MS),
      });
      this.recordCall({ path: logPath, ms: Date.now() - started, code: String(res.status) });
    } catch {
      this.recordCall({ path: logPath, ms: Date.now() - started, code: 'network-error' });
    }
  }

  /**
   * Timed outbound GET recorded in the plane's call log.
   * `parseError` distinguishes "the Orchestrator sent no JSON" from "it sent
   * an empty array" — the caller must not read the second as the first.
   */
  private async get(
    path: string,
    logPath: string,
    token: string,
  ): Promise<{ status: number; body: unknown; parseError: string | null }> {
    const started = Date.now();
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${REST_ROOT}${path}`, {
        method: 'GET',
        headers: { accept: 'application/json', 'X-AUTH-TOKEN': token },
        signal: AbortSignal.timeout(OUTBOUND_TIMEOUT_MS),
      });
    } catch (err) {
      this.recordCall({ path: logPath, ms: Date.now() - started, code: 'network-error' });
      throw new Error(`GET ${logPath} failed: ${(err as Error).message}`);
    }
    this.recordCall({ path: logPath, ms: Date.now() - started, code: String(res.status) });
    let body: unknown = null;
    let parseError: string | null = null;
    try {
      body = await res.json();
    } catch (err) {
      parseError = `${res.headers.get('content-type') ?? 'no content-type'}: ${(err as Error).message}`;
    }
    return { status: res.status, body, parseError };
  }
}
