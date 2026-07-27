/**
 * server/src/planes/aos8.ts — AOS-8 mobility master adapter (read-only).
 *
 * The on-prem controller plane (README integration table: inventory +
 * controller health; read-only — configuration stays on the MM, the portal
 * never fakes an edit form). There is no cloud in the path: the portal talks
 * to the mobility master's own HTTPS API on :4343.
 *
 * Verified surface (AOS-8 8.x API, the same calls the WebUI makes):
 *   login       POST /v1/api/login  form {username, password}
 *               → { _global_result: { status: "0", UIDARUBA: "…" } }
 *               The UID is a session cookie (~15 min TTL) — cached here and
 *               renewed at 14 min, or immediately when a call answers
 *               status != "0" (session expired), with ONE re-login retry.
 *   showcommand GET /v1/configuration/showcommand?command=<cli>&UIDARUBA=<uid>
 *               → the CLI table parsed to JSON: named arrays of row objects
 *               (top level, or nested one level under a `_data`-style key).
 *               Pulled: `show ap database long` (APs) and `show switches`
 *               (controllers).
 *
 * TLS: a factory MM serves a self-signed certificate, so the default
 * transport is a small node:https fetch with rejectUnauthorized OFF (set
 * creds.verifyTls = 'true' to enforce chain verification). The call log
 * records method + path + ms + status — the UID in the query string is
 * redacted, and the password only ever travels in the login POST body.
 *
 * Failure policy (mirrors clearpass/mist): login failing or either
 * showcommand section failing → pull() throws naming the section; the
 * inventory is this plane's whole dataset, nothing honest to degrade to.
 */

import * as https from 'node:https';
import type { DeviceRow, DeviceType, Tone } from '../../../shared';
import type { PlaneCredentials } from '../config/settings';
import { siteIdForName, type FetchLike, type RecordCallFn } from './central';
import type { PlaneAdapter, PlanePull, PlaneState } from './types';

// Re-exported so tests can type an in-memory fake fetch against this adapter.
export type { FetchLike } from './central';

const OUTBOUND_TIMEOUT_MS = 10_000;
/** UIDARUBA sessions live ~15 min on the MM; renew a minute early. */
const SESSION_TTL_MS = 14 * 60 * 1000;

const CMD_AP_DATABASE = 'show ap database long';
const CMD_SWITCHES = 'show switches';

// ---------------------------------------------------------------------------
// Default transport: node:https so per-connection TLS verification can be
// relaxed for the MM's factory self-signed cert (global fetch/undici offers
// no per-call switch without an undici Agent dependency).
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

/** First non-empty value among the column-name variants a table may use. */
function pick(r: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = str(r[k]);
    if (v !== null) return v;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Row mapping (pure, exported for tests)
// ---------------------------------------------------------------------------

/** AOS-8 Status column ("Up 5d:02:11:47" / "Down") → portal state vocabulary. */
function stateForStatus(raw: string | null): { state: string; stateTone: Tone } {
  const s = (raw ?? '').trim().toLowerCase();
  if (s.startsWith('up')) return { state: 'up', stateTone: 'success' };
  if (s.startsWith('down')) return { state: 'down', stateTone: 'danger' };
  return { state: s || 'unknown', stateTone: 'neutral' };
}

function baseRow(
  name: string,
  model: string | null,
  type: DeviceType,
  statusRaw: string | null,
  firmware: string | null,
): DeviceRow {
  const { state, stateTone } = stateForStatus(statusRaw);
  const site = siteIdForName(null); // AOS-8 tables carry no site concept — honest 'multiple'
  return {
    name,
    model: model ?? 'unknown',
    type,
    siteId: site.siteId,
    siteName: site.siteName,
    plane: 'AOS-8',
    planeTone: 'accent',
    state,
    stateTone,
    firmware: firmware ?? 'unknown',
    firmwareApproved: true, // the MM does not publish an approved train — honest default
    licence: 'unknown', // licences live on the MM (show license), not pulled
    reconciliationIssue: false, // the reconcile service computes this
    localShell: false, // SSH sessions go through the terminal manager, not this adapter
  };
}

/** `show ap database long` row → DeviceRow (type 'ap'). */
export function mapAos8Ap(raw: unknown): DeviceRow | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const name = pick(r, ['Name', 'name', 'AP Name', 'ap-name']) ?? pick(r, ['IP Address', 'IP', 'ip']);
  if (!name) return null;
  return baseRow(
    name,
    pick(r, ['AP Type', 'Type', 'Model', 'model']),
    'ap',
    pick(r, ['Status', 'status', 'State']),
    pick(r, ['Version', 'Firmware', 'fw']),
  );
}

