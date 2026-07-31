/**
 * server/src/planes/clearpass.ts — HPE ClearPass (CPPM) adapter.
 *
 * The policy plane (README integration table: auth/accounting events,
 * endpoints, policy; read-only — policy is edited in ClearPass itself, the
 * portal never fakes an edit form). Auth logs are mapped into the shared
 * AuthEventRow so the poller cache and /api/auth-events can consume them, and
 * the endpoint repository total rides on the plane state as its device count.
 *
 * Auth (documented CPPM 6.x surface — "API Authorization / OAuth2" on
 * developer.arubanetworks.com/cppm): API clients mint their own token with
 *   POST /api/oauth   {grant_type: client_credentials, client_id, client_secret}
 * which answers {access_token, expires_in: 28800}. Tokens are cached via the
 * shared TokenManager (refresh at expiry−60s, single-flight, invalidate +
 * retry once on 401), exactly like central/greenlake/uxi. A pre-minted
 * `token` credential is still honoured as the legacy path — that one cannot
 * self-heal, so a 401 on it is NOT retried.
 * Credential keys: publisher (the key the connect drawer writes) / host /
 * baseUrl for the publisher node, then clientId + clientSecret, or token.
 *
 * Endpoint candidates (tried in order, 404 on one is tolerated by trying the
 * next and remembering which path worked). Both are documented CPPM 6.x REST
 * resources and both are the calls the design records for this plane
 * (design/NtSystems.dc.html:386-388):
 *
 *   section     candidates                          paging
 *   authEvents  /api/session                        offset/limit 100, filter
 *                                                   on acctstarttime, sort
 *                                                   -acctstarttime
 *               /api/insight/endpoint/auth-events   offset/limit 100 with an
 *                                                   epoch start/end window
 *   endpoints   /api/endpoint?limit=500             count only (the fact on
 *                                                   the Systems plane row)
 *
 * ASSUMPTION (unverifiable without a live CPPM): the Insight variant's window
 * parameters are `start_time`/`end_time` in epoch seconds, and /api/session
 * accepts CPPM's JSON `filter` vocabulary. A build that rejects either answers
 * 400/422 rather than 404, so the first page is retried once WITHOUT any query
 * string and the unparameterised style is remembered — an old build still
 * syncs, it just gets the vendor's default page.
 *
 * Failure policy (mirrors central):
 *   - 404 on every candidate → pull() fails naming the section — the auth feed
 *     is this plane's whole dataset, so there is nothing honest to degrade to.
 *   - a 200 whose payload has no readable row container → pull() fails naming
 *     the path. Reporting "0 auth events" for a body we could not parse would
 *     stamp an unreadable sync as a healthy quiet network (README honesty
 *     rule 1) — degraded is the truthful answer.
 *   - any other HTTP/network error → pull() throws naming the section, so the
 *     poller marks the plane degraded and keeps serving the last good cache.
 *   - the endpoint-count fetch is best-effort: it refreshes at most every 5
 *     minutes (the design's cadence) and a failure drops one fact, never the
 *     auth feed.
 *
 * Mapping decisions:
 *   - payload container: HAL first (`_embedded.items` — the container every
 *     CPPM collection answers with), then a well-known top-level list key,
 *     then a nested envelope, then the first array-valued key.
 *   - result forced onto the design's closed union: accept/success →
 *     accept (success); reject/denied/fail → reject (danger); timeout /
 *     no-response → timeout (warning). An unrecognised vocabulary keeps the
 *     row as timeout/warning AND carries the raw verdict into `reason`
 *     ('unmapped result: <raw>') — dropping data silently is worse than an
 *     imperfect bucket, and the operator must be able to see that the timeout
 *     is ours, not CPPM's. An accounting session row with no verdict at all is
 *     an accept: the session only exists because RADIUS already answered
 *     Access-Accept.
 *   - method normalised to 802.1X / MAB / TACACS+; unfamiliar values pass
 *     through unchanged.
 *   - mac normalised to aa:bb:cc:dd:ee:ff (any separator, any case); values
 *     that are not 12 hex digits pass through lowercased.
 *   - time: ISO/epoch → 'HH:MM:SS' local wall-clock (the design's and the
 *     fixtures' style — a burst of decisions inside one minute has to stay
 *     orderable by eye); the exact instant rides along as the tsMs hint so
 *     /api/auth-events can compute rates and the stats window without
 *     re-parsing display strings (same pattern as central's serial/mac
 *     identity hints).
 *   - role: enforcement profile → 'role <name>' (the fixtures' display
 *     language); none → 'no role assigned'.
 *   - rows with neither a username nor a MAC are junk → dropped.
 *   - newest 200 kept (dated rows sorted by tsMs descending) — the screen
 *     shows the freshest decisions; the feed can be far larger, so the request
 *     itself is windowed, sorted newest-first and paged only as deep as that
 *     cap. Rows whose timestamp key we did not recognise keep their arrival
 *     order BEHIND the dated ones (they cannot be placed on the timeline) and
 *     are counted in the plane note, so a build that renames the timestamp
 *     field loses visibility, never the rows themselves.
 *
 * Rate limits: 429 (and the transient 502/503/504 gateway statuses) are
 * retried with bounded exponential backoff, Retry-After honoured when CPPM
 * sends one. Every attempt is still recorded in the call log, so the Systems
 * Activity tab shows the real 429s (README:314) instead of a plane that just
 * flaps degraded once a minute.
 *
 * Security: the token travels in the Authorization header only, never in a
 * URL; client credentials live only in the /api/oauth POST body; the call log
 * records method + path + ms + status, never headers and never a body.
 */

