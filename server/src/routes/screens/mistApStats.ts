/**
 * server/src/routes/screens/mistApStats.ts — the Mist AP rich-stats dataset
 * (PlanePull.mistApStats) joined onto two screen payloads.
 *
 * Two jobs:
 *
 *  1. `mistApStatsFor` — the one MistApStatsRow that belongs to a device row,
 *     for the device page's RF/health panel. The dataset is keyed by device
 *     name/uuid on Mist's side; the reconciled row's serial is the strongest
 *     join, the MAC the next, and the display name the legacy fallback (the
 *     same identity order resolveDeviceIdentity applies to the row itself).
 *
 *  2. `mistLldpTopology` — a SiteTopologyLive built from the rows' LLDP
 *     uplinks, for the site page when Mist's own /topology endpoint publishes
 *     no graph (it 404s on sites that have none — the adapter honestly
 *     returns null there). Every edge is one AP's OWN LLDP report of its
 *     uplink neighbour; nothing is inferred beyond what `lldp_stat` says, and
 *     the edges are typed 'LLDP' so the diagram words their provenance
 *     instead of reading them as a plane-observed full graph.
 *
 * The dataset is a POLL read, so this module issues no plane calls of its own.
 */

import type {
  DeviceRow,
  MistApStatsRow,
  SiteRow,
  SiteTopologyLive,
  TopologyDeviceNode,
  TopologyLink,
} from '@hpe/shared';
import { registry } from '../../planes/registry';
import { poller } from '../../services/poller';

/** The Mist contribution's AP stats rows — empty when the plane is unlinked
 *  or the AP-stats walk was not read this cycle (the key is omitted, never
 *  emptied, on a failed walk). */
export function liveMistApStats(): MistApStatsRow[] {
  return poller.contributionsByPlane().get('mist')?.mistApStats ?? [];
}

/**
 * Was Mist's AP walk missing from this cycle rather than genuinely empty?
 *
 * `liveMistApStats` ends in `?? []`, which is the laundering the comment above
 * warns about: a linked Mist whose walk failed and a Mist that manages no APs
 * both arrive as zero rows. Every LLDP edge on the estate graph is built from
 * this dataset, so the difference decides whether a graph with no Mist edges
 * means "no AP reported a neighbour" or "we never saw the APs".
 *
 * Unlinked is not unread — a plane nobody connected owes no answer.
 */
export function mistApStatsUnread(): boolean {
  if (!registry.state('mist').linked) return false;
  return poller.contributionsByPlane().get('mist')?.mistApStats === undefined;
}

/** Case- and separator-insensitive MAC key (the adapter's own macKey rule). */
function macKey(v: string | null | undefined): string | null {
  if (!v) return null;
  const hex = v.toLowerCase().replace(/[^0-9a-f]/g, '');
  return hex.length > 0 ? hex : null;
}

/**
 * The AP-stats row for one device row, or null when the dataset says nothing
 * about it. Serial beats MAC beats name — name-only matching is last because
 * two reconciled rows may share a display name, and a stats row attached to
 * the wrong physical AP is worse than none.
 */
export function mistApStatsFor(
  device: Pick<DeviceRow, 'name' | 'serial' | 'mac'>,
  rows: MistApStatsRow[],
): MistApStatsRow | null {
  const serial = device.serial?.trim().toLowerCase();
  if (serial) {
    const hit = rows.find((row) => row.serial?.trim().toLowerCase() === serial);
    if (hit) return hit;
  }
  const mac = macKey(device.mac);
  if (mac) {
    const hit = rows.find((row) => macKey(row.mac) === mac);
    if (hit) return hit;
  }
  const name = device.name.trim().toLowerCase();
  return rows.find((row) => row.deviceName.trim().toLowerCase() === name) ?? null;
}

/** The device row an AP-stats row belongs to, for the card's liveness word.
 *  Same identity order as mistApStatsFor, in the other direction. */
function deviceForApStats(
  row: MistApStatsRow,
  devices: ReadonlyArray<Pick<DeviceRow, 'name' | 'serial' | 'mac' | 'state'>>,
): Pick<DeviceRow, 'name' | 'serial' | 'mac' | 'state'> | null {
  const serial = row.serial?.trim().toLowerCase();
  if (serial) {
    const hit = devices.find((d) => d.serial?.trim().toLowerCase() === serial);
    if (hit) return hit;
  }
  const mac = macKey(row.mac);
  if (mac) {
    const hit = devices.find((d) => macKey(d.mac) === mac);
    if (hit) return hit;
  }
  const name = row.deviceName.trim().toLowerCase();
  return devices.find((d) => d.name.trim().toLowerCase() === name) ?? null;
}

/** The graph key for one AP — serial, then the Mist device uuid, then the
 *  MAC, then a name-derived key that still cannot collide with a serial. */
