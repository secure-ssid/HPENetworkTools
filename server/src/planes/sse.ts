/**
 * server/src/planes/sse.ts — HPE Aruba Networking SSE (formerly Axis
 * Security / Atmos) adapter.
 *
 * A security/object-management plane, not a network-monitoring one: there are
 * no devices/clients/alerts here, only a paged inventory of the resources the
 * SSE Admin console itself edits — connector zones, connectors, locations,
 * tunnels, NetworkRange applications, users, groups, and the two writable
 * category types (custom IP categories, IP-feed categories).
 *
 * Auth and endpoint spellings are VERIFIED against the official Python SDK
 * source (aruba/pyhpesse, pyhpesse/common.py + pyhpesse/adminapi.py — fetched
 * and read directly, not guessed):
 *   base    https://admin-api.axissecurity.com (HPESecureServiceEdgeApiLogin's
 *           own default; the connect drawer may override it)
 *   auth    Authorization: Bearer <api_token> on every call — a single static,
 *           scoped Admin API token (Settings → Admin API → New API Token in
 *           the SSE console). There is no token-mint step and no documented
 *           expiry, so PlaneTokenInfo.expiresAt stays null (registry.ts
 *           tokenFor()) unless a future tenant publishes one.
 *   paths   /api/v1.0/ConnectorZones, /api/v1.0/Connectors, /api/v1.0/Locations,
 *           /api/v1.0/Tunnels, /api/v1.0/Applications, /api/v1.0/Users,
 *           /api/v1.0/Groups, /api/v1.0/IpCategories, /api/v1.0/IpCategoriesFeed,
 *           /api/v1.0/Commit — note the literal ".0" and PascalCase resource
 *           names: an earlier assumption (this repo's own plan notes) guessed
 *           lower-case "/api/v1/connectors"-style paths before the SDK source
 *           was actually read. The SDK is the more authoritative source and
 *           this adapter follows it.
 *   paging  query params `pagenumber` / `pagesize` (lower-case, no camelCase —
 *           SDK's `_generate_parameterised_url`), NOT the pageSize/pageNumber
 *           spelling an earlier assumption used.
 *   mutate  POST (create) / PUT (update) / DELETE, body JSON, 2xx on success;
 *           the SDK does not itself assert a status code, so any 2xx counts.
 *   commit  POST /api/v1.0/Commit with an empty body — REQUIRED after any
 *           create/update/delete before the change is live. A failed commit
 *           leaves the object change STAGED, not applied; retryCommit() is
 *           the only safe recovery (it never replays the mutation).
 *
 * Response envelope: the SDK returns the parsed JSON body verbatim and does
 * not itself assert a row container, so this adapter is defensive the same
 * way clearpass.ts is — try the documented `data` array first, then a small
 * set of tolerated alternates, then give up and mark the kind unreadable
 * rather than report a fabricated empty list.
 *
 * Failure policy: every kind carries a secret-free reason through the cached
 * inventory. Healthy kinds survive beside failed ones; if every kind fails,
 * the pull still carries those reasons so the poller can cache the evidence
 * while degrading the plane rather than serving an older healthy-looking
 * inventory.
 *
 * Security: the token travels in the Authorization header only, never in a
 * URL or a log line; the call log records method + path + ms + status only.
 * A `users` object's `sshPrivateKey` field (the SDK's own body shape) is
 * stripped from every summary/detail payload this adapter returns — the
 * portal must not become a second place that key can leak from.
 */

import { createHash } from 'node:crypto';
import type { PlaneCredentials } from '../config/settings';
import {
  SSE_LIMITED_RELEASE_KINDS,
  SSE_OBJECT_KINDS,
  type SseCommitOutcome,
  type SseInventory,
  type SseKindReadStatus,
  type SseMutationAction,
  type SseMutationOutcome,
  type SseObjectKind,
  type SseObjectKindResult,
  type SseObjectSummary,
} from '../../../shared';
import { parseRetryAfterMs, type FetchLike, type RecordCallFn, type SleepFn } from './central';
import type { PlaneAdapter, PlaneCapabilities, PlanePull, PlaneState } from './types';