import type { AuthEvent, AuthEventRow, Tone } from '@hpe/shared';
import { formatCount } from '@hpe/shared';
import type { PlaneCredentials } from '../config/settings';
import type { PlaneAdapter, PlaneCapabilities, PlanePull, PlaneState } from './types';
import {
  parseTimestamp,
} from './format';
import {
  TokenManager,
  mintedTokenInfo,
  parseRetryAfterMs,
  type FetchLike,
  type RecordCallFn,
  type SleepFn,
} from './transport';

const OUTBOUND_TIMEOUT_MS = 10_000;

/** 429/5xx backoff: attempts after the first, exponential floor, hard cap. */
const RATE_LIMIT_RETRIES = 2;
const RATE_LIMIT_BASE_MS = 1_000;
const RATE_LIMIT_CAP_MS = 30_000;
/** Statuses worth waiting out: a throttle or a gateway blip, not a verdict. */
const TRANSIENT_STATUSES = new Set([429, 502, 503, 504]);

const realSleep: SleepFn = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** The feed can be far larger than the screen's needs — keep the freshest. */
export const MAX_AUTH_EVENTS = 200;

/** Per-page size and the page cap, so a large tenant cannot stall a poll tick. */
const AUTH_PAGE_LIMIT = 100;
const AUTH_MAX_PAGES = 5;

/**
 * One read of the auth log, with whatever cut it short.
 *
 * The rows alone are not an answer. Three limits can stop this walk — the page
 * cap, the row cap, and a build that rejects the paging query and can only
 * ever serve page one — and a screen handed a short read with no note treats
 * the newest hundred decisions as the whole window. Every other paginating
 * plane here already declares this (see uxi.ts's `truncated`, mist.ts's and
 * central.ts's `partialDatasets`); ClearPass was the one that did not.
 */
interface AuthEventRead {
  rows: unknown[];
  /** What stopped the walk, for the plane note. null = the window was read. */
  truncated: string | null;
}

/** How far back the auth feed asks for — bounded, so the request stays cheap. */
const AUTH_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Documented CPPM token endpoint; expiry when the response omits expires_in. */
const TOKEN_PATH = '/api/oauth';
const TOKEN_DEFAULT_TTL_SEC = 28_800; // CPPM mints 8-hour tokens

/** Endpoint repository: the design pulls it every 5m with limit 500. */
const ENDPOINT_PATH = '/api/endpoint';
const ENDPOINT_PAGE_LIMIT = 500;
const ENDPOINT_REFRESH_MS = 5 * 60 * 1000;

