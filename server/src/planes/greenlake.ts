/**
 * server/src/planes/greenlake.ts — HPE GreenLake platform adapter.
 *
 * The licence reconciliation source (README integration table: subscriptions,
 * assignments, identity; read-only). OAuth2 client-credentials against the
 * GLP platform API, subscriptions mapped into the shared SubscriptionRow so
 * the poller cache and /api/licenses can consume them.
 *
 * Auth (verified against developer.greenlake.hpe.com — the MSP token-exchange
 * doc and the new-central token guide): the documented endpoint is
 *   POST /authorization/v2/oauth2/{workspaceId}/token
 * form-encoded grant_type=client_credentials + client_id + client_secret —
 * the workspace rides in the PATH (there is no X-Workspace-Id header).
 * Workspace/release variance is tolerated by falling back through the legacy
 * doors (/oauth2/token, then /token) on a 404 and remembering which path
 * worked. Tokens are cached via the shared TokenManager (refresh at
 * expiry−60s, single-flight, invalidate + retry once on 401), exactly like
 * central.
 *
 * Endpoint candidates (workspace/release variance; 404 on a candidate is
 * tolerated by trying the next one and remembering which path worked):
 *
 *   section        candidates (tried in order)                        paging
 *   subscriptions  /subscriptions/v1/subscriptions (&workspace_id=…)  offset/limit 100
 *                  /subscription-manager/v1/subscriptions
 *                  /devices/v1/subscriptions
 *   assignments    /devices/v1/devices                                offset/limit 100
 *
 * The assignments feed is the device→subscription join the Licences screen
 * needs to count unlicensed devices and name orphans; a live probe returns
 * `{items:[{serialNumber, macAddress, model, deviceType, deviceName, archived,
 * assignedState, subscription}], errors, count, offset, total}` — the same
 * envelope the subscriptions section pages. It is SECONDARY: it refreshes on a
 * 5-minute cadence (the device inventory dwarfs the subscription list) and its
 * failure never fails the pull. When it cannot be read the pull declares
 * `partial: ['assignments']`, so the plane says 'half read' rather than
 * letting the screen infer 'no unlicensed devices' from silence.
 *
 * Failure policy (mirrors central):
 *   - 404 on every candidate → pull() fails naming the section — the
 *     subscriptions feed is this plane's whole dataset, so there is nothing
 *     honest to degrade to.
 *   - any other HTTP/network error → pull() throws naming the section, so the
 *     poller marks the plane degraded and keeps serving the last good cache.
 *   - rows that came back but NONE of which could be mapped → pull() throws:
 *     '0 subscriptions' from a payload we misread is a licence screen that
 *     says the workspace owns nothing, which is worse than a red plane. Some
 *     rows dropping is survivable and named in the note ('N rows unmapped').
 *   - 429 → bounded exponential backoff, Retry-After honoured, then the
 *     section fails naming rate limiting rather than a bare HTTP code.
 * Pagination mirrors central's fetchSection: offset/limit pages merged until
 * the envelope's total is reached (GLP answers `{items, count, offset, total}`
 * and defaults to a bounded page), capped by MAX_PAGES. Hitting the cap is
 * reported in the plane note rather than presented as the whole inventory.
 *
 * Mapping decisions:
 *   - field variance: the same endpoint family answers snake_case+flat on some
 *     releases and camelCase+nested on others (a live GLP v1 row is
 *     `{key, sku, skuDescription, quantity, availableQuantity, startTime,
 *     endTime, subscriptionStatus, tierDescription}`; v1alpha1 answers
 *     `productDescription`/`appointment.subscriptionStart`). Every reader
 *     accepts both spellings — the same tolerance central.ts carries.
 *   - expires: ISO/epoch → 'DD Mon YY' display ('14 Sep 26', UTC), the format
 *     the design and the fixtures use — live and demo rows land in the SAME
 *     table in blend mode, and month precision made a subscription ending on
 *     the 2nd indistinguishable from one ending on the 29th. The exact instant
 *     rides along in the expiresAtMs/daysLeft hints so /api/licenses can
 *     compute renewals and stats without re-parsing display strings — same
 *     pattern as central's serial/mac identity hints.
 *   - sku carries its source ('R7G20AAE · greenlake'), matching the fixtures:
 *     the Licences table mixes planes, so the column has to say whose key it is.
 *   - status precedence: retiring (raw status says expired/cancelled/EoL, or
 *     the expiry date is already past — danger) → expiring (<90d left —
 *     warning) → idle (0 assigned — neutral) → active (success).
 *     Time-critical beats reclaimable.
 *   - term: a reported term string wins; else term_months ('3 yr
 *     subscription'); else derived from start/end dates; else '—'.
 *   - assigned: direct count fields first, then GLP's complement
 *     (quantity − availableQuantity — the only assignment signal a real v1 row
 *     carries), then an assignments array's length ("from assignments if
 *     present").
 *   - qty/assigned display uses the fixtures' locale grouping ('5,000').
 *   - planeTone 'accent' — the fixtures' GREENLAKE badge colour.
 *
 * Security: secrets live only in the token POST body — never in URLs, never
 * in the recorded call log (method + path + ms + status only).
 */

