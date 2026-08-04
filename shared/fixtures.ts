/**
 * shared/fixtures.ts — every fixture extracted from design/*.dc.html,
 * normalised to shared/types.ts.
 *
 * Provenance is noted per export (source file + original constant name).
 * Nothing here is invented; the only transformations are:
 *   - README field names (fw→firmware, fwOk→firmwareApproved, issue→reconciliationIssue,
 *     base→baseline, kind→model),
 *   - site references resolved to `siteId` via the canonical SITE_ID map below,
 *     keeping the authored display string as `siteName`,
 *   - plane labels normalised to the Plane union ('GLK'→'GREENLAKE',
 *     '3RD-PARTY'→'THIRD-PARTY'),
 *   - health '—' → null (README: null = inventory stale, cannot assert).
 */

import type {
  AlertRow,
  ApUplinkMap,
  AuthEventRow,
  BaselineProgressRow,
  CapabilityRow,
  ChangeLogEntry,
  ClearPassAuthSourceRow,
  ClearPassEnforcementPolicyRow,
  ClearPassEnforcementProfileRow,
  ClearPassLocalUserRow,
  ClearPassNetworkDeviceRow,
  ClearPassRoleRow,
  ClearPassServiceDetailLive,
  ClearPassServiceRow,
  ClientRow,
  ConnectField,
  CrumbMap,
  DeviceCfg,
  DeviceClientSet,
  DeviceProfile,
  DeviceRow,
  EndpointRow,
  EndpointVariant,
  Fact,
  FailReasonRow,
  FindingRow,
  LaneMeta,
  LaunchpadRow,
  MistLicenseUsageRow,
  MistApStatsRow,
  MistAuditLogRow,
  MistPlaneStatus,
  MistRogueApRow,
  MistSiteMap,
  MistSleMetricDetail,
  MistSleRow,
  NavGroup,
  OrphanRow,
  OverviewAlert,
  OverviewPlaneRow,
  OverviewSiteRow,
  Plane,
  PlaneKey,
  PolicyServiceRow,
  PortObject,
  QueuedChangeRow,
  RenewalRow,
  SearchIndexEntry,
  SiteAlertRow,
  SiteChain,
  SiteDeviceRow,
  SiteId,
  SiteProfile,
  SiteRow,
  SsidCatalog,
  SsidForm,
  PortForm,
  VlanForm,
  SsidObject,
  StatDef,
  SubscriptionRow,
  SyncHistoryRow,
  PermissionRow,
  SystemRow,
  SystemTypeKey,
  TerminalKind,
  TerminalResponseTable,
  TicketRow,
  TimelineStep,
  TimelineVariant,
  UxiSensorRow,
  VlanObject,
  SelectOption,
  WriteMode,
} from './types';
import { CONNECTOR_CATALOG, connectorCatalogEntry } from './connectors';
import {
  byBytesDesc,
  normalizeSiteApp,
  type SiteAppRow,
  type SiteApplicationsLive,
} from './appRisk';
import {
  apTrendSpecs,
  interfaceTrendSpecs,
  normalizeTrendSet,
  type ApTrendsLive,
  type SwitchHardwareTrendsLive,
  type SwitchInterfaceTrendsLive,
} from './trends';
import type { TopologyEdgeReportInput } from './topologyGraph';

// ---------------------------------------------------------------------------
// Canonical site map
// ---------------------------------------------------------------------------

/** Canonical display name per site id (NtSites authoring wins). */
export const SITE_DISPLAY_NAMES: Record<SiteId, string> = {
  'campus-01': 'Campus-01 — Meridian HQ',
  'campus-02': 'Campus-02 Research',
  lakeshore: 'Lakeshore Medical Center',
  riverside: 'Riverside Clinic',
  northgate: 'Northgate Clinic',
  southpoint: 'Southpoint Clinic',
  'warehouse-dc1': 'Warehouse-DC1',
  'warehouse-dc2': 'Warehouse-DC2',
  'airport-annex': 'Airport Annex',
  'remote-vpn': 'Remote & VPN users',
  'core-services': 'Core services',
  workspace: 'Workspace',
  multiple: 'Multiple',
};

export function siteDisplayName(id: SiteId): string {
  return SITE_DISPLAY_NAMES[id];
}

/** Every site-name variant observed in the fixtures, lower-cased → id. */
const SITE_ALIASES: Record<string, SiteId> = {
  'campus-01 — meridian hq': 'campus-01', // NtSites, NtSiteDetail, shell, NtSystems
  'campus-01 hq': 'campus-01', // NtAlerts, NtClients, NtDevices, NT_SITE_CHAIN
  'campus-01': 'campus-01', // NT_INDEX device metas, alert metas
  'campus-02 research': 'campus-02',
  'campus-02': 'campus-02',
  'lakeshore medical center': 'lakeshore', // NtSites, NtSiteDetail, shell, NtSystems
  'lakeshore medical': 'lakeshore', // NtAlerts, NtClients, NtDevices, NtTickets, NT_SITE_CHAIN
  lakeshore: 'lakeshore', // NT_INDEX device metas
  'riverside clinic': 'riverside',
  'northgate clinic': 'northgate',
  'southpoint clinic': 'southpoint',
  'warehouse-dc1': 'warehouse-dc1',
  'warehouse-dc2': 'warehouse-dc2',
  'airport annex': 'airport-annex',
  'remote & vpn users': 'remote-vpn',
  'core services': 'core-services',
  workspace: 'workspace',
  multiple: 'multiple',
};

/** Resolve any authored site-name variant to its canonical id. */
export function siteIdFor(name: string): SiteId | undefined {
  return SITE_ALIASES[name.trim().toLowerCase()];
}

// ---------------------------------------------------------------------------
// Shell — HpeNetworkTools.dc.html
// ---------------------------------------------------------------------------

/**
 * Nav groups — object-first IA (NightDesk 2.0).
 * Primary rail stays job-oriented (~9 items). Plane consoles live under
 * Platforms so operators pick a task, not a brand.
 */
export const NAV_GROUPS: NavGroup[] = [
  {
    label: 'Operate',
    items: [
      { label: 'Overview', view: 'overview' },
      { label: 'Alerts', view: 'alerts' },
      { label: 'Topology', view: 'topology' },
      { label: 'Tickets', view: 'tickets' },
      { label: 'Clients', view: 'clients' },
    ],
  },
  {
    label: 'Estate',
    items: [
      { label: 'Sites', view: 'sites' },
      { label: 'Devices', view: 'devices' },
      { label: 'Inventory explorer', view: 'inventory' },
      { label: 'Auth events', view: 'auth' },
    ],
  },
  {
    label: 'Change',
    items: [
      { label: 'Configure', view: 'configure' },
      { label: 'Compliance', view: 'compliance' },
      { label: 'Licences', view: 'licenses' },
    ],
  },
  {
    label: 'Platforms',
    items: [
      { label: 'Connected systems', view: 'systems' },
      { label: 'Central', view: 'central' },
      { label: 'Mist', view: 'mist' },
      { label: 'ClearPass', view: 'clearpass' },
      { label: 'UXI', view: 'uxi' },
      { label: 'GreenLake', view: 'greenlake' },
    ],
  },
];

/** Global search index — NT_INDEX (17 entries). */
export const SEARCH_INDEX: SearchIndexEntry[] = [
  { kind: 'site', label: 'Campus-01 — Meridian HQ', meta: '148 devices', view: 'site', arg: 'Campus-01 — Meridian HQ' },
  { kind: 'site', label: 'Lakeshore Medical Center', meta: 'AOS-8 · 62 devices', view: 'site', arg: 'Lakeshore Medical Center' },
  { kind: 'site', label: 'Riverside Clinic', meta: 'Central Classic', view: 'site', arg: 'Riverside Clinic' },
  { kind: 'site', label: 'Warehouse-DC1', meta: 'local only', view: 'site', arg: 'Warehouse-DC1' },
  { kind: 'device', label: 'sw-core-a', meta: 'CX 8325 · Campus-01', view: 'device', arg: 'sw-core-a' },
  { kind: 'device', label: 'sw-core-b', meta: 'CX 8325 · Campus-01', view: 'device', arg: 'sw-core-b' },
  { kind: 'device', label: 'sw-acc-3f-2', meta: 'CX 6300 · Campus-01', view: 'device', arg: 'sw-acc-3f-2' },
  { kind: 'device', label: 'mm-lake-1', meta: 'AOS-8 master · Lakeshore', view: 'device', arg: 'mm-lake-1' },
  { kind: 'device', label: 'gw-edge-1', meta: 'AOS-10 gateway · Campus-01', view: 'device', arg: 'gw-edge-1' },
  { kind: 'device', label: 'ap-3f-12', meta: 'Mist AP43 · Campus-02', view: 'device', arg: 'ap-3f-12' },
  { kind: 'mac', label: '3c:2a:f4:9b:11:08', meta: 'ap-3f-12 · port 1/1/14', view: 'device', arg: 'sw-acc-3f-2' },
  { kind: 'client', label: 'm.okonjo — iPad, ward 3E', meta: 'clinical · ap-3f-12', view: 'clients', arg: null },
  { kind: 'config', label: 'MRDN-Guest SSID — vlan 812', meta: 'edit ssid · central', view: 'configure', arg: null },
  { kind: 'config', label: 'sw-core-a port 1/1/14', meta: 'edit port · local ssh', view: 'configure', arg: null },
  { kind: 'client', label: '6e:41:0d:99:2b:af — 7 auth rejects', meta: 'quarantine · ap-3f-14', view: 'auth', arg: null },
  { kind: 'ip', label: '10.42.8.11', meta: 'sw-core-a · vlan 8', view: 'device', arg: 'sw-core-a' },
  { kind: 'ticket', label: 'NET-4188 — Wi-Fi drops, 3rd floor east', meta: 'P2 · open', view: 'tickets', arg: 'NET-4188' },
  { kind: 'ticket', label: 'NET-4173 — Classic sync stalled', meta: 'P1 · open', view: 'tickets', arg: 'NET-4173' },
];

/** Breadcrumb trails per view (workspace crumb is prepended at runtime). */
export const CRUMBS: CrumbMap = {
  overview: [{ label: 'Overview' }],
  topology: [{ label: 'Operate' }, { label: 'Topology' }],
  alerts: [{ label: 'Operate' }, { label: 'Alerts' }],
  tickets: [{ label: 'Operate' }, { label: 'Tickets' }],
  clients: [{ label: 'Operate' }, { label: 'Clients' }],
  auth: [{ label: 'Estate' }, { label: 'Auth & policy events' }],
  clearpass: [{ label: 'Platforms' }, { label: 'ClearPass' }],
  central: [{ label: 'Platforms' }, { label: 'Central' }],
  mist: [{ label: 'Platforms' }, { label: 'Mist' }],
  uxi: [{ label: 'Platforms' }, { label: 'UXI' }],
  inventory: [{ label: 'Estate' }, { label: 'Explorer' }],
  sites: [{ label: 'Estate' }, { label: 'Sites' }],
  devices: [{ label: 'Estate' }, { label: 'Devices' }],
  licenses: [{ label: 'Change' }, { label: 'Licences' }],
  greenlake: [{ label: 'Platforms' }, { label: 'GreenLake workspace' }],
  configure: [{ label: 'Change' }, { label: 'Configuration' }],
  compliance: [{ label: 'Change' }, { label: 'Compliance' }],
  systems: [{ label: 'Platforms' }, { label: 'Connected systems' }],
};

// ---------------------------------------------------------------------------
// Overview — NtOverview.dc.html
// ---------------------------------------------------------------------------

/** Stat row, from the markup (5 stats). */
export const OVERVIEW_STATS: StatDef[] = [
  { label: 'Devices reachable', value: '404 / 418', delta: '▼ 3 since 08:00', tone: 'negative' },
  { label: 'Open alerts', value: '7', delta: '▲ 2 critical', tone: 'negative' },
  { label: 'Config drift', value: '12', delta: '▼ 4 this week', tone: 'positive' },
  { label: 'Licences ≤60d', value: '34', delta: '▲ 12 renewals due', tone: 'neutral' },
  { label: 'Planes linked', value: '6 / 7', delta: 'Classic degraded', tone: 'negative' },
];

/** "Needs you now" — NT_ALERTS (5 rows; the prototype renders slice(0, 4)).
 *  Note: row 5's plane was authored 'GLK' — normalised to 'GREENLAKE'.
 *
 *  The three rows whose authored `meta` opens with a site also carry that site
 *  as `siteName`/`siteId`, exactly as the live mapper sends it — so the demo
 *  estate's "Needs you now" sites are openable too, instead of being prose the
 *  operator cannot click. The prose prefix is KEPT: the renderer strips a
 *  leading '<siteName> · ' when both are present, so the site is printed once
 *  either way, and a renderer that only knows `meta` still says where.
 *
 *  Rows 1 and 5 stay field-less on purpose, and that is the honest reading of
 *  what they say: 'classic.central' is a plane endpoint and 'GreenLake' is the
 *  workspace, neither is a site the portal has an inventory row for. They also
 *  keep the demo exercising the no-site branch that live rows take whenever
 *  the alert cannot be mapped (siteName omitted, never blank). */
export const OVERVIEW_ALERTS: OverviewAlert[] = [
  { sev: 'P1', tone: 'danger', title: 'Central Classic sync stalled — inventory 6h stale', meta: 'classic.central · api 429 rate-limited', plane: 'CLASSIC', age: '6h', device: 'sw-acc-3f-2' },
  { sev: 'P1', tone: 'danger', title: 'mm-lake-1 lost heartbeat from 3 local controllers', meta: 'Lakeshore Medical Center · AOS-8 cluster', siteName: 'Lakeshore Medical Center', siteId: 'lakeshore', plane: 'AOS-8', age: '41m', device: 'mm-lake-1' },
  { sev: 'P2', tone: 'warning', title: 'Wi-Fi drops, 3rd floor east — 22 clients affected', meta: 'Campus-02 Research · ap-3f-12, ap-3f-14', siteName: 'Campus-02 Research', siteId: 'campus-02', plane: 'MIST', age: '2h', device: 'ap-3f-12' },
  { sev: 'P2', tone: 'warning', title: 'sw-core-a PSU 2 absent, running on single supply', meta: 'Campus-01 · CX 8325 · local SSH', siteName: 'Campus-01', siteId: 'campus-01', plane: 'LOCAL', age: '3h', device: 'sw-core-a' },
  { sev: 'P3', tone: 'info', title: '34 AP subscriptions expire within 60 days', meta: 'GreenLake · Foundation AP licences', plane: 'GREENLAKE', age: '1d', device: 'sw-core-a' },
];

/** Sites table — NT_SITES (6 rows). */
export const OVERVIEW_SITES: OverviewSiteRow[] = [
  { name: 'Campus-01 — Meridian HQ', siteId: 'campus-01', plane: 'Central · local', devices: 148, clients: '1,904', health: '98%', healthPct: '98%', tone: 'ok', alerts: '2 open', alertTone: 'warning' },
  { name: 'Campus-02 Research', siteId: 'campus-02', plane: 'Mist', devices: 96, clients: '1,212', health: '94%', healthPct: '94%', tone: 'ok', alerts: '1 open', alertTone: 'warning' },
  { name: 'Lakeshore Medical Center', siteId: 'lakeshore', plane: 'AOS-8', devices: 62, clients: '744', health: '81%', healthPct: '81%', tone: 'warn', alerts: '3 open', alertTone: 'danger' },
  { name: 'Riverside Clinic', siteId: 'riverside', plane: 'Central Classic', devices: 24, clients: '188', health: null, healthPct: '0%', tone: 'stale', alerts: 'stale', alertTone: 'neutral' },
  { name: 'Warehouse-DC1', siteId: 'warehouse-dc1', plane: 'Local only', devices: 18, clients: '96', health: '100%', healthPct: '100%', tone: 'ok', alerts: 'clear', alertTone: 'success' },
  { name: 'Airport Annex', siteId: 'airport-annex', plane: 'AOS-8 · local', devices: 21, clients: '132', health: '96%', healthPct: '96%', tone: 'ok', alerts: 'clear', alertTone: 'success' },
];

/** Management planes — NT_PLANES (7 rows). */
export const OVERVIEW_PLANES: OverviewPlaneRow[] = [
  { name: 'HPE Aruba Central', scope: 'new · 3 sites', state: 'healthy', tone: 'success', sync: '40s', linked: true },
  { name: 'Mist', scope: 'cloud · 3 sites', state: 'healthy', tone: 'success', sync: '1m', linked: true },
  { name: 'Central Classic', scope: 'legacy · 2 sites', state: 'degraded', tone: 'danger', sync: '6h', linked: true },
  { name: 'GreenLake', scope: 'workspace · licences', state: 'healthy', tone: 'success', sync: '4m', linked: true },
  { name: 'AOS-8 master', scope: 'mm-lake-1 · on-prem', state: 'warning', tone: 'warning', sync: '2m', linked: true },
  { name: 'Local switch collector', scope: 'ssh · 96 switches', state: 'healthy', tone: 'success', sync: '30s', linked: true },
  { name: 'ClearPass', scope: 'cppm-01 · policy', state: 'healthy', tone: 'success', sync: '55s', linked: true },
];

/** Change log — NT_CHANGES (4 rows). */
export const OVERVIEW_CHANGES: ChangeLogEntry[] = [
  { time: '09:22', text: 'vlan 812 added to sw-acc-3f-2, sw-acc-3f-3', who: 'r.okafor · local ssh' },
  { time: '08:47', text: 'WLAN "MRDN-Guest" PSK rotated at Campus-02', who: 'automation · mist api' },
  { time: '07:15', text: 'AOS-10 gateway cluster failover test, Campus-01', who: 'j.alvarez · central' },
  { time: 'Yest.', text: '12 CX switches upgraded to 10.13.1005', who: 'r.okafor · orchestrated' },
];

/** Launchpad — the `launch` array in renderVals (5 rows). */
export const OVERVIEW_LAUNCHPAD: LaunchpadRow[] = [
  { label: 'Open Central — Campus-01', hint: 'sso ↗', target: { type: 'view', view: 'systems' } },
  { label: 'Open Mist — Campus-02 org', hint: 'sso ↗', target: { type: 'view', view: 'systems' } },
  { label: 'SSH to sw-core-a', hint: 'terminal', target: { type: 'device', device: 'sw-core-a' } },
  { label: 'Run compliance scan', hint: 'all sites', target: { type: 'view', view: 'compliance' } },
  { label: 'Reconcile licences with GreenLake', hint: 'report', target: { type: 'view', view: 'licenses' } },
];

// ---------------------------------------------------------------------------
// Alerts — NtAlerts.dc.html (the `data` array, 12 rows, plus repeat firings
// of the tunnel-flap and DHCP-pool alerts so the demo queue exercises
// fingerprint grouping — a flapping alert is exactly what dedup is for)
// ---------------------------------------------------------------------------

export const ALERTS: AlertRow[] = [
  { sev: 'P1', tone: 'danger', title: 'Riverside Clinic offline — WAN down', detail: 'wan1 down 12m · lte failover did not engage', siteId: 'riverside', siteName: 'Riverside Clinic', plane: 'CLASSIC', state: 'open', age: '12m', device: 'sw-core-a' },
  { sev: 'P1', tone: 'danger', title: 'mm-lake-1 lost heartbeat from 3 controllers', detail: 'mc-lake-2, mc-lake-3, mc-lake-4 · cluster degraded', siteId: 'lakeshore', siteName: 'Lakeshore Medical', plane: 'AOS-8', state: 'open', age: '41m', device: 'mm-lake-1' },
  { sev: 'P1', tone: 'danger', title: 'Central Classic sync stalled — inventory 6h stale', detail: 'api 429 rate-limited · 24 devices unverified', siteId: 'riverside', siteName: 'Riverside Clinic', plane: 'CLASSIC', state: 'open', age: '6h', device: 'sw-core-a' },
  { sev: 'P2', tone: 'warning', title: 'DHCP pool 92% used on vlan 812', detail: 'scope 10.42.12.0/23 · 1,842 of 2,046 leases', siteId: 'campus-01', siteName: 'Campus-01 HQ', plane: 'CENTRAL', state: 'open', age: '20m', device: 'sw-core-a' },
  { sev: 'P2', tone: 'warning', title: 'DHCP pool 92% used on vlan 812', detail: 'scope 10.42.12.0/23 · 1,901 of 2,046 leases', siteId: 'campus-01', siteName: 'Campus-01 HQ', plane: 'CENTRAL', state: 'open', age: '9m', device: 'sw-core-a' },
  { sev: 'P2', tone: 'warning', title: 'gw-edge-1 tunnel flap ×14 in an hour', detail: 'ipsec to dc1 · mtu blackhole suspected', siteId: 'campus-01', siteName: 'Campus-01 HQ', plane: 'AOS-10', state: 'open', age: '55m', device: 'gw-edge-1' },
  { sev: 'P2', tone: 'warning', title: 'gw-edge-1 tunnel flap ×14 in an hour', detail: 'ipsec to dc1 · rekey collision on iked restart', siteId: 'campus-01', siteName: 'Campus-01 HQ', plane: 'AOS-10', state: 'open', age: '38m', device: 'gw-edge-1' },
  { sev: 'P2', tone: 'warning', title: 'gw-edge-1 tunnel flap ×14 in an hour', detail: 'ipsec to dc1 · ddos guard throttled ike', siteId: 'campus-01', siteName: 'Campus-01 HQ', plane: 'AOS-10', state: 'open', age: '12m', device: 'gw-edge-1' },
  { sev: 'P2', tone: 'warning', title: 'Wi-Fi drops, 3rd floor east — 22 clients', detail: 'ap-3f-12, ap-3f-14 · dfs radar events on 5GHz', siteId: 'campus-02', siteName: 'Campus-02 Research', plane: 'MIST', state: 'acked', age: '2h', device: 'ap-3f-12' },
  { sev: 'P2', tone: 'warning', title: 'sw-core-a PSU 2 absent — single supply', detail: 'chassis CX 8325 · psu2 removed 03:12', siteId: 'campus-01', siteName: 'Campus-01 HQ', plane: 'LOCAL', state: 'open', age: '3h', device: 'sw-core-a' },
  { sev: 'P2', tone: 'warning', title: 'uxi-cam01-2 sensor offline', detail: 'last test 04:50 · poe port 1/1/22 down', siteId: 'campus-01', siteName: 'Campus-01 HQ', plane: 'UXI', state: 'open', age: '5h', device: 'sw-acc-3f-2' },
  { sev: 'P3', tone: 'info', title: '34 AP subscriptions expire within 60 days', detail: 'greenlake workspace · foundation ap tier', siteId: 'workspace', siteName: 'Workspace', plane: 'GREENLAKE', state: 'open', age: '1d', device: 'sw-core-a' },
  { sev: 'P3', tone: 'info', title: 'cppm-01 server certificate expires in 21 days', detail: 'radsec · issued by internal-ca', siteId: 'core-services', siteName: 'Core services', plane: 'CLEARPASS', state: 'acked', age: '2d', device: 'cppm-01' },
  { sev: 'P3', tone: 'info', title: '6 CX switches still on 10.11 firmware', detail: 'target 10.13.1005 · maintenance window Sat 02:00', siteId: 'multiple', siteName: 'Multiple', plane: 'LOCAL', state: 'open', age: '3d', device: 'sw-acc-3f-2' },
  { sev: 'P3', tone: 'info', title: 'Meraki MX uplink loss (third-party probe)', detail: 'read-only integration · 2m outage', siteId: 'southpoint', siteName: 'Southpoint Clinic', plane: 'THIRD-PARTY', state: 'acked', age: '4h', device: 'sw-core-a' },
];

// ---------------------------------------------------------------------------
// Tickets — NtTickets.dc.html (the `tickets` array, 5 rows)
// ---------------------------------------------------------------------------

export const TICKETS: TicketRow[] = [
  {
    id: 'NET-4188', pri: 'P2', tone: 'warning', state: 'in progress', title: 'Wi-Fi drops, 3rd floor east ward', siteId: 'campus-02', siteName: 'Campus-02 Research', age: '2h', reporter: 'Ward 3E station', owner: 'R. Okafor', planes: 'Mist · ClearPass · local', sla: 'SLA breach in 1h 12m', inc: '21', causeTitle: 'Likely cause: DFS radar events forcing channel changes',
    cause: 'Both APs left channel 116 within 40 seconds of each other, and clients that failed to roam were re-authenticated by ClearPass. The switch ports show no errors, so this is radio, not wiring.', action1: 'Pin channels on ap-3f-12/14', action2: 'Open in Mist', action3: 'Compare to Campus-01 RF profile',
    evidence: [
      { time: '07:41', plane: 'MIST', finding: 'ap-3f-12 left channel 116 after DFS radar detect; 22 clients reconnected', raw: 'event=DFS_RADAR band=5 ch=116 → 36', device: 'ap-3f-12' },
      { time: '07:41', plane: 'MIST', finding: 'ap-3f-14 followed 38s later — same radar signature', raw: 'event=DFS_RADAR band=5 ch=116 → 44', device: 'ap-3f-14' },
      { time: '07:42', plane: 'CLEARPASS', finding: '14 re-authentications from the same MAC block, all successful', raw: 'auth=MAB+802.1X result=ACCEPT count=14', device: 'cppm-01' },
      { time: '07:43', plane: 'LOCAL SSH', finding: 'Uplink ports on sw-acc-3f-2 clean — no CRC errors, PoE steady', raw: 'show interface 1/1/14 · errors 0 · poe 22.1W', device: 'sw-acc-3f-2' },
      { time: '07:55', plane: 'UXI', finding: 'Sensor test passed on 2.4GHz, failed twice on 5GHz', raw: 'wifi-5 assoc timeout 2/6 tests', device: null },
    ],
  },
  {
    id: 'NET-4173', pri: 'P1', tone: 'danger', state: 'open', title: 'Central Classic sync stalled, inventory stale', siteId: 'riverside', siteName: 'Riverside Clinic', age: '6h', reporter: 'Portal watchdog', owner: 'Unassigned', planes: 'Central Classic · local', sla: 'SLA breach in 24m', inc: '18', causeTitle: 'Likely cause: API rate limit on the Classic tenant',
    cause: 'The Classic collector is being 429-throttled every third poll, so 24 devices at Riverside have not reported for six hours. Local SSH still reaches them, so treat Classic state as unverified until the backfill completes.', action1: 'Re-key Classic API token', action2: 'Force full backfill', action3: 'Verify 24 devices over SSH',
    evidence: [
      { time: '03:12', plane: 'CLASSIC', finding: 'Poll rejected — HTTP 429, retry-after 600s', raw: 'GET /monitoring/v1/switches → 429', device: null },
      { time: '03:12', plane: 'PORTAL', finding: 'Collector backed off to a 10-minute interval; queue depth now 41', raw: 'backoff=600s queue=41', device: null },
      { time: '06:40', plane: 'LOCAL SSH', finding: '24 Riverside devices answered directly — all up, config unchanged', raw: 'ssh probe 24/24 ok', device: 'sw-core-a' },
      { time: '09:05', plane: 'GREENLAKE', finding: 'Tenant shows two API clients sharing one token quota', raw: 'clients=portal-collector, legacy-scripts', device: null },
    ],
  },
  {
    id: 'NET-4166', pri: 'P2', tone: 'warning', state: 'waiting', title: 'Guest onboarding fails intermittently', siteId: 'campus-01', siteName: 'Campus-01 HQ', age: '1d', reporter: 'Front desk', owner: 'J. Alvarez', planes: 'Central · ClearPass', sla: 'SLA breach in 6h', inc: '09', causeTitle: 'Likely cause: guest VLAN DHCP exhaustion',
    cause: 'Failures cluster when the vlan 812 scope passes 90% utilisation. Onboarding succeeds on retry, which points at leases rather than policy.', action1: 'Widen vlan 812 scope', action2: 'Open in Central', action3: 'Shorten guest lease to 2h',
    evidence: [
      { time: '11:20', plane: 'CENTRAL', finding: 'DHCP scope 10.42.12.0/23 at 92% — 1,842 of 2,046 leases', raw: 'scope=guest-812 used=92%', device: 'sw-core-a' },
      { time: '11:21', plane: 'CLEARPASS', finding: 'Guest policy applied correctly on every attempt', raw: 'role=guest result=ACCEPT', device: 'cppm-01' },
      { time: '11:44', plane: 'LOCAL SSH', finding: 'sw-core-a relay counters show 61 discovers unanswered', raw: 'show dhcp-relay statistics', device: 'sw-core-a' },
    ],
  },
  {
    id: 'NET-4152', pri: 'P3', tone: 'info', state: 'open', title: 'Stack member 3 missing after reboot', siteId: 'warehouse-dc1', siteName: 'Warehouse-DC1', age: '3d', reporter: 'R. Okafor', owner: 'R. Okafor', planes: 'local only', sla: 'No SLA — planned', inc: '02', causeTitle: 'Likely cause: stacking cable seated on the wrong port',
    cause: 'This site has no cloud plane at all, so everything here comes from the local collector over SSH. Member 3 never rejoined after the 02:00 reboot.', action1: 'SSH to sw-wh1-1', action2: 'Show stack topology', action3: 'Schedule on-site check',
    evidence: [
      { time: '02:03', plane: 'LOCAL SSH', finding: 'Stack reports 2 of 3 members after reload', raw: 'show stack · member 3 missing', device: 'sw-core-a' },
      { time: '02:04', plane: 'PORTAL', finding: 'Collector flagged an inventory delta at Warehouse-DC1', raw: 'delta=-1 device', device: null },
    ],
  },
  {
    id: 'NET-4149', pri: 'P2', tone: 'success', state: 'resolved', title: 'AOS-8 AP tunnel resets after upgrade', siteId: 'lakeshore', siteName: 'Lakeshore Medical', age: '5d', reporter: 'Ops', owner: 'J. Alvarez', planes: 'AOS-8', sla: 'Closed', inc: '77', causeTitle: 'Resolved: MTU corrected on the controller uplink',
    cause: 'Tunnel MTU was left at 1500 after the upgrade; setting it to 1400 stopped the resets. Kept here as the reference fix for the other two clusters.', action1: 'Apply fix to mc-lake-3', action2: 'Open in AOS-8', action3: 'Add to compliance baseline',
    evidence: [
      { time: 'Mon', plane: 'AOS-8', finding: 'GRE tunnels reset every 90s on mc-lake-2', raw: 'tunnel 12 flap count=48', device: 'mm-lake-1' },
      { time: 'Mon', plane: 'LOCAL SSH', finding: 'Path MTU to controller measured at 1400', raw: 'ping df-bit size 1472 → fail', device: null },
    ],
  },
];

// ---------------------------------------------------------------------------
// Clients — NtClients.dc.html
// ---------------------------------------------------------------------------

