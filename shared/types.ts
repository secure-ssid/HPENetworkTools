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
  | 'SSE'
  | 'THIRD-PARTY';

export type Sev = 'P1' | 'P2' | 'P3';

/** Shell views (HpeNetworkTools state.view). */
export type View =
  | 'overview'
  | 'alerts'
  | 'tickets'
  | 'clients'
  | 'auth'
  | 'inventory'
  | 'sites'
  | 'site'
  | 'devices'
  | 'device'
  | 'licenses'
  | 'greenlake'
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
  scope: PlaneScope;
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
  /** Immutable inventory identity when the row can be joined unambiguously. */
  plane?: Plane;
  serial?: string;
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
  /** Legacy free-text target (CLI preview only — see the demo `ap-group`
   *  template in shared/logic.ts ssidPreview). The direct Central apply path
   *  NEVER reads this field; it targets `scopeIds` instead. Kept only so the
   *  CLI-flavoured preview/blast-radius renderers stay byte-identical for
   *  demo mode and existing tests. */
  group: string;
  bands: SsidBands;
  broadcast: boolean;
  isolate: boolean;
  noDfs: boolean;
  plane: string; // display label of the owning plane(s), drives preview meta
  // -- direct New Central apply (immutable plane-native ids, never free text) --
  /** Selected scope-map targets — SsidScopeOption.id values (a site, a site
   *  collection, an AP device group, or one AP). Required, non-empty, before
   *  a direct apply can run. */
  scopeIds?: string[];
  /** The role assigned on this WLAN (New Central `default-role`). Required by
   *  every security mode per the editor's live dependency catalog. */
  defaultRole?: string;
  /** Authentication server-group id — required for WPA2/WPA3 Enterprise. */
  authServerGroupId?: string;
  /** Captive-portal profile id — required for psk-portal. */
  captivePortalProfileId?: string;
  /** PSK passphrase — required for wpa2-psk / psk-portal. Write-only: never
   *  returned by a catalog/apply response, never logged, never audited. */
  passphrase?: string;
}