import type { Subscription, SubscriptionAssignment, SubscriptionRow, Tone } from '../../../shared';
import type { PlaneCredentials } from '../config/settings';
import {
  mintedTokenInfo,
  parseRetryAfterMs,
  parseTimestamp,
  TokenManager,
  type FetchLike,
  type RecordCallFn,
  type SleepFn,
} from './central';
import type { PlaneAdapter, PlaneCapabilities, PlanePull, PlaneState } from './types';

// Re-exported so tests can type an in-memory fake fetch against this adapter.
export type { FetchLike } from './central';

const OUTBOUND_TIMEOUT_MS = 10_000;
const DEFAULT_BASE_URL = 'https://global.api.greenlake.hpe.com';
const DAY_MS = 86_400_000;
const YEAR_MS = 365.25 * DAY_MS;

/** A subscription this close to expiry renders as 'expiring' (warning). */
export const EXPIRING_SOON_DAYS = 90;

/** 429 backoff: attempts after the first, exponential floor, and a hard cap. */
const RATE_LIMIT_RETRIES = 2;
const RATE_LIMIT_BASE_MS = 1_000;
const RATE_LIMIT_CAP_MS = 30_000;

/** The device inventory is big and slow-moving — one read per 5 minutes. */
const ASSIGNMENTS_REFRESH_MS = 5 * 60 * 1000;

const realSleep: SleepFn = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

// ---------------------------------------------------------------------------
// Defensive field readers — unknown/extra fields ignored, missing → null
// (module-private copies of central's; that module keeps its own private too)
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

/** A nested object field (GLP nests product identity / term dates), else {}. */
function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

// ---------------------------------------------------------------------------
// Metric hints — what the display row flattens away but the screen needs
// ---------------------------------------------------------------------------

/**
 * Optional computed fields attached to each row (the pattern central uses for
 * serial/mac identity hints). /api/licenses reads them when present to build
 * renewals and stats; rows from other sources simply lack them.
 */
export interface SubscriptionMetricHints {
  expiresAtMs?: number;
  daysLeft?: number;
  qtyValue?: number;
  assignedValue?: number;
}

export type GreenLakeSubscriptionRow = SubscriptionRow & SubscriptionMetricHints;

// ---------------------------------------------------------------------------
// Row mapping (pure, exported for tests)
// ---------------------------------------------------------------------------

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Epoch ms → the design's day-precision expiry display ('14 Sep 26'), UTC.
 * Live and demo rows share one table in blend mode, so the two must render
 * identically; month precision also hid the difference between a subscription
 * ending on the 2nd and one ending on the 29th.
 */
export function expiryDisplay(ms: number): string {
  const d = new Date(ms);
  const day = String(d.getUTCDate()).padStart(2, '0');
  const year = String(d.getUTCFullYear()).slice(2);
  return `${day} ${MONTHS[d.getUTCMonth()]} ${year}`;
}

