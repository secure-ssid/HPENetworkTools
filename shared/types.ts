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
  /** Management IP as the plane reports it. Optional: not every plane
   *  publishes one, and a device without it renders '—' rather than a guess. */
  ip?: string;
  /** Identity hints adapters attach so reconciliation can match one physical
   *  device across planes (serial/MAC beat name matching). Optional — the
   *  authored fixtures carry neither. */
  serial?: string;
  mac?: string;
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

/**
 * How a Configure row was obtained. `configured` = read back from the plane's
 * configuration API (an SSID profile, a named VLAN, a port profile);
 * `observed` = inferred from live client sessions or interface state, which is
 * evidence of a config, not the config itself. Same vocabulary as the
 * `origin` field the three ConfigObject rows already carry.
 */
export type ConfigInventoryMode = 'configured' | 'observed';

/**
 * A plane's configuration inventory — the SSID / VLAN / port objects read
 * from its config API, as opposed to the ones observed from client sessions.
 * This is the shape the live Configure screen needs so it can stop deriving
 * SSIDs and VLANs from Clients (`inventoryMode: 'observed'`).
 *
 * Every array is OPTIONAL and absence is meaningful: an adapter that cannot
 * read VLANs omits `vlans` rather than reporting an empty list, so the screen
 * can say "not reported by this plane" instead of "this plane has no VLANs".
 */
export interface ConfigInventory {
  ssids?: SsidObject[];
  vlans?: VlanObject[];
  ports?: PortObject[];
  /** How these rows were obtained; rows may also carry a per-row `origin`. */
  mode: ConfigInventoryMode;
  /** Free-text provenance for the honesty note, e.g.
   *  'central /configuration/v2/wlan · 6 groups'. */
  source?: string;
  /** Datasets the adapter tried and could not read (404 / no permission).
   *  Named here so the screen distinguishes "not read" from "none exist". */
  unavailable?: ('ssids' | 'vlans' | 'ports')[];
}

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
  /** Canonical site the alert belongs to. The authored fixtures compose the
   *  site into `meta`; a live mapper has the site as a field and would
   *  otherwise drop it (a live "Needs you now" row that cannot say where).
   *  Optional so the fixtures stay valid — renderers prefer it over parsing
   *  `meta`, and fall back to `meta` alone when it is absent. */
  siteName?: string;
  siteId?: SiteId;
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

/**
 * One row of the write broker's own audit log (data/change-log.jsonl), as
 * writeBroker.recentEvents() reads it back.
 *
 * Deliberately NOT ChangeLogEntry ({time,text,who}): that is the Overview
 * "Recent changes" projection, and reusing it would force the broker's real
 * fields through a prose string. This is the shape a GET /api/configure/history
 * would answer with (`{ events: BrokerAuditEvent[] }`, mirroring the existing
 * GET /api/configure/queue's `{ changes }`).
 *
 * SECURITY: rendered configuration bodies and payloads are NOT part of this
 * row and must never be added — the drawer shows what happened to a change,
 * not what was in it.
 */
export interface BrokerAuditEvent {
  ts: string; // ISO
  event: string; // 'queued' | 'push' | 'discard' | …
  changeId: string;
  ticket: string;
  kind: string; // ssid | port | vlan
  result: string; // the broker's own outcome word
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
  /** The source plane is behind (design rule 1): `age` was frozen at pull time
   *  and the row is unverified, not current. Absent = the source is fresh. */
  stale?: boolean;
}

/** The derived `danger` banner over the alert queue — the worst finding
 *  crossed with plane freshness (README §5). Null when there is nothing to
 *  correlate; never authored prose in live mode. */
