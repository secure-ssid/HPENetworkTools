/**
 * server/src/planes/types.ts — plane adapter contract.
 *
 * Every independently configurable control plane has a real product adapter.
 * AOS-10 is the exception by design: it is discovered through Central and has
 * no separate connector. Invalid enabled configurations surface as degraded
 * configuration errors; disabled or absent connectors are unconfigured.
 *
 * PlanePull datasets use the normalized shared row types so a real adapter's
 * output can flow straight into the poller cache and the screen endpoints.
 * SSE is the one exception: it has no devices/clients/alerts at all, so its
 * whole contribution rides on the single `sse` field (an SseInventory), the
 * same "structured object, not a row array" pattern `config` already uses.
 */

import type {
  AlertRow,
  ApTrendMetric,
  ApTrendsLive,
  AuthEventRow,
  ClearPassAuthSourceRow,
  ClearPassDeviceGroupRow,
  ClearPassEnforcementPolicyRow,
  ClearPassEnforcementProfileRow,
  ClearPassLocalUserRow,
  ClearPassNetworkDeviceRow,
  ClearPassRoleRow,
  ClearPassServiceDetailLive,
  ClearPassServiceRow,
  ClientDetailLive,
  ClientRow,
  ConfigInventory,
  DeviceDetailKind,
  DeviceDetailLive,
  DeviceRow,
  EndpointRow,
  GreenLakeInventory,
  MistLicenseUsageRow,
  MistSleRow,
  MistApStatsRow,
  MistRogueApRow,
  MistSiteMap,
  MistSleMetricDetail,
  PlaneDatasetKey,
  PlaneScope,
  SiteApplicationsLive,
  SiteRow,
  SiteTopologyLive,
  SseInventory,
  SubscriptionAssignment,
  SubscriptionRow,
  SwitchHardwareTrendsLive,
  SwitchInterfaceTrendsLive,
  TrendWindow,
  UxiSensorRow,
} from '@hpe/shared';
import { CONNECTOR_IDS, type ConnectorId } from '@hpe/shared';

export const PLANE_IDS = [
  'central',
  'classic',
  'mist',
  'greenlake',
  'aos8',
  'aos10',
  'local',
  'clearpass',
  'uxi',
  'sse',
  'opsramp',
  'edgeconnect',
] as const;

export type PlaneId = (typeof PLANE_IDS)[number];

/** Independently configurable planes. AOS-10 is intentionally Central-derived. */
export const CONFIGURABLE_PLANE_IDS = CONNECTOR_IDS;

export function isConnectorPlaneId(id: PlaneId): id is ConnectorId {
  return (CONFIGURABLE_PLANE_IDS as readonly string[]).includes(id);
}

export type PlaneHealth = 'healthy' | 'degraded' | 'warning' | 'unlinked';

/**
 * What the portal can actually DO with a plane, as the adapter reports it.
 * Every field is optional and absent means "not claimed" — a caller treats an
 * unset capability as false rather than assuming it.
 *
 * `localShell` is the one the recorded-SSH terminal gates on: a cloud plane
 * describes hardware it cannot give a shell to, but the local collector and
 * the AOS-8 master can. Note this is a PLANE-level statement; whether one
 * device can be dialled is still the terminal manager's call (a management IP
 * has to resolve), so a consumer needs both.
 */
export interface PlaneCapabilities {
  /** Devices claimed by this plane can be reached by the portal's recorded
   *  SSH bridge (a collector or jump-host path exists for them). */
  localShell?: boolean;
  /** The write broker can push configuration to this plane. */
  brokeredWrite?: boolean;
  /** pull() can populate PlanePull.config (real SSID/VLAN/port reads) rather
   *  than the Configure screen observing them from client sessions. */
  configRead?: boolean;
  /** This plane accepts REVIEWED direct writes outside the ticketed broker
   *  queue — New Central's WLAN-profile upsert + scope-map assignment
   *  (server/src/services/ssidDirectWrite.ts), Mist's site-scoped WLAN
   *  create/update, ClearPass endpoint/local-user writes
   *  (server/src/services/clearpassDirectWrite.ts), and HPE Aruba Networking
   *  SSE's object CRUD + automatic commit (server/src/planes/sse.ts).
   *  false/absent on Classic Central and every other plane: Classic is not
   *  writable via this path, and an SSE token whose granted scope excludes
   *  write reports false here too — see SseAdapter.capabilities(). */
  directWrite?: boolean;
  /** New Central's network-troubleshooting API can run reviewed operational
   *  diagnostics. This is an action/write, but not a configuration mutation.
   *  Classic Central and every non-Central plane leave it false/absent. */
  activeDiagnostics?: boolean;
  /** This plane's pull() can populate PlanePull.alerts. When false/absent the
   *  plane is excluded from the missing-alert-source banner. */
  alertFeed?: boolean;
}

