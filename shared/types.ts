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
  | 'EDGECONNECT'
  | 'OPSRAMP'
  | 'THIRD-PARTY';

export type Sev = 'P1' | 'P2' | 'P3';

/** Shell views (HpeNetworkTools state.view). */
export type View =
  | 'overview'
  | 'topology'
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
  | 'systems'
  | 'uxi'
  | 'clearpass'
  | 'mist'
  | 'central';

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
  /** The firmware train the plane RECOMMENDS for this model, when it publishes
   *  one (Mist /orgs/{org}/devices/versions). Absent = no recommendation was
   *  read, which says nothing about compliance. */
  firmwareTarget?: string;
  /** The plane's own firmware-upgrade state word, verbatim (Mist's
   *  `fwupdate.status` / `auto_upgrade_stat.status` on the stats row — e.g.
   *  'inprogress'). Never interpreted into prose; absent = none reported. */
  firmwareUpdate?: string;
  /** The plane's claim/activation code for the device (Mist inventory
   *  `magic`). It is a claim secret, so it rides only where an operator with
   *  device-read access already sees the device — never into logs. Absent
   *  unless the plane publishes one. */
  claimCode?: string;
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
  /** Floor-plan position in map-image PIXELS, when the plane locates the
   *  client on a map (Mist's wireless roster carries x/y/x_m/y_m/map_id).
   *  Optional — absent means the plane published no position, which must
   *  render as "not located", never as (0,0). Set only as a pair: a dot
   *  needs both coordinates. */
  x?: number;
  y?: number;
  /** The floor plan x/y refer to (Mist map id — matches MistSiteMap.mapId).
   *  Absent whenever x/y are absent. */
  mapId?: string;
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
  /**
   * Wall-clock for display. Authored fixtures carry it already written
   * ('09:41:22'); a live row carries `at` as well and the screen renders that
   * instead, so the column reads in the timezone of whoever is looking.
   */
  time: string;
  /**
   * ISO instant the event happened, when the plane gave one. Absent on the
   * authored rows and on a live row whose timestamp would not parse — which
   * is why `time` stays and is not replaced by it.
   */
  at?: string;
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
  /**
   * Every device the finding covers, when it covers more than the one `device`
   * names. A finding is a whole plane's worth of devices failing one check, so
   * `device` is merely the first of them and `count` is the only field that
   * ever described the real scope.
   */
  devices?: string[];
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
  /** A fact about the row worth surfacing that has no column of its own —
   *  e.g. 'PSK set — redacted by the portal' on a Mist WLAN whose payload
   *  carried the cleartext key (the portal never transports Wi-Fi secrets, so
   *  the marker is the only honest way to say a PSK exists). */
  note?: string;
  /** The WLAN's admin state, when the plane's config read reported it (Mist
   *  WLANs carry `enabled`). Absent = not reported — the edit drawer must not
   *  invent one. */
  enabled?: boolean;
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

// ---------------------------------------------------------------------------
// Central plane screen (/api/central) — the plane's own operational dashboard
// ---------------------------------------------------------------------------

/**
 * A dataset the Central screen renders a section for. `wlans` names the
 * plane's config read (ConfigInventory.ssids) — 'config' would collide with
 * the Configure screen's own vocabulary on the wire.
 */
export type CentralDataset = 'devices' | 'sites' | 'clients' | 'alerts' | 'wlans';

/**
 * The plane header's status block: link state, the registry health word and
 * freshness, straight off the registry (live) or the authored SYSTEMS row
 * (demo). `health` is the registry's own lower-case word ('healthy' |
 * 'warning' | 'degraded' | 'unlinked') so the header never paraphrases the
 * plane's condition; `lastSync` null = the plane has never completed a pull,
 * which the header words as 'never', never as a guessed time.
 */
export interface CentralPlaneStatus {
  linked: boolean;
  health: string;
  tone: Tone;
  lastSync: string | null;
  /** The registry's own note (a throttle reason, a partial-read warning);
   *  null when there is none — the header shows nothing rather than inventing
   *  one. */
  note: string | null;
}

/**
 * Fleet rollup behind the header tiles: devices by type and by state, counted
 * off the plane's own inventory rows. `byState` keeps the feed's verbatim
 * state words ('up', 'down', whatever Central next invents) — never folded
 * into an umbrella good/bad pair, the same rule `?state=` deep links follow.
 */
export interface CentralFleetSummary {
  total: number;
  byType: Partial<Record<DeviceType, number>>;
  byState: Record<string, number>;
}

/**
 * One site in the plane's estate summary. Counts come off the plane's own
 * rows (never the cross-plane merge — this screen is what CENTRAL sees).
 * `clients` null = the plane reported no client roster this cycle;
 * `healthPct` is the share of known-state devices that are up, null when
 * nothing at the site has a verifiable state — never a fabricated 0.
 */
export interface CentralSiteRow {
  siteId: SiteId;
  siteName: string;
  devices: number;
  clients: number | null;
  healthPct: number | null;
  /** null = the alert feed was not reported this cycle, so no open count can
   *  be asserted — the row words it rather than claiming a clear site. */
  openAlerts: number | null;
}

/**
 * A device behind its recommended firmware train: the plane's approved-train
 * check failed (`firmwareApproved: false`). `target` is the train the plane
 * RECOMMENDS when it publishes one — null when the verdict rests on the
 * approved-train flag alone; `update` is the plane's own upgrade state word,
 * verbatim, null when none was reported.
 */
