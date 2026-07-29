/**
 * web/src/api/client.ts — typed API layer, one function per screen endpoint.
 *
 * Every getter tries the backend first (`/api/...`) and, when the backend is
 * unreachable (network error — e.g. the server simply isn't running yet),
 * falls back to the shared fixtures so the UI is fully functional in demo
 * mode. Responses carry `dataSource: 'live' | 'demo'` so screens can say so.
 * The detail getters (site/device) go further: an ANSWERED non-OK is live
 * data saying "not in the cache", not an absent backend — it returns the
 * honest null-profile shape instead of substituting fixtures.
 * The on-demand per-object reads (getClientDetail / getSiteTopology, and the
 * `detail`/`topology` blocks the screen envelopes carry) have their own rules —
 * see "THREE STATES, PRESERVED ACROSS THIS BOUNDARY" below.
 */

import {
  ALERTS,
  AUTH_EVENTS,
  AUTH_FAIL_REASONS,
  AUTH_STATS,
  BASELINE_PROGRESS,
  CAPABILITY_MATRIX,
  CLIENT_STATS,
  CLIENTS,
  COMPLIANCE_DIFF,
  COMPLIANCE_STATS,
  CONFIGURE_STATS,
  CONFIG_PORTS,
  DEVICE_CLIENT_SETS,
  DEVICE_CONFIGS,
  DEVICE_RECONCILIATION,
  DEVICES,
  FINDINGS,
  LANE_META,
  LICENSE_STATS,
  ORPHANS,
  OVERVIEW_ALERTS,
  OVERVIEW_CHANGES,
  OVERVIEW_LAUNCHPAD,
  OVERVIEW_PLANES,
  OVERVIEW_SITES,
  OVERVIEW_STATS,
  PERMISSIONS,
  POLICY_SERVICES,
  QUEUED_CHANGES,
  RENEWALS,
  SEARCH_INDEX,
  SITES,
  SITE_IDS,
  SITE_PROFILES,
  SITE_STATS,
  SSIDS,
  SUBSCRIPTIONS,
  SYNC_HISTORY,
  SYSTEMS,
  TICKETS,
  VLANS,
  canonicalizeWebhookCreateForm,
  deriveSiteProfile,
  deviceProfile,
  isRealSiteId,
  siteIdFor,
  terminalBanner,
  terminalQuickCommands,
} from '../../../shared';
import type {
  AlertCorrelation,
  AlertRow,
  AuthEventRow,
  BaselineProgressRow,
  BlastRadiusRow,
  BrokerAuditEvent,
  CapabilityRow,
  ChangeLogEntry,
  ClientDetailLive,
  ClientRow,
  ConfigForm,
  ConfigKind,
  DeviceCfg,
  DeviceCheckRow,
  DeviceClientSet,
  DeviceDetailLive,
  DeviceEvidence,
  DiagnosticAuditEntry,
  DiagnosticEligibilityResponse,
  DiagnosticJob,
  DiagnosticReview,
  DiagnosticReviewRequest,
  DiagnosticStartRequest,
  DeviceProfile,
  DeviceRow,
  FailReasonRow,
  FindingRow,
  LaneMeta,
  LaunchpadRow,
  OrphanRow,
  OverviewAlert,
  OverviewPlaneRow,
  OverviewSiteRow,
  PermissionRow,
  Plane,
  PlaneScope,
  PolicyServiceRow,
  PortObject,
  QueuedChangeRow,
  RenewalRow,
  SearchIndexEntry,
  SectionMode,
  SiteAlertRow,
  SiteDeviceRow,
  SiteId,
  SiteProfile,
  SiteReachability,
  SiteRow,
  SiteTopologyLive,
  SsidApplyResult,
  SsidCatalog,
  SsidObject,
  SseCommitRetryResult,
  SseInventory,
  SseKindReadStatus,
  SseManualCleanupResult,
  SseMutationResult,
  SseObjectKind,
  SseObjectSummary,
  StatDef,
  SubscriptionRow,
  SyncHistoryRow,
  SystemRow,
  TerminalLine,
  TicketRow,
  VlanObject,
  WebhookDetail,
  WebhookForm,
  WebhookHandoffResolutionResult,
  WebhookHandoffStatus,
  WebhookListEnvelope,
  WebhookMutationResult,
  WebhookOneTimeSecretResult,
  WebhookPatchForm,
  WebhookUnknownOutcomeCode,
} from '../../../shared';

// ---------------------------------------------------------------------------
// Response envelopes (per-screen view models + dataSource)
// ---------------------------------------------------------------------------

export type DataSource = 'live' | 'demo';

interface ScreenEnvelope {
  dataSource: DataSource;
  syncedAt?: string | null;
  blended?: string[];
  /** Present when the backend answered but could not serve the screen. */
  apiError?: string;
}

export interface OverviewData extends ScreenEnvelope {
  stats: StatDef[];
  alerts: OverviewAlert[];
  sites: OverviewSiteRow[];
  planes: OverviewPlaneRow[];
  changes: ChangeLogEntry[];
  launchpad: LaunchpadRow[];
  syncedAt: string | null; // null in live mode before the first successful poll
  workspace?: string;
}

export type SystemCredentialPayload = Record<string, string | string[]>;

export interface AlertsData extends ScreenEnvelope {
  alerts: AlertRow[];
  syncedAt: string | null;
  /** The danger/warning banner over the queue, when the ROUTE correlates it —
   *  the server can cross the worst finding with plane freshness, which a
   *  client-side correlate() over already-pulled rows cannot see. Absent (or
   *  null) = no server correlation was sent and the screen's own correlate()
   *  stays the single source; `tone` absent inside it keeps the renderer's
   *  existing 'danger' default. */
  correlation?: AlertCorrelation | null;
}

export interface TicketsData extends ScreenEnvelope {
  tickets: TicketRow[];
}

export interface ClientsData extends ScreenEnvelope {
  stats: StatDef[];
  clients: ClientRow[];
  /** The three keys below appear ONLY when the request named one client
   *  (`/api/clients?mac=…`) — the route does no per-object read for a plain
   *  list poll, which is what keeps the 60s tick off the tenant's call budget.
   *  `null` on any of them is the route's honest "no plane could answer". */
  client?: ClientRow | null;
  detail?: ClientDetailLive | null;
  topology?: SiteTopologyLive | null;
}

export interface AuthEventsData extends ScreenEnvelope {
  stats: StatDef[];
  events: AuthEventRow[];
  failReasons: FailReasonRow[];
  policyServices: PolicyServiceRow[];
}

export interface SitesData extends ScreenEnvelope {
  stats: StatDef[];
  sites: SiteRow[];
}

export interface SiteDetailData extends ScreenEnvelope {
  site: SiteRow | null; // null = the API does not know this site at all (404)
  profile: SiteProfile | null; // null = live/blend row only — no authored profile exists
  /** README §7's two per-site sections, sent alongside a null profile in
   *  live/blend mode. In demo mode they live inside `profile` instead. */
  devices?: SiteDeviceRow[];
  alerts?: SiteAlertRow[];
  /** README §7's "Local reachability" panel in live/blend mode, where there is
   *  no authored profile to read it from: the route derives it from the local
   *  collector plane's registry state plus the LOCAL-claimed share of this
   *  site's devices. `reachValue: null` means the portal does not know the
   *  answering share — render '—', never 0%. Absent = the route sent nothing
   *  and the panel keeps its honest NOT REPORTED state. In demo mode the same
   *  four values live on `profile` instead. */
  reachability?: SiteReachability;
  /** The claiming plane's LINK topology for this site — the device graph and
   *  the port-to-port links behind it — read ON THE DETAIL REQUEST PATH for
   *  this one site, never on the 60s poll. See the three-state rule below:
   *  absent envelope = the route attached nothing, absent `nodes`/`links` =
   *  that section was not fetched, present-and-empty = the plane answered with
   *  no graph. This client never fills either in. */
  topology?: SiteTopologyLive;
}

// -- THREE STATES, PRESERVED ACROSS THIS BOUNDARY ---------------------------
//
// The on-demand detail payloads below (ClientDetailLive, DeviceDetailLive,
// SiteTopologyLive) each carry a `source.sections` map saying what happened to
// every section of the read, because the screens word three outcomes
// differently: never asked / asked and there is genuinely nothing / asked and
// the call failed. A stationary camera with no roams is "no roaming in the
// last 24h", not "no source".
//
// So the rule for every getter here: an ABSENT array stays absent and an EMPTY
// array stays empty. Defaulting a missing array to [] would turn "we never
// asked" into "there are none", which is the exact fabrication this whole pass
// exists to remove. Nothing below applies `?? []` to a detail array.

/** Every detail payload carries a provenance envelope; a body without one
 *  cannot be read three-state. Used the same way getChangeQueue() checks for
 *  an array: a wrong-shaped 200 is an API failure, not an empty result. */
function carriesDetailSource(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const source = (value as { source?: unknown }).source;
  return (
    !!source &&
    typeof source === 'object' &&
    typeof (source as { plane?: unknown }).plane === 'string' &&
    typeof (source as { sections?: unknown }).sections === 'object'
  );
}

/**
 * Drop an ATTACHED detail block that arrived without its provenance envelope.
 *
 * Such a block is unreadable rather than empty — nothing in it says whether a
 * missing array means "not fetched" or "the call failed" — and a screen that
 * rendered it would have to guess, which is how "—" starts meaning three
 * different things again. Dropping it leaves the panel's existing honest empty
 * state. It is deliberately NOT promoted to an apiError: one unreadable
 * sub-block must not blank a device, site or clients page whose other panels
 * are fine — the honest empty state is the smaller loss.
 */
function dropUnreadableBlocks<T extends object>(data: T, ...keys: DetailBlockKey[]): T {
  const unreadable = keys.filter((key) => {
    const block = (data as Record<string, unknown>)[key];
    // `null` is the route's own honest "no plane could answer" and is kept.
    return block !== undefined && block !== null && !carriesDetailSource(block);
  });
  if (unreadable.length === 0) return data;
  const copy = { ...data } as Record<string, unknown>;
  for (const key of unreadable) delete copy[key];
  return copy as T;
}

/** The two keys a route attaches a detail payload under. */
type DetailBlockKey = 'detail' | 'topology';

export interface DevicesData extends ScreenEnvelope {
  devices: DeviceRow[];
  lanes: Partial<Record<Plane, LaneMeta>>;
  reconciliation?: { doubleClaimed: number; unclaimed: number };
  /** Demo mode only: fixture names the operator hid, for the restore affordance. */
  hiddenDevices?: string[];
}

export interface DeviceDetailData extends ScreenEnvelope {
  device: DeviceRow | null; // null = live mode, device not in the poller cache
  profile: DeviceProfile | null; // null in live mode — the authored profile is demo data
  config: DeviceCfg | null;
  clients: DeviceClientSet | null;
  /** Shell banner + quick-command chips as the ROUTE computes them. The demo
   *  branch (and this client's offline demo fallback) sends it; the screen may prefer it over
   *  re-deriving the pair from the fixture profile, so the server stays the
   *  authority once the live branch serves a platform-correct command set.
   *  Absent = no payload sent; fall back to the shared helpers. */
  terminal?: { banner: TerminalLine[]; quickCommands: string[] };
  /** Per-device evidence for the Compliance panel. `mode` is what keeps an
   *  EMPTY list from reading as "everything passes": 'unavailable' means no
   *  plane supplied evidence and the panel must say so. Absent = the route
   *  sent nothing at all; in demo mode the authored `profile.checks` is the
   *  source instead. Normalized by getDeviceDetail(), so the screen only ever
   *  sees this one shape. */
  evidence?: DeviceEvidence;
  /** Per-device live subresources — radios + WLANs for an AP, ports for a
   *  switch — read ON THE DETAIL REQUEST PATH for this one device, never on
   *  the 60s poll. Same three states as `SiteDetailData.topology`: absent
   *  envelope = the route attached nothing, absent array = that section was
   *  not fetched (an AP is not asked for ports), present-and-empty = the plane
   *  answered with nothing. Consult `detail.source.sections` before writing
   *  any "nothing here" sentence. */
  detail?: DeviceDetailLive;
  /** The site graph this device sits in, when the route attaches one — it is
   *  what names the far end of an uplink. Same three states as `detail`. */
  topology?: SiteTopologyLive;
}

