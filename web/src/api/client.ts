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
  CapabilityRow,
  ChangeLogEntry,
  ClientRow,
  ConfigForm,
  ConfigKind,
  DeviceCfg,
  DeviceCheckRow,
  DeviceClientSet,
  DeviceEvidence,
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
  SsidObject,
  StatDef,
  SubscriptionRow,
  SyncHistoryRow,
  SystemRow,
  TerminalLine,
  TicketRow,
  VlanObject,
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
}

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

export async function getClients(): Promise<ClientsData> {
  const result = await fetchScreen<ClientsData>('/api/clients');
  if (result.kind === 'ok') return result.data;
  if (result.kind === 'http-error') {
    return apiFailure<ClientsData>(result.message, { stats: [], clients: [] });
  }
  return { stats: CLIENT_STATS, clients: CLIENTS, dataSource: 'demo' };
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
  if (r.kind === 'ok') return r.data;
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

export async function getDeviceDetail(name: string): Promise<DeviceDetailData> {
  const r = await fetchDetail<DeviceDetailData & { checks?: DeviceCheckRow[] }>(
    `/api/devices/${encodeURIComponent(name)}`,
  );
  if (r.kind === 'ok') return normalizeEvidence(r.data);
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
  const device = DEVICES.find((row) => row.name === name) ?? null;
  if (!device) {
    return { device: null, profile: null, config: null, clients: null, dataSource: 'demo' };
  }
  const profile = deviceProfile(name);
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

/** Uniform failure half of ApiResult; `offline` = backend unreachable. */
export interface ApiError {
  error: string;
  offline?: boolean;
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
  if (result.kind === 'ok') return result.data.changes;
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
  creds: Record<string, string>,
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
  creds: Record<string, string>,
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
  ticket: string;
  httpCode?: number;
  message: string;
}

/** POST /api/devices/:name/reboot — surfaces the server's message verbatim on failure. */
export async function rebootDevice(
  name: string,
  ticket: string,
): Promise<RebootResult | { ok: false; applied: false; message: string }> {
  try {
    const r = await fetch(`/api/devices/${encodeURIComponent(name)}/reboot`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticket }),
    });
    if (r.ok) return (await r.json()) as RebootResult;
    return { ok: false, applied: false, message: await serverMessage(r, `reboot failed — HTTP ${r.status}`) };
  } catch (err) {
    return { ok: false, applied: false, message: `cannot reach the portal backend: ${(err as Error).message}` };
  }
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
}

/** Recorded sessions for one device; [] when none or backend absent. */
export async function getTerminalSessions(device: string): Promise<TerminalSession[]> {
  const r = await fromStrictOptionalApi<{ sessions: TerminalSession[] }>(
    `/api/terminal/sessions?device=${encodeURIComponent(device)}`,
  );
  return r?.sessions ?? [];
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

/** One recorded transcript; null when unknown or backend absent. */
export async function getTerminalSession(file: string): Promise<TerminalTranscript | null> {
  return fromStrictOptionalApi<TerminalTranscript>(
    `/api/terminal/sessions/${encodeURIComponent(file)}`,
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