/** One auth-log resource: its path and the query string for one page. */
interface AuthCandidate {
  path: string;
  query: (offset: number, limit: number, sinceMs: number, nowMs: number) => string;
}

const AUTH_CANDIDATES: AuthCandidate[] = [
  {
    // The documented, filterable, paged session resource (design records
    // `GET /api/session?filter=recent`).
    path: '/api/session',
    query: (offset, limit, sinceMs) => {
      const filter = JSON.stringify({ acctstarttime: { $gte: new Date(sinceMs).toISOString() } });
      return (
        `?filter=${encodeURIComponent(filter)}&sort=-acctstarttime` +
        `&offset=${offset}&limit=${limit}&calculate_count=true`
      );
    },
  },
  {
    // The Insight variant (design records `GET /api/insight/endpoint/auth-events`).
    path: '/api/insight/endpoint/auth-events',
    query: (offset, limit, sinceMs, nowMs) =>
      `?start_time=${Math.floor(sinceMs / 1000)}&end_time=${Math.ceil(nowMs / 1000)}` +
      `&offset=${offset}&limit=${limit}`,
  },
];

/** Whether the resolved path takes our paging vocabulary or must go bare. */
type ParamStyle = 'query' | 'bare';

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

/**
 * Local wall-clock 'HH:MM:SS' — the fixtures' and the design's display style
 * (design/NtAuthEvents.dc.html: '09:41:22'). Seconds are not decoration here:
 * the screen exists to expose bursts ('6th attempt in 4 minutes'), which
 * collapse into identical strings at minute precision.
 */
function hhmmss(ms: number): string {
  const d = new Date(ms);
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((v) => String(v).padStart(2, '0')).join(':');
}

/**
 * ClearPass result vocabulary → the design's closed union (+ badge tone).
 * `matched` says whether the bucket was earned or defaulted, so the caller can
 * carry the raw verdict into the row instead of presenting our fallback as
 * CPPM's own answer.
 */