export interface LicensesData extends ScreenEnvelope {
  stats: StatDef[];
  subscriptions: SubscriptionRow[];
  renewals: RenewalRow[];
  orphans: OrphanRow[];
}

export interface ConfigureData extends ScreenEnvelope {
  stats: StatDef[];
  ssids: SsidObject[];
  ports: PortObject[];
  vlans: VlanObject[];
  inventoryMode: 'configured' | 'observed' | 'unavailable';
  queued: QueuedChangeRow[];
  capabilities: CapabilityRow[];
}

export interface ComplianceData extends ScreenEnvelope {
  stats: StatDef[];
  findings: FindingRow[];
  baselines: BaselineProgressRow[];
  diff: string;
  evidenceMode: 'baseline' | 'coverage' | 'unavailable';
}

export interface SystemsData extends ScreenEnvelope {
  systems: SystemRow[];
  syncHistory: SyncHistoryRow[];
  permissions: PermissionRow[];
}

export interface SearchIndexData extends ScreenEnvelope {
  entries: SearchIndexEntry[];
}

// ---------------------------------------------------------------------------
// Fetch helpers
// ---------------------------------------------------------------------------

async function fromApi<T>(path: string): Promise<T | null> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), SCREEN_REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(path, { signal: controller.signal });
  } catch {
    return null;
  } finally {
    window.clearTimeout(timer);
  }
  if (!response.ok) throw new Error(await serverMessage(response, `HTTP ${response.status}`));
  try {
    return (await response.json()) as T;
  } catch {
    throw new Error('The portal API returned invalid JSON.');
  }
}

async function fromStrictOptionalApi<T>(path: string, notFoundIsNull = false): Promise<T | null> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), SCREEN_REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(path, { signal: controller.signal });
  } catch {
    return null;
  } finally {
    window.clearTimeout(timer);
  }
  if (notFoundIsNull && response.status === 404) return null;
  if (!response.ok) throw new Error(await serverMessage(response, `HTTP ${response.status}`));
  try {
    return (await response.json()) as T;
  } catch {
    throw new Error('The portal API returned invalid JSON.');
  }
}

type ScreenFetch<T> =
  | { kind: 'ok'; data: T }
  | { kind: 'http-error'; message: string }
  | { kind: 'unreachable' };

const SCREEN_REQUEST_TIMEOUT_MS = 15_000;

/**
 * Screen endpoints only use fixtures when no backend answered. An HTTP error
 * is an explicit live/API failure and must never turn into believable demo
 * inventory.
 */
async function fetchScreen<T>(path: string): Promise<ScreenFetch<T>> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), SCREEN_REQUEST_TIMEOUT_MS);
  try {
    const r = await fetch(path, { signal: controller.signal });
    if (r.ok) {
      try {
        return { kind: 'ok', data: (await r.json()) as T };
      } catch {
        return { kind: 'http-error', message: 'The portal API returned invalid JSON.' };
      }
    }
    return { kind: 'http-error', message: await serverMessage(r, `HTTP ${r.status}`) };
  } catch {
    if (controller.signal.aborted) {
      return { kind: 'http-error', message: 'The portal API did not respond within 15 seconds.' };
    }
    return { kind: 'unreachable' };
  } finally {
    window.clearTimeout(timer);
  }
}

function apiFailure<T extends ScreenEnvelope>(message: string, empty: Omit<T, keyof ScreenEnvelope>): T {
  return {
    ...empty,
    dataSource: 'live',
    syncedAt: null,
    apiError: message,
  } as T;
}

/**
 * Detail-getter helper: like fromApi, but distinguishes an ANSWERED non-OK
 * (the backend is up and says "not in the live cache" — never substitute
 * fixtures for that) from an unreachable backend (demo fallback allowed).
 */
async function fetchDetail<T>(
  path: string,
): Promise<
  | { kind: 'ok'; data: T }
  | { kind: 'answered'; status: number; message: string; dataSource?: DataSource; blended?: string[] }
  | { kind: 'unreachable' }
> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), SCREEN_REQUEST_TIMEOUT_MS);
  try {
    const r = await fetch(path, { signal: controller.signal });
    if (r.ok) {
      try {
        return { kind: 'ok', data: (await r.json()) as T };
      } catch {
        return { kind: 'answered', status: 502, message: 'The portal API returned invalid JSON.' };
      }
    }
    let body: { error?: string; message?: string; dataSource?: DataSource; blended?: string[] } = {};
    try {
      body = (await r.json()) as typeof body;
    } catch {
      /* use the HTTP fallback below */
    }
    return {
      kind: 'answered',
      status: r.status,
      message: body.error ?? body.message ?? `HTTP ${r.status}`,
      dataSource: body.dataSource,
      blended: body.blended,
    };
  } catch {
    if (controller.signal.aborted) {
      return { kind: 'answered', status: 504, message: 'The portal API did not respond within 15 seconds.' };
    }
    return { kind: 'unreachable' };
  } finally {
    window.clearTimeout(timer);
  }
}

/** The stamp the prototype hard-codes in the Overview header. */
const DEMO_SYNCED_AT = '09:41';

// ---------------------------------------------------------------------------
// Screen endpoints
// ---------------------------------------------------------------------------

export async function getOverview(): Promise<OverviewData> {
  const result = await fetchScreen<OverviewData>('/api/overview');
  if (result.kind === 'ok') return result.data;
  if (result.kind === 'http-error') {
    return apiFailure<OverviewData>(result.message, {
      stats: [],
      alerts: [],
      sites: [],
      planes: [],
      changes: [],
      launchpad: [],
    });
  }
  return {
    stats: OVERVIEW_STATS,
    alerts: OVERVIEW_ALERTS,
    sites: OVERVIEW_SITES,
    planes: OVERVIEW_PLANES,
    changes: OVERVIEW_CHANGES,
    launchpad: OVERVIEW_LAUNCHPAD,
    syncedAt: DEMO_SYNCED_AT,
    dataSource: 'demo',
  };
}

export async function getAlerts(): Promise<AlertsData> {
  const result = await fetchScreen<AlertsData>('/api/alerts');
  if (result.kind === 'ok') return result.data;
  if (result.kind === 'http-error') return apiFailure<AlertsData>(result.message, { alerts: [] });
  return { alerts: ALERTS, syncedAt: DEMO_SYNCED_AT, dataSource: 'demo' };
}

export async function getTickets(): Promise<TicketsData> {
  const result = await fetchScreen<TicketsData>('/api/tickets');
  if (result.kind === 'ok') return result.data;
  if (result.kind === 'http-error') return apiFailure<TicketsData>(result.message, { tickets: [] });
  return { tickets: TICKETS, dataSource: 'demo' };
}

/**
 * The clients screen. Pass `mac` ONLY from a drawer open, never from the poll:
 * naming a client makes the route issue that client's per-object detail read,
 * and doing that on a 60s timer across a whole list is what the tenant's daily
 * call budget cannot survive.
 */
export async function getClients(mac?: string): Promise<ClientsData> {
  const result = await fetchScreen<ClientsData>(
    mac ? `/api/clients?mac=${encodeURIComponent(mac)}` : '/api/clients',
  );
  if (result.kind === 'ok') return dropUnreadableBlocks(result.data, 'detail', 'topology');
  if (result.kind === 'http-error') {
    return apiFailure<ClientsData>(result.message, { stats: [], clients: [] });
  }
  return { stats: CLIENT_STATS, clients: CLIENTS, dataSource: 'demo' };
}

// ---------------------------------------------------------------------------
// On-demand detail reads — the per-object blocks the routes attach to
// /api/clients?mac=…, /api/sites/:siteId and /api/devices/:name
//
// These are NOT poller work. A plane models one client across several
// per-object endpoints and one device across many /{id}/subresource endpoints;
// fanning those out over every row on every 60s tick would spend the tenant's
// daily call budget on data nobody is looking at. Each getter below is for the
// ONE object whose drawer is open, called once per selection.
//
// They return the payload or `null`, never an envelope and never fixtures:
//
//   * `null` = the portal could not obtain a READABLE payload — no backend, a
//     build without the route, an HTTP failure, or a body with no provenance.
//     The panel keeps the honest empty state it already had. It is deliberately
//     NOT an ApiErrorState: these reads are supplementary, and blanking a
//     drawer whose other twenty rows are true would be a worse lie than the
//     missing figure. It is also never fixtures — there is no authored client
//     detail, and inventing one would put fabricated radio numbers against a
//     real endpoint's MAC.
//   * A payload = whatever the plane said, passed through UNTOUCHED. The read
//     that was attempted and failed is not null: the route marks the section
//     'failed' inside `source.sections`, which is how the drawer can say the
//     call broke instead of implying the plane has nothing.
// ---------------------------------------------------------------------------

/**
 * Take the detail payload out of the screen envelope the route attaches it to.
 *
 * Same reasoning as normalizeEvidence() below — one shape for the screen, no
 * guessing at the call site — and it also accepts a route that answers with
 * the bare payload. A block with no provenance envelope is discarded rather
 * than rendered: with no `source.sections` there is no way to tell "asked and
 * empty" from "the call failed", and a figure whose meaning is unknown must
 * not reach an operator.
 */
function unwrapDetailPayload<T>(body: unknown, key: DetailBlockKey): T | null {
  if (!body || typeof body !== 'object') return null;
  if (carriesDetailSource(body)) return body as T;
  const block = (body as Record<string, unknown>)[key];
  return carriesDetailSource(block) ? (block as T) : null;
}

/** Shared body of the two on-demand reads; see the section note above. */
async function readDetail<T>(path: string, key: DetailBlockKey): Promise<T | null> {
  const r = await fetchDetail<unknown>(path);
  return r.kind === 'ok' ? unwrapDetailPayload<T>(r.data, key) : null;
}

/**
 * The client's own detail — signal, throughput, roam count, session timeline —
 * for the ONE client whose drawer is open.
 *
 * It rides `/api/clients?mac=`: the route does the per-object read only when a
 * request names a client, so the plain list poll stays exactly as cheap as it
 * was. Never call this from the polling loop.
 */
export async function getClientDetail(mac: string): Promise<ClientDetailLive | null> {
  return readDetail<ClientDetailLive>(`/api/clients?mac=${encodeURIComponent(mac)}`, 'detail');
}

/**
 * The plane's link topology for one site — the device graph and the
 * port-to-port links behind it, which is what makes a client's wiring and
 * path-to-the-internet rows real rather than guessed.
 *
 * It rides `/api/sites/:siteId`, where the route already attaches it, and the
 * server caches the read, so opening several drawers in one site costs one
 * call rather than one per drawer.
 */
export async function getSiteTopology(siteId: string): Promise<SiteTopologyLive | null> {
  return readDetail<SiteTopologyLive>(`/api/sites/${encodeURIComponent(siteId)}`, 'topology');
}

export async function getAuthEvents(): Promise<AuthEventsData> {
  const result = await fetchScreen<AuthEventsData>('/api/auth-events');
  if (result.kind === 'ok') return result.data;
  if (result.kind === 'http-error') {
    return apiFailure<AuthEventsData>(result.message, {
      stats: [],
      events: [],
      failReasons: [],
      policyServices: [],
    });
  }
  return {
    stats: AUTH_STATS,
    events: AUTH_EVENTS,
    failReasons: AUTH_FAIL_REASONS,
    policyServices: POLICY_SERVICES,
    dataSource: 'demo',
  };
}