/** Stat row, from the markup (5 stats). */
export const CLIENT_STATS: StatDef[] = [
  { label: 'Clients now', value: '4,982', delta: '▲ 214 since 08:00', tone: 'neutral' },
  { label: 'Wireless', value: '4,410', delta: '88% of sessions', tone: 'neutral' },
  { label: 'Wired', value: '572', delta: 'incl. 148 medical', tone: 'neutral' },
  { label: 'Failing auth', value: '24', delta: '▲ 9 in the last hour', tone: 'negative' },
  { label: 'Poor experience', value: '61', delta: 'rssi under −72dBm', tone: 'negative' },
];

/** AP → access-switch uplink wiring — NT_AP_UPLINK (7 entries). */
export const AP_UPLINK: ApUplinkMap = {
  'ap-3f-12': 'sw-acc-3f-2',
  'ap-3f-14': 'sw-acc-3f-2',
  'ap-3f-08': 'sw-acc-3f-3',
  'ap-1f-04': 'sw-acc-1f-1',
  'ap-ng-02': 'sw-ng-1',
  'ap-t1-12': 'sw-lake-1',
  'ap-t2-04': 'sw-lake-1',
};

/** Campus-01 chain, also the pathFor() fallback — NT_SITE_CHAIN['Campus-01 HQ']. */
export const FALLBACK_CHAIN: SiteChain = {
  core: 'sw-core-a', coreRole: 'core · CX 8325 VSX pair', coreState: 'degraded', coreTone: 'warning',
  gw: 'gw-edge-1', gwRole: 'edge gateway · AOS-10', gwState: 'flapping', gwTone: 'warning',
  wan: '2 × 10G to DC1 · rtt 3 ms', exit: 'DC1 border', exitRole: 'firewall + internet break-out',
};

/** Per-site forwarding chains — NT_SITE_CHAIN (6 entries), keyed by canonical
 *  siteId (the prototype keys by display name; gw fields null when absent). */
export const SITE_CHAIN: Partial<Record<SiteId, SiteChain>> = {
  'campus-01': FALLBACK_CHAIN,
  'campus-02': {
    core: 'sw-cam02-1', coreRole: 'core · EX4400 virtual chassis', coreState: 'up', coreTone: 'success',
    gw: 'gw-edge-1', gwRole: 'edge gateway · AOS-10', gwState: 'flapping', gwTone: 'warning',
    wan: '10G to Campus-01 · rtt 1 ms', exit: 'DC1 border', exitRole: 'firewall + internet break-out',
  },
  lakeshore: {
    core: 'sw-lake-1', coreRole: 'core · CX 6400', coreState: 'up', coreTone: 'success',
    gw: null, gwRole: null, gwState: null, gwTone: null,
    wan: '1G primary + diverse fibre · rtt 6 ms', exit: 'DC1 border', exitRole: 'firewall + internet break-out',
  },
  northgate: {
    core: 'sw-ng-1', coreRole: 'core · EX4100', coreState: 'up', coreTone: 'success',
    gw: null, gwRole: null, gwState: null, gwTone: null,
    wan: '500M broadband · rtt 11 ms', exit: 'Internet', exitRole: 'local break-out',
  },
  'warehouse-dc1': {
    core: 'sw-wh1-1', coreRole: 'stack master · CX 6300', coreState: 'up', coreTone: 'success',
    gw: null, gwRole: null, gwState: null, gwTone: null,
    wan: '1G to DC1 · rtt 4 ms', exit: 'DC1 border', exitRole: 'firewall + internet break-out',
  },
  'remote-vpn': {
    core: 'sw-core-a', coreRole: 'core · CX 8325 VSX pair', coreState: 'degraded', coreTone: 'warning',
    gw: 'gw-edge-1', gwRole: 'VPN concentrator · AOS-10', gwState: 'flapping', gwTone: 'warning',
    wan: '2 × 10G to DC1 · rtt 3 ms', exit: 'DC1 border', exitRole: 'firewall + internet break-out',
  },
};

/**
 * Cross-site and fabric neighbour reports — the demo world's answer to what
 * the planes would report at poll time for the estate-level topology graph
 * (shared/topologyGraph.ts). Not from the prototypes: authored to agree with
 * the authored estate (SITE_CHAIN's WAN words, DEVICES' rows and states), one
 * row per PLANE report, so a link two planes report exercises the same merge
 * as a live estate. The story they tell:
 *
 *  - the Campus-01 CX fabric (VSX pair + the two access switches), read by
 *    the local collector over SSH ('show lldp neighbors');
 *  - Campus-01 ↔ Campus-02 ('10G to Campus-01'), reported by BOTH ends' planes
 *    — the collector read it on sw-core-a, Mist read it on sw-cam02-1 — so the
 *    merged edge carries two badges;
 *  - Lakeshore's 1G primary landing on the VSX secondary (sw-core-b);
 *  - the 2 × 10G DC1 handoff as TWO parallel links on distinct port pairs;
 *  - Northgate's broadband CPE and Riverside's ISP handoff as ghosts (named
 *    by a plane, managed by none) — Riverside's riding Classic's CDP report,
 *    flagged stale because Classic is six hours behind;
 *  - the Warehouse-DC1 VSF stack link to member 3, which never rejoined after
 *    the 02:00 reboot (its state word stays 'missing' on the card).
 *
 * Stamps are the fixed demo instant (DEMO_TOPOLOGY_STAMP's own value, kept a
 * literal here the way the SLE fixtures carry theirs) so the demo graph is
 * byte-identical on every read; staleness is an explicit flag, not a clock.
 */
export const TOPOLOGY_EDGE_REPORTS: TopologyEdgeReportInput[] = [
  // -- Campus-01 fabric, the local collector's LLDP reads -------------------
  { plane: 'LOCAL', protocol: 'LLDP', from: { name: 'sw-core-a', port: '1/1/51' }, to: { name: 'sw-core-b', port: '1/1/51' }, speedBps: 25_000_000_000, reportedAt: '2026-07-26T11:59:00.000Z' },
  { plane: 'LOCAL', protocol: 'LLDP', from: { name: 'sw-acc-3f-2', port: '1/1/49' }, to: { name: 'sw-core-a', port: '1/1/13' }, speedBps: 10_000_000_000, reportedAt: '2026-07-26T11:59:00.000Z' },
  { plane: 'LOCAL', protocol: 'LLDP', from: { name: 'sw-acc-3f-3', port: '1/1/49' }, to: { name: 'sw-core-b', port: '1/1/14' }, speedBps: 10_000_000_000, reportedAt: '2026-07-26T11:59:00.000Z' },
  // -- Campus-01 ↔ Campus-02, reported from BOTH ends -----------------------
  { plane: 'LOCAL', protocol: 'LLDP', from: { name: 'sw-core-a', port: '1/1/49' }, to: { name: 'sw-cam02-1', port: 'xe-0/1/0' }, speedBps: 10_000_000_000, reportedAt: '2026-07-26T11:59:00.000Z' },
  { plane: 'MIST', protocol: 'LLDP', from: { name: 'sw-cam02-1', port: 'xe-0/1/0' }, to: { name: 'sw-core-a', port: '1/1/49' }, speedBps: 10_000_000_000, reportedAt: '2026-07-26T11:59:00.000Z' },
  // -- Lakeshore's 1G primary, on the VSX secondary -------------------------
  { plane: 'LOCAL', protocol: 'LLDP', from: { name: 'sw-lake-1', port: '1/1/49' }, to: { name: 'sw-core-b', port: '1/1/49' }, speedBps: 1_000_000_000, reportedAt: '2026-07-26T11:59:00.000Z' },
  // -- The 2 × 10G DC1 handoff: two parallel links, distinct port pairs -----
  { plane: 'LOCAL', protocol: 'LLDP', from: { name: 'gw-edge-1', port: '1/1/1' }, to: { name: 'sw-wh1-1', port: '1/1/1' }, speedBps: 10_000_000_000, reportedAt: '2026-07-26T11:59:00.000Z' },
  { plane: 'LOCAL', protocol: 'LLDP', from: { name: 'gw-edge-1', port: '1/1/2' }, to: { name: 'sw-wh1-1', port: '1/1/2' }, speedBps: 10_000_000_000, reportedAt: '2026-07-26T11:59:00.000Z' },
  // -- Northgate's broadband CPE: heard via LLDP, managed by nobody ---------
  { plane: 'MIST', protocol: 'LLDP', from: { name: 'sw-ng-1', port: 'ge-0/0/0' }, to: { name: 'broadband-cpe-ng', port: 'wan1' }, speedBps: 1_000_000_000, reportedAt: '2026-07-26T11:59:00.000Z' },
  // -- Riverside's ISP handoff: Classic's CDP report, six hours stale -------
  { plane: 'CLASSIC', protocol: 'CDP', from: { name: 'sw-riv-1', port: '1/1/52' }, to: { name: 'isp-cpe-riv', port: 'gi0/0' }, speedBps: 1_000_000_000, reportedAt: '2026-07-26T11:59:00.000Z', stale: true },
  // -- Warehouse-DC1's VSF stack link to the member that never rejoined -----
  { plane: 'LOCAL', protocol: 'VSF', from: { name: 'sw-wh1-1', port: '1/1/27' }, to: { name: 'sw-wh1-3', port: '1/1/27' }, reportedAt: '2026-07-26T11:59:00.000Z' },
];

/** Client sessions — the `clients` array (16 rows). Fixture `kind` → model. */
export const CLIENTS: ClientRow[] = [
  { name: 'm.okonjo', model: 'iPad Pro', type: 'tablet', group: 'clinical-floors', mac: '3c:22:fb:41:0a:19', ip: '10.44.12.88', attach: 'ap-3f-12', where: '3F east · ward 3E', plane: 'MIST', planeTone: 'info', auth: '802.1X', authBy: 'clearpass', role: 'Clinical staff', vlan: 'vlan 820', health: 'good', healthTone: 'success', session: '2h 14m', medium: 'wireless', siteId: 'campus-02', siteName: 'Campus-02 Research', problem: false, link: '5 GHz · ch 36 · 40 MHz', rssi: '−52 dBm', snr: '41 dB', retries: '2.1%', tput: '866 Mbps', roams: '3', quality: 94, zone: 'Tower A · 3rd floor east · bed bay 12', closet: 'IDF-3F-A · sw-acc-3f-2 port 1/1/14', x: 362, y: 268, mapId: 'map-cam02-3f' },
  { name: 'infusion-4A-12', model: 'Infusion pump', type: 'medical', group: 'medical-wired', mac: '00:1b:c5:09:7f:22', ip: '10.42.30.44', attach: 'sw-acc-3f-2', where: 'port 1/1/20', plane: 'LOCAL', planeTone: 'neutral', auth: 'MAB', authBy: 'clearpass', role: 'Medical device', vlan: 'vlan 820', health: 'good', healthTone: 'success', session: '41d', medium: 'wired', siteId: 'campus-01', siteName: 'Campus-01 HQ', problem: false, link: '1 Gb full duplex', rssi: '—', snr: '—', retries: '0.0%', tput: '4 Mbps', roams: '0', quality: 99, zone: 'Tower A · 4th floor · room 4A-12', closet: 'IDF-3F-A · port 1/1/20 · poe 6.1 W' },
  { name: 'j.alvarez', model: 'MacBook Pro', type: 'laptop', group: 'staff-wireless', mac: '8c:85:90:22:d1:04', ip: '10.42.14.19', attach: 'ap-3f-08', where: 'ward 3E · nurse station', plane: 'CENTRAL', planeTone: 'accent', auth: 'EAP-TLS', authBy: 'clearpass', role: 'IT admin', vlan: 'vlan 810', health: 'good', healthTone: 'success', session: '5h 02m', medium: 'wireless', siteId: 'campus-01', siteName: 'Campus-01 HQ', problem: false, link: '6 GHz · ch 37 · 80 MHz', rssi: '−48 dBm', snr: '45 dB', retries: '1.2%', tput: '1.2 Gbps', roams: '1', quality: 97, zone: 'Tower A · 3rd floor · nurse station', closet: 'IDF-3F-B · sw-acc-3f-3 port 1/1/9' },
  { name: 'guest-4471', model: 'Android phone', type: 'phone', group: 'guest-lobby', mac: 'f0:18:98:5c:11:73', ip: '10.42.12.208', attach: 'ap-1f-04', where: 'lobby · reception', plane: 'CENTRAL', planeTone: 'accent', auth: 'PSK + portal', authBy: 'clearpass guest', role: 'Guest', vlan: 'vlan 812', health: 'weak signal', healthTone: 'warning', session: '18m', medium: 'wireless', siteId: 'campus-01', siteName: 'Campus-01 HQ', problem: true, link: '5 GHz · ch 44 · 20 MHz', rssi: '−74 dBm', snr: '18 dB', retries: '14.8%', tput: '117 Mbps', roams: '0', quality: 46, zone: 'Ground floor · lobby, far corner by the café', closet: 'IDF-1F-A · sw-acc-1f-1 port 1/1/4' },
  { name: 'xray-cart-2', model: 'Imaging cart', type: 'imaging', group: 'lakeshore-medical', mac: '00:0c:29:7a:41:88', ip: '10.48.30.12', attach: 'ap-t1-12', where: 'tower 1 · corridor', plane: 'AOS-8', planeTone: 'accent', auth: '802.1X', authBy: 'controller', role: 'Medical device', vlan: 'vlan 848', health: 'roaming', healthTone: 'warning', session: '1h 09m', medium: 'wireless', siteId: 'lakeshore', siteName: 'Lakeshore Medical', problem: true, link: '5 GHz · ch 60 · 40 MHz', rssi: '−69 dBm', snr: '24 dB', retries: '9.4%', tput: '400 Mbps', roams: '14', quality: 61, zone: 'Tower 1 · moving between floors 2 and 3', closet: 'MDF-T1 · sw-lake-1 port 1/2/11' },
  { name: 'voip-3f-114', model: 'Desk handset', type: 'voip', group: 'voice-wired', mac: '00:04:f2:aa:19:60', ip: '10.42.16.114', attach: 'sw-acc-3f-3', where: 'port 1/1/14', plane: 'LOCAL', planeTone: 'neutral', auth: '802.1X', authBy: 'clearpass', role: 'Voice', vlan: 'vlan 816', health: 'good', healthTone: 'success', session: '12d', medium: 'wired', siteId: 'campus-01', siteName: 'Campus-01 HQ', problem: false, link: '1 Gb full duplex · lldp-med', rssi: '—', snr: '—', retries: '0.0%', tput: '128 kbps', roams: '0', quality: 98, zone: 'Tower A · 3rd floor · desk 114', closet: 'IDF-3F-B · port 1/1/14 · poe 4.4 W' },
  { name: 'r.okafor', model: 'ThinkPad X1', type: 'laptop', group: 'staff-wireless', mac: '54:e1:ad:03:77:c1', ip: '10.42.14.61', attach: 'ap-1f-04', where: 'lobby · hot desk', plane: 'CENTRAL', planeTone: 'accent', auth: 'EAP-TLS', authBy: 'clearpass', role: 'IT admin', vlan: 'vlan 810', health: 'good', healthTone: 'success', session: '3h 44m', medium: 'wireless', siteId: 'campus-01', siteName: 'Campus-01 HQ', problem: false, link: '5 GHz · ch 36 · 80 MHz', rssi: '−55 dBm', snr: '38 dB', retries: '2.8%', tput: '866 Mbps', roams: '2', quality: 92, zone: 'Ground floor · lobby hot desks', closet: 'IDF-1F-A · sw-acc-1f-1 port 1/1/4' },
  { name: 'ct-scanner-b', model: 'CT scanner', type: 'imaging', group: 'medical-wired', mac: '00:50:56:11:c4:07', ip: '10.48.30.61', attach: 'sw-lake-1', where: 'port 1/3/4', plane: 'LOCAL', planeTone: 'neutral', auth: 'MAB', authBy: 'clearpass', role: 'Medical device', vlan: 'vlan 848', health: 'good', healthTone: 'success', session: '96d', medium: 'wired', siteId: 'lakeshore', siteName: 'Lakeshore Medical', problem: false, link: '1 Gb full duplex', rssi: '—', snr: '—', retries: '0.0%', tput: '210 Mbps', roams: '0', quality: 99, zone: 'Tower 1 · basement · imaging suite 2', closet: 'MDF-T1 · port 1/3/4' },
  { name: 'unknown', model: 'Unrecognised', type: 'unknown', group: 'clinical-floors', mac: '6e:41:0d:99:2b:af', ip: '—', attach: 'ap-3f-14', where: '3F east', plane: 'MIST', planeTone: 'info', auth: '802.1X', authBy: 'reject ×7', role: 'Quarantine', vlan: 'none', health: 'auth failing', healthTone: 'danger', session: '—', medium: 'wireless', siteId: 'campus-02', siteName: 'Campus-02 Research', problem: true, link: '5 GHz · ch 36 · assoc only', rssi: '−61 dBm', snr: '30 dB', retries: '—', tput: '0', roams: '0', quality: 12, zone: 'Tower A · 3rd floor east · unknown position', closet: 'IDF-3F-A · sw-acc-3f-2 port 1/1/16' },
  { name: 's.mehta', model: 'iPhone 16', type: 'phone', group: 'clinical-floors', mac: 'de:ad:0b:14:65:22', ip: '10.44.12.140', attach: 'ap-3f-12', where: '3F east · ward 3E', plane: 'MIST', planeTone: 'info', auth: '802.1X', authBy: 'clearpass', role: 'Clinical staff', vlan: 'vlan 820', health: 'sticky client', healthTone: 'warning', session: '48m', medium: 'wireless', siteId: 'campus-02', siteName: 'Campus-02 Research', problem: true, link: '2.4 GHz · ch 6 · 20 MHz', rssi: '−71 dBm', snr: '21 dB', retries: '11.2%', tput: '144 Mbps', roams: '0', quality: 52, zone: 'Tower A · 3rd floor east · should be on 5 GHz', closet: 'IDF-3F-A · sw-acc-3f-2 port 1/1/14', x: 414, y: 296, mapId: 'map-cam02-3f' },
  { name: 'kiosk-ng-02', model: 'Check-in kiosk', type: 'kiosk', group: 'northgate-public', mac: '00:26:57:03:14:9a', ip: '10.52.4.22', attach: 'ap-ng-02', where: 'reception', plane: 'MIST', planeTone: 'info', auth: 'PSK', authBy: 'local psk', role: 'Kiosk', vlan: 'vlan 830', health: 'good', healthTone: 'success', session: '22d', medium: 'wireless', siteId: 'northgate', siteName: 'Northgate Clinic', problem: false, link: '5 GHz · ch 100 · 40 MHz', rssi: '−58 dBm', snr: '35 dB', retries: '3.1%', tput: '400 Mbps', roams: '0', quality: 90, zone: 'Ground floor · reception, fixed mount', closet: 'Comms cupboard · sw-ng-1 port 1/1/6' },
  { name: 'p.singh', model: 'Surface Laptop', type: 'laptop', group: 'remote-workers', mac: 'a4:83:e7:5f:00:31', ip: '10.70.8.44', attach: 'gw-edge-1', where: 'VIA tunnel · home', plane: 'AOS-10', planeTone: 'accent', auth: 'EAP-TLS', authBy: 'clearpass', role: 'Remote worker', vlan: 'vlan 870', health: 'good', healthTone: 'success', session: '1h 51m', medium: 'wireless', siteId: 'remote-vpn', siteName: 'Remote & VPN users', problem: false, link: 'IPsec · 42 Mbps · rtt 28 ms', rssi: '—', snr: '—', retries: '0.4%', tput: '42 Mbps', roams: '0', quality: 88, zone: 'Off-site · Chicago metro, residential broadband', closet: 'n/a — VPN client' },
  { name: 'printer-2f-04', model: 'Multifunction', type: 'printer', group: 'office-wired', mac: '00:17:c8:20:11:70', ip: '10.42.18.4', attach: 'sw-acc-3f-3', where: 'port 1/1/31', plane: 'LOCAL', planeTone: 'neutral', auth: 'MAB', authBy: 'clearpass', role: 'Printer', vlan: 'vlan 818', health: 'good', healthTone: 'success', session: '61d', medium: 'wired', siteId: 'campus-01', siteName: 'Campus-01 HQ', problem: false, link: '100 Mb full duplex', rssi: '—', snr: '—', retries: '0.0%', tput: '2 Mbps', roams: '0', quality: 97, zone: 'Tower A · 2nd floor · print room', closet: 'IDF-3F-B · port 1/1/31' },
  { name: 'guest-4488', model: 'Windows laptop', type: 'laptop', group: 'guest-lobby', mac: '2c:33:61:8a:04:12', ip: 'pending', attach: 'ap-1f-04', where: 'lobby', plane: 'CENTRAL', planeTone: 'accent', auth: 'PSK + portal', authBy: 'dhcp pending', role: 'Guest', vlan: 'vlan 812', health: 'no address', healthTone: 'danger', session: '3m', medium: 'wireless', siteId: 'campus-01', siteName: 'Campus-01 HQ', problem: true, link: '5 GHz · ch 44 · 40 MHz', rssi: '−63 dBm', snr: '29 dB', retries: '4.0%', tput: '0', roams: '0', quality: 28, zone: 'Ground floor · lobby, seating area', closet: 'IDF-1F-A · sw-acc-1f-1 port 1/1/4' },
  { name: 'a.ferreira', model: 'iPad Air', type: 'tablet', group: 'lakeshore-medical', mac: '9a:11:74:0c:33:81', ip: '10.48.12.19', attach: 'ap-t2-04', where: 'tower 2 · ICU', plane: 'AOS-8', planeTone: 'accent', auth: '802.1X', authBy: 'controller', role: 'Clinical staff', vlan: 'vlan 820', health: 'good', healthTone: 'success', session: '2h 40m', medium: 'wireless', siteId: 'lakeshore', siteName: 'Lakeshore Medical', problem: false, link: '5 GHz · ch 52 · 40 MHz', rssi: '−57 dBm', snr: '36 dB', retries: '2.6%', tput: '866 Mbps', roams: '4', quality: 91, zone: 'Tower 2 · 5th floor · ICU bay 3', closet: 'MDF-T1 · sw-lake-1 port 1/2/14' },
  { name: 'badge-reader-14', model: 'Door controller', type: 'building', group: 'building-systems', mac: '00:1e:c0:44:81:07', ip: '10.60.2.14', attach: 'sw-wh1-1', where: 'port 1/1/9', plane: 'LOCAL', planeTone: 'neutral', auth: 'MAB', authBy: 'local db', role: 'Building system', vlan: 'vlan 860', health: 'good', healthTone: 'success', session: '88d', medium: 'wired', siteId: 'warehouse-dc1', siteName: 'Warehouse-DC1', problem: false, link: '100 Mb full duplex', rssi: '—', snr: '—', retries: '0.0%', tput: '64 kbps', roams: '0', quality: 96, zone: 'Warehouse · dock door 14', closet: 'Dock panel · port 1/1/9 · poe 3.2 W' },
  // The Mist wired roster at Campus-02 — the demo world's answer to the live
  // adapter's /orgs/{org}/wired_clients/search read: a research workstation
  // and a bench instrument on sw-cam02-1, the site the live probe calls the
  // portal's first wired medium.
  { name: 'rsch-ws-07', model: 'Linux workstation', type: 'laptop', group: 'research-wired', mac: '3c:52:82:1e:07:a1', ip: '10.44.22.31', attach: 'sw-cam02-1', where: 'port ge-0/0/8', plane: 'MIST', planeTone: 'info', auth: '802.1X', authBy: 'clearpass', role: 'Research', vlan: 'vlan 822', health: 'good', healthTone: 'success', session: '6d 4h', medium: 'wired', siteId: 'campus-02', siteName: 'Campus-02 Research', problem: false, link: '1 Gb full duplex', rssi: '—', snr: '—', retries: '0.0%', tput: '96 Mbps', roams: '0', quality: 97, zone: 'Tower B · 3rd floor · lab bench 7', closet: 'IDF-3F-C · sw-cam02-1 port ge-0/0/8' },
  { name: 'bench-daq-02', model: 'Data-acquisition unit', type: 'building', group: 'research-wired', mac: '3c:52:82:44:02:19', ip: '10.44.22.44', attach: 'sw-cam02-1', where: 'port ge-0/0/11', plane: 'MIST', planeTone: 'info', auth: 'MAB', authBy: 'clearpass', role: 'Lab instrument', vlan: 'vlan 828', health: 'good', healthTone: 'success', session: '21d', medium: 'wired', siteId: 'campus-02', siteName: 'Campus-02 Research', problem: false, link: '100 Mb full duplex', rssi: '—', snr: '—', retries: '0.0%', tput: '240 kbps', roams: '0', quality: 95, zone: 'Tower B · 3rd floor · instrument rack 2', closet: 'IDF-3F-C · sw-cam02-1 port ge-0/0/11 · poe 5.0 W' },
];

/** Session timelines — the `timelines` map (3 variants). */
export const TIMELINES: Record<TimelineVariant, TimelineStep[]> = {
  default: [
    { time: '07:41', plane: 'MIST', what: 'Association to the access point, 5 GHz', raw: 'assoc rssi=-52 snr=41' },
    { time: '07:41', plane: 'CLEARPASS', what: '802.1X accepted, role applied from AD group', raw: 'service=MRDN-Wireless result=ACCEPT' },
    { time: '07:41', plane: 'CENTRAL', what: 'DHCP lease issued from the site scope', raw: 'lease 8h · relay on the access switch' },
    { time: '08:12', plane: 'MIST', what: 'Roamed to the neighbouring AP and back', raw: 'roam type=11r time=38ms' },
    { time: '08:52', plane: 'UXI', what: 'Sensor on the same AP passed 2.4 GHz, failed 5 GHz twice', raw: 'wifi-5 assoc timeout' },
    { time: '09:38', plane: 'PORTAL', what: 'Session stitched into ticket NET-4188 evidence', raw: 'linked ticket NET-4188' },
  ],
  reject: [
    { time: '09:31', plane: 'MIST', what: 'Association attempt to ap-3f-14', raw: 'assoc rssi=-61' },
    { time: '09:31', plane: 'CLEARPASS', what: '802.1X rejected — certificate not yet valid', raw: 'result=REJECT reason=cert_not_valid_yet' },
    { time: '09:33', plane: 'CLEARPASS', what: 'Six further attempts rejected, moved to Quarantine', raw: 'count=6 role=Quarantine' },
    { time: '09:34', plane: 'PORTAL', what: 'Flagged for review — no matching inventory record', raw: 'unknown MAC block 6e:41:0d' },
  ],
  dhcp: [
    { time: '09:40', plane: 'CENTRAL', what: 'Association to ap-1f-04, guest PSK accepted', raw: 'assoc rssi=-63 ssid=MRDN-Guest' },
    { time: '09:40', plane: 'CLEARPASS', what: 'Guest portal login accepted, role Guest applied', raw: 'service=Guest result=ACCEPT' },
    { time: '09:41', plane: 'LOCAL SSH', what: 'DHCP discover unanswered — scope at 92%', raw: 'relay counters: 61 discovers dropped' },
    { time: '09:43', plane: 'PORTAL', what: 'Correlated with the DHCP pool alert on vlan 812', raw: 'alert id A-2214' },
  ],
};

// ---------------------------------------------------------------------------
// Auth & policy events — NtAuthEvents.dc.html
// ---------------------------------------------------------------------------

/** Stat row, from the markup (5 stats). */
export const AUTH_STATS: StatDef[] = [
  { label: 'Auths / min', value: '412', delta: 'peak 610 at 08:05', tone: 'neutral' },
  { label: 'Accept rate', value: '98.6%', delta: '▲ 0.3% vs. yesterday', tone: 'positive' },
  { label: 'Rejects / hour', value: '24', delta: '▲ 9 — one endpoint', tone: 'negative' },
  { label: 'MAB fallbacks', value: '61', delta: 'medical + printers', tone: 'neutral' },
  { label: 'Known endpoints', value: '4,182', delta: 'of 5,000 licensed', tone: 'neutral' },
];

/** RADIUS decisions — the `events` array (19 rows). m.okonjo's two rows are
 *  deliberate: the Clients drawer's Client 360 panel needs one endpoint with
 *  a PLURAL recent-decisions list, and her second accept matches the roam the
 *  stitched timeline (TIMELINES.default, 08:12) already narrates. */
