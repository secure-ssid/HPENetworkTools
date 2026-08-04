/** Per-screen read endpoints: the view models each screen renders. */

import {
  DEMO_SYNCED_AT,
  ScreenEnvelope,
  apiFailure,
  dropUnreadableBlocks,
  fetchDetail,
  fetchScreen,
  readDetail,
  unwrapDetailPayload,
} from './core';
import {
  ALERTS,
  AP_TRENDS_DEMO,
  AUTH_EVENTS,
  AUTH_FAIL_REASONS,
  AUTH_STATS,
  BASELINE_PROGRESS,
  CAPABILITY_MATRIX,
  CLEARPASS_AUTH_SOURCES,
  CLEARPASS_ENDPOINTS,
  CLEARPASS_ENFORCEMENT_POLICIES,
  CLEARPASS_ENFORCEMENT_PROFILES,
  CLEARPASS_LOCAL_USERS,
  CLEARPASS_NETWORK_DEVICES,
  CLEARPASS_ROLES,
  CLEARPASS_SERVICES,
  CLEARPASS_SERVICE_DETAILS,
  CLIENTS,
  CLIENT_STATS,
  COMPLIANCE_DIFF,
  COMPLIANCE_STATS,
  CONFIGURE_STATS,
  CONFIG_PORTS,
  DEVICES,
  DEVICE_CLIENT_SETS,
  DEVICE_CONFIGS,
  DEVICE_RECONCILIATION,
  FINDINGS,
  LANE_META,
  LICENSE_STATS,
  MIST_AP_STATS,
  MIST_LICENSE_USAGES,
  MIST_PLANE_STATUS,
  MIST_ROGUE_APS,
  MIST_SITE_MAPS,
  MIST_SLE_DRILLDOWN,
  ORPHANS,
  OVERVIEW_ALERTS,
  OVERVIEW_CHANGES,
  OVERVIEW_LAUNCHPAD,
  OVERVIEW_PLANES,
  OVERVIEW_SITES,
  OVERVIEW_STATS,
  POLICY_SERVICES,
  QUEUED_CHANGES,
  RENEWALS,
  SEARCH_INDEX,
  SITES,
  SITE_APPLICATIONS_DEMO,
  SITE_IDS,
  SITE_PROFILES,
  SITE_SLE,
  SITE_STATS,
  SSIDS,
  SUBSCRIPTIONS,
  SWITCH_HARDWARE_TRENDS_DEMO,
  SWITCH_INTERFACE_TRENDS_DEMO,
  TICKETS,
  UXI_SENSORS,
  VLANS,
  buildDemoTopologyGraph,
  clientPlaneSections,
  demoCentralSections,
  demoClient360World,
  demoTopologyNotes,
  deriveSiteProfile,
  deviceProfile,
  isRealSiteId,
  siteIdFor,
  terminalBanner,
  terminalQuickCommands,
  type AlertCorrelation,
  type AlertGroup,
  type AlertRow,
  type ApTrendMetric,
  type ApTrendsLive,
  type AuthEventRow,
  type BaselineProgressRow,
  type CapabilityRow,
  type CentralDataset,
  type CentralFleetSummary,
  type CentralFirmwareRow,
  type CentralPlaneStatus,
  type CentralSiteRow,
  type ChangeLogEntry,
  type ClientDetailLive,
  type ClientPlaneSection,
  type ClientRow,
  type ClearPassAuthSourceRow,
  type ClearPassDeviceGroupRow,
  type ClearPassEnforcementPolicyRow,
  type ClearPassEnforcementProfileRow,
  type ClearPassLocalUserRow,
  type ClearPassNetworkDeviceRow,
  type ClearPassRoleRow,
  type ClearPassServiceDetailLive,
  type ClearPassServiceRow,
  type ConfigBackupDiff,
  type ConfigBackupListEnvelope,
  type ConfigBackupVersionList,
  type DeviceCfg,
  type DeviceCheckRow,
  type DeviceClientSet,
  type DeviceDetailLive,
  type DeviceEvidence,
  type DeviceProfile,
  type DeviceRow,
  type EndpointRow,
  type FailReasonRow,
  type FindingRow,
  type LaneMeta,
  type LaunchpadRow,
  type MistApStatsRow,
  type MistLicenseUsageRow,
  type MistPlaneStatus,
  type MistRogueApRow,
  type MistSiteMap,
  type MistSleMetricDetail,
  type MistSleRow,
  type OrphanRow,
  type OverviewAlert,
  type OverviewPlaneRow,
  type OverviewSiteRow,
  type Plane,
  type PolicyServiceRow,
  type PortObject,
  type QueuedChangeRow,
  type RenewalRow,
  type SearchIndexEntry,
  type SiteAlertRow,
  type SiteApplicationsLive,
  type SiteDeviceRow,
  type SiteId,
  type SiteProfile,
  type SiteReachability,
  type SiteRow,
  type SiteTopologyLive,
  type SilencedAlertGroup,
  type SsidObject,
  type StatDef,
  type SubscriptionRow,
  type SwitchHardwareTrendsLive,
  type SwitchInterfaceTrendsLive,
  type TerminalLine,
  type TicketRow,
  type TopologyPayload,
  type UxiSensorRow,
  type VlanObject,
} from '@hpe/shared';

export interface OverviewData extends ScreenEnvelope {
  stats: StatDef[];
  alerts: OverviewAlert[];
  sites: OverviewSiteRow[];
  planes: OverviewPlaneRow[];
  changes: ChangeLogEntry[];
  /** Rotated audit-log generations the server could not open. The tail above
   *  is short by whatever they hold, so an empty change log is only "nothing
   *  was brokered yet" when this is 0 — otherwise part of the record is
   *  unreachable, which is the opposite claim. Absent means the route did not
   *  say (demo fixtures, or an older server). */
  changesUnreadable?: number;
  launchpad: LaunchpadRow[];
  syncedAt: string | null; // null in live mode before the first successful poll
  workspace?: string;
}

/** Optional list paging envelope from `?limit=&cursor=` screen routes. */
export interface ListPageMeta {
  total: number;
  limit: number;
  cursor: string;
  nextCursor: string | null;
}