/**
 * Credential freshness for the fact strip's fourth fact (README:306
 * "Last sync / Devices / Calls today / Token").
 *
 * SECURITY: PlaneState is served unmasked by /api/systems/state. This carries
 * an expiry and a source label ONLY — never a token, a fragment of one, or
 * anything that could be replayed.
 */
export interface PlaneTokenInfo {
  /** ISO expiry of the credential currently in use; null = the plane does not
   *  publish one (e.g. a static API key). */
  expiresAt: string | null;
  /** How the credential is obtained — 'oauth client_credentials', 'sso',
   *  'static token', 'client cert'. */
  source: string;
}

/** One notable plane event for the drawer's "Recent events" list (brokered
 *  writes, token rotations, credential re-keys, cluster changes). Must never
 *  carry credential material: /api/systems/state serves it unmasked. */
export interface PlaneEventEntry {
  time: string; // ISO
  what: string;
  who: string;
}

export interface PlaneState {
  id: PlaneId;
  linked: boolean;
  health: PlaneHealth;
  lastSync: string | null; // ISO timestamp of the last successful pull
  deviceCount: number | null;
  callsToday: number;
  note: string | null;
  /** Daily outbound-call budget for the "Calls today" denominator (Mist is
   *  20k/day, Classic 1k …). null = the vendor tier is unknown, so the fact
   *  renders bare rather than inventing a limit. Absent = not yet resolved. */
  callBudget?: number | null;
  /** Credential freshness — expiry + source only, never the secret. */
  token?: PlaneTokenInfo | null;
  /** What the operator actually granted (parsed from the stored `scopes`
   *  credential), so the Systems row stops hardcoding 'read only'. */
  scope?: PlaneScope;
  scopeNote?: string;
  /** What the portal can do with this plane — see PlaneCapabilities. */
  capabilities?: PlaneCapabilities;
  /** Consecutive failed polls, and the earliest time a scheduled poll should
   *  be attempted again. A 429-throttled plane must back off instead of
   *  re-polling the quota it is already exceeding; a forced sync ignores it. */
  consecutiveFailures?: number;
  nextAttemptAt?: string | null;
}

/**
 * Partial datasets a plane can contribute; empty for stubs.
 *
 * `devices`…`assignments` are DATA. `partial` is METADATA about the pull and
 * must never be treated as a dataset — merge loops iterate
 * PLANE_ROW_DATASET_KEYS (shared/types.ts), not `keyof PlanePull`.
 */