export async function getSites(): Promise<SitesData> {
  const result = await fetchScreen<SitesData>('/api/sites');
  if (result.kind === 'ok') return result.data;
  if (result.kind === 'http-error') return apiFailure<SitesData>(result.message, { stats: [], sites: [] });
  return { stats: SITE_STATS, sites: SITES, dataSource: 'demo' };
}

export async function getSiteDetail(param: string): Promise<SiteDetailData> {
  const r = await fetchDetail<SiteDetailData>(
    `/api/sites/${encodeURIComponent(param)}`,
  );
  if (r.kind === 'ok') return dropUnreadableBlocks(r.data, 'topology');
  if (r.kind === 'answered') {
    if (r.status !== 404) {
      return apiFailure<SiteDetailData>(r.message, { site: null, profile: null });
    }
    // The backend answered (unknown site, or live/blend mode with the site
    // not in the live inventory) — an honest not-found, never the authored
    // local-only fallback profile.
    return {
      site: null,
      profile: null,
      dataSource: r.dataSource ?? 'live',
      ...(r.blended ? { blended: r.blended } : {}),
    };
  }
  // Backend absent: mirror the server's own demo branch (screens.ts:1493-1507)
  // rather than the prototype's fallback(). 'core-services', 'workspace' and
  // 'multiple' are bookkeeping ids that alert/device rows file under — they
  // have no inventory row, so a page for them would be a fabricated site. And
  // a real site with no authored profile gets one derived from the portal's
  // OWN inventory row, never Warehouse-DC1's authored numbers.
  const id = (SITE_IDS as readonly string[]).includes(param) ? (param as SiteId) : siteIdFor(param);
  if (!id || !isRealSiteId(id)) return { site: null, profile: null, dataSource: 'demo' };
  return {
    site: SITES.find((s) => s.id === id) ?? null,
    profile: SITE_PROFILES[id] ?? deriveSiteProfile(id),
    dataSource: 'demo',
  };
}

export async function getDevices(): Promise<DevicesData> {
  const result = await fetchScreen<DevicesData>('/api/devices');
  if (result.kind === 'ok') return result.data;
  if (result.kind === 'http-error') return apiFailure<DevicesData>(result.message, { devices: [], lanes: {} });
  // Offline demo: carry the authored estate truth in the envelope so the
  // reconciliation banner reads from the payload rather than the screen
  // re-importing the fixture on its own.
  return {
    devices: DEVICES,
    lanes: LANE_META,
    reconciliation: DEVICE_RECONCILIATION,
    dataSource: 'demo',
  };
}

/**
 * The device-detail evidence block, normalized to one shape.
 *
 * The route may serve the four per-device checks either as the full
 * `evidence: DeviceEvidence` block or as a bare `checks: DeviceCheckRow[]`.
 * Collapsing both here means the screen has a single contract to render and
 * never has to guess what an empty list means: a bare list that came back
 * empty is 'unavailable' (no plane supplied evidence), NOT a clean scorecard.
 */
function normalizeEvidence(data: DeviceDetailData & { checks?: DeviceCheckRow[] }): DeviceDetailData {
  const { checks, ...rest } = data;
  if (rest.evidence || !checks) return rest;
  return {
    ...rest,
    evidence: {
      checks,
      mode: checks.length === 0 ? 'unavailable' : rest.dataSource === 'demo' ? 'demo' : 'live',
      ...(checks.length === 0 ? { note: 'No plane reported evidence for this device.' } : {}),
    },
  };
}

/** Identity carried alongside `name` on GET /api/devices/:name — the same
 *  plane+serial pair the server needs to pick one row when reconciliation has
 *  left two rows sharing a display name (see server/src/routes/screens.ts
 *  resolveDeviceIdentity). Both optional: search hits and other screens'
 *  name-only fields still work as long as the name stays unique. */
export interface DeviceDetailIdentity {
  plane?: string;
  serial?: string;
}

export async function getDeviceDetail(
  name: string,
  identity: DeviceDetailIdentity = {},
): Promise<DeviceDetailData> {
  const params = new URLSearchParams();
  if (identity.plane) params.set('plane', identity.plane);
  if (identity.serial) params.set('serial', identity.serial);
  const qs = params.toString();
  const r = await fetchDetail<DeviceDetailData & { checks?: DeviceCheckRow[] }>(
    `/api/devices/${encodeURIComponent(name)}${qs ? `?${qs}` : ''}`,
  );
  if (r.kind === 'ok') return dropUnreadableBlocks(normalizeEvidence(r.data), 'detail', 'topology');
  if (r.kind === 'answered') {
    if (r.status !== 404) {
      return apiFailure<DeviceDetailData>(r.message, {
        device: null,
        profile: null,
        config: null,
        clients: null,
      });
    }
    // The backend answered (live mode, device not in the poller cache) — an
    // honest not-found, never the authored fixture profile.
    return {
      device: null,
      profile: null,
      config: null,
      clients: null,
      dataSource: r.dataSource ?? 'live',
      ...(r.blended ? { blended: r.blended } : {}),
    };
  }
  // Offline demo fallback: the authored fixtures never carry a duplicate
  // name, but resolve by serial first anyway so this path matches the
  // server's own identity order rather than a name-only shortcut.
  const device =
    (identity.serial ? DEVICES.find((row) => row.serial === identity.serial) : undefined) ??
    DEVICES.find((row) => row.name === name) ??
    null;
  if (!device) {
    return { device: null, profile: null, config: null, clients: null, dataSource: 'demo' };
  }
  const profile = deviceProfile(device.name);
  return {
    device,
    profile,
    // Mirror the server's own demo branch (screens.ts `terminal:` block) rather
    // than a thinner offline shape: with no backend the screen must still get
    // the same envelope it gets from the demo route, or the terminal panel
    // silently changes behaviour depending on whether the server is running.
    terminal: {
      banner: terminalBanner(profile.kind),
      quickCommands: terminalQuickCommands(profile.kind),
    },
    // Same reason, for the Compliance panel: the authored profile's checks ARE
    // the demo evidence, so serve them under the one `evidence` key both modes
    // read. Without this the offline demo page would be the only place with a
    // profile but no evidence block, and a screen that reads `evidence`
    // uniformly would lose the panel exactly when there is no backend to blame.
    evidence: { checks: profile.checks, mode: 'demo' },
    config: DEVICE_CONFIGS[profile.kind],
    clients: DEVICE_CLIENT_SETS[profile.kind],
    dataSource: 'demo',
  };
}

export async function getLicenses(): Promise<LicensesData> {
  const result = await fetchScreen<LicensesData>('/api/licenses');
  if (result.kind === 'ok') return result.data;
  if (result.kind === 'http-error') {
    return apiFailure<LicensesData>(result.message, {
      stats: [],
      subscriptions: [],
      renewals: [],
      orphans: [],
    });
  }
  return {
    stats: LICENSE_STATS,
    subscriptions: SUBSCRIPTIONS,
    renewals: RENEWALS,
    orphans: ORPHANS,
    dataSource: 'demo',
  };
}

export async function getConfigure(): Promise<ConfigureData> {
  const result = await fetchScreen<ConfigureData>('/api/configure');
  if (result.kind === 'ok') return result.data;
  if (result.kind === 'http-error') {
    return apiFailure<ConfigureData>(result.message, {
      stats: [],
      ssids: [],
      ports: [],
      vlans: [],
      inventoryMode: 'unavailable',
      queued: [],
      capabilities: [],
    });
  }
  return {
    stats: CONFIGURE_STATS,
    ssids: SSIDS,
    ports: CONFIG_PORTS,
    vlans: VLANS,
    inventoryMode: 'configured',
    queued: QUEUED_CHANGES,
    capabilities: CAPABILITY_MATRIX,
    dataSource: 'demo',
  };
}

// ---------------------------------------------------------------------------
// Write broker — /api/configure/* (render / dry-run / queue / push / discard)
//
// The broker is authoritative for queue state whenever the backend is
// reachable. Every mutation returns the server's own message on non-OK
// ({error}) instead of throwing, and marks network failures `offline: true`
// so the Configure screen can fall back to its local-only behavior.
// ---------------------------------------------------------------------------

/** Uniform failure half of ApiResult; `offline` = backend unreachable.
 *  `httpCode` (set only when a real HTTP response came back) lets a caller
 *  distinguish a definite server answer (400/403/409) from a transport-
 *  level 502 "the outcome is unknown" — see isUnknownWebhookOutcome. */
export interface ApiError {
  error: string;
  offline?: boolean;
  httpCode?: number;
  outcome?: 'unknown';
  code?: WebhookUnknownOutcomeCode;
  operationId?: string;
}

export function isApiError(value: unknown): value is ApiError {
  return !!value && typeof value === 'object' && typeof (value as ApiError).error === 'string';
}

export type ApiResult<T> = T | ApiError;

async function postForResult<T>(path: string, body: unknown): Promise<ApiResult<T>> {
  try {
    const r = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (r.ok) return (await r.json()) as T;
    return { error: await serverMessage(r, `request failed — HTTP ${r.status}`) };
  } catch (err) {
    return { error: `cannot reach the portal backend: ${(err as Error).message}`, offline: true };
  }
}

/** POST /api/configure/render — pure render, no ticket needed. */
export interface RenderedConfig {
  rendered: string;
  meta: string;
  blastRadius: BlastRadiusRow[];
}

export async function renderConfig(kind: ConfigKind, form: ConfigForm): Promise<ApiResult<RenderedConfig>> {
  return postForResult<RenderedConfig>('/api/configure/render', { kind, form });
}

/** POST /api/configure/dry-run — ticket-gated rehearsal (+ rollback snapshot when linked). */
export interface DryRunResult extends RenderedConfig {
  ok: boolean;
  kind: string;
  ticket: string;
  target: 'central' | 'console';
  reachable: boolean | null; // null = no read-back attempted
  snapshot: boolean; // a rollback snapshot was stored (kept 24h)
  httpCode?: number;
  note: string; // honest one-liner from the broker
}

export async function dryRunConfig(
  kind: ConfigKind,
  form: ConfigForm,
  ticket: string,
): Promise<ApiResult<DryRunResult>> {
  return postForResult<DryRunResult>('/api/configure/dry-run', { kind, form, ticket });
}

/** A queued change as the broker persists it (server BrokeredChange). */
export interface BrokeredChange {
  id: string;
  object: { kind: ConfigKind; form: ConfigForm };
  what: string;
  ticket: string;
  state: 'ready' | 'applying' | 'needs window' | 'console';
  where: string;
  rendered: string;
  createdAt: string; // ISO
  expiresAt: string | null; // 15-min lease on ready changes
}

export async function queueChange(
  kind: ConfigKind,
  form: ConfigForm,
  ticket: string,
): Promise<ApiResult<BrokeredChange>> {
  return postForResult<BrokeredChange>('/api/configure/queue', { kind, form, ticket });
}

/** GET /api/configure/queue — null only when no backend answers. */
export async function getChangeQueue(): Promise<BrokeredChange[] | ApiError | null> {
  const result = await fetchScreen<{ changes: BrokeredChange[] }>('/api/configure/queue');
  if (result.kind === 'ok') {
    // A 200 carrying the wrong body is an API failure, not an empty queue:
    // handing `undefined` to the screen would silently read as "nothing is
    // pending" and let the operator push against a queue nobody can see.
    if (!Array.isArray(result.data?.changes)) {
      return { error: 'The portal API returned an unexpected change-queue payload.' };
    }
    return result.data.changes;
  }
  if (result.kind === 'http-error') return { error: result.message };
  return null;
}