/**
 * Status + badge tone. Precedence (documented in the header): retiring →
 * expiring → idle → active. `rawStatus` only ever moves a row INTO retiring;
 * everything else is computed from the dates and counts the plane reports.
 */
export function subStatusFor(
  rawStatus: string | null,
  assigned: number | null,
  daysLeft: number | null,
): { status: Subscription['status']; tone: Tone } {
  const s = (rawStatus ?? '').toLowerCase();
  // \bended\b, not /ended/ — GLP answers subscriptionStatus:'ENDED' for a
  // finished subscription, but must not catch 'EXTENDED'.
  if (/retir|expired|cancel|end[- ]?of|\bended\b|terminat/.test(s)) return { status: 'retiring', tone: 'danger' };
  if (daysLeft !== null && daysLeft < 0) return { status: 'retiring', tone: 'danger' }; // date already past
  if (daysLeft !== null && daysLeft < EXPIRING_SOON_DAYS) return { status: 'expiring', tone: 'warning' };
  if (assigned === 0) return { status: 'idle', tone: 'neutral' };
  return { status: 'active', tone: 'success' };
}

/**
 * assigned count: direct fields first, then GLP's complement
 * (quantity − availableQuantity — a real v1 row reports no assigned count at
 * all, only what is left), then an assignments array's length.
 */
function assignedCount(r: Record<string, unknown>, qty: number | null): number | null {
  const direct = num(
    r.assigned ??
      r.assigned_count ??
      r.assignedCount ??
      r.assigned_quantity ??
      r.assignedQuantity ??
      r.used ??
      r.used_quantity ??
      r.usedQuantity ??
      r.consumed,
  );
  if (direct !== null) return direct;
  const available = num(r.availableQuantity ?? r.available_quantity);
  if (qty !== null && available !== null && qty >= available) return qty - available;
  const a = r.assignments;
  if (Array.isArray(a)) return a.length;
  return num(a);
}

/**
 * Subscription term instants. One reader so the expiry mapping and the term
 * derivation cannot drift apart: v1 answers startTime/endTime, v1alpha1 nests
 * them under `appointment`, older shapes are flat snake_case.
 */
function subscriptionDates(r: Record<string, unknown>): { start: number | null; end: number | null } {
  const appt = obj(r.appointment);
  return {
    start: parseTimestamp(
      r.startTime ?? r.start_date ?? r.startDate ?? r.starts ?? r.valid_from ?? r.validFrom ?? appt.subscriptionStart,
    ),
    end: parseTimestamp(
      r.endTime ??
        r.end_date ??
        r.endDate ??
        r.expires ??
        r.expiration_date ??
        r.expirationDate ??
        r.expiry_date ??
        r.expiryDate ??
        r.valid_until ??
        r.validUntil ??
        appt.subscriptionEnd,
    ),
  };
}

/** Term display: reported string > term_months > start/end derivation > '—'. */
function termString(r: Record<string, unknown>): string {
  const direct = str(r.term ?? r.subscription_term ?? r.subscriptionTerm ?? r.term_description ?? r.termDescription);
  if (direct) return direct;
  const months = num(r.term_months ?? r.termMonths ?? r.duration_months ?? r.durationMonths);
  if (months !== null && months > 0) {
    return months % 12 === 0 ? `${months / 12} yr subscription` : `${months} mo subscription`;
  }
  const { start, end } = subscriptionDates(r);
  if (start !== null && end !== null && end > start) {
    const years = Math.round((end - start) / YEAR_MS);
    return years > 0 ? `${years} yr subscription` : '<1 yr subscription';
  }
  return '—';
}