export interface AlertCorrelation {
  title: string;
  body: string;
  /** Severity of the banner itself. A correlation over a stale plane is a
   *  'warning' ("we cannot see the estate"), one over live P1s is 'danger'
   *  ("the estate is on fire") — the client-side correlate() could only ever
   *  express the latter. Optional: absent keeps the renderer's existing
   *  default ('danger'), so the authored/derived banners are unchanged. */
  tone?: Tone;
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
  /** When the ticket was raised (ISO). Set on operator-raised tickets so `age`
   *  can be recomputed on read instead of frozen at raise time; absent on the
   *  authored fixtures, whose `age`/`sla` strings stay authoritative. */
  raisedAt?: string;
  /** SLA deadline (ISO) the `sla` countdown is rendered from. */
  slaDueAt?: string;
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
  /** Core switch — the terminal target the reachability panel offers. The
   *  empty string means "no shell-capable core is known at this site", which
   *  is what the demo branch must send when the authored core is one of the
   *  operator's hidden demo devices: a renderer must then offer NO terminal
   *  button rather than print a headless one. Kept a plain string (not
   *  nullable) so every authored fixture stays valid unchanged. */
  core: string;
  collectorNote: string;
  facts: Fact[];
  devices: SiteDeviceRow[];
  alerts: SiteAlertRow[];
}

/**
 * SiteDetail's "Local reachability" panel, derived rather than authored.
 *
 * In demo mode the four values live on SiteProfile; in live/blend mode there
 * is no authored profile, so the route computes them from the local collector
 * plane's registry state plus the LOCAL-claimed share of that site's devices
 * and sends this block instead. Kept a separate shape (not a partial
 * SiteProfile) because `reachValue` is nullable here: null = the portal does
 * not know the answering share and the panel must read '—', never 0%.
 */
export interface SiteReachability {
  /** Badge text for the collector row — the plane's health when linked,
   *  'not linked' when it is not. Never a claim beyond registry state. */
  collector: string;
  collectorTone: Tone;
  /** "Devices answering directly", 0-100. null = unknown (render '—'). */
  reachValue: number | null;
  /** The mono line under the bar: how the number was derived, or why there
   *  is none. */
  collectorNote: string;
  /** Terminal target for the panel's button — a LOCAL-claimed device at this
   *  site that can take a shell. null/absent = offer no terminal. */
  core?: string | null;
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
  /** Every plane that claims this device, worst-to-best display priority.
   *  `length > 1` is the double-claim of design rule 2 — the row stays one
   *  row and is flagged, never duplicated. Absent on the authored fixtures,
   *  which encode the double-claim in `state` instead. */
  claimedBy?: Plane[];
}

/**
 * What a lane header is actually asserting about its plane (design rule 1):
 *   synced  — a real last-sync stamp from the registry
 *   never   — the plane is linked but has never completed a sync
 *   stale   — the last sync has aged past the staleness window
 *   unknown — the payload carried NO lane meta for this plane; the header is
 *             non-asserting and must not claim the plane is linked
 */
export type LaneSyncState = 'synced' | 'never' | 'stale' | 'unknown';

/** Platform-lane header metadata (NT_LANE_META) — `mark` is the 2px rule colour. */
export interface LaneMeta {
  tone: Tone;
  sync: string;
  note: string;
  mark: string;
  /** Absent = 'synced' for the authored fixtures, which all carry a stamp.
   *  A lane built for an unmapped/unlinked plane sets 'unknown' so nothing
   *  downstream reads the header as a claim of linkage. */
  state?: LaneSyncState;
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
  /** The evidence rule this verdict came from ('scan.coverage.identity',
   *  'inventory.reconciliation', …) — the same ids /api/compliance reports.
   *  Optional: the authored profiles carry prose labels only. Renderers key
   *  on it when present, because a label is not unique across planes. */
  rule?: string;
}

/**
 * Per-device evidence block for the device-detail "Compliance" panel.
 *
 * `mode` exists so an EMPTY `checks` list can never be read as "everything
 * passes" (README honesty rule): 'unavailable' means no plane supplied the
 * evidence, and the panel must say so rather than render a clean scorecard.
 */
