/**
 * server/src/planes/clearpass.ts — HPE ClearPass (CPPM) adapter.
 *
 * The policy plane (README integration table: auth/accounting events,
 * endpoints, policy). Policy itself is edited in ClearPass itself — the
 * portal never fakes an edit form — but the endpoint repository and the
 * local-user list take REVIEWED direct writes (endpoint register/update,
 * local-user create/update) through services/clearpassDirectWrite.ts, audited
 * like every other write and carrying password material nowhere but the
 * outbound request body. Auth logs are mapped into the shared AuthEventRow so
 * the poller cache and /api/auth-events can consume them, and the endpoint
 * repository total rides on the plane state as its device count.
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
 *   services    /api/config/service, then           offset/limit 100 HAL walk
 *               /api/service (pre-6.11 builds)
 *
 * One service's FULL object (GET {service path}/{id}, same candidate order)
 * is the Services-tab drawer's on-demand read — serviceDetail(), TTL-cached
 * and never poller work, per the PlaneAdapter on-demand contract.
 *
 * Policy inventories (the plane's remaining datasets — NADs, auth sources,
 * roles, enforcement policies/profiles, local users, services and device
 * groups off /api/network-device, /api/auth-source, /api/role,
 * /api/enforcement-policy, /api/enforcement-profile, /api/local-user, the
 * service candidates above and /api/device-group) each get the same paged
 * HAL walk as the endpoint detail rows, on the same 5-minute cadence. Every
 * dataset is independently fault-tolerant: a failure omits its PlanePull key
 * and names it in `partial`, never sinks the pull. Verified against a live
 * CPPM 6.11.12 (Super Admin client): /api/config/service answers 200 (and
 * /api/config/service/{id} a full service object) while /api/service 404s —
 * so the config namespace is tried first, the legacy path is the fallback,
 * and only a box that 404s BOTH reports services as "not available on this
 * CPPM" (the key absent with NO partial flag). /api/device-group 404s even
 * on 6.11, so it keeps the same both-404-honest rule on its single path.
 * Every other failure, and any failure on the resources CPPM does serve, IS
 * a partial read. The local-user read is strictly whitelisted — no password
 * hash may ride a row the portal serves, and the service read is whitelisted
 * the same way: nothing in a service definition is credential material.
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

import type {
  AuthEvent,
  AuthEventRow,
  ClearPassAuthSourceRow,
  ClearPassDeviceGroupRow,
  ClearPassEndpointRegisterForm,
  ClearPassEndpointUpdateForm,
  ClearPassEnforcementPolicyRow,
  ClearPassEnforcementProfileRow,
  ClearPassLocalUserCreateForm,
  ClearPassLocalUserRow,
  ClearPassLocalUserUpdateForm,
  ClearPassNetworkDeviceRow,
  ClearPassRoleRow,
  ClearPassServiceDetail,
  ClearPassServiceDetailLive,
  ClearPassServiceDetailSection,
  ClearPassServiceRow,
  ClearPassWriteResult,
  DetailFetchState,
  EndpointRow,
  PlaneDatasetKey,
  Tone,
} from '@hpe/shared';
import { formatCount } from '@hpe/shared';
import * as https from 'node:https';
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
  httpsBase,
} from './transport';

const OUTBOUND_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// Default transport: node:https so per-connection TLS verification can be
// relaxed for a lab CPPM's self-signed cert (global fetch/undici offers no
// per-call switch without an undici Agent dependency) — identical to
// aoscx.ts's copy, duplicated rather than shared because each adapter owns its
// own transport choice. Set creds.verifyTls = 'true' to enforce chain
// verification; default OFF matches every other device adapter.
// Exported so the connection test (routes/systems.ts) validates credentials
// down the exact path the adapter dials.
// ---------------------------------------------------------------------------

export function httpsFetch(verifyTls: boolean): FetchLike {
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
            const headers = new Headers();
            for (let i = 0; i + 1 < res.rawHeaders.length; i += 2) {
              try {
                headers.append(res.rawHeaders[i], res.rawHeaders[i + 1]);
              } catch {
                /* a header this runtime refuses is dropped, never fatal */
              }
            }
            resolve(new Response(Buffer.concat(chunks), { status, headers }));
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

/** Local-user collection: the reviewed-write surface alongside /api/endpoint. */
const LOCAL_USER_PATH = '/api/local-user';

/** Endpoint DETAIL rows for the ClearPass screen: paged at 100/call, capped at
 *  500 total — a best-effort read (README second dataset), never fatal to the
 *  auth feed pull() otherwise returns. */
export const MAX_ENDPOINTS = 500;
const ENDPOINT_DETAIL_PAGE_LIMIT = 100;

/** Policy-inventory reads: the same paged HAL walk as the endpoint detail
 *  read (100/page, capped at 500) on the same 5-minute cadence
 *  (ENDPOINT_REFRESH_MS) — roles, policies and NADs are the repository's
 *  slow-moving neighbours, not a 60-second dataset. */
const INVENTORY_PAGE_LIMIT = 100;
const INVENTORY_MAX_ROWS = 500;

/**
 * Service-collection candidates, tried in order. Verified against a live
 * CPPM 6.11.12 (Super Admin client): the config namespace answers 200 while
 * the legacy path 404s with the guest portal's HTML page; older 6.x builds
 * answer the legacy path, so it stays as the fallback. A box that 404s BOTH
 * does not expose the collection at all.
 */
const SERVICE_PATHS = ['/api/config/service', '/api/service'] as const;