export type { FetchLike } from './central';

const OUTBOUND_TIMEOUT_MS = 10_000;
export const SSE_DEFAULT_BASE_URL = 'https://admin-api.axissecurity.com';
export const SSE_INSECURE_HTTP_OVERRIDE_ENV = 'HPE_SSE_ALLOW_INSECURE_HTTP_FOR_TESTS';
const COMMIT_PATH = '/api/v1.0/Commit';

/** 429 backoff — a throttle is retried, bounded; every other status is final. */
const RATE_LIMIT_RETRIES = 2;
const RATE_LIMIT_BASE_MS = 1_000;
const RATE_LIMIT_CAP_MS = 15_000;

const realSleep: SleepFn = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** Per-kind page size and page cap — nine kinds every poll must stay cheap. */
const PAGE_SIZE = 100;
const MAX_PAGES_PER_KIND = 3;
const MAX_ROWS_PER_KIND = PAGE_SIZE * MAX_PAGES_PER_KIND;

/** One kind's REST surface: its collection path and which fields identify a
 *  row for the generic list→summary mapper. Verified spellings only — this
 *  table IS the allowlist a route path can be built from; a kind that is not
 *  a key of SSE_KIND_SPEC can never reach an outbound URL. */
interface SseKindSpec {
  path: string;
  /** Field the SDK body requires for a create (README-style: "Mandatory Body
   *  Parameters" in the SDK's own docstring; `users` names none explicitly,
   *  so `userName` is this adapter's own minimum-viable requirement). */
  requiredCreateField: string;
  /** Field read as the summary row's display name. */
  nameField: string;
}

export const SSE_KIND_SPEC: Record<SseObjectKind, SseKindSpec> = {
  connectorZones: { path: '/api/v1.0/ConnectorZones', requiredCreateField: 'name', nameField: 'name' },
  connectors: { path: '/api/v1.0/Connectors', requiredCreateField: 'name', nameField: 'name' },
  locations: { path: '/api/v1.0/Locations', requiredCreateField: 'name', nameField: 'name' },
  tunnels: { path: '/api/v1.0/Tunnels', requiredCreateField: 'name', nameField: 'name' },
  applications: { path: '/api/v1.0/Applications', requiredCreateField: 'name', nameField: 'name' },
  users: { path: '/api/v1.0/Users', requiredCreateField: 'userName', nameField: 'userName' },
  groups: { path: '/api/v1.0/Groups', requiredCreateField: 'name', nameField: 'name' },
  customIpCategories: { path: '/api/v1.0/IpCategories', requiredCreateField: 'name', nameField: 'name' },
  ipFeedCategories: { path: '/api/v1.0/IpCategoriesFeed', requiredCreateField: 'name', nameField: 'name' },
};

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

function filled(v: unknown): boolean {
  return typeof v === 'string' && v.trim().length > 0;
}

export class SseEndpointValidationError extends Error {
  readonly status = 400;
}

function insecureHttpOverrideEnabled(): boolean {
  return (
    process.env[SSE_INSECURE_HTTP_OVERRIDE_ENV] === '1' &&
    (process.env.NODE_ENV === 'test' || process.env.NODE_ENV === 'development')
  );
}

/**
 * Validate and canonicalize an SSE Admin API base URL before a static bearer
 * token can be attached to any request. Custom endpoints require an explicit
 * scheme; plaintext HTTP is available only to test/development processes via
 * a process environment override and can never be enabled by request data.
 */
export function normalizeSseBaseUrl(base: string | null | undefined): string {
  const raw = base?.trim();
  if (!raw) return SSE_DEFAULT_BASE_URL;
  if (!/^[a-z][a-z\d+.-]*:\/\//i.test(raw)) {
    throw new SseEndpointValidationError('SSE Admin API base URL must start with https://');
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SseEndpointValidationError('SSE Admin API base URL must be a valid https:// URL');
  }
  if (!url.hostname || url.username || url.password) {
    throw new SseEndpointValidationError(
      'SSE Admin API base URL must be a valid https:// URL without embedded credentials',
    );
  }
  if (url.protocol === 'http:') {
    if (!insecureHttpOverrideEnabled()) {
      throw new SseEndpointValidationError('SSE Admin API base URL must use https://; plaintext HTTP is disabled');
    }
  } else if (url.protocol !== 'https:') {
    throw new SseEndpointValidationError('SSE Admin API base URL must use https://');
  }
  url.hash = '';
  url.search = '';
  url.pathname = url.pathname.replace(/\/+$/, '');
  return url.toString().replace(/\/+$/, '');
}