export function authResultFor(raw: string | null): { result: AuthEvent['result']; tone: Tone; matched: boolean } {
  const s = (raw ?? '').toLowerCase();
  if (/accept|success|allow/.test(s)) return { result: 'accept', tone: 'success', matched: true };
  if (/reject|denied|deny|fail/.test(s)) return { result: 'reject', tone: 'danger', matched: true };
  if (/timeout|timed|no.?response|discard|drop/.test(s)) return { result: 'timeout', tone: 'warning', matched: true };
  // Unrecognised vocabulary: keep the row, bucket it as timeout/warning rather
  // than guess accept/reject — and say so (the raw value lands in `reason`).
  return { result: 'timeout', tone: 'warning', matched: false };
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

/** ClearPass auth row (Insight, /api/session accounting or legacy shape) → AuthEventRow. */
export function mapClearPassAuthEvent(raw: unknown): ClearPassAuthEventRow | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const tsMs = parseTimestamp(
    r.timestamp ??
      r.auth_time ??
      r.time ??
      r['@timestamp'] ??
      r.logged_at ??
      r.date ??
      r.acctstarttime ?? // /api/session: accounting start beats the update stamp
      r.acctupdatetimestamp ??
      r.start_time,
  );
  const who = str(r.username ?? r.user ?? r.auth_username ?? r.subject);
  const macRaw = str(r.mac ?? r.mac_address ?? r.macaddress ?? r.endpoint_mac ?? r.calling_station_id ?? r.client_mac);
  if (!who && !macRaw) return null; // an auth event with no identity at all is junk
  const rawResult = str(r.result ?? r.auth_result ?? r.status ?? r.response ?? r.outcome ?? r.auth_status);
  // An /api/session row is an accounting session: it exists only because RADIUS
  // already answered Access-Accept, so an absent verdict there is an accept —
  // bucketing it as 'timeout' would report a live network at a 0% accept rate.
  const isSession = r.acctsessionid !== undefined || r.acctstarttime !== undefined;
  const { result, tone, matched } = authResultFor(rawResult ?? (isSession ? 'accept' : null));
  const role = str(r.role ?? r.enforcement_profile ?? r.enforcement_profiles ?? r.profile);
  const reported = str(r.reason ?? r.reject_reason ?? r.auth_details ?? r.error_message ?? r.message ?? r.detail);
  // A verdict we could not classify is bucketed as timeout — the evidence for
  // that call has to travel with the row, or the operator reads a fabricated
  // timeout with no way back to what CPPM actually said.
  const unmapped = !matched && rawResult !== null ? `unmapped result: ${rawResult}` : null;
  return {
    time: tsMs !== null ? hhmmss(tsMs) : '—',
    // The instant as well as this host's rendering of it: the reader may be
    // in another timezone, and HH:MM:SS alone does not say whose.
    ...(tsMs !== null ? { at: new Date(tsMs).toISOString() } : {}),
    who: who ?? 'unknown',
    mac: macRaw ? normalizeMac(macRaw) : '—',
    service: str(r.service ?? r.service_name ?? r.policy_service) ?? '—',
    method: authMethodFor(str(r.auth_method ?? r.method ?? r.authentication_method ?? r.auth_type ?? r.protocol)),
    result,
    tone,
    reason: [reported, unmapped].filter((v): v is string => v !== null).join(' · ') || '—',
    role: role ? `role ${role}` : 'no role assigned',
    nas: str(r.nas ?? r.nas_ip ?? r.nasipaddress ?? r.nas_name ?? r.nas_identifier ?? r.source ?? r.nad) ?? '—',
    plane: 'CLEARPASS',
    ...(tsMs !== null ? { tsMs } : {}),
  };
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

/**
 * One outbound response. `retryAfterMs` is additive — callers that only read
 * { status, body } (coaDisconnect) are unaffected; only the backoff consumes it.
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
    // A throttle that survived the backoff is not "CPPM said no" — name it, so
    // the plane note reads 'rate limited' rather than a bare HTTP code.
    super(`HTTP ${status} from ${path}${status === 429 ? ' — rate limited, backoff exhausted' : ''}`);
    this.name = 'HttpStatusError';
  }
}

class SectionMissingError extends Error {
  constructor() {
    super("section 'authEvents': no candidate endpoint answered (all 404)");
    this.name = 'SectionMissingError';
  }
}

/** A 200 we could not read: never reported as an empty (healthy) feed. */
class UnreadablePayloadError extends Error {
  constructor(path: string) {
    super(`200 from ${path} but no row container in the payload (no _embedded.items, no known list key)`);
    this.name = 'UnreadablePayloadError';
  }
}

/** Payload keys the auth-log endpoints use, tried before the first-array heuristic. */
const PAYLOAD_KEYS = ['logs', 'events', 'items', 'results', 'rows', 'sessions', 'endpoints', 'data'];

/** Objects that wrap the row container one level down (HAL first). */
const ENVELOPE_KEYS = ['_embedded', 'data', 'result', 'results', 'response'];

/** A well-known payload key wins over an incidental array (e.g. `errors: []`). */
function firstArrayIn(r: Record<string, unknown>): unknown[] | null {
  for (const k of PAYLOAD_KEYS) {
    if (Array.isArray(r[k])) return r[k];
  }
  for (const v of Object.values(r)) {
    if (Array.isArray(v)) return v;
  }
  return null;
}

/**
 * Rows out of a collection body, or null when the payload carries no row
 * container at all — the caller turns that into a failed section rather than
 * an empty feed. A HAL page that legitimately has nothing (`{count: 0,
 * _links: {…}}` — CPPM omits `_embedded` when the page is empty) is an honest
 * empty list, not an unreadable body.
 */
export function extractRows(body: unknown): unknown[] | null {
  if (Array.isArray(body)) return body;
  if (body && typeof body === 'object') {
    const r = body as Record<string, unknown>;
    for (const k of PAYLOAD_KEYS) {
      if (Array.isArray(r[k])) return r[k];
    }
    // HAL: CPPM answers collections as {count, _links, _embedded: {items: […]}}
    for (const k of ENVELOPE_KEYS) {
      const nested = r[k];
      if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
        const rows = firstArrayIn(nested as Record<string, unknown>);
        if (rows) return rows;
      }
    }
    for (const v of Object.values(r)) {
      if (Array.isArray(v)) return v;
    }
    if (r._links !== undefined || num(r.count) !== null) return []; // an empty HAL page
  }
  return null;
}