function apNodeKey(row: MistApStatsRow): string {
  return row.serial ?? row.deviceUuid ?? row.mac ?? `mist-ap:${row.deviceName}`;
}

/** The graph key for one LLDP neighbour — its chassis id when the AP heard
 *  one, else a key derived from the system name (two APs uplinking to the
 *  same system then share ONE neighbour node). */
function neighbourKey(systemName: string, chassisId: string | null): string {
  return chassisId ?? `lldp:${systemName.toLowerCase()}`;
}

/**
 * The site graph the AP stats rows carry: one edge per AP whose `lldp_stat`
 * names a neighbour system, plus the APs and those neighbours as nodes.
 *
 * Honesty rules, matching the screen's honest-edge philosophy:
 *  - No edge without an LLDP report — an AP row with no `lldp_stat` (or one
 *    whose report names no system) is NOT drawn; it is counted in
 *    `isolatedDevicesCount` so the diagram says the graph does not reach it.
 *  - The neighbour is 'Unmanaged': Mist only hears its LLDP advertisements.
 *    Its `model` is the neighbour's own system description, verbatim.
 *  - `lldp_stat` names no LOCAL port, so the AP side of the edge names the
 *    AP's up ports (the convention mapApPortDetail already applies: the AP's
 *    eth port IS the uplink side of that edge), and the speed rides only
 *    when exactly one up port reported one — never a picked one of several.
 *  - The AP's status word is the reconciled row's own state when the row is
 *    in the merged inventory, empty when it is not — the stats row itself
 *    carries no liveness verdict and none is invented.
 *
 * Returns null when no AP at the site reported an LLDP neighbour — the
 * caller then keeps whatever the plane's own topology read answered.
 */
export function mistLldpTopology(
  site: Pick<SiteRow, 'id' | 'name'>,
  rows: MistApStatsRow[],
  devices: ReadonlyArray<Pick<DeviceRow, 'name' | 'serial' | 'mac' | 'state'>> = [],
): SiteTopologyLive | null {
  const siteRows = rows.filter((row) => row.siteId === site.id);
  const edged = siteRows.filter((row) => (row.lldpUplink?.systemName ?? '').trim() !== '');
  if (edged.length === 0) return null;

  const nodes = new Map<string, TopologyDeviceNode>();
  const links: TopologyLink[] = [];
  for (const row of edged) {
    const lldp = row.lldpUplink!;
    const systemName = lldp.systemName!.trim();
    const apKey = apNodeKey(row);
    if (!nodes.has(apKey)) {
      const device = deviceForApStats(row, devices);
      nodes.set(apKey, {
        serial: apKey,
        name: row.deviceName,
        type: 'Access Point',
        deviceFunction: '-',
        status: device?.state ?? '',
        health: null,
        healthReason: null,
        model: null,
        ipv4: null,
        mac: row.mac,
      });
    }
    const nbKey = neighbourKey(systemName, lldp.chassisId);
    if (!nodes.has(nbKey)) {
      nodes.set(nbKey, {
        serial: nbKey,
        name: systemName,
        // Mist hears this system only through the AP's LLDP report — it is
        // not managed here, and its description is its own verbatim claim.
        type: 'Unmanaged',
        deviceFunction: '-',
        status: '',
        health: null,
        healthReason: null,
        model: lldp.systemDesc,
        ipv4: lldp.mgmtAddr,
        mac: lldp.chassisId,
      });
    }
    const upPorts = row.ports.filter((port) => port.up === true);
    links.push({
      from: apKey,
      to: nbKey,
      fromPorts: upPorts.map((port) => ({ name: port.name })),
      toPorts: lldp.portId ? [{ name: lldp.portId }] : [],
      speedBps:
        upPorts.length === 1 && upPorts[0]!.speedMbps !== null ? upPorts[0]!.speedMbps * 1_000_000 : null,
      health: null,
      edgeType: 'LLDP',
    });
  }

  return {
    siteId: String(site.id),
    nodes: [...nodes.values()],
    links,
    // APs at the site whose row carried no LLDP neighbour are real and absent
    // from this graph — the diagram's omission wording says exactly that.
    isolatedDevicesCount: siteRows.length - edged.length,
    isolatedHealth: null,
    source: {
      plane: 'mist',
      // mistApStats is a structured dataset, so lastSyncFor cannot stamp it —
      // the Mist plane's own last-successful-pull stamp is the same instant.
      at: poller.freshness().mist ?? new Date().toISOString(),
      sections: { nodes: 'ok', links: 'ok' },
      note:
        'Each edge is one AP’s own LLDP report of its uplink neighbour, read from the Mist AP stats walk ' +
        '(Mist publishes no topology graph for this site) — physical adjacency only, not a full site graph.',
    },
  };
}