export interface PortForm {
  device: string;
  /** Exact device identity. Legacy name-only forms are accepted only uniquely. */
  plane?: Plane;
  serial?: string;
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
// SSID direct-write catalog & apply — New Central network-config v1alpha1.
//
// SSIDs no longer go through the ticketed write broker's queue/push: New
// Central's real config surface is a named WLAN profile upsert
// (/network-config/v1alpha1/wlan-ssids/{ssid}) plus separate configuration
// assignments (/network-config/v1alpha1/config-assignments), reviewed and
// applied directly. These
// types are the editor's catalog (what CAN be picked, read live from Central,
// never guessed) and the apply outcome (what happened, reported per step).
// ---------------------------------------------------------------------------

/** Category of an SSID assignment target — the New Central config scope
 *  model's four selectable kinds. `id` is the immutable plane-native scope
 *  id used in a config-assignment; a free-text group name is never one. */
export type SsidScopeCategory = 'site' | 'site-collection' | 'ap-group' | 'ap';

/** One selectable scope target. */
export interface SsidScopeOption {
  id: string;
  label: string;
  category: SsidScopeCategory;
}

/** One selectable security dependency (role, authentication server group,
 *  captive-portal profile) — an immutable plane-native id, not a label. */
export interface SsidDependencyOption {
  id: string;
  label: string;
}

/** The catalog sections the SSID editor needs and might not get. Naming
 *  matches SsidCatalog's own field names so the screen can say precisely
 *  what this tenant/gateway did not answer, instead of a generic
 *  "catalog unavailable". */
export type SsidCatalogSection =
  | 'sites'
  | 'site-collections'
  | 'ap-groups'
  | 'aps'
  | 'roles'
  | 'authServerGroups'
  | 'captivePortalProfiles';

/**
 * Everything the SSID editor needs to render live scope/dependency pickers,
 * read from New Central's own config APIs — never guessed. A section this
 * tenant/gateway could not answer is named in `unavailable`, not silently
 * emptied: an adapter that cannot read authentication server groups says so,
 * rather than
 * implying the tenant simply has none, and the screen disables Apply for a
 * security mode that needs a section named here.
 */
export interface SsidCatalog {
  scopes: SsidScopeOption[];
  roles: SsidDependencyOption[];
  authServerGroups: SsidDependencyOption[];
  captivePortalProfiles: SsidDependencyOption[];
  unavailable: SsidCatalogSection[];
  source: string; // free-text provenance, e.g. 'Central /network-config/v1alpha1 · 6/7 sections'
}

/** What a security mode requires before Apply can be enabled — computed from
 *  SsidSecurity alone (see shared/logic.ts ssidDependencyRequirementsFor). */
export interface SsidDependencyRequirement {
  role: boolean;
  authServerGroup: boolean;
  captivePortal: boolean;
  passphrase: boolean;
}

/** One step of a direct SSID apply. `ok` is true ONLY on a confirmed 2xx/
 *  verified outcome — never assumed. */
export interface SsidApplyStep {
  ok: boolean;
  httpCode?: number;
  message: string;
}

/** The profile half of a direct apply — GET/POST-or-PATCH/verify collapsed
 *  into one reported action. */
export interface SsidProfileStepResult extends SsidApplyStep {
  action: 'created' | 'updated' | 'unchanged' | 'failed';
  verified: boolean;
}

/** One configuration-assignment outcome. `skipped` means it was already on file
 *  (idempotent no-op) — still ok:true, just not a new write.
 *
 *  `verified` mirrors SsidProfileStepResult.verified for the assignment half:
 *  true when a re-read of the assignment list found it, false when that read
 *  succeeded and the assignment was absent (the write was accepted but has not
 *  landed), and undefined when the confirming read could not be made at all.
 *  Undefined is deliberately NOT false — an unreadable list is not an empty
 *  one, and reporting a missing assignment we never actually looked for would
 *  be its own lie. */
export interface SsidScopeAssignmentResult extends SsidApplyStep {
  scopeId: string;
  label: string;
  skipped?: boolean;
  verified?: boolean;
}

/**
 * The full direct-apply outcome. `ok` is true only when the profile step AND
 * every assignment succeeded; a profile success with any assignment failure
 * is `partial`, never `ok` — a successfully created/updated profile is NEVER
 * rolled back automatically just because a later assignment failed (see
 * server/src/services/ssidDirectWrite.ts).
 */
export interface SsidApplyResult {
  ok: boolean;
  partial: boolean;
  profile: SsidProfileStepResult;
  assignments: SsidScopeAssignmentResult[];
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

// ---------------------------------------------------------------------------
// Scalable inventory navigation
// ---------------------------------------------------------------------------

export type InventoryNodeKind =
  | 'group'
  | 'system'
  | 'site'
  | 'device-group'
  | 'device'
  | 'sse-kind'
  | 'sse-object'
  | 'switch'
  | 'port';

export type InventoryNodeReadState =
  | 'current'
  | 'empty'
  /** Linked, credentials accepted, but no successful pull has happened yet.
   *  Distinct from 'empty' (read, and there was nothing) and from 'stale'
   *  (read once, and that answer has aged out) — this node has never carried
   *  an answer at all, so it must not render as either. */
  | 'never-synced'
  | 'denied'
  | 'unsupported'
  | 'failed'
  | 'stale'
  | 'unlinked';

/** One bounded, secret-free node in the shared shell/full-page inventory tree. */
export interface InventoryTreeNode {
  id: string;
  parentId: string | null;
  kind: InventoryNodeKind;
  label: string;
  meta?: string;
  count?: number;
  status: InventoryNodeReadState;
  tone: Tone;
  hasChildren: boolean;
  childCount?: number;
  target?: string;
  identity?: {
    plane?: string;
    serial?: string;
    siteId?: string;
    sseKind?: SseObjectKind;
    objectId?: string;
  };
}

export interface InventoryTreePage {
  parentId: string | null;
  nodes: InventoryTreeNode[];
  total: number;
  nextCursor: string | null;
  query: string;
}

export interface InventorySearchPage {
  nodes: InventoryTreeNode[];
  total: number;
  nextCursor: string | null;
  query: string;
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
  /** Whether the plane holds credentials and is actually polled. The Overview
   *  panel collapses the ones that are not; deriving that from the `state`
   *  string would break the moment the wording changes. */
  linked: boolean;
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
  /**
   * Who made the change: the signed-in principal, or `operator` when the
   * portal is running without an identity provider. A name is not a payload —
   * it is the one thing this row previously could not say.
   */
  who?: string;
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
  /** Identity hint carried straight from the reconciled row so the site
   *  device table's "open" link can name the exact physical device — two
   *  rows can share `name` after reconciliation (see DeviceIdentityHints in
   *  services/reconcile.ts). Absent on the authored fixtures, which carry
   *  none. */
  serial?: string;
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
  /** The prose form, kept for the authored demo rows whose facts differ per
   *  device class ('port 1/1/20 · MAB · vlan 820' on a switch, '5 GHz · −52
   *  dBm' on an AP) and so do not share a column set. */
  detail: string;
  /** The same facts kept apart so the screen can column them instead of
   *  re-splitting the sentence above. A live row carries these; an authored
   *  one does not, and the table falls back to `detail` for the whole set. */
  model?: string | null;
  mac?: string | null;
  ip?: string | null;
  where?: string | null;
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

// -- GreenLake platform sections (users, locations) --

/** The GreenLake platform sections the portal reads beyond subscriptions and
 *  assignments.
 *
 *  `roleAssignments` is the ONLY role surface available: GLP withdrew
 *  `GET /authorization/v1beta1/roles` from the public API on 2026-02-10 (it
 *  answers 405, the route is registered but listing is gone), so the portal
 *  can enumerate who holds which role but cannot enumerate the role
 *  catalogue. Note the version is `v1beta1` — v1/v2/v1alpha1/v2alpha1 all
 *  404, and the whole /authorization surface is only routed for workspaces
 *  with enhanced IAM (RBAC v2) enabled. */
export const GREENLAKE_SECTION_KEYS = ['users', 'locations', 'roleAssignments'] as const;
export type GreenLakeSectionKey = (typeof GREENLAKE_SECTION_KEYS)[number];

/** Per-section read outcome — the SseKindReadStatus pattern. A failed section
 *  is evidence of a failure, never an authoritative empty list. */
export type GreenLakeSectionStatus =
  | { state: 'ok' }
  | {
      state: 'failed';
      /** 'denied' 401/403, 'missing' 404 on every candidate, 'error' anything
       *  else (network, 5xx, unreadable payload). */
      reason: 'denied' | 'missing' | 'error';
      httpCode: number | null;
      /** Operator-safe explanation only: never a response body or a token. */
      message: string;
    };

/** A workspace member. `username` is the login (an email on GLP); the portal
 *  never stores or displays anything that could authenticate as them. */
export interface GreenLakeUser {
  id: string;
  username: string;
  firstName?: string;
  lastName?: string;
  /** Raw GLP userStatus ('VERIFIED', 'UNVERIFIED', …) — displayed as given so
   *  an unfamiliar status is never silently normalised into a friendly one. */
  status?: string;
  lastLogin?: string | null;
  createdAt?: string | null;
}

/** A workspace location (GLP's site/address record). */
export interface GreenLakeLocation {
  id: string;
  name: string;
  type?: string;
  /** Single-line postal summary assembled from the address record. */
  address?: string;
  country?: string;
  deviceCount?: number | null;
}

/** One principal→role grant. GLP returns the principal as '{type}:{id}' with
 *  an UNDASHED uuid, while /identity/v1/users returns a DASHED one — the
 *  adapter normalises both sides before joining, so `principalName` is null
 *  only when the principal genuinely is not a known workspace user (an
 *  api-client, or a user the token cannot see). */
export interface GreenLakeRoleAssignment {
  id: string;
  /** Verbatim GLP principal, e.g. 'user:6aec904ab3a14951b8dc607081928170'. */
  principal: string;
  /** 'user' | 'user-group' | 'api-client' — the principal's prefix. */
  principalType: string;
  /** Resolved login when the principal joins a known user; null when not. */
  principalName: string | null;
  /** Short role slug for display, e.g. 'ccs.account-admin'. */
  role: string;
  /** Full role GRN as granted. */
  roleGrn: string;
  /** GRN scopes the grant applies to (workspace, tenant group, scope group). */
  scope: string[];
  /** 'LOCAL' etc. — where the grant came from. */
  source?: string;
  createdAt?: string | null;
}

/** The GreenLake platform inventory beyond licences — one PlanePull.greenlake
 *  per pull(), the same "structured object, not a row array" pattern as
 *  `config` and `sse`. */
export interface GreenLakeInventory {
  users: GreenLakeUser[];
  locations: GreenLakeLocation[];
  roleAssignments: GreenLakeRoleAssignment[];
  /** Sections that could not be read. A key listed here means the matching
   *  array is NOT an inventory — it is empty because the read failed. */
  unavailable: GreenLakeSectionKey[];
  readStatus: Partial<Record<GreenLakeSectionKey, GreenLakeSectionStatus>>;
  /** Free-text provenance, e.g. 'global.api.greenlake.hpe.com · 3 of 3 sections read'. */
  source: string;
}

/** The reviewed GreenLake writes the portal supports. Deliberately a closed
 *  allowlist, not a generic passthrough: no route here forwards a
 *  caller-supplied path or method to the GLP API.
 *
 *  There is no `deleteDevice`: DELETE /devices/v1/devices/{id} answers 405 on
 *  the GLP gateway, so device add is one-way and the portal must not offer a
 *  removal it cannot perform. */
export const GREENLAKE_WRITE_ACTIONS = [
  'inviteUser',
  'deleteUser',
  'createLocation',
  'deleteLocation',
  'addDevices',
  'addSubscription',
  'assignRole',
  'removeRoleAssignment',
] as const;
export type GreenLakeWriteAction = (typeof GREENLAKE_WRITE_ACTIONS)[number];

/** Outcome of one reviewed GreenLake write.
 *
 *  `accepted` is NOT `applied`: the subscriptions endpoints answer 202 with a
 *  transaction id and validate asynchronously, so a 202 means the workspace
 *  took the request, not that it succeeded. Collapsing the two would tell an
 *  operator a subscription was added when the key may still be rejected. */
export interface GreenLakeWriteResult {
  action: GreenLakeWriteAction;
  outcome: 'applied' | 'accepted';
  /** Operator-safe summary — never a token or a raw response body. */
  detail: string;
  /** Present only for async (202) actions; the workspace's handle for it. */
  transactionId?: string | null;
  /** Identifier of the object created, when the API returned one. */
  id?: string | null;
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
  /**
   * Whether the plane holds credentials at all. Configure collapses the
   * planes that hold none behind one line, and it must not decide that by
   * pattern-matching `note` — the prose is written for a human and is free to
   * change wording without silently un-collapsing the list.
   */
  linked: boolean;
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
export type SystemTypeKey =
  | 'central'
  | 'mist'
  | 'classic'
  | 'greenlake'
  | 'aos8'
  | 'local'
  | 'clearpass'
  | 'uxi'
  | 'sse';

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
  'sse',
  'greenlake',
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
export type PlaneScope = 'read only' | 'read + broker' | 'read + ssh' | 'read + direct';

// ---------------------------------------------------------------------------
// HPE Aruba Networking SSE (formerly Axis Security / Atmos) — object
// inventory, mutation and commit contracts.
//
// The SSE Admin API (verified against the official `pyhpesse` SDK source,
// aruba/pyhpesse pyhpesse/adminapi.py) is a paged object-management API, not
// a network-monitoring one: there are no devices/clients/alerts, only a
// handful of writable resource collections that back its own console. The
// portal manages nine of them; WebCategories, SslExclusions, ApplicationGroups
// and SubLocations are read by nobody here and stay out of this union so a
// route can never be asked to touch a resource this file does not name.
// ---------------------------------------------------------------------------

/** Object kinds the portal manages on the SSE plane. `applications` is the
 *  NetworkRange application shape only (the SDK's other application types are
 *  not selected). `locations`, `tunnels` and `applications` are documented by
 *  the vendor as limited-release surfaces — a 404 on them is "not entitled
 *  for this tenant", never "this tenant has none". */
export const SSE_OBJECT_KINDS = [
  'connectorZones',
  'connectors',
  'locations',
  'tunnels',
  'applications',
  'users',
  'groups',
  'customIpCategories',
  'ipFeedCategories',
] as const;
export type SseObjectKind = (typeof SSE_OBJECT_KINDS)[number];

/** Display labels for the inventory browser's grouped/searchable list. */
export const SSE_OBJECT_KIND_LABELS: Record<SseObjectKind, string> = {
  connectorZones: 'Connector zones',
  connectors: 'Connectors',
  locations: 'Locations',
  tunnels: 'Tunnels',
  applications: 'Applications (network range)',
  users: 'Users',
  groups: 'Groups',
  customIpCategories: 'Custom IP categories',
  ipFeedCategories: 'IP-feed categories',
};

/** Limited-release kinds — a 404 reads as "not entitled on this tenant" in the
 *  UI, not as an empty state (README honesty rule 1). */
export const SSE_LIMITED_RELEASE_KINDS: readonly SseObjectKind[] = ['locations', 'tunnels', 'applications'];

/**
 * One row in an SSE object list — the fields common enough across all nine
 * kinds to render one searchable grouped table without per-kind columns.
 * `raw` carries the vendor object verbatim (never a secret: SSH private keys
 * on a `users` row are stripped before this leaves the adapter) so the detail
 * / edit drawer has the kind-specific fields the SDK body shapes need.
 */
export interface SseObjectSummary {
  kind: SseObjectKind;
  id: string;
  name: string;
  description?: string;
  enabled?: boolean;
  /** True when the vendor marks this row as built-in/system-defined. The UI
   *  must not offer edit/delete for it even though the kind itself is
   *  otherwise writable — never fabricate a control the plane cannot honour. */
  builtIn?: boolean;
  /** Free-text secondary fact for the list row (a connector's zone, a
   *  tunnel's location, a user's email — whatever that kind's SDK body makes
   *  the second most useful field). */
  detail?: string;
  /** The vendor object, secrets stripped. The edit drawer's initial values. */
  raw: Record<string, unknown>;
}

/** One SSE object kind's slice of the inventory. */
export interface SseObjectKindResult {
  rows: SseObjectSummary[];
  /** Total the API reports, when knowable; null when a full page could not
   *  prove the repository size (mirrors ClearPass's extractTotal — a full
   *  page whose only count describes itself proves nothing about the rest). */
  total: number | null;
  /** True when the per-kind row cap truncated the walk — a partial list, not
   *  the entire repository, so the UI can say so instead of implying nine
   *  kinds were read in full every poll. */
  truncated: boolean;
}

/** Secret-free outcome of reading one SSE inventory kind. */
export type SseKindReadFailureReason =
  | 'denied'
  | 'unsupported'
  | 'service-error'
  | 'unreachable'
  | 'invalid-response'
  | 'not-synced';

export type SseKindReadStatus =
  | { state: 'ok' }
  | {
      state: 'failed';
      reason: SseKindReadFailureReason;
      httpCode: number | null;
      /** Operator-safe explanation only: never a response body, URL, or token. */
      message: string;
    };

/** The SSE plane's whole object inventory — one PlanePull.sse per pull(). */
export interface SseInventory {
  /** Absent key = never attempted. Present key = attempted; see `unavailable`
   *  for whether it actually answered. */
  kinds: Partial<Record<SseObjectKind, SseObjectKindResult>>;
  /** Kinds the token could not read (401/403 — scope denies it; 404 on a
   *  limited-release kind — not entitled) — unavailable, never reported as an
   *  authoritative empty list. */
  unavailable: SseObjectKind[];
  /** Per-kind read outcome. Optional only for compatibility with an older
   * cached/first-sync-pending inventory; current pulls populate every kind. */
  readStatus?: Partial<Record<SseObjectKind, SseKindReadStatus>>;
  /** Free-text provenance for the honesty note, e.g.
   *  'admin-api.axissecurity.com · 7 of 9 object kinds read'. */
  source: string;
}

/** create/update/delete — the three SSE mutation actions the review dialog
 *  and the allowlisted server routes support. */
export type SseMutationAction = 'create' | 'update' | 'delete';

/** A validated write against one SSE object — the server route's typed input
 *  after allowlist + required-field validation. NEVER an arbitrary path: the
 *  route resolves `kind` through the same SSE_OBJECT_KINDS-keyed lookup table
 *  the adapter uses for reads. */
export interface SseMutationRequest {
  kind: SseObjectKind;
  action: SseMutationAction;
  id?: string; // required for update/delete
  fields?: Record<string, unknown>; // required for create/update
  /** The direct-write review gate (ssidDirectWrite.ts's pattern) — must be
   *  exactly `true`, standing in for a ticket reference this plane has none of. */
  reviewConfirmed?: boolean;
}

/** Explicit input for removing an ambiguous, non-commit-eligible journal
 * after the operator has reconciled the tenant in the SSE admin console. */
export interface SseManualCleanupRequest {
  /** General reviewed-write gate; must be exactly true. */
  reviewConfirmed?: boolean;
  /** Separate attestation that manual tenant reconciliation is complete. */
  manualReconciled?: boolean;
}

/** Outcome of the mutation call itself, BEFORE any commit is attempted. */
export interface SseMutationOutcome {
  ok: boolean;
  httpCode: number | null;
  id?: string;
  message: string;
  /** Whether the plane definitely accepted/rejected the request, or the
   * transport failed after acceptance became unknowable. */
  acceptance?: 'accepted' | 'rejected' | 'unknown';
}

/** Outcome of the mandatory POST /Commit that follows a successful mutation.
 *  `attempted: false` means the mutation itself failed, so no commit was even
 *  tried — replaying a commit for a change that never landed would be a lie. */
export interface SseCommitOutcome {
  attempted: boolean;
  ok: boolean;
  httpCode: number | null;
  message: string;
  /** A transport failure is `unknown`, never a definite rejection. */
  acceptance?: 'accepted' | 'rejected' | 'unknown' | 'not-attempted';
  /** Present whenever a commit was actually attempted — SSE's /Commit
   *  endpoint is TENANT-WIDE: it applies every currently staged change on the
   *  tenant, not only the one mutation that triggered this call. The UI must
   *  surface this every time, not just imply "your change committed". */
  warning?: string;
}

/**
 * Whether the poller's cached inventory was actually refreshed after a
 * mutation/commit-retry so the UI never silently keeps presenting the
 * last-good (now stale) inventory as if it were current.
 *   'refreshed' — poller.syncNowFor('sse') ran and returned 'ok'.
 *   'stale'     — a refresh was attempted but did not complete (the poll
 *                 returned 'error'/'skipped', or threw) — the cache may still
 *                 reflect the pre-change state until the next scheduled sync.
 *   'skipped'   — no refresh was attempted at all (nothing changed to refresh
 *                 for, e.g. the mutation itself failed).
 */
export interface SseCacheRefreshOutcome {
  attempted: boolean;
  status: 'refreshed' | 'stale' | 'skipped';
  message: string;
}

/**
 * The full result an SSE mutation route returns. Mutation and commit are
 * reported SEPARATELY. `staged: true` is reserved for the provable case where
 * the mutation succeeded and Commit definitely rejected/non-2xx, which is
 * the only state eligible for commit-only retry. Transport-unknown outcomes
 * use `outcome: 'unknown'` with `staged: false` and require manual
 * reconciliation. `cacheRefresh` reports whether the just-mutated state is
 * actually visible in the cached inventory yet.
 */
export interface SseMutationResult {
  mutation: SseMutationOutcome;
  commit: SseCommitOutcome;
  staged: boolean;
  /** Explicit aggregate state; `unknown` means durable recovery is required. */
  outcome?: 'applied' | 'unverified' | 'staged' | 'unknown' | 'rejected';
  cacheRefresh: SseCacheRefreshOutcome;
}

/** Commit-only retry's result — never replays the original mutation, so
 *  there is no `mutation` outcome to report, only the commit attempt and
 *  whether the cache now reflects it. */
export interface SseCommitRetryResult {
  commit: SseCommitOutcome;
  cacheRefresh: SseCacheRefreshOutcome;
  /** Commit acceptance alone never proves the journaled object mutation. */
  recovery?: SseRecoveryOutcome;
}

/** Machine-readable journal recovery result shared by retry and cleanup. */
export interface SseRecoveryOutcome {
  journalPhase: string;
  /** Machine-readable route taken by reviewed recovery. */
  action:
    | 'commit-retry'
    | 'refresh-and-cleanup'
    | 'cleanup-only'
    | 'manual-reconciliation'
    | 'manual-cleanup';
  /** Durable journal disposition when the recovery path reports one. */
  status?: 'journal-removed' | 'journal-retained';
  mutationVerified: boolean;
  message: string;
}

/** Cleanup-only result for an operator-reconciled ambiguous journal. */
export interface SseManualCleanupResult {
  commit: SseCommitOutcome;
  cacheRefresh: SseCacheRefreshOutcome;
  recovery: SseRecoveryOutcome & {
    action: 'manual-cleanup';
    status: 'journal-removed' | 'journal-retained';
  };
}

// ---------------------------------------------------------------------------
// On-demand plane DETAIL reads (per-object). NOT poller datasets.
// ---------------------------------------------------------------------------
//
// The poller reads a handful of FLAT LISTS (/clients, /aps, /switches, /sites)
// on a 60s timer. A control plane models one client across ~8 endpoints and one
// device across many /{id}/subresource endpoints, so everything a list does not
// carry — signal history, roaming trail, per-radio RF, per-port wiring, site
// topology — is only obtainable with a PER-OBJECT read.
//
// Those reads are ON-DEMAND: issued for the ONE object a drawer is opening, on
// the detail request path, behind a short TTL cache. They must NEVER be added
// to the poll loop — 9 devices x N subresources x 1440 polls/day would exhaust
// the tenant's daily call budget, and a fix that hammers the plane is a
// regression, not a fix.
//
// THREE STATES, everywhere. The whole point of these shapes is that
// "we never asked", "we asked and there is genuinely nothing" and "we asked and
// the call failed" are three different sentences on screen:
//
//   not-fetched — the section was not requested (cheap render, cache miss
//                 pending, plane unlinked). Render the existing empty state.
//   ok          — fetched, and the plane returned rows.
//   empty       — fetched, and the plane authoritatively returned nothing.
//                 THIS IS NOT AN ERROR: a stationary camera with no roams is
//                 "no roaming in the last 24h", never "no source".
//   failed      — the call 404'd, timed out or threw. Keep the honest empty
//                 state; never substitute a fabricated or stale value.
//
// An ABSENT array and an EMPTY array therefore do not mean the same thing:
//   rows === undefined -> nothing was fetched
//   rows.length === 0  -> consult DetailSource.sections for 'empty' vs 'failed'

/** Outcome of one section of a detail read — see the three-state note above. */
export type DetailFetchState = 'not-fetched' | 'ok' | 'empty' | 'failed';

/**
 * Provenance envelope carried by every detail payload: which plane answered,
 * when, and what happened to each section of the read.
 *
 * `sections` is PARTIAL on purpose — a key that is absent was not attempted,
 * which is exactly 'not-fetched'. Use detailState() (shared/logic.ts) rather
 * than indexing it directly so the default is applied consistently.
 */
export interface DetailSource<S extends string = string> {
  /** The plane the read was issued against. */
  plane: PlaneKey;
  /** ISO — when the read settled (NOT when the poller last synced). */
  at: string;
  /** Per-section outcome. Absent key = 'not-fetched'. */
  sections: Partial<Record<S, DetailFetchState>>;
  /** Whether these rows came from the TTL cache rather than a fresh call.
   *  Absent = unknown/not tracked. */
  cached?: boolean;
  /** One honest sentence about the read as a whole, surfaced verbatim when a
   *  section failed ("Central token refresh failed", "read timed out"). Never
   *  invented prose, and never a credential or URL with a secret in it. */
  note?: string | null;
}

/** Sections of a client detail read — one key per thing the drawer renders,
 *  so a renderer can ask "what happened to `roams`?" and get a straight
 *  answer even when several fields come from one endpoint. */
export type ClientDetailSection =
  | 'rssi'
  | 'tput'
  | 'roams'
  | 'timeline'
  | 'usageSeries'
  /** The AP radio the client is actually associated to (/aps/{serial}/radios,
   *  matched by band+channel). 'empty' = the radio list came back but no radio
   *  could be matched without guessing. */
  | 'servingRadio'
  /** The physical path AP -> switch port, read off the site topology link.
   *  'empty' = the topology has no link for this AP. */
  | 'wiring';

/** Sections of a device detail read. */
export type DeviceDetailSection = 'radios' | 'wlans' | 'ports';

/** Sections of a site topology read. */
export type SiteTopologySection = 'nodes' | 'links';

/** What a client timeline entry describes. 'other' keeps an unmapped plane
 *  event renderable instead of dropping it. */
export type ClientTimelineKind =
  | 'roam'
  | 'connect'
  | 'disconnect'
  | 'auth'
  | 'dhcp'
  | 'other';

/**
 * One event on a client's session timeline. Built from the plane's own event
 * feed (Central: /clients/{mac}/mobility-trail) — never stitched from the demo
 * topology fixtures, which would fabricate hops through devices the live estate
 * does not have.
 */
export interface ClientTimelineEvent {
  ts: string; // ISO
  kind: ClientTimelineKind;
  /** Human sentence for the row, as close to the plane's own words as
   *  possible ("roamed ap-3f-12 -> ap-3f-08, 5 GHz ch 36"). */
  detail: string;
  /** Device the event happened on/at (name or serial as the plane gave it). */
  device?: string;
  /** Switch port or AP radio the event happened on. */
  port?: string;
  /** VLAN id/name at the time of the event. */
  vlan?: string;
  /** Signal at the moment of the event, dBm (MobilityDetails.rssi). */
  rssiDbm?: number | null;
  /** Radio band, as the plane words it ('5 GHz'). */
  band?: string;
  /** Channel, as the plane words it — Central returns '157E'/'213S', i.e. a
   *  channel plus a width marker, so this is a STRING not a number. */
  channel?: string;
  /** WLAN/SSID the event relates to. */
  wlan?: string;
}

/** One usage sample from a plane's usage series (Central /clients-usage
 *  returns [txUsage, rxUsage] byte pairs on a fixed sampling interval). */
export interface UsageSample {
  ts: string; // ISO — start of the sample bucket
  txBytes: number | null;
  rxBytes: number | null;
}

/**
 * The AP radio a wireless client is actually associated to.
 *
 * WHY THIS EXISTS: Central's Client schema has NO rssi and NO retries — those
 * fields are modelled PER AP RADIO (RadioListResponseV1.retries), never per
 * client. The only honest way to fill the drawer's RETRIES / noise-floor rows
 * is to name the radio the client is on and say the number is THE RADIO'S.
 * Matched by band+channel against /aps/{serial}/radios — see
 * matchServingRadio() in shared/logic.ts, which returns null rather than
 * guessing when the match is ambiguous.
 *
 * RENDERERS MUST LABEL THESE AS THE RADIO'S, not the client's: `retries` is
 * the serving radio's frame-retry percentage across all its clients.
 *
 * TYPES: Central sends every metric here as a STRING ('-97', '0.51', '98').
 * The adapter normalizes to numbers so no renderer parses; a value the plane
 * omitted or could not be parsed is `null`, NEVER 0.
 */
export interface ServingRadio {
  /** Serial of the AP the client is attached to (Client.connectedDeviceSerial). */
  serial: string;
  /** That AP's name, as the plane words it ('MBB-515'). */
  apName: string;
  /** radioNumber — 0/1/2 on a tri-radio AP. */
  radioNumber: number | null;
  /** '2.4 GHz' | '5 GHz' | '6 GHz', as the plane words it. */
  band: string;
  /** Channel AS THE PLANE WORDS IT — '6', '40E', '157E'. The trailing letter
   *  is a bonding marker, so this is a string, not a number. */
  channel: string;
  /** Noise floor, dBm (negative). The other half of the RSSI derivation —
   *  see deriveRssiDbm() in shared/logic.ts. */
  noiseFloorDbm: number | null;
  /** Frame retries, percent 0-100. THE RADIO'S, not this client's. */
  retries: number | null;
  /** Central's own channel-quality score, 0-100. */
  channelQuality: number | null;
  /** Channel utilization, percent 0-100. */
  channelUtilPct: number | null;
  /** Clients associated to this radio (this client is one of them). */
  clients: number | null;
}

/**
 * The physical path from a wireless client's AP to the switch it hangs off.
 *
 * Derived from ONE topology link (SiteTopologyLive.links) whose near or far end
 * is the client's AP — never from the demo fixtures, and never guessed. When
 * the topology carries no link for that AP this is ABSENT and the drawer keeps
 * its honest empty state.
 */
export interface ClientWiring {
  /** The AP the client is associated to, as the plane names it. */
  apName: string;
  apSerial: string;
  /** The switch at the far end of the AP's uplink. */
  switchName: string;
  switchSerial: string;
  /** Switch port the AP is patched into, as the plane words it ('1/1/8'). */
  port: string;
  /** Link speed in BITS PER SECOND (Central reports 1000000000 for a 1 Gb
   *  link). null/absent = the plane reported no speed. */
  speedBps?: number | null;
  /** 'Good' | 'Unknown' | null, as the plane words it — the plane's verdict on
   *  the link, not ours. */
  linkHealth?: string | null;
}

/**
 * Per-client detail, fetched on demand for ONE client.
 *
 * Every data field is optional: absent means the section was not fetched (or
 * the plane returned no value for it), and `source.sections` says which.
 * `null` means the plane answered and reported no value — do not render a
 * number for it, and do not blame the plane for a field it never models
 * (see planeSupportsClientField in shared/logic.ts).
 */
export interface ClientDetailLive {
  /** The MAC the read was issued for, normalized as the caller passed it. */
  mac: string;
  /** Signal, dBm (negative). Wired clients have no radio: expect
   *  'not-fetched'/null, and the renderer must say "wired link", not
   *  "not reported". */
  rssi?: number | null;
  /** Throughput in BITS PER SECOND, derived from the plane's usage window
   *  (bytes x 8 / window). Central reports usage totals, not an instantaneous
   *  rate, so this is an average — `tputWindowSec` is what a renderer must
   *  label it with ("avg over 3h"), never "current rate". */
  tput?: number | null;
  /** The window `tput` was averaged over, seconds. */
  tputWindowSec?: number;
  /** Roam count in `roamsWindowSec`. 0 is a REAL answer for a stationary
   *  client and must render as "no roaming in the last 24h". */
  roams?: number | null;
  /** The lookback `roams`/`timeline` cover, seconds. */
  roamsWindowSec?: number;
  /** Session events, newest-first. Present-and-empty = the plane has no events
   *  in the window (honest), absent = not fetched. */
  timeline?: ClientTimelineEvent[];
  /** Usage samples over the detail window, oldest-first. */
  usageSeries?: UsageSample[];
  /** The AP radio this client is on. Absent = not matched (see the
   *  'servingRadio' section state for why). Its metrics belong to the RADIO;
   *  a renderer must say so in one short label, e.g. "radio 1 · 2.4 GHz". */
  servingRadio?: ServingRadio;
  /** AP -> switch port for this client. Absent = the topology has no link for
   *  the AP; keep the existing empty state rather than inventing a path. */
  wiring?: ClientWiring;
  /** Where these numbers came from and what happened to each section. */
  source: DetailSource<ClientDetailSection>;
}

/**
 * One AP radio (Central /aps/{serial}/radios).
 *
 * NOTE ON TYPES — verified live on AP735-LR (PHT5M520SZ): Central returns most
 * of these as STRINGS ("9", "25", "-98"). The adapter normalizes to numbers
 * here so renderers never parse; a value the plane omitted or could not be
 * parsed is `null`, never 0.
 */
export interface DeviceRadio {
  /** radioNumber — 0/1/2 on a tri-radio AP. */
  number: number;
  /** '2.4 GHz' | '5 GHz' | '6 GHz', as the plane words it. */
  band: string;
  /** Channel AS THE PLANE WORDS IT — '11', '157E', '213S'. The trailing
   *  letter is a bonding marker, so this is a string, not a number. */
  channel: string;
  /** '20 MHz' | '80 MHz' | '160 MHz', as the plane words it. */
  bandwidth: string;
  /** Transmit power, dBm. */
  powerDbm: number | null;
  /** Clients associated to this radio. */
  clients: number | null;
  /** Channel utilization, percent 0-100. */
  channelUtilPct: number | null;
  /** Receive airtime utilization, percent 0-100. */
  rxUtilPct: number | null;
  /** Transmit airtime utilization, percent 0-100. */
  txUtilPct: number | null;
  /** Frame retries, percent 0-100. */
  retries: number | null;
  /** Dropped frames, percent 0-100. */
  drops: number | null;
  /** Noise floor, dBm (negative). */
  noiseFloorDbm: number | null;
  /** Non-Wi-Fi interference, percent 0-100. */
  nonWifiInterference: number | null;
  /** Central's own channel-quality score, 0-100. */
  channelQuality: number | null;
  /** 'UP' | 'DOWN' | 'DISABLED', as the plane words it. */
  status: string;
  /** Radio mode ('Client Access', 'Monitor'…), as the plane words it. */
  mode: string;
  /** Radio BSSID/MAC, when the plane reports one. */
  macAddress?: string;
}

/** One WLAN broadcast by a device (Central /aps/{serial}/wlans). */
export interface DeviceWlan {
  /** wlanName — the SSID as broadcast. */
  name: string;
  /** 'UP' | 'DOWN', as the plane words it. */
  status: string;
  /** Security suite, as the plane words it ('wpa3-sae'). */
  security: string;
  /** Central's coarse security grade ('Enterprise', 'Personal', 'Open'). */
  securityLevel: string;
  /** Band(s) the WLAN is broadcast on, as the plane words it. */
  band: string;
  /** VLAN id as a STRING — planes report bare ids ('200') and named VLANs
   *  ('guest') through the same field. */
  vlan: string;
  /** Clients currently on this WLAN on this device. */
  clients: number | null;
}

/**
 * One switch/gateway port (Central /switches/{serial}/interfaces).
 *
 * The neighbour* fields are what makes the Clients drawer's "Wiring" row real:
 * they name the far end of the cable, which no flat list carries.
 */
export interface DevicePort {
  /** Interface name as the plane words it ('1/1/20', 'GE 0/0/1'). */
  name: string;
  /** The plane's rolled-up port status. */
  status: string;
  /** Administrative state ('up' | 'down'). */
  adminStatus: string;
  /** Operational state ('up' | 'down'). */
  operStatus: string;
  /** Negotiated speed in BITS PER SECOND (Central reports 1000000000 for a
   *  1 Gb port). null = the plane reported no speed. */
  speedBps?: number | null;
  /** 'full' | 'half' | '', as the plane words it. */
  duplex: string;
  /** Physical connector type ('RJ45', 'SFP+'). */
  connector?: string;
  mtu?: number | null;
  /** 'access' | 'trunk' | 'native-untagged'…, as the plane words it. */
  vlanMode: string;
  nativeVlan?: number | null;
  /** Tagged VLANs allowed on the port. Present-and-empty = the plane said
   *  none; absent = the plane did not report the list. */
  allowedVlanIds?: number[];
  poeStatus?: string;
  poeClass?: string;
  /** Spanning-tree role/state as the plane words them ('root', 'forwarding'). */
  stpRole?: string;
  stpState?: string;
  /** Far end of the cable, as discovered by the plane (LLDP/CDP). */
  neighbour?: string;
  neighbourPort?: string;
  neighbourSerial?: string;
  neighbourType?: string;
  neighbourHealth?: string;
  /** LAG name when the port is bundled; '' or absent when it is not. */
  lag?: string;
  /** True when the plane marks this port as an uplink. */
  uplink?: boolean;
}

/** Which family of per-object subresources a device detail read should ask
 *  for. An AP has radios+wlans, a switch has ports, a gateway has ports. */
export type DeviceDetailKind = 'ap' | 'switch' | 'gateway';

/**
 * Per-device detail, fetched on demand for ONE device.
 *
 * Absent array = that section was not fetched (an AP is not asked for ports).
 * Present-and-empty = the plane answered with nothing. Check `source.sections`
 * before rendering any "nothing here" sentence.
 */
export interface DeviceDetailLive {
  /** The serial the read was issued for. */
  serial: string;
  kind: DeviceDetailKind;
  radios?: DeviceRadio[];
  wlans?: DeviceWlan[];
  ports?: DevicePort[];
  source: DetailSource<DeviceDetailSection>;
}

/**
 * One device in a plane's LINK topology (Central /topology/{site-id}).
 *
 * This is the plane's raw graph, not the rendered diagram — see SiteTopology /
 * TopologyNode above (line ~790) for the view model buildSiteTopology()
 * produces. The two must not be confused: this one is keyed by SERIAL and
 * carries no layout.
 */
export interface TopologyDeviceNode {
  /** Plane serial — the graph key. Unmanaged nodes get a synthetic id
   *  ('tpd_204c03ff61e2'), which is still the key links reference. */
  serial: string;
  /** Device name, or the MAC when the plane has no name for it. */
  name: string;
  /** 'Switch' | 'Access Point' | 'Gateway' | 'Unmanaged', as the plane words it. */
  type: string;
  /** 'Access Switch' | 'Campus Access Point' | 'Mobility GW' | '-', as worded. */
  deviceFunction: string;
  /** 'ONLINE' | 'OFFLINE', as the plane words it. */
  status: string;
  /** 'Good' | 'Poor' | null — null is a REAL answer for an unmanaged node the
   *  plane does not assess, not a missing read. */
  health: string | null;
  /** Why the health is what it is ('DEVICE_STATUS'); null when unstated. */
  healthReason: string | null;
  model: string | null;
  ipv4: string | null;
  mac: string | null;
  /** 'Standalone' | 'Cluster', as the plane words it. */
  deployment?: string | null;
  /** Conductor/stack-master serial when the node is a member. */
  conductorSerial?: string | null;
  /** Whether the plane sees an internet path from this node. */
  internet?: boolean | null;
  /** Epoch ms as the plane reports it; 0 and null both mean "no stamp", and
   *  neither may be rendered as 1970. */
  lastSeen?: number | null;
}

/** One end of a topology link — a port on the device at that end. */
export interface TopologyLinkPort {
  /** Port name as the plane words it ('1/1/20', 'GE 0/0/1', 'eth0'). */
  name: string;
  index?: number | null;
  /** LAG name; '' when the port is not bundled. */
  lag?: string | null;
  health?: string | null;
  healthReason?: string | null;
}

/** One link between two topology nodes, keyed by the SERIALS in `nodes`. */
export interface TopologyLink {
  /** Serial of the near end (matches TopologyDeviceNode.serial). */
  from: string;
  /** Serial of the far end. */
  to: string;
  /** Ports at the near end (a LAG has several). */
  fromPorts: TopologyLinkPort[];
  /** Ports at the far end. */
  toPorts: TopologyLinkPort[];
  /** Link speed in BITS PER SECOND (Central reports 5000000000 for 5 Gb). */
  speedBps: number | null;
  /** 'Good' | 'Unknown' | null, as the plane words it. 'Unknown' is the
   *  plane's own verdict about an unmanaged far end — not a failed read. */
  health: string | null;
  healthReason?: string | null;
  stpState?: string | null;
  /** 'System' | 'Manual', as the plane words it. */
  edgeType?: string | null;
  /** Set when both ends are members of the same stack/cluster. */
  isSibling?: boolean | null;
}

/**
 * A plane's link topology for ONE site, fetched on demand.
 *
 * Named *Live to keep it distinct from `SiteTopology` (the rendered diagram
 * view model built by buildSiteTopology). Absent `nodes`/`links` = not
 * fetched; present-and-empty = the plane knows the site and reports no graph.
 */
export interface SiteTopologyLive {
  /** The plane's site id the read was issued for. */
  siteId: string;
  nodes?: TopologyDeviceNode[];
  links?: TopologyLink[];
  /** Devices the plane could not place on the graph. */
  isolatedDevicesCount?: number | null;
  isolatedHealth?: string | null;
  source: DetailSource<SiteTopologySection>;
}

// ---------------------------------------------------------------------------
// Reviewed active diagnostics (New Central network-troubleshooting v1)
// ---------------------------------------------------------------------------

export type DiagnosticOperation = 'traceroute';
export type DiagnosticDeviceClass = 'ap' | 'cx';
export type DiagnosticJobState =
  | 'starting'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'timed_out'
  /** Operator-facing portal polling stopped; the upstream Central task was not cancelled. */
  | 'cancelled';

export interface DiagnosticEligibleDevice {
  name: string;
  serial: string | null;
  plane: Plane;
  type: DeviceType;
  model: string;
  deviceClass: DiagnosticDeviceClass | null;
  eligible: boolean;
  reason: string;
}

export interface DiagnosticEligibilityResponse {
  devices: DiagnosticEligibleDevice[];
  operation: DiagnosticOperation;
  source: 'live-inventory';
}

export interface DiagnosticTracerouteOptions {
  /** AP-only, documented by TracerouteApRequest. */
  sourceInterface?: string;
  /** CX-only, documented by TracerouteCxRequest. */
  useIpv6?: boolean;
  useManagementInterface?: boolean;
  vrfName?: string;
}

export interface DiagnosticReviewRequest {
  /** Exact live-inventory identity. Display names are not identifiers. */
  plane: Plane;
  serial: string;
  operation: DiagnosticOperation;
  target: string;
  options?: DiagnosticTracerouteOptions;
}

export interface DiagnosticReview {
  reviewId: string;
  expiresAt: string;
  device: string;
  serial: string;
  plane: Plane;
  deviceClass: DiagnosticDeviceClass;
  operation: DiagnosticOperation;
  target: string;
  options: DiagnosticTracerouteOptions;
  startPath: string;
  pollPathTemplate: string;
  warning: string;
}

export interface DiagnosticStartRequest {
  reviewId: string;
  confirmed: true;
  plane: Plane;
  serial: string;
}

export interface DiagnosticProbe {
  ipAddress: string | null;
  reverseDnsResolution: string | null;
  responseTimeMilliseconds: string | null;
}

export interface DiagnosticHop {
  hop: string;
  probes: DiagnosticProbe[];
}

export interface DiagnosticResult {
  device: string;
  serial: string;
  plane: Plane;
  destination: string | null;
  resolvedIp: string | null;
  hops: DiagnosticHop[];
}

export interface DiagnosticJob {
  id: string;
  device: string;
  serial: string;
  plane: Plane;
  deviceClass: DiagnosticDeviceClass;
  operation: DiagnosticOperation;
  state: DiagnosticJobState;
  taskId: string | null;
  progressPercent: number;
  startedAt: string;
  finishedAt: string | null;
  message: string;
  result: DiagnosticResult | null;
}

export interface DiagnosticAuditEntry {
  id: string;
  at: string;
  device: string;
  serial: string;
  plane: Plane;
  operation: DiagnosticOperation;
  state:
    | DiagnosticJobState
    | 'reviewed'
    /** Initiation transport failed after dispatch, so Central acceptance is unknown. */
    | 'initiation_unknown'
    /** Central accepted initiation but supplied no usable task identifier for tracking. */
    | 'accepted_untrackable'
    /** An ambiguous/cancelled reservation was released at its original deadline. */
    | 'reservation_expired';
  target: '[redacted]';
  httpCode?: number;
}