/** Shared optional query for inventory/list screen GETs. */
export interface ScreenListQuery {
  limit?: number;
  cursor?: string;
  q?: string;
  plane?: string;
  /** Tickets queue: P1|P2|P3 (server-enforced). */
  pri?: string;
  /** Tickets queue: exact state or openish (server-enforced). */
  state?: string;
  /** UXI sensors: online|offline|issues|unknown|idle (server-enforced). */
  status?: string;
  /** UXI sensors: critical|warning|info — at least one issue of that severity. */
  severity?: string;
  /** UXI sensors / Alerts: exact site name (server-enforced, case-insensitive; Alerts allows comma multi). */
  site?: string;
  /** Auth events: accept|reject|timeout (server-enforced exact). */
  result?: string;
  /** Auth events: exact service name (server-enforced, case-insensitive). */
  service?: string;
  /** Auth events: exact method name (server-enforced, case-insensitive). */
  method?: string;
  /** Auth events: exact role name (server-enforced, case-insensitive). */
  role?: string;
  /** Sites list: ok|warn|bad|stale. Clients list: exact health word (case-insensitive). */
  health?: string;
  /** Alerts queue: P1|P2|P3 (comma multi OK; server-enforced on latest.sev). */
  sev?: string;
  /** Devices / Clients: exact type (server-enforced, case-insensitive). */
  type?: string;
  /** Devices: reconciliation issues only (`1`/`true`). */
  issues?: string;
  /** Clients: wired|wireless (server-enforced). */
  medium?: string;
  /** Clients: exact group (server-enforced, case-insensitive). */
  group?: string;
  /** Clients: problem rows only (`1`/`true`). */
  problems?: string;
  /** Alerts queue: only latest.state=open (`1`/`true`). */
  unacked?: string;
  /** Alerts queue: `0`/`false` drops cleared; `1`/`true` keeps them. */
  cleared?: string;
  /** Auth events: 15m|1h|24h|7d quick window on event.at (server-enforced). */
  range?: string;
}

function screenListPath(base: string, query?: ScreenListQuery): string {
  if (!query) return base;
  const params = new URLSearchParams();
  if (query.limit != null) params.set('limit', String(query.limit));
  if (query.cursor) params.set('cursor', query.cursor);
  if (query.q) params.set('q', query.q);
  if (query.plane) params.set('plane', query.plane);
  if (query.pri) params.set('pri', query.pri);
  if (query.state) params.set('state', query.state);
  if (query.status) params.set('status', query.status);
  if (query.severity) params.set('severity', query.severity);
  if (query.site) params.set('site', query.site);
  if (query.result) params.set('result', query.result);
  if (query.service) params.set('service', query.service);
  if (query.method) params.set('method', query.method);
  if (query.role) params.set('role', query.role);
  if (query.health) params.set('health', query.health);
  if (query.sev) params.set('sev', query.sev);
  if (query.type) params.set('type', query.type);
  if (query.issues) params.set('issues', query.issues);
  if (query.medium) params.set('medium', query.medium);
  if (query.group) params.set('group', query.group);
  if (query.problems) params.set('problems', query.problems);
  if (query.unacked) params.set('unacked', query.unacked);
  if (query.cleared) params.set('cleared', query.cleared);
  if (query.range) params.set('range', query.range);
  const qs = params.toString();
  return qs ? `${base}?${qs}` : base;
}

export interface AlertsData extends ScreenEnvelope {
  alerts: AlertRow[];
  syncedAt: string | null;
  /** The deduped queue, when the ROUTE groups it (shared/alertEngine.ts):
   *  silenced groups are excluded here and carried in `silenced` with their
   *  reason. Absent (demo fixture fallback, or an older server) = the screen
   *  groups the flat `alerts` itself with the same shared engine, so the two
   *  can never disagree about what belongs together. */
  groups?: AlertGroup[];
  /** Groups an active silence benched, each WITH the silence and its reason —
   *  suppression is always visible, never invisible. Absent = the route did
   *  not say (older server); an empty array means it looked and nothing is
   *  silenced. */
  silenced?: SilencedAlertGroup[];
  /** The danger/warning banner over the queue, when the ROUTE correlates it —
   *  the server can cross the worst finding with plane freshness, which a
   *  client-side correlate() over already-pulled rows cannot see. Absent (or
   *  null) = no server correlation was sent and the screen's own correlate()
   *  stays the single source; `tone` absent inside it keeps the renderer's
   *  existing 'danger' default. */
  correlation?: AlertCorrelation | null;
  /** Linked planes that contributed nothing to this dataset — the list above
   *  is short by whatever they hold. Absent means the route did not say; an
   *  empty array means it looked and every linked plane reported. */
  missingSources?: Plane[];
  /** Present only when the request asked for `?limit=` paging. */
  page?: ListPageMeta;
}

export interface TicketsData extends ScreenEnvelope {
  tickets: TicketRow[];
  /** Present only when the request asked for `?limit=` paging. */
  page?: ListPageMeta;
}

export interface ClientsData extends ScreenEnvelope {
  stats: StatDef[];
  clients: ClientRow[];
  /** Present only when the request asked for `?limit=` paging on the list. */
  page?: ListPageMeta;
  /** The three keys below appear ONLY when the request named one client
   *  (`/api/clients?mac=…`) — the route does no per-object read for a plain
   *  list poll, which is what keeps the 60s tick off the tenant's call budget.
   *  `null` on any of them is the route's honest "no plane could answer". */
  client?: ClientRow | null;
  detail?: ClientDetailLive | null;
  topology?: SiteTopologyLive | null;
  /** Client 360: every registry plane's view of the named client, keyed by
   *  its normalized MAC — present-with-data or absent-with-an-honest-reason.
   *  Same one-client rule as the keys above. It is a JOIN over rows the
   *  poller already pulled, so it costs no plane call; in demo mode the route
   *  correlates the fixtures themselves. Absent = the route did not say (an
   *  older server). */
  clientPlanes?: ClientPlaneSection[] | null;
  /** Linked planes that contributed nothing to this dataset — the list above
   *  is short by whatever they hold. Absent means the route did not say; an
   *  empty array means it looked and every linked plane reported. */
  missingSources?: Plane[];
}