/** GreenLake subscriptions row → SubscriptionRow (+ metric hints). */
export function mapGreenLakeSubscription(raw: unknown, nowMs: number = Date.now()): GreenLakeSubscriptionRow | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const product = obj(r.product);
  // Most human-readable first. A real GLP v1 row has none of the flat *_name
  // keys — its only human label is skuDescription — so dropping unnamed rows
  // would discard the entire workspace.
  const name =
    str(r.name) ??
    str(r.subscription_name) ??
    str(r.subscriptionName) ??
    str(r.product_name) ??
    str(r.productName) ??
    str(r.skuDescription) ??
    str(r.sku_description) ??
    str(r.productDescription) ??
    str(r.display_name) ??
    str(r.displayName) ??
    str(r.service_name) ??
    str(r.serviceName) ??
    str(product.description) ??
    str(product.name) ??
    str(r.tierDescription) ??
    str(r.subscriptionType) ??
    str(r.product);
  if (!name) return null; // a subscription we cannot name is junk
  const qty = num(
    r.quantity ?? r.total_quantity ?? r.totalQuantity ?? r.license_count ?? r.licenseCount ?? r.qty ?? r.seats,
  );
  const assigned = assignedCount(r, qty);
  const expiresAtMs = subscriptionDates(r).end;
  const daysLeft = expiresAtMs !== null ? Math.floor((expiresAtMs - nowMs) / DAY_MS) : null;
  const rawStatus = str(r.status ?? r.state ?? r.subscriptionStatus ?? r.subscription_status);
  const { status, tone } = subStatusFor(rawStatus, assigned, daysLeft);
  const skuBase =
    str(r.sku) ??
    str(r.part_number) ??
    str(r.partNumber) ??
    str(r.productSku) ??
    str(product.sku) ??
    str(r.subscription_key) ??
    str(r.subscriptionKey) ??
    str(r.key) ??
    str(r.subscription_id) ??
    str(r.subscriptionId) ??
    str(r.id);
  return {
    name,
    // The fixtures' convention: the key plus the plane that issued it, because
    // the Licences table mixes GreenLake, Mist and perpetual rows.
    sku: skuBase !== null ? `${skuBase} · greenlake` : '—',
    plane: 'GREENLAKE',
    planeTone: 'accent',
    term: termString(r),
    qty: qty !== null ? qty.toLocaleString('en-US') : '—',
    assigned: assigned !== null ? assigned.toLocaleString('en-US') : '—',
    pct: qty !== null && qty > 0 && assigned !== null ? `${Math.round((assigned / qty) * 100)}%` : '—',
    expires: expiresAtMs !== null ? expiryDisplay(expiresAtMs) : '—',
    status,
    tone,
    ...(expiresAtMs !== null ? { expiresAtMs, daysLeft: daysLeft! } : {}),
    ...(qty !== null ? { qtyValue: qty } : {}),
    ...(assigned !== null ? { assignedValue: assigned } : {}),
  };
}

/**
 * GLP device row → SubscriptionAssignment (the device→entitlement join).
 * `assigned` is tri-state on purpose: absent means the plane never said, which
 * is not the same as 'UNASSIGNED' and must not be counted as an unlicensed
 * device. A row with no serial is dropped — serial is the reconcile key.
 */
