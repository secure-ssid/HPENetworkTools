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
  ClientRow,
  ConnectField,
  CrumbMap,
  DeviceCfg,
  DeviceClientSet,
  DeviceProfile,
  DeviceRow,
  EndpointVariant,
  Fact,
  FailReasonRow,
  FindingRow,
  LaneMeta,
  LaunchpadRow,
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
  VlanObject,
  SelectOption,
  WriteMode,
} from './types';

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

/** Nav groups from the sidebar markup (OPERATE / INVENTORY / GOVERN). */
export const NAV_GROUPS: NavGroup[] = [
  {
    label: 'Operate',
    items: [
      { label: 'Overview', view: 'overview' },
      { label: 'Alerts', view: 'alerts' },
      { label: 'Tickets', view: 'tickets' },
      { label: 'Clients', view: 'clients' },
      { label: 'Auth events', view: 'auth' },
    ],
  },
  {
    label: 'Inventory',
    items: [
      { label: 'Sites', view: 'sites' },
      { label: 'Devices', view: 'devices' },
      { label: 'Licences', view: 'licenses' },
    ],
  },
  {
    label: 'Govern',
    items: [
      { label: 'Configure', view: 'configure' },
      { label: 'Compliance', view: 'compliance' },
      { label: 'Connected systems', view: 'systems' },
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

/** Breadcrumb trails per view — NT_CRUMBS (workspace crumb is prepended at runtime). */
export const CRUMBS: CrumbMap = {
  overview: [{ label: 'Overview' }],
  alerts: [{ label: 'Operate' }, { label: 'Alerts' }],
  tickets: [{ label: 'Operate' }, { label: 'Tickets' }],
  clients: [{ label: 'Operate' }, { label: 'Clients' }],
  auth: [{ label: 'Operate' }, { label: 'Auth & policy events' }],
  sites: [{ label: 'Inventory' }, { label: 'Sites' }],
  devices: [{ label: 'Inventory' }, { label: 'Devices' }],
  licenses: [{ label: 'Inventory' }, { label: 'Licences' }],
  configure: [{ label: 'Govern' }, { label: 'Configuration' }],
  compliance: [{ label: 'Govern' }, { label: 'Compliance' }],
  systems: [{ label: 'Govern' }, { label: 'Connected systems' }],
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
  { name: 'HPE Aruba Central', scope: 'new · 3 sites', state: 'healthy', tone: 'success', sync: '40s' },
  { name: 'Mist', scope: 'cloud · 3 sites', state: 'healthy', tone: 'success', sync: '1m' },
  { name: 'Central Classic', scope: 'legacy · 2 sites', state: 'degraded', tone: 'danger', sync: '6h' },
  { name: 'GreenLake', scope: 'workspace · licences', state: 'healthy', tone: 'success', sync: '4m' },
  { name: 'AOS-8 master', scope: 'mm-lake-1 · on-prem', state: 'warning', tone: 'warning', sync: '2m' },
  { name: 'Local switch collector', scope: 'ssh · 96 switches', state: 'healthy', tone: 'success', sync: '30s' },
  { name: 'ClearPass', scope: 'cppm-01 · policy', state: 'healthy', tone: 'success', sync: '55s' },
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
// Alerts — NtAlerts.dc.html (the `data` array, 12 rows)
// ---------------------------------------------------------------------------

export const ALERTS: AlertRow[] = [
  { sev: 'P1', tone: 'danger', title: 'Riverside Clinic offline — WAN down', detail: 'wan1 down 12m · lte failover did not engage', siteId: 'riverside', siteName: 'Riverside Clinic', plane: 'CLASSIC', state: 'open', age: '12m', device: 'sw-core-a' },
  { sev: 'P1', tone: 'danger', title: 'mm-lake-1 lost heartbeat from 3 controllers', detail: 'mc-lake-2, mc-lake-3, mc-lake-4 · cluster degraded', siteId: 'lakeshore', siteName: 'Lakeshore Medical', plane: 'AOS-8', state: 'open', age: '41m', device: 'mm-lake-1' },
  { sev: 'P1', tone: 'danger', title: 'Central Classic sync stalled — inventory 6h stale', detail: 'api 429 rate-limited · 24 devices unverified', siteId: 'riverside', siteName: 'Riverside Clinic', plane: 'CLASSIC', state: 'open', age: '6h', device: 'sw-core-a' },
  { sev: 'P2', tone: 'warning', title: 'DHCP pool 92% used on vlan 812', detail: 'scope 10.42.12.0/23 · 1,842 of 2,046 leases', siteId: 'campus-01', siteName: 'Campus-01 HQ', plane: 'CENTRAL', state: 'open', age: '20m', device: 'sw-core-a' },
  { sev: 'P2', tone: 'warning', title: 'gw-edge-1 tunnel flap ×14 in an hour', detail: 'ipsec to dc1 · mtu blackhole suspected', siteId: 'campus-01', siteName: 'Campus-01 HQ', plane: 'AOS-10', state: 'open', age: '55m', device: 'gw-edge-1' },
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

/** Client sessions — the `clients` array (16 rows). Fixture `kind` → model. */
export const CLIENTS: ClientRow[] = [
  { name: 'm.okonjo', model: 'iPad Pro', type: 'tablet', group: 'clinical-floors', mac: '3c:22:fb:41:0a:19', ip: '10.44.12.88', attach: 'ap-3f-12', where: '3F east · ward 3E', plane: 'MIST', planeTone: 'info', auth: '802.1X', authBy: 'clearpass', role: 'Clinical staff', vlan: 'vlan 820', health: 'good', healthTone: 'success', session: '2h 14m', medium: 'wireless', siteId: 'campus-02', siteName: 'Campus-02 Research', problem: false, link: '5 GHz · ch 36 · 40 MHz', rssi: '−52 dBm', snr: '41 dB', retries: '2.1%', tput: '866 Mbps', roams: '3', quality: 94, zone: 'Tower A · 3rd floor east · bed bay 12', closet: 'IDF-3F-A · sw-acc-3f-2 port 1/1/14' },
  { name: 'infusion-4A-12', model: 'Infusion pump', type: 'medical', group: 'medical-wired', mac: '00:1b:c5:09:7f:22', ip: '10.42.30.44', attach: 'sw-acc-3f-2', where: 'port 1/1/20', plane: 'LOCAL', planeTone: 'neutral', auth: 'MAB', authBy: 'clearpass', role: 'Medical device', vlan: 'vlan 820', health: 'good', healthTone: 'success', session: '41d', medium: 'wired', siteId: 'campus-01', siteName: 'Campus-01 HQ', problem: false, link: '1 Gb full duplex', rssi: '—', snr: '—', retries: '0.0%', tput: '4 Mbps', roams: '0', quality: 99, zone: 'Tower A · 4th floor · room 4A-12', closet: 'IDF-3F-A · port 1/1/20 · poe 6.1 W' },
  { name: 'j.alvarez', model: 'MacBook Pro', type: 'laptop', group: 'staff-wireless', mac: '8c:85:90:22:d1:04', ip: '10.42.14.19', attach: 'ap-3f-08', where: 'ward 3E · nurse station', plane: 'CENTRAL', planeTone: 'accent', auth: 'EAP-TLS', authBy: 'clearpass', role: 'IT admin', vlan: 'vlan 810', health: 'good', healthTone: 'success', session: '5h 02m', medium: 'wireless', siteId: 'campus-01', siteName: 'Campus-01 HQ', problem: false, link: '6 GHz · ch 37 · 80 MHz', rssi: '−48 dBm', snr: '45 dB', retries: '1.2%', tput: '1.2 Gbps', roams: '1', quality: 97, zone: 'Tower A · 3rd floor · nurse station', closet: 'IDF-3F-B · sw-acc-3f-3 port 1/1/9' },
  { name: 'guest-4471', model: 'Android phone', type: 'phone', group: 'guest-lobby', mac: 'f0:18:98:5c:11:73', ip: '10.42.12.208', attach: 'ap-1f-04', where: 'lobby · reception', plane: 'CENTRAL', planeTone: 'accent', auth: 'PSK + portal', authBy: 'clearpass guest', role: 'Guest', vlan: 'vlan 812', health: 'weak signal', healthTone: 'warning', session: '18m', medium: 'wireless', siteId: 'campus-01', siteName: 'Campus-01 HQ', problem: true, link: '5 GHz · ch 44 · 20 MHz', rssi: '−74 dBm', snr: '18 dB', retries: '14.8%', tput: '117 Mbps', roams: '0', quality: 46, zone: 'Ground floor · lobby, far corner by the café', closet: 'IDF-1F-A · sw-acc-1f-1 port 1/1/4' },
  { name: 'xray-cart-2', model: 'Imaging cart', type: 'imaging', group: 'lakeshore-medical', mac: '00:0c:29:7a:41:88', ip: '10.48.30.12', attach: 'ap-t1-12', where: 'tower 1 · corridor', plane: 'AOS-8', planeTone: 'accent', auth: '802.1X', authBy: 'controller', role: 'Medical device', vlan: 'vlan 848', health: 'roaming', healthTone: 'warning', session: '1h 09m', medium: 'wireless', siteId: 'lakeshore', siteName: 'Lakeshore Medical', problem: true, link: '5 GHz · ch 60 · 40 MHz', rssi: '−69 dBm', snr: '24 dB', retries: '9.4%', tput: '400 Mbps', roams: '14', quality: 61, zone: 'Tower 1 · moving between floors 2 and 3', closet: 'MDF-T1 · sw-lake-1 port 1/2/11' },
  { name: 'voip-3f-114', model: 'Desk handset', type: 'voip', group: 'voice-wired', mac: '00:04:f2:aa:19:60', ip: '10.42.16.114', attach: 'sw-acc-3f-3', where: 'port 1/1/14', plane: 'LOCAL', planeTone: 'neutral', auth: '802.1X', authBy: 'clearpass', role: 'Voice', vlan: 'vlan 816', health: 'good', healthTone: 'success', session: '12d', medium: 'wired', siteId: 'campus-01', siteName: 'Campus-01 HQ', problem: false, link: '1 Gb full duplex · lldp-med', rssi: '—', snr: '—', retries: '0.0%', tput: '128 kbps', roams: '0', quality: 98, zone: 'Tower A · 3rd floor · desk 114', closet: 'IDF-3F-B · port 1/1/14 · poe 4.4 W' },
  { name: 'r.okafor', model: 'ThinkPad X1', type: 'laptop', group: 'staff-wireless', mac: '54:e1:ad:03:77:c1', ip: '10.42.14.61', attach: 'ap-1f-04', where: 'lobby · hot desk', plane: 'CENTRAL', planeTone: 'accent', auth: 'EAP-TLS', authBy: 'clearpass', role: 'IT admin', vlan: 'vlan 810', health: 'good', healthTone: 'success', session: '3h 44m', medium: 'wireless', siteId: 'campus-01', siteName: 'Campus-01 HQ', problem: false, link: '5 GHz · ch 36 · 80 MHz', rssi: '−55 dBm', snr: '38 dB', retries: '2.8%', tput: '866 Mbps', roams: '2', quality: 92, zone: 'Ground floor · lobby hot desks', closet: 'IDF-1F-A · sw-acc-1f-1 port 1/1/4' },
  { name: 'ct-scanner-b', model: 'CT scanner', type: 'imaging', group: 'medical-wired', mac: '00:50:56:11:c4:07', ip: '10.48.30.61', attach: 'sw-lake-1', where: 'port 1/3/4', plane: 'LOCAL', planeTone: 'neutral', auth: 'MAB', authBy: 'clearpass', role: 'Medical device', vlan: 'vlan 848', health: 'good', healthTone: 'success', session: '96d', medium: 'wired', siteId: 'lakeshore', siteName: 'Lakeshore Medical', problem: false, link: '1 Gb full duplex', rssi: '—', snr: '—', retries: '0.0%', tput: '210 Mbps', roams: '0', quality: 99, zone: 'Tower 1 · basement · imaging suite 2', closet: 'MDF-T1 · port 1/3/4' },
  { name: 'unknown', model: 'Unrecognised', type: 'unknown', group: 'clinical-floors', mac: '6e:41:0d:99:2b:af', ip: '—', attach: 'ap-3f-14', where: '3F east', plane: 'MIST', planeTone: 'info', auth: '802.1X', authBy: 'reject ×7', role: 'Quarantine', vlan: 'none', health: 'auth failing', healthTone: 'danger', session: '—', medium: 'wireless', siteId: 'campus-02', siteName: 'Campus-02 Research', problem: true, link: '5 GHz · ch 36 · assoc only', rssi: '−61 dBm', snr: '30 dB', retries: '—', tput: '0', roams: '0', quality: 12, zone: 'Tower A · 3rd floor east · unknown position', closet: 'IDF-3F-A · sw-acc-3f-2 port 1/1/16' },
  { name: 's.mehta', model: 'iPhone 16', type: 'phone', group: 'clinical-floors', mac: 'de:ad:0b:14:65:22', ip: '10.44.12.140', attach: 'ap-3f-12', where: '3F east · ward 3E', plane: 'MIST', planeTone: 'info', auth: '802.1X', authBy: 'clearpass', role: 'Clinical staff', vlan: 'vlan 820', health: 'sticky client', healthTone: 'warning', session: '48m', medium: 'wireless', siteId: 'campus-02', siteName: 'Campus-02 Research', problem: true, link: '2.4 GHz · ch 6 · 20 MHz', rssi: '−71 dBm', snr: '21 dB', retries: '11.2%', tput: '144 Mbps', roams: '0', quality: 52, zone: 'Tower A · 3rd floor east · should be on 5 GHz', closet: 'IDF-3F-A · sw-acc-3f-2 port 1/1/14' },
  { name: 'kiosk-ng-02', model: 'Check-in kiosk', type: 'kiosk', group: 'northgate-public', mac: '00:26:57:03:14:9a', ip: '10.52.4.22', attach: 'ap-ng-02', where: 'reception', plane: 'MIST', planeTone: 'info', auth: 'PSK', authBy: 'local psk', role: 'Kiosk', vlan: 'vlan 830', health: 'good', healthTone: 'success', session: '22d', medium: 'wireless', siteId: 'northgate', siteName: 'Northgate Clinic', problem: false, link: '5 GHz · ch 100 · 40 MHz', rssi: '−58 dBm', snr: '35 dB', retries: '3.1%', tput: '400 Mbps', roams: '0', quality: 90, zone: 'Ground floor · reception, fixed mount', closet: 'Comms cupboard · sw-ng-1 port 1/1/6' },
  { name: 'p.singh', model: 'Surface Laptop', type: 'laptop', group: 'remote-workers', mac: 'a4:83:e7:5f:00:31', ip: '10.70.8.44', attach: 'gw-edge-1', where: 'VIA tunnel · home', plane: 'AOS-10', planeTone: 'accent', auth: 'EAP-TLS', authBy: 'clearpass', role: 'Remote worker', vlan: 'vlan 870', health: 'good', healthTone: 'success', session: '1h 51m', medium: 'wireless', siteId: 'remote-vpn', siteName: 'Remote & VPN users', problem: false, link: 'IPsec · 42 Mbps · rtt 28 ms', rssi: '—', snr: '—', retries: '0.4%', tput: '42 Mbps', roams: '0', quality: 88, zone: 'Off-site · Chicago metro, residential broadband', closet: 'n/a — VPN client' },
  { name: 'printer-2f-04', model: 'Multifunction', type: 'printer', group: 'office-wired', mac: '00:17:c8:20:11:70', ip: '10.42.18.4', attach: 'sw-acc-3f-3', where: 'port 1/1/31', plane: 'LOCAL', planeTone: 'neutral', auth: 'MAB', authBy: 'clearpass', role: 'Printer', vlan: 'vlan 818', health: 'good', healthTone: 'success', session: '61d', medium: 'wired', siteId: 'campus-01', siteName: 'Campus-01 HQ', problem: false, link: '100 Mb full duplex', rssi: '—', snr: '—', retries: '0.0%', tput: '2 Mbps', roams: '0', quality: 97, zone: 'Tower A · 2nd floor · print room', closet: 'IDF-3F-B · port 1/1/31' },
  { name: 'guest-4488', model: 'Windows laptop', type: 'laptop', group: 'guest-lobby', mac: '2c:33:61:8a:04:12', ip: 'pending', attach: 'ap-1f-04', where: 'lobby', plane: 'CENTRAL', planeTone: 'accent', auth: 'PSK + portal', authBy: 'dhcp pending', role: 'Guest', vlan: 'vlan 812', health: 'no address', healthTone: 'danger', session: '3m', medium: 'wireless', siteId: 'campus-01', siteName: 'Campus-01 HQ', problem: true, link: '5 GHz · ch 44 · 40 MHz', rssi: '−63 dBm', snr: '29 dB', retries: '4.0%', tput: '0', roams: '0', quality: 28, zone: 'Ground floor · lobby, seating area', closet: 'IDF-1F-A · sw-acc-1f-1 port 1/1/4' },
  { name: 'a.ferreira', model: 'iPad Air', type: 'tablet', group: 'lakeshore-medical', mac: '9a:11:74:0c:33:81', ip: '10.48.12.19', attach: 'ap-t2-04', where: 'tower 2 · ICU', plane: 'AOS-8', planeTone: 'accent', auth: '802.1X', authBy: 'controller', role: 'Clinical staff', vlan: 'vlan 820', health: 'good', healthTone: 'success', session: '2h 40m', medium: 'wireless', siteId: 'lakeshore', siteName: 'Lakeshore Medical', problem: false, link: '5 GHz · ch 52 · 40 MHz', rssi: '−57 dBm', snr: '36 dB', retries: '2.6%', tput: '866 Mbps', roams: '4', quality: 91, zone: 'Tower 2 · 5th floor · ICU bay 3', closet: 'MDF-T1 · sw-lake-1 port 1/2/14' },
  { name: 'badge-reader-14', model: 'Door controller', type: 'building', group: 'building-systems', mac: '00:1e:c0:44:81:07', ip: '10.60.2.14', attach: 'sw-wh1-1', where: 'port 1/1/9', plane: 'LOCAL', planeTone: 'neutral', auth: 'MAB', authBy: 'local db', role: 'Building system', vlan: 'vlan 860', health: 'good', healthTone: 'success', session: '88d', medium: 'wired', siteId: 'warehouse-dc1', siteName: 'Warehouse-DC1', problem: false, link: '100 Mb full duplex', rssi: '—', snr: '—', retries: '0.0%', tput: '64 kbps', roams: '0', quality: 96, zone: 'Warehouse · dock door 14', closet: 'Dock panel · port 1/1/9 · poe 3.2 W' },
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

/** RADIUS decisions — the `events` array (18 rows). */
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

/** Local-only fallback profile — fallback(name) in the prototype. The stats are
 *  authored for Warehouse-DC1 and are returned verbatim for any unknown site. */
export function buildLocalOnlySiteProfile(name: string): SiteProfile {
  return {
    name, siteId: siteIdFor(name) ?? null, blurb: 'Local-only site: no cloud plane claims these devices, so the SSH collector is the source of truth.',
    launch: 'Open local WebUI', deviceCount: '18', deviceDelta: '4 ap · 14 sw', clients: '96', clientDelta: 'peak 104',
    health: '100%', healthNote: 'clear 30d', healthTone: 'positive', alertCount: '0', alertNote: 'none open', drift: '0', driftNote: 'matches baseline',
    collector: 'healthy', collectorTone: 'success', reachValue: 100, core: 'sw-wh1-1',
    collectorNote: 'collector-05 · polls every 30s · 14 of 14 switches answering over ssh',
    facts: [
      { k: 'Subnets', v: '10.60.0.0/22' },
      { k: 'WAN', v: '1G to DC1' },
      { k: 'Core', v: 'sw-wh1-1 · CX 6300 stack of 3' },
      { k: 'Planes', v: 'Local SSH only' },
      { k: 'Note', v: 'Candidate for Central onboarding in Q4' },
    ],
    devices: [
      { name: 'sw-wh1-1', model: 'CX 6300M-24G', plane: 'LOCAL', planeTone: 'neutral', role: 'stack master', state: 'up', stateTone: 'success', uptime: '88d' },
      { name: 'sw-wh1-2', model: 'CX 6300M-24G', plane: 'LOCAL', planeTone: 'neutral', role: 'stack member', state: 'up', stateTone: 'success', uptime: '88d' },
      { name: 'sw-wh1-3', model: 'CX 6300M-24G', plane: 'LOCAL', planeTone: 'neutral', role: 'stack member', state: 'missing', stateTone: 'warning', uptime: '—' },
      { name: 'ap-wh1-01', model: 'AP-505', plane: 'LOCAL', planeTone: 'neutral', role: 'dock area', state: 'up', stateTone: 'success', uptime: '88d' },
    ],
    alerts: [{ sev: 'P3', tone: 'info', title: 'Stack member 3 missing after reboot', meta: 'local ssh · 3d' }],
  };
}

/** Prototype lookup: authored profile for the site, else the local-only fallback
 *  (accepts any authored name variant or a canonical siteId). */
export function siteProfileFor(siteName: string): SiteProfile {
  const id = siteIdFor(siteName);
  const profile = id ? SITE_PROFILES[id] : undefined;
  return profile ?? buildLocalOnlySiteProfile(siteName);
}

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
  { name: 'ap-3f-12', model: 'AP43', type: 'ap', siteId: 'campus-02', siteName: 'Campus-02 Research', plane: 'MIST', planeTone: 'info', state: 'up', stateTone: 'success', firmware: '0.14.29', firmwareApproved: true, licence: 'Wi-Fi SUB', reconciliationIssue: false, localShell: hasLocalShell('ap-3f-12') },
  { name: 'ap-3f-14', model: 'AP43', type: 'ap', siteId: 'campus-02', siteName: 'Campus-02 Research', plane: 'MIST', planeTone: 'info', state: 'up', stateTone: 'success', firmware: '0.14.29', firmwareApproved: true, licence: 'Wi-Fi SUB', reconciliationIssue: false, localShell: hasLocalShell('ap-3f-14') },
  { name: 'ap-ng-02', model: 'AP32', type: 'ap', siteId: 'northgate', siteName: 'Northgate Clinic', plane: 'MIST', planeTone: 'info', state: 'up', stateTone: 'success', firmware: '0.14.29', firmwareApproved: true, licence: 'Wi-Fi SUB', reconciliationIssue: false, localShell: hasLocalShell('ap-ng-02') },
  { name: 'sw-cam02-1', model: 'EX4400-48P', type: 'switch', siteId: 'campus-02', siteName: 'Campus-02 Research', plane: 'MIST', planeTone: 'info', state: 'up', stateTone: 'success', firmware: '23.4R2', firmwareApproved: true, licence: 'Wired SUB', reconciliationIssue: false, localShell: hasLocalShell('sw-cam02-1') },
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
      { id: '1/1/1-2', what: 'VSX ISL to sw-core-b · 20G lag', state: 'up', tone: 'success' },
      { id: '1/1/14', what: 'ap-3f-12 · poe 22.1W · vlan 812', state: 'up', tone: 'success' },
      { id: '1/1/22', what: 'uxi-cam01-2 · no carrier since 04:50', state: 'down', tone: 'danger' },
      { id: '1/1/47-48', what: 'gw-edge-1 / gw-edge-2 transit', state: 'up', tone: 'success' },
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

// ---------------------------------------------------------------------------
// Configure — NtConfigure.dc.html
// ---------------------------------------------------------------------------

/** Stat row, from the markup (4 stats). */
export const CONFIGURE_STATS: StatDef[] = [
  { label: 'Queued changes', value: '3', delta: '2 need a window', tone: 'neutral' },
  { label: 'Pushed today', value: '6', delta: 'all ticket-stamped', tone: 'positive' },
  { label: 'Config objects', value: '27', delta: '5 ssid · 7 vlan · 12 port', tone: 'neutral' },
  { label: 'Drift open', value: '12', delta: '7 auto-remediable', tone: 'negative' },
];

/** Wireless SSIDs — the `ssids` array (5 rows). */
export const SSIDS: SsidObject[] = [
  { kind: 'ssid', name: 'MRDN-Staff', vlan: 'vlan 820', security: 'WPA3-Enterprise', targets: 'clinical-floors, staff-wireless · 268 APs', plane: 'CENTRAL + MIST', tone: 'accent' },
  { kind: 'ssid', name: 'MRDN-Guest', vlan: 'vlan 812', security: 'PSK + captive portal', targets: 'guest-lobby, northgate-public · 96 APs', plane: 'CENTRAL', tone: 'accent' },
  { kind: 'ssid', name: 'MRDN-IoT', vlan: 'vlan 830', security: 'WPA2-PSK', targets: 'all groups · 268 APs', plane: 'CENTRAL + MIST', tone: 'accent' },
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

/** Queued changes — the `queue` array (3 rows). */
export const QUEUED_CHANGES: QueuedChangeRow[] = [
  { state: 'ready', tone: 'success', what: 'Add DHCP helper 10.44.0.20 to vlan 812', where: '2 core switches · local collector', ticket: 'NET-4166' },
  { state: 'needs window', tone: 'warning', what: 'Tunnel MTU 1400 on mc-lake-3', where: 'AOS-8 · window 01:00–04:00', ticket: 'NET-4149' },
  { state: 'console', tone: 'neutral', what: 'Exclude DFS channels on clinical-floors', where: 'Mist · read-only, opens in console', ticket: 'NET-4188' },
];

/** "Where a change can go" capability matrix — the `capability` array (6 rows). */
export const CAPABILITY_MATRIX: CapabilityRow[] = [
  { plane: 'HPE Aruba Central', note: 'wlan, groups, templates', mode: 'brokered', tone: 'accent' },
  { plane: 'Local switch collector', note: 'ports, vlans, aaa', mode: 'brokered', tone: 'accent' },
  { plane: 'AOS-8 master', note: 'recorded shell, window only', mode: 'ssh', tone: 'accent' },
  { plane: 'Mist', note: 'payload pre-filled in console', mode: 'read only', tone: 'neutral' },
  { plane: 'Central Classic', note: 'retiring 12 Aug', mode: 'read only', tone: 'neutral' },
  { plane: 'ClearPass', note: 'policy edited in ClearPass', mode: 'read only', tone: 'neutral' },
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
  mist: 'read only',
  greenlake: 'read only',
  clearpass: 'read only',
  uxi: 'read only',
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
  id: '812', name: 'guest-wifi', helpers: '10.42.0.20', scope: 'cx-campus-01',
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
  ssid: 'Written to Central directly; the Mist half opens in its console with the same payload.',
  port: 'Pushed over the recorded SSH session on the local collector, with a rollback snapshot.',
  vlan: 'Applied to every switch in the selected scope through the local collector.',
};

/** Mono note under the queue buttons, per object kind — `pushNote`. */
export const CONFIG_PUSH_NOTES: Record<string, string> = {
  ssid: 'Central accepts this push directly. The Mist half is read-only from here — the portal opens the Mist console with the payload pre-filled.',
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

/** Connect-a-system: type select options — `typeOptions` (7). */
export const CONNECT_TYPE_OPTIONS: SelectOption[] = [
  { value: 'central', label: 'HPE Aruba Central (new)' },
  { value: 'mist', label: 'Mist' },
  { value: 'classic', label: 'Central Classic (legacy)' },
  { value: 'greenlake', label: 'GreenLake platform' },
  { value: 'aos8', label: 'AOS-8 mobility master' },
  { value: 'local', label: 'Local switch collector (SSH)' },
  { value: 'clearpass', label: 'ClearPass' },
  { value: 'uxi', label: 'HPE Aruba UXI (sensors)' },
];

/** Connect-a-system: type-dependent endpoint field — `endpoints` (7 variants). */
export const CONNECT_ENDPOINTS: Record<SystemTypeKey, EndpointVariant> = {
  central: { label: 'Central region / base URL', help: 'Shown under Central → API Gateway → REST API. Tokens are minted by HPE GreenLake SSO.', hint: 'us4.api.central.arubanetworks.com' },
  mist: { label: 'Mist API host + org ID', help: 'Global 01–06, plus the org UUID.', hint: 'api.mist.com · org 4f2a…' },
  classic: { label: 'Classic tenant URL', help: 'Legacy tenant; expect a low rate limit.', hint: 'eu-central.classic.arubanetworks.com' },
  greenlake: { label: 'GreenLake workspace ID', help: 'Platform workspace, not the application instance.', hint: 'wks-meridian-health' },
  aos8: { label: 'Mobility master address', help: 'Portal reaches it through a jump host.', hint: '10.48.0.10:4343' },
  local: { label: 'Collector agent address', help: 'The agent dials out; this is for verification only.', hint: '10.42.0.9:8443' },
  clearpass: { label: 'ClearPass publisher URL', help: 'Publisher node, API client credentials.', hint: 'cppm-01.meridian.health' },
  uxi: { label: 'UXI API base — optional', help: 'Defaults to api.capenetworks.com; auth is always HPE SSO client credentials.', hint: 'api.capenetworks.com' },
};

/**
 * The credential fields each plane needs BEYOND the endpoint variant above and
 * the shared clientId/clientSecret pair. Keys are the exact ones the adapters'
 * `isComplete()` reads (server/src/planes/*.ts) — a drawer that saves under any
 * other key produces a linked-but-stubbed plane that silently never syncs.
 *
 * The endpoint input itself must save under CONNECT_ENDPOINT_KEY below.
 */
export const CONNECT_FIELDS: Record<SystemTypeKey, ConnectField[]> = {
  central: [],
  mist: [
    { key: 'orgId', label: 'Org ID', help: 'Mist organisation UUID.' },
    { key: 'token', label: 'API token', help: 'Org API token — sent as Authorization: Token.', secret: true },
  ],
  classic: [],
  greenlake: [
    { key: 'workspaceId', label: 'Workspace ID', help: 'Platform workspace, not the application instance.' },
  ],
  aos8: [
    { key: 'username', label: 'Username', help: 'Read-only management account on the master.' },
    { key: 'password', label: 'Password', help: 'Stored with the plane credentials.', secret: true },
  ],
  local: [
    { key: 'username', label: 'SSH username', help: 'Account the collector opens recorded sessions with.' },
    { key: 'password', label: 'SSH password', help: 'Omit when a private key is supplied.', secret: true, optional: true },
    { key: 'privateKey', label: 'SSH private key', help: 'PEM body; preferred over a password.', secret: true, optional: true },
    { key: 'passphrase', label: 'Key passphrase', help: 'Only when the private key is encrypted.', secret: true, optional: true },
    { key: 'port', label: 'Jump host port', help: 'Defaults to 22.', optional: true },
  ],
  clearpass: [
    { key: 'token', label: 'API token', help: 'OAuth access token for the publisher API client.', secret: true },
    // Read by clearpass.ts coaDisconnect(): sent as `enforcement_profile` on a
    // CoA Disconnect-Request when set, omitted when not. Optional because an
    // UNKNOWN profile name turns a working disconnect into a 422 — blank is
    // the safe default, not a guess.
    { key: 'coaEnforcementProfile', label: 'CoA enforcement profile', help: 'Sent on a CoA disconnect when set. Leave blank to use the publisher default — a wrong name fails the request.', optional: true },
  ],
  uxi: [],
};

/**
 * Settings key the connect drawer's endpoint input must save under, per plane
 * — read straight off each adapter's `isComplete()` / constructor:
 *   central.ts:670 gatewayBaseUrl · mist.ts:181 apiHost · greenlake.ts:302
 *   workspaceId · aos8.ts:264 master · clearpass.ts:213 host · uxi.ts:190
 *   baseUrl (optional) · terminal.ts:410 host (the collector's jump box).
 * `classic` has no adapter yet; its record keeps the generic baseUrl key.
 */
export const CONNECT_ENDPOINT_KEY: Record<SystemTypeKey, string> = {
  central: 'gatewayBaseUrl',
  mist: 'apiHost',
  classic: 'baseUrl',
  greenlake: 'workspaceId',
  aos8: 'master',
  local: 'host',
  clearpass: 'host',
  uxi: 'baseUrl',
};

/** Success alert body after "Test connection" — `testResult`. */
export const CONNECT_TEST_RESULT =
  'Authenticated, read scopes granted. Found 164 devices across 3 sites and 486 subscription records — 3 devices are already claimed by another plane and will be flagged, not duplicated.';
