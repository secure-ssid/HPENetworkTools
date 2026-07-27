/**
 * shared/types.ts — normalized data model for the HPE Network Tools portal.
 *
 * Entity interfaces follow README.md §"Data model (from the fixtures)" verbatim
 * (Plane, System, Site, Device, Client, PathHop, AuthEvent, Alert, Ticket,
 * Subscription, Finding, ConfigObject, ChangeRequest).
 *
 * Where the prototype fixtures diverge from the README field names, the README
 * names win here and fixtures.ts maps during extraction:
 *   Device  fixtures: fw / fwOk / issue  → firmware / firmwareApproved / reconciliationIssue
 *   Finding fixtures: base               → baseline
 *   Client  fixtures: kind               → model
 *
 * "*Row" types are the per-screen view models: they carry the pre-formatted
 * display fields the prototypes actually render (per-row tones, display strings
 * like health '98%', colour tokens), plus the canonical site join
 * (siteId + siteName) — see README §"Data model" and the SITE_ID map in
 * fixtures.ts.
 */

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/** Badge tones — the only semantic colour vocabulary in the design system. */
export type Tone = 'success' | 'warning' | 'danger' | 'info' | 'neutral' | 'accent';

/** Stat delta tones (Nightdesk.Stat deltaTone). */
export type DeltaTone = 'positive' | 'negative' | 'neutral';

export type Plane =
  | 'CENTRAL'
  | 'CLASSIC'
  | 'MIST'
  | 'GREENLAKE'
  | 'AOS-8'
  | 'AOS-10'
  | 'LOCAL'
  | 'CLEARPASS'
  | 'UXI'
  | 'THIRD-PARTY';

export type Sev = 'P1' | 'P2' | 'P3';

/** Shell views (HpeNetworkTools state.view). */
export type View =
  | 'overview'
  | 'alerts'
  | 'tickets'
  | 'clients'
  | 'auth'
  | 'sites'
  | 'site'
  | 'devices'
  | 'device'
  | 'licenses'
  | 'configure'
  | 'compliance'
  | 'systems';

// ---------------------------------------------------------------------------
// Canonical site identity
// ---------------------------------------------------------------------------

/**
 * Canonical site ids. Site names are inconsistent across the prototypes
 * ('Campus-01 — Meridian HQ' vs 'Campus-01 HQ', 'Lakeshore Medical' vs
 * 'Lakeshore Medical Center'); every fixture reference is normalised to one of
 * these, keeping the authored display string alongside as `siteName`.
 * 'core-services', 'workspace' and 'multiple' are pseudo-sites used by
 * alert/device rows that do not belong to a physical site.
 */
export const SITE_IDS = [
  'campus-01',
  'campus-02',
  'lakeshore',
  'riverside',
  'northgate',
  'southpoint',
  'warehouse-dc1',
  'warehouse-dc2',
  'airport-annex',
  'remote-vpn',
  'core-services',
  'workspace',
  'multiple',
] as const;

export type SiteId = (typeof SITE_IDS)[number];

/** Canonical site map shape (e.g. Record<SiteId, SiteRow>). */
export type SiteMap<T> = Record<SiteId, T>;

// ---------------------------------------------------------------------------
// Shared small shapes
// ---------------------------------------------------------------------------

/** Key/value fact row used by System, SiteProfile and DeviceProfile. */
export interface Fact {
  k: string;
  v: string;
}

/** Nightdesk.Stat definition (label / value / delta / deltaTone). */
export interface StatDef {
  label: string;
  value: string;
  delta: string;
  tone: DeltaTone;
}

export interface SelectOption {
  value: string;
  label: string;
}

// ---------------------------------------------------------------------------
// Normalized model (README §"Data model")
// ---------------------------------------------------------------------------