export interface PlanePull {
  devices?: DeviceRow[];
  sites?: SiteRow[];
  clients?: ClientRow[];
  alerts?: AlertRow[];
  authEvents?: AuthEventRow[];
  /** ClearPass endpoint repository rows (README:465's "endpoints" dataset) —
   *  a best-effort detail read on top of the required auth feed; capped at
   *  MAX_ENDPOINTS and never required for a healthy pull. */
  endpoints?: EndpointRow[];
  subscriptions?: SubscriptionRow[];
  /** Configuration inventory read from the plane's config API — what the live
   *  Configure screen needs so it stops inferring SSIDs/VLANs from sessions. */
  config?: ConfigInventory;
  /** Device→subscription assignments (GreenLake) — the feed the Licences
   *  screen needs to count unlicensed devices and derive orphan/gap rows. */
  assignments?: SubscriptionAssignment[];
  /** HPE Aruba Networking SSE's object inventory (connector zones, connectors,
   *  locations, tunnels, applications, users, groups, categories) — a
   *  structured object, not a row array, same pattern as `config`. */
  sse?: SseInventory;
  /** GreenLake's platform inventory beyond licences (workspace users,
   *  locations, role assignments) — a structured object, not a row array,
   *  same pattern as `config` and `sse`. Subscriptions and assignments keep
   *  their own dedicated fields: those feed the Licences screen, this does
   *  not. */
  greenlake?: GreenLakeInventory;
  /** Mist per-site Service Level Expectations (site SLE summaries) — a
   *  structured dataset, not a row array, same pattern as `config`/`sse`. */
  mistSle?: MistSleRow[];
  /** Mist per-site licence consumption (/orgs/{org}/licenses/usages) —
   *  Mist-only (no other plane populates it), same pattern as `mistSle`. */
  mistLicenseUsages?: MistLicenseUsageRow[];
  /** Mist per-AP rich live stats (site stats/devices?type=ap): radios, ports,
   *  env, LLDP uplink, cpu/mem and the per-device client count. Mist-only,
   *  same pattern as `mistSle`. */
  mistApStats?: MistApStatsRow[];
  /** Mist floor plans per site (maps + AP config positions) — Mist-only,
   *  same pattern as `mistSle`. Present-and-empty is a REAL answer: the
   *  sites were read and publish no maps. */
  mistMaps?: MistSiteMap[];
  /** Mist per-site rogue/neighbor BSSID report (insights/rogues) — Mist-only,
   *  same pattern as `mistSle`. The on-your-wire flag is the alarm. */
  mistRogues?: MistRogueApRow[];
  /** UXI's richer per-sensor view (identity + live status + issues) for the
   *  dedicated UXI screen — built from the SAME sensors list + status reads
   *  pull() already fetches for `devices`/`alerts`, no extra API calls. A
   *  row array, but not merged through PLANE_ROW_DATASET_KEYS: it is UXI-only
   *  (no other plane populates it), same pattern as `mistSle`. */
  uxiSensors?: UxiSensorRow[];
  /** ClearPass NAD inventory (/api/network-device) — ClearPass-only (no
   *  other plane populates it), same pattern as `mistSle`. A best-effort
   *  read on the endpoint repository's 5-minute cadence: a failure omits
   *  the key and names it in `partial`, never sinks the pull. */
  networkDevices?: ClearPassNetworkDeviceRow[];
  /** ClearPass authentication sources (/api/auth-source) — ClearPass-only,
   *  same best-effort pattern as `networkDevices`. */
  authSources?: ClearPassAuthSourceRow[];
  /** ClearPass roles (/api/role) — ClearPass-only, same pattern. */
  roles?: ClearPassRoleRow[];
  /** ClearPass enforcement policies (/api/enforcement-policy) —
   *  ClearPass-only, same pattern. */
  enforcementPolicies?: ClearPassEnforcementPolicyRow[];
  /** ClearPass enforcement profiles (/api/enforcement-profile) —
   *  ClearPass-only, same pattern. */
  enforcementProfiles?: ClearPassEnforcementProfileRow[];
  /** ClearPass local users (/api/local-user) — ClearPass-only, same pattern,
   *  with STRICTLY whitelisted fields (never a password hash). */
  localUsers?: ClearPassLocalUserRow[];
  /** ClearPass services (/api/config/service on 6.11+, /api/service on older
   *  6.x — the first candidate that answers) — ClearPass-only, same pattern,
   *  plus the 404-honest rule: a box that 404s BOTH paths does not expose
   *  the resource, so only then is the key omitted WITHOUT a partial flag. */
  services?: ClearPassServiceRow[];
  /** ClearPass device groups (/api/device-group) — ClearPass-only, same
   *  404-honest rule as `services`. */
  deviceGroups?: ClearPassDeviceGroupRow[];
  /** Datasets this pull could NOT read (404, truncated page, no permission).
   *  The registry holds health at 'warning' for a pull that names any, so a
   *  half-read plane is never stamped as a complete sync; the poller must not
   *  attribute freshness to a dataset listed here. */
  partial?: PlaneDatasetKey[];
}

export interface PlaneAdapter {
  id: PlaneId;
  state(): PlaneState;
  pull(): Promise<PlanePull>;
  /** What this adapter can do beyond reading. Optional: an adapter that does
   *  not implement it claims nothing, and callers default every capability to
   *  false. */
  capabilities?(): PlaneCapabilities;

  // -- ON-DEMAND DETAIL READS ------------------------------------------------
  //
  // These are NOT poller work. pull() reads a few flat lists on the 60s timer;
  // a plane models one client across ~8 endpoints and one device across many
  // /{id}/subresource endpoints, and fetching those per object per poll would
  // be 9 devices x N subresources x 1440 polls/day against a tenant that
  // enforces a daily call budget. A fix that works but hammers the plane is a
  // regression.
  //
  // THEREFORE, for every method below:
  //   * call it on the DETAIL REQUEST PATH only — for the ONE object whose
  //     drawer is opening — behind a short TTL cache;
  //   * never call it from poller.ts, and never fan it out over a list;
  //   * it must be cheap to not call: the screens work without it.
  //
  // RETURNING null means "this plane cannot answer" (not implemented, not
  // linked, wrong plane for this object). It must render as the honest empty
  // state the screen already has — never as fabricated or borrowed data. A
  // read that was ATTEMPTED and failed should return a payload whose
  // `source.sections` marks the failed sections 'failed', so the screen can
  // say the call broke instead of implying the plane has nothing.
  //
  // Implementations must not throw: swallow transport errors, mark the section
  // 'failed', and return. All three are optional so no existing adapter has to
  // change; callers must feature-detect (`adapter.clientDetail?.(…)`).