/**
 * The on-demand service DETAIL read (drawer path, not the poller): TTL +
 * cache cap, the same shape central's detail cache keeps. Long enough that
 * re-opening a drawer costs no CPPM call; small enough that a service
 * edited in CPPM is not stale for long.
 */
const SERVICE_DETAIL_TTL_MS = 45_000;
const SERVICE_DETAIL_CACHE_MAX = 64;

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

function bool(v: unknown): boolean | null {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (s === 'true') return true;
    if (s === 'false') return false;
  }
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

/**
 * The canonical MAC normalizer lives in shared/logic.ts: the roster's client
 * dedupe, the auth-event join and the Client 360 correlation must agree on
 * what "the same endpoint" means, so there is exactly one implementation.
 * Re-exported here so this module's existing importers keep working.
 */
export { normalizeMac } from '@hpe/shared';
import { normalizeMac } from '@hpe/shared';

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

/**
 * One /api/endpoint row → EndpointRow. CPPM's endpoint object nests profiling
 * facts under `attributes` (Category/Family/OS/'Device Name'/'IP Address'/
 * 'Updated At') rather than as top-level fields — a build that omits one
 * leaves the corresponding column null rather than guessing. Three facts are
 * NOT in attributes: `description` (the operator's own note) and `updated_at`
 * (the repository's change stamp — CPPM's 'Aug 06, 2025 11:32:01 CDT'
 * display string, kept verbatim as the updatedAt fallback so a row that
 * carries it never reports null) are top-level, and `device_insight_tags` is
 * Device Insight's free-text categorisation — the profiler's evidence list,
 * kept separate from the enforcement `profile` it often echoes.
 */
export function mapClearPassEndpoint(raw: unknown): EndpointRow | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const macRaw = str(r.mac_address ?? r.mac ?? r.macaddress);
  const id = str(r.id ?? r.endpoint_id) ?? macRaw;
  if (!id) return null; // no identity at all — not a real row
  const attrs = r.attributes && typeof r.attributes === 'object' ? (r.attributes as Record<string, unknown>) : {};
  const status = str(r.status) ?? 'Unknown';
  const insightTags = Array.isArray(r.device_insight_tags)
    ? r.device_insight_tags.map(str).filter((t): t is string => t !== null)
    : [];
  return {
    id,
    mac: macRaw ? normalizeMac(macRaw) : '—',
    description: str(r.description),
    ip: str(attrs['IP Address']),
    hostname: str(attrs['Device Name']),
    status: status as EndpointRow['status'],
    category: str(attrs.Category),
    family: str(attrs.Family),
    os: str(attrs.OS),
    profile: str(r.enforcement_profile ?? r.enforcement_profiles ?? attrs.Profile ?? attrs['Enforcement Profile']),
    updatedAt: str(attrs['Updated At']) ?? str(r.updated_at),
    ...(insightTags.length > 0 ? { insightTags } : {}),
  };
}

// ---------------------------------------------------------------------------
// Policy-inventory row mapping — the plane's smaller collections, same
// defensive reading as the endpoint mapper (pure, exported for tests)
// ---------------------------------------------------------------------------

/** One /api/network-device row → a NAD. A device with no name is junk. */
export function mapClearPassNetworkDevice(raw: unknown): ClearPassNetworkDeviceRow | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const name = str(r.name ?? r.nad_name ?? r.hostname);
  if (!name) return null;
  return {
    id: str(r.id) ?? name,
    name,
    ipAddress: str(r.ip_address ?? r.ip ?? r.ipaddr),
    vendorName: str(r.vendor_name ?? r.vendor),
    coaCapable: bool(r.coa_capable),
    radsecEnabled: bool(r.radsec_enabled),
    description: str(r.description),
  };
}

/** One /api/auth-source row. A source with no name is junk. */
export function mapClearPassAuthSource(raw: unknown): ClearPassAuthSourceRow | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const name = str(r.name ?? r.source_name);
  if (!name) return null;
  return {
    id: str(r.id) ?? name,
    name,
    type: str(r.type),
    description: str(r.description),
  };
}

/** One /api/role row. A role with no name is junk. */
export function mapClearPassRole(raw: unknown): ClearPassRoleRow | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const name = str(r.name ?? r.role_name);
  if (!name) return null;
  return {
    id: str(r.id) ?? name,
    name,
    description: str(r.description),
  };
}

/** One /api/enforcement-policy row. A policy with no name is junk. */
export function mapClearPassEnforcementPolicy(raw: unknown): ClearPassEnforcementPolicyRow | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const name = str(r.name ?? r.policy_name);
  if (!name) return null;
  return {
    id: str(r.id) ?? name,
    name,
    enforcementType: str(r.enforcement_type),
    defaultProfile: str(r.default_profile ?? r.default_enforcement_profile),
  };
}

/** One /api/enforcement-profile row. A profile with no name is junk. */
export function mapClearPassEnforcementProfile(raw: unknown): ClearPassEnforcementProfileRow | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const name = str(r.name ?? r.profile_name);
  if (!name) return null;
  return {
    id: str(r.id) ?? name,
    name,
    type: str(r.type),
    description: str(r.description),
  };
}

/**
 * One /api/local-user row → ClearPassLocalUserRow. STRICTLY whitelisted —
 * the fields above are read by name and nothing else crosses, so no
 * password hash or secret of any kind can ride a row the poller cache and
 * the screens will serve. A row without user_id is junk.
 */
export function mapClearPassLocalUser(raw: unknown): ClearPassLocalUserRow | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const userId = str(r.user_id);
  if (!userId) return null;
  return {
    id: str(r.id) ?? userId,
    userId,
    username: str(r.username ?? r.name),
    roleName: str(r.role_name ?? r.role),
    enabled: bool(r.enabled),
  };
}