/** A connected control plane (NtSystems). */
export interface System {
  name: string;
  kind: string; // "cloud · new central · us-west-4"
  state: 'healthy' | 'degraded' | 'warning';
  scope: 'read only' | 'read + broker' | 'read + ssh';
  scopeNote: string;
  facts: Fact[]; // last sync, devices, calls today, token
  sites: SystemSite[];
  live: LiveStat[];
  calls: ApiCall[];
  events: SystemEvent[];
  pulls: SystemPull[];
  configText: string;
}

export interface SystemSite {
  name: string;
  detail: string;
}

export interface LiveStat {
  value: string;
  label: string;
}

export interface ApiCall {
  time: string;
  path: string;
  ms: string;
  code: string;
  tone: Tone;
}

export interface SystemEvent {
  time: string;
  what: string;
  who: string;
}

export interface SystemPull {
  what: string;
  every: string;
  mode: 'read' | 'write' | 'ssh';
}

export interface SitePlaneBadge {
  name: Plane;
  tone: Tone;
}

/** Site inventory row (NtSites). health null = inventory stale, cannot assert. */
export interface Site {
  name: string;
  subnet: string;
  planes: SitePlaneBadge[]; // MAY BE MORE THAN ONE
  mix: string;
  devices: number;
  clients: string;
  health: string | null;
  healthPct: string;
  alerts: string;
  sync: string; // "6h" for a throttled plane
}

export type DeviceType = 'switch' | 'ap' | 'gateway' | 'controller' | 'sensor' | 'policy';

export interface Device {
  name: string;
  model: string;
  type: DeviceType;
  site: string;
  plane: Plane;
  state: string;
  firmware: string;
  firmwareApproved: boolean;
  licence: string;
  reconciliationIssue: boolean; // double-claimed OR in no cloud plane
  localShell: boolean; // false for cloud-claimed devices
}

export type ClientType =
  | 'laptop'
  | 'phone'
  | 'tablet'
  | 'medical'
  | 'imaging'
  | 'voip'
  | 'printer'
  | 'media'
  | 'kiosk'
  | 'building'
  | 'unknown';

export interface Client {
  name: string;
  model: string; // fixture field "kind" — e.g. 'iPad Pro'
  type: ClientType;
  mac: string;
  ip: string | 'pending';
  medium: 'wired' | 'wireless';
  site: string;
  group: string; // config group it inherits
  attach: string;
  where: string; // AP or switch + port/zone
  plane: Plane;
  auth: string;
  authBy: string;
  role: string;
  vlan: string;
  health: string;
  session: string;
  problem: boolean;
  link: string;
  rssi: string;
  snr: string;
  retries: string;
  tput: string;
  roams: string;
  quality: number | null; // 0-100 score; null when the plane reports no numeric score
  zone: string; // physical location
  closet: string; // wiring
}

/** Computed, not stored — see logic.ts pathFor(). */
export interface PathHop {
  name: string;
  role: string;
  state: string;
  tone: Tone;
  link: string | null; // fact about the segment to the NEXT hop
  device: boolean; // clickable through to device detail
}

export interface AuthEvent {
  time: string;
  who: string;
  mac: string;
  service: string;
  method: string;
  result: 'accept' | 'reject' | 'timeout';
  reason: string;
  role: string;
  nas: string;
  plane: Plane;
}

export interface Alert {
  sev: Sev;
  title: string;
  detail: string;
  site: string;
  plane: Plane;
  state: 'open' | 'acked' | 'cleared'; // 'cleared' = the plane considers it resolved
  age: string;
  device: string;
}

export interface TicketEvidence {
  time: string;
  plane: string; // display label — wider vocabulary than Plane ('LOCAL SSH', 'PORTAL', …)
  finding: string;
  raw: string;
  device: string | null;
}

export interface Ticket {
  id: string;
  pri: string;
  state: string;
  title: string;
  site: string;
  age: string;
  reporter: string;
  owner: string;
  planes: string;
  sla: string;
  causeTitle: string;
  cause: string;
  action1: string;
  action2: string;
  action3: string;
  evidence: TicketEvidence[];
}