/**
 * A field this adapter must never surface: a tunnel/user secret riding along
 * in the raw vendor body (authenticationPsk, sshPrivateKey, apiToken, …).
 * Anything matching this is dropped before a row leaves the adapter.
 */
const RAW_SECRET_KEY = /psk|privatekey|password|secret|token|apitoken/i;

function stripSecrets(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (RAW_SECRET_KEY.test(k)) continue;
    out[k] = v;
  }
  return out;
}

/** kind-specific second fact for the list row — best-effort, never required. */
function detailFor(kind: SseObjectKind, r: Record<string, unknown>): string | undefined {
  switch (kind) {
    case 'connectors':
      return str(r.connectorZoneId) ? `zone ${str(r.connectorZoneId)}` : undefined;
    case 'tunnels':
      return str(r.locationID ?? r.locationId) ? `location ${str(r.locationID ?? r.locationId)}` : undefined;
    case 'locations':
      return Array.isArray(r.tunnels) ? `${r.tunnels.length} tunnel(s)` : undefined;
    case 'users':
      return str(r.email) ?? undefined;
    case 'groups':
      return Array.isArray(r.users) ? `${r.users.length} user(s)` : undefined;
    case 'applications': {
      const nrad = r.networkRangeApplicationData;
      const ranges = nrad && typeof nrad === 'object' ? (nrad as Record<string, unknown>).ipRangesOrCIDRs : undefined;
      return Array.isArray(ranges) && ranges.length > 0 ? String(ranges[0]) + (ranges.length > 1 ? ` +${ranges.length - 1}` : '') : undefined;
    }
    case 'customIpCategories':
    case 'ipFeedCategories':
      return Array.isArray(r.includedIps) ? `${r.includedIps.length} included IP(s)` : undefined;
    case 'connectorZones':
      return Array.isArray(r.connectors) ? `${r.connectors.length} connector(s)` : undefined;
    default:
      return undefined;
  }
}

/** One vendor object → the generic summary row every kind renders through. */
export function mapSseObject(kind: SseObjectKind, raw: unknown): SseObjectSummary | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const id = str(r.id);
  if (!id) return null;
  const spec = SSE_KIND_SPEC[kind];
  const name = str(r[spec.nameField]) ?? str(r.name) ?? id;
  const clean = stripSecrets(r);
  return {
    kind,
    id,
    name,
    ...(str(r.description) ? { description: str(r.description) as string } : {}),
    ...(typeof r.enabled === 'boolean' ? { enabled: r.enabled } : {}),
    ...(r.systemDefined === true || r.builtIn === true || r.readOnly === true ? { builtIn: true } : {}),
    ...(detailFor(kind, r) ? { detail: detailFor(kind, r) } : {}),
    raw: clean,
  };
}

/** Documented `data` container first, then tolerated alternates, then a bare
 *  top-level array — null (not `[]`) when nothing recognisable is present, so
 *  a 200 with an unreadable body cannot masquerade as "this kind has none". */
function extractRows(body: unknown): unknown[] | null {
  if (Array.isArray(body)) return body;
  if (body && typeof body === 'object') {
    const r = body as Record<string, unknown>;
    for (const key of ['data', 'items', 'results', 'records', 'list']) {
      if (Array.isArray(r[key])) return r[key] as unknown[];
    }
    const embedded = r._embedded as Record<string, unknown> | undefined;
    if (embedded) {
      for (const key of Object.keys(embedded)) {
        if (Array.isArray(embedded[key])) return embedded[key] as unknown[];
      }
    }
  }
  return null;
}