/** Repository total when the body states one; null when it cannot be proven. */
function extractTotal(body: unknown, rows: unknown[], pageLimit: number): number | null {
  const r = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const total = num(r.total ?? r.total_count ?? r.item_count ?? r.count);
  if (total !== null && total > rows.length) return total; // an explicit repository total
  if (rows.length < pageLimit) return rows.length; // the whole repository fitted in one page
  // A full page whose `count` only describes the page itself proves nothing
  // about the repository size — say nothing rather than report the page as it.
  return null;
}

function withScheme(base: string): string {
  return /^https?:\/\//i.test(base) ? base : `https://${base}`;
}

function filled(v: unknown): boolean {
  return typeof v === 'string' && v.trim().length > 0;
}

export class ClearPassAdapter implements PlaneAdapter {
  readonly id = 'clearpass' as const;

  private readonly baseUrl: string;
  /** Legacy pre-minted token; null when the adapter mints its own. */
  private readonly staticToken: string | null;
  /** OAuth token manager; null on the legacy static-token path. */
  private readonly tokens: TokenManager | null;
  /** Optional CoA enforcement profile (only sent when configured). */
  private readonly coaEnforcementProfile: string | null;
  /** Candidate that worked, with the param style it accepted (tried first next time). */
  private resolvedAuth: { candidate: AuthCandidate; paramStyle: ParamStyle } | null = null;
  /** Endpoint repository total and when it was last proven (5m cadence). */
  private endpointCount: number | null = null;
  private endpointCountAtMs = 0;

  constructor(
    creds: PlaneCredentials,
    private readonly stateRef: PlaneState,
    private readonly recordCall: RecordCallFn,
    private readonly fetchImpl: FetchLike = (url, init) => fetch(url, init),
    /** Injectable so tests exercise the backoff without real wall time. */
    private readonly sleep: SleepFn = realSleep,
  ) {
    if (!ClearPassAdapter.isComplete(creds)) {
      throw new Error('clearpass requires a publisher (or host) plus clientId + clientSecret, or a token');
    }
    // 'publisher' is the key the connect drawer writes (README:322, and the
    // design's own credential record); host/baseUrl stay accepted.
    const host = [creds.publisher, creds.host, creds.baseUrl].find(filled) as string;
    this.baseUrl = withScheme(host).replace(/\/+$/, '');
    this.coaEnforcementProfile = filled(creds.coaEnforcementProfile) ? creds.coaEnforcementProfile : null;
    this.staticToken = filled(creds.token) && !ClearPassAdapter.hasOauthCreds(creds) ? creds.token : null;
    this.tokens = ClearPassAdapter.hasOauthCreds(creds)
      ? new TokenManager(async () => {
          const res = await this.http('POST', TOKEN_PATH, {
            body: {
              grant_type: 'client_credentials',
              client_id: creds.clientId,
              client_secret: creds.clientSecret,
            },
          });
          const record = res.body && typeof res.body === 'object' ? (res.body as Record<string, unknown>) : {};
          const token = str(record.access_token);
          if (res.status !== 200 || !token) {
            throw new Error(`auth: ${TOKEN_PATH} answered HTTP ${res.status} without an access_token`);
          }
          // CPPM's 8-hour grant expires; the registry only knew the source, so
          // stamp the expiry here. No expires_in in the answer = no published
          // lifetime, and the default below stays a refresh-pacing choice only.
          const published = num(record.expires_in);
          this.stateRef.token = mintedTokenInfo(published);
          return { accessToken: token, expiresInSec: published ?? TOKEN_DEFAULT_TTL_SEC };
        })
      : null;
  }

  /** API-client credentials — the path a real CPPM expects (POST /api/oauth). */
  private static hasOauthCreds(creds: PlaneCredentials): boolean {
    return filled(creds.clientId) && filled(creds.clientSecret);
  }