export interface Subscription {
  name: string;
  sku: string;
  plane: Plane;
  term: string;
  qty: string;
  assigned: string;
  pct: string;
  expires: string;
  status: 'active' | 'expiring' | 'idle' | 'retiring';
}

export interface Finding {
  sev: 'high' | 'med' | 'low';
  title: string;
  detail: string;
  rule: string;
  plane: Plane;
  count: string;
  fix: 'auto' | 'manual' | 'window' | 'ssh scan';
  device: string;
  baseline: string; // fixture field "base"
}

// ---------------------------------------------------------------------------
// Configure — config objects, forms, change requests
// ---------------------------------------------------------------------------

export type ConfigKind = 'ssid' | 'port' | 'vlan';

/** Wireless SSID list row (NtConfigure). */
export interface SsidObject {
  kind: 'ssid';
  origin?: 'configured' | 'observed';
  name: string;
  vlan: string; // display: 'vlan 820'
  security: string; // display label, e.g. 'WPA3-Enterprise'
  targets: string;
  plane: string; // display label, e.g. 'CENTRAL + MIST'
  tone: Tone;
}

/** Switch port list row (NtConfigure). */
export interface PortObject {
  kind: 'port';
  origin?: 'configured' | 'observed';
  device: string;
  port: string;
  desc: string;
  summary: string;
  state: string;
  tone: Tone;
}

/** VLAN & role list row (NtConfigure). */
export interface VlanObject {
  kind: 'vlan';
  origin?: 'configured' | 'observed';
  id: string;
  name: string;
  detail: string;
  role: string;
}

/** README ConfigObject — kind: 'ssid'|'port'|'vlan'|'role'. The prototypes only
 *  author ssid/port/vlan rows; roles exist as display strings on VLAN rows. */
export type ConfigObject = SsidObject | PortObject | VlanObject;

/** README ChangeRequest — the brokered-write unit. */
export interface ChangeRequest {
  object: ConfigObject;
  ticket: string; // REQUIRED
  state: 'ready' | 'applying' | 'needs window' | 'console';
  where: string;
  rendered: string; // plane-specific payload
}

// -- Edit-drawer form models (NtConfigure state) ----------------------------

export type SsidSecurity = 'wpa3-enterprise' | 'wpa2-enterprise' | 'psk-portal' | 'wpa2-psk' | 'open';
export type SsidBands = '5+6' | 'all' | '5';

export interface SsidForm {
  name: string;
  vlan: string;
  security: SsidSecurity;
  group: string;
  bands: SsidBands;
  broadcast: boolean;
  isolate: boolean;
  noDfs: boolean;
  plane: string; // display label of the owning plane(s), drives preview meta
}

export interface PortForm {
  device: string;
  id: string; // interface id, e.g. '1/1/14'
  desc: string;
  mode: 'access' | 'trunk';
  vlan: string;
  poe: boolean;
  dot1x: boolean;
  mab: boolean;
  up: boolean;
}

export type VlanScope = 'cx-campus-01' | 'cx-all' | 'core-only';

export interface VlanForm {
  id: string;
  name: string;
  helpers: string; // comma-separated DHCP helper addresses
  scope: VlanScope;
}

export type ConfigForm = SsidForm | PortForm | VlanForm;

export interface BlastRadiusRow {
  what: string;
  count: string;
}

// ---------------------------------------------------------------------------
// Per-screen view models (rows as the prototypes render them)
// ---------------------------------------------------------------------------

// -- Shell (HpeNetworkTools) --

export interface SearchIndexEntry {
  kind: string; // site | device | mac | client | config | ip | ticket
  label: string;
  meta: string;
  view: View;
  arg: string | null; // site/device name for drill-downs
}

export interface Crumb {
  label: string;
}