export const AUTH_EVENTS: AuthEventRow[] = [
  { time: '09:41:22', who: 'm.okonjo', mac: '3c:22:fb:41:0a:19', service: 'MRDN Wireless 802.1X', method: 'EAP-TLS', result: 'accept', tone: 'success', reason: 'Certificate valid, AD group Clinical', role: 'role Clinical staff · vlan 820', nas: 'ap-3f-12', plane: 'MIST' },
  { time: '09:41:04', who: 'infusion-4A-12', mac: '00:1b:c5:09:7f:22', service: 'MRDN Wired MAB', method: 'MAB', result: 'accept', tone: 'success', reason: 'Endpoint profiled as medical pump', role: 'role Medical device · vlan 820', nas: 'sw-acc-3f-2', plane: 'LOCAL' },
  { time: '09:40:51', who: 'unknown', mac: '6e:41:0d:99:2b:af', service: 'MRDN Wireless 802.1X', method: 'EAP-TLS', result: 'reject', tone: 'danger', reason: 'Certificate not yet valid (clock skew)', role: 'role Quarantine', nas: 'ap-3f-14', plane: 'MIST' },
  { time: '09:40:33', who: 'guest-4488', mac: '2c:33:61:8a:04:12', service: 'MRDN Guest Portal', method: 'PSK + portal', result: 'accept', tone: 'success', reason: 'Portal login accepted, sponsor auto-approve', role: 'role Guest · vlan 812', nas: 'ap-1f-04', plane: 'CENTRAL' },
  { time: '09:40:12', who: 'j.alvarez', mac: '8c:85:90:22:d1:04', service: 'MRDN Wireless 802.1X', method: 'EAP-TLS', result: 'accept', tone: 'success', reason: 'AD group IT-Admins, MFA satisfied', role: 'role IT admin · vlan 810', nas: 'ap-3f-08', plane: 'CENTRAL' },
  { time: '09:39:58', who: 'unknown', mac: '6e:41:0d:99:2b:af', service: 'MRDN Wireless 802.1X', method: 'EAP-TLS', result: 'reject', tone: 'danger', reason: 'Repeat failure — 6th attempt in 4 minutes', role: 'role Quarantine', nas: 'ap-3f-14', plane: 'MIST' },
  { time: '09:39:31', who: 'xray-cart-2', mac: '00:0c:29:7a:41:88', service: 'AOS-8 Controller 802.1X', method: 'EAP-PEAP', result: 'accept', tone: 'success', reason: 'Machine auth, controller-terminated', role: 'role Medical device · vlan 848', nas: 'mm-lake-1', plane: 'AOS-8' },
  { time: '09:39:02', who: 'printer-2f-04', mac: '00:17:c8:20:11:70', service: 'MRDN Wired MAB', method: 'MAB', result: 'accept', tone: 'success', reason: 'Static endpoint list', role: 'role Printer · vlan 818', nas: 'sw-acc-3f-3', plane: 'LOCAL' },
  { time: '09:38:44', who: 's.mehta', mac: 'de:ad:0b:14:65:22', service: 'MRDN Wireless 802.1X', method: 'EAP-TLS', result: 'accept', tone: 'success', reason: 'Roamed from ap-3f-14, cached session reused', role: 'role Clinical staff · vlan 820', nas: 'ap-3f-12', plane: 'MIST' },
  { time: '09:38:19', who: 'p.singh', mac: 'a4:83:e7:5f:00:31', service: 'Remote VIA / VPN', method: 'EAP-TLS', result: 'accept', tone: 'success', reason: 'Posture check passed (OnGuard)', role: 'role Remote worker · vlan 870', nas: 'gw-edge-1', plane: 'AOS-10' },
  { time: '09:37:55', who: 'badge-reader-14', mac: '00:1e:c0:44:81:07', service: 'Building Systems MAB', method: 'MAB', result: 'accept', tone: 'success', reason: 'Local endpoint database', role: 'role Building system · vlan 860', nas: 'sw-wh1-1', plane: 'LOCAL' },
  { time: '09:37:12', who: 'lab-laptop-7', mac: '48:2a:e3:11:07:c4', service: 'MRDN Wireless 802.1X', method: 'EAP-PEAP', result: 'reject', tone: 'danger', reason: 'Password expired in Active Directory', role: 'no role assigned', nas: 'ap-ng-02', plane: 'MIST' },
  { time: '09:36:40', who: 'a.ferreira', mac: '9a:11:74:0c:33:81', service: 'AOS-8 Controller 802.1X', method: 'EAP-TLS', result: 'accept', tone: 'success', reason: 'Certificate valid, ICU floor policy', role: 'role Clinical staff · vlan 820', nas: 'mm-lake-1', plane: 'AOS-8' },
  { time: '09:36:02', who: 'voip-3f-114', mac: '00:04:f2:aa:19:60', service: 'MRDN Voice 802.1X', method: 'EAP-MD5', result: 'accept', tone: 'success', reason: 'LLDP-MED voice VLAN assigned', role: 'role Voice · vlan 816', nas: 'sw-acc-3f-3', plane: 'LOCAL' },
  { time: '09:35:41', who: 'ct-scanner-b', mac: '00:50:56:11:c4:07', service: 'MRDN Wired MAB', method: 'MAB', result: 'accept', tone: 'success', reason: 'Profiled as imaging device', role: 'role Medical device · vlan 848', nas: 'sw-lake-1', plane: 'LOCAL' },
  { time: '09:35:08', who: 'guest-4471', mac: 'f0:18:98:5c:11:73', service: 'MRDN Guest Portal', method: 'PSK + portal', result: 'timeout', tone: 'warning', reason: 'Portal page abandoned, retried at 09:36', role: 'role Guest pending', nas: 'ap-1f-04', plane: 'CENTRAL' },
  { time: '09:34:22', who: 'contractor-tab', mac: '7c:2e:bd:44:19:03', service: 'MRDN Wireless 802.1X', method: 'EAP-PEAP', result: 'reject', tone: 'danger', reason: 'Not a member of any authorised group', role: 'role Quarantine', nas: 'ap-1f-04', plane: 'CENTRAL' },
  { time: '09:33:47', who: 'sw-riv-2 uplink', mac: '00:0b:86:41:22:19', service: 'Device Admin (TACACS)', method: 'TACACS+', result: 'accept', tone: 'success', reason: 'Portal collector service account', role: 'role read-only shell', nas: 'sw-riv-1', plane: 'LOCAL' },
  { time: '08:12:03', who: 'm.okonjo', mac: '3c:22:fb:41:0a:19', service: 'MRDN Wireless 802.1X', method: 'EAP-TLS', result: 'accept', tone: 'success', reason: 'Reauthenticated after 11r roam from ap-3f-12, cached session reused', role: 'role Clinical staff · vlan 820', nas: 'ap-3f-08', plane: 'MIST' },
];

/** "Why authentications failed" — the `reasons` array (5 rows, Progress max=60). */
export const AUTH_FAIL_REASONS: FailReasonRow[] = [
  { label: 'Certificate not yet valid', value: 42, note: '42 events · one endpoint with clock skew, 6e:41:0d:99:2b:af' },
  { label: 'Password expired in AD', value: 11, note: '11 events · 4 users, all resolved after reset' },
  { label: 'No authorised group', value: 8, note: '8 events · contractor tablets, expected' },
  { label: 'Portal abandoned', value: 6, note: '6 events · guests who closed the page' },
  { label: 'MAB endpoint unknown', value: 3, note: '3 events · new medical devices awaiting profiling' },
];

/** "Policy services" — the `services` array (6 rows). */
export const POLICY_SERVICES: PolicyServiceRow[] = [
  { name: 'MRDN Wireless 802.1X', detail: 'Central + Mist · EAP-TLS preferred', rate: '8,910', state: 'ok', tone: 'success' },
  { name: 'MRDN Wired 802.1X / MAB', detail: 'CX switches via local collector', rate: '1,204', state: 'ok', tone: 'success' },
  { name: 'MRDN Guest Portal', detail: 'self-registration, sponsor approval', rate: '412', state: 'ok', tone: 'success' },
  { name: 'AOS-8 Controller 802.1X', detail: 'Lakeshore + Airport Annex', rate: '744', state: 'ok', tone: 'success' },
  { name: 'Remote VIA / VPN', detail: 'AOS-10 gateways, OnGuard posture', rate: '368', state: 'ok', tone: 'success' },
  { name: 'Device Admin (TACACS)', detail: 'engineer + portal service accounts', rate: '96', state: 'ok', tone: 'success' },
];

/**
 * ClearPass endpoint repository (demo). 15 rows spanning the categories,
 * statuses and OS families the endpoint table is meant to show — Computer /
 * Phone / Printer / IoT devices, Known / Unknown / Disabled statuses, and
 * Windows / iOS / Android / macOS / Linux operating systems. `insightTags`
 * is Device Insight's free-text categorisation (the profiler's evidence) —
 * present on the rows a profiler would have classified, absent on the
 * unknown/plain ones, and never just a copy of `profile`.
 */
export const CLEARPASS_ENDPOINTS: EndpointRow[] = [
  { id: 'ep-001', mac: '3c:22:fb:41:0a:19', description: 'Ward 3E rounds iPad — Dr. Okonjo', ip: '10.44.12.88', hostname: 'm-okonjo-ipad', status: 'Known', category: 'Phone', family: 'iOS', os: 'iOS 17.5', profile: 'Clinical staff', updatedAt: '2 minutes ago', insightTags: ['Tablet', 'Apple iOS'] },
  { id: 'ep-002', mac: '00:1b:c5:09:7f:22', description: 'Infusion pump, room 4A-12', ip: '10.42.30.44', hostname: 'infusion-4a-12', status: 'Known', category: 'Computer', family: 'Embedded', os: 'RTOS 4.2', profile: 'Medical device', updatedAt: '4 minutes ago', insightTags: ['Medical Device', 'IoT'] },
  { id: 'ep-003', mac: '6e:41:0d:99:2b:af', description: null, ip: null, hostname: null, status: 'Unknown', category: null, family: null, os: null, profile: 'Quarantine', updatedAt: '9 minutes ago' },
  { id: 'ep-004', mac: '2c:33:61:8a:04:12', description: 'Lobby guest laptop — front desk sponsor', ip: '10.42.18.90', hostname: 'guest-4488', status: 'Known', category: 'Computer', family: 'Windows', os: 'Windows 11', profile: 'Guest', updatedAt: '11 minutes ago' },
  { id: 'ep-005', mac: '8c:85:90:22:d1:04', description: 'IT admin — J. Alvarez', ip: '10.42.14.19', hostname: 'j-alvarez-mbp', status: 'Known', category: 'Computer', family: 'macOS', os: 'macOS 14.5 Sonoma', profile: 'IT admin', updatedAt: '12 minutes ago' },
  { id: 'ep-006', mac: '00:0c:29:7a:41:88', description: 'Radiology cart, Lakeshore tower 1', ip: '10.48.10.12', hostname: 'xray-cart-2', status: 'Known', category: 'Computer', family: 'Windows', os: 'Windows 10 IoT', profile: 'Medical device', updatedAt: '18 minutes ago', insightTags: ['Medical Device', 'IoT'] },
  { id: 'ep-007', mac: '00:17:c8:20:11:70', description: '2F print room multifunction', ip: '10.42.18.4', hostname: 'printer-2f-04', status: 'Known', category: 'Printer', family: 'Embedded', os: null, profile: 'Printer', updatedAt: '21 minutes ago', insightTags: ['Office Device', 'IoT'] },
  { id: 'ep-008', mac: 'de:ad:0b:14:65:22', description: 'Clinical iPhone — S. Mehta', ip: '10.44.12.140', hostname: 's-mehta-iphone', status: 'Known', category: 'Phone', family: 'iOS', os: 'iOS 17.4', profile: 'Clinical staff', updatedAt: '24 minutes ago', insightTags: ['Smartphone', 'Apple iOS'] },
  { id: 'ep-009', mac: 'a4:83:e7:5f:00:31', description: 'Remote worker — VIA tunnel', ip: '10.70.8.44', hostname: 'p-singh-surface', status: 'Known', category: 'Computer', family: 'Windows', os: 'Windows 11', profile: 'Remote worker', updatedAt: '29 minutes ago' },
  { id: 'ep-010', mac: '00:1e:c0:44:81:07', description: 'Dock door 14 controller — access revoked', ip: '10.42.60.14', hostname: 'badge-reader-14', status: 'Disabled', category: 'IoT', family: 'Embedded', os: null, profile: 'Building system (revoked)', updatedAt: '1 hour ago', insightTags: ['Building Automation', 'IoT'] },
  { id: 'ep-011', mac: '48:2a:e3:11:07:c4', description: 'Research loaner — AD account locked', ip: null, hostname: 'lab-laptop-7', status: 'Disabled', category: 'Computer', family: 'Windows', os: 'Windows 10', profile: 'Disabled — AD account locked', updatedAt: '2 hours ago' },
  { id: 'ep-012', mac: '9a:11:74:0c:33:81', description: 'ICU tablet — A. Ferreira', ip: '10.48.30.09', hostname: 'a-ferreira-android', status: 'Known', category: 'Phone', family: 'Android', os: 'Android 14', profile: 'Clinical staff', updatedAt: '2 hours ago', insightTags: ['Tablet', 'Android'] },
  { id: 'ep-013', mac: '00:04:f2:aa:19:60', description: 'Desk handset, 3F station 114', ip: '10.42.16.114', hostname: 'voip-3f-114', status: 'Known', category: 'Phone', family: 'Embedded', os: null, profile: 'Voice', updatedAt: '3 hours ago', insightTags: ['VoIP Phone', 'IoT'] },
  { id: 'ep-014', mac: '00:50:56:11:c4:07', description: 'Imaging suite 2 CT scanner', ip: '10.48.30.61', hostname: 'ct-scanner-b', status: 'Known', category: 'Computer', family: 'Windows', os: 'Windows 10 IoT', profile: 'Medical device', updatedAt: '5 hours ago', insightTags: ['Medical Device', 'Imaging'] },
  { id: 'ep-015', mac: 'f0:18:98:5c:11:73', description: null, ip: null, hostname: null, status: 'Unknown', category: null, family: null, os: null, profile: 'Guest pending', updatedAt: '6 hours ago' },
];

/**
 * ClearPass NAD inventory (demo) — the switches RADIUS-authenticating to
 * cppm-01. Names and mgmt IPs match the demo estate's own device rows:
 * sw-core-a (10.42.8.11, the Campus-01 CX 8325 core), its 3F access switch,
 * and the Campus-02 EX4400 that tunnels RadSec to cppm-01 (the trust the
 * 'RadSec certificate expires' alert is about).
 */
export const CLEARPASS_NETWORK_DEVICES: ClearPassNetworkDeviceRow[] = [
  { id: 'nad-001', name: 'sw-core-a', ipAddress: '10.42.8.11', vendorName: 'Aruba', coaCapable: true, radsecEnabled: false, description: 'Campus-01 core · CX 8325 VSX primary' },
  { id: 'nad-002', name: 'sw-acc-3f-2', ipAddress: '10.42.8.32', vendorName: 'Aruba', coaCapable: true, radsecEnabled: false, description: 'Campus-01 IDF-3F-A access · CX 6300' },
  { id: 'nad-003', name: 'sw-cam02-1', ipAddress: '10.44.8.11', vendorName: 'Juniper', coaCapable: true, radsecEnabled: true, description: 'Campus-02 core · EX4400 virtual chassis · RadSec to cppm-01' },
];

/**
 * ClearPass authentication sources (demo) — the AD the auth feed's accept
 * reasons name ('AD group Clinical', 'Password expired in Active
 * Directory') and the local repository the MAB fallback rows use ('Local
 * endpoint database').
 */
export const CLEARPASS_AUTH_SOURCES: ClearPassAuthSourceRow[] = [
  { id: 'as-001', name: 'AD meridian.health', type: 'Active Directory', description: 'dc-01/dc-02 · clinical + staff groups' },
  { id: 'as-002', name: 'Local User Repository', type: 'Local', description: 'cppm-01 local db · service accounts + sponsors' },
];

/**
 * ClearPass roles (demo) — the roles the auth feed applies ('role Clinical
 * staff · vlan 820') and the endpoint repository's profiles echo.
 */
export const CLEARPASS_ROLES: ClearPassRoleRow[] = [
  { id: 'role-001', name: 'Clinical staff', description: 'vlan 820 · clinical apps + internet' },
  { id: 'role-002', name: 'Medical device', description: 'vlan 820/848 · device servers only' },
  { id: 'role-003', name: 'IT admin', description: 'vlan 810 · full management access' },
  { id: 'role-004', name: 'Guest', description: 'vlan 812 · internet only, 8h session' },
  { id: 'role-005', name: 'Voice', description: 'vlan 816 · LLDP-MED handsets' },
  { id: 'role-006', name: 'Printer', description: 'vlan 818 · static endpoint list' },
  { id: 'role-007', name: 'Research', description: 'vlan 822 · lab benches, Campus-02' },
  { id: 'role-008', name: 'Quarantine', description: 'remediation portal only' },
];

/**
 * ClearPass enforcement policies (demo) — the 802.1X and guest pair behind
 * the auth feed's top two services; each policy's default profile is one of
 * CLEARPASS_ENFORCEMENT_PROFILES.
 */
export const CLEARPASS_ENFORCEMENT_POLICIES: ClearPassEnforcementPolicyRow[] = [
  { id: 'epol-001', name: 'MRDN Wireless 802.1X Enforcement', enforcementType: 'RADIUS', defaultProfile: 'Quarantine' },
  { id: 'epol-002', name: 'MRDN Guest Portal Enforcement', enforcementType: 'WEBAUTH', defaultProfile: 'Guest' },
];

/** ClearPass enforcement profiles (demo) — the vlan/ACL answers the two
 *  policies above return. */
export const CLEARPASS_ENFORCEMENT_PROFILES: ClearPassEnforcementProfileRow[] = [
  { id: 'eprof-001', name: 'Clinical staff', type: 'RADIUS', description: 'vlan 820 + clinical ACLs' },
  { id: 'eprof-002', name: 'Guest', type: 'RADIUS', description: 'vlan 812 + internet-only ACL' },
  { id: 'eprof-003', name: 'Quarantine', type: 'RADIUS', description: 'remediation portal only' },
];

/**
 * ClearPass local users (demo) — the portal's own service account (the
 * TACACS row in the auth feed: 'Portal collector service account') and the
 * front-desk guest sponsor. Whitelisted fields only, exactly as the live
 * adapter maps them: no password hash exists in this world either.
 */
export const CLEARPASS_LOCAL_USERS: ClearPassLocalUserRow[] = [
  { id: 'lu-001', userId: 'portal-collector', username: 'Portal Collector Service', roleName: 'read-only shell', enabled: true },
  { id: 'lu-002', userId: 'front-desk-sponsor', username: 'Front Desk Sponsor', roleName: 'Guest Sponsor', enabled: true },
];

/**
 * ClearPass services (demo) — the policy chain's front door, as a 6.11 CPPM
 * answers /api/config/service: the guest 802.1X SSID visitors join, the
 * eduroam pilot for visiting research clinicians (disabled until announced —
 * this world's one honest Disabled service, hit count 0), the wired MAB
 * fallback the pumps and printers ride, and TACACS+ device administration.
 * Auth sources are the two CLEARPASS_AUTH_SOURCES names (eduroam proxies to
 * the home IdP, so it names none); hit counts echo the auth feed's
 * POLICY_SERVICES rates; the NAD IPs in the match rules are the demo NADs'
 * own management addresses. This collection is served in demo — device
 * groups stay the absent one.
 */
export const CLEARPASS_SERVICES: ClearPassServiceRow[] = [
  { id: 'svc-001', name: 'MRDN Guest 802.1X', type: '1X', description: 'guest SSID · sponsor-approved accounts', template: '802.1X Wireless', enabled: true, hitCount: 412, orderNo: 3, authSources: ['Local User Repository'], rulesSummary: 'Radius:Called-Station-Id CONTAINS MRDN-Guest' },
  { id: 'svc-002', name: 'eduroam 802.1X', type: '1X', description: 'visiting research clinicians · pilot, awaiting go-live', template: 'eduroam Wireless', enabled: false, hitCount: 0, orderNo: 11, rulesSummary: 'Radius:Called-Station-Id EQUALS eduroam' },
  { id: 'svc-003', name: 'MRDN Wired MAB', type: 'MAC_AUTH', description: 'medical devices, printers · static endpoint list', template: 'MAC Authentication', enabled: true, hitCount: 1204, orderNo: 5, authSources: ['Local User Repository'], rulesSummary: 'Connection:NAD-IP-Address EQUALS 10.42.8.32' },
  { id: 'svc-004', name: 'Device Admin (TACACS+)', type: 'TACACS', description: 'switch shell · engineers + portal service accounts', template: 'TACACS+ Enforcement', enabled: true, hitCount: 96, orderNo: 8, authSources: ['AD meridian.health', 'Local User Repository'], rulesSummary: 'Connection:NAD-IP-Address EQUALS 10.42.8.11' },
];

/**
 * The full service object behind the Services-tab drawer (demo) — svc-001,
 * the guest 802.1X SSID, as a 6.11 CPPM answers GET /api/config/service/{id}
 * (the verified shape, vocabulary included: the DETAIL object types an 802.1X
 * service 'RADIUS' where the collection row says '1X'). The story is the
 * collection row's own, deepened: the MRDN-Guest called-station match, PEAP
 * against the sponsor-approved local accounts, the guest role mapping and the
 * estate's guest enforcement pair. The other three demo services stay
 * collection rows only — the route 404s their detail, the same honest
 * 'not recorded' the SLE drill fixtures keep. Whitelisted like every other
 * ClearPass fixture: no credential material exists in this world.
 */
export const CLEARPASS_SERVICE_DETAILS: Record<string, ClearPassServiceDetailLive> = {
  'svc-001': {
    service: {
      id: 'svc-001',
      name: 'MRDN Guest 802.1X',
      type: 'RADIUS',
      template: '802.1X Wireless',
      enabled: true,
      hitCount: 412,
      orderNo: 3,
      description: 'guest SSID · sponsor-approved accounts',
      monitorMode: false,
      rulesMatchType: 'MATCHES_ALL',
      rulesConditions: [
        { type: 'Radius', name: 'Called-Station-Id', operator: 'CONTAINS', value: 'MRDN-Guest' },
      ],
      authMethods: ['PEAP', 'MSCHAPv2'],
      authSources: ['Local User Repository'],
      stripUsername: false,
      roleMappingPolicy: 'MRDN Guest Role Mapping',
      enforcementPolicy: 'MRDN Guest Portal Enforcement',
      useCachedPolicyResults: true,
      postureEnabled: false,
      auditEnabled: false,
      profilerEnabled: true,
      acctProxyEnabled: false,
    },
    source: { plane: 'clearpass', at: '2026-07-26T11:59:00.000Z', sections: { service: 'ok' } },
  },
};

// ---------------------------------------------------------------------------
// Sites — NtSites.dc.html
// ---------------------------------------------------------------------------

/** Stat row, from the markup (4 stats). */
export const SITE_STATS: StatDef[] = [
  { label: 'Sites', value: '10', delta: '2 legacy-managed', tone: 'neutral' },
  { label: 'Devices', value: '418', delta: '▲ 12 this month', tone: 'neutral' },
  { label: 'Clients', value: '4,982', delta: 'peak 5,410', tone: 'neutral' },
  { label: 'Sites with alerts', value: '4', delta: '▲ 1 today', tone: 'negative' },
];

/** Site inventory — the `sites` array (10 rows). '3RD-PARTY' → 'THIRD-PARTY';
 *  Riverside health '—' → null (stale inventory). */
export const SITES: SiteRow[] = [
  { id: 'campus-01', name: 'Campus-01 — Meridian HQ', subnet: '10.42.0.0/16', planes: [{ name: 'CENTRAL', tone: 'accent' }, { name: 'LOCAL', tone: 'neutral' }], mix: '96 ap · 42 sw · 6 gw · 4 uxi', devices: 148, clients: '1,904', health: '98%', healthPct: '98%', tone: 'ok', alerts: '4 open', alertTone: 'warning', sync: '40s' },
  { id: 'campus-02', name: 'Campus-02 Research', subnet: '10.44.0.0/16', planes: [{ name: 'MIST', tone: 'info' }], mix: '72 ap · 22 sw · 2 gw', devices: 96, clients: '1,212', health: '94%', healthPct: '94%', tone: 'ok', alerts: '1 open', alertTone: 'warning', sync: '1m' },
  { id: 'lakeshore', name: 'Lakeshore Medical Center', subnet: '10.48.0.0/16', planes: [{ name: 'AOS-8', tone: 'accent' }, { name: 'LOCAL', tone: 'neutral' }], mix: '44 ap · 14 sw · 4 mc', devices: 62, clients: '744', health: '81%', healthPct: '81%', tone: 'warn', alerts: '3 open', alertTone: 'danger', sync: '2m' },
  { id: 'riverside', name: 'Riverside Clinic', subnet: '10.51.0.0/24', planes: [{ name: 'CLASSIC', tone: 'warning' }], mix: '16 ap · 8 sw', devices: 24, clients: '188', health: null, healthPct: '4%', tone: 'stale', alerts: 'stale', alertTone: 'neutral', sync: '6h' },
  { id: 'northgate', name: 'Northgate Clinic', subnet: '10.52.0.0/24', planes: [{ name: 'MIST', tone: 'info' }], mix: '12 ap · 4 sw', devices: 16, clients: '142', health: '99%', healthPct: '99%', tone: 'ok', alerts: 'clear', alertTone: 'success', sync: '1m' },
  { id: 'southpoint', name: 'Southpoint Clinic', subnet: '10.53.0.0/24', planes: [{ name: 'MIST', tone: 'info' }, { name: 'THIRD-PARTY', tone: 'neutral' }], mix: '10 ap · 4 sw · 1 mx', devices: 15, clients: '118', health: '97%', healthPct: '97%', tone: 'ok', alerts: '1 open', alertTone: 'warning', sync: '2m' },
  { id: 'warehouse-dc1', name: 'Warehouse-DC1', subnet: '10.60.0.0/22', planes: [{ name: 'LOCAL', tone: 'neutral' }], mix: '4 ap · 14 sw', devices: 18, clients: '96', health: '100%', healthPct: '100%', tone: 'ok', alerts: 'clear', alertTone: 'success', sync: '30s' },
  { id: 'warehouse-dc2', name: 'Warehouse-DC2', subnet: '10.61.0.0/22', planes: [{ name: 'CLASSIC', tone: 'warning' }, { name: 'LOCAL', tone: 'neutral' }], mix: '6 ap · 10 sw', devices: 16, clients: '78', health: '92%', healthPct: '92%', tone: 'ok', alerts: 'clear', alertTone: 'success', sync: '6h' },
  { id: 'airport-annex', name: 'Airport Annex', subnet: '10.62.0.0/23', planes: [{ name: 'AOS-8', tone: 'accent' }, { name: 'LOCAL', tone: 'neutral' }], mix: '14 ap · 6 sw · 1 mc', devices: 21, clients: '132', health: '96%', healthPct: '96%', tone: 'ok', alerts: 'clear', alertTone: 'success', sync: '2m' },
  { id: 'remote-vpn', name: 'Remote & VPN users', subnet: '10.70.0.0/16', planes: [{ name: 'AOS-10', tone: 'accent' }, { name: 'CLEARPASS', tone: 'neutral' }], mix: '2 gw · 168 rap', devices: 2, clients: '368', health: '95%', healthPct: '95%', tone: 'ok', alerts: '1 open', alertTone: 'warning', sync: '50s' },
];

/** The site ids that name a physical site. SITE_IDS also carries the
 *  bookkeeping pseudo-sites ('core-services', 'workspace', 'multiple') that
 *  alert/device rows use — those have no inventory row, so a site page must
 *  404 for them rather than fabricate one. */
export const REAL_SITE_IDS: SiteId[] = SITES.map((s) => s.id);

/** True only for a site the portal actually has an inventory row for. */
export function isRealSiteId(id: string): id is SiteId {
  return (REAL_SITE_IDS as readonly string[]).includes(id);
}

/**
 * Mist SLE fixture — per-site Service Level Expectations, keyed by SiteId.
 * Only the sites Mist actually manages (the `MIST` badge on SITES above)
 * carry a row; the rest are absent rather than a fabricated score, same
 * "not reported" rule the live adapter follows. Covers the full spread the
 * Sites screen's badge needs to demonstrate: good (≥0.9), moderate
 * (0.7–0.9) and poor (<0.7). Each row's `metrics` mirrors what the live
 * adapter reads from the per-site SLE summaries — the headline fractions
 * are the same numbers the metrics' sample counts derive to, and the
 * classifiers/impact tell the WHY (all authored: the demo estate's names
 * and counts, in Mist's vocabulary).
 */