  static isComplete(creds: PlaneCredentials | null): boolean {
    if (!creds) return false;
    const host = filled(creds.publisher) || filled(creds.host) || filled(creds.baseUrl);
    return host && (ClearPassAdapter.hasOauthCreds(creds) || filled(creds.token));
  }

  state(): PlaneState {
    return this.stateRef;
  }

  /**
   * ClearPass is a policy plane, not a transport: it gives the portal no shell
   * to any device, the write broker cannot push configuration to it (policy is
   * edited in ClearPass itself — README integration table), and it publishes
   * no SSID/VLAN/port inventory. The one sanctioned write is coaDisconnect(),
   * which is a session action, not a configuration push.
   */
  capabilities(): PlaneCapabilities {
    return { localShell: false, brokeredWrite: false, configRead: false };
  }

  async pull(): Promise<PlanePull> {
    let read: AuthEventRead;
    try {
      read = await this.fetchAuthEvents();
    } catch (err) {
      if (err instanceof SectionMissingError) {
        throw new Error(
          "clearpass pull: section 'authEvents' failed — no auth-log endpoint answered (404 on every candidate)",
        );
      }
      throw new Error(`clearpass pull: section 'authEvents' failed — ${(err as Error).message}`);
    }

    // Newest first, capped — the screen shows the freshest decisions. A row
    // whose timestamp key we did not recognise cannot be placed on that
    // timeline, but it is still a real decision: keep it in arrival order
    // behind the dated rows rather than sorting it to the back of a 200-row
    // cap that then throws it away silently.
    const mapped = read.rows.map(mapClearPassAuthEvent).filter((e): e is ClearPassAuthEventRow => e !== null);
    const dated = mapped.filter((e) => e.tsMs !== undefined).sort((a, b) => (b.tsMs as number) - (a.tsMs as number));
    const undated = mapped.filter((e) => e.tsMs === undefined);
    const authEvents = [...dated, ...undated].slice(0, MAX_AUTH_EVENTS);
    const undatedShown = authEvents.filter((e) => e.tsMs === undefined).length;
    // The slice above is a fourth way to come up short: rows that were read
    // and then dropped are as absent from the screen as rows never fetched.
    const truncated = read.truncated ?? (mapped.length > authEvents.length ? `row cap ${MAX_AUTH_EVENTS}` : null);

    // The endpoint repository is the plane's second dataset (README:465) and a
    // slower pull (design: every 5m); it never fails the auth feed.
    await this.refreshEndpointCount();

    const rejects = authEvents.filter((e) => e.result === 'reject').length;
    const parts = [
      ...(this.endpointCount !== null ? [`${formatCount(this.endpointCount)} endpoints`] : []),
      `${formatCount(authEvents.length)} auth events`,
      `${formatCount(rejects)} rejects`,
      // Undated rows are kept but cannot be ordered or counted per minute —
      // the gap belongs on the Systems row, not in silence.
      ...(undatedShown > 0 ? [`${formatCount(undatedShown)} without timestamps`] : []),
      // Both counts above describe what was read. Left unqualified they
      // describe the window, and '4 rejects' out of the newest 200 of an
      // unknown number is a different fact from '4 rejects in the last hour'.
      ...(truncated !== null ? [`window truncated (${truncated})`] : []),
    ];
    this.stateRef.note = parts.join(' · ');
    if (this.stateRef.health === 'warning') this.stateRef.health = 'healthy'; // first sync done

    return truncated !== null ? { authEvents, partial: ['authEvents'] } : { authEvents };
  }