/** Breadcrumb trails per view (site/device are computed at runtime). */
export type CrumbMap = Record<string, Crumb[]>;

export interface NavItem {
  label: string;
  view: View;
}

export interface NavGroup {
  label: string; // OPERATE | INVENTORY | GOVERN
  items: NavItem[];
}

// -- Overview (NtOverview) --

/** "Needs you now" alert row — note `meta` (not `detail`) and no site column. */
export interface OverviewAlert {
  sev: Sev;
  tone: Tone;
  title: string;
  meta: string;
  plane: Plane;
  age: string;
  device: string;
}

/** Overview Sites table row — `plane` here is a prose label ('Central · local'). */
export interface OverviewSiteRow {
  name: string;
  siteId: SiteId;
  plane: string;
  devices: number;
  clients: string;
  health: string | null;
  healthPct: string;
  tone: SiteHealthTone;
  alerts: string;
  alertTone: Tone;
}

/** Health-bar colour key shared by the two site tables. */
export type SiteHealthTone = 'ok' | 'warn' | 'bad' | 'stale';

export interface OverviewPlaneRow {
  name: string;
  scope: string;
  state: string;
  tone: Tone;
  sync: string;
}

export interface ChangeLogEntry {
  time: string;
  text: string;
  who: string;
}

export type LaunchTarget = { type: 'view'; view: View } | { type: 'device'; device: string };

export interface LaunchpadRow {
  label: string;
  hint: string;
  target: LaunchTarget;
}

// -- Alerts (NtAlerts) --

export interface AlertRow extends Omit<Alert, 'site'> {
  tone: Tone;
  siteId: SiteId;
  siteName: string; // display string as authored in this fixture
  alertId?: string; // the plane's own key — what an acknowledge write addresses
}

// -- Tickets (NtTickets) --

export interface TicketNote {
  ts: string; // ISO timestamp
  kind: 'note' | 'action'; // action = an operator-requested next action, logged for the record
  text: string;
}

export interface TicketRow extends Omit<Ticket, 'site'> {
  tone: Tone;
  inc: string; // ServiceNow suffix — "INC0094<inc>"
  siteId: SiteId;
  siteName: string;
  notes?: TicketNote[]; // persisted operator log — present once the first note/action lands
}

// -- Clients (NtClients) --

export interface ClientRow extends Omit<Client, 'site'> {
  siteId: SiteId;
  siteName: string;
  planeTone: Tone;
  healthTone: Tone;
}

/** Uplink wiring: AP name → access switch name (NT_AP_UPLINK). */
export type ApUplinkMap = Record<string, string>;

/** Per-site forwarding chain for the path diagram (NT_SITE_CHAIN). */
export interface SiteChain {
  core: string;
  coreRole: string;
  coreState: string;
  coreTone: Tone;
  gw: string | null; // null = no gateway hop on this site
  gwRole: string | null;
  gwState: string | null;
  gwTone: Tone | null;
  wan: string;
  exit: string;
  exitRole: string;
}

/** PathHop decorated for rendering (dot colour, connector flags). */
export interface PathHopView extends PathHop {
  hasNext: boolean;
  plain: boolean; // !device — renders as plain text instead of a link
  dot: string; // CSS colour for the 9px status dot
}

export interface TimelineStep {
  time: string;
  plane: string;
  what: string;
  raw: string;
}

export type TimelineVariant = 'default' | 'reject' | 'dhcp';

// -- Auth events (NtAuthEvents) --

export interface AuthEventRow extends AuthEvent {
  tone: Tone;
}

export interface FailReasonRow {
  label: string;
  value: number; // of max 60
  note: string;
}

export interface PolicyServiceRow {
  name: string;
  detail: string;
  rate: string; // auths/hour
  state: string;
  tone: Tone;
}

// -- Sites (NtSites) --

export interface SiteRow extends Site {
  id: SiteId;
  tone: SiteHealthTone;
  alertTone: Tone;
}