export interface CentralFirmwareRow {
  name: string;
  model: string;
  type: DeviceType;
  siteId: SiteId;
  siteName: string;
  serial?: string;
  firmware: string;
  target: string | null;
  update: string | null;
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
  /** WLAN admin state — Mist direct writes only (Mist WLANs carry `enabled`).
   *  Absent means "leave the plane's current/default state alone": the Central
   *  payload does not model it (its profile upsert always writes enable:true),
   *  so the Central drawer never offers the switch and never sets this. */
  enabled?: boolean;
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
  /**
   * Set by the service layer, not the adapter. The Configure inventory is
   * served from the poll cache, so without a forced re-read the SSID list the
   * operator sees after a successful apply is the one from before it — which
   * reads as a silent failure and invites a retry.
   *
   * Absent means no refresh was tried at all (demo mode, or an older server);
   * that is NOT the same as a refresh that was tried and did not land, and the
   * screen must not conflate them.
   */
  cacheRefresh?: WriteCacheRefresh;
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

/**
 * The cursor named a page that is no longer there.
 *
 * A cursor is only ever handed out when the list had strictly more rows to
 * give, so a request that lands at or past the end is not a client that paged
 * too far — it is a list that SHRANK between the two reads. The inventory is
 * a live cache: a plane going stale or unlinking takes its rows out from
 * under a half-paged answer.
 *
 * That case has to be distinguishable from a genuine end-of-list, because the
 * two look identical on the wire (no rows, no next cursor) and mean opposite
 * things. Reading it as the end tells the operator they have seen everything,
 * on a list that has since changed under them.
 */
export type PageCursorState = 'ok' | 'past-end';

export interface InventoryTreePage {
  parentId: string | null;
  nodes: InventoryTreeNode[];
  total: number;
  nextCursor: string | null;
  query: string;
  /** Absent means the route did not say — treat it as unknown, not as 'ok'. */
  cursorState?: PageCursorState;
}

export interface InventorySearchPage {
  nodes: InventoryTreeNode[];
  total: number;
  nextCursor: string | null;
  query: string;
  /** Absent means the route did not say — treat it as unknown, not as 'ok'. */
  cursorState?: PageCursorState;
  /** Linked planes that contributed no searchable rows, by display name. The
   *  search walked what the poller holds, so a plane whose read has not come
   *  back was never searched at all — and "no matches" over an unsearched
   *  plane is a false negative, not an answer. Absent means the route did not
   *  say; an empty array means every linked plane was searchable. */
  unsearchedPlanes?: string[];
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
   *  ("the estate is on fire"). Optional: absent keeps the renderer's existing
   *  default ('danger'), so the authored banners are unchanged. Derived
   *  banners always set it — server and browser both go through
   *  shared/logic.ts correlateAlerts. */
  tone?: Tone;
}

// -- Tickets (NtTickets) --

/**
 * The longest note text the ticket log accepts. Shared because the browser
 * must warn against exactly the number the server enforces — a client cap
 * that disagrees with the server's either blocks text that would have been
 * accepted, or promises one that will be refused after the operator has
 * finished typing it.
 */
export const MAX_NOTE_CHARS = 2_000;

export interface TicketNote {
  ts: string; // ISO timestamp
  /** action = an operator-requested next action, logged for the record.
   *  retention = not an operator entry at all: a marker standing in for older
   *  entries the store dropped to stay bounded. Anything rendering the log has
   *  to tell it apart, or a deletion reads as something an operator did. */
  kind: 'note' | 'action' | 'retention';
  text: string;
  /** Only on kind 'retention': how many entries this marker stands in for,
   *  carried forward across rotations. `text` is for the operator; this is for
   *  the next rotation, which must not reset the running total to zero. */
  discarded?: number;
  /** Only on kind 'retention': ISO bounds of the entries that went. */
  coveringFrom?: string;
  coveringTo?: string;
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
  /** Every per-product row retained when this is a grouped unified client. */
  sources?: ClientObservation[];
}

/** One product's observation of a client represented in a unified row. */
export interface ClientObservation {
  row: Omit<ClientRow, 'sources'>;
  /** Registry plane id, retained separately from the display label on `row`. */
  plane: PlaneKey;
  observedAt: string | null;
  stale: boolean;
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

// -- ClearPass endpoint repository --

export interface EndpointRow {
  id: string;
  mac: string;
  description: string | null; // the operator's free-text note on the endpoint
  ip: string | null;
  hostname: string | null;
  status: 'Known' | 'Unknown' | 'Disabled' | string;
  category: string | null; // e.g. 'Computer', 'Phone', 'Printer'
  family: string | null; // e.g. 'Windows', 'iOS'
  os: string | null;
  profile: string | null; // enforcement profile / role
  updatedAt: string | null; // ISO or display string
  /** Device Insight's free-text categorisation tags (`device_insight_tags`)
   *  — the profiler's evidence, NOT the enforcement `profile` it often
   *  echoes. Absent when the row carries no tags. */
  insightTags?: string[];
}

// -- ClearPass policy-plane inventories --
//
// The smaller collections the adapter walks alongside the endpoint
// repository (NADs, auth sources, roles, enforcement policy/profiles, local
// users, services, device groups). Every field beyond identity is nullable
// and read defensively — a fact the box did not report is null, never an
// assumed value.

/** One network access device (NAD) from GET /api/network-device. */
export interface ClearPassNetworkDeviceRow {
  id: string;
  name: string;
  ipAddress: string | null;
  vendorName: string | null;
  coaCapable: boolean | null;
  radsecEnabled: boolean | null;
  description: string | null;
}

/** One authentication source from GET /api/auth-source. */
export interface ClearPassAuthSourceRow {
  id: string;
  name: string;
  type: string | null; // e.g. 'Active Directory', 'Local'
  description: string | null;
}

/** One role from GET /api/role. */
export interface ClearPassRoleRow {
  id: string;
  name: string;
  description: string | null;
}

/** One enforcement policy from GET /api/enforcement-policy. */
export interface ClearPassEnforcementPolicyRow {
  id: string;
  name: string;
  enforcementType: string | null; // e.g. 'RADIUS', 'WEBAUTH', 'TACACS'
  defaultProfile: string | null; // the catch-all profile the policy falls back to
}

/** One enforcement profile from GET /api/enforcement-profile. */
export interface ClearPassEnforcementProfileRow {
  id: string;
  name: string;
  type: string | null; // e.g. 'RADIUS', 'RADIUS_CoA', 'TACACS'
  description: string | null;
}

/**
 * One local user from GET /api/local-user. STRICTLY whitelisted fields —
 * the mapper reads this list by name and nothing else crosses, so no
 * password hash or secret of any kind can ride a row the poller cache and
 * the screens will serve.
 */
export interface ClearPassLocalUserRow {
  id: string;
  userId: string; // the login name
  username: string | null; // the display name
  roleName: string | null;
  enabled: boolean | null;
}

/**
 * One service from GET /api/config/service (the 6.11+ config namespace —
 * verified against CPPM 6.11.12) with /api/service as the older-6.x fallback;
 * a build that 404s BOTH does not expose the collection at all. The first
 * four fields are the shape every build answers; the rest ride along only
 * when the row reports them, so an older build's row stays exactly
 * { id, name, type, description }. Whitelisted by name like the local-user
 * row — nothing in a service definition is credential material, and the
 * mapper keeps it that way.
 */
export interface ClearPassServiceRow {
  id: string;
  name: string;
  type: string | null; // e.g. '1X', 'MAC_AUTH', 'TACACS'
  description: string | null;
  template?: string | null; // e.g. 'TACACS+ Enforcement'
  enabled?: boolean | null;
  hitCount?: number | null;
  orderNo?: number | null;
  authSources?: string[]; // source names, only when the row names them
  /** One readable line built from rules_conditions — never raw JSON. */
  rulesSummary?: string | null;
}

/**
 * One condition of a service's match rules — a row of CPPM's rule editor
 * (rules_conditions: { type, name, operator, value }), read-only here. A
 * field the box did not report is null, and a list-valued `value` is joined
 * readably — the drawer never renders raw JSON.
 */
export interface ClearPassServiceRuleCondition {
  type: string | null;
  name: string | null;
  operator: string | null;
  value: string | null;
}

/**
 * One full service from GET /api/config/service/{id} (verified against a live
 * CPPM 6.11.12) — the object the Services-tab drawer renders, fetched ON
 * DEMAND for the one service being viewed, never on the poll. This is the
 * detail the collection row (ClearPassServiceRow) summarises, and its
 * vocabulary is the DETAIL object's own: `type` here is 'RADIUS' | 'TACACS' |
 * 'Application' | 'WEBAUTH' where the collection row says '1X'/'MAC_AUTH'.
 * Every boolean is tri-state: null means the box did not report the flag,
 * which is not the same as false. Whitelisted by name like the collection
 * row — nothing in a service definition is credential material, and the
 * mapper keeps it that way.
 */
export interface ClearPassServiceDetail {
  id: string;
  name: string;
  type: string | null;
  template: string | null;
  enabled: boolean | null;
  hitCount: number | null;
  orderNo: number | null;
  description: string | null;
  monitorMode: boolean | null;
  rulesMatchType: string | null; // 'MATCHES_ALL' | 'MATCHES_ANY'
  rulesConditions: ClearPassServiceRuleCondition[];
  authMethods: string[]; // method names, only the ones the box names readably
  authSources: string[]; // source names, same rule
  stripUsername: boolean | null;
  roleMappingPolicy: string | null;
  /** CPPM's `enf_policy` — the enforcement policy this service evaluates. */
  enforcementPolicy: string | null;
  useCachedPolicyResults: boolean | null;
  postureEnabled: boolean | null;
  auditEnabled: boolean | null;
  profilerEnabled: boolean | null;
  acctProxyEnabled: boolean | null;
}

/** Sections of a service detail read — ONE GET, so ONE section: 'ok' the
 *  object mapped, 'empty' the box 404'd every candidate path (no such
 *  service, or the resource is not exposed), 'failed' the read broke. */
export type ClearPassServiceDetailSection = 'service';

/**
 * The service detail payload — the mapped object plus its provenance
 * envelope, the same contract as every on-demand detail read. `service` null
 * means the read produced no object; `source.sections.service` says which of
 * 'empty' (no such service) or 'failed' (the read broke) it was.
 */
export interface ClearPassServiceDetailLive {
  service: ClearPassServiceDetail | null;
  source: DetailSource<ClearPassServiceDetailSection>;
}

/** One device group from GET /api/device-group (not exposed on every build). */
export interface ClearPassDeviceGroupRow {
  id: string;
  name: string;
  description: string | null;
}

// -- ClearPass direct writes (endpoint repository + local users) --
//
// The CPPM write surface for the two datasets this portal operates on: POST
// /api/endpoint registers a MAC, PATCH /api/endpoint/{id} updates its status
// and operator note, POST /api/local-user creates an account and
// PUT /api/local-user/{id} updates one. Policy itself is never written here
// — it is edited in ClearPass. Every write rides the reviewed direct-write
// flow (server/src/services/clearpassDirectWrite.ts): an explicit review
// confirmation standing in for a ticket, one audit line per attempt, and a
// read-back verify whose outcome is reported, never assumed. Local-user
// passwords are WRITE-ONLY: they travel in the request body to CPPM and
// nowhere else — never logged, never audited, never echoed in a result.

/** The endpoint status vocabulary a write may set (CPPM's own three values). */
export type ClearPassEndpointStatus = 'Known' | 'Unknown' | 'Disabled';
export const CLEARPASS_ENDPOINT_STATUSES: ClearPassEndpointStatus[] = ['Known', 'Unknown', 'Disabled'];

/** Register one endpoint (POST /api/endpoint). */
export interface ClearPassEndpointRegisterForm {
  /** Any separator/case — the service normalises to aa:bb:cc:dd:ee:ff and
   *  refuses anything that is not 12 hex digits. */
  mac: string;
  description?: string;
  /** Absent registers the endpoint as 'Known'. */
  status?: ClearPassEndpointStatus;
  /** Profiler-style attribute hints (e.g. {Category: 'Computer'}) — a flat
   *  string map, exactly what CPPM's endpoint object nests. */
  attributes?: Record<string, string>;
}

/** Update one endpoint (PATCH /api/endpoint/{id}) — status and/or the
 *  operator note only; the MAC is the row's identity and is never rewritten.
 *  At least one field must be present. */
export interface ClearPassEndpointUpdateForm {
  status?: ClearPassEndpointStatus;
  /** Present-and-empty clears the note; absent leaves it alone. */
  description?: string;
}

/** Create one local user (POST /api/local-user). */
export interface ClearPassLocalUserCreateForm {
  userId: string; // the login name
  username?: string; // the display name
  /** Must exist in the CPPM role inventory — checked against the reported
   *  roles when the portal has them, otherwise left for CPPM to answer. */
  roleName: string;
  enabled: boolean;
  /** WRITE-ONLY — never logged, audited, echoed, or read back. */
  password: string;
}

/** Update one local user (PUT /api/local-user/{id}) — every field optional,
 *  at least one required. */
export interface ClearPassLocalUserUpdateForm {
  username?: string;
  roleName?: string;
  enabled?: boolean;
  /** WRITE-ONLY — present only when the operator is setting a new password;
   *  absent leaves the current one alone. */
  password?: string;
}

/**
 * What one ClearPass direct write did, reported honestly. `ok` is true ONLY
 * on a 2xx from the write call itself. `verified` is the read-back: true when
 * a re-read found the written state, false when that read succeeded and the
 * state was absent (accepted but not landed), and undefined when the
 * confirming read could not be made at all — undefined is deliberately NOT
 * false, exactly as the SSID apply reports it. `message` is always a fixed,
 * secret-free string (an HTTP code at most — never a vendor body, and a
 * local-user write's password appears nowhere in this shape).
 */
export interface ClearPassWriteResult {
  ok: boolean;
  /** 'failed' when the plane refused or errored — never rolled into ok. */
  action: 'created' | 'updated' | 'failed';
  verified?: boolean;
  httpCode?: number;
  message: string;
  /**
   * Set by the service layer, not the adapter — the screen's list is served
   * from the poll cache, so without a forced re-read it would show the
   * pre-write snapshot (see SsidApplyResult.cacheRefresh). Absent means no
   * refresh was tried (demo mode), which is NOT a failed refresh.
   */
  cacheRefresh?: WriteCacheRefresh;
}

// -- Sites (NtSites) --

export interface SiteRow extends Site {
  id: SiteId;
  tone: SiteHealthTone;
  alertTone: Tone;
}

/**
 * AP/user impact counts from one Mist SLE summary window
 * (`sle_summary_impact`: num_* are the DEGRADED counts, total_* the
 * population considered). Every field nullable — a count Mist did not
 * report is null, never an assumed 0.
 */
export interface MistSleImpact {
  numUsers: number | null;
  numAps: number | null;
  totalUsers: number | null;
  totalAps: number | null;
}

/**
 * One classifier of a Mist SLE metric (`sle_classifier`) — the WHY behind a
 * degraded metric ('dhcp', 'signal-strength', …). `samples`/`degraded` are
 * the summed per-interval counts and `durationSec` the summed observation
 * durations, all straight off the wire; a series the summary did not carry
 * sums to null, not 0.
 */
export interface MistSleClassifier {
  name: string;
  samples: number | null;
  degraded: number | null;
  durationSec: number | null;
  impact: MistSleImpact | null;
}

/**
 * One Mist SLE metric as read from the site-scoped summary endpoint
 * (GET /api/v1/sites/{siteId}/sle/site/{siteId}/metric/{metric}/summary).
 * `success` is the 0.0–1.0 fraction DERIVED from the sample counts
 * (1 − Σdegraded/Σtotal): counts are unambiguous, where the `value` series'
 * unit is not stated on the wire. null when the window held no countable
 * samples — SLE has no "no signal" reading.
 */
export interface MistSleMetric {
  name: string; // as Mist words it: 'time-to-connect', 'ap-health', …
  success: number | null;
  samples: number | null;
  degraded: number | null;
  impact: MistSleImpact | null;
  classifiers: MistSleClassifier[];
}

/**
 * Mist Service Level Expectations — the platform's headline per-site score,
 * one classifier per operational dimension (coverage/capacity/roaming/AP
 * health/WAN). Each dimension's score is the success fraction derived from
 * that metric's summary sample counts (see MistSleMetric); a metric the
 * site does not score (the summary 404s — no WAN edge, insufficient data)
 * is `null`, not an assumed 0. `overall` is the mean of whichever
 * dimensions ARE present, so a WAN-less site is not penalised for a
 * dimension Mist never scores it on. `metrics` carries the richer per-metric
 * detail (classifiers, impact) for the drill-down; absent when only the
 * headline fractions were read. */
export interface MistSleRow {
  siteId: SiteId;
  siteName: string; // raw Mist site name
  coverage: number | null;
  capacity: number | null;
  roaming: number | null;
  apHealth: number | null;
  wan: number | null;
  overall: number | null;
  metrics?: MistSleMetric[];
}

/**
 * One site's licence consumption as Mist reports it
 * (GET /api/v1/orgs/{orgId}/licenses/usages row). `usages` and
 * `fullyLoaded` are Mist's own service→count maps verbatim ({'SUB-MAN': 12})
 * — current consumption, and the demand if every device used every service —
 * null when the row did not carry the map. Counts Mist did not report stay
 * null rather than reading as an authoritative 0.
 */
export interface MistLicenseUsageRow {
  siteId: SiteId;
  siteName: string;
  numDevices: number | null;
  numAps: number | null;
  usages: Record<string, number> | null;
  fullyLoaded: Record<string, number> | null;
}

// -- Mist AP rich stats (GET /sites/{siteId}/stats/devices?type=ap) --

/**
 * One radio's live stats from a Mist site AP-stats row (`radio_stat.band_*`).
 * Mist keys radios `band_24`/`band_5`/`band_6`; `band` is normalized here to
 * the display words ('2.4 GHz'…) so a renderer never re-derives them. Every
 * reading nullable — a stat the row did not carry is null, never an assumed
 * 0 (0% utilization and "not reported" are different facts).
 */
export interface MistApRadioStats {
  /** '2.4 GHz' | '5 GHz' | '6 GHz' | the raw key suffix when unrecognized. */
  band: string;
  channel: number | null;
  /** Channel width in MHz (20/40/80/160). */
  bandwidthMHz: number | null;
  powerDbm: number | null;
  noiseFloorDbm: number | null;
  /** `util_all` — total channel utilization, percent 0-100. */
  utilAllPct: number | null;
  utilTxPct: number | null;
  utilRxInBssPct: number | null;
  utilRxOtherBssPct: number | null;
  /** `util_non_wifi` — non-Wi-Fi interference share, percent 0-100. */
  utilNonWifiPct: number | null;
  /** Clients associated to THIS radio (`num_clients`). */
  numClients: number | null;
}

/**
 * One wired port's live stats (`port_stat.eth0`). Mist reports `speed` in
 * Mbps (1000 for a 1 Gb port); byte/error counters are cumulative since boot.
 */
export interface MistApPortStats {
  /** Port name as Mist keys it ('eth0'). */
  name: string;
  up: boolean | null;
  speedMbps: number | null;
  fullDuplex: boolean | null;
  rxBytes: number | null;
  txBytes: number | null;
  rxErrors: number | null;
  txErrors: number | null;
  peakBps: number | null;
}

/**
 * Onboard environment sensors (`env_stat`). Not every AP model carries these
 * — the whole block is null when the row has no `env_stat`, and each reading
 * is null when the sensor reported nothing.
 */
export interface MistApEnvStats {
  ambientTempC: number | null;
  /** Barometric pressure; mbar and hPa are the same unit 1:1. */
  pressureHpa: number | null;
  humidityPct: number | null;
  accelX: number | null;
  accelY: number | null;
  accelZ: number | null;
}

/**
 * The AP's uplink neighbour as LLDP reports it (`lldp_stat`) — the real
 * AP → switch edge (e.g. AP → "CX6300-CORE" port 1/1/5) that topology edges
 * are built from. null when the row carried no `lldp_stat`.
 */
export interface MistApLldpUplink {
  systemName: string | null;
  /** Platform description verbatim ('HPE JL660A …'). */
  systemDesc: string | null;
  portId: string | null;
  chassisId: string | null;
  mgmtAddr: string | null;
}

/**
 * One AP's rich live stats from the SITE-scoped stats walk
 * (GET /api/v1/sites/{siteId}/stats/devices?type=ap) — the radios, ports,
 * environment, LLDP uplink and load readings the org-wide row does not
 * carry. `numClients` is the per-device client count that only this surface
 * publishes (see the Mist adapter header). Readings the row did not carry
 * stay null; absent arrays (`radios`/`ports`) mean the row had no
 * `radio_stat`/`port_stat` at all.
 */
export interface MistApStatsRow {
  deviceName: string;
  /** Mist's device UUID — the key the site-scoped detail reads want
   *  (00000000-0000-0000-1000-<mac>), NOT the mac. null when unreported. */
  deviceUuid: string | null;
  mac: string | null;
  serial: string | null;
  siteId: SiteId;
  siteName: string;
  /** Wireless clients on this AP, as the row reports it. */
  numClients: number | null;
  cpuUtilPct: number | null;
  memTotalKb: number | null;
  memUsedKb: number | null;
  uptimeSec: number | null;
  rxBps: number | null;
  txBps: number | null;
  /** External (WAN-side) IP, when the row reports one. */
  extIp: string | null;
  /** `ip_stat` — the AP's own view of its network services. */
  dns: string | null;
  gateway: string | null;
  dhcpServer: string | null;
  /** `power_src` verbatim ('PoE 802.3at', …). */
  powerSrc: string | null;
  powerConstrained: boolean | null;
  radios: MistApRadioStats[];
  ports: MistApPortStats[];
  env: MistApEnvStats | null;
  lldpUplink: MistApLldpUplink | null;
}

// -- Mist floor plans (GET /sites/{siteId}/maps + device config x/y) --

/** One AP's placement on a floor plan, from the site device-config rows
 *  (GET /sites/{siteId}/devices?type=ap carries x/y/map_id per AP). x/y are
 *  PIXELS in the map image. */
export interface MistSiteMapAp {
  deviceName: string;
  deviceUuid: string | null;
  mac: string | null;
  x: number | null;
  y: number | null;
}

/**
 * One floor plan at one Mist site. `imageUrl` is Mist's hosted image URL
 * verbatim (the demo world authors an inline SVG data-URI instead — same
 * field, renderable the same way); width/height come in both pixels (image)
 * and meters (Mist's calibration) exactly as the map row reports them, null
 * when unreported. `aps` holds the APs the site config places on THIS map;
 * client dots ride on the ClientRow's own x/y/mapId.
 */
export interface MistSiteMap {
  siteId: SiteId;
  siteName: string;
  /** Mist's map id — the key ClientRow.mapId and the AP config's map_id use. */
  mapId: string;
  name: string | null;
  imageUrl: string | null;
  widthPx: number | null;
  heightPx: number | null;
  widthM: number | null;
  heightM: number | null;
  /** Map rotation, degrees, as the row reports it. */
  orientationDeg: number | null;
  aps: MistSiteMapAp[];
}

// -- Mist rogue & neighbor APs (GET /sites/{siteId}/insights/rogues) --

/**
 * One BSSID from a site's rogue/neighbor report
 * (GET /api/v1/sites/{siteId}/insights/rogues row). `bssid` is the identity —
 * a row without one is junk and maps to null. `seenOnLan` (`seen_on_lan`) is
 * the on-your-wire flag: true means the AP is connected to YOUR wired
 * infrastructure, which is the actual alarm — everything else is a neighbor.
 * null means the row did not say, which reads as "not reported", never as a
 * safe false. Readings the row did not carry (ssid, channel, avg_rssi,
 * num_aps) stay null rather than an assumed value.
 */
export interface MistRogueApRow {
  siteId: SiteId;
  siteName: string;
  /** The BSSID the report keys on, verbatim as Mist carries it. */
  bssid: string;
  ssid: string | null;
  channel: number | null;
  /** Average signal strength the site's APs heard it at, dBm. */
  avgRssi: number | null;
  /** How many of the site's APs reported hearing it. */
  numAps: number | null;
  /** The on-your-wire flag — true is the alarm. null = not reported. */
  seenOnLan: boolean | null;
}

// -- Mist org audit log (GET /orgs/{orgId}/logs/search, on-demand) --

/**
 * One org admin change from Mist's audit log
 * (GET /api/v1/orgs/{orgId}/logs/search `results` row) — who changed what,
 * when. `before`/`after` are the entry's config snapshots as compact JSON
 * with every secret-shaped value (psk/secret/passphrase/password/private key/
 * token/api key) replaced by a redaction marker BEFORE it leaves the server —
 * the snapshots can carry a cleartext WLAN PSK, so they get the same
 * whitelist discipline the site-WLAN read does. Readings the row did not
 * carry stay null; a row with neither an id nor a message maps to null.
 */
export interface MistAuditLogRow {
  /** The entry's own id, when Mist carries one. */
  id: string | null;
  /** ISO instant — Mist stamps epoch milliseconds. null when unreported. */
  at: string | null;
  /** The admin who made the change (email or name as reported). */
  admin: string | null;
  /** What changed, in Mist's own words. */
  message: string;
  /** Portal site key when the entry is site-scoped; null = org-wide. */
  siteId: SiteId | null;
  siteName: string | null;
  before?: string;
  after?: string;
}

/** Sections of the org audit-log read. */
export type MistAuditLogSection = 'logs';

/**
 * The latest org admin changes behind the Systems screen's Mist drawer — read
 * ON DEMAND when the drawer opens, never on the 60s poll (the drawer is the
 * only consumer, and a quota'd plane should not pay for it every cycle).
 * Absent `entries` = the read was not fetched; check `source.sections`
 * before any "nothing changed" line.
 */
export interface MistAuditLogLive {
  entries?: MistAuditLogRow[];
  source: DetailSource<MistAuditLogSection>;
}

// -- Mist screen (/api/mist) — the plane's operational dashboard payload -----

/**
 * The Mist plane's own status, carried on the Mist screen's payload so the
 * header can say what the plane is doing without a second fetch: the
 * registry's facts in live mode (linked/health/lastSync verbatim — a plane
 * that never synced keeps lastSync null, never a borrowed stamp), the demo
 * world's authored row in demo mode (MIST_PLANE_STATUS, stamped on the demo
 * fixed clock like the audit-log fixtures). `deviceCount`/`clientCount` are
 * the plane's own claimed counts where the mode has them, null where it does
 * not — never a recounted subset presented as the plane's claim.
 */
export interface MistPlaneStatus {
  linked: boolean;
  /** The registry health word; 'unlinked' when no credentials are stored. */
  health: 'healthy' | 'warning' | 'degraded' | 'unlinked';
  /** ISO instant of the last successful pull; null = never synced. */
  lastSync: string | null;
  /** Devices the plane claims; null = not reported. */
  deviceCount: number | null;
  /** Clients the plane reports; null = not reported. */
  clientCount: number | null;
  /** The plane's own pull note, verbatim (e.g. a half-read caveat). */
  note: string | null;
}

// -- Mist SLE drill-down (lazy per-metric reads, on the detail path only) --

/**
 * One interval series of an SLE summary-trend read
 * (GET …/sle/site/{id}/metric/{metric}/summary-trend). `total`/`degraded`
 * are parallel to the intervals starting at `startSec`, stepping
 * `intervalSec`; a null entry is an interval Mist reported no count for.
 */
export interface MistSleTrend {
  startSec: number | null;
  endSec: number | null;
  intervalSec: number | null;
  total: Array<number | null>;
  degraded: Array<number | null>;
}

/** One client an SLE metric names as impacted (…/impacted-users). `degraded`
 *  is the row's own degraded-sample count when it carries one. */
export interface MistSleImpactedClient {
  mac: string;
  /** hostname/username as the row words it; null when it names only the MAC. */
  name: string | null;
  degraded: number | null;
}

/** One AP an SLE metric names as impacted (…/impacted-aps). */
export interface MistSleImpactedAp {
  mac: string;
  name: string | null;
  degraded: number | null;
}

/** Sections of an SLE drill-down read. */
export type MistSleDrillSection = 'classifiers' | 'impactedClients' | 'impactedAps' | 'trend';

/**
 * The drill-down behind ONE SLE metric at ONE site — classifiers (the WHY),
 * impacted clients/APs (the WHO/WHERE) and the summary trend (the WHEN).
 * Read ON DEMAND when an operator opens the metric, never on the poll: the
 * headline MistSleRow.metrics already carries the summary classifiers, and
 * fetching four more endpoints per metric per site per cycle would hammer a
 * quota'd plane for data nobody is looking at. Absent array = that section
 * was not fetched; check `source.sections` before any "nothing here" line.
 */
export interface MistSleMetricDetail {
  siteId: SiteId;
  siteName: string;
  /** The metric as Mist words it ('time-to-connect', 'coverage', …). */
  metric: string;
  classifiers?: MistSleClassifier[];
  impactedClients?: MistSleImpactedClient[];
  impactedAps?: MistSleImpactedAp[];
  trend?: MistSleTrend;
  source: DetailSource<MistSleDrillSection>;
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

/**
 * A firing an active silence benched off a site page's "Open here" — moved,
 * never hidden, exactly like the bench on the Alerts screen: it renders under
 * the section's own SILENCED (N) group with the reason and expiry that hushed
 * it, so a site reading 'clear' never lists the firing as if it still needed
 * someone. `until` rides as the silence's ISO stamp; the renderer formats it
 * in the reader's own clock.
 */
export interface SilencedSiteAlertRow extends SiteAlertRow {
  reason: string;
  until: string;
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
  /** What the plane reported and the diagram could not draw, one phrase per
   *  reason. A drawn graph is read as "this is the site", so anything the
   *  plane said it could not place — or that the builder had to leave out —
   *  has to travel with the picture instead of being dropped at the point it
   *  becomes inconvenient. Empty means the diagram is the whole of what the
   *  plane reported; absent means the builder did not say, which is the case
   *  for the recorded profile wiring, where there is nothing to omit. */
  omissions?: string[];
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
  /** Structured counters for the authored CX switch rows — the same contract
   *  as the live read (DevicePort.counters), so the demo estate shows what a
   *  real AOS-CX counters read looks like without a switch. Absent = the
   *  authored row has no counters to say (a PSU row is not an interface). */
  counters?: DevicePortCounters;
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

/** Where a DeviceCfg block came from, when it came from the config-backup
 *  store. Absent on the authored fixtures — the presence of this block is how
 *  the screen tells a real collected snapshot from demo furniture, so the
 *  caption can name the collection channel instead of implying one. */
export interface DeviceCfgProvenance {
  /** The snapshot version the Running tab shows. */
  version: number;
  /** Versions on file for this device (pruning gaps included in the count's
   *  basis — the history rows carry the real numbers). */
  versions: number;
  /** Collection channel, e.g. 'demo synthesis' | 'ssh show running-config'. */
  source: string;
  /** ISO instant the shown snapshot was collected; the browser formats it in
   *  the reader's own clock, never the server's. */
  takenAt: string;
}

/** Running / drift / history config block per device kind (NT_CFG). */
export interface DeviceCfg {
  meta: string;
  running: string;
  diff: string;
  history: CfgHistoryRow[];
  provenance?: DeviceCfgProvenance;
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
/**
 * Whether the cached workspace inventory was re-read after a write.
 *
 * The GreenLake screen re-renders its lists straight after a change, but those
 * lists are served from the poller's cache, not a live call. If the cache was
 * not refreshed, the list the operator is looking at PREDATES the change they
 * were just told succeeded — which reads exactly like a silent failure and
 * invites a retry that would create a second user, location or device.
 *
 * So the refresh is reported rather than assumed.
 */
export interface WriteCacheRefresh {
  /** False when no refresh was tried. That is the correct state for an
   *  `accepted` (202) write: nothing has been applied yet, so re-reading
   *  would only assert more confidently that nothing changed. */
  attempted: boolean;
  /** True only when a fresh pull completed. When false, the inventory the
   *  screen shows next is the pre-change snapshot and must say so. */
  ok: boolean;
  /** Operator-facing reason, present only when a refresh was attempted and
   *  did not land. Never a vendor body. */
  message?: string;
}

/** The original name, kept because the shape is identical and GreenLake was
 *  simply the first write path to need it. Nothing about it is workspace
 *  specific — the Central SSID apply reports staleness the same way. */
export type GreenLakeCacheRefresh = WriteCacheRefresh;

export interface GreenLakeWriteResult {
  action: GreenLakeWriteAction;
  outcome: 'applied' | 'accepted';
  /** Operator-safe summary — never a token or a raw response body. */
  detail: string;
  /** Present only for async (202) actions; the workspace's handle for it. */
  transactionId?: string | null;
  /** Identifier of the object created, when the API returned one. */
  id?: string | null;
  /** Set by the service layer, not the adapter. Absent means an older server
   *  that did not refresh at all — which is NOT the same as a refresh that
   *  was tried and failed, and the screen must not conflate them. */
  cacheRefresh?: GreenLakeCacheRefresh;
}

// -- UXI sensors (NtUxi) --

/**
 * One UXI sensor for the dedicated fleet screen — identity + live status +
 * ongoing issues in a single row. This is deliberately richer than the
 * DeviceRow/AlertRow projections UxiAdapter also produces for the merged
 * Devices/Alerts screens: those two exist so UXI participates in the
 * cross-plane views, this exists so the UXI screen does not have to
 * reconstruct a sensor's own picture by re-joining them.
 */
export interface UxiSensorRow {
  id: string;
  name: string;
  serial: string | null;
  model: string | null;
  /** groupName from UXI — the site the sensor is assigned to. */
  site: string | null;
  /** `boolean | null` — the vendor status read is tri-state; null = the
   *  sensor did not answer, never assumed down. */
  isOnline: boolean | null;
  isTesting: boolean | null;
  issueCount: number;
  issues: Array<{
    code: string;
    severity: string; // 'critical' | 'warning' | 'info'
    status: string; // 'active' | 'resolved'
    context: string | null; // networkName or serviceTestName from context
  }>;
  wifiMac: string | null;
  ethernetMac: string | null;
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
  /** 'direct' is a reviewed direct write with no ticket/queue (Mist SSIDs,
   *  SSE object CRUD) — distinct from 'brokered' (ticketed) and from
   *  'read only', and still a write path for the purposes of the screen's
   *  "which planes accept a change" filter. */
  mode: 'brokered' | 'ssh' | 'direct' | 'read only';
  tone: Tone;
  /**
   * Whether the plane holds credentials at all. Configure collapses the
   * planes that hold none behind one line, and it must not decide that by
   * pattern-matching `note` — the prose is written for a human and is free to
   * change wording without silently un-collapsing the list.
   */
  linked: boolean;
  /** The registry plane key ('mist', 'central', …) when the row describes one
   *  plane — the stable identity a screen matches on, since `plane` is a
   *  display label the operator can rename. */
  planeId?: string;
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
  | 'sse'
  | 'edgeconnect'
  | 'opsramp';

/** Type-dependent endpoint field for the connect form. */
export interface EndpointVariant {
  label: string;
  help: string;
  hint: string;
  /** Pre-defined options shown as a dropdown; user can still type a custom value. */
  options?: SelectOption[];
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
  'uxi',
] as const;
export type ScreenSection = (typeof SCREEN_SECTIONS)[number];

/** Per-section source: absent = follow the portal-wide demoMode. */
export type SectionMode = Partial<Record<ScreenSection, 'demo' | 'live'>>;

// ---------------------------------------------------------------------------
// Data sources and plane freshness (README §"Design rules" 1)
// ---------------------------------------------------------------------------

/** Which source served a payload — every /api screen envelope carries it. */
export type DataSource = 'demo' | 'live';

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
  'endpoints',
  'subscriptions',
  'config',
  'assignments',
  'sse',
  'greenlake',
  'mistSle',
  'mistLicenseUsages',
  'mistApStats',
  'mistMaps',
  'mistRogues',
  'uxiSensors',
  'networkDevices',
  'authSources',
  'roles',
  'enforcementPolicies',
  'enforcementProfiles',
  'localUsers',
  'services',
  'deviceGroups',
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
  'endpoints',
  'subscriptions',
] as const;
export type PlaneRowDatasetKey = (typeof PLANE_ROW_DATASET_KEYS)[number];

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
  /**
   * The change is settled (see `outcome`) but its durable journal could not be
   * deleted afterwards. This never changes what happened to the object — the
   * record is already in a terminal phase no recovery will replay Commit for.
   * It does mean the leftover journal blocks the NEXT SSE change until it is
   * cleaned up, which the operator has to be told, and separately from the
   * outcome so a settled change is never reported as a failed one.
   */
  journalRetained?: boolean;
}

/** Commit-only retry's result — never replays the original mutation, so
 *  there is no `mutation` outcome to report, only the commit attempt and
 *  whether the cache now reflects it. */
export interface SseCommitRetryResult {
  commit: SseCommitOutcome;
  cacheRefresh: SseCacheRefreshOutcome;
  /** As SseMutationResult.journalRetained: the retry settled, and the journal
   *  it was recovering could not be removed afterwards. */
  journalRetained?: boolean;
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
  /** Switch port the AP is patched into, as the plane words it ('1/1/8').
   *  The FIRST of `ports` — never the only one when `ports` has more. */
  port: string;
  /** Every port at the switch end, when the plane reported more than one.
   *  Absent for a single cable. A bundled AP is not patched into one port and
   *  telling an operator to shut '1/1/8' on a four-member LAG names a quarter
   *  of the link — the traffic simply stays up on the rest. */
  ports?: string[];
  /** LAG name at the switch end when the plane named one; absent when it did
   *  not, which is NOT the same as the ports not being bundled. */
  lag?: string | null;
  /** Further links the plane's site graph draws from this AP to a switch,
   *  beyond the one described here. Absent/0 = this is the whole story.
   *  A dual-homed AP whose second uplink is unmentioned turns "shut the port
   *  and watch it drop" into a test that proves nothing. */
  otherUplinks?: number;
  /** Link speed in BITS PER SECOND (Central reports 1000000000 for a 1 Gb
   *  link). null/absent = the plane reported no speed. */
  speedBps?: number | null;
  /** 'Good' | 'Unknown' | null, as the plane words it — the plane's verdict on
   *  the link, not ours. */
  linkHealth?: string | null;
  /** Why the plane reached that verdict, in its own words, when it said. A
   *  verdict without its reason sends the operator to look for a fault the
   *  plane had already named. */
  linkHealthReason?: string | null;
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
  /** True when `roams` is a FLOOR rather than a total: the plane stated no
   *  window total, so all the portal could count was the single page it
   *  fetched, and that page came back full. A renderer must not present the
   *  number as firm — a client that roamed 340 times reads as exactly the
   *  page size, which is indistinguishable from a real count of that size.
   *  Absent = an older server that never made the distinction. */
  roamsAtLeast?: boolean;
  /** The lookback `roams`/`timeline` cover, seconds. */
  roamsWindowSec?: number;
  /** Session events, newest-first. Present-and-empty = the plane has no events
   *  in the window (honest), absent = not fetched. */
  timeline?: ClientTimelineEvent[];
  /** True when `timeline` holds only the NEWEST page of the window, not all of
   *  it. Set independently of `roamsAtLeast`: a stated total makes the count
   *  exact and still leaves the rest of the events unfetched. A renderer
   *  captioning the list with its own length is stating a fact about the
   *  window that it does not have. */
  timelineTruncated?: boolean;
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

// ---------------------------------------------------------------------------
// Client 360 — ONE client correlated across every registry plane by MAC
// ---------------------------------------------------------------------------

/**
 * What happened to one plane's section of a Client 360 block.
 *
 * A subset of DetailFetchState: 'failed' cannot occur, because the block is a
 * PURE CORRELATION of rows the poller already pulled — no per-plane call is
 * issued for it, so there is no call to fail. The three remaining states keep
 * their usual meanings:
 *   ok          — this plane holds something about this MAC (a session, an
 *                 endpoint record, auth decisions, a site SLE).
 *   empty       — the plane's feed was read and genuinely has nothing for
 *                 this MAC.
 *   not-fetched — the plane cannot be asked (not linked, no working sync
 *                 adapter, structurally no per-client view) or has not
 *                 reported the dataset the section reads.
 */
export type ClientPlaneSectionState = 'ok' | 'empty' | 'not-fetched';

/** The row datasets a Client 360 section reads. */
export type Client360Dataset = 'clients' | 'authEvents' | 'endpoints';

/**
 * One registry plane's view of ONE client — a section of the Client 360 block
 * the Clients drawer renders as its cross-plane panel.
 *
 * Every registry plane gets a section, present-with-data or
 * absent-with-an-honest-reason, so "which planes see this client?" is answered
 * by reading one list instead of by knowing which feeds to check. The data
 * fields are per-plane on purpose — a correlation shows what THIS plane says,
 * in its own rows, never a merged guess:
 *
 *   session     — the plane's own session row for this MAC (pre-dedupe: the
 *                 roster merges cross-plane duplicates; this block must not,
 *                 or the very sightings it exists to show would be erased).
 *   endpoint    — the ClearPass endpoint-repository profile for this MAC.
 *   authEvents  — recent ClearPass decisions for this MAC, newest first,
 *                 capped at CLIENT_360_AUTH_EVENT_LIMIT (shared/logic.ts). The
 *                 full log is the Auth events screen's job; this is the
 *                 summary.
 *   siteSle     — site-level SLE when the plane scores the client's site
 *                 (Mist). SITE-LEVEL, never a per-client score — a renderer
 *                 must label it as the site's.
 */
export interface ClientPlaneSection {
  /** Registry plane key this section answers for. */
  plane: PlaneKey;
  /** Display label ('CENTRAL'). */
  label: Plane;
  state: ClientPlaneSectionState;
  /** One honest sentence: why the plane has nothing (absent sections), or a
   *  qualifier about what is present (e.g. "the endpoint repository was not
   *  read this cycle"). */
  reason?: string;
  session?: ClientRow;
  endpoint?: EndpointRow;
  authEvents?: AuthEventRow[];
  siteSle?: MistSleRow;
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
 * One interface's cumulative counters since boot (or the last clear), as the
 * plane counts them — AOS-CX reports them as the interface's `statistics`
 * attribute (documented in the AOS-CX NAE guide's monitor URIs,
 * `…/system/interfaces/{name}?attributes=statistics.rx_packets`).
 *
 * The BLOCK is optional and each FIELD nullable on purpose, because they are
 * different facts: no block = the plane did not report a statistics map for
 * this port at all (Central's interface list carries none, so the key stays
 * absent there); a null field = the map came back without that counter, which
 * must render as "not reported", never as a zero.
 */
export interface DevicePortCounters {
  rxBytes: number | null;
  txBytes: number | null;
  rxPackets: number | null;
  txPackets: number | null;
  rxErrors: number | null;
  txErrors: number | null;
  rxDropped: number | null;
  txDropped: number | null;
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
  /** Cumulative rx/tx counters, only when the plane reports an interface
   *  statistics map — the AOS-CX local collector reads it; Central's
   *  interface list has none, so the key stays absent on its rows. */
  counters?: DevicePortCounters;
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

/** One stretch of Diagnostics history removed by the log retention policy.
 *  The bounds are null when the deleted generation's own lines could not be
 *  parsed for a range — the gap is still real, only its width is unknown. */
export interface DiagnosticHistoryGap {
  from: string | null;
  to: string | null;
}

/**
 * A read of the Diagnostics audit history, with the holes it knows about.
 *
 * `entries` alone cannot express why it is short. A generation deleted by
 * retention and a generation that would not open both produce a list missing
 * a stretch of runs, and neither is distinguishable from a device that was
 * simply never diagnosed. Both are carried out so the panel can say which.
 */
export interface DiagnosticHistoryRead {
  entries: DiagnosticAuditEntry[];
  discarded: DiagnosticHistoryGap[];
  /** Basenames of rotated generations present on disk that could not be read. */
  unreadable: string[];
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