/**
 * GET /api/configure/history — the broker's own audit log, newest first.
 *
 * Same rule as getChangeQueue(): null ONLY when no backend answered (there is
 * no fixture audit log — an authored one would be a fabricated record of
 * changes this install never brokered), and an HTTP error surfaces as {error}
 * rather than turning into an empty list that reads as "nothing ever happened".
 *
 * SECURITY: BrokerAuditEvent is {ts,event,changeId,ticket,kind,result} —
 * shared/types.ts pins that rendered configuration bodies are NOT part of the
 * row. Nothing here may widen it.
 */
export async function getChangeHistory(limit = 50): Promise<BrokerAuditEvent[] | ApiError | null> {
  const result = await fetchScreen<{ events: BrokerAuditEvent[] }>(
    `/api/configure/history?limit=${encodeURIComponent(String(limit))}`,
  );
  if (result.kind === 'ok') {
    // Same rule as an HTTP error: a wrong-shaped 200 must not collapse into an
    // empty drawer that reads as "nothing has ever been brokered here".
    if (!Array.isArray(result.data?.events)) {
      return { error: 'The portal API returned an unexpected change-history payload.' };
    }
    return result.data.events;
  }
  if (result.kind === 'http-error') return { error: result.message };
  return null;
}

/** Push outcome; `applied` is true ONLY on a 2xx from the plane. */
export interface PushResult {
  ok: boolean;
  applied: boolean;
  changeId: string;
  ticket: string;
  kind: string;
  httpCode?: number;
  snapshot: boolean;
  message: string;
}

export async function pushChange(changeId: string): Promise<ApiResult<PushResult>> {
  return postForResult<PushResult>('/api/configure/push', { changeId });
}

export async function discardChange(changeId: string): Promise<ApiResult<{ ok: boolean; changeId: string }>> {
  return postForResult<{ ok: boolean; changeId: string }>('/api/configure/discard', { changeId });
}

// ---------------------------------------------------------------------------
// SSID direct write — /api/configure/ssids/* (catalog + reviewed apply)
//
// SSIDs do NOT go through the ticketed queue/dry-run/push above: the editor
// loads a live catalog when its drawer opens, then applies a reviewed change
// directly (no ticket — an explicit reviewConfirmed:true stands in for one).
// ---------------------------------------------------------------------------

/**
 * GET /api/configure/ssids/catalog — never 4xx on its own; an unlinked or
 * Classic-only Central answers 200 with every section named in
 * `unavailable` so the drawer can disable what it cannot offer instead of
 * guessing. `null` means the backend itself did not answer at all.
 */
export async function getSsidCatalog(): Promise<SsidCatalog | ApiError | null> {
  const result = await fetchScreen<SsidCatalog>('/api/configure/ssids/catalog');
  if (result.kind === 'ok') return result.data;
  if (result.kind === 'http-error') return { error: result.message };
  return null;
}

/**
 * POST /api/configure/ssids/apply — a reviewed direct SSID change.
 * `reviewConfirmed` must be `true`; the server logs one audit line per
 * attempt (success, partial, or failure) with no ticket and no payload body.
 */
export async function applySsidDirect(form: ConfigForm, reviewConfirmed: boolean): Promise<ApiResult<SsidApplyResult>> {
  return postForResult<SsidApplyResult>('/api/configure/ssids/apply', { form, reviewConfirmed });
}

// ---------------------------------------------------------------------------
// New Central webhook management — /api/central/webhooks/*
//
// Reads never throw for an unlinked/Classic/permission-denied Central; they
// answer with the envelope's own honest `error` (list) so the panel can
// render "nothing to show, and why" without treating it as a network
// failure. Mutations require `reviewConfirmed: true`; the server's own
// response is always the outcome to render (ok:false is a normal result,
// not a thrown error) — see server/src/services/centralWebhooks.ts.
//
// Create and HMAC-key rotation require two independent confirmations. Their
// successful response is the only client
// contract carrying `hmacKey`; callers must hand it directly to the dedicated
// one-time modal and discard it on close. A separate secretStored:true
// acknowledgement clears the server's durable, secret-free handoff journal.
// The key never enters list/detail state, browser storage, settings, generic
// mutation history, or toast text.
// ---------------------------------------------------------------------------

function emptyWebhookEnvelope(opts: { limit?: number; offset?: number }, error: string): WebhookListEnvelope {
  return {
    items: [],
    totalCount: 0,
    count: 0,
    limit: opts.limit ?? 10,
    offset: opts.offset ?? 0,
    hasMore: false,
    source: 'unavailable',
    error,
    gatewayBaseUrl: null,
    tenantBinding: null,
  };
}

/** GET /api/central/webhooks — never throws; an unreachable backend or a
 *  non-OK response both answer the same honest envelope shape with `error`
 *  set and `items: []`. */
export async function getCentralWebhooks(
  opts: { limit?: number; offset?: number; q?: string } = {},
): Promise<WebhookListEnvelope> {
  const params = new URLSearchParams();
  if (opts.limit !== undefined) params.set('limit', String(opts.limit));
  if (opts.offset !== undefined) params.set('offset', String(opts.offset));
  if (opts.q?.trim()) params.set('q', opts.q.trim());
  const qs = params.toString();
  try {
    const r = await fetch(`/api/central/webhooks${qs ? `?${qs}` : ''}`);
    if (!r.ok) return emptyWebhookEnvelope(opts, await serverMessage(r, `request failed — HTTP ${r.status}`));
    const body = (await r.json()) as Partial<WebhookListEnvelope>;
    if (!Array.isArray(body.items)) {
      return emptyWebhookEnvelope(opts, 'the portal returned a successful but unrecognized webhook list response');
    }
    return body as WebhookListEnvelope;
  } catch (err) {
    return emptyWebhookEnvelope(opts, `cannot reach the portal backend: ${(err as Error).message}`);
  }
}

/** GET /api/central/webhooks/:id — fresh single-webhook detail, used to
 *  populate the edit drawer's "before" state for the review diff. */
export async function getCentralWebhook(id: string): Promise<ApiResult<WebhookDetail>> {
  try {
    const r = await fetch(`/api/central/webhooks/${encodeURIComponent(id)}`);
    if (r.ok) return (await r.json()) as WebhookDetail;
    return { error: await serverMessage(r, `request failed — HTTP ${r.status}`) };
  } catch (err) {
    return { error: `cannot reach the portal backend: ${(err as Error).message}`, offline: true };
  }
}

export async function getCentralWebhookHandoffStatus(): Promise<ApiResult<WebhookHandoffStatus>> {
  try {
    const r = await fetch('/api/central/webhooks/handoff');
    if (r.ok) return (await r.json()) as WebhookHandoffStatus;
    return { error: await serverMessage(r, `request failed — HTTP ${r.status}`), httpCode: r.status };
  } catch (err) {
    return { error: `cannot reach the portal backend: ${(err as Error).message}`, offline: true };
  }
}

export async function acknowledgeCentralWebhookHandoff(
  operationId: string,
  secretStored: true,
): Promise<ApiResult<WebhookHandoffResolutionResult>> {
  try {
    const r = await fetch('/api/central/webhooks/handoff/acknowledge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ operationId, secretStored }),
    });
    if (r.ok) return (await r.json()) as WebhookHandoffResolutionResult;
    return { error: await serverMessage(r, `request failed — HTTP ${r.status}`), httpCode: r.status };
  } catch (err) {
    return { error: `cannot reach the portal backend: ${(err as Error).message}`, offline: true };
  }
}

export async function resolveCentralWebhookHandoff(input: {
  operationId: string;
  resolution: 'create-located' | 'create-absent' | 'rotate-reconciled';
  reviewConfirmed: true;
  attestations: Record<string, true>;
  matchedWebhookId?: string;
}): Promise<ApiResult<WebhookHandoffResolutionResult>> {
  try {
    const r = await fetch('/api/central/webhooks/handoff/resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (r.ok) return (await r.json()) as WebhookHandoffResolutionResult;
    return { error: await serverMessage(r, `request failed — HTTP ${r.status}`), httpCode: r.status };
  } catch (err) {
    return { error: `cannot reach the portal backend: ${(err as Error).message}`, offline: true };
  }
}

async function webhookMutate(
  path: string,
  method: 'PATCH' | 'DELETE',
  body: unknown,
  secrets: readonly string[] = [],
): Promise<ApiResult<WebhookMutationResult>> {
  try {
    const r = await fetch(path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (r.ok) return (await r.json()) as WebhookMutationResult;
    const responseBody = await responseJson(r);
    if (r.status === 409) {
      const conflict = webhookConflictResult(responseBody, secrets);
      if (conflict) return conflict;
    }
    // `httpCode` lets the caller tell a definite, known failure (400/403/409
    // — safe to let the operator see and retry immediately) apart from a 502
    // "the outcome is unknown" transport answer, which is not (see
    // isUnknownWebhookOutcome below).
    return {
      error: redactWebhookSecrets(messageFromBody(responseBody, `request failed — HTTP ${r.status}`), secrets),
      httpCode: r.status,
    };
  } catch (err) {
    return {
      error: redactWebhookSecrets(`cannot reach the portal backend: ${(err as Error).message}`, secrets),
      offline: true,
    };
  }
}

function webhookCreateForm(form: WebhookForm): WebhookForm | null {
  if (form.authMechanism === 'API_KEY' || form.authMechanism === 'OIDC') {
    return canonicalizeWebhookCreateForm(form);
  }
  return null;
}

function parseOneTimeWebhookResult(
  body: unknown,
  expectedAction: 'created' | 'rotated',
): WebhookOneTimeSecretResult | null {
  try {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
    const record = body as Record<string, unknown>;
    if (
      record.ok !== true ||
      record.action !== expectedAction ||
      typeof record.operationId !== 'string' ||
      typeof record.hmacKey !== 'string' ||
      record.hmacKey.trim().length === 0
    ) {
      return null;
    }
    return {
      ok: true,
      action: expectedAction,
      operationId: record.operationId,
      hmacKey: record.hmacKey,
      message:
        expectedAction === 'created'
          ? 'webhook created — copy the one-time HMAC key now'
          : 'webhook HMAC key rotated — copy the one-time key now',
      ...(typeof record.callbackValidatedAt === 'string'
        ? { callbackValidatedAt: record.callbackValidatedAt }
        : {}),
    };
  } catch {
    return null;
  }
}

function oneTimeUnknownCode(action: 'created' | 'rotated'): WebhookUnknownOutcomeCode {
  return action === 'created'
    ? 'WEBHOOK_CREATE_HMAC_OUTCOME_UNKNOWN'
    : 'WEBHOOK_ROTATE_HMAC_OUTCOME_UNKNOWN';
}

function oneTimeUnknownMessage(action: 'created' | 'rotated'): string {
  return action === 'created'
    ? 'The webhook create outcome is unknown because the one-time HMAC key response was unavailable. Reconcile the webhook list before another create; retrying blindly may duplicate the webhook.'
    : 'The HMAC rotation outcome is unknown because the one-time key response was unavailable. Reconcile the receiver and key before another rotation; retrying blindly may rotate the key again.';
}

function parseOneTimeUnknownResult(
  body: unknown,
  expectedAction: 'created' | 'rotated',
  httpCode: number,
): ApiError | null {
  try {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
    const record = body as Record<string, unknown>;
    const code = oneTimeUnknownCode(expectedAction);
    if (
      record.ok !== false ||
      record.action !== 'unknown' ||
      record.outcome !== 'unknown' ||
      record.code !== code
    ) {
      return null;
    }
    return {
      error: oneTimeUnknownMessage(expectedAction),
      httpCode,
      outcome: 'unknown',
      code,
      ...(typeof record.operationId === 'string' ? { operationId: record.operationId } : {}),
    };
  } catch {
    return null;
  }
}

function parseOneTimeFailureResult(
  body: unknown,
  httpCode: number,
  secrets: readonly string[],
): ApiError | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  if (
    record.ok !== false ||
    record.action !== 'failed' ||
    typeof record.message !== 'string'
  ) {
    return null;
  }
  return {
    error: redactWebhookSecrets(record.message, secrets),
    httpCode,
    ...(typeof record.operationId === 'string' ? { operationId: record.operationId } : {}),
  };
}

async function webhookSecretMutate(
  path: string,
  body: unknown,
  expectedAction: 'created' | 'rotated',
  secrets: readonly string[] = [],
): Promise<ApiResult<WebhookOneTimeSecretResult>> {
  try {
    const r = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const responseBody = await responseJson(r);
    if (r.ok) {
      const success = parseOneTimeWebhookResult(responseBody, expectedAction);
      if (success) return success;
      const unknown = parseOneTimeUnknownResult(responseBody, expectedAction, r.status);
      if (unknown) return unknown;
      const failure = parseOneTimeFailureResult(responseBody, r.status, secrets);
      if (failure) return failure;
      return {
        error: oneTimeUnknownMessage(expectedAction),
        httpCode: r.status,
        outcome: 'unknown',
        code: oneTimeUnknownCode(expectedAction),
      };
    }
    const unknown = parseOneTimeUnknownResult(responseBody, expectedAction, r.status);
    if (unknown) return unknown;
    return {
      error: redactWebhookSecrets(
        messageFromBody(responseBody, `request failed — HTTP ${r.status}`),
        secrets,
      ),
      httpCode: r.status,
    };
  } catch (err) {
    return {
      error: redactWebhookSecrets(`cannot reach the portal backend: ${(err as Error).message}`, secrets),
      offline: true,
    };
  }
}

function responseJson(r: Response): Promise<unknown> {
  return r.json().catch(() => undefined);
}

function messageFromBody(body: unknown, fallback: string): string {
  if (!body || typeof body !== 'object') return fallback;
  const record = body as Record<string, unknown>;
  if (typeof record.error === 'string') return record.error;
  if (typeof record.message === 'string') return record.message;
  return fallback;
}

function webhookConflictResult(body: unknown, secrets: readonly string[]): WebhookMutationResult | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  if (
    record.ok !== false ||
    record.action !== 'conflict' ||
    record.httpCode !== 409 ||
    typeof record.message !== 'string'
  ) {
    return null;
  }
  return {
    ok: false,
    action: 'conflict',
    httpCode: 409,
    message: redactWebhookSecrets(record.message, secrets),
    ...(typeof record.callbackValidatedAt === 'string'
      ? { callbackValidatedAt: record.callbackValidatedAt }
      : {}),
  };
}