export const SITE_SLE: Partial<Record<SiteId, MistSleRow>> = {
  'campus-02': {
    siteId: 'campus-02', siteName: 'Campus-02 Research',
    coverage: 0.97, capacity: 0.95, roaming: 0.96, apHealth: 0.98, wan: 0.94, overall: 0.96,
    metrics: [
      { name: 'time-to-connect', success: 0.97, samples: 4112, degraded: 123,
        impact: { numUsers: 36, numAps: 4, totalUsers: 1240, totalAps: 72 },
        classifiers: [
          { name: 'dhcp', samples: 71, degraded: 71, durationSec: 1704, impact: { numUsers: 21, numAps: 2, totalUsers: 1240, totalAps: 72 } },
          { name: 'authorization', samples: 31, degraded: 31, durationSec: 612, impact: { numUsers: 9, numAps: 1, totalUsers: 1240, totalAps: 72 } },
          { name: 'association', samples: 21, degraded: 21, durationSec: 498, impact: { numUsers: 6, numAps: 1, totalUsers: 1240, totalAps: 72 } },
        ] },
      { name: 'roaming', success: 0.96, samples: 2054, degraded: 82,
        impact: { numUsers: 22, numAps: 3, totalUsers: 1240, totalAps: 72 },
        classifiers: [
          { name: 'roam-latency', samples: 57, degraded: 57, durationSec: 1332, impact: { numUsers: 15, numAps: 2, totalUsers: 1240, totalAps: 72 } },
          { name: 'sticky-client', samples: 25, degraded: 25, durationSec: 588, impact: { numUsers: 7, numAps: 1, totalUsers: 1240, totalAps: 72 } },
        ] },
      { name: 'ap-availability', success: 0.99, samples: 1030, degraded: 10,
        impact: { numUsers: 9, numAps: 1, totalUsers: 1240, totalAps: 72 },
        classifiers: [
          { name: 'reboot', samples: 10, degraded: 10, durationSec: 600, impact: { numUsers: 9, numAps: 1, totalUsers: 1240, totalAps: 72 } },
        ] },
      { name: 'ap-health', success: 0.98, samples: 1030, degraded: 21,
        impact: { numUsers: 12, numAps: 2, totalUsers: 1240, totalAps: 72 },
        classifiers: [
          { name: 'memory', samples: 12, degraded: 12, durationSec: 720, impact: { numUsers: 7, numAps: 1, totalUsers: 1240, totalAps: 72 } },
          { name: 'uplink-errors', samples: 9, degraded: 9, durationSec: 402, impact: { numUsers: 5, numAps: 1, totalUsers: 1240, totalAps: 72 } },
        ] },
      { name: 'capacity', success: 0.95, samples: 6200, degraded: 310,
        impact: { numUsers: 58, numAps: 6, totalUsers: 1240, totalAps: 72 },
        classifiers: [
          { name: 'channel-utilization', samples: 204, degraded: 204, durationSec: 4896, impact: { numUsers: 39, numAps: 4, totalUsers: 1240, totalAps: 72 } },
          { name: 'client-load', samples: 106, degraded: 106, durationSec: 2544, impact: { numUsers: 19, numAps: 2, totalUsers: 1240, totalAps: 72 } },
        ] },
      { name: 'coverage', success: 0.97, samples: 6200, degraded: 186,
        impact: { numUsers: 41, numAps: 3, totalUsers: 1240, totalAps: 72 },
        classifiers: [
          { name: 'signal-strength', samples: 141, degraded: 141, durationSec: 3384, impact: { numUsers: 29, numAps: 2, totalUsers: 1240, totalAps: 72 } },
          { name: 'interference', samples: 45, degraded: 45, durationSec: 1080, impact: { numUsers: 12, numAps: 1, totalUsers: 1240, totalAps: 72 } },
        ] },
    ],
  },
  northgate: {
    siteId: 'northgate', siteName: 'Northgate Clinic',
    coverage: 0.88, capacity: 0.82, roaming: 0.79, apHealth: 0.91, wan: null, overall: 0.85,
    metrics: [
      { name: 'time-to-connect', success: 0.87, samples: 512, degraded: 67,
        impact: { numUsers: 14, numAps: 2, totalUsers: 142, totalAps: 12 },
        classifiers: [
          { name: 'dhcp', samples: 44, degraded: 44, durationSec: 1056, impact: { numUsers: 9, numAps: 1, totalUsers: 142, totalAps: 12 } },
          { name: 'authorization', samples: 23, degraded: 23, durationSec: 474, impact: { numUsers: 5, numAps: 1, totalUsers: 142, totalAps: 12 } },
        ] },
      { name: 'roaming', success: 0.79, samples: 288, degraded: 60,
        impact: { numUsers: 11, numAps: 2, totalUsers: 142, totalAps: 12 },
        classifiers: [
          { name: 'sticky-client', samples: 41, degraded: 41, durationSec: 984, impact: { numUsers: 8, numAps: 2, totalUsers: 142, totalAps: 12 } },
          { name: 'roam-latency', samples: 19, degraded: 19, durationSec: 390, impact: { numUsers: 3, numAps: 1, totalUsers: 142, totalAps: 12 } },
        ] },
      { name: 'ap-availability', success: 0.93, samples: 180, degraded: 13,
        impact: { numUsers: 6, numAps: 1, totalUsers: 142, totalAps: 12 },
        classifiers: [
          { name: 'unreachable', samples: 13, degraded: 13, durationSec: 936, impact: { numUsers: 6, numAps: 1, totalUsers: 142, totalAps: 12 } },
        ] },
      { name: 'ap-health', success: 0.91, samples: 180, degraded: 16,
        impact: { numUsers: 7, numAps: 1, totalUsers: 142, totalAps: 12 },
        classifiers: [
          { name: 'uplink-errors', samples: 16, degraded: 16, durationSec: 768, impact: { numUsers: 7, numAps: 1, totalUsers: 142, totalAps: 12 } },
        ] },
      { name: 'capacity', success: 0.82, samples: 940, degraded: 169,
        impact: { numUsers: 18, numAps: 3, totalUsers: 142, totalAps: 12 },
        classifiers: [
          { name: 'channel-utilization', samples: 121, degraded: 121, durationSec: 2904, impact: { numUsers: 13, numAps: 2, totalUsers: 142, totalAps: 12 } },
          { name: 'client-load', samples: 48, degraded: 48, durationSec: 1152, impact: { numUsers: 5, numAps: 1, totalUsers: 142, totalAps: 12 } },
        ] },
      { name: 'coverage', success: 0.88, samples: 940, degraded: 113,
        impact: { numUsers: 15, numAps: 2, totalUsers: 142, totalAps: 12 },
        classifiers: [
          { name: 'signal-strength', samples: 113, degraded: 113, durationSec: 2712, impact: { numUsers: 15, numAps: 2, totalUsers: 142, totalAps: 12 } },
        ] },
    ],
  },
  southpoint: {
    siteId: 'southpoint', siteName: 'Southpoint Clinic',
    coverage: 0.61, capacity: 0.58, roaming: 0.52, apHealth: 0.49, wan: 0.55, overall: 0.55,
    metrics: [
      { name: 'time-to-connect', success: 0.63, samples: 402, degraded: 149,
        impact: { numUsers: 31, numAps: 4, totalUsers: 118, totalAps: 10 },
        classifiers: [
          { name: 'dhcp', samples: 98, degraded: 98, durationSec: 2352, impact: { numUsers: 21, numAps: 3, totalUsers: 118, totalAps: 10 } },
          { name: 'association', samples: 51, degraded: 51, durationSec: 1224, impact: { numUsers: 10, numAps: 2, totalUsers: 118, totalAps: 10 } },
        ] },
      { name: 'roaming', success: 0.52, samples: 210, degraded: 101,
        impact: { numUsers: 19, numAps: 3, totalUsers: 118, totalAps: 10 },
        classifiers: [
          { name: 'sticky-client', samples: 72, degraded: 72, durationSec: 1728, impact: { numUsers: 13, numAps: 2, totalUsers: 118, totalAps: 10 } },
          { name: 'roam-latency', samples: 29, degraded: 29, durationSec: 696, impact: { numUsers: 6, numAps: 1, totalUsers: 118, totalAps: 10 } },
        ] },
      { name: 'ap-availability', success: 0.71, samples: 150, degraded: 44,
        impact: { numUsers: 12, numAps: 2, totalUsers: 118, totalAps: 10 },
        classifiers: [
          { name: 'reboot', samples: 31, degraded: 31, durationSec: 1860, impact: { numUsers: 9, numAps: 2, totalUsers: 118, totalAps: 10 } },
          { name: 'unreachable', samples: 13, degraded: 13, durationSec: 936, impact: { numUsers: 3, numAps: 1, totalUsers: 118, totalAps: 10 } },
        ] },
      { name: 'ap-health', success: 0.49, samples: 150, degraded: 77,
        impact: { numUsers: 16, numAps: 3, totalUsers: 118, totalAps: 10 },
        classifiers: [
          { name: 'memory', samples: 44, degraded: 44, durationSec: 2640, impact: { numUsers: 10, numAps: 2, totalUsers: 118, totalAps: 10 } },
          { name: 'uplink-errors', samples: 33, degraded: 33, durationSec: 1584, impact: { numUsers: 6, numAps: 1, totalUsers: 118, totalAps: 10 } },
        ] },
      { name: 'capacity', success: 0.58, samples: 760, degraded: 319,
        impact: { numUsers: 27, numAps: 5, totalUsers: 118, totalAps: 10 },
        classifiers: [
          { name: 'channel-utilization', samples: 214, degraded: 214, durationSec: 5136, impact: { numUsers: 18, numAps: 3, totalUsers: 118, totalAps: 10 } },
          { name: 'client-load', samples: 105, degraded: 105, durationSec: 2520, impact: { numUsers: 9, numAps: 2, totalUsers: 118, totalAps: 10 } },
        ] },
      { name: 'coverage', success: 0.61, samples: 760, degraded: 296,
        impact: { numUsers: 24, numAps: 4, totalUsers: 118, totalAps: 10 },
        classifiers: [
          { name: 'signal-strength', samples: 201, degraded: 201, durationSec: 4824, impact: { numUsers: 17, numAps: 3, totalUsers: 118, totalAps: 10 } },
          { name: 'interference', samples: 95, degraded: 95, durationSec: 2280, impact: { numUsers: 7, numAps: 1, totalUsers: 118, totalAps: 10 } },
        ] },
    ],
  },
};

// ---------------------------------------------------------------------------
// Site detail — NtSiteDetail.dc.html (the `profiles` map + fallback())
// ---------------------------------------------------------------------------

/** The three authored site profiles, keyed by canonical siteId
 *  (prototype keys by display name: 'Campus-01 — Meridian HQ',
 *  'Lakeshore Medical Center', 'Riverside Clinic'). Riverside health '—' → null. */
export const SITE_PROFILES: Partial<Record<SiteId, SiteProfile>> = {
  'campus-01': {
    name: 'Campus-01 — Meridian HQ', siteId: 'campus-01', blurb: 'Flagship campus: Central for wireless, local SSH for the CX fabric, AOS-10 gateways at the edge.',
    launch: 'Open in Central', deviceCount: '148', deviceDelta: '96 ap · 42 sw · 6 gw', clients: '1,904', clientDelta: 'peak 2,140 at 10:20',
    health: '98%', healthNote: '▼ 1% vs. yesterday', healthTone: 'negative', alertCount: '4', alertNote: '1 hardware', drift: '5', driftNote: 'vlan + ntp',
    collector: 'healthy', collectorTone: 'success', reachValue: 96, core: 'sw-core-a',
    collectorNote: 'collector-01 · 10.42.0.9 · polls every 30s · 42 of 42 switches answering, 4 uxi sensors idle',
    facts: [
      { k: 'Address', v: '1400 Meridian Parkway, Building A–D' },
      { k: 'Subnets', v: '10.42.0.0/16 · guest 10.42.12.0/23' },
      { k: 'WAN', v: '2 × 10G to DC1, LTE standby (unused 41d)' },
      { k: 'Core', v: 'sw-core-a / sw-core-b · CX 8325 VSX pair' },
      { k: 'Planes', v: 'Central (wireless), local SSH (wired), AOS-10' },
      { k: 'On-site', v: 'M. Rossi (facilities), 24×7 escort for ward floors' },
    ],
    devices: [
      { name: 'sw-core-a', model: 'CX 8325-48Y8C', plane: 'LOCAL', planeTone: 'neutral', role: 'core / vsx-1', state: 'degraded', stateTone: 'warning', uptime: '182d' },
      { name: 'sw-core-b', model: 'CX 8325-48Y8C', plane: 'LOCAL', planeTone: 'neutral', role: 'core / vsx-2', state: 'up', stateTone: 'success', uptime: '182d' },
      { name: 'sw-acc-3f-2', model: 'CX 6300M-48G', plane: 'LOCAL', planeTone: 'neutral', role: 'access 3F east', state: 'up', stateTone: 'success', uptime: '61d' },
      { name: 'sw-acc-3f-3', model: 'CX 6300M-48G', plane: 'LOCAL', planeTone: 'neutral', role: 'access 3F west', state: 'up', stateTone: 'success', uptime: '61d' },
      { name: 'gw-edge-1', model: 'AOS-10 9240', plane: 'AOS-10', planeTone: 'accent', role: 'edge gateway', state: 'flapping', stateTone: 'warning', uptime: '12d' },
      { name: 'gw-edge-2', model: 'AOS-10 9240', plane: 'AOS-10', planeTone: 'accent', role: 'edge gateway', state: 'up', stateTone: 'success', uptime: '12d' },
      { name: 'ap-1f-04', model: 'AP-635', plane: 'CENTRAL', planeTone: 'accent', role: 'lobby', state: 'up', stateTone: 'success', uptime: '44d' },
      { name: 'ap-3f-08', model: 'AP-635', plane: 'CENTRAL', planeTone: 'accent', role: 'ward 3E', state: 'up', stateTone: 'success', uptime: '44d' },
      { name: 'uxi-cam01-2', model: 'UXI G2', plane: 'UXI', planeTone: 'info', role: 'sensor 3F', state: 'offline', stateTone: 'danger', uptime: '—' },
      { name: 'cppm-01', model: 'ClearPass C3010', plane: 'CLEARPASS', planeTone: 'neutral', role: 'policy manager', state: 'up', stateTone: 'success', uptime: '211d' },
    ],
    alerts: [
      { sev: 'P2', tone: 'warning', title: 'sw-core-a PSU 2 absent', meta: 'local ssh · 3h' },
      { sev: 'P2', tone: 'warning', title: 'gw-edge-1 tunnel flap ×14', meta: 'aos-10 · 55m' },
      { sev: 'P2', tone: 'warning', title: 'uxi-cam01-2 sensor offline', meta: 'uxi · 5h' },
      { sev: 'P2', tone: 'warning', title: 'DHCP pool 92% on vlan 812', meta: 'central · 20m' },
    ],
  },
  lakeshore: {
    name: 'Lakeshore Medical Center', siteId: 'lakeshore', blurb: 'On-prem AOS-8 master-local cluster. No cloud plane here — the portal talks to the mobility master directly.',
    launch: 'Open AOS-8 WebUI', deviceCount: '62', deviceDelta: '44 ap · 14 sw · 4 mc', clients: '744', clientDelta: 'peak 810 at 09:05',
    health: '81%', healthNote: '▼ 14% since 08:00', healthTone: 'negative', alertCount: '3', alertNote: '2 critical', drift: '4', driftNote: 'mtu + firmware',
    collector: 'healthy', collectorTone: 'success', reachValue: 100, core: 'sw-lake-1',
    collectorNote: 'collector-03 · 10.48.0.9 · api to mm-lake-1 plus ssh to 14 switches · cluster heartbeat degraded',
    facts: [
      { k: 'Address', v: '89 Lakeshore Drive, towers 1–2' },
      { k: 'Subnets', v: '10.48.0.0/16 · medical devices 10.48.30.0/24' },
      { k: 'WAN', v: '1G primary + 1G diverse fibre' },
      { k: 'Cluster', v: 'mm-lake-1 master · mc-lake-2/3/4 locals' },
      { k: 'Planes', v: 'AOS-8 (8.10.0.10), local SSH for CX' },
      { k: 'Constraint', v: 'Change window 01:00–04:00 only — clinical floors' },
    ],
    devices: [
      { name: 'mm-lake-1', model: 'AOS-8 MM-VA', plane: 'AOS-8', planeTone: 'accent', role: 'mobility master', state: 'degraded', stateTone: 'warning', uptime: '96d' },
      { name: 'mc-lake-2', model: '7210 controller', plane: 'AOS-8', planeTone: 'accent', role: 'local', state: 'no heartbeat', stateTone: 'danger', uptime: '9d' },
      { name: 'mc-lake-3', model: '7210 controller', plane: 'AOS-8', planeTone: 'accent', role: 'local', state: 'no heartbeat', stateTone: 'danger', uptime: '9d' },
      { name: 'mc-lake-4', model: '7205 controller', plane: 'AOS-8', planeTone: 'accent', role: 'local', state: 'no heartbeat', stateTone: 'danger', uptime: '9d' },
      { name: 'sw-lake-1', model: 'CX 6400', plane: 'LOCAL', planeTone: 'neutral', role: 'core', state: 'up', stateTone: 'success', uptime: '240d' },
      { name: 'ap-t1-12', model: 'AP-535', plane: 'AOS-8', planeTone: 'accent', role: 'tower 1 ward', state: 'up', stateTone: 'success', uptime: '9d' },
      { name: 'ap-t2-04', model: 'AP-535', plane: 'AOS-8', planeTone: 'accent', role: 'tower 2 ICU', state: 'up', stateTone: 'success', uptime: '9d' },
    ],
    alerts: [
      { sev: 'P1', tone: 'danger', title: 'mm-lake-1 lost heartbeat from 3 controllers', meta: 'aos-8 · 41m' },
      { sev: 'P2', tone: 'warning', title: 'Tunnel MTU still 1500 on mc-lake-3', meta: 'compliance · 2d' },
      { sev: 'P3', tone: 'info', title: '4 APs pending 8.10.0.10 upgrade', meta: 'aos-8 · 3d' },
    ],
  },
  riverside: {
    name: 'Riverside Clinic', siteId: 'riverside', blurb: 'Still on Central Classic. Cloud state is six hours stale, so trust the local collector until the migration lands.',
    launch: 'Open Classic UI', deviceCount: '24', deviceDelta: '16 ap · 8 sw', clients: '188', clientDelta: 'last seen 03:12',
    health: null, healthNote: 'inventory stale', healthTone: 'negative', alertCount: '2', alertNote: '1 critical', drift: '3', driftNote: 'unverified',
    collector: 'degraded', collectorTone: 'warning', reachValue: 100, core: 'sw-riv-1',
    collectorNote: 'classic api 429-throttled · ssh probe reached 24 of 24 devices at 06:40 · migration to Central scheduled 12 Aug',
    facts: [
      { k: 'Address', v: '22 Riverside Way, single floor' },
      { k: 'Subnets', v: '10.51.0.0/24' },
      { k: 'WAN', v: '500M broadband, LTE failover (did not engage)' },
      { k: 'Core', v: 'sw-riv-1 · CX 6200F-48G' },
      { k: 'Planes', v: 'Central Classic (legacy), local SSH' },
      { k: 'Migration', v: 'Planned 12 Aug — 24 devices to Central' },
    ],
    devices: [
      { name: 'sw-riv-1', model: 'CX 6200F-48G', plane: 'LOCAL', planeTone: 'neutral', role: 'core / stack-1', state: 'up', stateTone: 'success', uptime: '312d' },
      { name: 'sw-riv-2', model: 'CX 6200F-24G', plane: 'CLASSIC', planeTone: 'warning', role: 'access', state: 'unverified', stateTone: 'neutral', uptime: '?' },
      { name: 'ap-riv-01', model: 'AP-515', plane: 'CLASSIC', planeTone: 'warning', role: 'reception', state: 'unverified', stateTone: 'neutral', uptime: '?' },
      { name: 'ap-riv-06', model: 'AP-515', plane: 'CLASSIC', planeTone: 'warning', role: 'consult rooms', state: 'unverified', stateTone: 'neutral', uptime: '?' },
    ],
    alerts: [
      { sev: 'P1', tone: 'danger', title: 'Riverside Clinic offline — WAN down', meta: 'classic · 12m' },
      { sev: 'P1', tone: 'danger', title: 'Classic sync stalled, 24 devices stale', meta: 'classic · 6h' },
    ],
  },
};

/** Inventory row → the site-detail device table's row shape. `role` and
 *  `uptime` are not on a DeviceRow, so they read '—' rather than invented. */
export function toSiteDeviceRow(d: DeviceRow): SiteDeviceRow {
  return {
    name: d.name,
    model: d.model,
    plane: d.plane,
    planeTone: d.planeTone,
    role: '—',
    state: d.state,
    stateTone: d.stateTone,
    uptime: '—',
    serial: d.serial,
  };
}

/** Alert queue row → the site-detail "Open here" row shape (plane · age meta,
 *  the same composition the authored profiles use). */
export function toSiteAlertRow(a: AlertRow): SiteAlertRow {
  return { sev: a.sev, tone: a.tone, title: a.title, meta: `${a.plane.toLowerCase()} · ${a.age}` };
}

/** Console label per claiming plane — the `launch` button copy. */
const SITE_LAUNCH_LABEL: Partial<Record<Plane, string>> = {
  CENTRAL: 'Open in Central',
  'AOS-10': 'Open in Central',
  MIST: 'Open in Mist',
  CLASSIC: 'Open Classic UI',
  'AOS-8': 'Open AOS-8 WebUI',
  LOCAL: 'Open local WebUI',
  CLEARPASS: 'Open ClearPass',
  UXI: 'Open UXI dashboard',
};

/**
 * Site profile derived from the portal's own inventory for a site that has no
 * authored deep profile — every value traces back to the SITES row, the
 * recorded forwarding chain, and the device/alert rows filed under that site.
 * Facts the portal does not hold (config drift, client peak, per-device role
 * and uptime) read '—' rather than borrowing another site's numbers.
 *
 * Returns null for a pseudo-site with no inventory row; callers should 404.
 * `core` is '' when no switch is filed at the site — render the terminal
 * button disabled rather than dialling a device from somewhere else.
 */
export function deriveSiteProfile(id: SiteId): SiteProfile | null {
  const site = SITES.find((s) => s.id === id);
  if (!site) return null;
  const chain = SITE_CHAIN[id];
  const rows = DEVICES.filter((d) => d.siteId === id);
  const open = ALERTS.filter((a) => a.siteId === id && a.state === 'open');
  const planeNames = site.planes.map((p) => p.name);
  const critical = open.filter((a) => a.sev === 'P1').length;
  const answering = rows.filter((d) => d.state === 'up').length;
  const core = chain?.core ?? rows.find((d) => d.type === 'switch')?.name ?? '';
  const local = planeNames.includes('LOCAL');
  const facts: Fact[] = [
    { k: 'Subnets', v: site.subnet },
    { k: 'WAN', v: chain ? chain.wan : '—' },
    { k: 'Core', v: chain ? `${chain.core} · ${chain.coreRole}` : '—' },
    { k: 'Planes', v: planeNames.join(', ') },
    { k: 'Mix', v: site.mix },
  ];
  return {
    name: site.name,
    siteId: id,
    blurb:
      `${planeNames.join(' + ')} ${planeNames.length > 1 ? 'claim' : 'claims'} this site. ` +
      'Everything below is the portal’s own inventory record — this site has no authored deep profile.',
    launch: SITE_LAUNCH_LABEL[site.planes[0]?.name ?? 'LOCAL'] ?? 'Open plane console',
    deviceCount: String(site.devices),
    deviceDelta: site.mix,
    clients: site.clients,
    clientDelta: 'no peak recorded',
    health: site.health,
    healthNote: site.health === null ? 'inventory stale' : `synced ${site.sync}`,
    healthTone: site.tone === 'ok' ? 'neutral' : 'negative',
    alertCount: String(open.length),
    alertNote: critical > 0 ? `${critical} critical` : open.length > 0 ? 'open now' : 'none open',
    drift: '—',
    driftNote: 'no baseline scan for this site',
    collector: local ? 'healthy' : 'none',
    collectorTone: local ? 'success' : 'neutral',
    reachValue: rows.length > 0 ? Math.round((answering / rows.length) * 100) : 0,
    core,
    collectorNote: local
      ? `local ssh collector · ${answering} of ${rows.length} recorded devices answering`
      : 'no local collector at this site — plane inventory only',
    facts,
    devices: rows.map(toSiteDeviceRow),
    alerts: open.map(toSiteAlertRow),
  };
}

// ---------------------------------------------------------------------------
// Devices — NtDevices.dc.html
// ---------------------------------------------------------------------------

/** Unified inventory — the `devices` array (28 rows).
 *  fw→firmware, fwOk→firmwareApproved, issue→reconciliationIssue.
 *  localShell is derived with the NtDeviceDetail profile() rule: ap-/uxi-
 *  devices are cloud-claimed (kind 'none') and expose no local shell. */
const hasLocalShell = (name: string): boolean => !(name.startsWith('ap-') || name.startsWith('uxi-'));

export const DEVICES: DeviceRow[] = [
  { name: 'sw-core-a', model: 'CX 8325-48Y8C', type: 'switch', siteId: 'campus-01', siteName: 'Campus-01 HQ', plane: 'LOCAL', planeTone: 'neutral', state: 'degraded', stateTone: 'warning', firmware: '10.13.1005', firmwareApproved: true, licence: 'n/a — local', reconciliationIssue: false, localShell: hasLocalShell('sw-core-a') },
  { name: 'sw-core-b', model: 'CX 8325-48Y8C', type: 'switch', siteId: 'campus-01', siteName: 'Campus-01 HQ', plane: 'LOCAL', planeTone: 'neutral', state: 'up', stateTone: 'success', firmware: '10.13.1005', firmwareApproved: true, licence: 'n/a — local', reconciliationIssue: false, localShell: hasLocalShell('sw-core-b') },
  { name: 'sw-acc-3f-2', model: 'CX 6300M-48G', type: 'switch', siteId: 'campus-01', siteName: 'Campus-01 HQ', plane: 'LOCAL', planeTone: 'neutral', state: 'up', stateTone: 'success', firmware: '10.11.1030', firmwareApproved: false, licence: 'n/a — local', reconciliationIssue: false, localShell: hasLocalShell('sw-acc-3f-2') },
  { name: 'sw-acc-3f-3', model: 'CX 6300M-48G', type: 'switch', siteId: 'campus-01', siteName: 'Campus-01 HQ', plane: 'LOCAL', planeTone: 'neutral', state: 'up', stateTone: 'success', firmware: '10.11.1030', firmwareApproved: false, licence: 'n/a — local', reconciliationIssue: false, localShell: hasLocalShell('sw-acc-3f-3') },
  { name: 'gw-edge-1', model: 'AOS-10 9240', type: 'gateway', siteId: 'campus-01', siteName: 'Campus-01 HQ', plane: 'AOS-10', planeTone: 'accent', state: 'flapping', stateTone: 'warning', firmware: '10.6.0.2', firmwareApproved: true, licence: 'Advanced', reconciliationIssue: false, localShell: hasLocalShell('gw-edge-1') },
  { name: 'gw-edge-2', model: 'AOS-10 9240', type: 'gateway', siteId: 'campus-01', siteName: 'Campus-01 HQ', plane: 'AOS-10', planeTone: 'accent', state: 'up', stateTone: 'success', firmware: '10.6.0.2', firmwareApproved: true, licence: 'Advanced', reconciliationIssue: false, localShell: hasLocalShell('gw-edge-2') },
  { name: 'ap-1f-04', model: 'AP-635', type: 'ap', siteId: 'campus-01', siteName: 'Campus-01 HQ', plane: 'CENTRAL', planeTone: 'accent', state: 'up', stateTone: 'success', firmware: '10.6.0.2', firmwareApproved: true, licence: 'Foundation', reconciliationIssue: false, localShell: hasLocalShell('ap-1f-04') },
  { name: 'ap-3f-08', model: 'AP-635', type: 'ap', siteId: 'campus-01', siteName: 'Campus-01 HQ', plane: 'CENTRAL', planeTone: 'accent', state: 'up', stateTone: 'success', firmware: '10.6.0.2', firmwareApproved: true, licence: 'Foundation', reconciliationIssue: false, localShell: hasLocalShell('ap-3f-08') },
  { name: 'ap-3f-12', model: 'AP43', type: 'ap', siteId: 'campus-02', siteName: 'Campus-02 Research', plane: 'MIST', planeTone: 'info', state: 'up', stateTone: 'success', firmware: '0.14.29', firmwareApproved: true, licence: 'Wi-Fi SUB', reconciliationIssue: false, localShell: hasLocalShell('ap-3f-12'), claimCode: 'KV4M9Q2X7RND3H1' },
  // One Mist AP demonstrably BEHIND the recommended train (0.14.29), with the
  // upgrade already running — the demo's at/behind spread for the firmware
  // verdict, and the plane's own state word riding through verbatim.
  { name: 'ap-3f-14', model: 'AP43', type: 'ap', siteId: 'campus-02', siteName: 'Campus-02 Research', plane: 'MIST', planeTone: 'info', state: 'up', stateTone: 'success', firmware: '0.13.18', firmwareApproved: false, firmwareTarget: '0.14.29', firmwareUpdate: 'inprogress', licence: 'Wi-Fi SUB', reconciliationIssue: false, localShell: hasLocalShell('ap-3f-14'), claimCode: 'MX8B4T2Q9WLF6P3' },
  { name: 'ap-ng-02', model: 'AP32', type: 'ap', siteId: 'northgate', siteName: 'Northgate Clinic', plane: 'MIST', planeTone: 'info', state: 'up', stateTone: 'success', firmware: '0.14.29', firmwareApproved: true, licence: 'Wi-Fi SUB', reconciliationIssue: false, localShell: hasLocalShell('ap-ng-02'), claimCode: 'QF7R2M9X4TNB8D5' },
  { name: 'sw-cam02-1', model: 'EX4400-48P', type: 'switch', siteId: 'campus-02', siteName: 'Campus-02 Research', plane: 'MIST', planeTone: 'info', state: 'up', stateTone: 'success', firmware: '23.4R2', firmwareApproved: true, licence: 'Wired SUB', reconciliationIssue: false, localShell: hasLocalShell('sw-cam02-1'), claimCode: 'ZT3W8K6N2PQX7R4' },
  { name: 'mm-lake-1', model: 'AOS-8 MM-VA', type: 'controller', siteId: 'lakeshore', siteName: 'Lakeshore Medical', plane: 'AOS-8', planeTone: 'accent', state: 'degraded', stateTone: 'warning', firmware: '8.10.0.10', firmwareApproved: true, licence: 'MM perpetual', reconciliationIssue: false, localShell: hasLocalShell('mm-lake-1') },
  { name: 'mc-lake-2', model: '7210 controller', type: 'controller', siteId: 'lakeshore', siteName: 'Lakeshore Medical', plane: 'AOS-8', planeTone: 'accent', state: 'no heartbeat', stateTone: 'danger', firmware: '8.10.0.10', firmwareApproved: true, licence: 'AP-16 perpetual', reconciliationIssue: false, localShell: hasLocalShell('mc-lake-2') },
  { name: 'mc-lake-3', model: '7210 controller', type: 'controller', siteId: 'lakeshore', siteName: 'Lakeshore Medical', plane: 'AOS-8', planeTone: 'accent', state: 'no heartbeat', stateTone: 'danger', firmware: '8.10.0.9', firmwareApproved: false, licence: 'AP-16 perpetual', reconciliationIssue: false, localShell: hasLocalShell('mc-lake-3') },
  { name: 'mc-lake-4', model: '7205 controller', type: 'controller', siteId: 'lakeshore', siteName: 'Lakeshore Medical', plane: 'AOS-8', planeTone: 'accent', state: 'no heartbeat', stateTone: 'danger', firmware: '8.10.0.10', firmwareApproved: true, licence: 'AP-8 perpetual', reconciliationIssue: false, localShell: hasLocalShell('mc-lake-4') },
  { name: 'ap-t1-12', model: 'AP-535', type: 'ap', siteId: 'lakeshore', siteName: 'Lakeshore Medical', plane: 'AOS-8', planeTone: 'accent', state: 'up', stateTone: 'success', firmware: '8.10.0.10', firmwareApproved: true, licence: 'controller', reconciliationIssue: false, localShell: hasLocalShell('ap-t1-12') },
  { name: 'sw-lake-1', model: 'CX 6400', type: 'switch', siteId: 'lakeshore', siteName: 'Lakeshore Medical', plane: 'LOCAL', planeTone: 'neutral', state: 'up', stateTone: 'success', firmware: '10.13.1005', firmwareApproved: true, licence: 'n/a — local', reconciliationIssue: false, localShell: hasLocalShell('sw-lake-1') },
  { name: 'sw-riv-1', model: 'CX 6200F-48G', type: 'switch', siteId: 'riverside', siteName: 'Riverside Clinic', plane: 'LOCAL', planeTone: 'neutral', state: 'up', stateTone: 'success', firmware: '10.10.1080', firmwareApproved: false, licence: 'n/a — local', reconciliationIssue: false, localShell: hasLocalShell('sw-riv-1') },
  { name: 'sw-riv-2', model: 'CX 6200F-24G', type: 'switch', siteId: 'riverside', siteName: 'Riverside Clinic', plane: 'CLASSIC', planeTone: 'warning', state: 'double-claimed', stateTone: 'danger', firmware: 'conflict', firmwareApproved: false, licence: 'Classic', reconciliationIssue: true, localShell: hasLocalShell('sw-riv-2') },
  { name: 'ap-riv-01', model: 'AP-515', type: 'ap', siteId: 'riverside', siteName: 'Riverside Clinic', plane: 'CLASSIC', planeTone: 'warning', state: 'double-claimed', stateTone: 'danger', firmware: 'conflict', firmwareApproved: false, licence: 'Classic', reconciliationIssue: true, localShell: hasLocalShell('ap-riv-01') },
  { name: 'ap-riv-06', model: 'AP-515', type: 'ap', siteId: 'riverside', siteName: 'Riverside Clinic', plane: 'CLASSIC', planeTone: 'warning', state: 'double-claimed', stateTone: 'danger', firmware: 'conflict', firmwareApproved: false, licence: 'Classic', reconciliationIssue: true, localShell: hasLocalShell('ap-riv-06') },
  { name: 'sw-wh1-1', model: 'CX 6300M-24G', type: 'switch', siteId: 'warehouse-dc1', siteName: 'Warehouse-DC1', plane: 'LOCAL', planeTone: 'neutral', state: 'up', stateTone: 'success', firmware: '10.13.1005', firmwareApproved: true, licence: 'not in greenlake', reconciliationIssue: true, localShell: hasLocalShell('sw-wh1-1') },
  { name: 'sw-wh1-3', model: 'CX 6300M-24G', type: 'switch', siteId: 'warehouse-dc1', siteName: 'Warehouse-DC1', plane: 'LOCAL', planeTone: 'neutral', state: 'missing', stateTone: 'warning', firmware: 'unknown', firmwareApproved: false, licence: 'not in greenlake', reconciliationIssue: true, localShell: hasLocalShell('sw-wh1-3') },
  { name: 'sw-wh2-1', model: 'CX 6200F-48G', type: 'switch', siteId: 'warehouse-dc2', siteName: 'Warehouse-DC2', plane: 'CLASSIC', planeTone: 'warning', state: 'stale', stateTone: 'neutral', firmware: '10.09.1010', firmwareApproved: false, licence: 'Classic', reconciliationIssue: true, localShell: hasLocalShell('sw-wh2-1') },
  { name: 'cppm-01', model: 'ClearPass C3010', type: 'policy', siteId: 'core-services', siteName: 'Core services', plane: 'CLEARPASS', planeTone: 'neutral', state: 'up', stateTone: 'success', firmware: '6.11.7', firmwareApproved: true, licence: '5,000 endpoints', reconciliationIssue: false, localShell: hasLocalShell('cppm-01') },
  { name: 'uxi-cam01-2', model: 'UXI G2', type: 'sensor', siteId: 'campus-01', siteName: 'Campus-01 HQ', plane: 'UXI', planeTone: 'info', state: 'offline', stateTone: 'danger', firmware: '3.4.1', firmwareApproved: true, licence: 'UXI SUB', reconciliationIssue: false, localShell: hasLocalShell('uxi-cam01-2') },
  { name: 'uxi-cam02-1', model: 'UXI G2', type: 'sensor', siteId: 'campus-02', siteName: 'Campus-02 Research', plane: 'UXI', planeTone: 'info', state: 'up', stateTone: 'success', firmware: '3.4.1', firmwareApproved: true, licence: 'UXI SUB', reconciliationIssue: false, localShell: hasLocalShell('uxi-cam02-1') },
];