// -- Site detail (NtSiteDetail) --

export interface SiteDeviceRow {
  name: string;
  model: string;
  plane: Plane;
  planeTone: Tone;
  role: string;
  state: string;
  stateTone: Tone;
  uptime: string;
}

export interface SiteAlertRow {
  sev: Sev;
  tone: Tone;
  title: string;
  meta: string;
}

export interface SiteProfile {
  name: string;
  siteId: SiteId | null; // null only for an unresolvable fallback name
  blurb: string;
  launch: string; // "Open in Central" etc.
  deviceCount: string;
  deviceDelta: string;
  clients: string;
  clientDelta: string;
  health: string | null; // null = stale ('—' in the prototype)
  healthNote: string;
  healthTone: DeltaTone;
  alertCount: string;
  alertNote: string;
  drift: string;
  driftNote: string;
  collector: string;
  collectorTone: Tone;
  reachValue: number; // "Devices answering directly" %
  core: string; // core switch, terminal target
  collectorNote: string;
  facts: Fact[];
  devices: SiteDeviceRow[];
  alerts: SiteAlertRow[];
}

// -- Site topology (SiteDetail topology section, computed — see logic.ts) --

/** Vertical layers, rendered top (WAN side) → bottom (edge). */
export type TopologyLayerKey = 'wan' | 'gateway' | 'core' | 'access' | 'edge';

/** One device inside a collapsed group chip (e.g. the APs on one switch). */
export interface TopologyMember {
  name: string;
  state: string;
  tone: Tone;
}

export interface TopologyNode {
  id: string; // unique within the diagram ('dev:sw-core-a', 'grp:sw-acc-3f-2:ap', 'exit')
  layer: TopologyLayerKey;
  label: string; // device name, exit label, or group label ('2 APs')
  sub: string; // role / model line under the label
  state: string;
  tone: Tone; // worst member tone for groups
  device: string | null; // click-through target; null for non-device nodes
  members: TopologyMember[] | null; // set on collapsed group chips
}

export interface TopologyEdge {
  from: string; // node id (upper layer)
  to: string; // node id (lower layer); group ids fan out to members when expanded
  label: string | null; // only when the data carries one (chain.wan)
}

export interface SiteTopology {
  layers: TopologyLayerKey[]; // which layers have nodes, in render order
  nodes: TopologyNode[];
  edges: TopologyEdge[];
  note: string; // honesty note: where the wiring comes from
}

// -- Devices (NtDevices) --

export interface DeviceRow extends Omit<Device, 'site'> {
  siteId: SiteId;
  siteName: string;
  planeTone: Tone;
  stateTone: Tone;
}

/** Platform-lane header metadata (NT_LANE_META) — `mark` is the 2px rule colour. */
export interface LaneMeta {
  tone: Tone;
  sync: string;
  note: string;
  mark: string;
}

// -- Device detail (NtDeviceDetail) --

/** Terminal behaviour class: CX-style shell, AOS-style shell, or no shell. */
export type TerminalKind = 'sw' | 'aos' | 'none';

export interface DevicePortRow {
  id: string;
  what: string;
  state: string;
  tone: Tone;
}

export interface DeviceCheckRow {
  mark: string; // pass | fail
  tone: Tone;
  label: string;
}

/** Full per-device profile produced by deviceProfile(name) in logic.ts. */
export interface DeviceProfile {
  name: string;
  model: string;
  site: string; // display string as authored
  siteId: SiteId;
  ip: string;
  plane: Plane;
  planeTone: Tone;
  state: string;
  stateTone: Tone;
  launch: string; // "Open AOS-8 WebUI" etc.
  kind: TerminalKind;
  prompt: string; // '' when kind === 'none'
  readOnlyNote?: string; // set only for cloud-claimed (kind === 'none')
  stats: StatDef[];
  facts: Fact[];
  listTitle: string; // Ports of interest | Cluster members | Radios & SSIDs | Tunnels | Services
  listMeta: string;
  ports: DevicePortRow[];
  checks: DeviceCheckRow[];
}