/** `show switches` row → DeviceRow (type 'controller'). */
export function mapAos8Switch(raw: unknown): DeviceRow | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const name = pick(r, ['Name', 'name', 'Hostname']) ?? pick(r, ['IP Address', 'IP', 'Switch IP', 'ip']);
  if (!name) return null;
  const model = pick(r, ['Model', 'Type', 'model']);
  return baseRow(
    name,
    model,
    'controller',
    pick(r, ['Status', 'status', 'State']),
    pick(r, ['Version', 'Firmware', 'fw']),
  );
}

// ---------------------------------------------------------------------------
// Response-shape helpers
// ---------------------------------------------------------------------------

/** `_global_result.status` — "0" means success; anything else is a session/CLI error. */
function globalStatus(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const g = (body as Record<string, unknown>)._global_result;
  if (!g || typeof g !== 'object') return null;
  return str((g as Record<string, unknown>).status);
}

/** UIDARUBA out of a login body (`_global_result.UIDARUBA`, with flat variants). */
function uidFrom(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  const g = b._global_result;
  if (g && typeof g === 'object') {
    const uid = str((g as Record<string, unknown>).UIDARUBA);
    if (uid) return uid;
  }
  return str(b.UIDARUBA) ?? str(b.uidaruba);
}

/**
 * All table rows in a showcommand body: arrays of plain objects at the top
 * level or one level deep, excluding `_`-prefixed metadata keys. Command
 * tables appear under their CLI title ("AP Database", "Switches", …), which
 * varies by version — walking the shape beats hardcoding titles.
 */
function extractTables(body: unknown): unknown[] {
  const out: unknown[] = [];
  const walk = (v: unknown, depth: number): void => {
    if (depth > 2 || !v || typeof v !== 'object') return;
    if (Array.isArray(v)) {
      for (const item of v) if (item && typeof item === 'object' && !Array.isArray(item)) out.push(item);
      return;
    }
    for (const [k, child] of Object.entries(v as Record<string, unknown>)) {
      // `_data` is where the MM nests tables; other `_` keys are metadata.
      if (k.startsWith('_') && k !== '_data') continue;
      walk(child, depth + 1);
    }
  };
  walk(body, 0);
  return out;
}