  /**
   * Trigger a CoA Disconnect-Request for an active session, by MAC — the one
   * sanctioned write on this read-only plane (CPPM SessionAction API, 6.8.7+):
   *   POST /api/session-action/disconnect/mac/{mac}
   * The vendor operation requires `async` in the body; `enforcement_profile`
   * is only sent when the operator configured one (an unknown profile name
   * turns a working disconnect into a 422). The caller decides what the HTTP
   * code means; this adapter only promises a timed, logged request. The MAC is
   * normalised to aa:bb:cc:dd:ee:ff — the vocabulary the auth feed uses.
   */
  async coaDisconnect(mac: string): Promise<{ status: number; body: unknown }> {
    const body: Record<string, unknown> = { async: false };
    if (this.coaEnforcementProfile) body.enforcement_profile = this.coaEnforcementProfile;
    return this.authed('POST', `/api/session-action/disconnect/mac/${encodeURIComponent(normalizeMac(mac))}`, body);
  }

  // -- internals -------------------------------------------------------------

  /**
   * Page one auth-log resource, tolerating 404 by trying the next candidate and
   * a 400/422 by retrying the first page unparameterised. Remembers the path
   * AND the param style that worked.
   */
  private async fetchAuthEvents(): Promise<AuthEventRead> {
    const now = Date.now();
    const since = now - AUTH_WINDOW_MS;
    const resolved = this.resolvedAuth;
    const candidates = resolved
      ? [resolved.candidate, ...AUTH_CANDIDATES.filter((c) => c !== resolved.candidate)]
      : AUTH_CANDIDATES;

    for (const candidate of candidates) {
      let paramStyle: ParamStyle = resolved?.candidate === candidate ? resolved.paramStyle : 'query';
      const urlFor = (offset: number): string =>
        paramStyle === 'query'
          ? `${candidate.path}${candidate.query(offset, AUTH_PAGE_LIMIT, since, now)}`
          : candidate.path;

      let firstPath = urlFor(0);
      let first = await this.authedGet(firstPath);
      // A build that does not know our paging/filter vocabulary rejects the
      // query, not the resource — ask again bare rather than degrade the plane.
      if ((first.status === 400 || first.status === 422) && paramStyle === 'query') {
        paramStyle = 'bare';
        firstPath = urlFor(0);
        first = await this.authedGet(firstPath);
      }
      if (first.status === 404) continue; // release variance — try the next resource
      if (first.status < 200 || first.status >= 300) throw new HttpStatusError(first.status, firstPath);

      const rows = rowsOrThrow(first.body, firstPath);
      let lastPageSize = rows.length;
      let page = 1;
      while (
        paramStyle === 'query' &&
        page < AUTH_MAX_PAGES &&
        rows.length < MAX_AUTH_EVENTS &&
        lastPageSize >= AUTH_PAGE_LIMIT
      ) {
        const path = urlFor(rows.length);
        const res = await this.authedGet(path);
        // Page 1 worked, so the path is valid: a failure here fails the section.
        if (res.status < 200 || res.status >= 300) throw new HttpStatusError(res.status, path);
        const pageRows = rowsOrThrow(res.body, path);
        // An empty page is the end of the feed, not a walk cut short — record
        // it as such or the check below reads the previous full page and
        // reports a complete read as truncated.
        if (pageRows.length === 0) {
          lastPageSize = 0;
          break;
        }
        rows.push(...pageRows);
        lastPageSize = pageRows.length;
        page += 1;
      }
      this.resolvedAuth = { candidate, paramStyle };
      /* A walk that ended while its last page was still full means the window
         holds more decisions than were read — whichever of the three limits
         stopped it. In 'bare' style the loop never runs at all: the build
         rejected our paging vocabulary, so page one is everything the portal
         can ever get from it, and a full page one is the only hint that more
         exists. */
      const truncated =
        lastPageSize < AUTH_PAGE_LIMIT ? null
        : paramStyle === 'bare' ? 'this build does not accept paging parameters'
        : rows.length >= MAX_AUTH_EVENTS ? `row cap ${MAX_AUTH_EVENTS}`
        : `page cap ${AUTH_MAX_PAGES}`;
      return { rows, truncated };
    }
    throw new SectionMissingError();
  }

