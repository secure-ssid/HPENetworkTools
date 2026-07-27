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
 *
 * Failure policy (mirrors central):
 *   - 404 on every candidate → pull() fails naming the section — the
 *     subscriptions feed is this plane's whole dataset, so there is nothing
 *     honest to degrade to.
 *   - any other HTTP/network error → pull() throws naming the section, so the
 *     poller marks the plane degraded and keeps serving the last good cache.
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
 *   - expires: ISO/epoch → 'MMM YYYY' display ('Mar 2027', UTC month). The
 *     exact instant rides along in the expiresAtMs/daysLeft hints so
 *     /api/licenses can compute renewals and stats without re-parsing display
 *     strings — same pattern as central's serial/mac identity hints.
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

import type { Subscription, SubscriptionRow, Tone } from '../../../shared';
import type { PlaneCredentials } from '../config/settings';
import { parseTimestamp, TokenManager, type FetchLike, type RecordCallFn } from './central';
import type { PlaneAdapter, PlanePull, PlaneState } from './types';

// Re-exported so tests can type an in-memory fake fetch against this adapter.
export type { FetchLike } from './central';

const OUTBOUND_TIMEOUT_MS = 10_000;
const DEFAULT_BASE_URL = 'https://global.api.greenlake.hpe.com';
const DAY_MS = 86_400_000;
const YEAR_MS = 365.25 * DAY_MS;

/** A subscription this close to expiry renders as 'expiring' (warning). */
export const EXPIRING_SOON_DAYS = 90;

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

/** Epoch ms → the month-precision expiry display ('Mar 2027'), UTC-based. */
export function expiryDisplay(ms: number): string {
  const d = new Date(ms);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
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
  return {
    name,
    sku:
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
      str(r.id) ??
      '—',
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

  constructor(
    creds: PlaneCredentials,
    private readonly stateRef: PlaneState,
    private readonly recordCall: RecordCallFn,
    private readonly fetchImpl: FetchLike = (url, init) => fetch(url, init),
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
        return { accessToken: token, expiresInSec: num(record.expires_in) ?? 7200 };
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

    const expiring = subscriptions.filter((s) => s.status === 'expiring').length;
    this.stateRef.note =
      `${subscriptions.length.toLocaleString('en-US')} subscriptions · ` +
      `${expiring.toLocaleString('en-US')} expiring < ${EXPIRING_SOON_DAYS}d` +
      // A page-capped read is a partial inventory — say so rather than let the
      // count read as the whole truth.
      (page.truncated ? ` · partial (page cap ${MAX_PAGES})` : '');
    if (this.stateRef.health === 'warning') this.stateRef.health = 'healthy'; // first sync done

    return { subscriptions };
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
      this.resolvedPath = cand;
      const truncated = pages >= MAX_PAGES && lastPageSize >= PAGE_LIMIT && (total === null || offset < total);
      return { rows, truncated };
    }
    throw new SectionMissingError();
  }

  /** GET with a bearer token; one invalidation + retry on 401 (mirrors central). */
  private async authedGet(path: string): Promise<{ status: number; body: unknown }> {
    let res = await this.http('GET', path, { token: await this.tokens.get() });
    if (res.status === 401) {
      this.tokens.invalidate();
      res = await this.http('GET', path, { token: await this.tokens.get() });
    }
    return res;
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
  ): Promise<{ status: number; body: unknown }> {
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
    return { status: res.status, body };
  }
}