/**
 * rules_conditions → one readable line: each condition as
 * 'Type:Name OPERATOR value' ('Connection:NAD-IP-Address EQUALS 127.0.0.1'),
 * conditions joined ' · '. A condition with nothing readable is skipped;
 * nothing readable at all degrades the FIELD to null — the screen never gets
 * raw JSON, and the row never dies over a summary.
 */
export function summarizeServiceRules(rules: unknown): string | null {
  if (!Array.isArray(rules)) return null;
  const parts = rules
    .map((c) => {
      if (!c || typeof c !== 'object') return null;
      const cond = c as Record<string, unknown>;
      const target = [str(cond.type), str(cond.name)].filter((v): v is string => v !== null).join(':');
      const clause = [target || null, str(cond.operator), ruleValue(cond.value)]
        .filter((v): v is string => v !== null)
        .join(' ');
      return clause.length > 0 ? clause : null;
    })
    .filter((v): v is string => v !== null);
  return parts.length > 0 ? parts.join(' · ') : null;
}

/** A condition value: a scalar, or a list joined readably. */
function ruleValue(v: unknown): string | null {
  if (Array.isArray(v)) {
    const parts = v.map(str).filter((x): x is string => x !== null);
    return parts.length > 0 ? parts.join(', ') : null;
  }
  return str(v);
}

/** Names out of a list of plain strings or {name} objects — [] when nothing
 *  is readable (auth_sources and auth_methods share the wire shape). */
function serviceNameList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((s) => (s && typeof s === 'object' ? str((s as Record<string, unknown>).name) : str(s)))
    .filter((x): x is string => x !== null);
}

/** auth_sources names — present only when the row names them readably. */
function serviceAuthSources(v: unknown): string[] | undefined {
  const names = serviceNameList(v);
  return names.length > 0 ? names : undefined;
}

/**
 * One /api/config/service (6.11+) or /api/service (older 6.x) row. The base
 * shape every build answers is { id, name, type, description }; the 6.11
 * fields ride along only when the row carries them — present-but-unreadable
 * degrades that field to null, absent omits the key entirely, so an older
 * build's row keeps its exact older shape. Read by name, the same whitelist
 * discipline as the local-user row: a service definition holds no credential
 * material, and no future field can cross uninvited. A service with no name
 * is junk.
 */
export function mapClearPassService(raw: unknown): ClearPassServiceRow | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const name = str(r.name ?? r.service_name);
  if (!name) return null;
  const authSources = serviceAuthSources(r.auth_sources ?? r.authSources);
  return {
    id: str(r.id) ?? name,
    name,
    type: str(r.type),
    description: str(r.description),
    ...('template' in r ? { template: str(r.template) } : {}),
    ...('enabled' in r ? { enabled: bool(r.enabled) } : {}),
    ...('hit_count' in r ? { hitCount: num(r.hit_count) } : {}),
    ...('order_no' in r ? { orderNo: num(r.order_no) } : {}),
    ...(authSources ? { authSources } : {}),
    ...('rules_conditions' in r ? { rulesSummary: summarizeServiceRules(r.rules_conditions) } : {}),
  };
}

/**
 * One rules_conditions entry → the rule editor's row. Every field degrades
 * to null independently; a condition with NOTHING readable is junk and
 * dropped, so the drawer's table only ever shows rows that say something.
 */
function mapServiceRuleCondition(raw: unknown): ClearPassServiceDetail['rulesConditions'][number] | null {
  if (!raw || typeof raw !== 'object') return null;
  const c = raw as Record<string, unknown>;
  const out = {
    type: str(c.type),
    name: str(c.name),
    operator: str(c.operator),
    value: ruleValue(c.value),
  };
  return out.type !== null || out.name !== null || out.operator !== null || out.value !== null ? out : null;
}

/**
 * The full service object from GET /api/config/service/{id} (verified
 * against a live CPPM 6.11.12: every field of ClearPassServiceDetail plus
 * `_links`, which the whitelist drops). The on-demand read behind the
 * Services-tab drawer — one object, so where the collection row omits
 * absent keys this shape reports every field it knows by name, with null
 * for the ones the box did not carry (absence ≠ false for the booleans).
 * The same strict whitelist as the collection row: nothing in a service
 * definition is credential material, and no future field crosses uninvited.
 * A service with no name is junk.
 */
export function mapClearPassServiceDetail(raw: unknown): ClearPassServiceDetail | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const name = str(r.name ?? r.service_name);
  if (!name) return null;
  return {
    id: str(r.id) ?? name,
    name,
    type: str(r.type),
    template: str(r.template),
    enabled: bool(r.enabled),
    hitCount: num(r.hit_count),
    orderNo: num(r.order_no),
    description: str(r.description),
    monitorMode: bool(r.monitor_mode),
    rulesMatchType: str(r.rules_match_type),
    rulesConditions: Array.isArray(r.rules_conditions)
      ? r.rules_conditions.map(mapServiceRuleCondition).filter((c): c is NonNullable<typeof c> => c !== null)
      : [],
    authMethods: serviceNameList(r.auth_methods ?? r.authMethods),
    authSources: serviceNameList(r.auth_sources ?? r.authSources),
    stripUsername: bool(r.strip_username),
    roleMappingPolicy: str(r.role_mapping_policy),
    enforcementPolicy: str(r.enf_policy ?? r.enforcement_policy),
    useCachedPolicyResults: bool(r.use_cached_policy_results),
    postureEnabled: bool(r.posture_enabled),
    auditEnabled: bool(r.audit_enabled),
    profilerEnabled: bool(r.profiler_enabled),
    acctProxyEnabled: bool(r.acct_proxy_enabled),
  };
}