export interface AuthEventsData extends ScreenEnvelope {
  stats: StatDef[];
  events: AuthEventRow[];
  failReasons: FailReasonRow[];
  policyServices: PolicyServiceRow[];
  /** Present only when the request asked for `?limit=` paging on events. */
  page?: ListPageMeta;
}

export interface ClearPassData extends ScreenEnvelope {
  /** Effective server-side write admission for this exact ClearPass connector. */
  canWrite?: boolean;
  /** A separately proven repository total, when the ClearPass read supplied one. */
  endpointTotal?: number | null;
  /**
   * Legacy compact snapshot retained for API compatibility. The ClearPass
   * screen's endpoint table never reads it; it uses its own bounded page API.
   */
  endpoints: EndpointRow[];
  authEvents: AuthEventRow[];
  /** Linked planes that contributed nothing to the endpoint or auth-event
   *  dataset — absent means the route did not say; an empty array means it
   *  looked and every linked plane reported. */
  missingSources?: Plane[];
  /** The CPPM's policy inventories. Each key is present only when the plane
   *  reported that collection (demo fixtures always carry the six below); an
   *  ABSENT key is the honest "this CPPM did not report it" — a failed read
   *  or a build that does not expose the collection — never an implied empty
   *  list. Present-and-empty is a real answer. */
  networkDevices?: ClearPassNetworkDeviceRow[];
  authSources?: ClearPassAuthSourceRow[];
  roles?: ClearPassRoleRow[];
  enforcementPolicies?: ClearPassEnforcementPolicyRow[];
  enforcementProfiles?: ClearPassEnforcementProfileRow[];
  /** Whitelisted identity fields only — no password material of any kind. */
  localUsers?: ClearPassLocalUserRow[];
  /** Served by 6.11 builds (/api/config/service) and by the demo estate;
   *  absent only when the live box 404s BOTH service paths — the screen
   *  renders "not available on this CPPM" for that case. */
  services?: ClearPassServiceRow[];
  /** Not exposed on every CPPM build (verified 404 on 6.11) — absent in
   *  demo AND whenever the live box 404s the read. */
  deviceGroups?: ClearPassDeviceGroupRow[];
}

export interface UxiData extends ScreenEnvelope {
  sensors: UxiSensorRow[];
  /** Non-empty only when the UXI plane is linked but did not contribute a
   *  sensor read this cycle — a single-plane dataset, unlike the merged
   *  multi-plane `missingSources` other screens carry. Absent means the
   *  route did not say. */
  missingSources?: Plane[];
  /** Present when the client requested `?limit=` — same shape as Sites/AuthEvents. */
  page?: ListPageMeta;
}

export interface MistData extends ScreenEnvelope {
  /** The plane's own status block — the registry facts live, the authored
   *  MIST_PLANE_STATUS in demo. Always present; `linked: false` is how an
   *  unlinked deployment reads. */
  plane: MistPlaneStatus;
  /** Per-site SLE rows keyed by SiteId. Absent = the pull did not carry the
   *  SLE walk this cycle (a failed read), which the screen words differently
   *  from a site simply absent from the map ("not scored", never 0%). */
  sleBySiteId?: Partial<Record<string, MistSleRow>>;
  /** Rogue/neighbor BSSIDs across sites. Absent = the rogues walk was not
   *  reported this cycle; present-and-empty = Mist heard nothing, a real
   *  answer. */
  rogues?: MistRogueApRow[];
  /** The AP rich-stats walk across sites — same absent/present-empty rule. */
  apStats?: MistApStatsRow[];
  /** Per-site licence consumption. null = Mist reported nothing this cycle
   *  (not linked, or the read failed) — the Licenses screen's own contract. */
  licenseUsages?: MistLicenseUsageRow[] | null;
  /** The plane's WLAN inventory (Configure's ssids dataset). null = not read
   *  this cycle or the plane named it unavailable. */
  wlans?: SsidObject[] | null;
  /** Mist-claimed devices (the firmware section's rows). Always present:
   *  the merge looked, so empty is a real answer. */
  devices: DeviceRow[];
}

export interface SitesData extends ScreenEnvelope {
  stats: StatDef[];
  sites: SiteRow[];
  /** Linked planes that contributed no device list. Sites are derived from
   *  the merged inventory, so these planes' locations are missing from the
   *  table entirely — not shown empty. Absent means the route did not say;
   *  an empty array means it looked and every linked plane reported. */
  missingSources?: Plane[];
  /** Mist's per-site Service Level Expectations, keyed by SiteId. Only Mist
   *  publishes this, so a site absent from the map is "not reported by any
   *  plane", not a score of zero. Absent map entirely = older server. */
  sleBySiteId?: Partial<Record<string, MistSleRow>>;
  /** Present only when the request asked for `?limit=` paging. */
  page?: ListPageMeta;
}

export interface CentralData extends ScreenEnvelope {
  /** The plane's own status block — the registry facts live, the authored
   *  SYSTEMS row's in demo. Always present; `linked: false` is how an
   *  unlinked deployment reads. */
  plane: CentralPlaneStatus;
  stats: StatDef[];
  /** Devices by type and by verbatim state word, off the plane's own rows. */
  fleet: CentralFleetSummary;
  /** Per-site rollup of the plane's own rows (never the cross-plane merge). */
  sites: CentralSiteRow[];
  /** Devices behind their recommended train — the plane's own verdict. */
  firmware: CentralFirmwareRow[];
  /** The plane's WLAN inventory (Configure's ssids dataset). */
  wlans: SsidObject[];
  /** The active alert queue cut to this plane (silences already applied
   *  server-side; received webhook deliveries included). */
  alerts: AlertRow[];
  /** Datasets the pull did not carry this cycle — each words its own section
   *  ("not reported"), never an implied empty estate. Absent = the route did
   *  not say (demo fixtures, or an older server); an empty array means it
   *  looked and every section reported. */
  notReported?: CentralDataset[];
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
  /** The site's floor plans (Mist-published — only Mist has maps). Present
   *  and EMPTY is a real answer: the site's planes were read and publish no
   *  map, which renders the honest no-map state — never a fabricated
   *  placeholder image. Absent = the route did not say (an older server). */
  maps?: MistSiteMap[];
  /** The site's Mist SLE row — the scores behind the wireless-experience
   *  section and the entry into the per-metric drill-down. null = no plane
   *  reports SLE for this site (rendered "not reported", never a 0% score);
   *  absent = the route did not say. */
  sle?: MistSleRow | null;
  /** Roster clients the plane locates on one of the site's maps, projected to
   *  exactly what a floor-plan dot renders (the site page has no client
   *  table). Absent = the route did not say. */
  mapClients?: SiteMapClientDot[];
}