function redactWebhookSecrets(message: string, secrets: readonly string[]): string {
  return secrets.reduce(
    (safe, secret) => (secret ? safe.split(secret).join('[redacted]') : safe),
    message,
  );
}

function webhookPatchForm(form: WebhookForm, expectedGeneration: number): WebhookPatchForm | null {
  const common = {
    expectedGeneration,
    name: form.name,
    endpoint: form.endpoint,
  };
  if (form.authMechanism === 'OIDC') {
    return {
      ...common,
      authMechanism: 'OIDC',
      oidcClientId: form.oidcClientId,
      oidcClientSecret: form.oidcClientSecret,
      oidcWellKnownUrl: form.oidcWellKnownUrl,
    };
  }
  if (form.authMechanism === 'API_KEY') {
    return {
      ...common,
      authMechanism: 'API_KEY',
      apiKey: form.apiKey,
    };
  }
  return null;
}

/**
 * PATCH /api/central/webhooks/:id — the only edit path this app exposes,
 * review-confirmed. `expectedGeneration` (the generation the operator's
 * reviewed diff was built from) rides along on every request as an
 * optimistic-concurrency check; a stale generation is expected to come back
 * as an `ok:false` result with `httpCode: 409` (see
 * isWebhookGenerationConflict below) rather than silently applying over a
 * change the operator never saw.
 */
export async function updateCentralWebhook(
  id: string,
  form: WebhookForm,
  reviewConfirmed: boolean,
  expectedGeneration?: number,
): Promise<ApiResult<WebhookMutationResult>> {
  if (typeof expectedGeneration !== 'number' || !Number.isSafeInteger(expectedGeneration) || expectedGeneration < 0) {
    return { error: 'expectedGeneration must be a non-negative safe integer' };
  }
  const patchForm = webhookPatchForm(form, expectedGeneration);
  if (!patchForm) return { error: 'authMechanism must be exactly API_KEY or OIDC' };
  const secrets = [patchForm.apiKey, patchForm.oidcClientSecret].filter(
    (value): value is string => typeof value === 'string' && value.length > 0,
  );
  return webhookMutate(
    `/api/central/webhooks/${encodeURIComponent(id)}`,
    'PATCH',
    { form: patchForm, reviewConfirmed },
    secrets,
  );
}

/** POST /api/central/webhooks — reviewed create with a second
 * one-time-secret acknowledgement. The success result must be discarded as
 * soon as its dedicated modal closes. */
export async function createCentralWebhook(
  form: WebhookForm,
  reviewConfirmed: boolean,
  oneTimeSecretAcknowledged: boolean,
  reviewedTenantBinding: string | null,
): Promise<ApiResult<WebhookOneTimeSecretResult>> {
  if (reviewConfirmed !== true) {
    return { error: 'webhook creation requires an explicit review confirmation' };
  }
  if (oneTimeSecretAcknowledged !== true) {
    return { error: 'acknowledge that the returned HMAC key is one-time and must be copied now' };
  }
  if (!reviewedTenantBinding) {
    return { error: 'the reviewed Central tenant binding is missing; refresh the webhook list and review again' };
  }
  const createForm = webhookCreateForm(form);
  if (!createForm) return { error: 'authMechanism must be exactly API_KEY or OIDC' };
  const secrets = [createForm.apiKey, createForm.oidcClientSecret].filter(
    (value): value is string => typeof value === 'string' && value.length > 0,
  );
  return webhookSecretMutate(
    '/api/central/webhooks',
    { form: createForm, reviewConfirmed, oneTimeSecretAcknowledged, reviewedTenantBinding },
    'created',
    secrets,
  );
}

/** POST /api/central/webhooks/:id/rotate-hmac-key — reviewed
 * rotation with the same one-time-secret acknowledgement. */
export async function rotateCentralWebhookHmacKey(
  id: string,
  reviewConfirmed: boolean,
  oneTimeSecretAcknowledged: boolean,
  reviewedTenantBinding: string | null,
): Promise<ApiResult<WebhookOneTimeSecretResult>> {
  if (reviewConfirmed !== true) {
    return { error: 'HMAC rotation requires an explicit review confirmation' };
  }
  if (oneTimeSecretAcknowledged !== true) {
    return { error: 'acknowledge that the returned HMAC key is one-time and must be copied now' };
  }
  if (!reviewedTenantBinding) {
    return { error: 'the reviewed Central tenant binding is missing; refresh the webhook list and review again' };
  }
  return webhookSecretMutate(
    `/api/central/webhooks/${encodeURIComponent(id)}/rotate-hmac-key`,
    { reviewConfirmed, oneTimeSecretAcknowledged, reviewedTenantBinding },
    'rotated',
  );
}

/** DELETE /api/central/webhooks/:id — review-confirmed. */
export async function deleteCentralWebhook(id: string, reviewConfirmed: boolean): Promise<ApiResult<WebhookMutationResult>> {
  return webhookMutate(`/api/central/webhooks/${encodeURIComponent(id)}`, 'DELETE', { reviewConfirmed });
}

/**
 * True when a webhook mutation's failure means Central never confirmed the
 * outcome — a fetch-level exception (`offline`), or the server's own 502
 * "the outcome is unknown" answer for a transport failure it caught (see
 * CentralWebhooksError(502, ...) in server/src/services/centralWebhooks.ts)
 * — as opposed to a definite, known failure (400 validation, 409 not
 * linked/conflict, or an ok:false result). The caller must refetch/
 * reconcile the real state before trying again; retrying blindly risks
 * double-applying a mutation that may already have gone through.
 */
export function isUnknownWebhookOutcome(err: ApiError): boolean {
  return err.outcome === 'unknown' || err.offline === true || err.httpCode === 502;
}

/**
 * True when a PATCH's ok:false result reports a generation conflict — the
 * webhook changed since this operator's copy was loaded and reviewed.
 * Server-side enforcement of `expectedGeneration` is a follow-up outside
 * this client; this checks the httpCode:409 convention the client is ready
 * to interpret as soon as that lands, so the UI never silently overwrites a
 * change it never showed the operator.
 */
export function isWebhookGenerationConflict(result: WebhookMutationResult): boolean {
  return result.ok === false && result.httpCode === 409;
}

export async function getCompliance(): Promise<ComplianceData> {
  const result = await fetchScreen<ComplianceData>('/api/compliance');
  if (result.kind === 'ok') return result.data;
  if (result.kind === 'http-error') {
    return apiFailure<ComplianceData>(result.message, {
      stats: [],
      findings: [],
      baselines: [],
      diff: '',
      evidenceMode: 'unavailable',
    });
  }
  return {
    stats: COMPLIANCE_STATS,
    findings: FINDINGS,
    baselines: BASELINE_PROGRESS,
    diff: COMPLIANCE_DIFF,
    evidenceMode: 'baseline',
    dataSource: 'demo',
  };
}

export async function getSystems(): Promise<SystemsData> {
  const result = await fetchScreen<SystemsData>('/api/systems');
  if (result.kind === 'ok') return result.data;
  if (result.kind === 'http-error') {
    return apiFailure<SystemsData>(result.message, { systems: [], syncHistory: [], permissions: [] });
  }
  return { systems: SYSTEMS, syncHistory: SYNC_HISTORY, permissions: PERMISSIONS, dataSource: 'demo' };
}

// ---------------------------------------------------------------------------
// Systems live state + mutations — /api/systems/*
//
// getSystemsState() reads the server's plane registry (linked/health/lastSync/
// callsToday/recentCalls) plus the poller's sync history; it returns null when
// the backend is unreachable so the Systems screen can say "backend offline"
// and render fixture state instead. The mutation helpers never fall back —
// they surface the server's own message ({error} or {ok:false,message}).
// ---------------------------------------------------------------------------

/** One recorded outbound API call (server ring buffer entry). */
export interface LiveApiCall {
  time: string; // ISO
  path: string;
  ms: number;
  code: string;
}

/** Credential freshness for the fact strip — expiry + source, never a secret. */
export interface LivePlaneToken {
  expiresAt: string | null; // null = the plane publishes no expiry (static key)
  source: string; // 'oauth client_credentials', 'static token', 'sso' …
}

/** What the portal can do with a plane (server PlaneCapabilities). */
export interface LivePlaneCapabilities {
  localShell?: boolean;
  brokeredWrite?: boolean;
  configRead?: boolean;
  /** This plane accepts reviewed direct writes + automatic commit outside any
   *  ticketed queue (New Central's SSID apply, SSE's object CRUD) — false when
   *  the plane cannot, or when a linked SSE token's declared scope excludes
   *  write. The Systems Configuration tab's SSE object browser reads this
   *  directly to enable/disable its own mutation controls. */
  directWrite?: boolean;
}

/**
 * Per-plane registry state (server PlaneStateView) + its recent call log.
 *
 * Everything below `note` is optional because the registry fills it in as the
 * adapters learn it — but it IS on the wire (registry.snapshot() spreads the
 * whole PlaneState and stamps `stale`/`ageSec`), so the client must not strip
 * it: staleness is part of the UI, and a screen that cannot see `stale` has to
 * re-derive it from `lastSync` with its own idea of the window.
 */
