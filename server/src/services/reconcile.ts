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

import type { DeviceRow, Plane } from '@hpe/shared';
import { PLANE_IDS, type PlaneId } from '../planes/types';

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
  sse: 'SSE',
};

/**
 * Inverse of PLANE_LABEL: the registry plane id behind a display label, or
 * undefined when the label names no registry plane ('THIRD-PARTY').
 *
 * Reconciliation is where a row's claiming planes are decided (claimedBy holds
 * DISPLAY labels so the UI needs no mapping table), so the way back — from a
 * claim to the plane whose registry state and capabilities() describe it — is
 * published here rather than re-derived by every caller that has to ask "can
 * the plane claiming this row hand out a shell / take a brokered write?".
 */
export function planeIdForLabel(label: Plane): PlaneId | undefined {
  return PLANE_ID_FOR[label];
}

const PLANE_ID_FOR: Partial<Record<Plane, PlaneId>> = Object.fromEntries(
  PLANE_IDS.map((id) => [PLANE_LABEL[id], id]),
) as Partial<Record<Plane, PlaneId>>;

/**
 * Fields the merge resolves as a UNION across every claimant instead of taking
 * the display claimant's value.
 *
 * `localShell` is the only one today. It is not a display field: it says "a
 * plane that claims this device reports the collector reaches it", and a cloud
 * plane's `false` means "I do not provide a shell", NOT "no shell exists" —
 * exactly the distinction services/terminal.ts draws for the plane-level
 * PlaneCapabilities.localShell. Taking the display claimant's literal makes a
 * higher-ranked cloud plane's disclaimer silently erase a peer's positive
 * claim: an AOS-8 controller (aos8 rows set localShell true for controllers)
 * that Central also claims would merge to false and lose its shell on both
 * /api/devices and /api/devices/:name, which is the false-negative twin of the
 * "gate can never open" defect.
 *
 * ANY, not ALL — deliberately, and the honesty argument runs the other way from
 * the usual one. Offering a shell that fails is a broken control, so if this
 * value reached a button unchanged, ALL would be the safer rule. It does not:
 * this is the row-level CLAIM only, and every live consumer reads it after the
 * composition layer has ANDed in the claiming planes' capabilities() and the
 * collector credentials that ARE the shell path (screens.ts canOpenShell,
 * applied to every live row in liveDeviceData). So ANY here can never surface a
 * control that cannot act, while ALL here would let one cloud plane's "I do not
 * provide a shell" permanently hide a peer's working one — a false negative
 * nothing downstream can recover, because the positive claim is gone.
 *
 * The live facts stay out of this module on purpose: both are singleton/registry
 * reads, and importing them would make this module impure and circular —
 * terminal.ts imports planeIdForLabel from this file.
 */
function unionLocalShell(claims: readonly Claim[]): boolean {
  return claims.some((c) => c.row.localShell === true);
}

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
  // SSE never contributes a DeviceRow (it has no devices dataset at all — see
  // shared SseInventory) so this rank is never actually consulted; it exists
  // only to keep this map exhaustive over PlaneId.
  sse: 9,
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
      // Union, not display (see unionLocalShell): one claimant saying it has no
      // shell path must not erase another claimant saying it does.
      localShell: unionLocalShell(claims),
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