  /**
   * Per-client detail for ONE MAC. `medium` lets an adapter avoid wireless
   * mobility/radio reads for an Ethernet client while still fetching shared
   * facts such as usage.
   */
  clientDetail?(mac: string, medium?: ClientRow['medium']): Promise<ClientDetailLive | null>;

  /**
   * Per-device detail for ONE serial. `kind` tells the adapter which
   * subresources are worth asking for (an AP has radios+wlans, a switch has
   * ports) so it does not spend calls on 404s.
   */
  deviceDetail?(serial: string, kind: DeviceDetailKind): Promise<DeviceDetailLive | null>;

  /**
   * The plane's link topology for ONE site — the device graph and the
   * port-to-port links behind it. `siteId` is the PLANE's site id, not the
   * portal's SiteId.
   */
  siteTopology?(siteId: string): Promise<SiteTopologyLive | null>;

  /**
   * Mist-only: the drill-down behind ONE SLE metric at ONE site —
   * classifiers, impacted clients/APs, summary trend. Same on-demand rules
   * as the detail reads above: the headline MistSleRow is polled, this is
   * fetched only when an operator opens the metric, behind a TTL cache.
   * `siteId` is the portal's site key (the adapter owns the native-uuid
   * join, same as siteTopology). null = this plane cannot answer.
   */
  mistSleMetricDetail?(siteId: string, metric: string): Promise<MistSleMetricDetail | null>;

  /**
   * Central-only: the DPI application table for ONE site over ONE window
   * (GET /network-monitoring/v1/applications — requires site_id + start/end
   * ISO, the window capped at 7 days, paged). Same on-demand rules as the
   * detail reads above: fetched when an operator opens the site's
   * applications view, behind a TTL cache, never from the poller. `siteId`
   * is the PLANE's site id, not the portal's SiteId. null = this plane
   * cannot answer.
   */
  siteApplications?(siteId: string, window: TrendWindow): Promise<SiteApplicationsLive | null>;

  /**
   * Central-only: a switch's hardware gauges (cpu/memory/temperature/PoE/
   * power) for ONE serial over ONE window — ONE call to
   * /network-monitoring/v1/switches/{serial}/hardware-trends. On-demand, TTL
   * cached, never polled. null = this plane cannot answer.
   */
  switchHardwareTrends?(serial: string, window: TrendWindow): Promise<SwitchHardwareTrendsLive | null>;

  /**
   * Central-only: ONE AP metric trend (cpu | memory | throughput) for ONE
   * serial — /network-monitoring/v1/aps/{serial}/{metric}-trends. On-demand,
   * TTL cached, never polled. null = this plane cannot answer (including a
   * metric outside the vocabulary).
   */
  apTrends?(serial: string, metric: ApTrendMetric, window: TrendWindow): Promise<ApTrendsLive | null>;

  /**
   * Central-only: a switch's interface byte/error counter trends for ONE
   * serial — /network-monitoring/v1/switches/{serial}/interface-trends.
   * On-demand, TTL cached, never polled. null = this plane cannot answer.
   */
  switchInterfaceTrends?(serial: string, window: TrendWindow): Promise<SwitchInterfaceTrendsLive | null>;

  /**
   * ClearPass-only: ONE service's full definition for the Services-tab
   * drawer — GET {service path}/{id} (the 6.11 config namespace first, the
   * legacy path as fallback, same candidates as the collection walk). Same
   * on-demand rules as the detail reads above: fetched when an operator
   * opens the service, behind a TTL cache, never from the poller. A 404 on
   * every candidate is an 'empty' section (no such service), never a thrown
   * error. null = this plane cannot answer.
   */
  serviceDetail?(id: string): Promise<ClearPassServiceDetailLive | null>;

  /**
   * Release anything held on the far side before this adapter is dropped —
   * an AOS-8 session UID, a websocket, a keep-alive timer. The registry calls
   * it on the OUTGOING adapter when credentials are re-saved or a plane is
   * retired; without it a credential save leaks the live session on the
   * controller until it ages out.
   *
   * Optional so no other adapter has to change, and it must never throw or
   * hang: implementations swallow their own errors and the caller does not
   * block a re-link on the result.
   */
  dispose?(): Promise<void>;
}

/** One recorded outbound API call (ring buffer, last 50 per plane). */
export interface ApiCallLogEntry {
  time: string; // ISO
  path: string;
  ms: number;
  code: string;
}