function extractTotal(body: unknown, rows: unknown[], pageSize: number): number | null {
  const r = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const total = num(r.totalRecords ?? r.total ?? r.count ?? r.totalCount);
  if (total !== null && total >= rows.length) return total;
  if (rows.length < pageSize) return rows.length; // the whole collection fitted in one page
  return null; // a full page's own count proves nothing about the rest
}

interface HttpResult {
  status: number;
  body: unknown;
  retryAfterMs?: number;
}

/** Thrown only for a transport failure (DNS/TLS/timeout), distinct from an
 * HTTP status so the caller can preserve an accurate unreachable reason. */
class SseTransportError extends Error {}

interface SseKindFetchResult {
  result: SseObjectKindResult | null;
  readStatus: SseKindReadStatus;
}

function failedKindRead(
  reason: Exclude<SseKindReadStatus, { state: 'ok' }>['reason'],
  httpCode: number | null,
  message: string,
): SseKindFetchResult {
  return { result: null, readStatus: { state: 'failed', reason, httpCode, message } };
}

/**
 * getObject()'s result: a real 404 ('not-found') is kept distinct from a
 * scope/auth failure ('denied', 401/403) and from any other transport or
 * unreadable-body failure ('unreachable') — the caller must not collapse an
 * auth or network fault into "the object does not exist".
 */
export type SseObjectReadResult =
  | { status: 'ok'; httpCode: number; object: Record<string, unknown> }
  | { status: 'not-found'; httpCode: 404; message: string }
  | { status: 'denied'; httpCode: number; message: string }
  | { status: 'unreachable'; httpCode: number | null; message: string };

/**
 * The adapter's own mutate() result — mutation + commit + staged, WITHOUT the
 * cache-refresh outcome: cache-refresh is a poller concern the adapter has no
 * access to, so the service layer (sseObjects.ts) is what turns this into the
 * shared, route-facing `SseMutationResult` (which additionally carries
 * `cacheRefresh`).
 */
export interface SseAdapterMutateResult {
  mutation: SseMutationOutcome;
  commit: SseCommitOutcome;
  staged: boolean;
  outcome: 'unverified' | 'staged' | 'unknown' | 'rejected';
}

/** SSE Commit is TENANT-WIDE: it applies every currently staged change on the
 *  tenant, not only the one mutation that just triggered it. This must be
 *  surfaced every time a commit is attempted, success or failure alike. */
const TENANT_WIDE_COMMIT_WARNING =
  "SSE Commit is tenant-wide: it applies every staged change on this tenant right now, not only the change just made \u2014 review the tenant's other staged changes before relying on this result alone.";

export class SseAdapter implements PlaneAdapter {
  readonly id = 'sse' as const;

  private readonly baseUrl: string;
  private readonly token: string;
  /** Parsed from the connect drawer's scope checkboxes (settings key
   *  `scopes`), the same mechanism every other plane's write-scope flag uses
   *  (shared/logic.ts scopeForPlane). There is no way to introspect an Admin
   *  API token's real grants ahead of a call, so this is the operator's own
   *  declaration — the mutation routes still enforce it server-side, and any
   *  write the token itself refuses still comes back 401/403 regardless of
   *  what was declared here. */
  private readonly writeGranted: boolean;

  constructor(
    creds: PlaneCredentials,
    private readonly stateRef: PlaneState,
    private readonly recordCall: RecordCallFn,
    private readonly fetchImpl: FetchLike = (url, init) => fetch(url, init),
    private readonly sleep: SleepFn = realSleep,
  ) {
    if (!SseAdapter.isComplete(creds)) {
      throw new Error('sse requires an Admin API token');
    }
    this.baseUrl = normalizeSseBaseUrl(filled(creds.baseUrl) ? (creds.baseUrl as string) : undefined);
    this.token = creds.token as string;
    this.writeGranted = (creds.scopes ?? '').includes('write');
  }

  static isComplete(creds: PlaneCredentials | null): boolean {
    return !!creds && filled(creds.token);
  }

  /** Stable, secret-free binding for durable mutation state. */
  tenantFingerprint(): string {
    const tokenHash = createHash('sha256').update(this.token, 'utf8').digest('hex');
    return `sse:${createHash('sha256').update(`${this.baseUrl}\n${tokenHash}`, 'utf8').digest('hex')}`;
  }