export interface DeviceEvidence {
  checks: DeviceCheckRow[];
  /** live  — recomputed from the plane rows this device was reconciled from
   *  demo  — the authored profile's checks
   *  unavailable — no evidence source; `checks` is empty and stays empty */
  mode: 'live' | 'demo' | 'unavailable';
  /** Why, when mode is 'unavailable' — surfaced verbatim as the gap note. */
  note?: string;
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

/**
 * The shell block /api/devices/:name serves alongside a device: the banner the
 * pane opens with and the quick-command chips under it, as the ROUTE computed
 * them. Declared here (not inline on the client envelope) so the demo branch,
 * the live branch and the screen all name ONE shape — the demo branch has sent
 * this since screens.ts:1587 while the live branch sent nothing, which is the
 * drift this type closes. Absent payload = fall back to the shared helpers
 * terminalBanner(kind) / terminalQuickCommands(kind).
 */
export interface DeviceTerminalPayload {
  banner: TerminalLine[];
  quickCommands: string[];
}

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

/**
 * One device→subscription assignment as an entitlement plane (GreenLake)
 * reports it. This is the missing half of the Licences screen: without it the
 * portal can count subscriptions but cannot say which devices are unlicensed,
 * so "Devices unlicensed" and the orphan/gap rows have nothing to derive from.
 *
 * Identity is `serial` (the one key GreenLake, Central and Mist all agree on —
 * see reconcile's identityKey). Everything else is optional: a field the
 * vendor did not return must stay absent, never a zero or an empty string
 * standing in for "unknown".
 */
export interface SubscriptionAssignment {
  serial: string;
  mac?: string;
  model?: string;
  deviceName?: string;
  deviceType?: string;
  /** True only when the plane says the device is assigned to a service.
   *  Absent = the plane did not report assignment state at all. */
  assigned?: boolean;
  /** The subscription key/SKU this device consumes; null = explicitly none. */
  subscriptionKey?: string | null;
  subscriptionTier?: string | null;
  /** ISO date the consuming subscription ends. */
  expires?: string | null;
  archived?: boolean;
}

// -- Configure (NtConfigure) --

/** Queued-change list row — the display-level view of a ChangeRequest. */
export interface QueuedChangeRow {
  state: 'ready' | 'applying' | 'needs window' | 'console';
  tone: Tone;
  what: string;
  where: string;
  ticket: string;
  /** The write broker's own change id. Present on rows the broker queued, so
   *  a change survives a reload and stays pushable; null/absent on the
   *  authored fixture rows, which is exactly what makes them correctly
   *  non-pushable (there is no queued change behind them). It is also the
   *  only stable React key for a server-listed queue. */
  id?: string | null;
  /** ISO end of the change's push lease. Absent = the row carries no lease
   *  (fixtures); an elapsed value means "re-queue before pushing", which the
   *  screen must say rather than offering a push that will be rejected. */
  expiresAt?: string | null;
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
  /** The vendor console this plane is administered in. Absent = the portal
   *  holds no console URL for it (the local collector has none, and a live
   *  plane only has one if the operator stored an endpoint) — "Open console"
   *  must then be inert and say so, not claim a hand-off it cannot make. */
  consoleUrl?: string;
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

/**
 * One credential input in the connect drawer beyond the endpoint variant.
 * `key` is the exact settings key the plane's adapter `isComplete()` reads —
 * saving a field under any other key produces a linked-but-stubbed plane.
 */
export interface ConnectField {
  key: string;
  label: string;
  help: string;
  secret?: boolean; // render as a password input and never echo back
  optional?: boolean; // adapter works without it
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

// ---------------------------------------------------------------------------
// Envelope, plane freshness and sync outcomes (README §"Design rules" 1)
// ---------------------------------------------------------------------------

/** Which source served a payload — every /api screen envelope carries it. */
export type DataSource = 'demo' | 'live';

/** The envelope fields that ride alongside every screen payload. Screens read
 *  these to say where the rows came from and how fresh they are. */
export interface EnvelopeMeta {
  dataSource: DataSource;
  /** Last successful sync for this section; null in live mode before the
   *  first poll lands. Never stamped from an empty or failed pull. */
  syncedAt?: string | null;
  /** Sections whose fixtures were swapped for live rows in blend mode. */
  blended?: string[];
  /** Set when the backend answered but could not serve the screen. */
  apiError?: string;
}

/** Registry plane ids — the same union the server's PLANE_IDS declares
 *  (SystemTypeKey is the connect-drawer subset; aos10 is brokered, not
 *  separately credentialed). */
export type PlaneKey = SystemTypeKey | 'aos10';

/** Datasets a plane can contribute — the keys of the server's PlanePull. */
export const PLANE_DATASET_KEYS = [
  'devices',
  'sites',
  'clients',
  'alerts',
  'authEvents',
  'subscriptions',
  'config',
  'assignments',
] as const;
export type PlaneDatasetKey = (typeof PLANE_DATASET_KEYS)[number];

/** The dataset keys that are ROW ARRAYS merged into the poller cache.
 *  `config` is a single object and `assignments` is an entitlement feed, not a
 *  screen row set — a merge loop must iterate this list, not every key. */
export const PLANE_ROW_DATASET_KEYS = [
  'devices',
  'sites',
  'clients',
  'alerts',
  'authEvents',
  'subscriptions',
] as const;
export type PlaneRowDatasetKey = (typeof PLANE_ROW_DATASET_KEYS)[number];

/**
 * What one pull actually achieved. The distinction the honesty rules need is
 * 'ok' vs 'empty': a call that succeeded and returned no rows is NOT a healthy
 * sync with data, and must not stamp a screen's freshness as current.
 *   ok              — every requested dataset came back, at least one row
 *   empty           — the plane answered, and reported nothing at all
 *   partial         — some datasets read, others could not be (404 / unparsable)
 *   failed          — the pull threw; last-good data is being served
 *   not-implemented — a stub adapter: no sync happened, nothing to stamp
 *   skipped         — not polled this cycle (in flight, unlinked, demo mode)
 */
export type SyncOutcome = 'ok' | 'empty' | 'partial' | 'failed' | 'not-implemented' | 'skipped';

/** The result of one plane pull, in the form the registry stamps and the
 *  Systems screen renders. `reported` is what actually came back; `missing`
 *  is what the plane could not read — an absent dataset is unknown, never an
 *  authoritative zero. */
export interface PlaneSyncResult {
  outcome: SyncOutcome;
  at: string; // ISO — when the pull settled
  reported: PlaneDatasetKey[];
  missing: PlaneDatasetKey[];
  rows: number; // total rows across the reported datasets
  note: string | null;
}

/** Age of a plane's last successful sync, and whether it has expired.
 *  A stale plane's devices read `unverified`, never `up` (design rule 1). */
export interface PlaneFreshness {
  lastSync: string | null;
  ageSec: number | null; // null when the plane has never synced
  stale: boolean; // never synced, or older than the staleness window
}

/** Registry health vocabulary, mirrored here so the freshness helpers can be
 *  shared by the server registry, the poller and the screen endpoints (the
 *  server's PlaneHealth is the same union). */
export type PlaneHealthKey = 'healthy' | 'warning' | 'degraded' | 'unlinked';

/**
 * Why a plane's rows cannot be presented as current:
 *   never-synced — linked, but no successful pull has ever landed
 *   aged-out     — the last successful pull is older than staleAfterSec
 *   degraded     — the last pull failed; last-good data is being served
 *   partial      — the pull succeeded but some datasets could not be read
 *   null         — the plane is current (or unlinked, so it contributes none)
 */
export type PlaneStaleReason = 'never-synced' | 'aged-out' | 'degraded' | 'partial' | null;

/** Plane freshness plus WHY it is stale — one definition for the registry,
 *  the poller and every screen that has to render `unverified`. */
export interface PlaneStaleness extends PlaneFreshness {
  reason: PlaneStaleReason;
}

/** How a change can reach a plane — the capability-matrix `mode` vocabulary. */
export type WriteMode = 'brokered' | 'ssh' | 'read only';

/** Granted scope on a plane — the same vocabulary as System.scope. */
export type PlaneScope = 'read only' | 'read + broker' | 'read + ssh';
