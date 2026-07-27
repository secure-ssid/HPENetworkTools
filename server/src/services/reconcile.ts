/**
 * server/src/services/reconcile.ts — cross-plane device reconciliation.
 *
 * Design rules implemented here (README §"Integration model"):
 *   2. Reconcile, don't duplicate — a device claimed by two planes is one row
 *      flagged `reconciliationIssue`; a device in no cloud plane is still a
 *      first-class row.
 *   1. Never present stale data as current — rows whose ONLY claimant is a
 *      stale plane read state 'unverified' with a neutral tone.
 *
 * Identity: serial if present, else normalized MAC, else lowercased name.
 * Serial/MAC are NOT part of the shared DeviceRow type — adapters attach them
 * as optional hints (see DeviceIdentityHints below); rows without hints still
 * reconcile by name.
 *
 * "Unclaimed" means claimed by 'local' and nothing else: the SSH collector is
 * a transport, not a management plane, so a collector-only row is a device no
 * management plane accounts for (README: "double-claimed OR in no cloud
 * plane"). Rows claimed solely by any other plane (Mist, AOS-8, …) are
 * claimed, matching how the fixtures treat single-plane rows.
 *
 * claimedBy uses the shared display-plane labels ('CENTRAL', …), not the
 * internal PlaneId, so the UI can render it without a mapping table.
 *
 * Pure module: no I/O, no singletons — fully unit-testable.
 */

import type { DeviceRow, Plane } from '../../../shared';
import type { PlaneId } from '../planes/types';

/** Extra identity fields adapters may attach; not in the shared types. */
export interface DeviceIdentityHints {
  serial?: string;
  mac?: string;
}

/** DeviceRow as the reconciliation layer returns it: identity hints preserved,
 *  plus the claiming planes. (Task spec: `DeviceRow & { claimedBy?: string[] }`
 *  — Plane[] is the precise form of string[]; hints ride along so identity
 *  stays visible downstream.) */
export type ReconciledDeviceRow = DeviceRow & DeviceIdentityHints & { claimedBy?: Plane[] };

export interface ReconcileResult {
  devices: ReconciledDeviceRow[];
  doubleClaimed: number;
  unclaimed: number;
}

/** Display label per plane id (kept in sync with the shared Plane union). */
export const PLANE_LABEL: Record<PlaneId, Plane> = {
  central: 'CENTRAL',
  classic: 'CLASSIC',
  mist: 'MIST',
  greenlake: 'GREENLAKE',
  aos8: 'AOS-8',
  aos10: 'AOS-10',
  local: 'LOCAL',
  clearpass: 'CLEARPASS',
  uxi: 'UXI',
};

/**
 * Display-field priority: central > classic > mist > local > others
 * (remaining planes in PLANE_IDS order). When two planes describe the same
 * device, the earlier plane's row supplies the display fields.
 */
const PLANE_RANK: Record<PlaneId, number> = {
  central: 0,
  classic: 1,
  mist: 2,
  local: 3,
  greenlake: 4,
  aos8: 5,
  aos10: 6,
  clearpass: 7,
  uxi: 8,
};

/** 'AA:BB:CC:DD:EE:FF', 'aabb.ccdd.eeff' and 'aabb-ccdd-eeff' all → 'aabbccddeeff'. */
export function normalizeMac(mac: string): string {
  return mac.toLowerCase().replace(/[:.-]/g, '');
}

/**
 * Identity key for one row: serial wins, then normalized MAC, then name.
 * Rows with neither hint fall back to name — exact for fixture data, good
 * enough for planes that report stable hostnames.
 */
export function identityKey(row: DeviceRow & DeviceIdentityHints): string {
  const serial = row.serial?.trim();
  if (serial) return `serial:${serial.toLowerCase()}`;
  const mac = row.mac?.trim();
  if (mac) return `mac:${normalizeMac(mac)}`;
  return `name:${row.name.trim().toLowerCase()}`;
}

interface Claim {
  row: DeviceRow & DeviceIdentityHints;
  plane: PlaneId;
  stale: boolean;
}

/**
 * Merge every plane's device inventory into one row per physical device.
 *
 * `byPlane` maps plane id → that plane's last good device list (poller
 * contributions). `stale` is the set of planes currently serving stale data
 * (caller decides what stale means — the routes use health 'degraded').
 */
export function reconcileDevices(
  byPlane: Partial<Record<PlaneId, readonly DeviceRow[]>>,
  stale: ReadonlySet<PlaneId> = new Set<PlaneId>(),
): ReconcileResult {
  // Group claims by identity key, iterating planes in priority order so
  // output order is deterministic.
  const groups = new Map<string, Claim[]>();
  const planes = (Object.keys(byPlane) as PlaneId[]).sort((a, b) => PLANE_RANK[a] - PLANE_RANK[b]);
  for (const plane of planes) {
    for (const row of byPlane[plane] ?? []) {
      const key = identityKey(row);
      const claims = groups.get(key);
      const claim: Claim = { row, plane, stale: stale.has(plane) };
      if (claims) claims.push(claim);
      else groups.set(key, [claim]);
    }
  }

  const devices: ReconciledDeviceRow[] = [];
  let doubleClaimed = 0;
  let unclaimed = 0;

  for (const claims of groups.values()) {
    // One claimant per plane (a plane reporting the same device twice still
    // claims it once).
    const claimantPlanes: PlaneId[] = [];
    for (const c of claims) {
      if (!claimantPlanes.includes(c.plane)) claimantPlanes.push(c.plane);
    }
    claimantPlanes.sort((a, b) => PLANE_RANK[a] - PLANE_RANK[b]);

    // Display fields come from the healthiest, highest-priority claimant:
    // fresh planes outrank stale ones, then the priority order decides.
    const display = [...claims].sort((a, b) => {
      if (a.stale !== b.stale) return a.stale ? 1 : -1;
      return PLANE_RANK[a.plane] - PLANE_RANK[b.plane];
    })[0].row;

    const merged: ReconciledDeviceRow = {
      ...display,
      claimedBy: claimantPlanes.map((p) => PLANE_LABEL[p]),
    };

    let issue = false;
    if (claimantPlanes.length > 1) {
      doubleClaimed += 1;
      issue = true;
    }
    if (claimantPlanes.every((p) => p === 'local')) {
      unclaimed += 1;
      issue = true; // in no management plane — first-class, but flagged
    }
    merged.reconciliationIssue = issue;

    // Design rule 1: every claimant is stale → we cannot assert live state.
    if (claims.every((c) => c.stale)) {
      merged.state = 'unverified';
      merged.stateTone = 'neutral';
    }

    devices.push(merged);
  }

  return { devices, doubleClaimed, unclaimed };
}