  state(): PlaneState {
    return this.stateRef;
  }

  /**
   * SSE is not a network plane (no shell, no port/VLAN/SSID config, no
   * ticketed broker) — its one write path is its own object CRUD + automatic
   * commit, gated on whatever write scope the operator declared for this
   * token. `configRead` stays false: `sse` inventory is a distinct
   * PlanePull field the Configure screen never reads.
   */
  capabilities(): PlaneCapabilities {
    return { localShell: false, brokeredWrite: false, configRead: false, directWrite: this.writeGranted };
  }

  async pull(): Promise<PlanePull> {
    const kinds: SseInventory['kinds'] = {};
    const unavailable: SseObjectKind[] = [];
    const readStatus: NonNullable<SseInventory['readStatus']> = {};
    for (const kind of SSE_OBJECT_KINDS) {
      const outcome = await this.fetchKind(kind);
      readStatus[kind] = outcome.readStatus;
      if (outcome.result === null) {
        unavailable.push(kind);
      } else {
        kinds[kind] = outcome.result;
      }
    }
    const readCount = Object.keys(kinds).length;
    const totalRows = Object.values(kinds).reduce((sum, k) => sum + (k?.rows.length ?? 0), 0);
    const source = `${new URL(this.baseUrl).hostname} · ${readCount} of ${SSE_OBJECT_KINDS.length} object kinds read`;
    this.stateRef.note =
      readCount === 0
        ? `SSE inventory read failed for all ${SSE_OBJECT_KINDS.length} object kinds`
        : `${totalRows.toLocaleString('en-US')} objects across ${readCount} kinds${
            unavailable.length > 0 ? ` · ${unavailable.length} failed` : ''
          }`;
    if (unavailable.length === 0 && this.stateRef.health === 'warning') this.stateRef.health = 'healthy';
    return {
      sse: { kinds, unavailable, readStatus, source },
      ...(unavailable.length > 0 ? { partial: ['sse'] as const } : {}),
    };
  }

  /** One on-demand kind refresh — the Systems Configuration tab's inventory
   *  browser reads through GET /api/sse/inventory (poller cache), but this is
   *  reused directly by pull() and is exposed so a route can force a single
   *  kind's fresh page without paying for all nine. */
  async fetchKind(kind: SseObjectKind): Promise<SseKindFetchResult> {
    const spec = SSE_KIND_SPEC[kind];
    const rows: unknown[] = [];
    let total: number | null = null;
    let truncated = false;
    for (let page = 1; page <= MAX_PAGES_PER_KIND; page += 1) {
      const path = `${spec.path}?pagenumber=${page}&pagesize=${PAGE_SIZE}`;
      let res: HttpResult;
      try {
        res = await this.authedGet(path);
      } catch {
        return failedKindRead(
          'unreachable',
          null,
          'The SSE service could not be reached for this kind because the request failed or timed out.',
        );
      }
      if (res.status === 401 || res.status === 403) {
        return failedKindRead(
          'denied',
          res.status,
          `The SSE Admin API denied this kind (HTTP ${res.status}); check the token's granted scope.`,
        );
      }
      if (res.status === 404) {
        const limited = SSE_LIMITED_RELEASE_KINDS.includes(kind);
        return failedKindRead(
          'unsupported',
          404,
          limited
            ? 'This SSE kind is limited-release or is not enabled for this tenant (HTTP 404).'
            : 'This SSE kind is not supported by the connected service (HTTP 404).',
        );
      }
      if (res.status < 200 || res.status >= 300) {
        return failedKindRead(
          'service-error',
          res.status,
          res.status === 429
            ? 'The SSE service rate-limited this kind (HTTP 429); retry after the service recovers.'
            : `The SSE service returned an error for this kind (HTTP ${res.status}); retry after the service recovers.`,
        );
      }
      const pageRows = extractRows(res.body);
      if (pageRows === null) {
        return failedKindRead(
          'invalid-response',
          res.status,
          `The SSE service returned HTTP ${res.status}, but the successful response was not a recognized inventory shape.`,
        );
      }
      rows.push(...pageRows);
      if (page === 1) total = extractTotal(res.body, pageRows, PAGE_SIZE);
      if (pageRows.length < PAGE_SIZE) break; // short page — reached the end
      if (rows.length >= MAX_ROWS_PER_KIND) {
        truncated = true;
        break;
      }
    }
    const mapped = rows.slice(0, MAX_ROWS_PER_KIND).map((r) => mapSseObject(kind, r)).filter((r): r is SseObjectSummary => r !== null);
    return { result: { rows: mapped, total, truncated }, readStatus: { state: 'ok' } };
  }