export interface LivePlaneState {
  id: string;
  linked: boolean;
  health: 'healthy' | 'degraded' | 'warning' | 'unlinked';
  lastSync: string | null; // ISO of the last successful pull
  deviceCount: number | null;
  callsToday: number;
  note: string | null;
  recentCalls: LiveApiCall[];
  /** The last successful sync has aged past the registry's staleness window. */
  stale?: boolean;
  /** Seconds since that sync; null when the plane has never synced. */
  ageSec?: number | null;
  /** Daily outbound-call budget — the "Calls today" denominator. null = the
   *  vendor tier is unknown, so the fact renders bare rather than inventing one. */
  callBudget?: number | null;
  token?: LivePlaneToken | null;
  /** What the operator actually granted, parsed from the stored `scopes`. */
  scope?: PlaneScope;
  scopeNote?: string;
  capabilities?: LivePlaneCapabilities;
  /** Consecutive failed polls + the earliest time a scheduled poll retries. */
  consecutiveFailures?: number;
  nextAttemptAt?: string | null;
}

/** One poller sync-history entry (server SyncEvent). */
export interface LiveSyncEvent {
  time: string; // ISO
  plane: string;
  what: string;
  result: 'ok' | 'error';
}

export interface SystemsState {
  /** Always 'live' from the route — the registry has no fixture mode. */
  dataSource?: DataSource;
  /** Newest successful sync across every plane (ISO); null before the first. */
  syncedAt?: string | null;
  demoMode: boolean;
  planes: Record<string, LivePlaneState>;
  history: LiveSyncEvent[];
  apiError?: string;
}

/** Live per-plane state; null when the backend is absent (fixtures then). */
export async function getSystemsState(): Promise<SystemsState | null> {
  const result = await fetchScreen<SystemsState>('/api/systems/state');
  if (result.kind === 'ok') return result.data;
  if (result.kind === 'http-error') {
    return {
      dataSource: 'live',
      syncedAt: null,
      demoMode: false,
      planes: {},
      history: [],
      apiError: result.message,
    };
  }
  return null;
}

/** Uniform result for the mutation endpoints (test / credentials / retire). */
export interface SystemMutationResult {
  ok: boolean;
  message: string;
  ms?: number;
  source?: 'request' | 'stored';
}

/** Ask the poller to run one immediate cycle for every linked plane. */
export async function syncSystems(): Promise<SystemMutationResult> {
  try {
    const r = await fetch('/api/systems/sync', { method: 'POST' });
    if (r.ok) {
      const body = (await r.json().catch(() => ({}))) as {
        ok?: boolean;
        started?: string[];
        failed?: string[];
        skipped?: string[];
      };
      const started = body.started?.length ?? 0;
      const failed = body.failed?.length ?? 0;
      const skipped = body.skipped?.length ?? 0;
      return {
        ok: body.ok !== false,
        message:
          failed > 0
            ? `${failed} linked system${failed === 1 ? '' : 's'} failed to synchronize`
            : `${started} linked system${started === 1 ? '' : 's'} synchronized${skipped > 0 ? `; ${skipped} already syncing` : ''}`,
      };
    }
    return { ok: false, message: await serverMessage(r, `sync failed — HTTP ${r.status}`) };
  } catch (err) {
    return { ok: false, message: `cannot reach the portal backend: ${(err as Error).message}` };
  }
}

/** Read the server's message out of a non-OK response ({error} or {message}). */
async function serverMessage(r: Response, fallback: string): Promise<string> {
  try {
    const body = (await r.json()) as { error?: string; message?: string };
    return body.error ?? body.message ?? fallback;
  } catch {
    return fallback;
  }
}

/**
 * POST /api/systems/:plane/test. A failed test is a normal result, not an
 * exception: the server answers 502 with {ok:false,message} (or 4xx {error})
 * and we surface that message verbatim.
 */
export async function testSystem(
  plane: string,
  creds: SystemCredentialPayload,
): Promise<SystemMutationResult> {
  try {
    const r = await fetch(`/api/systems/${encodeURIComponent(plane)}/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(creds),
    });
    if (r.ok) {
      const body = (await r.json()) as {
        ok: boolean;
        message: string;
        ms?: number;
        source?: 'request' | 'stored';
      };
      return { ok: true, message: body.message, ms: body.ms, source: body.source };
    }
    return { ok: false, message: await serverMessage(r, `test failed — HTTP ${r.status}`) };
  } catch (err) {
    return { ok: false, message: `cannot reach the portal backend: ${(err as Error).message}` };
  }
}

/** POST /api/systems/:plane/credentials — store creds and re-init the adapter. */
export async function saveSystemCredentials(
  plane: string,
  creds: SystemCredentialPayload,
): Promise<SystemMutationResult> {
  try {
    const r = await fetch(`/api/systems/${encodeURIComponent(plane)}/credentials`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(creds),
    });
    if (r.ok) return { ok: true, message: 'credentials saved — the plane re-indexes on the next poll' };
    return { ok: false, message: await serverMessage(r, `save failed — HTTP ${r.status}`) };
  } catch (err) {
    return { ok: false, message: `cannot reach the portal backend: ${(err as Error).message}` };
  }
}

/** DELETE /api/systems/:plane — clear creds; the adapter becomes unlinked. */
export async function retireSystem(plane: string): Promise<SystemMutationResult> {
  try {
    const r = await fetch(`/api/systems/${encodeURIComponent(plane)}`, { method: 'DELETE' });
    if (r.ok) return { ok: true, message: 'plane retired — credentials cleared, adapter unlinked' };
    return { ok: false, message: await serverMessage(r, `retire failed — HTTP ${r.status}`) };
  } catch (err) {
    return { ok: false, message: `cannot reach the portal backend: ${(err as Error).message}` };
  }
}

// ---------------------------------------------------------------------------
// HPE Aruba Networking SSE — object inventory + reviewed CRUD, all under
// /api/sse/*. The inventory read is always served from the poller's cache
// (never a live call); mutations require an explicit reviewConfirmed:true
// (the review dialog's job) and are gated server-side on the token's declared
// write scope — a 403 here means "this token is read-only", not a bug.
// ---------------------------------------------------------------------------

/** GET /api/sse/inventory — null when the plane is not linked (409) or the
 *  backend cannot be reached; the caller renders the same "not linked" panel
 *  either way rather than a spinner that never resolves. */
export async function getSseInventory(): Promise<SseInventory | null> {
  try {
    const r = await fetch('/api/sse/inventory');
    if (!r.ok) return null;
    return (await r.json()) as SseInventory;
  } catch {
    return null;
  }
}

export interface SseKindListing {
  rows: SseObjectSummary[];
  total: number | null;
  truncated: boolean;
  unavailable: boolean;
  /** Secret-free vendor read outcome supplied by the cached inventory. */
  readStatus?: SseKindReadStatus;
  /** Present when the portal could not complete the list read. */
  readError?: string;
}

function failedSseReadStatus(status: number): SseKindReadStatus {
  if (status === 401 || status === 403) {
    return {
      state: 'failed',
      reason: 'denied',
      httpCode: status,
      message: `The SSE read was denied (HTTP ${status}); check the token's granted scope.`,
    };
  }
  if (status === 404) {
    return {
      state: 'failed',
      reason: 'unsupported',
      httpCode: 404,
      message: 'This SSE kind is unsupported or limited-release for this tenant (HTTP 404).',
    };
  }
  return {
    state: 'failed',
    reason: 'service-error',
    httpCode: status,
    message:
      status === 429
        ? 'The SSE service rate-limited the read (HTTP 429).'
        : `The SSE service returned an error for the read (HTTP ${status}).`,
  };
}

/** GET /api/sse/objects/:kind — one kind's cached rows, optionally filtered. */
export async function getSseKind(kind: SseObjectKind, q?: string): Promise<SseKindListing> {
  try {
    const qs = q?.trim() ? `?q=${encodeURIComponent(q.trim())}` : '';
    const r = await fetch(`/api/sse/objects/${encodeURIComponent(kind)}${qs}`);
    if (!r.ok) {
      return {
        rows: [],
        total: null,
        truncated: false,
        unavailable: true,
        readStatus: failedSseReadStatus(r.status),
        readError: await serverMessage(r, `read failed — HTTP ${r.status}`),
      };
    }
    const body = (await r.json()) as Partial<SseKindListing>;
    if (!Array.isArray(body.rows) || typeof body.unavailable !== 'boolean') {
      return {
        rows: [],
        total: null,
        truncated: false,
        unavailable: true,
        readStatus: {
          state: 'failed',
          reason: 'invalid-response',
          httpCode: r.status,
          message: 'The portal returned a successful but unrecognized SSE list response.',
        },
        readError: 'successful SSE list response was not recognized',
      };
    }
    return body as SseKindListing;
  } catch (err) {
    return {
      rows: [],
      total: null,
      truncated: false,
      unavailable: true,
      readStatus: {
        state: 'failed',
        reason: 'unreachable',
        httpCode: null,
        message: 'The portal backend could not be reached for this SSE read.',
      },
      readError: `cannot reach the portal backend: ${(err as Error).message}`,
    };
  }
}

/** GET /api/sse/objects/:kind/:id — on-demand fresh detail read (edit drawer). */
export async function getSseObject(kind: SseObjectKind, id: string): Promise<{ ok: boolean; object?: Record<string, unknown>; message?: string }> {
  try {
    const r = await fetch(`/api/sse/objects/${encodeURIComponent(kind)}/${encodeURIComponent(id)}`);
    if (r.ok) return { ok: true, object: (await r.json()) as Record<string, unknown> };
    return { ok: false, message: await serverMessage(r, `read failed — HTTP ${r.status}`) };
  } catch (err) {
    return { ok: false, message: `cannot reach the portal backend: ${(err as Error).message}` };
  }
}

/** Uniform result for the SSE mutation endpoints (create/update/delete). */
export interface SseMutationCallResult {
  ok: boolean;
  message: string;
  result?: SseMutationResult;
  code?: string;
  /** A previous mutation is staged and must be committed before another write. */
  pendingCommit?: boolean;
}

export interface SseCommitRetryCallResult {
  ok: boolean;
  message: string;
  result?: SseCommitRetryResult;
  code?: string;
}

export interface SseManualCleanupCallResult {
  ok: boolean;
  message: string;
  result?: SseManualCleanupResult;
  code?: string;
}

interface SseErrorResponse {
  message: string;
  code?: string;
  result?: SseManualCleanupResult;
}

async function sseErrorResponse(r: Response, fallback: string): Promise<SseErrorResponse> {
  try {
    const body = (await r.json()) as {
      error?: unknown;
      message?: unknown;
      code?: unknown;
      result?: unknown;
    };
    return {
      message:
        typeof body.error === 'string'
          ? body.error
          : typeof body.message === 'string'
            ? body.message
            : fallback,
      ...(typeof body.code === 'string' ? { code: body.code } : {}),
      ...(body.result && typeof body.result === 'object'
        ? { result: body.result as SseManualCleanupResult }
        : {}),
    };
  } catch {
    return { message: fallback };
  }
}

async function sseMutate(url: string, method: 'POST' | 'PUT' | 'DELETE', body: unknown): Promise<SseMutationCallResult> {
  try {
    const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (r.ok) {
      const result = (await r.json()) as SseMutationResult;
      const message = !result.mutation.ok
        ? result.mutation.message
        : result.staged
          ? `applied, but the commit failed — the change is staged: ${result.commit.message}`
          : 'applied and committed';
      return { ok: result.mutation.ok, message, result };
    }
    const { message, code } = await sseErrorResponse(r, `request failed — HTTP ${r.status}`);
    const pendingCommit = code === 'SSE_PENDING_MUTATION';
    return {
      ok: false,
      message,
      ...(code ? { code } : {}),
      ...(pendingCommit ? { pendingCommit: true } : {}),
    };
  } catch (err) {
    return { ok: false, message: `cannot reach the portal backend: ${(err as Error).message}` };
  }
}

