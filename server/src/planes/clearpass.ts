/**
 * server/src/planes/clearpass.ts — HPE ClearPass (CPPM) adapter.
 *
 * The policy plane (README integration table: auth/accounting events,
 * endpoints, policy; read-only — policy is edited in ClearPass itself, the
 * portal never fakes an edit form). Static API-client token auth —
 * `Authorization: Bearer <token>` on every call, no token manager, nothing to
 * refresh — with auth logs mapped into the shared AuthEventRow so the poller
 * cache and /api/auth-events can consume them.
 *
 * Endpoint candidates (Insight vs. older log APIs; 404 on a candidate is
 * tolerated by trying the next one and remembering which path worked):
 *
 *   section     candidates (tried in order)
 *   authEvents  /api-insight/v1/auth/logs
 *               /api/auth-logs
 *               /tips/api/auth/events
 *
 * Failure policy (mirrors central):
 *   - 404 on every candidate → pull() fails naming the section — the auth feed
 *     is this plane's whole dataset, so there is nothing honest to degrade to.
 *   - any other HTTP/network error → pull() throws naming the section, so the
 *     poller marks the plane degraded and keeps serving the last good cache.
 *   - a 401 is NOT retried: a static token cannot self-heal.
 *
 * Mapping decisions:
 *   - result forced onto the design's closed union: accept/success →
 *     accept (success); reject/denied/fail → reject (danger); timeout /
 *     no-response → timeout (warning). An unrecognised vocabulary keeps the
 *     row as timeout/warning with the raw value preserved in reason —
 *     dropping data silently is worse than an imperfect bucket.
 *   - method normalised to 802.1X / MAB / TACACS+; unfamiliar values pass
 *     through unchanged.
 *   - mac normalised to aa:bb:cc:dd:ee:ff (any separator, any case); values
 *     that are not 12 hex digits pass through lowercased.
 *   - time: ISO/epoch → 'HH:MM' local wall-clock; the exact instant rides
 *     along as the tsMs hint so /api/auth-events can compute rates and the
 *     stats window without re-parsing display strings (same pattern as
 *     central's serial/mac identity hints).
 *   - role: enforcement profile → 'role <name>' (the fixtures' display
 *     language); none → 'no role assigned'.
 *   - rows with neither a username nor a MAC are junk → dropped.
 *   - newest 200 kept (sorted by tsMs descending) — the screen shows the
 *     freshest decisions; the feed can be far larger.
 *
 * Security: the token travels in the Authorization header only, never in a
 * URL; the call log records method + path + ms + status, never headers.
 */

import type { AuthEvent, AuthEventRow, Tone } from '../../../shared';
import type { PlaneCredentials } from '../config/settings';
import { parseTimestamp, type FetchLike, type RecordCallFn } from './central';
import type { PlaneAdapter, PlanePull, PlaneState } from './types';

const OUTBOUND_TIMEOUT_MS = 10_000;

/** The feed can be far larger than the screen's needs — keep the freshest. */
export const MAX_AUTH_EVENTS = 200;

const CANDIDATES = ['/api-insight/v1/auth/logs', '/api/auth-logs', '/tips/api/auth/events'];

// ---------------------------------------------------------------------------
// Defensive field readers — unknown/extra fields ignored, missing → null
// ---------------------------------------------------------------------------

function str(v: unknown): string | null {
  if (typeof v === 'string' && v.trim().length > 0) return v.trim();
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return null;
}

// ---------------------------------------------------------------------------
// Time hint — what the display row flattens away but the screen needs
// ---------------------------------------------------------------------------

/** Optional computed timestamp (the pattern central uses for serial/mac). */
export interface AuthEventTimeHint {
  tsMs?: number;
}

export type ClearPassAuthEventRow = AuthEventRow & AuthEventTimeHint;

// ---------------------------------------------------------------------------
// Row mapping (pure, exported for tests)
// ---------------------------------------------------------------------------

/** Any-separator MAC → aa:bb:cc:dd:ee:ff; non-12-hex values pass through lowercased. */
export function normalizeMac(v: string): string {
  const hex = v.replace(/[^0-9a-fA-F]/g, '').toLowerCase();
  if (hex.length === 12) return hex.replace(/(..)/g, '$1:').slice(0, -1);
  return v.trim().toLowerCase();
}