function withScheme(base: string): string {
  if (/^https:\/\//i.test(base)) return base;
  // The login POST carries the password — a plaintext scheme is a config error,
  // not something to silently honour.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(base)) {
    throw new Error(`aos8 master must use https — the login carries the password and '${base.split('://')[0]}://' would send it in cleartext; configure an https:// master`);
  }
  return `https://${base}`;
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export class Aos8Adapter implements PlaneAdapter {
  readonly id = 'aos8' as const;

  private readonly baseUrl: string;
  private readonly username: string;
  private readonly password: string;
  private session: { uid: string; expiresAt: number } | null = null;

  constructor(
    creds: PlaneCredentials,
    private readonly stateRef: PlaneState,
    private readonly recordCall: RecordCallFn,
    private readonly fetchImpl: FetchLike = httpsFetch(creds.verifyTls === 'true'),
  ) {
    if (!Aos8Adapter.isComplete(creds)) {
      throw new Error("aos8 requires master plus username/password (or clientId/clientSecret)");
    }
    this.baseUrl = withScheme(creds.master).replace(/\/+$/, '');
    this.username = (creds.username ?? creds.clientId).trim();
    this.password = creds.password ?? creds.clientSecret;
  }

  static isComplete(creds: PlaneCredentials | null): boolean {
    if (!creds) return false;
    const user = creds.username ?? creds.clientId;
    const pass = creds.password ?? creds.clientSecret;
    return [creds.master, user, pass].every((v) => typeof v === 'string' && v.trim().length > 0);
  }

  state(): PlaneState {
    return this.stateRef;
  }

  async pull(): Promise<PlanePull> {
    let apRows: unknown[];
    let switchRows: unknown[];
    try {
      apRows = await this.showcommand(CMD_AP_DATABASE);
    } catch (err) {
      throw new Error(`aos8 pull: section '${CMD_AP_DATABASE}' failed — ${(err as Error).message}`);
    }
    try {
      switchRows = await this.showcommand(CMD_SWITCHES);
    } catch (err) {
      throw new Error(`aos8 pull: section '${CMD_SWITCHES}' failed — ${(err as Error).message}`);
    }

    const aps = apRows.map(mapAos8Ap).filter((d): d is DeviceRow => d !== null);
    const switches = switchRows.map(mapAos8Switch).filter((d): d is DeviceRow => d !== null);
    const devices = [...aps, ...switches];

    const down = devices.filter((d) => d.state === 'down').length;
    this.stateRef.note =
      `${aps.length.toLocaleString('en-US')} APs · ${switches.length.toLocaleString('en-US')} controllers via showcommand` +
      (down > 0 ? ` · ${down.toLocaleString('en-US')} down` : '');
    if (this.stateRef.health === 'warning') this.stateRef.health = 'healthy'; // first sync done

    return { devices };
  }

  // -- internals -------------------------------------------------------------

  /**
   * One CLI command through the showcommand API. A status != "0" answer means
   * the session died (or the CLI errored) — drop the cached UID, re-login
   * once, retry once.
   */
  private async showcommand(command: string): Promise<unknown[]> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const uid = await this.login();
      const path = `/v1/configuration/showcommand?command=${encodeURIComponent(command)}&UIDARUBA=${encodeURIComponent(uid)}`;
      const res = await this.get(path, `GET /v1/configuration/showcommand?command=${command}&UIDARUBA=…`);
      if (res.status < 200 || res.status >= 300) {
        throw new Error(`HTTP ${res.status} from showcommand '${command}'`);
      }
      const status = globalStatus(res.body);
      if (status !== null && status !== '0') {
        this.session = null; // session rejected — force a fresh login on the retry
        if (attempt === 0) continue;
        throw new Error(`MM answered status ${status} for '${command}' after re-login`);
      }
      return extractTables(res.body);
    }
    throw new Error(`unreachable retry state for '${command}'`);
  }

  /** Cached UIDARUBA login; renews at 14 min or when the cache was dropped. */
  private async login(): Promise<string> {
    const now = Date.now();
    if (this.session && this.session.expiresAt > now) return this.session.uid;

    const started = Date.now();
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/v1/api/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams({ username: this.username, password: this.password }).toString(),
        signal: AbortSignal.timeout(OUTBOUND_TIMEOUT_MS),
      });
    } catch (err) {
      this.recordCall({ path: 'POST /v1/api/login', ms: Date.now() - started, code: 'network-error' });
      throw new Error(`login failed: ${(err as Error).message}`);
    }
    this.recordCall({ path: 'POST /v1/api/login', ms: Date.now() - started, code: String(res.status) });
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`login failed: HTTP ${res.status} — credentials rejected or wrong master`);
    }
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      /* handled below */
    }
    const uid = uidFrom(body);
    if (!uid) throw new Error('login failed: no UIDARUBA in the response body');
    this.session = { uid, expiresAt: now + SESSION_TTL_MS };
    return uid;
  }

  /** Timed outbound GET recorded in the plane's call log (path pre-redacted). */
  private async get(path: string, logPath: string): Promise<{ status: number; body: unknown }> {
    const started = Date.now();
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: 'GET',
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(OUTBOUND_TIMEOUT_MS),
      });
    } catch (err) {
      this.recordCall({ path: logPath, ms: Date.now() - started, code: 'network-error' });
      throw new Error(`GET ${logPath} failed: ${(err as Error).message}`);
    }
    this.recordCall({ path: logPath, ms: Date.now() - started, code: String(res.status) });
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      /* tolerate a non-JSON body — status is what we needed */
    }
    return { status: res.status, body };
  }
}