/** POST /api/sse/objects/:kind — create, review-confirmed. */
export async function createSseObject(kind: SseObjectKind, fields: Record<string, unknown>): Promise<SseMutationCallResult> {
  return sseMutate(`/api/sse/objects/${encodeURIComponent(kind)}`, 'POST', { fields, reviewConfirmed: true });
}

/** PUT /api/sse/objects/:kind/:id — update, review-confirmed. */
export async function updateSseObject(kind: SseObjectKind, id: string, fields: Record<string, unknown>): Promise<SseMutationCallResult> {
  return sseMutate(`/api/sse/objects/${encodeURIComponent(kind)}/${encodeURIComponent(id)}`, 'PUT', { fields, reviewConfirmed: true });
}

/** DELETE /api/sse/objects/:kind/:id — delete, review-confirmed. */
export async function deleteSseObject(kind: SseObjectKind, id: string): Promise<SseMutationCallResult> {
  return sseMutate(`/api/sse/objects/${encodeURIComponent(kind)}/${encodeURIComponent(id)}`, 'DELETE', { reviewConfirmed: true });
}

/** POST /api/sse/commit/retry — commit-only retry for a staged change; never
 *  replays the mutation that already landed. The caller must supply the
 *  explicit review action rather than this client silently confirming it. */
export async function retrySseCommit(reviewConfirmed: boolean): Promise<SseCommitRetryCallResult> {
  if (reviewConfirmed !== true) {
    return { ok: false, message: 'review the tenant-wide commit before retrying' };
  }
  try {
    const r = await fetch('/api/sse/commit/retry', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reviewConfirmed: true }),
    });
    if (r.ok) {
      const result = (await r.json()) as SseCommitRetryResult;
      const recoveryAction = result.recovery?.action;
      const ok =
        recoveryAction === 'cleanup-only' || recoveryAction === 'refresh-and-cleanup'
          ? true
          : recoveryAction === 'manual-reconciliation'
            ? false
            : result.commit.ok;
      return {
        ok,
        message:
          recoveryAction === 'cleanup-only' || recoveryAction === 'refresh-and-cleanup'
            ? result.recovery?.message || result.commit.message
            : result.commit.message,
        result,
      };
    }
    const { message, code } = await sseErrorResponse(r, `retry failed — HTTP ${r.status}`);
    return { ok: false, message, ...(code ? { code } : {}) };
  } catch (err) {
    return { ok: false, message: `cannot reach the portal backend: ${(err as Error).message}` };
  }
}

/** POST /api/sse/recovery/manual-cleanup — removes only an ambiguous journal
 * after separate reviewed-action and manual-reconciliation acknowledgments.
 * The server never calls a mutation or tenant-wide Commit on this path. */
export async function cleanupSseManualReconciliation(
  reviewConfirmed: boolean,
  manualReconciled: boolean,
): Promise<SseManualCleanupCallResult> {
  if (reviewConfirmed !== true) {
    return { ok: false, message: 'review the cleanup-only recovery before continuing' };
  }
  if (manualReconciled !== true) {
    return {
      ok: false,
      message: 'attest that the ambiguous outcome was manually reconciled in the SSE admin console',
    };
  }
  try {
    const r = await fetch('/api/sse/recovery/manual-cleanup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reviewConfirmed: true, manualReconciled: true }),
    });
    if (r.ok) {
      const result = (await r.json()) as SseManualCleanupResult;
      const removed =
        result.recovery?.action === 'manual-cleanup' &&
        result.recovery.status === 'journal-removed';
      return {
        ok: removed,
        message: result.recovery?.message || result.commit.message,
        result,
      };
    }
    const { message, code, result } = await sseErrorResponse(
      r,
      `manual cleanup failed — HTTP ${r.status}`,
    );
    return {
      ok: false,
      message,
      ...(code ? { code } : {}),
      ...(result ? { result } : {}),
    };
  } catch (err) {
    return { ok: false, message: `cannot reach the portal backend: ${(err as Error).message}` };
  }
}

export async function getSearchIndex(): Promise<SearchIndexData> {
  const result = await fetchScreen<SearchIndexData>('/api/search-index');
  if (result.kind === 'ok') return result.data;
  if (result.kind === 'http-error') return apiFailure<SearchIndexData>(result.message, { entries: [] });
  return { entries: SEARCH_INDEX, dataSource: 'demo' };
}

// ---------------------------------------------------------------------------
// Chat (assistant) — /api/chat/* and the mcp/llm slice of /api/settings
//
// The chatbot is the app's only MCP consumer: the server proxies an
// OpenAI-compatible LLM tool loop onto the user's centralmcp server. There is
// no fixture fallback — unconfigured or unreachable backends are surfaced
// honestly (null status, or the server's {error} message verbatim).
// ---------------------------------------------------------------------------

export interface ChatStatus {
  configured: { mcp: boolean; llm: boolean };
  writeMode: boolean;
  mcpUrl?: string;
  mcpReachable: boolean;
}

/** Live chat status; null when the backend is absent. */
export async function getChatStatus(): Promise<ChatStatus | null> {
  return fromApi<ChatStatus>('/api/chat/status');
}

export interface ChatTranscriptEntry {
  tool: string;
  args: string;
  resultPreview: string;
  ok: boolean;
}

export interface ChatRequestMessage {
  role: 'user' | 'assistant';
  content: string;
}

export type ChatResult =
  | { ok: true; reply: string; transcript: ChatTranscriptEntry[] }
  | { ok: false; error: string };

/** POST /api/chat — surfaces the server's message verbatim on failure. */
export async function postChat(
  messages: ChatRequestMessage[],
  allowWrite: boolean,
): Promise<ChatResult> {
  // The server-side LLM tool loop can legitimately take minutes, but never
  // forever — cancel at 120s so the composer can't pend indefinitely.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120_000);
  try {
    const r = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages, allowWrite }),
      signal: controller.signal,
    });
    if (r.ok) {
      const body = (await r.json()) as { reply: string; transcript: ChatTranscriptEntry[] };
      return { ok: true, reply: body.reply, transcript: body.transcript ?? [] };
    }
    return { ok: false, error: await serverMessage(r, `chat failed — HTTP ${r.status}`) };
  } catch (err) {
    if (controller.signal.aborted) {
      return { ok: false, error: 'no answer within two minutes — the request was cancelled' };
    }
    return { ok: false, error: `cannot reach the portal backend: ${(err as Error).message}` };
  } finally {
    clearTimeout(timer);
  }
}

/** The assistant slice of the server settings (masked secrets, never raw). */
export interface ChatSettings {
  mcp: { url: string; bearerToken: string | null } | null;
  llm: { baseUrl: string; apiKey: string; model: string } | null;
  chatWriteMode: boolean;
}

/** GET /api/settings, narrowed to the chat keys; null when backend absent. */
export async function getChatSettings(): Promise<ChatSettings | null> {
  return fromApi<ChatSettings>('/api/settings');
}

/**
 * PUT /api/settings with a chat partial. The store deep-merges mcp/llm, and
 * masked '••••••…' secrets written back unchanged are ignored, so a round
 * trip of the masked view keeps the stored secrets.
 */
export async function saveChatSettings(patch: Partial<ChatSettings>): Promise<SystemMutationResult> {
  try {
    const r = await fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    if (r.ok) return { ok: true, message: 'assistant settings saved' };
    return { ok: false, message: await serverMessage(r, `save failed — HTTP ${r.status}`) };
  } catch (err) {
    return { ok: false, message: `cannot reach the portal backend: ${(err as Error).message}` };
  }
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Tickets — raising from the alert queue
// ---------------------------------------------------------------------------

/** POST /api/tickets/raise — creates (or finds) the ticket for an alert. */
export async function raiseTicket(alert: AlertRow): Promise<{ ticket: TicketRow } | { error: string; offline?: boolean }> {
  try {
    const r = await fetch('/api/tickets/raise', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(alert),
    });
    const body = (await r.json().catch(() => ({}))) as { ticket?: TicketRow; error?: string };
    if (r.ok && body.ticket) return { ticket: body.ticket };
    return { error: body.error ?? `HTTP ${r.status}` };
  } catch {
    return { error: 'backend unreachable', offline: true };
  }
}

/** POST /api/tickets/:id/notes — persist an operator note or requested action. */
export async function addTicketNote(
  id: string,
  text: string,
  kind: 'note' | 'action' = 'note',
): Promise<{ ticket: TicketRow } | { error: string; offline?: boolean }> {
  try {
    const r = await fetch(`/api/tickets/${encodeURIComponent(id)}/notes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, kind }),
    });
    const body = (await r.json().catch(() => ({}))) as { ticket?: TicketRow; error?: string };
    if (r.ok && body.ticket) return { ticket: body.ticket };
    return { error: body.error ?? `HTTP ${r.status}` };
  } catch {
    return { error: 'backend unreachable', offline: true };
  }
}

/** POST /api/tickets/:id/resolve — close the ticket (idempotent on the server). */
export async function resolveTicket(id: string): Promise<{ ticket: TicketRow } | { error: string; offline?: boolean }> {
  try {
    const r = await fetch(`/api/tickets/${encodeURIComponent(id)}/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    const body = (await r.json().catch(() => ({}))) as { ticket?: TicketRow; error?: string };
    if (r.ok && body.ticket) return { ticket: body.ticket };
    return { error: body.error ?? `HTTP ${r.status}` };
  } catch {
    return { error: 'backend unreachable', offline: true };
  }
}

// ---------------------------------------------------------------------------
// Device actions — ticket-gated reboot
// ---------------------------------------------------------------------------

export interface RebootResult {
  ok: boolean;
  applied: boolean; // true ONLY on a 202 from the troubleshooting API
  device: string;
  plane: string;
  serial: string | null;
  ticket: string;
  httpCode?: number;
  message: string;
}

/** POST /api/devices/:name/reboot with exact identity when the resolved row has it. */
export async function rebootDevice(
  name: string,
  ticket: string,
  identity: DeviceDetailIdentity = {},
): Promise<RebootResult | { ok: false; applied: false; message: string }> {
  try {
    const r = await fetch(`/api/devices/${encodeURIComponent(name)}/reboot`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ticket,
        ...(identity.plane && identity.serial
          ? { plane: identity.plane, serial: identity.serial }
          : {}),
      }),
    });
    if (r.ok) return (await r.json()) as RebootResult;
    return { ok: false, applied: false, message: await serverMessage(r, `reboot failed — HTTP ${r.status}`) };
  } catch (err) {
    return { ok: false, applied: false, message: `cannot reach the portal backend: ${(err as Error).message}` };
  }
}

// ---------------------------------------------------------------------------
// Reviewed active diagnostics — New Central traceroute only
// ---------------------------------------------------------------------------

export async function getDiagnosticEligibility(): Promise<DiagnosticEligibilityResponse> {
  const r = await fetch('/api/diagnostics/eligible');
  if (!r.ok) throw new Error(await serverMessage(r, `diagnostic eligibility failed — HTTP ${r.status}`));
  return (await r.json()) as DiagnosticEligibilityResponse;
}

export async function reviewDiagnostic(request: DiagnosticReviewRequest): Promise<DiagnosticReview> {
  const r = await fetch('/api/diagnostics/review', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });
  if (!r.ok) throw new Error(await serverMessage(r, `diagnostic review failed — HTTP ${r.status}`));
  return (await r.json()) as DiagnosticReview;
}