/** One rendered terminal line. */
export interface TerminalLine {
  text: string;
  tone: 'in' | 'body' | 'muted' | 'warn';
}

/** Canned command → output lines (NT_SW_RESP / NT_AOS_RESP). */
export type TerminalResponseTable = Record<string, string[]>;

export interface CfgHistoryRow {
  when: string;
  what: string;
  who: string;
  tag: string; // push | shell | upgrade | baseline | cloud
  tone: Tone;
}

/** Running / drift / history config block per device kind (NT_CFG). */
export interface DeviceCfg {
  meta: string;
  running: string;
  diff: string;
  history: CfgHistoryRow[];
}

export interface DeviceClientRow {
  name: string;
  detail: string;
  state: string;
  tone: Tone;
}

export interface DeviceClientSet {
  meta: string;
  rows: DeviceClientRow[];
}

// -- Licences (NtLicenses) --

export interface SubscriptionRow extends Subscription {
  planeTone: Tone;
  tone: Tone; // status badge tone
}

export interface RenewalRow {
  date: string;
  what: string;
  days: string;
  color: string; // urgency colour token
}

export interface OrphanRow {
  tag: string; // orphan | gap | idle
  tone: Tone;
  what: string;
  detail: string;
}

// -- Configure (NtConfigure) --

/** Queued-change list row — the display-level view of a ChangeRequest. */
export interface QueuedChangeRow {
  state: 'ready' | 'applying' | 'needs window' | 'console';
  tone: Tone;
  what: string;
  where: string;
  ticket: string;
}

/** "Where a change can go" capability-matrix row. */
export interface CapabilityRow {
  plane: string;
  note: string;
  mode: 'brokered' | 'ssh' | 'read only';
  tone: Tone;
}

// -- Compliance (NtCompliance) --

export interface FindingRow extends Finding {
  tone: Tone;
  fixColor: string; // colour token per fix class
}

export interface BaselineProgressRow {
  label: string;
  value: number; // pass rate %
  note: string;
}

// -- Systems (NtSystems) --

export interface SystemSiteRow extends SystemSite {
  siteId: SiteId | null; // null for 'Workspace-wide'
}

export interface SystemPullRow extends SystemPull {
  tone: Tone;
}

export interface SystemRow extends Omit<System, 'sites' | 'pulls'> {
  tone: Tone;
  scopeTone: Tone;
  /** Registry plane id — present on live rows so the UI never reverse-maps a
   *  (possibly operator-renamed) display name to find the plane. */
  planeId?: string;
  sites: SystemSiteRow[];
  pulls: SystemPullRow[];
}

export interface SyncHistoryRow {
  time: string;
  system: string;
  what: string;
  result: string;
  tone: Tone;
}

export interface PermissionRow {
  mode: string; // read | broker | ssh | none
  tone: Tone;
  what: string;
}

/** Connect-a-system type keys (NtSystems state.newType). */
export type SystemTypeKey = 'central' | 'mist' | 'classic' | 'greenlake' | 'aos8' | 'local' | 'clearpass' | 'uxi';

/** Type-dependent endpoint field for the connect form. */
export interface EndpointVariant {
  label: string;
  help: string;
  hint: string;
}

/** Screens with their own demo/live source override (Connected systems grid). */
export const SCREEN_SECTIONS = [
  'overview',
  'alerts',
  'clients',
  'authEvents',
  'sites',
  'devices',
  'licenses',
  'configure',
  'compliance',
  'systems',
] as const;
export type ScreenSection = (typeof SCREEN_SECTIONS)[number];

/** Per-section source: absent = follow the portal-wide demoMode. */
export type SectionMode = Partial<Record<ScreenSection, 'demo' | 'live'>>;