  /** GET one object by id — the edit/detail drawer's on-demand read (the
   *  clientDetail/deviceDetail pattern: fresh, per-object, off the poll loop).
   *  A discriminated result, NOT a bare null: 'not-found' (a real 404 on the
   *  object), 'denied' (401/403 — a scope problem) and 'unreachable'
   *  (transport failure, or any other non-2xx/unreadable body) must stay
   *  distinguishable all the way to the route response — collapsing them all
   *  into "404" would report an auth or network fault as if the object simply
   *  did not exist. */
  async getObject(kind: SseObjectKind, id: string): Promise<SseObjectReadResult> {
    const path = `${SSE_KIND_SPEC[kind].path}/${encodeURIComponent(id)}`;
    let res: HttpResult;
    try {
      res = await this.authedGet(path);
    } catch (err) {
      return { status: 'unreachable', httpCode: null, message: `request failed: ${(err as Error).message}` };
    }
    if (res.status === 401 || res.status === 403) {
      return { status: 'denied', httpCode: res.status, message: `Admin API rejected the request — HTTP ${res.status}` };
    }
    if (res.status === 404) return { status: 'not-found', httpCode: 404, message: `HTTP 404` };
    if (res.status < 200 || res.status >= 300) {
      return { status: 'unreachable', httpCode: res.status, message: `Admin API answered HTTP ${res.status}` };
    }
    if (!res.body || typeof res.body !== 'object') {
      return { status: 'unreachable', httpCode: res.status, message: 'HTTP 200 with an unreadable body' };
    }
    return { status: 'ok', httpCode: res.status, object: stripSecrets(res.body as Record<string, unknown>) };
  }

  /**
   * create/update/delete + the mandatory commit, reported as two separate
   * outcomes. `fields`/`id` are the ROUTE's already-validated input — this
   * method trusts the caller for shape, not for authorization (the plane
   * itself is the authority on that, via the HTTP status it returns).
   */
  async mutate(kind: SseObjectKind, action: SseMutationAction, id?: string, fields?: Record<string, unknown>): Promise<SseAdapterMutateResult> {
    const mutation = await this.mutateOnly(kind, action, id, fields);
    if (mutation.acceptance !== 'accepted') {
      const unknown = mutation.acceptance === 'unknown';
      return {
        mutation,
        commit: {
          attempted: false,
          ok: false,
          httpCode: null,
          acceptance: 'not-attempted',
          message: unknown
            ? 'not attempted — mutation acceptance is unknown; use the reviewed recovery path'
            : 'not attempted — the mutation was rejected',
        },
        staged: unknown,
        outcome: unknown ? 'unknown' : 'rejected',
      };
    }
    const commit = await this.commit();
    const unknown = commit.acceptance === 'unknown';
    return {
      mutation,
      commit,
      staged: !commit.ok,
      outcome: commit.ok ? 'unverified' : unknown ? 'unknown' : 'staged',
    };
  }

  /** Mutation only. The service persists its journal before calling this. */
  async mutateOnly(
    kind: SseObjectKind,
    action: SseMutationAction,
    id?: string,
    fields?: Record<string, unknown>,
  ): Promise<SseMutationOutcome> {
    return this.performMutation(SSE_KIND_SPEC[kind].path, action, id, fields);
  }

  /** Commit-only retry — the safe recovery from a staged mutation. Never
   *  replays the create/update/delete that already landed. */
  async retryCommit(): Promise<SseCommitOutcome> {
    return this.commit();
  }