/**
 * Confirming a review requires the exact plane+serial identity the review
 * was issued for (the server rejects a mismatch with 409) — never just the
 * reviewId, so a stale confirmation can't be replayed against a device the
 * operator has since navigated away from.
 */
export async function startDiagnostic(
  reviewId: string,
  plane: Plane,
  serial: string,
): Promise<DiagnosticJob> {
  const body: DiagnosticStartRequest = { reviewId, confirmed: true, plane, serial };
  const r = await fetch('/api/diagnostics/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(await serverMessage(r, `diagnostic start failed — HTTP ${r.status}`));
  return (await r.json()) as DiagnosticJob;
}

/**
 * Diagnostic job-status fetch failure that preserves the HTTP status, so
 * pollers can tell an honest terminal answer (401/403 auth, 404 job gone)
 * from a transient failure (network error, 5xx) worth retrying.
 */
export class DiagnosticJobStatusError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'DiagnosticJobStatusError';
    this.status = status;
  }
}

export async function getDiagnosticJob(id: string): Promise<DiagnosticJob> {
  const r = await fetch(`/api/diagnostics/jobs/${encodeURIComponent(id)}`);
  if (!r.ok) {
    throw new DiagnosticJobStatusError(
      r.status,
      await serverMessage(r, `diagnostic status failed — HTTP ${r.status}`),
    );
  }
  return (await r.json()) as DiagnosticJob;
}

export async function cancelDiagnostic(id: string): Promise<DiagnosticJob> {
  const r = await fetch(`/api/diagnostics/jobs/${encodeURIComponent(id)}/cancel`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  if (!r.ok) throw new Error(await serverMessage(r, `diagnostic cancel failed — HTTP ${r.status}`));
  return (await r.json()) as DiagnosticJob;
}

export async function getDiagnosticHistory(): Promise<DiagnosticAuditEntry[]> {
  const r = await fetch('/api/diagnostics/history');
  if (!r.ok) throw new Error(await serverMessage(r, `diagnostic history failed — HTTP ${r.status}`));
  const body = (await r.json()) as { entries?: DiagnosticAuditEntry[] };
  return body.entries ?? [];
}

// ---------------------------------------------------------------------------
// Client actions — ticket-gated disconnect (CoA-style reauthentication)
// ---------------------------------------------------------------------------

export interface DisconnectResult {
  ok: boolean;
  applied: boolean; // true ONLY on a 202 from the troubleshooting API
  mac: string;
  ticket: string;
  httpCode?: number;
  message: string;
}

/** POST /api/clients/:mac/disconnect — surfaces the server's message verbatim on failure. */
export async function disconnectClient(
  mac: string,
  ticket: string,
): Promise<DisconnectResult | { ok: false; applied: false; message: string }> {
  try {
    const r = await fetch(`/api/clients/${encodeURIComponent(mac)}/disconnect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticket }),
    });
    if (r.ok) return (await r.json()) as DisconnectResult;
    return { ok: false, applied: false, message: await serverMessage(r, `disconnect failed — HTTP ${r.status}`) };
  } catch (err) {
    return { ok: false, applied: false, message: `cannot reach the portal backend: ${(err as Error).message}` };
  }
}

/**
 * POST /api/clients/:mac/block — ticket-gated endpoint block via a ClearPass
 * CoA Disconnect-Request (the wired-client path the Central troubleshooting
 * API cannot reach).
 */
export async function blockClient(
  mac: string,
  ticket: string,
): Promise<DisconnectResult | { ok: false; applied: false; message: string }> {
  try {
    const r = await fetch(`/api/clients/${encodeURIComponent(mac)}/block`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticket }),
    });
    if (r.ok) return (await r.json()) as DisconnectResult;
    return { ok: false, applied: false, message: await serverMessage(r, `block failed — HTTP ${r.status}`) };
  } catch (err) {
    return { ok: false, applied: false, message: `cannot reach the portal backend: ${(err as Error).message}` };
  }
}

// ---------------------------------------------------------------------------
// Alert actions — ticket-gated acknowledge through Central's notifications API
// ---------------------------------------------------------------------------

export interface AckAlertResult {
  ok: boolean;
  applied: boolean; // true ONLY on a 202 from the notifications API
  alert: string;
  ticket: string;
  httpCode?: number;
  message: string;
}

/** POST /api/alerts/ack — surfaces the server's message verbatim on failure. */
export async function ackAlert(
  alert: { plane: string; alertId?: string; title?: string; device?: string },
  ticket: string,
): Promise<AckAlertResult | { ok: false; applied: false; message: string }> {
  try {
    const r = await fetch('/api/alerts/ack', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticket, alert }),
    });
    if (r.ok) return (await r.json()) as AckAlertResult;
    return { ok: false, applied: false, message: await serverMessage(r, `acknowledge failed — HTTP ${r.status}`) };
  } catch (err) {
    return { ok: false, applied: false, message: `cannot reach the portal backend: ${(err as Error).message}` };
  }
}

// ---------------------------------------------------------------------------
// Terminal sessions — recorded shells (data/shell-logs)
// ---------------------------------------------------------------------------

export interface TerminalSession {
  file: string;
  device: string;
  user: string;
  target: string;
  openedAt: string;
  /** Plane+serial this recording was opened against, when the session
   *  carried a complete identity pair — absent for a legacy recording or one
   *  opened without one. Mirrors server SessionInfo (services/terminal.ts). */
  plane?: string;
  serial?: string;
}

/**
 * Recorded sessions for one device, scoped to the exact plane+serial pair
 * when supplied (see server services/terminal.ts listSessionsForDevice) —
 * [] when none or backend absent. When the display name still names more
 * than one physical device without an exact identity, the server answers
 * `ambiguous: true` rather than guessing a match; that is surfaced as a
 * thrown error so the caller's existing failure path renders a reason
 * instead of a misleadingly empty "no sessions on file".
 */
export async function getTerminalSessions(
  device: string,
  identity: DeviceDetailIdentity = {},
): Promise<TerminalSession[]> {
  const params = new URLSearchParams({ device });
  if (identity.plane) params.set('plane', identity.plane);
  if (identity.serial) params.set('serial', identity.serial);
  const r = await fromStrictOptionalApi<{ sessions: TerminalSession[]; ambiguous?: boolean }>(
    `/api/terminal/sessions?${params.toString()}`,
  );
  if (!r) return [];
  if (r.ambiguous) {
    throw new Error(
      `'${device}' names more than one device — recorded sessions need an exact plane and serial to show safely`,
    );
  }
  return r.sessions;
}

export interface TerminalSessionEvent {
  type: 'open' | 'in' | 'out' | 'blocked' | 'close';
  at: string;
  text?: string;
  reason?: string;
}

export interface TerminalTranscript {
  file: string;
  events: TerminalSessionEvent[];
  truncated: boolean;
}

/** One recorded transcript, gated by the same device+identity the listing
 *  used to name it — a bare file name is never enough on its own (it would
 *  let a caller that merely knows another device's file name read a
 *  transcript that does not belong to it). Null when unknown, ambiguous, or
 *  the backend is absent. */
export async function getTerminalSession(
  file: string,
  device: string,
  identity: DeviceDetailIdentity = {},
): Promise<TerminalTranscript | null> {
  const params = new URLSearchParams({ device });
  if (identity.plane) params.set('plane', identity.plane);
  if (identity.serial) params.set('serial', identity.serial);
  return fromStrictOptionalApi<TerminalTranscript>(
    `/api/terminal/sessions/${encodeURIComponent(file)}?${params.toString()}`,
    true,
  );
}

// Settings — /api/settings with a localStorage fallback
// ---------------------------------------------------------------------------

export interface Settings {
  density: 'comfortable' | 'compact';
  inventoryView: 'Unified table' | 'Platform lanes';
  showPlatformTags: boolean;
  workspaceName: string;
  pollIntervalSec: number;
}

export const DEFAULT_SETTINGS: Settings = {
  density: 'comfortable',
  inventoryView: 'Unified table',
  showPlatformTags: true,
  workspaceName: 'Meridian Health',
  pollIntervalSec: 60,
};

export const SETTINGS_STORAGE_KEY = 'nt-settings';

/**
 * Project the shell keys out of a settings payload. GET /api/settings answers
 * with the WHOLE masked store (demoMode, blendLive, sectionMode,
 * hiddenDemoDevices, planes, mcp, llm …), so spreading it wholesale would make
 * the shell carry — and then PUT back — settings it does not own: a density
 * change would echo a mount-time demoMode over whatever Connected systems set
 * in the meantime, and echo `planes` back at the plane registry.
 */
function shellSettingsOnly(raw: Partial<Settings> | null | undefined): Settings {
  const source = raw ?? {};
  return {
    density: source.density ?? DEFAULT_SETTINGS.density,
    inventoryView: source.inventoryView ?? DEFAULT_SETTINGS.inventoryView,
    showPlatformTags: source.showPlatformTags ?? DEFAULT_SETTINGS.showPlatformTags,
    workspaceName: source.workspaceName ?? DEFAULT_SETTINGS.workspaceName,
    pollIntervalSec: source.pollIntervalSec ?? DEFAULT_SETTINGS.pollIntervalSec,
  };
}

export async function getSettings(): Promise<Settings> {
  const result = await fetchScreen<Partial<Settings>>('/api/settings');
  if (result.kind === 'ok') return shellSettingsOnly(result.data);
  if (result.kind === 'http-error') throw new Error(result.message);
  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (raw) return shellSettingsOnly(JSON.parse(raw) as Partial<Settings>);
  } catch {
    /* corrupted local copy — fall through to defaults */
  }
  return DEFAULT_SETTINGS;
}

export async function saveSettings(settings: Settings): Promise<SystemMutationResult> {
  // Narrow patch, never the caller's state object: the PUT must change the
  // five shell preferences and nothing else in the store.
  const patch = shellSettingsOnly(settings);
  try {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(patch));
  } catch {
    /* storage unavailable — the server copy may still succeed */
  }
  try {
    const r = await fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    if (r.ok) return { ok: true, message: 'settings saved' };
    return { ok: false, message: await serverMessage(r, `save failed — HTTP ${r.status}`) };
  } catch (err) {
    return {
      ok: false,
      message: `settings saved locally; portal backend unavailable: ${(err as Error).message}`,
    };
  }
}

/** The portal-behaviour slice of the server settings (demo mode + poll cadence). */
export interface PortalSettings {
  demoMode: boolean;
  /** Demo mode only: swap a screen section to live rows once a plane reports them. */
  blendLive?: boolean;
  /** Per-screen demo/live overrides; a section absent here follows demoMode. */
  sectionMode?: SectionMode;
  /** Fixture device names hidden from the demo inventory. */
  hiddenDemoDevices?: string[];
  /** Lab config mode: writes go through without a ticket reference. */
  configMode?: boolean;
  pollIntervalSec: number;
}

/** GET /api/settings, narrowed to the portal keys; null when backend absent. */
export async function getPortalSettings(): Promise<PortalSettings | null> {
  return fromApi<PortalSettings>('/api/settings');
}

/**
 * PUT /api/settings with a portal partial. A pollIntervalSec change is picked
 * up by the server without a restart (it restarts the poller); demoMode is
 * re-read on every poll tick and on every screen fetch.
 */
export async function savePortalSettings(
  patch: Partial<PortalSettings>,
): Promise<SystemMutationResult> {
  try {
    const r = await fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    if (r.ok) return { ok: true, message: 'portal settings saved' };
    return { ok: false, message: await serverMessage(r, `save failed — HTTP ${r.status}`) };
  } catch (err) {
    return { ok: false, message: `cannot reach the portal backend: ${(err as Error).message}` };
  }
}