export function mapGreenLakeAssignment(raw: unknown): SubscriptionAssignment | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const serial = str(r.serialNumber ?? r.serial_number ?? r.serial);
  if (!serial) return null;
  // `subscription` is null (explicitly unlicensed), an object, or a list of
  // consuming subscriptions — read the first either way.
  const subRaw = Array.isArray(r.subscription) ? r.subscription[0] : r.subscription;
  const sub = obj(subRaw ?? r.subscriptionDetails);
  const subKey =
    typeof subRaw === 'string'
      ? str(subRaw)
      : (str(sub.key ?? sub.subscriptionKey ?? sub.subscription_key ?? sub.id) ??
        str(r.subscriptionKey ?? r.subscription_key));
  const stateRaw = (str(r.assignedState ?? r.assigned_state ?? r.assignmentState) ?? '').toLowerCase();
  // 'UNASSIGNED' contains 'assigned' — test the negative first or every
  // unlicensed device reads as licensed.
  const assigned =
    stateRaw === '' ? null
    : /^un(assigned)?/.test(stateRaw) || /not.?assigned/.test(stateRaw) ? false
    : /assigned/.test(stateRaw) ? true
    : null;
  const endMs = parseTimestamp(sub.endTime ?? sub.end_date ?? sub.expiryDate ?? r.subscriptionEndTime);
  const archived = typeof r.archived === 'boolean' ? r.archived : null;
  return {
    serial,
    ...(str(r.macAddress ?? r.mac_address ?? r.mac) !== null
      ? { mac: str(r.macAddress ?? r.mac_address ?? r.mac) as string }
      : {}),
    ...(str(r.model) !== null ? { model: str(r.model) as string } : {}),
    ...(str(r.deviceName ?? r.device_name ?? r.hostname) !== null
      ? { deviceName: str(r.deviceName ?? r.device_name ?? r.hostname) as string }
      : {}),
    ...(str(r.deviceType ?? r.device_type) !== null
      ? { deviceType: str(r.deviceType ?? r.device_type) as string }
      : {}),
    ...(assigned !== null ? { assigned } : {}),
    // null (not undefined) is a statement: the plane says this device consumes
    // no subscription. Undefined would mean it never said.
    ...(subKey !== null ? { subscriptionKey: subKey } : subRaw === null ? { subscriptionKey: null } : {}),
    ...(str(sub.tierDescription ?? sub.tier) !== null
      ? { subscriptionTier: str(sub.tierDescription ?? sub.tier) as string }
      : {}),
    ...(endMs !== null ? { expires: new Date(endMs).toISOString() } : {}),
    ...(archived !== null ? { archived } : {}),
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
    // A throttle that outlived the backoff is not the workspace saying no.
    super(`HTTP ${status} from ${path}${status === 429 ? ' — rate limited, backoff exhausted' : ''}`);
    this.name = 'HttpStatusError';
  }
}

/**
 * One outbound response. `retryAfterMs` is additive — callers that read only
 * { status, body } are unaffected; the 429 backoff is the sole consumer.
 */
interface HttpResult {
  status: number;
  body: unknown;
  retryAfterMs?: number;
}

class SectionMissingError extends Error {
  constructor() {
    super("section 'subscriptions': no candidate endpoint answered (all 404)");
    this.name = 'SectionMissingError';
  }
}

/** Payload keys the subscription endpoints use, tried before the first-array heuristic. */
const PAYLOAD_KEYS = ['subscriptions', 'items', 'results'];

/** One candidate endpoint; `extraQuery` is appended after the paging params. */
interface SectionCandidate {
  path: string;
  extraQuery?: string;
}

/** Page size and the cap that stops a runaway loop (mirrors central's spec). */
const PAGE_LIMIT = 100;
const MAX_PAGES = 25;

/**
 * The device inventory that carries the subscription join. Only the endpoint a
 * live workspace was actually observed answering is listed — an invented
 * candidate would spend a call per poll to learn nothing.
 */
const ASSIGNMENT_CANDIDATES: SectionCandidate[] = [{ path: '/devices/v1/devices' }];

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
 * Inventory size from the envelope — GLP answers
 * `{items, errors, count, offset, total}` where `count` is this page's length
 * and `total` the workspace's, so only `total` may bound the loop. null means
 * "unknown": the short-page test then decides when to stop.
 */
function extractTotal(body: unknown): number | null {
  if (body && typeof body === 'object') {
    return num((body as Record<string, unknown>).total);
  }
  return null;
}

function withScheme(base: string): string {
  return /^https?:\/\//i.test(base) ? base : `https://${base}`;
}

export class GreenLakeAdapter implements PlaneAdapter {
  readonly id = 'greenlake' as const;

  private readonly baseUrl: string;
  private readonly tokens: TokenManager;
  private readonly candidates: SectionCandidate[];
  private readonly tokenCandidates: string[];
  /** Candidate that worked (tried first next time). */
  private resolvedPath: SectionCandidate | null = null;
  /** Token endpoint that worked (tried first next time). */
  private resolvedTokenPath: string | null = null;
  /** Last good assignments read and when it was taken (5-minute cadence). */
  private assignments: SubscriptionAssignment[] | null = null;
  private assignmentsAtMs = 0;
  /** Why the assignments feed is missing, when it is — named in the note. */
  private assignmentsError: string | null = null;