  private async performMutation(
    path: string,
    action: SseMutationAction,
    id?: string,
    fields?: Record<string, unknown>,
  ): Promise<SseMutationOutcome> {
    const method = action === 'create' ? 'POST' : action === 'update' ? 'PUT' : 'DELETE';
    const fullPath = action === 'create' ? path : `${path}/${encodeURIComponent(id ?? '')}`;
    let res: HttpResult;
    try {
      res = await this.authed(method, fullPath, action === 'delete' ? undefined : fields);
    } catch (err) {
      return {
        ok: false,
        httpCode: null,
        acceptance: 'unknown',
        message: `request outcome unknown: ${(err as Error).message}`,
      };
    }
    if (res.status < 200 || res.status >= 300) {
      return {
        ok: false,
        httpCode: res.status,
        acceptance: 'rejected',
        message: `${method} ${fullPath} answered HTTP ${res.status}`,
      };
    }
    const body = res.body && typeof res.body === 'object' ? (res.body as Record<string, unknown>) : {};
    const returnedId = str(body.id) ?? id;
    return {
      ok: true,
      httpCode: res.status,
      acceptance: 'accepted',
      ...(returnedId ? { id: returnedId } : {}),
      message: `${action} accepted — HTTP ${res.status}`,
    };
  }

  private async commit(): Promise<SseCommitOutcome> {
    let res: HttpResult;
    try {
      res = await this.authed('POST', COMMIT_PATH, {});
    } catch (err) {
      return {
        attempted: true,
        ok: false,
        httpCode: null,
        acceptance: 'unknown',
        message: `commit outcome unknown: ${(err as Error).message}`,
        warning: TENANT_WIDE_COMMIT_WARNING,
      };
    }
    const ok = res.status >= 200 && res.status < 300;
    return {
      attempted: true,
      ok,
      httpCode: res.status,
      acceptance: ok ? 'accepted' : 'rejected',
      message: ok
        ? `Commit accepted — HTTP ${res.status}; this alone does not verify the journaled object mutation`
        : `commit answered HTTP ${res.status} — change is staged, retry commit`,
      warning: TENANT_WIDE_COMMIT_WARNING,
    };
  }

  // -- internals -------------------------------------------------------------

  private async authed(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<HttpResult> {
    return this.http(method, path, body);
  }

  /** Authenticated GET with a bounded 429 backoff. A static token is never
   *  retried on 401/403 — it cannot self-heal, so the caller must treat that
   *  as "this kind/action is denied", not a transient fault. */
  private async authedGet(path: string): Promise<HttpResult> {
    for (let attempt = 0; ; attempt += 1) {
      const res = await this.http('GET', path);
      if (res.status !== 429 || attempt >= RATE_LIMIT_RETRIES) return res;
      const backoffMs = RATE_LIMIT_BASE_MS * 2 ** attempt;
      await this.sleep(Math.min(res.retryAfterMs ?? backoffMs, RATE_LIMIT_CAP_MS));
    }
  }

  /**
   * Timed outbound call recorded in the plane's call log (method + path + ms
   * + status only — never the token, never a body). A network failure is
   * re-thrown as SseTransportError so pull() can tell it apart from an HTTP
   * status the plane actually answered with.
   */
  private async http(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<HttpResult> {
    const started = Date.now();
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        redirect: 'manual',
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${this.token}`,
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(OUTBOUND_TIMEOUT_MS),
      });
    } catch (err) {
      this.recordCall({ path: `${method} ${path}`, ms: Date.now() - started, code: 'network-error' });
      throw new SseTransportError(`${method} ${path} failed: ${(err as Error).message}`);
    }
    this.recordCall({ path: `${method} ${path}`, ms: Date.now() - started, code: String(res.status) });
    let parsed: unknown = null;
    try {
      parsed = await res.json();
    } catch {
      /* tolerate a non-JSON body (e.g. a 204 with no content) */
    }
    const retryAfterMs = parseRetryAfterMs(res.headers.get('retry-after'));
    return { status: res.status, body: parsed, ...(retryAfterMs !== null ? { retryAfterMs } : {}) };
  }
}