/** Local wall-clock 'HH:MM' — the fixtures' display style. */
function hhmm(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** ClearPass result vocabulary → the design's closed union (+ badge tone). */
export function authResultFor(raw: string | null): { result: AuthEvent['result']; tone: Tone } {
  const s = (raw ?? '').toLowerCase();
  if (/accept|success|allow/.test(s)) return { result: 'accept', tone: 'success' };
  if (/reject|denied|deny|fail/.test(s)) return { result: 'reject', tone: 'danger' };
  if (/timeout|timed|no.?response|discard|drop/.test(s)) return { result: 'timeout', tone: 'warning' };
  // Unrecognised vocabulary: keep the row (raw value survives in reason),
  // bucket it as timeout/warning rather than guess accept/reject.
  return { result: 'timeout', tone: 'warning' };
}

/** Method normalised to 802.1X / MAB / TACACS+; unfamiliar values pass through. */
export function authMethodFor(raw: string | null): string {
  const s = (raw ?? '').toLowerCase();
  if (!s) return '—';
  if (/tacacs/.test(s)) return 'TACACS+';
  if (/mab|mac.?auth/.test(s)) return 'MAB';
  if (/802\.1x|dot1x|eap/.test(s)) return '802.1X';
  return raw as string;
}

/** ClearPass auth-log row (Insight or legacy shape) → AuthEventRow (+ tsMs hint). */
export function mapClearPassAuthEvent(raw: unknown): ClearPassAuthEventRow | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const tsMs = parseTimestamp(r.timestamp ?? r.auth_time ?? r.time ?? r['@timestamp'] ?? r.logged_at ?? r.date);
  const who = str(r.username ?? r.user ?? r.auth_username ?? r.subject);
  const macRaw = str(r.mac ?? r.mac_address ?? r.endpoint_mac ?? r.calling_station_id ?? r.client_mac);
  if (!who && !macRaw) return null; // an auth event with no identity at all is junk
  const { result, tone } = authResultFor(str(r.result ?? r.auth_result ?? r.status ?? r.response ?? r.outcome));
  const role = str(r.role ?? r.enforcement_profile ?? r.enforcement_profiles ?? r.profile);
  return {
    time: tsMs !== null ? hhmm(tsMs) : '—',
    who: who ?? 'unknown',
    mac: macRaw ? normalizeMac(macRaw) : '—',
    service: str(r.service ?? r.service_name ?? r.policy_service) ?? '—',
    method: authMethodFor(str(r.auth_method ?? r.method ?? r.authentication_method ?? r.protocol)),
    result,
    tone,
    reason: str(r.reason ?? r.reject_reason ?? r.auth_details ?? r.message ?? r.detail) ?? '—',
    role: role ? `role ${role}` : 'no role assigned',
    nas: str(r.nas ?? r.nas_ip ?? r.nas_name ?? r.nas_identifier ?? r.source ?? r.nad) ?? '—',
    plane: 'CLEARPASS',
    ...(tsMs !== null ? { tsMs } : {}),
  };
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

class HttpStatusError extends Error {
  constructor(
    readonly status: number,
    path: string,
  ) {
    super(`HTTP ${status} from ${path}`);
    this.name = 'HttpStatusError';
  }
}

class SectionMissingError extends Error {
  constructor() {
    super("section 'authEvents': no candidate endpoint answered (all 404)");
    this.name = 'SectionMissingError';
  }
}

/** Payload keys the auth-log endpoints use, tried before the first-array heuristic. */
const PAYLOAD_KEYS = ['logs', 'events', 'items', 'results'];

/** Rows live under a well-known payload key, else the first array-valued key. */
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

function withScheme(base: string): string {
  return /^https?:\/\//i.test(base) ? base : `https://${base}`;
}

export class ClearPassAdapter implements PlaneAdapter {
  readonly id = 'clearpass' as const;

  private readonly baseUrl: string;
  private readonly token: string;
  /** Candidate path that worked (tried first next time). */
  private resolvedPath: string | null = null;

  constructor(
    creds: PlaneCredentials,
    private readonly stateRef: PlaneState,
    private readonly recordCall: RecordCallFn,
    private readonly fetchImpl: FetchLike = (url, init) => fetch(url, init),
  ) {
    if (!ClearPassAdapter.isComplete(creds)) {
      throw new Error('clearpass requires host and token');
    }
    this.baseUrl = withScheme(creds.host).replace(/\/+$/, '');
    this.token = creds.token;
  }

  static isComplete(creds: PlaneCredentials | null): boolean {
    return (
      !!creds &&
      [creds.host, creds.token].every((v) => typeof v === 'string' && v.trim().length > 0)
    );
  }

  state(): PlaneState {
    return this.stateRef;
  }

  async pull(): Promise<PlanePull> {
    let rows: unknown[];
    try {
      rows = await this.fetchAuthEvents();
    } catch (err) {
      if (err instanceof SectionMissingError) {
        throw new Error(
          "clearpass pull: section 'authEvents' failed — no auth-log endpoint answered (404 on every candidate)",
        );
      }
      throw new Error(`clearpass pull: section 'authEvents' failed — ${(err as Error).message}`);
    }

    // Newest first, capped — the screen shows the freshest decisions.
    const authEvents = rows
      .map(mapClearPassAuthEvent)
      .filter((e): e is ClearPassAuthEventRow => e !== null)
      .sort((a, b) => (b.tsMs ?? 0) - (a.tsMs ?? 0))
      .slice(0, MAX_AUTH_EVENTS);

    const rejects = authEvents.filter((e) => e.result === 'reject').length;
    this.stateRef.note =
      `${authEvents.length.toLocaleString('en-US')} auth events · ${rejects.toLocaleString('en-US')} rejects`;
    if (this.stateRef.health === 'warning') this.stateRef.health = 'healthy'; // first sync done

    return { authEvents };
  }

  /**
   * Trigger a CoA Disconnect-Request for an active session, by MAC — the one
   * sanctioned write on this read-only plane (CPPM SessionAction API, 6.8.7+):
   *   POST /api/session-action/disconnect/mac/{mac}
   * The caller decides what the HTTP code means; this adapter only promises a
   * timed, logged request. The MAC is normalised to aa:bb:cc:dd:ee:ff — the
   * vocabulary the auth feed already uses.
   */
  async coaDisconnect(mac: string): Promise<{ status: number; body: unknown }> {
    return this.post(`/api/session-action/disconnect/mac/${encodeURIComponent(normalizeMac(mac))}`, {});
  }

  // -- internals -------------------------------------------------------------

  /** Tolerate 404 by trying the next candidate path; remember the one that worked. */
  private async fetchAuthEvents(): Promise<unknown[]> {
    const resolved = this.resolvedPath;
    const candidates = resolved ? [resolved, ...CANDIDATES.filter((c) => c !== resolved)] : CANDIDATES;
    for (const path of candidates) {
      const res = await this.get(path);
      if (res.status === 404) continue; // Insight vs. legacy log APIs — try the next
      if (res.status < 200 || res.status >= 300) throw new HttpStatusError(res.status, path);
      this.resolvedPath = path;
      return extractRows(res.body);
    }
    throw new SectionMissingError();
  }

  /**
   * Timed outbound GET recorded in the plane's call log. The log carries
   * method + path + ms + status only — headers (and so the token) never.
   */
  private async get(path: string): Promise<{ status: number; body: unknown }> {
    const started = Date.now();
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: 'GET',
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${this.token}`,
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

  /**
   * Timed outbound POST recorded in the plane's call log — same rules as get():
   * the log carries method + path + ms + status only, never the token.
   */
  private async post(path: string, body: unknown): Promise<{ status: number; body: unknown }> {
    const started = Date.now();
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          authorization: `Bearer ${this.token}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(OUTBOUND_TIMEOUT_MS),
      });
    } catch (err) {
      this.recordCall({ path: `POST ${path}`, ms: Date.now() - started, code: 'network-error' });
      throw new Error(`POST ${path} failed: ${(err as Error).message}`);
    }
    this.recordCall({ path: `POST ${path}`, ms: Date.now() - started, code: String(res.status) });
    let parsed: unknown = null;
    try {
      parsed = await res.json();
    } catch {
      /* tolerate a non-JSON body — status is what we needed */
    }
    return { status: res.status, body: parsed };
  }
}