/** Platform-lane header metadata — NT_LANE_META (8 planes; `mark` is the 2px
 *  bottom-rule colour). Prototype falls back to a neutral linked lane for
 *  planes missing from this map. */
export const LANE_META: Partial<Record<Plane, LaneMeta>> = {
  CENTRAL: { tone: 'success', sync: 'synced 40s', note: 'new central', mark: 'var(--nd-accent)' },
  MIST: { tone: 'success', sync: 'synced 1m', note: 'cloud', mark: 'var(--nd-info)' },
  CLASSIC: { tone: 'danger', sync: 'stale 6h', note: 'legacy', mark: 'var(--nd-danger)' },
  'AOS-8': { tone: 'warning', sync: 'degraded', note: 'on-prem mm', mark: 'var(--nd-warning)' },
  'AOS-10': { tone: 'success', sync: 'synced 50s', note: 'gateways', mark: 'var(--nd-accent)' },
  LOCAL: { tone: 'success', sync: 'ssh 30s', note: 'no cloud plane', mark: 'var(--nd-border-strong)' },
  CLEARPASS: { tone: 'success', sync: 'synced 55s', note: 'policy', mark: 'var(--nd-border-strong)' },
  UXI: { tone: 'warning', sync: '1 offline', note: 'sensors', mark: 'var(--nd-info)' },
};

/** The 2px lane-rule colour per plane, lifted out of LANE_META so a live lane
 *  header built from registry state uses the same colour as the demo one.
 *  The eight LANE_META values are reproduced verbatim; GREENLAKE and
 *  THIRD-PARTY never own a device lane, so they take the neutral rule. */
export const PLANE_MARK: Record<Plane, string> = {
  CENTRAL: 'var(--nd-accent)',
  CLASSIC: 'var(--nd-danger)',
  MIST: 'var(--nd-info)',
  GREENLAKE: 'var(--nd-border-strong)',
  'AOS-8': 'var(--nd-warning)',
  'AOS-10': 'var(--nd-accent)',
  LOCAL: 'var(--nd-border-strong)',
  CLEARPASS: 'var(--nd-border-strong)',
  UXI: 'var(--nd-info)',
  SSE: 'var(--nd-border-strong)',
  EDGECONNECT: 'var(--nd-border-strong)',
  OPSRAMP: 'var(--nd-border-strong)',
  'THIRD-PARTY': 'var(--nd-border-strong)',
};

/**
 * The lane header for a plane the payload says nothing about — an inventory
 * row claims the plane, but no lane meta was published for it (unlinked, or
 * not in this deployment). Honesty rule 1: it states that it has no freshness
 * stamp instead of inheriting a neutral header that reads as "linked".
 * Shared so the server's live lane builder and the client's fallback cannot
 * drift apart.
 */
export const UNKNOWN_LANE_META: LaneMeta = {
  tone: 'neutral',
  sync: 'no sync stamp',
  note: 'freshness not reported',
  mark: 'var(--nd-border-strong)',
  state: 'unknown',
};

/** Authored reconciliation truth for the demo estate — README:237 and
 *  design/NtDevices.dc.html:38 ("3 devices are claimed by two inventories,
 *  14 by none"). The 28 DEVICES rows are a SAMPLE of a 418-device estate, so
 *  these counts cannot be re-derived by counting sample rows. */
export const DEVICE_RECONCILIATION = { doubleClaimed: 3, unclaimed: 14 };

// ---------------------------------------------------------------------------
// Device detail — NtDeviceDetail.dc.html
// ---------------------------------------------------------------------------

/** Canned CX-switch terminal responses — NT_SW_RESP (6 commands). */
export const SW_TERMINAL_RESPONSES: TerminalResponseTable = {
  'show version': ['ArubaOS-CX', 'Version      : FL.10.13.1005', 'Build Date   : 2026-03-14 08:12:44 UTC', 'Build ID     : FL.10.13.1005-0-g7c1a', 'Active Image : primary', 'Service OS   : FL.01.13.0002', 'BIOS         : FL.01.0009'],
  'show system': ['Hostname          : sw-core-a', 'System Contact    : netops@meridian.health', 'System Location   : Campus-01 / MDF-A / rack 3', 'Base MAC Address  : 88:3a:30:41:9c:00', 'Up Time           : 182 days, 4 hours, 11 minutes', 'CPU Util (%)      : 14', 'Memory Usage (%)  : 39', 'Power Supplies    : 1 of 2 present  <-- psu2 absent', 'Temperature       : 41.5C (normal)'],
  'show interface brief': ['Port  Native  Mode    Type      Enabled Status  Reason      Speed   Description', '----- ------- ------- --------- ------- ------- ----------- ------- -----------------', '1/1/1     1   trunk   10GbT     yes     up      --          10000   uplink sw-core-b', '1/1/2     1   trunk   10GbT     yes     up      --          10000   uplink sw-core-b', '1/1/13   812   access  1GbT      yes     up      --           1000   ap-3f-08', '1/1/14   812   access  1GbT      yes     up      --           1000   ap-3f-12 (poe 22.1W)', '1/1/22    99   access  1GbT      yes     down    no-carrier      --   uxi-cam01-2', '1/1/47    12   trunk   1GbT      yes     up      --           1000   gw-edge-1', '1/1/48    12   trunk   1GbT      yes     up      --           1000   gw-edge-2'],
  'show vlan': ['VLAN  Name              Status  Reason      Type    Ports', '----- ----------------- ------- ----------- ------- ------------------', '1     DEFAULT_VLAN_1    up      ok          default 1/1/1-1/1/2', '8     mgmt              up      ok          static  1/1/1-1/1/2,1/1/47', '12    transit-wan       up      ok          static  1/1/47-1/1/48', '99    infra-sensors     down    no_ports_up static  1/1/22', '812   guest-wifi        up      ok          static  1/1/13-1/1/14', '820   clinical-devices  up      ok          static  1/1/20-1/1/21'],
  'show lldp neighbor': ['LOCAL-PORT  NEIGHBOR-CHASSIS-ID  PORT-ID  TTL  NEIGHBOR-SYSNAME', '----------- -------------------- -------- ---- ----------------', '1/1/1       88:3a:30:41:9d:00    1/1/1    120  sw-core-b', '1/1/14      3c:2a:f4:9b:11:08    eth0     120  ap-3f-12', '1/1/47      20:4c:03:11:aa:01    GE0/0/1  120  gw-edge-1'],
  'show running-config vlan 812': ['vlan 812', '    name guest-wifi', '    description onboarded via portal 2026-07-25', '    ip helper-address 10.42.0.20', '    ip helper-address 10.42.0.21', '! drift: baseline expects a third helper 10.44.0.20'],
};

/** Canned AOS terminal responses — NT_AOS_RESP (4 commands). */
export const AOS_TERMINAL_RESPONSES: TerminalResponseTable = {
  'show version': ['Aruba Operating System Software', 'ArubaOS (MODEL: ArubaMM-VA), Version 8.10.0.10', 'Website: https://www.arubanetworks.com', 'Compiled on 2026-02-02 at 04:11:09 UTC', 'Switch uptime is 96 days 2 hours 14 minutes'],
  'show switches': ['All Switches', '-------------', 'IP Address    Name        Model      Status  Configuration State', '10.48.0.10    mm-lake-1   MM-VA      up      UPDATE SUCCESSFUL', '10.48.0.11    mc-lake-2   Aruba7210  DOWN    heartbeat missed (41m)', '10.48.0.12    mc-lake-3   Aruba7210  DOWN    heartbeat missed (41m)', '10.48.0.13    mc-lake-4   Aruba7205  DOWN    heartbeat missed (39m)'],
  'show ap database': ['AP Database', '-----------', 'Name        Group     IP           Status  Flags  Switch IP', 'ap-t1-12    lakeshore 10.48.10.12  Up 9d   --     10.48.0.11', 'ap-t2-04    lakeshore 10.48.10.24  Up 9d   --     10.48.0.12', '44 APs total, 44 up, 0 down'],
  'show datapath tunnel': ['Datapath Tunnel Table Entries', '-----------------------------', 'Source        Destination   Prt  Type  MTU   Flags', '10.48.0.11    10.48.0.10    47   GRE   1500  FYC   <-- mtu drift, baseline 1400', '10.48.0.12    10.48.0.10    47   GRE   1400  FYC'],
};

/** Running / drift / history config per device kind — NT_CFG (3 kinds). */
export const DEVICE_CONFIGS: Record<TerminalKind, DeviceCfg> = {
  sw: {
    meta: 'SNAPSHOT 06:00 · 4 CHANGES THIS WEEK',
    running: 'hostname sw-core-a\nntp server 10.42.0.20 iburst\nsnmp-server vrf mgmt\nlogging 10.42.0.5\n!\nvsx\n    system-mac 02:01:00:00:01:00\n    inter-switch-link lag 256\n    role primary\n!\nvlan 8\n    name mgmt\nvlan 812\n    name guest-wifi\n    ip helper-address 10.42.0.20\nvlan 820\n    name clinical-devices\n!\ninterface lag 256\n    no shutdown\n    vlan trunk allowed all\ninterface 1/1/14\n    description ap-3f-12\n    no shutdown\n    vlan access 812\n    power-over-ethernet allocate-by class\n    aaa authentication port-access client-limit 5\n!\naaa group server radius clearpass\n    server 10.42.0.30',
    diff: '  hostname sw-core-a\n  ntp server 10.42.0.20 iburst\n- ntp server 10.44.0.20 iburst          <- baseline requires two servers\n!\n  vlan 812\n      ip helper-address 10.42.0.20\n- ip helper-address 10.44.0.20          <- baseline\n!\n  logging 10.42.0.5\n- logging 10.42.0.21                    <- collector moved in April\n!\n  interface 1/1/22\n- description uxi-cam01-2               <- description missing\n\n3 findings · 2 auto-remediable · last scan 09:05',
    history: [
      { when: '25 Jul 09:22', what: 'vlan 812 ip helper-address 10.42.0.20 added', who: 'r.okafor · brokered write · ticket NET-4166', tag: 'push', tone: 'accent' },
      { when: '22 Jul 01:40', what: 'Port 1/1/22 shut/no-shut during sensor swap', who: 'r.okafor · recorded shell', tag: 'shell', tone: 'neutral' },
      { when: '19 Jul 02:10', what: 'Firmware FL.10.13.1005 activated, config migrated', who: 'orchestrated upgrade', tag: 'upgrade', tone: 'info' },
      { when: '14 Jul 11:05', what: 'AAA server group pointed at cppm-01 + local fallback', who: 'j.alvarez · brokered write', tag: 'push', tone: 'accent' },
      { when: '02 Jul 06:00', what: 'Baseline snapshot accepted as the CX reference', who: 'portal reconciler', tag: 'baseline', tone: 'success' },
    ],
  },
  aos: {
    meta: 'SNAPSHOT 06:00 · FROZEN UNTIL MIGRATION',
    running: 'mm-name mm-lake-1\nclock timezone America/Chicago\n!\nap system-profile "lakeshore-ap"\n    lms-ip 10.48.0.11\n    bkup-lms-ip 10.48.0.12\n    heartbeat-interval 1000\n!\nwlan ssid-profile "MRDN-Staff"\n    essid MRDN-Staff\n    opmode wpa3-aes-ccm-128\n    max-clients 128\n!\naaa profile "clinical"\n    authentication-dot1x "default"\n    dot1x-server-group "clearpass"\n    initial-role "logon"\n!\ninterface tunnel 12\n    tunnel mtu 1500\n    tunnel source 10.48.0.11\n    tunnel destination 10.48.0.10',
    diff: '  ap system-profile "lakeshore-ap"\n      lms-ip 10.48.0.11\n!\n  interface tunnel 12\n      tunnel mtu 1500\n- tunnel mtu 1400                       <- baseline (path mtu measured 1400)\n!\n  tacacs-server host 10.42.0.40\n- tacacs-server host 10.44.0.40         <- baseline requires a secondary\n\n2 findings · 1 auto-remediable · change window 01:00–04:00 only',
    history: [
      { when: '19 Jul 01:40', what: 'Tunnel MTU set to 1400 on mc-lake-4 (fix validated)', who: 'j.alvarez · change window', tag: 'shell', tone: 'neutral' },
      { when: '12 Jul 02:00', what: 'AOS 8.10.0.10 activated on master and three locals', who: 'orchestrated upgrade', tag: 'upgrade', tone: 'info' },
      { when: '30 Jun 01:20', what: 'WPA3 transition mode enabled on MRDN-Staff', who: 'j.alvarez', tag: 'push', tone: 'accent' },
      { when: '02 Jul 06:00', what: 'Controller baseline frozen ahead of AOS-10 migration', who: 'portal reconciler', tag: 'baseline', tone: 'success' },
    ],
  },
  none: {
    meta: 'CLOUD TEMPLATE · READ-ONLY MIRROR',
    running: '# Mist WLAN template applied to this AP (read-only mirror)\nsite: Campus-02 Research\nap_group: clinical-floors\nrf_template:\n  band_5:\n    channels: [36, 40, 44, 48, 149, 153]\n    disallowed: [116, 120, 124, 128]   # DFS excluded on clinical floors\n    power: auto (8–14 dBm)\nwlans:\n  - ssid: MRDN-Staff\n    auth: eap (radsec -> cppm-01)\n    vlan: 820\n  - ssid: MRDN-Guest\n    auth: psk + portal\n    vlan: 812\n  - ssid: MRDN-IoT\n    auth: psk\n    vlan: 830',
    diff: '  rf_template.band_5.disallowed:\n      [116, 120, 124, 128]\n- applied value on this AP: []          <- DFS channels still permitted\n!\n  wlans[MRDN-Staff].auth: eap\n  wlans[MRDN-Guest].vlan: 812\n\n1 finding · auto-remediable in Mist · caused ticket NET-4188',
    history: [
      { when: '24 Jul 08:47', what: 'MRDN-Guest PSK rotated by Mist automation', who: 'mist automation', tag: 'cloud', tone: 'info' },
      { when: '07 Jul 14:10', what: 'AP moved into the clinical-floors group', who: 'j.alvarez · mist console', tag: 'cloud', tone: 'info' },
      { when: '02 Jul 06:00', what: 'RF template captured as the wireless baseline', who: 'portal reconciler', tag: 'baseline', tone: 'success' },
    ],
  },
};

/** "Clients on this device" per device kind — NT_DEV_CLIENTS (3 kinds). */
export const DEVICE_CLIENT_SETS: Record<TerminalKind, DeviceClientSet> = {
  sw: {
    meta: '38 WIRED',
    rows: [
      { name: 'infusion-4A-12', detail: 'port 1/1/20 · MAB · vlan 820', state: 'up', tone: 'success' },
      { name: 'ap-3f-12 (AP uplink)', detail: 'port 1/1/14 · poe 22.1 W', state: 'up', tone: 'success' },
      { name: 'voip-3f-114', detail: 'port 1/1/31 · 802.1X · vlan 816', state: 'up', tone: 'success' },
      { name: 'uxi-cam01-2', detail: 'port 1/1/22 · no carrier since 04:50', state: 'down', tone: 'danger' },
    ],
  },
  aos: {
    meta: '744 WIRELESS',
    rows: [
      { name: 'xray-cart-2', detail: 'ap-t1-12 · 802.1X · vlan 848', state: 'up', tone: 'success' },
      { name: 'a.ferreira', detail: 'ap-t2-04 · EAP-TLS · vlan 820', state: 'up', tone: 'success' },
      { name: '42 clients on mc-lake-2', detail: 'controller unreachable — state stale', state: 'stale', tone: 'warning' },
    ],
  },
  none: {
    meta: '38 ASSOCIATED',
    rows: [
      { name: 'm.okonjo', detail: 'iPad · 5 GHz · −52 dBm · vlan 820', state: 'good', tone: 'success' },
      { name: 's.mehta', detail: 'iPhone · 2.4 GHz · −71 dBm · sticky', state: 'weak', tone: 'warning' },
      { name: '6e:41:0d:99:2b:af', detail: 'rejected ×7 · certificate not valid', state: 'reject', tone: 'danger' },
    ],
  },
};

/** The five device profiles authored in profile() — one builder per branch.
 *  logic.ts deviceProfile(name) dispatches on the name prefix to one of these. */
export const DEVICE_PROFILE_BUILDERS = {
  /** mm-* / mc-* — AOS-8 mobility master (kind 'aos', '(<name>) [mynode] #' prompt). */
  aos8Controller: (name: string): DeviceProfile => ({
    name, model: 'AOS-8 MM-VA', site: 'Lakeshore Medical', siteId: 'lakeshore', ip: '10.48.0.10', plane: 'AOS-8', planeTone: 'accent',
    state: 'degraded', stateTone: 'warning', launch: 'Open AOS-8 WebUI', kind: 'aos', prompt: '(' + name + ') [mynode] #',
    stats: [
      { label: 'Uptime', value: '96d', delta: 'since 8.10 upgrade', tone: 'neutral' },
      { label: 'APs terminated', value: '44', delta: '0 down', tone: 'positive' },
      { label: 'Locals up', value: '0 / 3', delta: '▼ heartbeat lost', tone: 'negative' },
      { label: 'Clients', value: '744', delta: 'peak 810', tone: 'neutral' },
      { label: 'CPU', value: '31%', delta: 'mem 44%', tone: 'neutral' },
    ],
    facts: [
      { k: 'Serial', v: 'VA-9F41-LAKE-0001' },
      { k: 'Role', v: 'Mobility master (master-local)' },
      { k: 'Version', v: '8.10.0.10 (baseline: 8.10.0.10)' },
      { k: 'Mgmt IP', v: '10.48.0.10 / vlan 1' },
      { k: 'Licences', v: 'AP 96, PEF 96, RFP 96 (perpetual)' },
      { k: 'Local access', v: 'SSH via portal jump host 10.48.0.9' },
      { k: 'Last change', v: '19 Jul 01:40 — tunnel mtu on mc-lake-4' },
      { k: 'Owner', v: 'J. Alvarez' },
    ],
    listTitle: 'Cluster members', listMeta: '3 DOWN',
    ports: [
      { id: 'mc-lake-2', what: '7210 · 16 APs · heartbeat missed 41m', state: 'down', tone: 'danger' },
      { id: 'mc-lake-3', what: '7210 · 14 APs · heartbeat missed 41m', state: 'down', tone: 'danger' },
      { id: 'mc-lake-4', what: '7205 · 14 APs · heartbeat missed 39m', state: 'down', tone: 'danger' },
      { id: 'mm-lake-1', what: 'this node · config sync ok', state: 'up', tone: 'success' },
    ],
    checks: [
      { mark: 'fail', tone: 'danger', label: 'Tunnel MTU 1500 on mc-lake-3 (baseline 1400)' },
      { mark: 'pass', tone: 'success', label: 'AOS version matches approved 8.10.0.10' },
      { mark: 'fail', tone: 'warning', label: 'TACACS server list missing secondary' },
      { mark: 'pass', tone: 'success', label: 'Admin auth via ClearPass' },
    ],
  }),

  /** ap-* / uxi-* — cloud-claimed device (kind 'none', no shell). */
  cloudClaimed: (name: string): DeviceProfile => ({
    name, model: name.startsWith('uxi') ? 'UXI G2 sensor' : 'AP43 (Mist)', site: 'Campus-02 Research', siteId: 'campus-02', ip: '10.44.10.12',
    plane: name.startsWith('uxi') ? 'UXI' : 'MIST', planeTone: 'info', state: 'up', stateTone: 'success',
    launch: 'Open in Mist', kind: 'none', prompt: '',
    readOnlyNote: 'This device is cloud-claimed, so the portal exposes read-only telemetry and a remote-shell request instead of a direct SSH session. Approve the request in Mist and the session opens here.',
    stats: [
      { label: 'Uptime', value: '41d', delta: 'no reboots', tone: 'positive' },
      { label: 'Clients', value: '38', delta: '▼ 22 at 07:41', tone: 'negative' },
      { label: 'Channel', value: '36', delta: 'was 116 (DFS)', tone: 'negative' },
      { label: 'Tx power', value: '11 dBm', delta: 'auto', tone: 'neutral' },
      { label: 'PoE draw', value: '22.1 W', delta: 'port 1/1/14', tone: 'neutral' },
    ],
    facts: [
      { k: 'Serial', v: 'A1234567890123' },
      { k: 'MAC', v: '3c:2a:f4:9b:11:08' },
      { k: 'Firmware', v: '0.14.29 (rolling)' },
      { k: 'Wired to', v: 'sw-acc-3f-2 port 1/1/14' },
      { k: 'Site', v: 'Campus-02 Research / 3F east' },
      { k: 'Subscription', v: 'Wi-Fi SUB · expires 14 Sep 2026' },
      { k: 'Local access', v: 'none — cloud-claimed device' },
      { k: 'Last change', v: '24 Jul 08:47 — WLAN PSK rotation' },
    ],
    listTitle: 'Radios & SSIDs', listMeta: 'LIVE',
    ports: [
      { id: '5 GHz', what: 'ch 36 / 40MHz · 24 clients · 2 DFS events today', state: 'warn', tone: 'warning' },
      { id: '2.4 GHz', what: 'ch 6 / 20MHz · 14 clients', state: 'up', tone: 'success' },
      { id: 'MRDN-Staff', what: '802.1X · ClearPass · 31 clients', state: 'up', tone: 'success' },
      { id: 'MRDN-Guest', what: 'PSK · vlan 812 · 7 clients', state: 'up', tone: 'success' },
      { id: 'MRDN-IoT', what: 'PSK · vlan 820 · 0 clients', state: 'idle', tone: 'neutral' },
    ],
    checks: [
      { mark: 'pass', tone: 'success', label: 'Firmware on the rolling train' },
      { mark: 'fail', tone: 'warning', label: 'DFS channels not excluded for clinical floors' },
      { mark: 'pass', tone: 'success', label: 'Guest SSID isolated to vlan 812' },
    ],
  }),

  /** gw-* — AOS-10 gateway (kind 'aos', '(<name>) #' prompt). */
  aos10Gateway: (name: string): DeviceProfile => ({
    name, model: 'AOS-10 9240 gateway', site: 'Campus-01 HQ', siteId: 'campus-01', ip: '10.42.12.1', plane: 'AOS-10', planeTone: 'accent',
    state: 'flapping', stateTone: 'warning', launch: 'Open in Central', kind: 'aos', prompt: '(' + name + ') #',
    stats: [
      { label: 'Uptime', value: '12d', delta: 'last reload planned', tone: 'neutral' },
      { label: 'Tunnels', value: '6', delta: '▲ 14 flaps / 1h', tone: 'negative' },
      { label: 'Throughput', value: '1.9 Gb', delta: 'peak 3.1 Gb', tone: 'neutral' },
      { label: 'Sessions', value: '48k', delta: 'nat 12k', tone: 'neutral' },
      { label: 'CPU', value: '22%', delta: 'mem 51%', tone: 'neutral' },
    ],
    facts: [
      { k: 'Serial', v: 'CX0921AB77' },
      { k: 'Cluster', v: 'gw-edge-1 / gw-edge-2 (active-active)' },
      { k: 'Version', v: '10.6.0.2' },
      { k: 'Mgmt IP', v: '10.42.12.1 / vlan 12' },
      { k: 'Licences', v: 'Advanced gateway · expires 30 Nov 2026' },
      { k: 'Local access', v: 'SSH allowed from 10.42.0.9' },
      { k: 'Last change', v: '25 Jul 07:15 — failover test' },
      { k: 'Owner', v: 'R. Okafor' },
    ],
    listTitle: 'Tunnels', listMeta: '14 FLAPS',
    ports: [
      { id: 'ipsec-dc1', what: 'to 203.0.113.14 · 14 resets in 1h', state: 'flap', tone: 'danger' },
      { id: 'ipsec-dc2', what: 'to 203.0.113.15 · stable 12d', state: 'up', tone: 'success' },
      { id: 'gre-mist', what: 'overlay to Campus-02', state: 'up', tone: 'success' },
      { id: 'wan1', what: '10G to DC1 · 1.9 Gb/s', state: 'up', tone: 'success' },
    ],
    checks: [
      { mark: 'fail', tone: 'danger', label: 'Tunnel MTU 1500 — path MTU measured 1400' },
      { mark: 'pass', tone: 'success', label: 'Role assignment matches Central template' },
      { mark: 'pass', tone: 'success', label: 'Firmware on approved 10.6.0.2' },
    ],
  }),

  /** cppm* — ClearPass policy manager (kind 'sw', '[appadmin@<name>]#' prompt). */
  clearpass: (name: string): DeviceProfile => ({
    name, model: 'ClearPass C3010', site: 'Core services', siteId: 'core-services', ip: '10.42.0.30', plane: 'CLEARPASS', planeTone: 'neutral',
    state: 'up', stateTone: 'success', launch: 'Open ClearPass', kind: 'sw', prompt: '[appadmin@' + name + ']#',
    stats: [
      { label: 'Uptime', value: '211d', delta: 'cluster publisher', tone: 'positive' },
      { label: 'Auths / min', value: '412', delta: 'peak 610', tone: 'neutral' },
      { label: 'Reject rate', value: '1.4%', delta: '▼ 0.3%', tone: 'positive' },
      { label: 'Endpoints', value: '4,182', delta: 'of 5,000 licensed', tone: 'neutral' },
      { label: 'Cert', value: '21d', delta: 'expires 15 Aug', tone: 'negative' },
    ],
    facts: [
      { k: 'Serial', v: 'CP3010-77A21' },
      { k: 'Role', v: 'Publisher · 1 subscriber' },
      { k: 'Version', v: '6.11.7 patch 2' },
      { k: 'Mgmt IP', v: '10.42.0.30' },
      { k: 'Licences', v: '5,000 endpoints, OnGuard 1,000' },
      { k: 'Local access', v: 'appadmin CLI over SSH' },
      { k: 'Last change', v: '22 Jul — guest role rewrite' },
      { k: 'Owner', v: 'J. Alvarez' },
    ],
    listTitle: 'Services', listMeta: 'TOP 5',
    ports: [
      { id: '802.1X wired', what: 'CX switches · 1,204 auths/h', state: 'up', tone: 'success' },
      { id: '802.1X wifi', what: 'Central + Mist · 8,910 auths/h', state: 'up', tone: 'success' },
      { id: 'MAC auth', what: 'clinical devices vlan 820', state: 'up', tone: 'success' },
      { id: 'Guest', what: 'self-registration · vlan 812', state: 'up', tone: 'success' },
      { id: 'RadSec', what: 'to Mist org · cert expires 21d', state: 'warn', tone: 'warning' },
    ],
    checks: [
      { mark: 'fail', tone: 'warning', label: 'Server certificate expires in 21 days' },
      { mark: 'pass', tone: 'success', label: 'Backup completed 05:00 today' },
      { mark: 'pass', tone: 'success', label: 'Admin MFA enforced' },
    ],
  }),

  /** default — CX switch (kind 'sw', '<name>#' prompt). */
  cxSwitch: (name: string): DeviceProfile => ({
    name, model: 'CX 8325-48Y8C', site: 'Campus-01 HQ', siteId: 'campus-01', ip: '10.42.8.11', plane: 'LOCAL', planeTone: 'neutral',
    state: 'degraded', stateTone: 'warning', launch: 'Open switch WebUI', kind: 'sw', prompt: name + '#',
    stats: [
      { label: 'Uptime', value: '182d', delta: 'no reload', tone: 'positive' },
      { label: 'Ports up', value: '44 / 48', delta: '1 no-carrier', tone: 'neutral' },
      { label: 'PoE draw', value: '318 W', delta: 'of 740 W budget', tone: 'neutral' },
      { label: 'Temp', value: '41.5°C', delta: 'normal', tone: 'positive' },
      { label: 'Power', value: '1 / 2', delta: '▼ psu2 absent', tone: 'negative' },
    ],
    facts: [
      { k: 'Serial', v: 'SG09KLM4X2' },
      { k: 'Role', v: 'Core · VSX primary with sw-core-b' },
      { k: 'Firmware', v: 'FL.10.13.1005 (approved)' },
      { k: 'Mgmt IP', v: '10.42.8.11 / vlan 8' },
      { k: 'Base MAC', v: '88:3a:30:41:9c:00' },
      { k: 'Managed by', v: 'No cloud plane — local SSH only' },
      { k: 'Location', v: 'Campus-01 / MDF-A / rack 3 U12' },
      { k: 'Last change', v: '25 Jul 09:22 — vlan 812 helper' },
    ],
    listTitle: 'Ports of interest', listMeta: '48 TOTAL',
    ports: [
      // Counters follow the authored story: the 20G ISL carries the estate,
      // the WAN transit is next, an AP uplink is modest, and the dead sensor
      // port froze when its carrier dropped. psu2 is not an interface, so it
      // has no counters to say — the same honesty shape the live read has
      // when a plane reports no statistics map for a row.
      {
        id: '1/1/1-2', what: 'VSX ISL to sw-core-b · 20G lag', state: 'up', tone: 'success',
        counters: {
          rxBytes: 31_482_000_000_000, txBytes: 28_913_000_000_000,
          rxPackets: 24_600_000_000, txPackets: 22_800_000_000,
          rxErrors: 0, txErrors: 0, rxDropped: 0, txDropped: 0,
        },
      },
      {
        id: '1/1/14', what: 'ap-3f-12 · poe 22.1W · vlan 812', state: 'up', tone: 'success',
        counters: {
          rxBytes: 412_000_000_000, txBytes: 1_280_000_000_000,
          rxPackets: 512_000_000, txPackets: 1_400_000_000,
          rxErrors: 0, txErrors: 0, rxDropped: 0, txDropped: 0,
        },
      },
      {
        id: '1/1/22', what: 'uxi-cam01-2 · no carrier since 04:50', state: 'down', tone: 'danger',
        counters: {
          rxBytes: 86_000_000_000, txBytes: 4_100_000_000,
          rxPackets: 64_000_000, txPackets: 31_000_000,
          rxErrors: 0, txErrors: 0, rxDropped: 0, txDropped: 0,
        },
      },
      {
        id: '1/1/47-48', what: 'gw-edge-1 / gw-edge-2 transit', state: 'up', tone: 'success',
        counters: {
          rxBytes: 9_800_000_000_000, txBytes: 14_200_000_000_000,
          rxPackets: 8_100_000_000, txPackets: 11_900_000_000,
          rxErrors: 3, txErrors: 0, rxDropped: 27, txDropped: 0,
        },
      },
      { id: 'psu2', what: 'absent since 03:12 — single supply', state: 'fault', tone: 'warning' },
    ],
    checks: [
      { mark: 'pass', tone: 'success', label: 'Firmware matches approved 10.13.1005' },
      { mark: 'fail', tone: 'warning', label: 'vlan 812 missing helper 10.44.0.20' },
      { mark: 'fail', tone: 'warning', label: 'NTP has one server, baseline expects two' },
      { mark: 'pass', tone: 'success', label: 'AAA points at cppm-01 + local fallback' },
    ],
  }),
};