  /**
   * The endpoint repository total (the 'Endpoints' fact and the plane's device
   * count). Best-effort by design: refreshed at most every 5 minutes, and any
   * failure leaves the previous answer alone instead of failing the poll.
   */
  private async refreshEndpointCount(): Promise<void> {
    const now = Date.now();
    if (this.endpointCount !== null && now - this.endpointCountAtMs < ENDPOINT_REFRESH_MS) return;
    const path = `${ENDPOINT_PATH}?offset=0&limit=${ENDPOINT_PAGE_LIMIT}&calculate_count=true`;
    try {
      const res = await this.authedGet(path);
      if (res.status < 200 || res.status >= 300) return; // one fact unavailable; auth feed unaffected
      const rows = extractRows(res.body);
      if (rows === null) return; // unreadable — say nothing rather than report 0 endpoints
      const total = extractTotal(res.body, rows, ENDPOINT_PAGE_LIMIT);
      if (total === null) return;
      this.endpointCount = total;
      this.endpointCountAtMs = now;
      this.stateRef.deviceCount = total;
    } catch {
      /* network error on a secondary fact — the auth feed is what pull() owes */
    }
  }

  /** The bearer for the next call: a managed (minted) token, or the legacy static one. */
  private async authToken(): Promise<string> {
    return this.tokens ? this.tokens.get() : (this.staticToken as string);
  }

  /**
   * Authenticated request. A minted token is invalidated and retried once on a
   * 401 (CPPM tokens expire after 8 hours); a static token is NOT retried —
   * it cannot self-heal, so the plane must degrade and say so.
   */
  private async authed(method: 'GET' | 'POST', path: string, body?: unknown): Promise<HttpResult> {
    let res = await this.http(method, path, { token: await this.authToken(), body });
    if (res.status === 401 && this.tokens) {
      this.tokens.invalidate();
      res = await this.http(method, path, { token: await this.authToken(), body });
    }
    return res;
  }

  /**
   * Authenticated GET with a bounded backoff on a throttle (429) or a gateway
   * blip (502/503/504): Retry-After wins over the exponential floor, capped so
   * a poll tick can never be held hostage. Only reads are retried — the one
   * write on this plane (coaDisconnect) is the caller's decision, not ours.
   * Every attempt is recorded, so the Activity tab shows the real 429s.
   */
  private async authedGet(path: string): Promise<HttpResult> {
    for (let attempt = 0; ; attempt += 1) {
      const res = await this.authed('GET', path);
      if (!TRANSIENT_STATUSES.has(res.status) || attempt >= RATE_LIMIT_RETRIES) return res;
      const backoffMs = RATE_LIMIT_BASE_MS * 2 ** attempt;
      await this.sleep(Math.min(res.retryAfterMs ?? backoffMs, RATE_LIMIT_CAP_MS));
    }
  }

  /**
   * Timed outbound call recorded in the plane's call log. The log carries
   * method + path + ms + status only — headers (so the token) and bodies (so
   * the client secret) never.
   */
  private async http(
    method: 'GET' | 'POST',
    path: string,
    opts: { token?: string; body?: unknown } = {},
  ): Promise<HttpResult> {
    const started = Date.now();
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: {
          accept: 'application/json',
          ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
        },
        ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
        signal: AbortSignal.timeout(OUTBOUND_TIMEOUT_MS),
      });
    } catch (err) {
      this.recordCall({ path: `${method} ${path}`, ms: Date.now() - started, code: 'network-error' });
      throw new Error(`${method} ${path} failed: ${(err as Error).message}`);
    }
    this.recordCall({ path: `${method} ${path}`, ms: Date.now() - started, code: String(res.status) });
    let parsed: unknown = null;
    try {
      parsed = await res.json();
    } catch {
      /* tolerate a non-JSON body — status is what we needed */
    }
    // Additive field: existing callers ({ status, body }) are unaffected.
    const retryAfterMs = parseRetryAfterMs(res.headers.get('retry-after'));
    return { status: res.status, body: parsed, ...(retryAfterMs !== null ? { retryAfterMs } : {}) };
  }
}

/** Rows, or a failed section: a 200 we cannot read is never an empty feed. */
function rowsOrThrow(body: unknown, path: string): unknown[] {
  const rows = extractRows(body);
  if (rows === null) throw new UnreadablePayloadError(path);
  return rows;
}