  constructor(
    creds: PlaneCredentials,
    private readonly stateRef: PlaneState,
    private readonly recordCall: RecordCallFn,
    private readonly fetchImpl: FetchLike = (url, init) => fetch(url, init),
    /** Injectable so tests exercise the backoff without real wall time. */
    private readonly sleep: SleepFn = realSleep,
  ) {
    if (!GreenLakeAdapter.isComplete(creds)) {
      throw new Error('greenlake requires workspaceId, clientId and clientSecret');
    }
    this.baseUrl = withScheme(creds.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    const ws = encodeURIComponent(creds.workspaceId);
    this.candidates = [
      // workspace_id is harmless where the token already scopes the workspace,
      // and required by the releases that read it — it rides after the paging
      // params, which every candidate carries.
      { path: '/subscriptions/v1/subscriptions', extraQuery: `&workspace_id=${ws}` },
      { path: '/subscription-manager/v1/subscriptions' },
      { path: '/devices/v1/subscriptions' },
    ];
    // Documented first (workspace in the path), then the legacy doors.
    this.tokenCandidates = [`/authorization/v2/oauth2/${ws}/token`, '/oauth2/token', '/token'];
    this.tokens = new TokenManager(async () => {
      const form = {
        grant_type: 'client_credentials',
        client_id: creds.clientId,
        client_secret: creds.clientSecret,
      };
      const resolved = this.resolvedTokenPath;
      const candidates = resolved
        ? [resolved, ...this.tokenCandidates.filter((c) => c !== resolved)]
        : this.tokenCandidates;
      let lastStatus = 0;
      for (const path of candidates) {
        const res = await this.http('POST', path, { form });
        if (res.status === 404) {
          lastStatus = res.status;
          continue; // workspace/release variance — try the next door
        }
        const record = res.body && typeof res.body === 'object' ? (res.body as Record<string, unknown>) : {};
        const token = str(record.access_token);
        if (res.status !== 200 || !token) {
          throw new Error(`auth: token endpoint answered HTTP ${res.status} without an access_token`);
        }
        this.resolvedTokenPath = path;
        const published = num(record.expires_in);
        // Only the token manager learns when this credential dies; the registry
        // could publish the source alone. Absent expires_in stays null rather
        // than inheriting the 7200 refresh-pacing default as a claimed expiry.
        this.stateRef.token = mintedTokenInfo(published);
        return { accessToken: token, expiresInSec: published ?? 7200 };
      }
      throw new Error(`auth: token endpoint answered HTTP ${lastStatus} without an access_token`);
    });
  }

  static isComplete(creds: PlaneCredentials | null): boolean {
    return (
      !!creds &&
      [creds.workspaceId, creds.clientId, creds.clientSecret].every(
        (v) => typeof v === 'string' && v.trim().length > 0,
      )
    );
  }

  state(): PlaneState {
    return this.stateRef;
  }

  /**
   * GreenLake is the licence source of record: it owns no device transport, so
   * there is no shell and nothing for the write broker to push, and it
   * publishes no network configuration.
   */
  capabilities(): PlaneCapabilities {
    return { localShell: false, brokeredWrite: false, configRead: false };
  }

  async pull(): Promise<PlanePull> {
    let page: { rows: unknown[]; truncated: boolean };
    try {
      page = await this.fetchSubscriptions();
    } catch (err) {
      if (err instanceof SectionMissingError) {
        throw new Error(
          "greenlake pull: section 'subscriptions' failed — no subscriptions endpoint answered (404 on every candidate)",
        );
      }
      throw new Error(`greenlake pull: section 'subscriptions' failed — ${(err as Error).message}`);
    }

    const now = Date.now();
    const subscriptions = page.rows
      .map((r) => mapGreenLakeSubscription(r, now))
      .filter((s): s is GreenLakeSubscriptionRow => s !== null);

    // The workspace answered with rows we could not read a single one of: the
    // payload shape moved. Publishing '0 subscriptions' would tell an operator
    // the workspace owns nothing — a red plane is the honest answer.
    if (page.rows.length > 0 && subscriptions.length === 0) {
      throw new Error(
        `greenlake pull: section 'subscriptions' failed — ${page.rows.length.toLocaleString('en-US')} rows returned but none could be mapped (payload shape not recognised)`,
      );
    }
    const unmapped = page.rows.length - subscriptions.length;

    // Secondary and slower: the device→entitlement join. Never fails the pull.
    const assignments = await this.refreshAssignments();

    const expiring = subscriptions.filter((s) => s.status === 'expiring').length;
    const unlicensed = assignments?.filter((a) => a.assigned === false).length ?? null;
    this.stateRef.note =
      `${subscriptions.length.toLocaleString('en-US')} subscriptions · ` +
      `${expiring.toLocaleString('en-US')} expiring < ${EXPIRING_SOON_DAYS}d` +
      // Rows we dropped are a gap in the licence picture, not a quiet workspace.
      (unmapped > 0 ? ` · ${unmapped.toLocaleString('en-US')} rows unmapped` : '') +
      // A page-capped read is a partial inventory — say so rather than let the
      // count read as the whole truth.
      (page.truncated ? ` · partial (page cap ${MAX_PAGES})` : '') +
      (assignments !== null
        ? ` · ${assignments.length.toLocaleString('en-US')} devices` +
          (unlicensed !== null ? ` · ${unlicensed.toLocaleString('en-US')} unlicensed` : '')
        : ` · assignments unavailable (${this.assignmentsError ?? 'not read'})`);
    if (this.stateRef.health === 'warning') this.stateRef.health = 'healthy'; // first sync done

    return {
      subscriptions,
      ...(assignments !== null ? { assignments } : { partial: ['assignments' as const] }),
    };
  }

  // -- internals -------------------------------------------------------------

  /**
   * Page through the subscriptions section, tolerating 404 by trying the next
   * candidate path; remember the one that worked. `truncated` is true when the
   * page cap stopped the loop before the envelope's total was read.
   */
  private async fetchSubscriptions(): Promise<{ rows: unknown[]; truncated: boolean }> {
    const resolved = this.resolvedPath;
    const candidates = resolved
      ? [resolved, ...this.candidates.filter((c) => c.path !== resolved.path)]
      : this.candidates;
    const result = await this.pageCandidates(candidates);
    if (result === null) throw new SectionMissingError();
    this.resolvedPath = result.candidate;
    return { rows: result.rows, truncated: result.truncated };
  }

  /**
   * The device→subscription join, on a 5-minute cadence. Returns the last good
   * read when it is still fresh, null when the feed could not be read at all
   * (the caller then declares the pull partial — an unread feed must never be
   * shown as 'no unlicensed devices'). Never throws: subscriptions are this
   * plane's required section, assignments are additive.
   */
  private async refreshAssignments(): Promise<SubscriptionAssignment[] | null> {
    const now = Date.now();
    // The cadence gates ATTEMPTS, not successes: a workspace whose devices
    // endpoint 404s must not be re-probed every 60s poll for nothing.
    if (this.assignmentsAtMs !== 0 && now - this.assignmentsAtMs < ASSIGNMENTS_REFRESH_MS) {
      return this.assignments;
    }
    this.assignmentsAtMs = now;
    try {
      const result = await this.pageCandidates(ASSIGNMENT_CANDIDATES);
      if (result === null) {
        this.assignmentsError = 'no devices endpoint answered (404)';
        return this.assignments; // keep the last good read if there was one
      }
      const rows = result.rows.map(mapGreenLakeAssignment).filter((a): a is SubscriptionAssignment => a !== null);
      if (result.rows.length > 0 && rows.length === 0) {
        // Same rule as the subscriptions section: a payload we could not read
        // is not an empty inventory.
        this.assignmentsError = `${result.rows.length.toLocaleString('en-US')} device rows returned, none mappable`;
        return this.assignments;
      }
      this.assignments = rows;
      this.assignmentsError = null;
      this.stateRef.deviceCount = rows.length;
      return rows;
    } catch (err) {
      this.assignmentsError = (err as Error).message;
      return this.assignments;
    }
  }

  /**
   * Page one section through its candidate paths, tolerating 404 by trying the
   * next; null when every candidate 404s. `truncated` is true when the page
   * cap stopped the loop before the envelope's total was read.
   */
  private async pageCandidates(
    candidates: SectionCandidate[],
  ): Promise<{ candidate: SectionCandidate; rows: unknown[]; truncated: boolean } | null> {
    for (const cand of candidates) {
      const firstPath = `${cand.path}?offset=0&limit=${PAGE_LIMIT}${cand.extraQuery ?? ''}`;
      const first = await this.authedGet(firstPath);
      if (first.status === 404) continue; // workspace/release variance — try the next API
      if (first.status < 200 || first.status >= 300) throw new HttpStatusError(first.status, firstPath);

      const rows = extractRows(first.body);
      const total = extractTotal(first.body);
      let offset = rows.length;
      let lastPageSize = rows.length;
      let pages = 1;
      while (pages < MAX_PAGES && lastPageSize >= PAGE_LIMIT && (total === null || offset < total)) {
        const path = `${cand.path}?offset=${offset}&limit=${PAGE_LIMIT}${cand.extraQuery ?? ''}`;
        const res = await this.authedGet(path);
        // Page 1 worked, so the path is valid: a failure here fails the section.
        if (res.status < 200 || res.status >= 300) throw new HttpStatusError(res.status, path);
        const pageRows = extractRows(res.body);
        if (pageRows.length === 0) break;
        rows.push(...pageRows);
        offset += pageRows.length;
        lastPageSize = pageRows.length;
        pages += 1;
      }
      const truncated = pages >= MAX_PAGES && lastPageSize >= PAGE_LIMIT && (total === null || offset < total);
      return { candidate: cand, rows, truncated };
    }
    return null;
  }

  /**
   * GET with a bearer token; one invalidation + retry on 401 (mirrors
   * central), plus a bounded backoff on 429 so a rate-limited workspace paces
   * the poll instead of degrading the plane every cycle. Retry-After wins over
   * the exponential floor; every attempt is recorded, so the Activity tab
   * shows the real 429s.
   */
  private async authedGet(path: string): Promise<HttpResult> {
    for (let attempt = 0; ; attempt += 1) {
      let res = await this.http('GET', path, { token: await this.tokens.get() });
      if (res.status === 401) {
        this.tokens.invalidate();
        res = await this.http('GET', path, { token: await this.tokens.get() });
      }
      if (res.status !== 429 || attempt >= RATE_LIMIT_RETRIES) return res;
      const backoffMs = RATE_LIMIT_BASE_MS * 2 ** attempt;
      await this.sleep(Math.min(res.retryAfterMs ?? backoffMs, RATE_LIMIT_CAP_MS));
    }
  }

  /**
   * Timed outbound call recorded in the plane's call log. The log carries
   * method + path + ms + status only — never a body, so never a secret.
   * `form` sends application/x-www-form-urlencoded (the OAuth2 doors expect
   * form encoding per RFC 6749); `body` sends JSON.
   */
  private async http(
    method: 'GET' | 'POST',
    path: string,
    opts: { token?: string; body?: unknown; form?: Record<string, string> } = {},
  ): Promise<HttpResult> {
    const started = Date.now();
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: {
          accept: 'application/json',
          ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...(opts.form !== undefined ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
          ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
        },
        body:
          opts.form !== undefined
            ? new URLSearchParams(opts.form).toString()
            : opts.body !== undefined
              ? JSON.stringify(opts.body)
              : undefined,
        signal: AbortSignal.timeout(OUTBOUND_TIMEOUT_MS),
      });
    } catch (err) {
      this.recordCall({ path: `${method} ${path}`, ms: Date.now() - started, code: 'network-error' });
      throw new Error(`${method} ${path} failed: ${(err as Error).message}`);
    }
    this.recordCall({ path: `${method} ${path}`, ms: Date.now() - started, code: String(res.status) });
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      /* tolerate a non-JSON body — status is what we needed */
    }
    // Additive field: callers reading { status, body } are unaffected.
    const retryAfterMs = parseRetryAfterMs(res.headers.get('retry-after'));
    return { status: res.status, body, ...(retryAfterMs !== null ? { retryAfterMs } : {}) };
  }
}