// ---------------------------------------------------------------------------
// Licences — NtLicenses.dc.html
// ---------------------------------------------------------------------------

/** Stat row, from the markup (5 stats). */
export const LICENSE_STATS: StatDef[] = [
  { label: 'Subscriptions', value: '486', delta: '4 platforms', tone: 'neutral' },
  { label: 'Assigned', value: '452', delta: '93% utilised', tone: 'positive' },
  { label: 'Unassigned', value: '34', delta: '▲ 6 this month', tone: 'negative' },
  { label: 'Expiring ≤60d', value: '34', delta: 'renewal due 14 Sep', tone: 'negative' },
  { label: 'Devices unlicensed', value: '14', delta: 'all local switches', tone: 'neutral' },
];

/** Subscriptions — the `rows` array (10 rows). */
export const SUBSCRIPTIONS: SubscriptionRow[] = [
  { name: 'Foundation AP', sku: 'R7G20AAE · greenlake', plane: 'GREENLAKE', planeTone: 'accent', term: '3 yr subscription', qty: '180', assigned: '174', pct: '97%', expires: '14 Sep 26', status: 'expiring', tone: 'warning' },
  { name: 'Advanced AP', sku: 'R7G21AAE · greenlake', plane: 'GREENLAKE', planeTone: 'accent', term: '3 yr subscription', qty: '40', assigned: '40', pct: '100%', expires: '30 Nov 26', status: 'active', tone: 'success' },
  { name: 'Advanced Switch 62xx/63xx', sku: 'R6U74AAE · greenlake', plane: 'GREENLAKE', planeTone: 'accent', term: '5 yr subscription', qty: '60', assigned: '46', pct: '77%', expires: '02 Mar 28', status: 'active', tone: 'success' },
  { name: 'Advanced Gateway', sku: 'R7G30AAE · greenlake', plane: 'GREENLAKE', planeTone: 'accent', term: '3 yr subscription', qty: '8', assigned: '6', pct: '75%', expires: '30 Nov 26', status: 'active', tone: 'success' },
  { name: 'Mist Wi-Fi SUB-WLAN', sku: 'SUB-WLAN-3Y · mist', plane: 'MIST', planeTone: 'info', term: '3 yr subscription', qty: '110', assigned: '108', pct: '98%', expires: '14 Sep 26', status: 'expiring', tone: 'warning' },
  { name: 'Mist Wired SUB-SW', sku: 'SUB-SW-3Y · mist', plane: 'MIST', planeTone: 'info', term: '3 yr subscription', qty: '30', assigned: '26', pct: '87%', expires: '14 Sep 26', status: 'expiring', tone: 'warning' },
  { name: 'AOS-8 AP capacity', sku: 'LIC-AP-96 · perpetual', plane: 'AOS-8', planeTone: 'accent', term: 'perpetual + support', qty: '96', assigned: '44', pct: '46%', expires: 'support 31 Jan 27', status: 'idle', tone: 'neutral' },
  { name: 'ClearPass endpoints', sku: 'CP-5K · perpetual', plane: 'CLEARPASS', planeTone: 'neutral', term: 'perpetual + support', qty: '5,000', assigned: '4,182', pct: '84%', expires: 'support 15 Aug 26', status: 'expiring', tone: 'warning' },
  { name: 'UXI sensor SUB', sku: 'UXI-SUB-1Y · greenlake', plane: 'UXI', planeTone: 'info', term: '1 yr subscription', qty: '12', assigned: '8', pct: '67%', expires: '01 Feb 27', status: 'active', tone: 'success' },
  { name: 'Central Classic device licences', sku: 'legacy pool', plane: 'CLASSIC', planeTone: 'warning', term: 'legacy, ends at migration', qty: '24', assigned: '24', pct: '100%', expires: '12 Aug 26', status: 'retiring', tone: 'danger' },
];

/** "Renewals, soonest first" — the `renewals` array (5 rows). */
export const RENEWALS: RenewalRow[] = [
  { date: '12 Aug 26', what: 'Central Classic legacy pool ends — migrate Riverside first', days: '18d', color: 'var(--nd-danger)' },
  { date: '15 Aug 26', what: 'ClearPass support contract + server certificate', days: '21d', color: 'var(--nd-danger)' },
  { date: '14 Sep 26', what: 'Foundation AP ×180, Mist WLAN ×110, Mist SW ×30', days: '51d', color: 'var(--nd-warning)' },
  { date: '30 Nov 26', what: 'Advanced AP ×40 and Advanced Gateway ×8', days: '128d', color: 'var(--nd-text-muted)' },
  { date: '01 Feb 27', what: 'UXI sensor subscriptions ×12', days: '191d', color: 'var(--nd-text-muted)' },
];

/** "Orphans & gaps" — the `orphans` array (4 rows). */
export const ORPHANS: OrphanRow[] = [
  { tag: 'orphan', tone: 'warning', what: '6 Foundation AP subscriptions on decommissioned devices', detail: 'ap-2f-01…06 · removed 14 May · reclaim before renewal' },
  { tag: 'gap', tone: 'info', what: '14 Warehouse switches with no GreenLake record', detail: 'locally managed only · no TAC entitlement' },
  { tag: 'gap', tone: 'info', what: '4 Mist wired SUBs unassigned', detail: 'purchased for Southpoint expansion, not yet claimed' },
  { tag: 'idle', tone: 'neutral', what: 'AOS-8 AP capacity 52 unused of 96', detail: 'freed as Lakeshore migrates to AOS-10' },
];

/**
 * Mist per-site licence consumption — the demo world's answer to the live
 * adapter's GET /api/v1/orgs/{org}/licenses/usages read. These are USAGE
 * counts (what each site consumes by service), not the subscription
 * assignment totals on SUBSCRIPTIONS above — per-site consumption sums to
 * less than the 108/26 assigned because Southpoint's four unassigned wired
 * SUBs (the orphan row above) consume nothing anywhere. `fullyLoaded` is
 * Mist's demand-if-every-feature-were-on map, carried in the same voice.
 */
export const MIST_LICENSE_USAGES: MistLicenseUsageRow[] = [
  {
    siteId: 'campus-02', siteName: 'Campus-02 Research',
    numDevices: 96, numAps: 72,
    usages: { 'SUB-WLAN': 72, 'SUB-SW': 22, 'SUB-ENG': 72 },
    fullyLoaded: { 'SUB-WLAN': 72, 'SUB-SW': 24, 'SUB-ENG': 72 },
  },
  {
    siteId: 'northgate', siteName: 'Northgate Clinic',
    numDevices: 16, numAps: 12,
    usages: { 'SUB-WLAN': 12, 'SUB-SW': 4 },
    fullyLoaded: { 'SUB-WLAN': 12, 'SUB-SW': 4, 'SUB-ENG': 12 },
  },
  {
    siteId: 'southpoint', siteName: 'Southpoint Clinic',
    numDevices: 15, numAps: 10,
    usages: { 'SUB-WLAN': 10, 'SUB-SW': 0 },
    fullyLoaded: { 'SUB-WLAN': 10, 'SUB-SW': 4, 'SUB-ENG': 10 },
  },
];

/**
 * Mist per-AP rich stats — the demo world's answer to the live adapter's
 * site-scoped stats/devices?type=ap walk. Authored in the live row's voice:
 * ap-3f-12 is the fully-instrumented AP43 (both radios, env sensors, the
 * LLDP uplink to sw-cam02-1 that topology edges are built from); ap-3f-14 is
 * the NET-4188 DFS-ticket AP, PoE-constrained and sitting on channel 116;
 * ap-ng-02 shows the honest-omission case (an AP32 has no env sensor block,
 * so `env` is null — "not reported", never a fabricated 21.5°C).
 */
export const MIST_AP_STATS: MistApStatsRow[] = [
  {
    deviceName: 'ap-3f-12', deviceUuid: '00000000-0000-0000-1000-3c52823f1201',
    mac: '3c:52:82:3f:12:01', serial: 'MST43KF1201',
    siteId: 'campus-02', siteName: 'Campus-02 Research',
    numClients: 41, cpuUtilPct: 23, memTotalKb: 997_376, memUsedKb: 512_040,
    uptimeSec: 3_945_600, rxBps: 48_200_000, txBps: 12_400_000, extIp: '198.51.100.44',
    dns: '10.44.1.10', gateway: '10.44.0.1', dhcpServer: '10.44.1.11',
    powerSrc: 'PoE 802.3at', powerConstrained: false,
    radios: [
      { band: '2.4 GHz', channel: 6, bandwidthMHz: 20, powerDbm: 11, noiseFloorDbm: -92, utilAllPct: 58, utilTxPct: 22, utilRxInBssPct: 18, utilRxOtherBssPct: 14, utilNonWifiPct: 4, numClients: 13 },
      { band: '5 GHz', channel: 36, bandwidthMHz: 40, powerDbm: 14, noiseFloorDbm: -96, utilAllPct: 31, utilTxPct: 12, utilRxInBssPct: 9, utilRxOtherBssPct: 7, utilNonWifiPct: 3, numClients: 28 },
    ],
    ports: [
      { name: 'eth0', up: true, speedMbps: 1000, fullDuplex: true, rxBytes: 4_812_340_220, txBytes: 1_203_110_540, rxErrors: 0, txErrors: 0, peakBps: 812_000_000 },
    ],
    env: { ambientTempC: 23.8, pressureHpa: 1004.2, humidityPct: 41, accelX: 0, accelY: 0, accelZ: 0 },
    lldpUplink: { systemName: 'sw-cam02-1', systemDesc: 'Juniper EX4400-48P', portId: 'ge-0/0/12', chassisId: '3c:52:82:c0:02:01', mgmtAddr: '10.44.1.5' },
  },
  {
    deviceName: 'ap-3f-14', deviceUuid: '00000000-0000-0000-1000-3c52823f1401',
    mac: '3c:52:82:3f:14:01', serial: 'MST43KF1401',
    siteId: 'campus-02', siteName: 'Campus-02 Research',
    numClients: 19, cpuUtilPct: 31, memTotalKb: 997_376, memUsedKb: 608_120,
    uptimeSec: 1_209_600, rxBps: 9_600_000, txBps: 3_100_000, extIp: '198.51.100.44',
    dns: '10.44.1.10', gateway: '10.44.0.1', dhcpServer: '10.44.1.11',
    powerSrc: 'PoE 802.3af', powerConstrained: true,
    radios: [
      { band: '2.4 GHz', channel: 11, bandwidthMHz: 20, powerDbm: 9, noiseFloorDbm: -91, utilAllPct: 44, utilTxPct: 16, utilRxInBssPct: 12, utilRxOtherBssPct: 11, utilNonWifiPct: 5, numClients: 7 },
      // Channel 116 with a non-Wi-Fi spike — the NET-4188 DFS-radar story.
      { band: '5 GHz', channel: 116, bandwidthMHz: 40, powerDbm: 13, noiseFloorDbm: -93, utilAllPct: 52, utilTxPct: 9, utilRxInBssPct: 6, utilRxOtherBssPct: 15, utilNonWifiPct: 22, numClients: 12 },
    ],
    ports: [
      { name: 'eth0', up: true, speedMbps: 1000, fullDuplex: true, rxBytes: 901_220_410, txBytes: 244_018_773, rxErrors: 3, txErrors: 0, peakBps: 388_000_000 },
    ],
    env: { ambientTempC: 26.1, pressureHpa: 1004.0, humidityPct: 38, accelX: 0, accelY: 0, accelZ: 0 },
    lldpUplink: { systemName: 'sw-cam02-1', systemDesc: 'Juniper EX4400-48P', portId: 'ge-0/0/16', chassisId: '3c:52:82:c0:02:01', mgmtAddr: '10.44.1.5' },
  },
  {
    deviceName: 'ap-ng-02', deviceUuid: '00000000-0000-0000-1000-3c5282a00201',
    mac: '3c:52:82:a0:02:01', serial: 'MST32NG0201',
    siteId: 'northgate', siteName: 'Northgate Clinic',
    numClients: 9, cpuUtilPct: 18, memTotalKb: 506_880, memUsedKb: 301_220,
    uptimeSec: 5_702_400, rxBps: 4_100_000, txBps: 1_800_000, extIp: '203.0.113.18',
    dns: '10.52.1.10', gateway: '10.52.0.1', dhcpServer: '10.52.1.11',
    powerSrc: 'PoE 802.3af', powerConstrained: false,
    radios: [
      { band: '2.4 GHz', channel: 1, bandwidthMHz: 20, powerDbm: 10, noiseFloorDbm: -90, utilAllPct: 39, utilTxPct: 11, utilRxInBssPct: 8, utilRxOtherBssPct: 14, utilNonWifiPct: 6, numClients: 4 },
      { band: '5 GHz', channel: 100, bandwidthMHz: 40, powerDbm: 14, noiseFloorDbm: -95, utilAllPct: 22, utilTxPct: 7, utilRxInBssPct: 5, utilRxOtherBssPct: 8, utilNonWifiPct: 2, numClients: 5 },
    ],
    ports: [
      { name: 'eth0', up: true, speedMbps: 1000, fullDuplex: true, rxBytes: 1_102_448_901, txBytes: 402_991_207, rxErrors: 0, txErrors: 0, peakBps: 244_000_000 },
    ],
    env: null, // the AP32 has no env sensor block — not reported, never fabricated
    lldpUplink: { systemName: 'sw-ng-1', systemDesc: 'Juniper EX2300-24P', portId: 'ge-0/0/6', chassisId: '3c:52:82:c0:11:01', mgmtAddr: '10.52.1.4' },
  },
];

/**
 * Mist floor plans — the demo world's answer to the maps + AP-config walk.
 * The live probe org publishes ZERO maps (200 [], an honest empty), so this
 * is the showcase: one plan for Campus-02's third floor with both Mist APs
 * placed, the client dots riding on the CLIENTS rows' own x/y/mapId. The
 * image is an inline SVG data-URI (the live field carries Mist's hosted URL
 * — same `imageUrl` field, rendered the same way in an <svg><image>).
 */
const CAM02_3F_PLAN_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 800">' +
  '<rect width="1200" height="800" fill="#f4f1ea"/>' +
  '<rect x="40" y="40" width="1120" height="720" fill="none" stroke="#4a463f" stroke-width="10"/>' +
  '<line x1="600" y1="40" x2="600" y2="760" stroke="#4a463f" stroke-width="6"/>' +
  '<line x1="40" y1="400" x2="1160" y2="400" stroke="#4a463f" stroke-width="6"/>' +
  '<line x1="600" y1="220" x2="1160" y2="220" stroke="#8a8578" stroke-width="3"/>' +
  '<line x1="300" y1="400" x2="300" y2="760" stroke="#8a8578" stroke-width="3"/>' +
  '<text x="80" y="90" font-family="sans-serif" font-size="28" fill="#4a463f">Lab 3B-East</text>' +
  '<text x="640" y="90" font-family="sans-serif" font-size="28" fill="#4a463f">Ward 3E</text>' +
  '<text x="640" y="450" font-family="sans-serif" font-size="28" fill="#4a463f">Instrument bay</text>' +
  '<text x="80" y="450" font-family="sans-serif" font-size="28" fill="#4a463f">Nurse station</text>' +
  '<text x="1120" y="790" font-family="sans-serif" font-size="18" fill="#8a8578" text-anchor="end">48 m × 32 m</text>' +
  '</svg>';

export const MIST_SITE_MAPS: MistSiteMap[] = [
  {
    siteId: 'campus-02', siteName: 'Campus-02 Research',
    mapId: 'map-cam02-3f', name: 'Tower B · 3rd floor — east labs',
    imageUrl: `data:image/svg+xml;utf8,${encodeURIComponent(CAM02_3F_PLAN_SVG)}`,
    widthPx: 1200, heightPx: 800, widthM: 48, heightM: 32, orientationDeg: 0,
    aps: [
      { deviceName: 'ap-3f-12', deviceUuid: '00000000-0000-0000-1000-3c52823f1201', mac: '3c:52:82:3f:12:01', x: 320, y: 240 },
      { deviceName: 'ap-3f-14', deviceUuid: '00000000-0000-0000-1000-3c52823f1401', mac: '3c:52:82:3f:14:01', x: 880, y: 560 },
    ],
  },
];

/**
 * Mist rogue & neighbor APs — the demo world's answer to the per-site
 * insights/rogues walk. The lead row is the showcase: 'FREE-CLINIC-WIFI'
 * seen ON the wire at Campus-02 (seen_on_lan true — a rogue plugged into
 * your own infrastructure is the alarm the section leads with), heard by
 * both 3F APs at a strong -48 dBm. The rest are honest neighbors: BSSIDs in
 * earshot that are NOT on the wire, including one whose SSID spoofs the
 * demo estate's own MRDN-Clinical (an evil-twin tell, but off-LAN). One row
 * carries no seen_on_lan at all — 'not reported', never an assumed safe.
 */
export const MIST_ROGUE_APS: MistRogueApRow[] = [
  {
    siteId: 'campus-02', siteName: 'Campus-02 Research',
    bssid: '5c:5b:35:00:0e:77', ssid: 'FREE-CLINIC-WIFI',
    channel: 6, avgRssi: -48, numAps: 2, seenOnLan: true,
  },
  {
    siteId: 'campus-02', siteName: 'Campus-02 Research',
    bssid: '5c:5b:35:00:0e:88', ssid: 'MRDN-Clinical',
    channel: 36, avgRssi: -71, numAps: 2, seenOnLan: false,
  },
  {
    siteId: 'campus-02', siteName: 'Campus-02 Research',
    bssid: 'b8:6a:f1:02:44:01', ssid: 'CoffeeShop_Guest',
    channel: 11, avgRssi: -83, numAps: 1, seenOnLan: false,
  },
  {
    siteId: 'campus-02', siteName: 'Campus-02 Research',
    bssid: 'b8:6a:f1:02:55:09', ssid: null,
    channel: 1, avgRssi: -89, numAps: 1, seenOnLan: null,
  },
  {
    siteId: 'northgate', siteName: 'Northgate Clinic',
    bssid: '70:a7:41:19:02:3c', ssid: 'Xfinitywifi',
    channel: 149, avgRssi: -78, numAps: 3, seenOnLan: false,
  },
];

/**
 * Mist org audit log — the demo world's answer to the on-demand
 * /orgs/{org}/logs/search read behind the Systems drawer's Mist section.
 * Newest first, stamped on the demo world's FIXED clock (deterministic, like
 * MIST_SLE_DRILLDOWN). Tells the demo estate's own story: the MRDN-Research
 * WLAN edit (its before/after carries a psk key — the demo proves the
 * portal's redaction marker shows instead of the value), ap-3f-14's radio
 * config change from the NET-4188 DFS ticket, and an org-scoped entry with
 * no site at all.
 */
export const MIST_AUDIT_LOG: MistAuditLogRow[] = [
  {
    id: 'log-demo-0003', at: '2026-07-26T11:42:00.000Z',
    admin: 'n.osei@meridian-health.example',
    message: "Updated WLAN 'MRDN-Research' (vlan_id 820 → 822)",
    siteId: 'campus-02', siteName: 'Campus-02 Research',
    before: '{"ssid":"MRDN-Research","vlan_id":820,"auth":{"type":"psk","psk":"<redacted by the portal>"}}',
    after: '{"ssid":"MRDN-Research","vlan_id":822,"auth":{"type":"psk","psk":"<redacted by the portal>"}}',
  },
  {
    id: 'log-demo-0002', at: '2026-07-26T09:15:00.000Z',
    admin: 'a.whitfield@meridian-health.example',
    message: "Updated device 'ap-3f-14' radio_config (band_5 channel 116 → 100) — NET-4188",
    siteId: 'campus-02', siteName: 'Campus-02 Research',
    before: '{"radio_config":{"band_5":{"channel":116,"power":13}}}',
    after: '{"radio_config":{"band_5":{"channel":100,"power":13}}}',
  },
  {
    id: 'log-demo-0001', at: '2026-07-25T16:03:00.000Z',
    admin: 'automation@meridian-health.example',
    message: "Updated org setting 'auto_upgrade' (window 01:00–04:00)",
    siteId: null, siteName: null,
  },
];

/**
 * The demo world's Mist plane status — the authored answer to the registry
 * block the live /api/mist payload builds from PlaneState. Agrees with the
 * SYSTEMS row's own facts (healthy, 128 devices claimed, 1,472 client
 * sessions reported) and stamps the demo FIXED clock one minute behind the
 * audit log's 'now' (2026-07-26T11:59Z) — the demo world never moves.
 */
export const MIST_PLANE_STATUS: MistPlaneStatus = {
  linked: true,
  health: 'healthy',
  lastSync: '2026-07-26T11:58:00.000Z',
  deviceCount: 128,
  clientCount: 1472,
  note: null,
};

/**
 * Mist SLE drill-down fixtures — the demo world's answer to the lazy
 * classifiers / impacted-users / impacted-aps / summary-trend reads, keyed
 * `${siteId}|${metric}` the way the adapter's mistSleMetricDetail() is
 * called. Authored to agree with SITE_SLE above (same classifiers, same
 * named clients and APs) and stamped with a FIXED `at` — the demo world is
 * deterministic; a renderer never sees a moving clock.
 */
export const MIST_SLE_DRILLDOWN: Record<string, MistSleMetricDetail> = {
  'campus-02|coverage': {
    siteId: 'campus-02', siteName: 'Campus-02 Research', metric: 'coverage',
    classifiers: [
      { name: 'signal-strength', samples: 141, degraded: 141, durationSec: 3384, impact: { numUsers: 29, numAps: 2, totalUsers: 1240, totalAps: 72 } },
      { name: 'interference', samples: 45, degraded: 45, durationSec: 1080, impact: { numUsers: 12, numAps: 1, totalUsers: 1240, totalAps: 72 } },
    ],
    impactedClients: [
      { mac: 'de:ad:0b:14:65:22', name: 's.mehta', degraded: 31 },
      { mac: '6e:41:0d:99:2b:af', name: null, degraded: 18 },
    ],
    impactedAps: [
      { mac: '3c:52:82:3f:14:01', name: 'ap-3f-14', degraded: 12 },
      { mac: '3c:52:82:3f:12:01', name: 'ap-3f-12', degraded: 5 },
    ],
    trend: {
      startSec: 1_785_513_600, endSec: 1_785_600_000, intervalSec: 3600,
      total: [258, 261, 255, 262, 259, 260, 258, 257, 261, 259, 254, 251, 248, 244, 241, 239, 242, 246, 251, 255, 258, 260, 261, 259],
      degraded: [4, 4, 5, 4, 4, 5, 5, 6, 6, 7, 8, 9, 12, 15, 18, 21, 17, 13, 10, 8, 7, 6, 5, 4],
    },
    source: { plane: 'mist', at: '2026-07-26T11:59:00.000Z', sections: { classifiers: 'ok', impactedClients: 'ok', impactedAps: 'ok', trend: 'ok' } },
  },
  'campus-02|time-to-connect': {
    siteId: 'campus-02', siteName: 'Campus-02 Research', metric: 'time-to-connect',
    classifiers: [
      { name: 'dhcp', samples: 71, degraded: 71, durationSec: 1704, impact: { numUsers: 21, numAps: 2, totalUsers: 1240, totalAps: 72 } },
      { name: 'authorization', samples: 31, degraded: 31, durationSec: 612, impact: { numUsers: 9, numAps: 1, totalUsers: 1240, totalAps: 72 } },
      { name: 'association', samples: 21, degraded: 21, durationSec: 498, impact: { numUsers: 6, numAps: 1, totalUsers: 1240, totalAps: 72 } },
    ],
    impactedClients: [
      { mac: '3c:22:fb:41:0a:19', name: 'm.okonjo', degraded: 9 },
    ],
    impactedAps: [
      { mac: '3c:52:82:3f:12:01', name: 'ap-3f-12', degraded: 7 },
    ],
    trend: {
      startSec: 1_785_513_600, endSec: 1_785_600_000, intervalSec: 3600,
      total: [171, 174, 170, 172, 169, 171, 168, 166, 172, 174, 170, 168, 165, 162, 160, 158, 161, 164, 168, 171, 173, 172, 174, 172],
      degraded: [3, 3, 4, 3, 3, 4, 4, 5, 5, 6, 7, 8, 9, 11, 12, 10, 8, 6, 5, 4, 4, 3, 3, 3],
    },
    source: { plane: 'mist', at: '2026-07-26T11:59:00.000Z', sections: { classifiers: 'ok', impactedClients: 'ok', impactedAps: 'ok', trend: 'ok' } },
  },
};

// ---------------------------------------------------------------------------
// Configure — NtConfigure.dc.html
// ---------------------------------------------------------------------------

/** Stat row, from the markup (4 stats). */
export const CONFIGURE_STATS: StatDef[] = [
  { label: 'Queued changes', value: '3', delta: '2 need a window', tone: 'neutral' },
  { label: 'Pushed today', value: '6', delta: 'all ticket-stamped', tone: 'positive' },
  { label: 'Config objects', value: '28', delta: '6 ssid · 7 vlan · 12 port', tone: 'neutral' },
  { label: 'Drift open', value: '12', delta: '7 auto-remediable', tone: 'negative' },
];

/** Wireless SSIDs — the `ssids` array (6 rows). The PSK rows carry the same
 *  redaction note the Mist adapter stamps on WLANs whose payload held the
 *  cleartext key: the portal says a PSK exists, and never transports it.
 *  MRDN-Research is the demo's purely-Mist WLAN (Campus-02 is the demo
 *  estate's Mist site): it is what the Mist direct-write edit flow opens on. */
export const SSIDS: SsidObject[] = [
  { kind: 'ssid', name: 'MRDN-Staff', vlan: 'vlan 820', security: 'WPA3-Enterprise', targets: 'clinical-floors, staff-wireless · 268 APs', plane: 'CENTRAL + MIST', tone: 'accent' },
  { kind: 'ssid', name: 'MRDN-Guest', vlan: 'vlan 812', security: 'PSK + captive portal', targets: 'guest-lobby, northgate-public · 96 APs', plane: 'CENTRAL', tone: 'accent', note: 'PSK set — redacted by the portal' },
  { kind: 'ssid', name: 'MRDN-IoT', vlan: 'vlan 830', security: 'WPA2-PSK', targets: 'all groups · 268 APs', plane: 'CENTRAL + MIST', tone: 'accent', note: 'PSK set — redacted by the portal' },
  { kind: 'ssid', name: 'MRDN-Research', vlan: 'vlan 822', security: 'WPA2-PSK', targets: 'Campus-02 Research · enabled', plane: 'MIST', tone: 'info', note: 'PSK set — redacted by the portal', enabled: true },
  { kind: 'ssid', name: 'LAKE-Clinical', vlan: 'vlan 848', security: 'WPA2-Enterprise', targets: 'lakeshore-medical · 44 APs', plane: 'AOS-8', tone: 'warning' },
  { kind: 'ssid', name: 'MRDN-Legacy', vlan: 'vlan 810', security: 'WPA2-Enterprise', targets: 'riverside only · retiring 12 Aug', plane: 'CLASSIC', tone: 'danger' },
];

/** Switch ports — the `ports` array (6 rows). */
export const CONFIG_PORTS: PortObject[] = [
  { kind: 'port', device: 'sw-core-a', port: '1/1/14', desc: 'ap-3f-12', summary: 'access vlan 812 · poe class · 802.1X', state: 'up', tone: 'success' },
  { kind: 'port', device: 'sw-acc-3f-2', port: '1/1/20', desc: 'infusion-4A-12', summary: 'access vlan 820 · poe 6.1 W · MAB', state: 'up', tone: 'success' },
  { kind: 'port', device: 'sw-acc-3f-3', port: '1/1/31', desc: 'printer-2f-04', summary: 'access vlan 818 · no poe · MAB', state: 'up', tone: 'success' },
  { kind: 'port', device: 'sw-core-a', port: '1/1/22', desc: 'uxi-cam01-2', summary: 'access vlan 99 · poe class · no carrier', state: 'down', tone: 'danger' },
  { kind: 'port', device: 'sw-lake-1', port: '1/3/4', desc: 'ct-scanner-b', summary: 'access vlan 848 · no poe · MAB', state: 'up', tone: 'success' },
  { kind: 'port', device: 'sw-wh1-1', port: '1/1/9', desc: 'badge-reader-14', summary: 'access vlan 860 · poe 3.2 W · MAB', state: 'up', tone: 'success' },
];

/** VLANs & roles — the `vlans` array (7 rows). */
export const VLANS: VlanObject[] = [
  { kind: 'vlan', id: '8', name: 'mgmt', detail: '10.42.8.0/24 · switch management', role: 'infra' },
  { kind: 'vlan', id: '12', name: 'transit-wan', detail: '10.42.12.0/30 · core to gateway', role: 'infra' },
  { kind: 'vlan', id: '812', name: 'guest-wifi', detail: '10.42.12.0/23 · 92% of leases used', role: 'Guest' },
  { kind: 'vlan', id: '816', name: 'voice', detail: '10.42.16.0/24 · lldp-med voice', role: 'Voice' },
  { kind: 'vlan', id: '820', name: 'clinical-devices', detail: '10.42.30.0/23 · pumps, tablets', role: 'Clinical' },
  { kind: 'vlan', id: '848', name: 'imaging', detail: '10.48.30.0/24 · CT, x-ray carts', role: 'Medical' },
  { kind: 'vlan', id: '860', name: 'building-systems', detail: '10.60.2.0/24 · doors, HVAC', role: 'Building' },
];