/** One located client on a floor plan — the dot's position (map-image pixels
 *  against `mapId`), label and tone, and nothing else. */
export interface SiteMapClientDot {
  name: string;
  mac: string;
  x: number;
  y: number;
  mapId: string;
  health: string;
  healthTone: ClientRow['healthTone'];
}

export interface DevicesData extends ScreenEnvelope {
  devices: DeviceRow[];
  lanes: Partial<Record<Plane, LaneMeta>>;
  reconciliation?: { doubleClaimed: number; unclaimed: number };
  /** Linked planes with no device inventory in `devices` — the list is short
   *  by however much they manage. Absent means the route did not say (an
   *  older server, or demo fixtures); an empty array means it looked and every
   *  linked plane reported. The two are deliberately distinguishable. */
  missingInventories?: Plane[];
  /** Demo mode only: fixture names the operator hid, for the restore affordance. */
  hiddenDevices?: string[];
  /** Present only when the request asked for `?limit=` paging. */
  page?: ListPageMeta;
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
  /** The Mist AP rich-stats row for THIS device (radios with the full util
   *  split, CPU/mem, env sensors, power, uplink port + LLDP neighbour), joined
   *  from the Mist site stats walk — a POLL dataset, so no per-object call
   *  stands behind it. `null` = the route looked and this device has no Mist
   *  AP stats row (not a Mist AP, or the walk was not read); absent = the
   *  route did not say (an older server). The RF/health panel renders only
   *  when a row is present. */
  mistAp?: MistApStatsRow | null;
}

export interface LicensesData extends ScreenEnvelope {
  stats: StatDef[];
  subscriptions: SubscriptionRow[];
  renewals: RenewalRow[];
  orphans: OrphanRow[];
  /** Mist's per-site licence consumption (/orgs/{org}/licenses/usages). Only
   *  Mist publishes this: `null` means it reported nothing this cycle (not
   *  linked, or the read failed) — "not reported", never zero consumption.
   *  Absent key entirely = an older server that does not send the section. */
  mistLicenseUsages?: MistLicenseUsageRow[] | null;
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
  /** Linked planes that contributed no inventory, so this run does not cover
   *  them. `evidenceMode: 'coverage'` only means SOMETHING was read. Absent
   *  means the route did not say; empty means it looked and the run is whole. */
  missingInventories?: Plane[];
}

export interface SearchIndexData extends ScreenEnvelope {
  entries: SearchIndexEntry[];
}

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

export async function getAlerts(query?: ScreenListQuery): Promise<AlertsData> {
  const result = await fetchScreen<AlertsData>(screenListPath('/api/alerts', query));
  if (result.kind === 'ok') return result.data;
  if (result.kind === 'http-error') return apiFailure<AlertsData>(result.message, { alerts: [] });
  return { alerts: ALERTS, syncedAt: DEMO_SYNCED_AT, dataSource: 'demo' };
}

export async function getTickets(query?: ScreenListQuery): Promise<TicketsData> {
  const result = await fetchScreen<TicketsData>(screenListPath('/api/tickets', query));
  if (result.kind === 'ok') return result.data;
  if (result.kind === 'http-error') return apiFailure<TicketsData>(result.message, { tickets: [] });
  return { tickets: TICKETS, dataSource: 'demo' };
}

/**
 * The clients screen. Pass `mac` ONLY from a drawer open, never from the poll:
 * naming a client makes the route issue that client's per-object detail read,
 * and doing that on a 60s timer across a whole list is what the tenant's daily
 * call budget cannot survive.
 *
 * List polls may pass optional `limit`/`cursor`/`q`/`plane` (never with `mac`).
 */
export async function getClients(macOrQuery?: string | ScreenListQuery, maybeQuery?: ScreenListQuery): Promise<ClientsData> {
  const mac = typeof macOrQuery === 'string' ? macOrQuery : undefined;
  const query = typeof macOrQuery === 'string' ? maybeQuery : macOrQuery;
  let path: string;
  if (mac) {
    const params = new URLSearchParams({ mac });
    path = `/api/clients?${params.toString()}`;
  } else {
    path = screenListPath('/api/clients', query);
  }
  const result = await fetchScreen<ClientsData>(path);
  if (result.kind === 'ok') return dropUnreadableBlocks(result.data, 'detail', 'topology');
  if (result.kind === 'http-error') {
    return apiFailure<ClientsData>(result.message, { stats: [], clients: [] });
  }
  // Unreachable backend: the fixtures stand in for the estate, and a named
  // client gets the same 360 block the server's demo branch serves — both go
  // through the one shared correlation, so they cannot disagree.
  const picked = mac ? (CLIENTS.find((c) => c.mac === mac) ?? null) : undefined;
  return {
    stats: CLIENT_STATS,
    clients: CLIENTS,
    dataSource: 'demo',
    ...(mac
      ? {
          client: picked,
          clientPlanes: clientPlaneSections(mac, picked?.siteId ?? null, demoClient360World()),
        }
      : {}),
  };
}

/**
 * The 360 block out of a /api/clients?mac= envelope. It carries no provenance
 * envelope of its own — no plane call stands behind it, so there is no
 * `source.sections` to check — so the guard is structural: an array whose
 * every entry names a plane, a label and a known state. Absent or malformed
 * is null ("the route did not say"), NEVER []: an empty array would claim
 * every plane was answered for and reported nothing.
 */
export function unwrapClientPlanes(body: unknown): ClientPlaneSection[] | null {
  if (!body || typeof body !== 'object') return null;
  const block = (body as Record<string, unknown>).clientPlanes;
  if (!Array.isArray(block)) return null;
  const states = new Set(['ok', 'empty', 'not-fetched']);
  const valid = block.every(
    (s) =>
      !!s &&
      typeof s === 'object' &&
      typeof (s as { plane?: unknown }).plane === 'string' &&
      typeof (s as { label?: unknown }).label === 'string' &&
      states.has((s as { state?: unknown }).state as string),
  );
  return valid ? (block as ClientPlaneSection[]) : null;
}