/** One /api/device-group row. A group with no name is junk. */
export function mapClearPassDeviceGroup(raw: unknown): ClearPassDeviceGroupRow | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const name = str(r.name ?? r.group_name);
  if (!name) return null;
  return {
    id: str(r.id) ?? name,
    name,
    description: str(r.description),
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

function filled(v: unknown): boolean {
  return typeof v === 'string' && v.trim().length > 0;
}

/**
 * What one policy-inventory read came back with. `{ rows }` ships the dataset
 * (even a genuinely empty one — that is a real answer); `{ partial: true }`
 * omits the key AND names it in PlanePull.partial; `{ partial: false }`
 * omits the key WITHOUT the flag — the 404-honest answer for a resource this
 * CPPM does not expose (verified on 6.11.12: /api/device-group, and
 * /api/service on pre-6.11 builds where /api/config/service also 404s).
 */
type InventoryOutcome<T> = { rows: T[] } | { partial: boolean };

/** One cached inventory read — rows, or a proven-absent (404) marker. A
 *  FAILURE is never cached: the next pull retries. */
interface InventorySlot {
  atMs: number;
  /** null = the resource 404d at last check (not exposed on this CPPM). */
  rows: unknown[] | null;
}

/**
 * The read-back half of a reviewed write. `rows` null means the confirming
 * read itself could not be made → undefined (NOT false — an unreadable answer
 * is not an absent object, and reporting one as the other is its own lie).
 * A readable answer with no matching row is false: the write was accepted
 * but the state is not there.
 */
function verifyReadBack<T>(rows: T[] | null, match: (row: T) => boolean): boolean | undefined {
  if (rows === null) return undefined;
  return rows.some(match);
}

/** Fixed, secret-free endpoint-write message — an HTTP code at most. */
function endpointWriteMessage(did: 'registered' | 'updated', httpCode: number, verified: boolean | undefined): string {
  if (verified === true) return `endpoint ${did} and confirmed in the repository read-back (HTTP ${httpCode})`;
  if (verified === false) {
    return `ClearPass accepted the write (HTTP ${httpCode}) but the endpoint read-back does not show it — check the repository before relying on it`;
  }
  return `endpoint ${did} (HTTP ${httpCode}); the confirming read-back could not be made`;
}

/** Fixed, secret-free local-user message — the password is never in scope here. */
function localUserWriteMessage(did: 'created' | 'updated', httpCode: number, verified: boolean | undefined): string {
  if (verified === true) return `local user ${did} and confirmed in the read-back (HTTP ${httpCode})`;
  if (verified === false) {
    return `ClearPass accepted the write (HTTP ${httpCode}) but the local-user read-back does not show it — check the user list before relying on it`;
  }
  return `local user ${did} (HTTP ${httpCode}); the confirming read-back could not be made`;
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
  private endpointRows: EndpointRow[] | null = null;
  private endpointRowsAtMs = 0;
  /** Policy-inventory reads on the same 5m cadence, keyed by dataset. */
  private readonly inventorySlots: Partial<Record<string, InventorySlot>> = {};
  /** The on-demand service detail read's TTL cache + single-flight. */
  private readonly serviceDetailCache = new Map<string, { expiresAtMs: number; value: ClearPassServiceDetailLive }>();
  private readonly serviceDetailInflight = new Map<string, Promise<ClearPassServiceDetailLive>>();

  constructor(
    creds: PlaneCredentials,
    private readonly stateRef: PlaneState,
    private readonly recordCall: RecordCallFn,
    private readonly fetchImpl: FetchLike = httpsFetch(creds.verifyTls === 'true'),
    /** Injectable so tests exercise the backoff without real wall time. */
    private readonly sleep: SleepFn = realSleep,
  ) {
    if (!ClearPassAdapter.isComplete(creds)) {
      throw new Error('clearpass requires a publisher (or host) plus clientId + clientSecret, or a token');
    }
    // 'publisher' is the key the connect drawer writes (README:322, and the
    // design's own credential record); host/baseUrl stay accepted.
    const host = [creds.publisher, creds.host, creds.baseUrl].find(filled) as string;
    this.baseUrl = httpsBase(host, 'the client secret is posted to mint a token').replace(/\/+$/, '');
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
  static hasOauthCreds(creds: PlaneCredentials): boolean {
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
   * to any device, the ticketed write broker cannot push configuration to it
   * (policy is edited in ClearPass itself — README integration table), and it
   * publishes no SSID/VLAN/port inventory. The sanctioned writes are
   * coaDisconnect() (a session action, not a configuration push) and the
   * reviewed direct writes behind `directWrite`: endpoint register/update and
   * local-user create/update via services/clearpassDirectWrite.ts — NEVER
   * policy editing, which stays in CPPM.
   */
  capabilities(): PlaneCapabilities {
    return {
      localShell: false,
      brokeredWrite: false,
      configRead: false,
      // Endpoint register/update + local-user create/update — only ever
      // through the reviewed flow in services/clearpassDirectWrite.ts.
      directWrite: true,
    };
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

    // Endpoint DETAIL rows for the ClearPass screen — a best-effort read on
    // top of the required auth feed. A failure here (network error, 404 on
    // /api/endpoint) must not fail the whole pull; it is reported as a
    // partial 'endpoints' section instead, same honesty rule the auth feed's
    // own `truncated` note follows.
    const endpointsRead = await this.fetchEndpoints();

    // The policy inventories — the plane's remaining datasets, each an
    // independent best-effort read on the endpoint repository's 5-minute
    // cadence. A failure omits its key and names it in `partial`; a 404 on
    // EVERY service candidate (or on /api/device-group) omits the key with
    // NO flag (that resource is not exposed on this CPPM — absence, not a
    // broken read).
    const networkDevices = await this.fetchInventory('networkDevices', '/api/network-device', mapClearPassNetworkDevice);
    const authSources = await this.fetchInventory('authSources', '/api/auth-source', mapClearPassAuthSource);
    const roles = await this.fetchInventory('roles', '/api/role', mapClearPassRole);
    const enforcementPolicies = await this.fetchInventory(
      'enforcementPolicies',
      '/api/enforcement-policy',
      mapClearPassEnforcementPolicy,
    );
    const enforcementProfiles = await this.fetchInventory(
      'enforcementProfiles',
      '/api/enforcement-profile',
      mapClearPassEnforcementProfile,
    );
    const localUsers = await this.fetchInventory('localUsers', '/api/local-user', mapClearPassLocalUser);
    const services = await this.fetchInventory('services', SERVICE_PATHS, mapClearPassService, {
      notFoundIsAbsent: true,
    });
    const deviceGroups = await this.fetchInventory('deviceGroups', '/api/device-group', mapClearPassDeviceGroup, {
      notFoundIsAbsent: true,
    });
    const inventoryReads: [PlaneDatasetKey, InventoryOutcome<unknown>][] = [
      ['networkDevices', networkDevices],
      ['authSources', authSources],
      ['roles', roles],
      ['enforcementPolicies', enforcementPolicies],
      ['enforcementProfiles', enforcementProfiles],
      ['localUsers', localUsers],
      ['services', services],
      ['deviceGroups', deviceGroups],
    ];

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

    const partial: PlaneDatasetKey[] = [
      ...(truncated !== null ? (['authEvents'] as const) : []),
      ...(endpointsRead === null ? (['endpoints'] as const) : []),
      ...inventoryReads.filter(([, outcome]) => 'partial' in outcome && outcome.partial).map(([key]) => key),
    ];
    return {
      authEvents,
      ...(endpointsRead !== null ? { endpoints: endpointsRead } : {}),
      ...('rows' in networkDevices ? { networkDevices: networkDevices.rows } : {}),
      ...('rows' in authSources ? { authSources: authSources.rows } : {}),
      ...('rows' in roles ? { roles: roles.rows } : {}),
      ...('rows' in enforcementPolicies ? { enforcementPolicies: enforcementPolicies.rows } : {}),
      ...('rows' in enforcementProfiles ? { enforcementProfiles: enforcementProfiles.rows } : {}),
      ...('rows' in localUsers ? { localUsers: localUsers.rows } : {}),
      ...('rows' in services ? { services: services.rows } : {}),
      ...('rows' in deviceGroups ? { deviceGroups: deviceGroups.rows } : {}),
      ...(partial.length > 0 ? { partial } : {}),
    };
  }

  /**
   * Endpoint repository DETAIL rows (README:465's second dataset), paged at
   * ENDPOINT_DETAIL_PAGE_LIMIT and capped at MAX_ENDPOINTS. Same 5-minute
   * cache window as refreshEndpointCount() — this is the repository's slower
   * dataset, not a 60-second one, so a pull inside the window returns the
   * last successful read instead of re-walking /api/endpoint. Best-effort:
   * any non-2xx, unreadable payload, or network error returns null (never
   * throws) so the caller marks the section partial instead of failing the
   * pull the auth feed already succeeded on.
   */
  private async fetchEndpoints(): Promise<EndpointRow[] | null> {
    const now = Date.now();
    if (this.endpointRows !== null && now - this.endpointRowsAtMs < ENDPOINT_REFRESH_MS) {
      return this.endpointRows;
    }
    const walk = await this.walkHal(ENDPOINT_PATH, ENDPOINT_DETAIL_PAGE_LIMIT, MAX_ENDPOINTS, mapClearPassEndpoint);
    if (!walk.ok) return null;
    this.endpointRows = walk.rows;
    this.endpointRowsAtMs = now;
    return walk.rows;
  }

  /**
   * One paged HAL collection walk at `pageLimit` rows per call, capped at
   * `rowCap`. `{ ok, rows }` when page one completed — a read that completed
   * at least one page, even a genuinely empty one, is a real answer (an
   * empty collection is not "never asked"). `{ ok: false, status }` when
   * page one never completed: the HTTP status page one answered with, or
   * null for a network error or an unreadable body — the caller decides what
   * that failure MEANS for its dataset (a 404 on /api/service is absence;
   * on /api/role it is a broken read).
   */
  private async walkHal<T>(
    path: string,
    pageLimit: number,
    rowCap: number,
    map: (raw: unknown) => T | null,
  ): Promise<{ ok: true; rows: T[] } | { ok: false; status: number | null }> {
    const rows: T[] = [];
    let readOk = false;
    let firstStatus: number | null = null;
    try {
      for (let offset = 0; rows.length < rowCap; offset += pageLimit) {
        const limit = Math.min(pageLimit, rowCap - rows.length);
        const res = await this.authedGet(`${path}?limit=${limit}&offset=${offset}`);
        if (res.status < 200 || res.status >= 300) {
          if (offset === 0) firstStatus = res.status;
          break;
        }
        const raw = extractRows(res.body);
        if (raw === null) break;
        readOk = true;
        rows.push(...raw.map(map).filter((r): r is T => r !== null));
        if (raw.length < limit) break; // short page — the collection is read
      }
    } catch {
      // A network error mid-walk still leaves whatever pages read ok.
    }
    if (!readOk) return { ok: false, status: firstStatus };
    return { ok: true, rows: rows.slice(0, rowCap) };
  }

  /**
   * One policy-inventory collection (NADs, auth sources, roles, enforcement
   * policies/profiles, local users, services, device groups) — the same
   * paged HAL walk as the endpoint detail read, on the same 5-minute
   * cadence. `paths` is one path or an ordered candidate list (services:
   * the 6.11 config namespace first, the pre-6.11 path as fallback); a 404
   * releases the walk to the next candidate, exactly like the auth feed's
   * own release-variance rule. Every dataset is independently
   * fault-tolerant:
   *   - read ok (even genuinely empty) → { rows }; the pull carries the key
   *   - 404 on EVERY candidate with notFoundIsAbsent → { partial: false }:
   *     the resource is not exposed on this CPPM (verified against 6.11.12
   *     for /api/device-group, and for services on boxes where neither
   *     candidate answers) — the key is omitted with NO partial flag,
   *     honest absence rather than a partial-failure alarm. The absence is
   *     cached for the cadence window so a 60s poll does not re-probe it.
   *   - any other failure → { partial: true }: the key is omitted AND named
   *     in PlanePull.partial — never sunk, never silent. A non-404 on an
   *     earlier candidate does NOT fall through to the next one (a 500 is a
   *     broken read, not absence). Failures are never cached: the next pull
   *     retries.
   */
  private async fetchInventory<T>(
    key: PlaneDatasetKey,
    paths: string | readonly string[],
    map: (raw: unknown) => T | null,
    opts: { notFoundIsAbsent?: boolean } = {},
  ): Promise<InventoryOutcome<T>> {
    const now = Date.now();
    const slot = this.inventorySlots[key];
    if (slot && now - slot.atMs < ENDPOINT_REFRESH_MS) {
      return slot.rows === null ? { partial: false } : { rows: slot.rows as T[] };
    }
    for (const path of [paths].flat()) {
      const walk = await this.walkHal(path, INVENTORY_PAGE_LIMIT, INVENTORY_MAX_ROWS, map);
      if (walk.ok) {
        this.inventorySlots[key] = { atMs: now, rows: walk.rows };
        return { rows: walk.rows };
      }
      if (walk.status !== 404) return { partial: true };
    }
    if (opts.notFoundIsAbsent) {
      this.inventorySlots[key] = { atMs: now, rows: null };
      return { partial: false };
    }
    return { partial: true };
  }


  /**
   * Trigger a CoA Disconnect-Request for an active session, by MAC — a session
   * action, not a configuration push (CPPM SessionAction API, 6.8.7+):
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

  // -- on-demand service detail ------------------------------------------------
  //
  // ONE service's full definition for the Services-tab drawer. NOT poller
  // work (the PlaneAdapter contract): the collection walk already serves the
  // summary rows on the 5-minute cadence, and fetching every service's full
  // object per cycle would multiply the call cost for data nobody opened.
  // This runs only for the ONE service whose drawer is opening, behind the
  // TTL cache below — never from pull(), never fanned out over the list.

  /**
   * ONE service's full definition — GET {service path}/{id} on the same
   * candidate order the collection walk uses (the 6.11 config namespace
   * first, the legacy path as fallback). Never throws: a 404 on EVERY
   * candidate is 'empty' (no such service — or a build that exposes neither
   * path), any other failure is 'failed' with a short, secret-free note.
   * null means the caller asked about nothing (an empty id), never a CPPM
   * answer.
   */
  async serviceDetail(id: string): Promise<ClearPassServiceDetailLive | null> {
    const key = (id ?? '').trim();
    if (!key) return null;
    return this.cachedServiceDetail(key, () => this.readServiceDetail(key));
  }

  /**
   * TTL cache + single-flight around one service detail read. A cache HIT
   * re-stamps `source.cached = true` so the drawer can say the read is up to
   * 45s old rather than implying a fresh call; a FAILED read is cached too —
   * without that, a drawer that re-renders turns one unhappy CPPM into a
   * call storm against the exact box already failing (the rule central's
   * detail cache documents).
   */
  private async cachedServiceDetail(
    id: string,
    load: () => Promise<ClearPassServiceDetailLive>,
  ): Promise<ClearPassServiceDetailLive> {
    const hit = this.serviceDetailCache.get(id);
    if (hit && hit.expiresAtMs > Date.now()) {
      return { ...hit.value, source: { ...hit.value.source, cached: true } };
    }
    const inflight = this.serviceDetailInflight.get(id);
    if (inflight) return inflight;
    const promise = load()
      .then((value) => {
        this.serviceDetailCache.set(id, { expiresAtMs: Date.now() + SERVICE_DETAIL_TTL_MS, value });
        // Insertion order = oldest first, so a long-lived process that opens
        // hundreds of drawers cannot grow this map without bound.
        while (this.serviceDetailCache.size > SERVICE_DETAIL_CACHE_MAX) {
          const oldest = this.serviceDetailCache.keys().next();
          if (oldest.done) break;
          this.serviceDetailCache.delete(oldest.value);
        }
        return value;
      })
      .finally(() => {
        this.serviceDetailInflight.delete(id);
      });
    this.serviceDetailInflight.set(id, promise);
    return promise;
  }

  /**
   * The read itself, once per TTL window. One call, one section: 'ok' the
   * body mapped, 'empty' every candidate 404'd, 'failed' anything else —
   * including a 200 with no service object in it, which is a broken read,
   * never an absent service.
   */
  private async readServiceDetail(id: string): Promise<ClearPassServiceDetailLive> {
    const sections: Partial<Record<ClearPassServiceDetailSection, DetailFetchState>> = {};
    const out: ClearPassServiceDetailLive = {
      service: null,
      source: { plane: 'clearpass', at: new Date().toISOString(), sections },
    };
    const seg = encodeURIComponent(id);
    for (const base of SERVICE_PATHS) {
      const res = await this.detailGet(`${base}/${seg}`);
      if (!res.ok) {
        if (res.status === 404) continue; // release variance — the legacy path may still answer
        sections.service = 'failed';
        out.source.note = res.note;
        return out;
      }
      const service = mapClearPassServiceDetail(res.body);
      if (service === null) {
        sections.service = 'failed';
        out.source.note = `200 from ${base}/${seg} but no service object in the payload`;
        return out;
      }
      out.service = service;
      sections.service = 'ok';
      return out;
    }
    sections.service = 'empty';
    out.source.note = `this CPPM answered 404 for service '${id}' — no such service`;
    return out;
  }

  /**
   * One detail GET with authed()'s 401 invalidate-and-retry for a minted
   * token but WITHOUT authedGet's 429 backoff: those sleeps exist so a poll
   * cycle survives, and on a drawer's request path they would only turn a
   * rate limit into a multi-second stall (the split central's detailGet
   * documents). Never throws — a transport failure comes back as
   * { ok:false } with a short, secret-free reason.
   */
  private async detailGet(
    path: string,
  ): Promise<{ ok: true; status: number; body: unknown } | { ok: false; status: number | null; note: string }> {
    try {
      const res = await this.authed('GET', path);
      if (res.status < 200 || res.status >= 300) return { ok: false, status: res.status, note: `HTTP ${res.status}` };
      return { ok: true, status: res.status, body: res.body };
    } catch (err) {
      // authed() prefixes 'GET <path> failed: '; keep only the cause so the
      // note stays one sentence, and never a URL or a credential.
      const raw = (err as Error).message;
      const cause = raw.includes('failed: ') ? raw.slice(raw.indexOf('failed: ') + 8) : raw;
      return { ok: false, status: null, note: cause || 'request failed' };
    }
  }

  // -- reviewed direct writes ------------------------------------------------
  //
  // The plane-facing half of the reviewed flow (services/clearpassDirectWrite.ts
  // owns the review gate, the audit line and the cache refresh — the same
  // split CentralAdapter.applySsidProfile() keeps). Each method does the write
  // and then a READ-BACK of the object it just wrote, reporting ok / verified
  // separately and never echoing a vendor body into a message. A successful
  // write also drops the poller-facing caches it just made stale, so the
  // service's forced re-read cannot come back with the pre-write rows.
  //
  // The local-user methods take password material in exactly one place — the
  // outbound request body. It is never read back (the verify maps rows through
  // the same strict whitelist pull() uses), never logged, and never echoed in
  // a result message.

  /** POST /api/endpoint — register one MAC with its attributes. */
  async registerEndpoint(form: ClearPassEndpointRegisterForm): Promise<ClearPassWriteResult> {
    const body: Record<string, unknown> = { mac_address: form.mac, status: form.status ?? 'Known' };
    if (form.description) body.description = form.description;
    if (form.attributes && Object.keys(form.attributes).length > 0) body.attributes = form.attributes;
    const res = await this.authed('POST', ENDPOINT_PATH, body);
    if (res.status < 200 || res.status >= 300) {
      return {
        ok: false,
        action: 'failed',
        httpCode: res.status,
        message: `ClearPass refused the endpoint registration (HTTP ${res.status})`,
      };
    }
    this.invalidateEndpointCaches();
    const createdId = res.body && typeof res.body === 'object' ? str((res.body as Record<string, unknown>).id) : null;
    const rows = await this.readBackEndpoint(createdId, form.mac);
    const verified = verifyReadBack(rows, (row) => normalizeMac(row.mac) === form.mac);
    return {
      ok: true,
      action: 'created',
      httpCode: res.status,
      ...(verified !== undefined ? { verified } : {}),
      message: endpointWriteMessage('registered', res.status, verified),
    };
  }

  /** PATCH /api/endpoint/{id} — status and/or the operator note, nothing else. */
  async updateEndpoint(id: string, form: ClearPassEndpointUpdateForm): Promise<ClearPassWriteResult> {
    const body: Record<string, unknown> = {};
    if (form.status !== undefined) body.status = form.status;
    if (form.description !== undefined) body.description = form.description;
    const path = `${ENDPOINT_PATH}/${encodeURIComponent(id)}`;
    const res = await this.authed('PATCH', path, body);
    if (res.status < 200 || res.status >= 300) {
      return {
        ok: false,
        action: 'failed',
        httpCode: res.status,
        message: `ClearPass refused the endpoint update (HTTP ${res.status})`,
      };
    }
    this.invalidateEndpointCaches();
    const rows = await this.readBackEndpoint(id, null);
    const verified = verifyReadBack(
      rows,
      (row) =>
        (form.status === undefined || row.status === form.status) &&
        (form.description === undefined || (row.description ?? '') === form.description),
    );
    return {
      ok: true,
      action: 'updated',
      httpCode: res.status,
      ...(verified !== undefined ? { verified } : {}),
      message: endpointWriteMessage('updated', res.status, verified),
    };
  }

  /**
   * POST /api/local-user — create one local account. `password` crosses in
   * the request body and NOWHERE else: the read-back whitelists rows through
   * mapClearPassLocalUser, so no hash can come back either.
   */
  async createLocalUser(form: ClearPassLocalUserCreateForm): Promise<ClearPassWriteResult> {
    const body: Record<string, unknown> = {
      user_id: form.userId,
      role_name: form.roleName,
      enabled: form.enabled,
      password: form.password,
    };
    if (form.username) body.username = form.username;
    const res = await this.authed('POST', LOCAL_USER_PATH, body);
    if (res.status < 200 || res.status >= 300) {
      return {
        ok: false,
        action: 'failed',
        httpCode: res.status,
        message: `ClearPass refused the local-user create (HTTP ${res.status})`,
      };
    }
    this.invalidateLocalUserCache();
    const createdId = res.body && typeof res.body === 'object' ? str((res.body as Record<string, unknown>).id) : null;
    const rows = await this.readBackLocalUser(createdId, form.userId);
    const verified = verifyReadBack(
      rows,
      (row) => row.userId === form.userId && row.roleName === form.roleName && row.enabled === form.enabled,
    );
    return {
      ok: true,
      action: 'created',
      httpCode: res.status,
      ...(verified !== undefined ? { verified } : {}),
      message: localUserWriteMessage('created', res.status, verified),
    };
  }

  /**
   * PUT /api/local-user/{id} — every field optional; an absent password
   * leaves the current one alone (it is only ever SENT, never read).
   */
  async updateLocalUser(id: string, form: ClearPassLocalUserUpdateForm): Promise<ClearPassWriteResult> {
    const body: Record<string, unknown> = {};
    if (form.username !== undefined) body.username = form.username;
    if (form.roleName !== undefined) body.role_name = form.roleName;
    if (form.enabled !== undefined) body.enabled = form.enabled;
    if (form.password !== undefined) body.password = form.password;
    const path = `${LOCAL_USER_PATH}/${encodeURIComponent(id)}`;
    const res = await this.authed('PUT', path, body);
    if (res.status < 200 || res.status >= 300) {
      return {
        ok: false,
        action: 'failed',
        httpCode: res.status,
        message: `ClearPass refused the local-user update (HTTP ${res.status})`,
      };
    }
    this.invalidateLocalUserCache();
    const rows = await this.readBackLocalUser(id, null);
    const verified = verifyReadBack(
      rows,
      (row) =>
        (form.username === undefined || row.username === form.username) &&
        (form.roleName === undefined || row.roleName === form.roleName) &&
        (form.enabled === undefined || row.enabled === form.enabled),
    );
    return {
      ok: true,
      action: 'updated',
      httpCode: res.status,
      ...(verified !== undefined ? { verified } : {}),
      message: localUserWriteMessage('updated', res.status, verified),
    };
  }

  /** A write just changed what the cached endpoint reads would answer. */
  private invalidateEndpointCaches(): void {
    this.endpointCount = null;
    this.endpointRows = null;
  }

  /** A write just changed what the cached local-user read would answer. */
  private invalidateLocalUserCache(): void {
    delete this.inventorySlots.localUsers;
  }

  /**
   * Re-read the endpoint a write just touched: by id when the write's answer
   * carried one, otherwise through the collection filter on the MAC (the same
   * JSON filter vocabulary /api/session already accepts — a build that rejects
   * it answers 4xx and the read-back reports undefined, never a guess).
   * null = the confirming read could not be made.
   */
  private async readBackEndpoint(id: string | null, mac: string | null): Promise<EndpointRow[] | null> {
    try {
      if (id) {
        const res = await this.authed('GET', `${ENDPOINT_PATH}/${encodeURIComponent(id)}`);
        if (res.status < 200 || res.status >= 300) return null;
        const row = mapClearPassEndpoint(res.body);
        return row ? [row] : [];
      }
      if (!mac) return null;
      const filter = encodeURIComponent(JSON.stringify({ mac_address: { $eq: mac } }));
      const res = await this.authed('GET', `${ENDPOINT_PATH}?filter=${filter}&limit=5`);
      if (res.status < 200 || res.status >= 300) return null;
      const raw = extractRows(res.body);
      if (raw === null) return null;
      return raw.map(mapClearPassEndpoint).filter((r): r is EndpointRow => r !== null);
    } catch {
      return null; // a transport fault on the CONFIRMING read is not the write's verdict
    }
  }

  /**
   * Re-read the local user a write just touched — by id when known, otherwise
   * through the collection filter on user_id. STRICTLY whitelisted through
   * mapClearPassLocalUser: this path is how the portal proves a password
   * never comes back. null = the confirming read could not be made.
   */
  private async readBackLocalUser(id: string | null, userId: string | null): Promise<ClearPassLocalUserRow[] | null> {
    try {
      if (id) {
        const res = await this.authed('GET', `${LOCAL_USER_PATH}/${encodeURIComponent(id)}`);
        if (res.status < 200 || res.status >= 300) return null;
        const row = mapClearPassLocalUser(res.body);
        return row ? [row] : [];
      }
      if (!userId) return null;
      const filter = encodeURIComponent(JSON.stringify({ user_id: { $eq: userId } }));
      const res = await this.authed('GET', `${LOCAL_USER_PATH}?filter=${filter}&limit=5`);
      if (res.status < 200 || res.status >= 300) return null;
      const raw = extractRows(res.body);
      if (raw === null) return null;
      return raw.map(mapClearPassLocalUser).filter((r): r is ClearPassLocalUserRow => r !== null);
    } catch {
      return null; // a transport fault on the CONFIRMING read is not the write's verdict
    }
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
  private async authed(method: 'GET' | 'POST' | 'PATCH' | 'PUT', path: string, body?: unknown): Promise<HttpResult> {
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
    method: 'GET' | 'POST' | 'PATCH' | 'PUT',
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