/** Queued changes — the `queue` array (3 rows). The NET-4188 row stays
 *  console-bound on purpose: DFS exclusion is an RF-profile change, which the
 *  Mist direct SSID write path refuses — "Mist is no longer read-only" does
 *  not make every Mist change portal-writable. */
export const QUEUED_CHANGES: QueuedChangeRow[] = [
  { state: 'ready', tone: 'success', what: 'Add DHCP helper 10.44.0.20 to vlan 812', where: '2 core switches · local collector', ticket: 'NET-4166' },
  { state: 'needs window', tone: 'warning', what: 'Tunnel MTU 1400 on mc-lake-3', where: 'AOS-8 · window 01:00–04:00', ticket: 'NET-4149' },
  { state: 'console', tone: 'neutral', what: 'Exclude DFS channels on clinical-floors', where: 'Mist · RF profile, opens in console', ticket: 'NET-4188' },
];

/** "Where a change can go" capability matrix — the `capability` array (6 rows). */
export const CAPABILITY_MATRIX: CapabilityRow[] = [
  { plane: 'HPE Aruba Central', note: 'wlan, groups, templates', mode: 'brokered', tone: 'accent', linked: true, planeId: 'central' },
  { plane: 'Local switch collector', note: 'ports, vlans, aaa', mode: 'brokered', tone: 'accent', linked: true, planeId: 'local' },
  { plane: 'AOS-8 master', note: 'recorded shell, window only', mode: 'ssh', tone: 'accent', linked: true, planeId: 'aos8' },
  { plane: 'Mist', note: 'reviewed SSID writes, no ticket', mode: 'direct', tone: 'accent', linked: true, planeId: 'mist' },
  { plane: 'Central Classic', note: 'retiring 12 Aug', mode: 'read only', tone: 'neutral', linked: true, planeId: 'classic' },
  { plane: 'ClearPass', note: 'policy edited in ClearPass', mode: 'read only', tone: 'neutral', linked: true, planeId: 'clearpass' },
];

/** What the write broker can actually do per plane — the single source the
 *  capability matrix and the Systems scope badge must both read, so the two
 *  screens can never disagree. Central is the brokered write target, the
 *  local collector and the AOS-8 master write over recorded SSH, everything
 *  else is read only. */
export const PLANE_WRITE_MODE: Record<PlaneKey, WriteMode> = {
  central: 'brokered',
  aos10: 'brokered', // brokered through Central, not separately credentialed
  local: 'ssh',
  aos8: 'ssh',
  classic: 'read only',
  // Mist's SSID write path is the reviewed direct apply (Configure's SSID
  // drawer → /sites/{site}/wlans), never the ticketed broker — 'read only'
  // here is accurate for the broker's vocabulary. The real capability is
  // claimed by the adapter via PlaneCapabilities.directWrite and granted per
  // deployment through the plane's write scope, exactly like SSE below.
  mist: 'read only',
  greenlake: 'read only',
  clearpass: 'read only',
  uxi: 'read only',
  // SSE's write path is its own object CRUD + automatic commit (Systems ->
  // Configuration tab), never a ticketed queue and never part of the
  // Configure screen's port/SSID/VLAN capability matrix — 'read only' here is
  // accurate for BOTH of those vocabularies. Real write capability is
  // reported separately via PlaneCapabilities.directWrite (state().capabilities
  // on GET /api/systems/state), which the Systems Configuration tab reads
  // directly to enable/disable its own mutation controls.
  sse: 'read only',
  opsramp: 'read only',
  edgeconnect: 'read only',
};

/**
 * Display label -> registry plane key. The server has the same mapping in the
 * other direction (services/reconcile.ts PLANE_LABEL / planeIdForLabel), but
 * that module is server-only; the web screens hold a client's `plane` as a
 * display label and need the key to ask shared helpers about it.
 *
 * 'THIRD-PARTY' resolves to null on purpose: it is not a plane the portal has
 * an adapter for, so nothing may be asserted about what it does or does not
 * model.
 */
export const PLANE_KEY_BY_LABEL: Record<Plane, PlaneKey | null> = {
  CENTRAL: 'central',
  CLASSIC: 'classic',
  MIST: 'mist',
  GREENLAKE: 'greenlake',
  'AOS-8': 'aos8',
  'AOS-10': 'aos10',
  LOCAL: 'local',
  CLEARPASS: 'clearpass',
  UXI: 'uxi',
  SSE: 'sse',
  OPSRAMP: 'opsramp',
  EDGECONNECT: 'edgeconnect',
  'THIRD-PARTY': null,
};

// -- Edit-drawer form seeds & select options (state + option arrays) ---------

/** Initial form models from the component state. */
export const DEFAULT_SSID_FORM: SsidForm = {
  name: 'MRDN-Staff', vlan: '820', security: 'wpa3-enterprise', group: 'clinical-floors',
  bands: '5+6', broadcast: true, isolate: false, noDfs: true, plane: 'CENTRAL + MIST',
};

export const DEFAULT_PORT_FORM: PortForm = {
  device: 'sw-core-a', id: '1/1/14', desc: 'ap-3f-12', mode: 'access', vlan: '812',
  poe: true, dot1x: true, mab: false, up: true,
};

export const DEFAULT_VLAN_FORM: VlanForm = {
  plane: 'CENTRAL', id: '812', name: 'guest-wifi', helpers: '10.42.0.20', scope: 'cx-campus-01',
};

/** Security select labels — `secLabel` keyed by security value. */
export const SSID_SECURITY_OPTIONS: SelectOption[] = [
  { value: 'wpa3-enterprise', label: 'WPA3-Enterprise (802.1X)' },
  { value: 'wpa2-enterprise', label: 'WPA2-Enterprise (802.1X)' },
  { value: 'psk-portal', label: 'PSK + captive portal' },
  { value: 'wpa2-psk', label: 'WPA2-PSK' },
  { value: 'open', label: 'Open (no encryption)' },
];

export const SSID_GROUP_OPTIONS: SelectOption[] = [
  { value: 'clinical-floors', label: 'clinical-floors (268 APs)' },
  { value: 'staff-wireless', label: 'staff-wireless (96 APs)' },
  { value: 'guest-lobby', label: 'guest-lobby (24 APs)' },
  { value: 'lakeshore-medical', label: 'lakeshore-medical (44 APs, AOS-8)' },
  { value: 'all-sites', label: 'all sites (268 APs, every plane)' },
];

/**
 * The SSID editor's demo catalog — what "New SSID" and "Edit SSID" load
 * instead of a live Central read when the portal is in demo mode. Every
 * section is populated (`unavailable: []`) so the demo drawer always shows a
 * complete review, matching the authored estate's SSID_GROUP_OPTIONS groups
 * reshaped across the four real scope categories.
 */
export const SSID_CATALOG_DEMO: SsidCatalog = {
  scopes: [
    { id: 'staff-wireless', label: 'staff-wireless (96 APs)', category: 'site' },
    { id: 'guest-lobby', label: 'guest-lobby (24 APs)', category: 'site' },
    { id: 'clinical-floors', label: 'clinical-floors (268 APs)', category: 'site-collection' },
    { id: 'all-sites', label: 'all sites (268 APs, every plane)', category: 'site-collection' },
    { id: 'lakeshore-medical', label: 'lakeshore-medical (44 APs, AOS-8)', category: 'ap-group' },
    { id: 'ap-3f-12', label: 'ap-3f-12 (3rd floor, clinical)', category: 'ap' },
  ],
  roles: [
    { id: 'authenticated', label: 'authenticated' },
    { id: 'guest', label: 'guest' },
    { id: 'clinical-device', label: 'clinical-device' },
  ],
  authServerGroups: [
    { id: 'clearpass', label: 'clearpass (RadSec)' },
    { id: 'clearpass-guest', label: 'clearpass-guest' },
  ],
  captivePortalProfiles: [{ id: 'guest-portal-meridian', label: 'guest-portal-meridian' }],
  unavailable: [],
  source: 'Central demo catalog (network-config/v1alpha1)',
};

/**
 * The Mist half of the demo catalog — what "Edit" on a Mist SSID loads when
 * the portal is in demo mode. Mist WLANs are SITE-scoped, so the only scope
 * category on offer is the demo estate's two Mist sites, and the Central
 * dependency sections (roles, server groups, portal profiles) are genuinely
 * absent rather than unavailable — Mist has no such catalogs.
 */
export const SSID_CATALOG_DEMO_MIST: SsidCatalog = {
  scopes: [
    { id: 'campus-02', label: 'Campus-02 Research', category: 'site' },
    { id: 'northgate', label: 'Northgate Clinic', category: 'site' },
  ],
  roles: [],
  authServerGroups: [],
  captivePortalProfiles: [],
  unavailable: [],
  source: 'Mist demo catalog (sites/{site}/wlans)',
};

export const SSID_BAND_OPTIONS: SelectOption[] = [
  { value: '5+6', label: '5 GHz + 6 GHz' },
  { value: 'all', label: '2.4 + 5 + 6 GHz' },
  { value: '5', label: '5 GHz only' },
];

export const PORT_DEVICE_OPTIONS: SelectOption[] = [
  'sw-core-a', 'sw-core-b', 'sw-acc-3f-2', 'sw-acc-3f-3', 'sw-lake-1', 'sw-wh1-1', 'sw-riv-1',
].map((d) => ({ value: d, label: d }));

export const PORT_MODE_OPTIONS: SelectOption[] = [
  { value: 'access', label: 'Access port' },
  { value: 'trunk', label: 'Trunk port' },
];

export const VLAN_SCOPE_OPTIONS: SelectOption[] = [
  { value: 'cx-campus-01', label: 'CX switches at Campus-01 (42)' },
  { value: 'cx-all', label: 'Every CX switch (96)' },
  { value: 'core-only', label: 'Core switches only (2)' },
];

/** Drawer title / description per object kind — `titles` / `descs`. */
export const CONFIG_EDIT_TITLES: Record<string, string> = {
  ssid: 'Wireless SSID',
  port: 'Switch port',
  vlan: 'VLAN',
};

export const CONFIG_EDIT_DESCS: Record<string, string> = {
  ssid: 'Written directly to the selected plane — Central or Mist — after review.',
  port: 'Pushed over the recorded SSH session on the local collector, with a rollback snapshot.',
  vlan: 'Applied to every switch in the selected scope through the local collector.',
};

/** Mono note under the queue buttons, per object kind — `pushNote`. */
export const CONFIG_PUSH_NOTES: Record<string, string> = {
  ssid: 'Central and Mist both accept this push directly — reviewed, audited, and written to the selected scope.',
  port: 'Pushed over the recorded SSH session; every keystroke and the resulting diff are attached to the ticket.',
  vlan: 'Applied switch by switch with a verify step between each; the run stops on the first mismatch.',
};

/** Success-alert body after queueing — `queuedNote` template. */
export function queuedChangeNote(ticket: string): string {
  return 'Change queued against ' + (ticket || 'the ticket') + '. The write lease opens for fifteen minutes when you push the queue; a rollback snapshot is kept for 24 hours.';
}

// ---------------------------------------------------------------------------
// Compliance — NtCompliance.dc.html
// ---------------------------------------------------------------------------

/** Stat row, from the markup (5 stats). */
export const COMPLIANCE_STATS: StatDef[] = [
  { label: 'Checks last run', value: '1,842', delta: '09:05 today', tone: 'neutral' },
  { label: 'Devices in scope', value: '404', delta: '14 unreachable', tone: 'negative' },
  { label: 'Findings', value: '12', delta: '▼ 4 this week', tone: 'positive' },
  { label: 'Sites clean', value: '6 / 10', delta: '▲ 1', tone: 'positive' },
  { label: 'Auto-remediable', value: '7', delta: 'of 12 findings', tone: 'neutral' },
];

/** Findings — the `findings` array (10 rows). base→baseline. */
export const FINDINGS: FindingRow[] = [
  { sev: 'high', tone: 'danger', title: 'Tunnel MTU 1500 where path MTU is 1400', detail: 'causes the AP tunnel resets seen at Lakeshore', rule: 'wlan.tunnel.mtu', plane: 'AOS-8', count: '2', fix: 'auto', fixColor: 'var(--nd-success)', device: 'mm-lake-1', baseline: 'AOS-8 controller' },
  { sev: 'high', tone: 'danger', title: 'Admin fallback account with local password', detail: 'found on 3 legacy switches at Warehouse-DC2', rule: 'aaa.local.fallback', plane: 'CLASSIC', count: '3', fix: 'manual', fixColor: 'var(--nd-warning)', device: 'sw-wh2-1', baseline: 'CX switch' },
  { sev: 'med', tone: 'warning', title: 'vlan 812 missing DHCP helper 10.44.0.20', detail: 'guest onboarding retries when the primary is busy', rule: 'dhcp.helpers.count', plane: 'LOCAL', count: '2', fix: 'auto', fixColor: 'var(--nd-success)', device: 'sw-core-a', baseline: 'CX switch' },
  { sev: 'med', tone: 'warning', title: 'Single NTP server configured', detail: 'baseline expects two, drift since the 10.11 image', rule: 'ntp.servers.min', plane: 'LOCAL', count: '6', fix: 'auto', fixColor: 'var(--nd-success)', device: 'sw-acc-3f-2', baseline: 'CX switch' },
  { sev: 'med', tone: 'warning', title: 'Firmware behind approved train', detail: '10.11.1030 installed, 10.13.1005 approved', rule: 'fw.approved.version', plane: 'LOCAL', count: '6', fix: 'window', fixColor: 'var(--nd-text-muted)', device: 'sw-acc-3f-2', baseline: 'CX switch' },
  { sev: 'med', tone: 'warning', title: 'DFS channels permitted on clinical floors', detail: 'radar events keep moving clients between APs', rule: 'rf.dfs.exclude', plane: 'MIST', count: '14', fix: 'auto', fixColor: 'var(--nd-success)', device: 'ap-3f-12', baseline: 'Wireless RF' },
  { sev: 'med', tone: 'warning', title: 'RadSec certificate expires within 30 days', detail: 'cppm-01 to Mist org trust breaks on 15 Aug', rule: 'pki.expiry.min', plane: 'CLEARPASS', count: '1', fix: 'manual', fixColor: 'var(--nd-warning)', device: 'cppm-01', baseline: 'ClearPass' },
  { sev: 'low', tone: 'info', title: 'Interface descriptions missing', detail: '18 access ports with no description string', rule: 'port.description', plane: 'LOCAL', count: '18', fix: 'auto', fixColor: 'var(--nd-success)', device: 'sw-acc-3f-2', baseline: 'CX switch' },
  { sev: 'low', tone: 'info', title: 'Syslog pointing at the retired collector', detail: '10.42.0.5 decommissioned in April', rule: 'logging.target', plane: 'LOCAL', count: '9', fix: 'auto', fixColor: 'var(--nd-success)', device: 'sw-core-b', baseline: 'CX switch' },
  { sev: 'low', tone: 'info', title: 'Device state unverified — plane is stale', detail: '24 Riverside devices cannot be scanned via Classic', rule: 'scan.coverage', plane: 'CLASSIC', count: '24', fix: 'ssh scan', fixColor: 'var(--nd-text-muted)', device: 'sw-riv-1', baseline: 'CX switch' },
];

/** "Pass rate by baseline" — the `baselines` array (5 rows). */
export const BASELINE_PROGRESS: BaselineProgressRow[] = [
  { label: 'CX switch baseline', value: 91, note: '96 devices · 8 findings · last edited 12 Jul' },
  { label: 'Wireless RF baseline', value: 86, note: '268 APs · 1 finding · clinical floors stricter' },
  { label: 'AOS-8 controller baseline', value: 74, note: '4 controllers · 2 findings · frozen until migration' },
  { label: 'ClearPass baseline', value: 96, note: '2 nodes · 1 finding · certificate expiry' },
  { label: 'Gateway baseline', value: 88, note: '8 gateways · 1 finding · MTU' },
];

/** "Drift, as text" — the static `diff` string. */
export const COMPLIANCE_DIFF: string =
  'vlan 812\n    name guest-wifi\n    ip helper-address 10.42.0.20\n-   ip helper-address 10.44.0.20     <- baseline\n+   (missing on sw-core-a, sw-core-b)\n\nntp server 10.42.0.20 iburst\n-   ntp server 10.44.0.20 iburst     <- baseline\n\ninterface 1/1/22\n-   description uxi-cam01-2\n+   (no description)';

// ---------------------------------------------------------------------------
// Connected systems — NtSystems.dc.html
// ---------------------------------------------------------------------------

/** Planes — the `systems` array (7 rows, full detail-drawer data).
 *  Every cloud/on-prem plane carries the console it is administered in
 *  (`consoleUrl`); the local switch collector deliberately carries none — it
 *  has no console, so "Open console" must stay inert for it rather than
 *  pretend a hand-off exists. */
export const SYSTEMS: SystemRow[] = [
  {
    name: 'HPE Aruba Central', kind: 'cloud · new central · us-west-4', state: 'healthy', tone: 'success', scope: 'read + broker', scopeTone: 'accent', scopeNote: 'write expires per change',
    consoleUrl: 'https://app-us4.central.arubanetworks.com',
    facts: [{ k: 'Last sync', v: '40s ago' }, { k: 'Devices', v: '164' }, { k: 'Calls today', v: '9,412 / 50k' }, { k: 'Token', v: 'rotates 12 Aug' }],
    sites: [
      { name: 'Campus-01 — Meridian HQ', siteId: 'campus-01', detail: '148 devices · wireless + gateways' },
      { name: 'Northgate Clinic', siteId: 'northgate', detail: '16 devices' },
      { name: 'Remote & VPN users', siteId: 'remote-vpn', detail: '2 gateways · 168 RAPs' },
    ],
    live: [{ value: '2,472', label: 'client sessions reported by this plane' }, { value: '164', label: 'devices claimed' }, { value: '4', label: 'open alerts sourced here' }],
    calls: [
      { time: '09:41', path: 'GET /monitoring/v2/aps?site=campus-01', ms: '212 ms', code: '200', tone: 'success' },
      { time: '09:41', path: 'GET /monitoring/v1/switches', ms: '188 ms', code: '200', tone: 'success' },
      { time: '09:40', path: 'GET /monitoring/v1/clients?limit=500', ms: '431 ms', code: '200', tone: 'success' },
      { time: '09:39', path: 'GET /configuration/v1/dhcp_scopes', ms: '96 ms', code: '200', tone: 'success' },
      { time: '09:38', path: 'POST /oauth2/token (refresh)', ms: '77 ms', code: '200', tone: 'success' },
      { time: '09:36', path: 'GET /central/v2/alerts?from=09:00', ms: '140 ms', code: '200', tone: 'success' },
    ],
    events: [
      { time: '09:22', what: 'Brokered write accepted — vlan 812 helper pushed to 2 switches', who: 'r.okafor · ticket NET-4166' },
      { time: '07:15', what: 'Gateway cluster failover test recorded', who: 'j.alvarez' },
      { time: 'Yest.', what: 'Token rotated automatically, 30-day cycle', who: 'portal vault' },
    ],
    pulls: [
      { what: 'Device inventory and topology', every: 'every 30s', mode: 'read', tone: 'neutral' },
      { what: 'Client sessions and roaming events', every: 'every 60s', mode: 'read', tone: 'neutral' },
      { what: 'Alerts and audit trail', every: 'stream', mode: 'read', tone: 'neutral' },
      { what: 'Configuration templates and groups', every: 'every 10m', mode: 'read', tone: 'neutral' },
      { what: 'Config push (vlan, port, template)', every: 'on change', mode: 'write', tone: 'accent' },
    ],
    configText: 'plane: central\nbase_url: us4.api.central.arubanetworks.com\nclient_id: a41f9c02-…\nsecret: vault://meridian/central/prod\nscopes: [inventory, clients, alerts, config.read, config.write]\nwrite_broker: ticket_required=true lease=15m\nrate_limit: 50000/day (used 9412)\nretention: 30d events, 90d config snapshots',
  },
  {
    name: 'Mist', kind: 'cloud · global 01 · org meridian', state: 'healthy', tone: 'success', scope: 'read only', scopeTone: 'neutral', scopeNote: 'write via console',
    consoleUrl: 'https://manage.mist.com',
    facts: [{ k: 'Last sync', v: '1m ago' }, { k: 'Devices', v: '128' }, { k: 'Calls today', v: '4,105 / 20k' }, { k: 'Token', v: 'rotates 01 Sep' }],
    sites: [
      { name: 'Campus-02 Research', siteId: 'campus-02', detail: '96 devices · AP43 + EX4400' },
      { name: 'Northgate Clinic', siteId: 'northgate', detail: '16 devices' },
      { name: 'Southpoint Clinic', siteId: 'southpoint', detail: '15 devices' },
    ],
    live: [{ value: '1,472', label: 'client sessions reported by this plane' }, { value: '128', label: 'devices claimed' }, { value: '1', label: 'open alert sourced here' }],
    calls: [
      { time: '09:41', path: 'GET /api/v1/sites/:id/stats/devices', ms: '164 ms', code: '200', tone: 'success' },
      { time: '09:40', path: 'GET /api/v1/sites/:id/stats/clients', ms: '302 ms', code: '200', tone: 'success' },
      { time: '09:37', path: 'WS /api/v1/subscribe (alarms)', ms: 'reconnect', code: '101', tone: 'warning' },
      { time: '09:35', path: 'GET /api/v1/orgs/:id/inventory', ms: '221 ms', code: '200', tone: 'success' },
    ],
    events: [
      { time: '08:47', what: 'WLAN MRDN-Guest PSK rotation observed', who: 'mist automation' },
      { time: '07:41', what: 'DFS radar events on two APs pulled into ticket NET-4188', who: 'portal correlation' },
    ],
    pulls: [
      { what: 'Device inventory and org claims', every: 'every 60s', mode: 'read', tone: 'neutral' },
      { what: 'Client sessions, SLE metrics', every: 'every 60s', mode: 'read', tone: 'neutral' },
      { what: 'Alarm stream', every: 'websocket', mode: 'read', tone: 'neutral' },
      { what: 'Configuration (read-only mirror)', every: 'every 15m', mode: 'read', tone: 'neutral' },
    ],
    configText: 'plane: mist\napi_host: api.mist.com\norg_id: 4f2a77c1-…\ntoken: vault://meridian/mist/readonly\nscopes: [read:inventory, read:clients, read:alarms, read:config]\nwrite_broker: disabled — changes go out in the Mist console\nrate_limit: 20000/day (used 4105)\nretention: 30d events',
  },
  {
    name: 'Central Classic', kind: 'legacy cloud · eu-central', state: 'degraded', tone: 'danger', scope: 'read only', scopeTone: 'neutral', scopeNote: '429 every third poll',
    consoleUrl: 'https://eu-central.classic.arubanetworks.com',
    facts: [{ k: 'Last sync', v: '6h 12m ago' }, { k: 'Devices', v: '40 (stale)' }, { k: 'Calls today', v: '812 / 1k' }, { k: 'Retires', v: '12 Aug 26' }],
    sites: [
      { name: 'Riverside Clinic', siteId: 'riverside', detail: '24 devices · unverified' },
      { name: 'Warehouse-DC2', siteId: 'warehouse-dc2', detail: '16 devices · stale 6h' },
    ],
    live: [{ value: '266', label: 'client sessions last reported (03:12)' }, { value: '40', label: 'devices claimed, state unverified' }, { value: '2', label: 'open alerts sourced here' }],
    calls: [
      { time: '09:38', path: 'GET /monitoring/v1/switches', ms: '—', code: '429', tone: 'danger' },
      { time: '09:28', path: 'GET /monitoring/v1/switches', ms: '—', code: '429', tone: 'danger' },
      { time: '09:18', path: 'GET /monitoring/v1/aps', ms: '904 ms', code: '200', tone: 'success' },
      { time: '03:12', path: 'GET /monitoring/v1/clients', ms: '1.2 s', code: '200', tone: 'success' },
    ],
    events: [
      { time: '09:38', what: 'Backed off to a 10-minute interval, queue depth 41', who: 'portal collector' },
      { time: '09:05', what: 'Two API clients found sharing one token quota', who: 'greenlake audit' },
      { time: '06:40', what: 'Fallback SSH probe verified all 24 Riverside devices', who: 'collector-04' },
    ],
    pulls: [
      { what: 'Device inventory', every: 'every 10m (throttled)', mode: 'read', tone: 'warning' },
      { what: 'Client sessions', every: 'paused', mode: 'read', tone: 'warning' },
      { what: 'Alerts', every: 'every 10m', mode: 'read', tone: 'neutral' },
    ],
    configText: 'plane: central-classic\nbase_url: eu-central.classic.arubanetworks.com\nclient_id: legacy-portal-01\nsecret: vault://meridian/classic/legacy\nscopes: [read:inventory, read:alerts]\nrate_limit: 1000/day (used 812) — SHARED with legacy-scripts\nbackoff: 600s after 429\nretires: 2026-08-12 (migrate 24 devices to Central)',
  },
  {
    name: 'GreenLake', kind: 'platform · workspace meridian-health', state: 'healthy', tone: 'success', scope: 'read only', scopeTone: 'neutral', scopeNote: 'licences + users',
    consoleUrl: 'https://common.cloud.hpe.com',
    facts: [{ k: 'Last sync', v: '4m ago' }, { k: 'Subscriptions', v: '486' }, { k: 'Calls today', v: '210 / 5k' }, { k: 'Token', v: 'rotates 30 Sep' }],
    sites: [{ name: 'Workspace-wide', siteId: null, detail: 'licences, users, audit' }],
    live: [{ value: '486', label: 'subscription records reconciled' }, { value: '34', label: 'expiring within 60 days' }, { value: '6', label: 'orphaned assignments found' }],
    calls: [
      { time: '09:35', path: 'GET /subscriptions/v1/assignments', ms: '340 ms', code: '200', tone: 'success' },
      { time: '09:35', path: 'GET /devices/v1/inventory', ms: '288 ms', code: '200', tone: 'success' },
      { time: '09:20', path: 'GET /identity/v1/users', ms: '120 ms', code: '200', tone: 'success' },
    ],
    events: [
      { time: '09:35', what: 'Reconciliation found 6 orphan AP subscriptions', who: 'portal reconciler' },
      { time: 'Mon', what: 'Workspace role added for the portal service principal', who: 'admin@meridian' },
    ],
    pulls: [
      { what: 'Subscriptions and assignments', every: 'every 5m', mode: 'read', tone: 'neutral' },
      { what: 'Device-to-licence mapping', every: 'every 5m', mode: 'read', tone: 'neutral' },
      { what: 'Users and workspace roles', every: 'every 30m', mode: 'read', tone: 'neutral' },
    ],
    configText: 'plane: greenlake\nworkspace: wks-meridian-health\nclient_id: gl-portal-svc\nsecret: vault://meridian/greenlake/svc\nscopes: [read:subscriptions, read:devices, read:identity]\nrate_limit: 5000/day (used 210)\nretention: 400d subscription history',
  },
  {
    name: 'AOS-8 mobility master', kind: 'on-prem · mm-lake-1 · 8.10.0.10', state: 'warning', tone: 'warning', scope: 'read + ssh', scopeTone: 'accent', scopeNote: 'jump host 10.48.0.9',
    consoleUrl: 'https://10.48.0.10:4343',
    facts: [{ k: 'Last sync', v: '2m ago' }, { k: 'Devices', v: '62' }, { k: 'Cluster', v: '1 of 4 up' }, { k: 'Auth', v: 'tacacs + key' }],
    sites: [
      { name: 'Lakeshore Medical Center', siteId: 'lakeshore', detail: '62 devices · master-local' },
      { name: 'Airport Annex', siteId: 'airport-annex', detail: '21 devices · 1 local' },
    ],
    live: [{ value: '744', label: 'client sessions terminated on controllers' }, { value: '62', label: 'devices claimed' }, { value: '3', label: 'open alerts sourced here' }],
    calls: [
      { time: '09:40', path: 'GET /v1/configuration/showcommand?show+switches', ms: '540 ms', code: '200', tone: 'success' },
      { time: '09:39', path: 'GET /v1/configuration/showcommand?show+ap+database', ms: '612 ms', code: '200', tone: 'success' },
      { time: '09:38', path: 'SSH show datapath tunnel (jump host)', ms: '1.1 s', code: 'ok', tone: 'success' },
      { time: '09:36', path: 'GET /v1/configuration/showcommand?show+switch+ip', ms: '—', code: 'timeout', tone: 'warning' },
    ],
    events: [
      { time: '09:00', what: 'Three locals stopped answering heartbeat', who: 'mm-lake-1' },
      { time: '19 Jul', what: 'Tunnel MTU corrected on mc-lake-4 under change window', who: 'j.alvarez' },
    ],
    pulls: [
      { what: 'Cluster and AP database', every: 'every 2m', mode: 'read', tone: 'neutral' },
      { what: 'Client table per controller', every: 'every 2m', mode: 'read', tone: 'neutral' },
      { what: 'Datapath and tunnel state (SSH)', every: 'every 5m', mode: 'read', tone: 'neutral' },
      { what: 'Recorded shell for changes', every: 'on demand', mode: 'ssh', tone: 'accent' },
    ],
    configText: 'plane: aos8\nmaster: 10.48.0.10:4343\njump_host: 10.48.0.9 (session recording on)\nauth: tacacs+ for api, vault-issued key for ssh\nscopes: [read:cluster, read:clients, ssh:recorded]\nchange_window: 01:00–04:00 local only\nretention: 90d session recordings',
  },
  {
    name: 'Local switch collector', kind: 'on-prem agent · ssh · 5 sites', state: 'healthy', tone: 'success', scope: 'read + ssh', scopeTone: 'accent', scopeNote: 'session recording on',
    facts: [{ k: 'Last sync', v: '30s ago' }, { k: 'Devices', v: '96' }, { k: 'Agents', v: '5 online' }, { k: 'Auth', v: 'vault-issued key' }],
    sites: [
      { name: 'Campus-01 — Meridian HQ', siteId: 'campus-01', detail: '42 switches' },
      { name: 'Warehouse-DC1', siteId: 'warehouse-dc1', detail: '14 switches · only plane here' },
      { name: 'Riverside Clinic', siteId: 'riverside', detail: '8 switches · fallback for Classic' },
    ],
    live: [{ value: '572', label: 'wired client sessions from MAC tables' }, { value: '96', label: 'switches polled over SSH' }, { value: '14', label: 'devices in no cloud plane' }],
    calls: [
      { time: '09:41', path: 'ssh sw-core-a · show interface brief', ms: '410 ms', code: 'ok', tone: 'success' },
      { time: '09:41', path: 'ssh sw-acc-3f-2 · show mac-address', ms: '380 ms', code: 'ok', tone: 'success' },
      { time: '09:40', path: 'ssh sw-wh1-1 · show stack', ms: '520 ms', code: 'warn', tone: 'warning' },
      { time: '09:40', path: 'ssh sw-riv-1 · show running-config', ms: '1.4 s', code: 'ok', tone: 'success' },
    ],
    events: [
      { time: '09:22', what: 'Brokered write — vlan 812 helper added to two switches', who: 'r.okafor · recorded' },
      { time: '02:04', what: 'Inventory delta at Warehouse-DC1: stack member 3 missing', who: 'collector-05' },
    ],
    pulls: [
      { what: 'Interfaces, VLANs, LLDP, MAC tables', every: 'every 30s', mode: 'read', tone: 'neutral' },
      { what: 'Running config snapshots', every: 'every 6h', mode: 'read', tone: 'neutral' },
      { what: 'Firmware and hardware inventory', every: 'every 1h', mode: 'read', tone: 'neutral' },
      { what: 'Recorded shell and config push', every: 'on demand', mode: 'ssh', tone: 'accent' },
    ],
    configText: 'plane: local-collector\nagents: collector-01,03,04,05,06 (dial-out)\nauth: vault-issued ed25519 keys, 24h leases\nscopes: [read:cli, ssh:recorded, config:push_with_ticket]\nsnapshot: every 6h, diffed against baseline\nrecording: full keystroke + output, 90d\nfallback_for: central-classic (Riverside)',
  },
  {
    name: 'ClearPass', kind: 'on-prem · cppm-01 · 6.11.7', state: 'healthy', tone: 'success', scope: 'read only', scopeTone: 'neutral', scopeNote: 'auth telemetry',
    consoleUrl: 'https://cppm-01.meridian.health/tips',
    facts: [{ k: 'Last sync', v: '55s ago' }, { k: 'Endpoints', v: '4,182' }, { k: 'Calls today', v: '1,904' }, { k: 'Cert', v: 'expires 15 Aug' }],
    sites: [{ name: 'Workspace-wide', siteId: null, detail: 'policy for every plane' }],
    live: [{ value: '412', label: 'authentications per minute' }, { value: '24', label: 'rejects in the last hour' }, { value: '4,182', label: 'known endpoints' }],
    calls: [
      { time: '09:41', path: 'GET /api/session?filter=recent', ms: '180 ms', code: '200', tone: 'success' },
      { time: '09:40', path: 'GET /api/endpoint?limit=500', ms: '260 ms', code: '200', tone: 'success' },
      { time: '09:31', path: 'GET /api/insight/endpoint/auth-events', ms: '310 ms', code: '200', tone: 'success' },
    ],
    events: [
      { time: '09:31', what: 'Seven rejects from one unknown endpoint, moved to Quarantine', who: 'policy engine' },
      { time: '22 Jul', what: 'Guest role rewritten — captive portal timeout raised', who: 'j.alvarez' },
    ],
    pulls: [
      { what: 'Auth and accounting events', every: 'every 60s', mode: 'read', tone: 'neutral' },
      { what: 'Endpoint profiles and roles', every: 'every 5m', mode: 'read', tone: 'neutral' },
      { what: 'Service and policy definitions', every: 'every 30m', mode: 'read', tone: 'neutral' },
    ],
    configText: 'plane: clearpass\npublisher: cppm-01.meridian.health\nclient_id: portal-insight\nsecret: vault://meridian/clearpass/insight\nscopes: [read:session, read:endpoint, read:policy]\nradsec_cert: expires 2026-08-15 (renew)\nretention: 30d auth events in portal, 180d on box',
  },
  {
    name: 'UXI', kind: 'cloud · sensors · cape networks', state: 'warning', tone: 'warning', scope: 'read only', scopeTone: 'neutral', scopeNote: 'history is push-only',
    consoleUrl: 'https://dashboard.capenetworks.com',
    facts: [{ k: 'Last sync', v: '50s ago' }, { k: 'Sensors', v: '8' }, { k: 'Calls today', v: '1,240' }, { k: 'Token', v: 'sso · hourly' }],
    sites: [
      { name: 'Campus-01 — Meridian HQ', siteId: 'campus-01', detail: '5 sensors · one offline (3F)' },
      { name: 'Campus-02 Research', siteId: 'campus-02', detail: '3 sensors' },
    ],
    live: [{ value: '8', label: 'sensors reporting' }, { value: '1', label: 'sensor offline — uxi-cam01-2' }, { value: '3', label: 'open synthetic-test issues' }],
    calls: [
      { time: '09:41', path: 'GET /networking-uxi/v1alpha1/sensors', ms: '204 ms', code: '200', tone: 'success' },
      { time: '09:41', path: 'GET /sensors/:id/status ×8', ms: '96–310 ms', code: '200', tone: 'success' },
      { time: '09:02', path: 'POST sso.common.cloud.hpe.com/as/token.oauth2', ms: '182 ms', code: '200', tone: 'success' },
    ],
    events: [
      { time: '08:12', what: 'Sensor uxi-cam01-2 stopped reporting — port shows no carrier', who: 'portal correlation' },
      { time: '21 Jul', what: 'DHCP synthetic test failing on clinical-ssid, pulled into NET-4188', who: 'portal correlation' },
    ],
    pulls: [
      { what: 'Sensor roster and online state', every: 'every 60s', mode: 'read', tone: 'neutral' },
      { what: 'Per-sensor status and ongoing issues', every: 'every 60s', mode: 'read', tone: 'neutral' },
      { what: 'Historical test results', every: 'n/a — push destinations only', mode: 'read', tone: 'neutral' },
    ],
    configText: 'plane: uxi\napi_base: api.capenetworks.com\nauth: sso.common.cloud.hpe.com client credentials\nclient_id: portal-uxi-read\nsecret: vault://meridian/uxi/readonly\nscopes: [read:sensors, read:status]\nhistory: push-only (S3 destination) — the portal never fakes a results pull\nrate_limit: 5 req/s, status reads sequential',
  },
];

