/**
 * server/src/planes/types.ts — plane adapter contract.
 *
 * Every control plane (Central new, Classic, Mist, GreenLake, AOS-8, AOS-10,
 * the local SSH collector, ClearPass, UXI) has one adapter. Adapters with
 * complete credentials are real (central, greenlake, clearpass, uxi, mist,
 * aos8 today); adapters with partial credentials are `StubAdapter`s (linked,
 * but pull() returns nothing — real implementations land later), adapters
 * without credentials are `UnconfiguredAdapter`s.
 *
 * PlanePull datasets use the normalized shared row types so a real adapter's
 * output can flow straight into the poller cache and the screen endpoints.
 */

import type {
  AlertRow,
  AuthEventRow,
  ClientRow,
  ConfigInventory,
  DeviceRow,
  PlaneDatasetKey,
  PlaneScope,
  SiteRow,
  SubscriptionAssignment,
  SubscriptionRow,
} from '../../../shared';

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
] as const;

export type PlaneId = (typeof PLANE_IDS)[number];

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
  subscriptions?: SubscriptionRow[];
  /** Configuration inventory read from the plane's config API — what the live
   *  Configure screen needs so it stops inferring SSIDs/VLANs from sessions. */
  config?: ConfigInventory;
  /** Device→subscription assignments (GreenLake) — the feed the Licences
   *  screen needs to count unlicensed devices and derive orphan/gap rows. */
  assignments?: SubscriptionAssignment[];
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
