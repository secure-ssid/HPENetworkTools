/**
 * shared/exports.ts — `?part=` / section contracts for multi-slice server CSV exports.
 *
 * CSV responses are not JSON envelopes; these types document the query/section
 * discriminators so OpenAPI, UI download helpers, and route parsers stay aligned.
 * Single-slice exports (devices, clients, …) need no part type.
 */

/** GET /api/topology/export — default `nodes`. */
export type TopologyExportPart = 'nodes' | 'edges';
export const TOPOLOGY_EXPORT_PARTS = ['nodes', 'edges'] as const satisfies readonly TopologyExportPart[];

/** GET /api/licenses/export — default `subscriptions`. */
export type LicensesExportPart = 'subscriptions' | 'renewals';
export const LICENSES_EXPORT_PARTS = ['subscriptions', 'renewals'] as const satisfies readonly LicensesExportPart[];

/** GET /api/greenlake/export — default `users`. */
export type GreenLakeExportPart = 'users' | 'locations' | 'roles';
export const GREENLAKE_EXPORT_PARTS = ['users', 'locations', 'roles'] as const satisfies readonly GreenLakeExportPart[];

/**
 * GET /api/clearpass/export — omit/`''` means endpoints+sessions (not services).
 * Route maps omit → internal `'all'`; clients send endpoints|sessions|services|omit.
 * `services` uses a dedicated column set (not the endpoint/session wide CSV).
 */
export type ClearPassExportPart = 'endpoints' | 'sessions' | 'services';
export const CLEARPASS_EXPORT_PARTS = [
  'endpoints',
  'sessions',
  'services',
] as const satisfies readonly ClearPassExportPart[];

/** GET /api/configure/export — default `ssids`. Inventory summary only (no bodies/secrets). */
export type ConfigureExportPart = 'ssids' | 'ports' | 'vlans';
export const CONFIGURE_EXPORT_PARTS = [
  'ssids',
  'ports',
  'vlans',
] as const satisfies readonly ConfigureExportPart[];

/**
 * GET /api/overview/export — default `alerts` (Needs-you-now).
 * `sites` also honours optional `?health=` (ok|warn|bad|stale) like the Overview Sites preview.
 */
export type OverviewExportPart = 'alerts' | 'planes' | 'sites' | 'changes';
export const OVERVIEW_EXPORT_PARTS = [
  'alerts',
  'planes',
  'sites',
  'changes',
] as const satisfies readonly OverviewExportPart[];

/**
 * Section column values in GET /api/central/export when shipping the combined
 * device+site file (omit / part=all). Dedicated part= slices use their own headers.
 */
export type CentralExportSection = 'device' | 'site';
export const CENTRAL_EXPORT_SECTIONS = ['device', 'site'] as const satisfies readonly CentralExportSection[];

/**
 * GET /api/central/export `?part=` — omit/all = combined device+site CSV;
 * device|site narrow that combined layout; firmware|wlans|alerts are dedicated
 * column sets (behind-train rows / WLAN inventory / recent Central alerts).
 */
export type CentralExportPart = 'device' | 'site' | 'firmware' | 'wlans' | 'alerts';
export const CENTRAL_EXPORT_PARTS = [
  'device',
  'site',
  'firmware',
  'wlans',
  'alerts',
] as const satisfies readonly CentralExportPart[];

/**
 * GET /api/mist/export — default `devices`.
 * `wlans` = Mist config SSID inventory (no PSKs); `licenses` = per-site usage
 * tallies (counts only — never entitlement secrets).
 */
export type MistExportPart = 'devices' | 'rogues' | 'ap-stats' | 'sle' | 'wlans' | 'licenses';
export const MIST_EXPORT_PARTS = [
  'devices',
  'rogues',
  'ap-stats',
  'sle',
  'wlans',
  'licenses',
] as const satisfies readonly MistExportPart[];

/**
 * GET /api/devices/{name}/trends/export — default follows device class
 * (switch → hardware, AP → ap with required metric).
 */
export type DeviceTrendsExportPart = 'hardware' | 'interfaces' | 'ap';
export const DEVICE_TRENDS_EXPORT_PARTS = [
  'hardware',
  'interfaces',
  'ap',
] as const satisfies readonly DeviceTrendsExportPart[];

/**
 * GET /api/metrics/export — default `series` (flattened plane + device-client
 * samples). `anomalies` exports only the additive flag rows (never secrets).
 */
export type MetricsExportPart = 'series' | 'anomalies';
export const METRICS_EXPORT_PARTS = ['series', 'anomalies'] as const satisfies readonly MetricsExportPart[];