/** Sync history — the `history` array (7 rows). */
export const SYNC_HISTORY: SyncHistoryRow[] = [
  { time: '09:41', system: 'central', what: 'Inventory delta — 2 devices changed state', result: 'ok', tone: 'success' },
  { time: '09:40', system: 'local ssh', what: '96 switches polled, 1 stack member still missing', result: 'ok', tone: 'success' },
  { time: '09:38', system: 'classic', what: 'Poll rejected — HTTP 429, backing off 600s', result: '429', tone: 'danger' },
  { time: '09:37', system: 'mist', what: 'Alarm stream reconnected after keepalive timeout', result: 'ok', tone: 'success' },
  { time: '09:36', system: 'aos-8', what: 'Cluster state read — 3 locals still without heartbeat', result: 'warn', tone: 'warning' },
  { time: '09:35', system: 'greenlake', what: 'Subscription reconciliation — 6 orphans found', result: 'ok', tone: 'success' },
  { time: '09:31', system: 'clearpass', what: 'Auth telemetry batch, 1,904 records', result: 'ok', tone: 'success' },
];

/** Permissions model — the `perms` array (4 rows). */
export const PERMISSIONS: PermissionRow[] = [
  { mode: 'read', tone: 'neutral', what: 'Inventory, clients, auth events, configuration, licences — all seven planes' },
  { mode: 'broker', tone: 'accent', what: 'Config push to Central and the local collector, ticket-stamped' },
  { mode: 'ssh', tone: 'accent', what: 'Recorded shell to CX switches and AOS-8, 15-minute leases' },
  { mode: 'none', tone: 'warning', what: 'No write access to Mist or Classic — changes go out in their consoles' },
];

/** Transitional flat-drawer exports, all derived from the typed product catalog. */
export const CONNECT_TYPE_OPTIONS: SelectOption[] = CONNECTOR_CATALOG.map(({ id, label }) => ({
  value: id,
  label,
}));

export const MIST_REGIONS: SelectOption[] = [
  ...(connectorCatalogEntry('mist').endpoint.options ?? []),
];

export const CENTRAL_CLUSTERS: SelectOption[] = [
  ...(connectorCatalogEntry('central').endpoint.options ?? []),
];

export const CONNECT_ENDPOINTS = Object.fromEntries(
  CONNECTOR_CATALOG.map(({ id, endpoint }) => [id, {
    label: connectorCatalogEntry(id).legacy.endpoint?.label ?? endpoint.label,
    help: connectorCatalogEntry(id).legacy.endpoint?.help ?? endpoint.help,
    hint: connectorCatalogEntry(id).legacy.endpoint?.hint ?? endpoint.hint,
    ...(endpoint.options ? { options: [...endpoint.options] } : {}),
  }]),
) as Record<SystemTypeKey, EndpointVariant>;

export const CONNECT_FIELDS = Object.fromEntries(
  CONNECTOR_CATALOG.map(({ id, legacy }) => [id, legacy.fields.map((field) => ({ ...field }))]),
) as Record<SystemTypeKey, ConnectField[]>;

export const CONNECT_HIDE_CLIENT_CREDENTIALS: readonly SystemTypeKey[] = CONNECTOR_CATALOG
  .filter(({ legacy }) => legacy.hideClientCredentials)
  .map(({ id }) => id);

export const CONNECT_ENDPOINT_KEY = Object.fromEntries(
  CONNECTOR_CATALOG.map(({ id, legacy }) => [id, legacy.endpointKey]),
) as Record<SystemTypeKey, string>;

// ---------------------------------------------------------------------------
// UXI sensor fleet (NtUxi) — demo data for the dedicated UXI screen.
//
// Unlike most of this file, these 8 rows are NOT extracted from a
// design/*.dc.html mockup — there is no prototype markup for a dedicated UXI
// screen. They are hand-authored to exercise every state the screen renders:
// three healthy online sensors, one with a critical active issue, one with a
// warning active issue, one offline, one whose status the sensor never
// reported (unknown), and one online sensor that is not currently testing.
// ---------------------------------------------------------------------------

export const UXI_SENSORS: UxiSensorRow[] = [
  {
    id: 'sns-01',
    name: 'uxi-meridian-lobby',
    serial: 'UXI2201A001',
    model: 'UXI Sensor V3',
    site: 'Campus-01 — Meridian HQ',
    isOnline: true,
    isTesting: true,
    issueCount: 0,
    issues: [],
    wifiMac: '3c:2a:f4:11:22:01',
    ethernetMac: null,
  },
  {
    id: 'sns-02',
    name: 'uxi-meridian-3f-east',
    serial: 'UXI2201A002',
    model: 'UXI Sensor V3',
    site: 'Campus-01 — Meridian HQ',
    isOnline: true,
    isTesting: true,
    issueCount: 0,
    issues: [],
    wifiMac: '3c:2a:f4:11:22:02',
    ethernetMac: null,
  },
  {
    id: 'sns-03',
    name: 'uxi-lakeshore-er',
    serial: 'UXI2201A003',
    model: 'UXI Sensor V3',
    site: 'Lakeshore Medical Center',
    isOnline: true,
    isTesting: true,
    issueCount: 0,
    issues: [],
    wifiMac: '3c:2a:f4:11:22:03',
    ethernetMac: null,
  },
  {
    id: 'sns-04',
    name: 'uxi-meridian-guest-wifi',
    serial: 'UXI2201A004',
    model: 'UXI Sensor V3',
    site: 'Campus-01 — Meridian HQ',
    isOnline: true,
    isTesting: true,
    issueCount: 1,
    issues: [
      {
        code: 'DNS_RESOLUTION_FAILURE',
        severity: 'critical',
        status: 'active',
        context: 'MRDN-Guest',
      },
    ],
    wifiMac: '3c:2a:f4:11:22:04',
    ethernetMac: null,
  },
  {
    id: 'sns-05',
    name: 'uxi-riverside-checkin',
    serial: 'UXI2201A005',
    model: 'UXI Sensor V3',
    site: 'Riverside Clinic',
    isOnline: true,
    isTesting: true,
    issueCount: 1,
    issues: [
      {
        code: 'HIGH_LATENCY',
        severity: 'warning',
        status: 'active',
        context: 'EHR-portal-test',
      },
    ],
    wifiMac: '3c:2a:f4:11:22:05',
    ethernetMac: null,
  },
  {
    id: 'sns-06',
    name: 'uxi-warehouse-dock',
    serial: 'UXI2201A006',
    model: 'UXI Sensor V2',
    site: 'Warehouse-DC1',
    isOnline: false,
    isTesting: false,
    issueCount: 0,
    issues: [],
    wifiMac: null,
    ethernetMac: '9c:8e:99:44:10:06',
  },
  {
    id: 'sns-07',
    name: 'uxi-meridian-basement',
    serial: 'UXI2201A007',
    model: 'UXI Sensor V3',
    site: 'Campus-01 — Meridian HQ',
    isOnline: null,
    isTesting: null,
    issueCount: 0,
    issues: [],
    wifiMac: '3c:2a:f4:11:22:07',
    ethernetMac: null,
  },
  {
    id: 'sns-08',
    name: 'uxi-lakeshore-radiology',
    serial: 'UXI2201A008',
    model: 'UXI Sensor V3',
    site: 'Lakeshore Medical Center',
    isOnline: true,
    isTesting: false,
    issueCount: 0,
    issues: [],
    wifiMac: '3c:2a:f4:11:22:08',
    ethernetMac: null,
  },
];


// ---------------------------------------------------------------------------
// Site application visibility (DPI) + hardware trends — the demo world for
// Central's ON-DEMAND reads (shared/appRisk.ts + shared/trends.ts).
//
// There is no design/*.dc.html markup for these screens yet, so — like the
// UXI roster above — these are hand-authored, coherent with the estate
// above: campus-01 is the demo's Central-claimed site, sw-core-a its
// degraded core switch, ap-1f-04 one of its Central APs.
//
// The RAW wire shapes are what is authored; the exported payloads are
// computed from them through the real normalizers at module load, so the
// demo world can never drift from what a live payload would produce. Every
// stamp is a fixed authored instant — demo output is deterministic.
// ---------------------------------------------------------------------------

const DPI_DEMO_NOW_MS = Date.parse('2026-07-26T12:00:00.000Z');
/** The demo read window: the 24h ending at the demo "now" (well inside the
 *  endpoint's 7-day cap). */
const DPI_DEMO_WINDOW = { start: '2026-07-25T12:00:00.000Z', end: '2026-07-26T12:00:00.000Z' };
const DPI_DEMO_SOURCE_AT = '2026-07-26T11:59:00.000Z';
const HOUR_MS = 3_600_000;
const TREND_DEMO_START_MS = Date.parse(DPI_DEMO_WINDOW.start);

/**
 * The campus-01 application table in Central's wire shape (verified field
 * names; statistics ride as strings). Dead fields are authored the way the
 * plane ships them — experience all-zero, tlsVersion/certificateExpiryDate
 * empty — and the normalizer is what turns those into honest nulls.
 */
const CAMPUS01_APPS_RAW: unknown[] = [
  { name: 'Microsoft 365', id: 'app-0365', risk: 'trusted', state: 'active', rxBytes: '4230000000', txBytes: '810000000', categories: ['Collaboration', 'Web'], applicationHostType: 'cloud', destLocation: ['US'], experience: 0, lastUsedTime: String(DPI_DEMO_NOW_MS - 60_000), tlsVersion: '', certificateExpiryDate: '' },
  { name: 'Epic Hyperspace', id: 'app-epic', risk: 'trusted', state: 'active', rxBytes: '3150000000', txBytes: '640000000', categories: ['Business Applications', 'Healthcare'], applicationHostType: 'datacenter', destLocation: [], experience: 0, lastUsedTime: String(DPI_DEMO_NOW_MS - 180_000), tlsVersion: '', certificateExpiryDate: '' },
  { name: 'YouTube', id: 'app-yt', risk: 'low', state: 'active', rxBytes: '2890000000', txBytes: '120000000', categories: ['Streaming', 'Web'], applicationHostType: 'cloud', destLocation: ['US'], experience: 0, lastUsedTime: String(DPI_DEMO_NOW_MS - 300_000), tlsVersion: '', certificateExpiryDate: '' },
  { name: 'Zoom', id: 'app-zoom', risk: 'trusted', state: 'active', rxBytes: '1740000000', txBytes: '990000000', categories: ['Collaboration', 'Voice'], applicationHostType: 'cloud', destLocation: ['US'], experience: 0, lastUsedTime: String(DPI_DEMO_NOW_MS - 900_000), tlsVersion: '', certificateExpiryDate: '' },
  { name: 'Windows Update', id: 'app-wu', risk: 'safe', state: 'active', rxBytes: '1520000000', txBytes: '45000000', categories: ['Software Update'], applicationHostType: 'cloud', destLocation: ['US'], experience: 0, lastUsedTime: String(DPI_DEMO_NOW_MS - 3_600_000), tlsVersion: '', certificateExpiryDate: '' },
  { name: 'Netflix', id: 'app-nf', risk: 'very_low', state: 'active', rxBytes: '1210000000', txBytes: '38000000', categories: ['Streaming'], applicationHostType: 'cloud', destLocation: ['US'], experience: 0, lastUsedTime: String(DPI_DEMO_NOW_MS - 5_400_000), tlsVersion: '', certificateExpiryDate: '' },
  { name: 'Slack', id: 'app-slack', risk: 'trusted', state: 'active', rxBytes: '610000000', txBytes: '240000000', categories: ['Collaboration'], applicationHostType: 'cloud', destLocation: ['US'], experience: 0, lastUsedTime: String(DPI_DEMO_NOW_MS - 420_000), tlsVersion: '', certificateExpiryDate: '' },
  // Flagged, KNOWN: a peer-to-peer client and an anonymizer — risk words the
  // aliases fold into 'suspicious', categories the plane could name.
  { name: 'BitTorrent', id: 'app-bt', risk: 'high', state: 'active', rxBytes: '940000000', txBytes: '720000000', categories: ['Peer-to-Peer'], applicationHostType: 'cloud', destLocation: ['NL', 'SE'], experience: 0, lastUsedTime: String(DPI_DEMO_NOW_MS - 1_800_000), tlsVersion: '', certificateExpiryDate: '' },
  { name: 'Tor', id: 'app-tor', risk: 'very_high', state: 'active', rxBytes: '86000000', txBytes: '41000000', categories: ['Anonymizer'], applicationHostType: 'cloud', destLocation: ['DE'], experience: 0, lastUsedTime: String(DPI_DEMO_NOW_MS - 7_200_000), tlsVersion: '', certificateExpiryDate: '' },
  // Flagged, UNCLASSIFIED: elevated risk and the plane could not say what it
  // is — the watchlist's investigation queue of one.
  { name: 'unknown-tcp-4410', id: 'app-unk-4410', risk: 'medium', state: 'active', rxBytes: '410000000', txBytes: '38000000', categories: ['unknown'], applicationHostType: null, destLocation: [], experience: 0, lastUsedTime: String(DPI_DEMO_NOW_MS - 1_200_000), tlsVersion: '', certificateExpiryDate: '' },
  { name: 'Spotify', id: 'app-spot', risk: 'low', state: 'active', rxBytes: '350000000', txBytes: '12000000', categories: ['Streaming', 'Audio'], applicationHostType: 'cloud', destLocation: ['US'], experience: 0, lastUsedTime: String(DPI_DEMO_NOW_MS - 2_400_000), tlsVersion: '', certificateExpiryDate: '' },
  // The plane reported this app's presence but no byte counters for it — a
  // null total in the ranking, never a zero.
  { name: 'NTP', id: 'app-ntp', risk: 'trusted', state: 'active', categories: ['Network'], applicationHostType: 'infrastructure', destLocation: [], experience: 0, lastUsedTime: String(DPI_DEMO_NOW_MS - 30_000), tlsVersion: '', certificateExpiryDate: '' },
];

/** The demo DPI read for a site: the ranked table for the demo window. */
export const SITE_APPLICATIONS_DEMO: Partial<Record<SiteId, SiteApplicationsLive>> = {
  'campus-01': {
    siteId: 'campus-01',
    window: { ...DPI_DEMO_WINDOW },
    apps: byBytesDesc(
      CAMPUS01_APPS_RAW.map((raw) => normalizeSiteApp(raw)).filter((a): a is SiteAppRow => a !== null),
    ),
    source: { plane: 'central', at: DPI_DEMO_SOURCE_AT, sections: { apps: 'ok' } },
  },
};

/**
 * Hourly gauge samples in the switch hardware-trends wire shape: positional
 * `data` (strings) per timestamp (epoch ms). `skipHours` omits buckets
 * outright — the demo's 03:00–05:00 telemetry outage that the normalizer
 * must break the line across, never bridge.
 */
function demoHourlySamples(
  seriesValues: readonly (readonly number[])[],
  skipHours: readonly number[] = [],
): { timestamp: number; data: string[] }[] {
  const out: { timestamp: number; data: string[] }[] = [];
  for (let hour = 0; hour < 24; hour += 1) {
    if (skipHours.includes(hour)) continue;
    out.push({
      timestamp: TREND_DEMO_START_MS + hour * HOUR_MS,
      data: seriesValues.map((values) => String(values[hour])),
    });
  }
  return out;
}

/** Cumulative-counter samples from hourly increments (SNMP-style octet and
 *  error counters, strings on the wire). */
function demoCounterSamples(
  bases: readonly number[],
  hourlyIncrements: readonly (readonly number[])[],
): { timestamp: number; data: string[] }[] {
  const cumulative = [...bases];
  const out: { timestamp: number; data: string[] }[] = [];
  for (let hour = 0; hour < 24; hour += 1) {
    for (let s = 0; s < cumulative.length; s += 1) cumulative[s] += hourlyIncrements[s][hour];
    out.push({ timestamp: TREND_DEMO_START_MS + hour * HOUR_MS, data: cumulative.map(String) });
  }
  return out;
}

/** AP trend samples: ISO timestamps (verified envelope shape), one value per
 *  hourly bucket. */
function demoApSamples(values: readonly number[]): { timestamp: string; data: string[] }[] {
  return values.map((v, hour) => ({
    timestamp: new Date(TREND_DEMO_START_MS + hour * HOUR_MS).toISOString(),
    data: [String(v)],
  }));
}

const SW_CORE_A_HW_KEYS = [
  'cpuUtilization',
  'memoryUtilization',
  'systemTemperature',
  'poeAvailable',
  'poeConsumption',
  'powerConsumption',
  'totalPowerConsumption',
];

/**
 * sw-core-a's hardware trends: 24 hourly buckets over the demo window.
 * Buckets 15–16 (03:00–05:00) are SKIPPED — the telemetry outage. The story
 * matches the demo estate's 'degraded' verdict: a CPU/temperature excursion
 * 08:00–10:00 that is recovering by the window's end. Values at the skipped
 * indices are placeholders and never reach the samples.
 */
const SW_CORE_A_HW_VALUES: readonly (readonly number[])[] = [
  // cpuUtilization (the terminal's baseline 14%)
  [14, 13, 14, 14, 15, 14, 13, 14, 14, 13, 14, 15, 14, 14, 13, 0, 0, 14, 15, 14, 14, 61, 83, 87, 52],
  // memoryUtilization (baseline 39%)
  [39, 39, 40, 39, 40, 41, 40, 39, 40, 40, 41, 40, 39, 40, 41, 0, 0, 40, 41, 42, 43, 44, 44, 44, 42],
  // systemTemperature (baseline 41.5C)
  [41.5, 41.4, 41.6, 41.5, 41.7, 41.8, 41.6, 41.5, 41.6, 41.7, 41.9, 42.1, 42.0, 41.8, 41.9, 0, 0, 42.3, 42.6, 43.1, 44.2, 49.8, 54.3, 57.6, 51.2],
  // poeAvailable — flat budget
  [370, 370, 370, 370, 370, 370, 370, 370, 370, 370, 370, 370, 370, 370, 370, 0, 0, 370, 370, 370, 370, 370, 370, 370, 370],
  // poeConsumption
  [178, 179, 180, 180, 181, 180, 179, 178, 179, 180, 182, 183, 182, 181, 180, 0, 0, 181, 182, 183, 184, 185, 186, 186, 184],
  // powerConsumption
  [208, 209, 210, 210, 211, 210, 209, 208, 209, 210, 212, 213, 212, 211, 210, 0, 0, 211, 212, 214, 216, 231, 246, 252, 228],
  // totalPowerConsumption — always >= powerConsumption + poeConsumption
  [392, 394, 396, 396, 398, 396, 394, 392, 394, 396, 400, 402, 400, 398, 396, 0, 0, 398, 400, 403, 406, 422, 438, 444, 418],
];

/** The demo hardware-trends read, keyed by device NAME (demo devices carry
 *  no serial — the demo read is addressed the same way). */
export const SWITCH_HARDWARE_TRENDS_DEMO: Record<string, SwitchHardwareTrendsLive> = {
  'sw-core-a': {
    serial: 'sw-core-a',
    window: { ...DPI_DEMO_WINDOW },
    trends: normalizeTrendSet(SW_CORE_A_HW_KEYS, demoHourlySamples(SW_CORE_A_HW_VALUES, [15, 16])),
    source: { plane: 'central', at: DPI_DEMO_SOURCE_AT, sections: { hardware: 'ok' } },
  },
};

/** Hourly AP values per metric: an overnight-quiet office AP that ramps with
 *  the workday; the throughput row is BYTES PER BUCKET (the wire shape), which
 *  the normalizer scales to bit/s. */
const AP_1F_04_VALUES: Record<'cpu' | 'memory' | 'throughput', readonly number[]> = {
  cpu: [18, 17, 16, 15, 14, 13, 12, 11, 10, 10, 9, 9, 8, 8, 8, 9, 9, 10, 11, 13, 15, 18, 21, 20],
  memory: [58, 58, 57, 57, 56, 56, 55, 55, 54, 54, 54, 55, 55, 56, 56, 56, 57, 57, 58, 58, 59, 60, 61, 60],
  throughput: [
    130_000_000_000, 122_000_000_000, 110_000_000_000, 98_000_000_000, 86_000_000_000, 72_000_000_000,
    58_000_000_000, 44_000_000_000, 32_000_000_000, 24_000_000_000, 18_000_000_000, 14_000_000_000,
    11_000_000_000, 9_000_000_000, 8_400_000_000, 8_800_000_000, 10_000_000_000, 13_000_000_000,
    22_000_000_000, 41_000_000_000, 68_000_000_000, 96_000_000_000, 150_000_000_000, 162_000_000_000,
  ],
};

const AP_TREND_KEY: Record<'cpu' | 'memory' | 'throughput', string> = {
  cpu: 'cpuUtilization',
  memory: 'memoryUtilization',
  throughput: 'throughput',
};

/** The demo AP trend reads, keyed `${deviceName}|${metric}` — the way the
 *  adapter is called. */
export const AP_TRENDS_DEMO: Record<string, ApTrendsLive> = Object.fromEntries(
  (['cpu', 'memory', 'throughput'] as const).map((metric) => {
    const keys = [AP_TREND_KEY[metric]];
    const live: ApTrendsLive = {
      serial: 'ap-1f-04',
      metric,
      window: { ...DPI_DEMO_WINDOW },
      trends: normalizeTrendSet(keys, demoApSamples(AP_1F_04_VALUES[metric]), apTrendSpecs(metric, keys)),
      source: { plane: 'central', at: DPI_DEMO_SOURCE_AT, sections: { trends: 'ok' } },
    };
    return [`ap-1f-04|${metric}`, live];
  }),
);

const SW_CORE_A_IF_KEYS = [
  'txBytes',
  'rxBytes',
  'inErrors',
  'outErrors',
  'inDiscards',
  'outDiscards',
  'inFcs',
  'inCrcErrors',
  'inFragmented',
  'outCollision',
  'inRunts',
  'inGiants',
];

/** sw-core-a's interface counters: cumulative octet counters growing ~1e12
 *  bytes/hour, error counters flat except a CRC/input-error burst during the
 *  08:00–10:00 excursion — the wired side of the same 'degraded' story. */
const SW_CORE_A_IF_BASES = [84_600_000_000_000, 91_200_000_000_000, 4120, 2055, 880, 640, 96, 1830, 44, 12, 61, 29];
const SW_CORE_A_IF_HOURLY: readonly (readonly number[])[] = [
  // txBytes
  [1_350_000_000_000, 1_280_000_000_000, 1_150_000_000_000, 1_020_000_000_000, 940_000_000_000, 860_000_000_000, 800_000_000_000, 760_000_000_000, 740_000_000_000, 750_000_000_000, 770_000_000_000, 800_000_000_000, 840_000_000_000, 880_000_000_000, 920_000_000_000, 960_000_000_000, 1_020_000_000_000, 1_080_000_000_000, 1_150_000_000_000, 1_240_000_000_000, 1_360_000_000_000, 1_480_000_000_000, 1_580_000_000_000, 1_500_000_000_000],
  // rxBytes
  [1_150_000_000_000, 1_090_000_000_000, 980_000_000_000, 870_000_000_000, 800_000_000_000, 730_000_000_000, 680_000_000_000, 650_000_000_000, 630_000_000_000, 640_000_000_000, 660_000_000_000, 680_000_000_000, 710_000_000_000, 750_000_000_000, 780_000_000_000, 820_000_000_000, 870_000_000_000, 920_000_000_000, 980_000_000_000, 1_050_000_000_000, 1_160_000_000_000, 1_260_000_000_000, 1_340_000_000_000, 1_280_000_000_000],
  // inErrors — the excursion leaves a mark
  [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3, 5, 7, 4],
  // outErrors
  [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  // inDiscards
  [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0],
  // outDiscards
  [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  // inFcs
  [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  // inCrcErrors — the loudest of the burst
  [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 4, 9, 12, 6],
  // inFragmented
  [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  // outCollision
  [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  // inRunts
  [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  // inGiants
  [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
];

/** The demo interface-trends read, keyed by device NAME. */
export const SWITCH_INTERFACE_TRENDS_DEMO: Record<string, SwitchInterfaceTrendsLive> = {
  'sw-core-a': {
    serial: 'sw-core-a',
    window: { ...DPI_DEMO_WINDOW },
    trends: normalizeTrendSet(
      SW_CORE_A_IF_KEYS,
      demoCounterSamples(SW_CORE_A_IF_BASES, SW_CORE_A_IF_HOURLY),
      interfaceTrendSpecs(SW_CORE_A_IF_KEYS),
    ),
    source: { plane: 'central', at: DPI_DEMO_SOURCE_AT, sections: { interfaces: 'ok' } },
  },
};