/** The named-client block: the per-object detail read and the Client 360
 *  sections, from ONE envelope. */
export interface ClientDetailBlock {
  detail: ClientDetailLive | null;
  clientPlanes: ClientPlaneSection[] | null;
}

/**
 * The client's own detail AND its cross-plane 360 sections for the ONE client
 * whose drawer is open — read off a single `/api/clients?mac=` envelope, so
 * one drawer open stays one request.
 *
 * It rides `/api/clients?mac=`: the route does the per-object read only when a
 * request names a client, so the plain list poll stays exactly as cheap as it
 * was. Never call this from the polling loop.
 */
export async function getClientDetailBlock(mac: string): Promise<ClientDetailBlock | null> {
  const r = await fetchDetail<unknown>(`/api/clients?mac=${encodeURIComponent(mac)}`);
  if (r.kind !== 'ok') return null;
  return {
    detail: unwrapDetailPayload<ClientDetailLive>(r.data, 'detail'),
    clientPlanes: unwrapClientPlanes(r.data),
  };
}

/**
 * The client's own detail — signal, throughput, roam count, session timeline —
 * for the ONE client whose drawer is open. The detail-only view of the block
 * getClientDetailBlock() reads; same one-client rule.
 */
export async function getClientDetail(mac: string): Promise<ClientDetailLive | null> {
  return (await getClientDetailBlock(mac))?.detail ?? null;
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

export async function getAuthEvents(query?: ScreenListQuery): Promise<AuthEventsData> {
  const result = await fetchScreen<AuthEventsData>(screenListPath('/api/auth-events', query));
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

export async function getClearPass(): Promise<ClearPassData> {
  const result = await fetchScreen<ClearPassData>('/api/clearpass');
  if (result.kind === 'ok') return result.data;
  if (result.kind === 'http-error') {
    return apiFailure<ClearPassData>(result.message, { endpoints: [], authEvents: [] });
  }
  return {
    endpoints: CLEARPASS_ENDPOINTS,
    authEvents: AUTH_EVENTS,
    networkDevices: CLEARPASS_NETWORK_DEVICES,
    authSources: CLEARPASS_AUTH_SOURCES,
    roles: CLEARPASS_ROLES,
    enforcementPolicies: CLEARPASS_ENFORCEMENT_POLICIES,
    enforcementProfiles: CLEARPASS_ENFORCEMENT_PROFILES,
    localUsers: CLEARPASS_LOCAL_USERS,
    services: CLEARPASS_SERVICES,
    // deviceGroups stays absent — the demo estate's CPPM does not expose it,
    // and the screen says so rather than implying an empty list.
    dataSource: 'demo',
    syncedAt: DEMO_SYNCED_AT,
  };
}

/**
 * The three outcomes of a service detail read, kept distinct because the
 * drawer words them differently: a payload renders its sections ('ok' the
 * object mapped, 'empty' the box 404'd, 'failed' the read broke),
 * 'not-reported' is the portal's straight answer that no detail exists for
 * this id (the demo world did not author one, or no linked plane can
 * answer), and 'failed' means the request itself broke — never rendered as
 * an empty drawer.
 */
export type ClearPassServiceDetailResult =
  | { kind: 'ok'; detail: ClearPassServiceDetailLive }
  | { kind: 'not-reported' }
  | { kind: 'failed'; message: string };

/**
 * ONE service's full definition for the Services-tab drawer. Called ONLY
 * from an open drawer, never from a poll: the route spends one per-service
 * GET on the ClearPass plane behind its TTL cache and budget gate. A block
 * without its provenance envelope is 'not-reported', never rendered (the
 * same unreadable-block rule as the other detail payloads).
 */
export async function getClearPassServiceDetail(id: string): Promise<ClearPassServiceDetailResult> {
  const r = await fetchDetail<unknown>(`/api/clearpass/services/${encodeURIComponent(id)}`);
  if (r.kind === 'ok') {
    const detail = unwrapDetailPayload<ClearPassServiceDetailLive>(r.data, 'serviceDetail');
    return detail ? { kind: 'ok', detail } : { kind: 'not-reported' };
  }
  if (r.kind === 'answered') {
    return r.status === 404 ? { kind: 'not-reported' } : { kind: 'failed', message: r.message };
  }
  // Backend absent: mirror the server's demo branch — the authored detail when
  // the demo world has one, the same honest 'not reported' when it does not.
  const demo = CLEARPASS_SERVICE_DETAILS[id];
  return demo ? { kind: 'ok', detail: demo } : { kind: 'not-reported' };
}

export async function getUxi(query?: ScreenListQuery): Promise<UxiData> {
  const result = await fetchScreen<UxiData>(screenListPath('/api/uxi', query));
  if (result.kind === 'ok') return result.data;
  if (result.kind === 'http-error') {
    return apiFailure<UxiData>(result.message, { sensors: [] });
  }
  /* Offline fixture path: apply the same filters client-side so demo stays honest. */
  let sensors = UXI_SENSORS.slice();
  const q = query?.q?.trim().toLowerCase() ?? '';
  const status = query?.status?.trim().toLowerCase() ?? '';
  const site = query?.site?.trim().toLowerCase() ?? '';
  if (q || status || site) {
    sensors = sensors.filter((s) => {
      if (site && String(s.site ?? '').trim().toLowerCase() !== site) return false;
      if (q) {
        const hay = [s.name, s.serial ?? '', s.site ?? '', s.model ?? ''].join(' ').toLowerCase();
        if (!hay.includes(q)) return false;
      }
      if (status === 'online' && s.isOnline !== true) return false;
      if (status === 'offline' && s.isOnline !== false) return false;
      if (status === 'unknown' && s.isOnline !== null) return false;
      if (status === 'issues' && !(s.issueCount > 0)) return false;
      if (status === 'idle' && !(s.isOnline === true && s.isTesting === false)) return false;
      return true;
    });
  }
  const limit = query?.limit;
  if (limit != null && limit > 0) {
    const cursor = Math.max(0, Number.parseInt(query?.cursor ?? '0', 10) || 0);
    const slice = sensors.slice(cursor, cursor + limit);
    const next = cursor + limit < sensors.length ? String(cursor + limit) : null;
    return {
      sensors: slice,
      dataSource: 'demo',
      syncedAt: DEMO_SYNCED_AT,
      page: { total: sensors.length, limit, cursor: String(cursor), nextCursor: next },
    };
  }
  return {
    sensors,
    dataSource: 'demo',
    syncedAt: DEMO_SYNCED_AT,
  };
}

export async function getMist(): Promise<MistData> {
  const result = await fetchScreen<MistData>('/api/mist');
  if (result.kind === 'ok') return result.data;
  if (result.kind === 'http-error') {
    return apiFailure<MistData>(result.message, { plane: UNLINKED_MIST_PLANE, devices: [] });
  }
  // Unreachable backend: the same authored world the server's demo branch
  // serves, composed here from the shared fixtures.
  return {
    plane: MIST_PLANE_STATUS,
    sleBySiteId: SITE_SLE,
    rogues: MIST_ROGUE_APS,
    apStats: MIST_AP_STATS,
    licenseUsages: MIST_LICENSE_USAGES,
    wlans: SSIDS.filter((s) => s.plane.includes('MIST')),
    devices: DEVICES.filter((d) => d.plane === 'MIST'),
    dataSource: 'demo',
    syncedAt: DEMO_SYNCED_AT,
  };
}

/** The plane block an http-error fallback carries: never a fabricated
 *  healthy plane — the apiError banner is what the screen acts on. */
const UNLINKED_MIST_PLANE: MistPlaneStatus = {
  linked: false,
  health: 'unlinked',
  lastSync: null,
  deviceCount: null,
  clientCount: null,
  note: null,
};

/** Same rule for the Central screen's http-error fallback. */
const UNLINKED_CENTRAL_PLANE: CentralPlaneStatus = {
  linked: false,
  health: 'unlinked',
  tone: 'neutral',
  lastSync: null,
  note: null,
};

export async function getCentral(): Promise<CentralData> {
  const result = await fetchScreen<CentralData>('/api/central');
  if (result.kind === 'ok') return result.data;
  if (result.kind === 'http-error') {
    return apiFailure<CentralData>(result.message, {
      plane: UNLINKED_CENTRAL_PLANE,
      stats: [],
      fleet: { total: 0, byType: {}, byState: {} },
      sites: [],
      firmware: [],
      wlans: [],
      alerts: [],
    });
  }
  // Unreachable backend: the SAME shared composition the server's demo branch
  // serves (shared/central.ts), so the standalone demo can never drift from it.
  return { ...demoCentralSections(), dataSource: 'demo', syncedAt: DEMO_SYNCED_AT };
}

export async function getSites(query?: ScreenListQuery): Promise<SitesData> {
  const result = await fetchScreen<SitesData>(screenListPath('/api/sites', query));
  if (result.kind === 'ok') return result.data;
  if (result.kind === 'http-error') return apiFailure<SitesData>(result.message, { stats: [], sites: [] });
  return { stats: SITE_STATS, sites: SITES, sleBySiteId: SITE_SLE, dataSource: 'demo' };
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
    // Same mirroring for the Mist slices: the authored plans, SLE row and
    // located-client dots, so the standalone demo renders exactly what the
    // server's demo branch serves.
    maps: MIST_SITE_MAPS.filter((m) => m.siteId === id),
    sle: SITE_SLE[id] ?? null,
    mapClients: mapClientDots(CLIENTS, id),
    dataSource: 'demo',
  };
}

export interface TopologyData extends ScreenEnvelope, TopologyPayload {}

/** The estate-level neighbour graph: /api/topology, with the demo fallback
 *  built by the SAME shared assembly the server's demo branch runs, so the
 *  two can never drift (fixed stamps — the fallback is byte-stable too). */
export async function getTopology(): Promise<TopologyData> {
  const result = await fetchScreen<TopologyData>('/api/topology');
  if (result.kind === 'ok') return result.data;
  if (result.kind === 'http-error') {
    return apiFailure<TopologyData>(result.message, {
      graph: { nodes: [], edges: [], sites: [], omissions: [] },
      notes: [],
    });
  }
  return { graph: buildDemoTopologyGraph(), notes: demoTopologyNotes(), dataSource: 'demo' };
}

/** The located-client dots of one site, off the roster — the same projection
 *  the server's mapClientDots applies, kept here so the offline demo fallback
 *  and the demo route cannot disagree about what draws a dot. */
function mapClientDots(clients: ClientRow[], siteId: SiteId): SiteMapClientDot[] {
  const dots: SiteMapClientDot[] = [];
  for (const c of clients) {
    if (c.siteId !== siteId) continue;
    if (c.x === undefined || c.y === undefined || c.mapId === undefined) continue;
    dots.push({ name: c.name, mac: c.mac, x: c.x, y: c.y, mapId: c.mapId, health: c.health, healthTone: c.healthTone });
  }
  return dots;
}

/**
 * The three outcomes of the per-metric SLE drill read, kept distinct because
 * the drawer words them differently: a payload renders its sections (each
 * carrying its own ok/empty/failed), 'not-reported' is the portal's straight
 * answer that no drill exists for this metric/site, and 'failed' means the
 * read itself broke — never rendered as an empty drill.
 */
export type SleMetricDetailResult =
  | { kind: 'ok'; detail: MistSleMetricDetail }
  | { kind: 'not-reported' }
  | { kind: 'failed'; message: string };

/**
 * The drill-down behind ONE SLE metric at ONE site — classifiers, impacted
 * clients/APs, summary trend. Called ONLY from an open drill drawer, never
 * from a poll: the route spends four per-metric endpoints on the Mist plane
 * behind its TTL cache and budget gate. A block without its provenance
 * envelope is 'not-reported', never rendered (same unreadable-block rule as
 * the other detail payloads).
 */
export async function getSleMetricDetail(
  siteId: string,
  metric: string,
): Promise<SleMetricDetailResult> {
  const r = await fetchDetail<unknown>(
    `/api/sites/${encodeURIComponent(siteId)}/sle/${encodeURIComponent(metric)}`,
  );
  if (r.kind === 'ok') {
    const detail = unwrapDetailPayload<MistSleMetricDetail>(r.data, 'sleDetail');
    return detail ? { kind: 'ok', detail } : { kind: 'not-reported' };
  }
  if (r.kind === 'answered') {
    return r.status === 404 ? { kind: 'not-reported' } : { kind: 'failed', message: r.message };
  }
  // Backend absent: mirror the server's demo branch — the authored drill when
  // the demo world has one, the same honest 'not reported' when it does not.
  const id = (SITE_IDS as readonly string[]).includes(siteId) ? siteId : siteIdFor(siteId);
  const demo = id ? MIST_SLE_DRILLDOWN[`${id}|${metric}`] : undefined;
  return demo ? { kind: 'ok', detail: demo } : { kind: 'not-reported' };
}

/**
 * The three outcomes of a site's DPI applications read, kept distinct because
 * the section words them differently: a payload renders its table (carrying
 * its own ok/empty/failed), 'not-reported' is the portal's straight answer
 * that no DPI table exists for this site, and 'failed' means the read itself
 * broke — never rendered as an empty table.
 */
export type SiteApplicationsResult =
  | { kind: 'ok'; applications: SiteApplicationsLive }
  | { kind: 'not-reported' }
  | { kind: 'failed'; message: string };

/**
 * The DPI application table for ONE site — the risk buckets, watchlist, top
 * talkers and category rollup behind the site page's application-visibility
 * section (and the Client 360's site-wide line for a Central client). Called
 * ONLY when that section mounts or that drawer opens, never from a poll: the
 * route pages the Central endpoint behind its TTL cache and budget gate. A
 * block without its provenance envelope is 'not-reported', never rendered
 * (same unreadable-block rule as the other detail payloads).
 */
export async function getSiteApplications(siteId: string): Promise<SiteApplicationsResult> {
  const r = await fetchDetail<unknown>(
    `/api/sites/${encodeURIComponent(siteId)}/applications`,
  );
  if (r.kind === 'ok') {
    const applications = unwrapDetailPayload<SiteApplicationsLive>(r.data, 'applications');
    return applications ? { kind: 'ok', applications } : { kind: 'not-reported' };
  }
  if (r.kind === 'answered') {
    return r.status === 404 ? { kind: 'not-reported' } : { kind: 'failed', message: r.message };
  }
  // Backend absent: mirror the server's demo branch — the authored table when
  // the demo world has one, the same honest 'not reported' when it does not.
  const id = (SITE_IDS as readonly string[]).includes(siteId) ? (siteId as SiteId) : siteIdFor(siteId);
  const demo = id ? SITE_APPLICATIONS_DEMO[id] : undefined;
  return demo ? { kind: 'ok', applications: demo } : { kind: 'not-reported' };
}

// ---------------------------------------------------------------------------
// Device hardware/telemetry trends — /api/devices/:name/trends/* (on-demand)
// ---------------------------------------------------------------------------

/**
 * The three outcomes of a per-device trend read, kept distinct because the
 * panel words them differently: a payload renders its series (the read's own
 * `source.sections` still say ok/empty/failed inside it), 'not-reported' is
 * the portal's straight answer that no plane can serve it (or that the demo
 * world authored none), and 'failed' means the read itself broke — never
 * rendered as an empty chart.
 */
export type DeviceTrendResult<T> =
  | { kind: 'ok'; live: T }
  | { kind: 'not-reported' }
  | { kind: 'failed'; message: string };

/** The path for one trend read: the device, the window, and the exact
 *  plane+serial identity the page's own read resolved (two reconciled rows
 *  can share a display name). */
function deviceTrendPath(
  name: string,
  read: string,
  window: { start: string; end: string },
  identity: DeviceDetailIdentity,
): string {
  const params = new URLSearchParams({ start: window.start, end: window.end });
  if (identity.plane) params.set('plane', identity.plane);
  if (identity.serial) params.set('serial', identity.serial);
  return `/api/devices/${encodeURIComponent(name)}/trends/${read}?${params.toString()}`;
}

/**
 * A switch's hardware gauges (cpu/memory/temperature/PoE/power) for the ONE
 * device whose page is open, over ONE window. Called from the panel mount and
 * on a window change, never from a poll — the route spends one Central call
 * behind its TTL cache and budget gate.
 */
export async function getDeviceHardwareTrends(
  name: string,
  window: { start: string; end: string },
  identity: DeviceDetailIdentity = {},
): Promise<DeviceTrendResult<SwitchHardwareTrendsLive>> {
  const r = await fetchDetail<unknown>(deviceTrendPath(name, 'hardware', window, identity));
  if (r.kind === 'ok') {
    const live = unwrapDetailPayload<SwitchHardwareTrendsLive>(r.data, 'hardwareTrends');
    return live ? { kind: 'ok', live } : { kind: 'not-reported' };
  }
  if (r.kind === 'answered') {
    return r.status === 404 ? { kind: 'not-reported' } : { kind: 'failed', message: r.message };
  }
  // Backend absent: mirror the server's demo branch — the authored read when
  // the demo world has one, the same honest 'not reported' when it does not.
  const demo = SWITCH_HARDWARE_TRENDS_DEMO[name];
  return demo ? { kind: 'ok', live: demo } : { kind: 'not-reported' };
}

/** A switch's interface byte/error counter trends, same on-demand rule. */
export async function getDeviceInterfaceTrends(
  name: string,
  window: { start: string; end: string },
  identity: DeviceDetailIdentity = {},
): Promise<DeviceTrendResult<SwitchInterfaceTrendsLive>> {
  const r = await fetchDetail<unknown>(deviceTrendPath(name, 'interfaces', window, identity));
  if (r.kind === 'ok') {
    const live = unwrapDetailPayload<SwitchInterfaceTrendsLive>(r.data, 'interfaceTrends');
    return live ? { kind: 'ok', live } : { kind: 'not-reported' };
  }
  if (r.kind === 'answered') {
    return r.status === 404 ? { kind: 'not-reported' } : { kind: 'failed', message: r.message };
  }
  const demo = SWITCH_INTERFACE_TRENDS_DEMO[name];
  return demo ? { kind: 'ok', live: demo } : { kind: 'not-reported' };
}

/** ONE AP metric trend (cpu | memory | throughput — throughput normalized to
 *  bit/s by the read), same on-demand rule. */
export async function getDeviceApTrends(
  name: string,
  metric: ApTrendMetric,
  window: { start: string; end: string },
  identity: DeviceDetailIdentity = {},
): Promise<DeviceTrendResult<ApTrendsLive>> {
  const r = await fetchDetail<unknown>(deviceTrendPath(name, `ap/${encodeURIComponent(metric)}`, window, identity));
  if (r.kind === 'ok') {
    const live = unwrapDetailPayload<ApTrendsLive>(r.data, 'apTrends');
    return live ? { kind: 'ok', live } : { kind: 'not-reported' };
  }
  if (r.kind === 'answered') {
    return r.status === 404 ? { kind: 'not-reported' } : { kind: 'failed', message: r.message };
  }
  const demo = AP_TRENDS_DEMO[`${name}|${metric}`];
  return demo ? { kind: 'ok', live: demo } : { kind: 'not-reported' };
}

export async function getDevices(query?: ScreenListQuery): Promise<DevicesData> {
  const result = await fetchScreen<DevicesData>(screenListPath('/api/devices', query));
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

/** Bulk serial lookup — max 50. Offline: filter demo DEVICES the same way. */
export async function getDevicesBulk(
  serials: string[],
  planes?: string[],
): Promise<{ devices: DeviceRow[]; missing: string[]; requested: number; dataSource: 'live' | 'demo'; apiError?: string }> {
  const cleaned = [...new Set(serials.map((s) => s.trim()).filter(Boolean))].slice(0, 50);
  if (cleaned.length === 0) {
    return { devices: [], missing: [], requested: 0, dataSource: 'demo' };
  }
  const params = new URLSearchParams({ serials: cleaned.join(',') });
  if (planes && planes.length > 0) params.set('planes', planes.join(','));
  const result = await fetchScreen<{
    devices: DeviceRow[];
    missing: string[];
    requested: number;
    dataSource?: 'live' | 'demo';
  }>(`/api/devices/bulk?${params.toString()}`);
  if (result.kind === 'ok') {
    return {
      devices: result.data.devices ?? [],
      missing: result.data.missing ?? [],
      requested: result.data.requested ?? cleaned.length,
      dataSource: result.data.dataSource === 'live' ? 'live' : 'demo',
    };
  }
  if (result.kind === 'http-error') {
    return {
      devices: [],
      missing: cleaned,
      requested: cleaned.length,
      dataSource: 'live',
      apiError: result.message,
    };
  }
  const wanted = new Set(cleaned.map((s) => s.toLowerCase()));
  const planeSet = planes && planes.length > 0 ? new Set(planes.map((p) => p.toLowerCase())) : null;
  const devices = DEVICES.filter((d) => {
    const serial = (d.serial ?? '').trim();
    if (!serial || !wanted.has(serial.toLowerCase())) return false;
    if (!planeSet) return true;
    const plane = String(d.plane ?? '').toLowerCase();
    const claimed = (d.claimedBy ?? []).map((p) => String(p).toLowerCase());
    return planeSet.has(plane) || claimed.some((p) => planeSet.has(p));
  });
  const found = new Set(devices.map((d) => (d.serial ?? '').trim().toLowerCase()).filter(Boolean));
  return {
    devices,
    missing: cleaned.filter((s) => !found.has(s.toLowerCase())),
    requested: cleaned.length,
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
export function normalizeEvidence(data: DeviceDetailData & { checks?: DeviceCheckRow[] }): DeviceDetailData {
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
    // Same join the server's demo branch runs (its mistApStatsFor): serial
    // beats MAC beats name, so the stats row never lands on the wrong AP.
    mistAp:
      MIST_AP_STATS.find((row) => device.serial !== undefined && row.serial === device.serial) ??
      MIST_AP_STATS.find(
        (row) => device.mac !== undefined && row.mac?.toLowerCase() === device.mac.toLowerCase(),
      ) ??
      MIST_AP_STATS.find((row) => row.deviceName === device.name) ??
      null,
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
      mistLicenseUsages: null,
    });
  }
  return {
    stats: LICENSE_STATS,
    subscriptions: SUBSCRIPTIONS,
    renewals: RENEWALS,
    orphans: ORPHANS,
    mistLicenseUsages: MIST_LICENSE_USAGES,
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

export async function getSearchIndex(): Promise<SearchIndexData> {
  const result = await fetchScreen<SearchIndexData>('/api/search-index');
  if (result.kind === 'ok') return result.data;
  if (result.kind === 'http-error') return apiFailure<SearchIndexData>(result.message, { entries: [] });
  return { entries: SEARCH_INDEX, dataSource: 'demo' };
}

// ---------------------------------------------------------------------------
// Config backups — /api/config-backups (versioned running-config snapshots)
// ---------------------------------------------------------------------------

/**
 * The estate's backup/drift roster. Additive: there is deliberately NO
 * fixture fallback here — an unreachable or failing API hides the drift
 * section rather than painting authored backup data the server never
 * claimed. (Demo backups are synthesized server-side; they are not part of
 * the offline fixture set.)
 */
export async function getConfigBackups(): Promise<ConfigBackupListEnvelope | null> {
  const result = await fetchScreen<ConfigBackupListEnvelope>('/api/config-backups');
  return result.kind === 'ok' ? result.data : null;
}

/** Version metadata for one device, newest first. */
export async function getConfigBackupVersions(device: string): Promise<ConfigBackupVersionList | null> {
  const r = await fetchDetail<ConfigBackupVersionList>(
    `/api/config-backups/${encodeURIComponent(device)}/versions`,
  );
  return r.kind === 'ok' ? r.data : null;
}

/** The unified line-diff between two stored versions of one device. */
export async function getConfigBackupDiff(
  device: string,
  from: number,
  to: number,
): Promise<ConfigBackupDiff | null> {
  const r = await fetchDetail<ConfigBackupDiff>(
    `/api/config-backups/${encodeURIComponent(device)}/diff?from=${from}&to=${to}`,
  );
  return r.kind === 'ok' ? r.data : null;
}
