/**
 * shared/topologyGraph.ts — the estate-level cross-plane topology graph.
 *
 * One graph over every plane's REPORTED neighbour facts. A node is a device,
 * deduped across planes by serial, then MAC, then name (the same identity
 * order the reconciler applies to the inventory itself); an edge is an
 * adjacency some plane — or the portal's own wiring records — actually
 * reported, carrying its provenance (which plane, which protocol word,
 * staleness) rather than reading as a surveyed truth.
 *
 * The honesty rules are the site topology's, applied estate-wide:
 *
 *  - NO INVENTED EDGES. Every edge traces to at least one report; a device
 *    nothing reports a neighbour for sits unconnected, and says nothing.
 *  - A neighbour that resolves to no inventory row is a GHOST — drawn as a
 *    reported neighbour, never promoted to a managed device and never
 *    silently dropped (the far end of an LLDP report is real even when no
 *    plane manages it).
 *  - Two planes reporting one adjacency merge into ONE edge with multi-source
 *    provenance; two links between the same pair on different ports stay two
 *    edges. Staleness follows the worst case: an edge every source has gone
 *    quiet on is stale, an edge one fresh source still vouches for is not.
 *
 * Provenance with `plane: null` is the portal's recorded wiring — an asserted
 * fact, worded as one, never dressed up as a plane's observation.
 *
 * `buildDemoTopologyGraph()` assembles the demo estate's graph from the
 * fixtures so the server route and the client's backend-unreachable fallback
 * produce the SAME graph; every stamp is fixed (DEMO_TOPOLOGY_STAMP), so the
 * demo payload is byte-identical on every read.
 */

import {
  AP_UPLINK,
  DEVICES,
  MIST_AP_STATS,
  SITES,
  TOPOLOGY_EDGE_REPORTS,
} from './fixtures';
import type { Plane, SiteId, SiteRow, Tone } from './types';

// ---------------------------------------------------------------------------
// Inputs — what the merge consumes
// ---------------------------------------------------------------------------

/** A device as the merged inventory knows it — one row per physical device. */
export interface TopologyDeviceInput {
  name: string;
  model: string | null;
  /** Device-kind word as the row words it ('switch', 'ap', 'gateway', …). */
  type: string;
  serial?: string;
  mac?: string;
  /** The plane whose row this is; `claimedBy` unions every claimant. */
  plane: Plane;
  claimedBy?: Plane[];
  siteId: SiteId;
  siteName: string;
  state: string;
  tone: Tone;
}

/** One end of a reported adjacency, named exactly as the report names it. */
export interface TopologyEdgeEndInput {
  /** System name as reported — the display word and the weakest join key. */
  name: string;
  serial?: string | null;
  mac?: string | null;
  /** Port at this end as the report words it; null/absent = not reported. */
  port?: string | null;
}

/**
 * One neighbour fact one source reported. `plane: null` marks the portal's
 * own wiring records: asserted, never claimed as a plane's observation.
 */
export interface TopologyEdgeReportInput {
  plane: Plane | null;
  /** Evidence word, verbatim ('LLDP', 'CDP', 'VSF', 'recorded uplink'). */
  protocol: string;
  from: TopologyEdgeEndInput;
  to: TopologyEdgeEndInput;
  /** Link speed in bits per second; null/absent = not reported. */
  speedBps?: number | null;
  /** ISO stamp of the read that reported this; null = the fact carries none. */
  reportedAt?: string | null;
  /** The reporting source is currently behind — the fact is unverified. */
  stale?: boolean;
}

// ---------------------------------------------------------------------------
// Output — the merged graph
// ---------------------------------------------------------------------------

export interface TopologyGraphNode {
  /** Stable graph id ('serial:…' / 'mac:…' / 'name:…' — strongest key held). */
  id: string;
  name: string;
  model: string | null;
  /** Inventory device-kind word; null on a ghost (no row words it). */
  type: string | null;
  serial: string | null;
  mac: string | null;
  /** The site's filing; null on a ghost (a reported neighbour is filed nowhere). */
  siteId: SiteId | null;
  siteName: string | null;
  /** CLAIMING planes on a managed node, REPORTING planes on a ghost. */
  planes: Plane[];
  /** Inventory state word; null on a ghost — a ghost makes no liveness claim. */
  state: string | null;
  tone: Tone;
  /** true = named by an edge but by no inventory row anywhere. */
  ghost: boolean;
}

/** One source's say-so for an edge. */
export interface TopologyEdgeProvenance {
  plane: Plane | null;
  protocol: string;
  reportedAt: string | null;
  stale: boolean;
}

export interface TopologyGraphEdge {
  /** Stable id: the unordered endpoint ids plus the unordered port pair. */
  id: string;
  from: string;
  to: string;
  fromPort: string | null;
  toPort: string | null;
  speedBps: number | null;
  /** Evidence words across every report, deduped in first-seen order. */
  protocols: string[];
  /** One entry per source that reported this adjacency. */
  provenance: TopologyEdgeProvenance[];
  /** The two ends are managed devices filed under DIFFERENT sites. */
  crossSite: boolean;
  /** true only when EVERY source is stale — one fresh source vouches fresh. */
  stale: boolean;
  /** Newest report stamp across the provenance (null = none carried one). */
  reportedAt: string | null;
}

/** A site's roll-up over its nodes — the collapse/expand grouping unit. */
export interface TopologyGraphSite {
  siteId: SiteId;
  name: string;
  /** Managed-by badges, in the site row's own order. */
  planes: Plane[];
  nodeCount: number;
  /** Edges with both ends filed here. */
  internalEdges: number;
  /** Edges with exactly one end filed here. */
  externalEdges: number;
  /** Worst node tone at the site ('neutral' when it holds none). */
  tone: Tone;
}

export interface TopologyGraph {
  nodes: TopologyGraphNode[];
  edges: TopologyGraphEdge[];
  sites: TopologyGraphSite[];
  /** Reports the graph refused to draw, worded — nothing is dropped silently. */
  omissions: string[];
}

/** The payload body every /api/topology response carries (envelope aside). */
export interface TopologyPayload {
  graph: TopologyGraph;
  notes: string[];
}

// ---------------------------------------------------------------------------
// The merge
// ---------------------------------------------------------------------------

/** Lower rank = worse tone (the group roll-up rule shared with logic.ts). */
function toneRank(t: Tone): number {
  switch (t) {
    case 'danger':
      return 0;
    case 'warning':
      return 1;
    case 'neutral':
      return 2;
    case 'info':
      return 3;
    case 'accent':
      return 4;
    default:
      return 5;
  }
}

/** Serial join key: trimmed, case-folded. null when there is nothing to join on. */
function serialKey(v: string | null | undefined): string | null {
  const s = (v ?? '').trim().toLowerCase();
  return s === '' ? null : s;
}

/** MAC join key: the 12 hex digits, case- and separator-insensitive. */
function macKey(v: string | null | undefined): string | null {
  const hex = (v ?? '').toLowerCase().replace(/[^0-9a-f]/g, '');
  return hex.length > 0 ? hex : null;
}

/** Name join key: trimmed, case-folded. The weakest identity — used last. */
function nameKey(v: string | null | undefined): string | null {
  const s = (v ?? '').trim().toLowerCase();
  return s === '' ? null : s;
}

/** The id a node keeps: its STRONGEST key, so a serial never collides with a name. */
function nodeIdFor(node: { serial: string | null; mac: string | null; name: string }): string {
  if (node.serial !== null) return `serial:${node.serial}`;
  if (node.mac !== null) return `mac:${node.mac}`;
  return `name:${nameKey(node.name) ?? node.name}`;
}

/** Undirected edge id: endpoints sorted, port pair sorted with them. */
function edgeIdFor(a: string, aPort: string | null, b: string, bPort: string | null): string {
  const left = `${a}${aPort ? `|${aPort}` : ''}`;
  const right = `${b}${bPort ? `|${bPort}` : ''}`;
  return left < right ? `${left}~~${right}` : `${right}~~${left}`;
}

/** Undirected NODE-PAIR key (ports aside) — the parallel-link grouping. */
function pairKeyFor(a: string, b: string): string {
  return a < b ? `${a}~~${b}` : `${b}~~${a}`;
}

/**
 * Could this report be the same physical link as this edge? Exact port match,
 * or either side carrying no ports at all (a recorded uplink names no ports —
 * it asserts the ADJACENCY, not the jack). An ambiguous candidate set (two
 * parallel links plus one portless report) is NOT merged — the caller cannot
 * tell which link it asserts, and picking one would invent a fact.
 */
function portsExact(
  edge: TopologyGraphEdge,
  fromId: string,
  fromPort: string | null,
  toPort: string | null,
): boolean {
  const [near, far] = edge.from === fromId ? [edge.fromPort, edge.toPort] : [edge.toPort, edge.fromPort];
  return near === fromPort && far === toPort;
}

function portsCompatible(
  edge: TopologyGraphEdge,
  fromId: string,
  fromPort: string | null,
  toPort: string | null,
): boolean {
  if (portsExact(edge, fromId, fromPort, toPort)) return true;
  const [near, far] = edge.from === fromId ? [edge.fromPort, edge.toPort] : [edge.toPort, edge.fromPort];
  if (near === null && far === null) return true;
  return fromPort === null && toPort === null;
}

/**
 * Merge the inventory and every reported neighbour fact into one graph.
 *
 * `sites` is the site list the serving mode already shows (SITES in demo, the
 * merged live rows otherwise) — every one appears, even with no nodes, so a
 * site the inventory is silent about reads as silent rather than absent.
 * Devices filed somewhere the list does not name (bookkeeping ids) land in no
 * site; the renderer groups them with the ghosts as 'no physical site'.
 */
export function buildTopologyGraph(
  devices: readonly TopologyDeviceInput[],
  reports: readonly TopologyEdgeReportInput[],
  sites: readonly Pick<SiteRow, 'id' | 'name' | 'planes'>[] = [],
): TopologyGraph {
  const nodes = new Map<string, TopologyGraphNode>();
  const bySerial = new Map<string, string>();
  const byMac = new Map<string, string>();
  const byName = new Map<string, string>();

  const register = (node: TopologyGraphNode): void => {
    const serial = serialKey(node.serial);
    const mac = macKey(node.mac);
    const name = nameKey(node.name);
    if (serial !== null && !bySerial.has(serial)) bySerial.set(serial, node.id);
    if (mac !== null && !byMac.has(mac)) byMac.set(mac, node.id);
    if (name !== null && !byName.has(name)) byName.set(name, node.id);
  };

  // The inventory first: an edge endpoint always prefers a managed device over
  // a ghost. Rows arrive reconciled in live mode, but the merge does not ASSUME
  // it — two rows for one physical device (fed per-plane lists, or a name-only
  // row beside a serial-keyed one) merge into ONE node here, badges unioned in
  // first-seen order, first row's facts winning fields both carry.
  for (const d of devices) {
    const serial = serialKey(d.serial);
    const mac = macKey(d.mac);
    const name = nameKey(d.name);
    const existingId =
      (serial !== null ? bySerial.get(serial) : undefined) ??
      (mac !== null ? byMac.get(mac) : undefined) ??
      (name !== null ? byName.get(name) : undefined);
    if (existingId !== undefined) {
      const node = nodes.get(existingId)!;
      for (const plane of d.claimedBy && d.claimedBy.length > 0 ? d.claimedBy : [d.plane]) {
        if (!node.planes.includes(plane)) node.planes.push(plane);
      }
      node.serial = node.serial ?? serial;
      node.mac = node.mac ?? mac;
      node.model = node.model ?? d.model;
      register(node);
      continue;
    }
    const id = nodeIdFor({ serial, mac, name: d.name });
    const planes = (d.claimedBy && d.claimedBy.length > 0 ? d.claimedBy : [d.plane]).filter(
      (plane, i, all) => all.indexOf(plane) === i,
    );
    const node: TopologyGraphNode = {
      id,
      name: d.name,
      model: d.model,
      type: d.type,
      serial,
      mac,
      siteId: d.siteId,
      siteName: d.siteName,
      planes,
      state: d.state,
      tone: d.tone,
      ghost: false,
    };
    nodes.set(id, node);
    register(node);
  }

  /**
   * Resolve one reported endpoint to a node — serial, then MAC, then name.
   * A miss creates a GHOST keyed by the strongest fact the report carried,
   * registered under every key it offered so a later, sparser report of the
   * same neighbour lands on the same node.
   */
  const resolveEnd = (end: TopologyEdgeEndInput, plane: Plane | null): TopologyGraphNode | null => {
    const serial = serialKey(end.serial);
    const mac = macKey(end.mac);
    const name = nameKey(end.name);
    if (serial === null && mac === null && name === null) return null;
    const hitId =
      (serial !== null ? bySerial.get(serial) : undefined) ??
      (mac !== null ? byMac.get(mac) : undefined) ??
      (name !== null ? byName.get(name) : undefined);
    if (hitId !== undefined) {
      const node = nodes.get(hitId)!;
      // A managed node this source had not named before earns its badge — the
      // report IS the source naming the device (a ghost's planes are exactly
      // this list; a managed node's badges stay its claimants).
      if (node.ghost && plane !== null && !node.planes.includes(plane)) node.planes.push(plane);
      // A report can teach a ghost its stronger keys (LLDP names a chassis id
      // the recorded uplink did not carry) — adopt and re-key under them.
      if (node.ghost) {
        if (node.serial === null && serial !== null) node.serial = serial;
        if (node.mac === null && mac !== null) node.mac = mac;
        register(node);
      }
      return node;
    }
    const node: TopologyGraphNode = {
      id: nodeIdFor({ serial, mac, name: end.name }),
      name: end.name.trim(),
      model: null,
      type: null,
      serial,
      mac,
      siteId: null,
      siteName: null,
      planes: plane !== null ? [plane] : [],
      state: null,
      tone: 'neutral',
      ghost: true,
    };
    nodes.set(node.id, node);
    register(node);
    return node;
  };

  const edges = new Map<string, TopologyGraphEdge>();
  const edgeIdsByPair = new Map<string, string[]>();
  const omissions: string[] = [];
  let selfEdges = 0;
  let contentFree = 0;

  const registerEdge = (edge: TopologyGraphEdge): void => {
    edges.set(edge.id, edge);
    const pair = pairKeyFor(edge.from, edge.to);
    const list = edgeIdsByPair.get(pair) ?? [];
    list.push(edge.id);
    edgeIdsByPair.set(pair, list);
  };

  for (const report of reports) {
    const from = resolveEnd(report.from, report.plane);
    const to = resolveEnd(report.to, report.plane);
    if (from === null || to === null) {
      contentFree += 1;
      continue;
    }
    if (from.id === to.id) {
      selfEdges += 1;
      continue;
    }
    const fromPort = (report.from.port ?? '').trim() || null;
    const toPort = (report.to.port ?? '').trim() || null;
    const provenance: TopologyEdgeProvenance = {
      plane: report.plane,
      protocol: report.protocol,
      reportedAt: report.reportedAt ?? null,
      stale: report.stale === true,
    };
    // The merge target: an exact port-pair match first, else the ONE
    // compatible edge of this node pair (a portless report joining a single
    // ported link, or the reverse). Zero or several candidates starts a new edge.
    const pair = pairKeyFor(from.id, to.id);
    const pool = (edgeIdsByPair.get(pair) ?? []).map((id) => edges.get(id)!);
    const exact = pool.filter((edge) => portsExact(edge, from.id, fromPort, toPort));
    const compatible = pool.filter((edge) => portsCompatible(edge, from.id, fromPort, toPort));
    const existing = exact.length > 0 ? exact[0] : compatible.length === 1 ? compatible[0] : undefined;
    if (existing) {
      // One physical link, several sources: the edge stays one, the say-so
      // grows. An identical (plane, protocol, stamp) entry is the same report
      // seen twice (two chains naming one pair) and is not repeated.
      const already = existing.provenance.some(
        (p) =>
          p.plane === provenance.plane &&
          p.protocol === provenance.protocol &&
          p.reportedAt === provenance.reportedAt,
      );
      if (!already) existing.provenance.push(provenance);
      if (!existing.protocols.includes(report.protocol)) existing.protocols.push(report.protocol);
      // Ports fill in orientation: the report's near port belongs to the
      // report's near node, whichever end of the stored edge that is.
      const [nearPort, farPort] = existing.from === from.id ? [fromPort, toPort] : [toPort, fromPort];
      existing.fromPort = existing.fromPort ?? nearPort;
      existing.toPort = existing.toPort ?? farPort;
      existing.speedBps = existing.speedBps ?? report.speedBps ?? null;
      existing.stale = existing.provenance.every((p) => p.stale);
      existing.reportedAt = latestStamp(existing.reportedAt, provenance.reportedAt);
      continue;
    }
    registerEdge({
      id: edgeIdFor(from.id, fromPort, to.id, toPort),
      from: from.id,
      to: to.id,
      fromPort,
      toPort,
      speedBps: report.speedBps ?? null,
      protocols: [report.protocol],
      provenance: [provenance],
      crossSite:
        !from.ghost && !to.ghost && from.siteId !== null && to.siteId !== null && from.siteId !== to.siteId,
      stale: provenance.stale,
      reportedAt: provenance.reportedAt,
    });
  }

  if (selfEdges > 0) {
    omissions.push(
      `${selfEdges === 1 ? 'One report names' : `${selfEdges} reports name`} a device as its own neighbour — not drawn.`,
    );
  }
  if (contentFree > 0) {
    omissions.push(
      `${contentFree === 1 ? 'One report carried' : `${contentFree} reports carried`} no usable system name — not drawn.`,
    );
  }

  const nodeList = [...nodes.values()].sort(
    (a, b) => Number(a.ghost) - Number(b.ghost) || a.name.localeCompare(b.name),
  );
  const edgeList = [...edges.values()].sort((a, b) => a.id.localeCompare(b.id));

  const siteList: TopologyGraphSite[] = sites.map((site) => {
    const members = nodeList.filter((n) => !n.ghost && n.siteId === site.id);
    const internal = edgeList.filter((e) => {
      const a = nodes.get(e.from)!;
      const b = nodes.get(e.to)!;
      return a.siteId === site.id && b.siteId === site.id && !a.ghost && !b.ghost;
    }).length;
    const external = edgeList.filter((e) => {
      const a = nodes.get(e.from)!;
      const b = nodes.get(e.to)!;
      return (a.siteId === site.id) !== (b.siteId === site.id);
    }).length;
    const worst = members.reduce(
      (tone, n) => (toneRank(n.tone) < toneRank(tone) ? n.tone : tone),
      'neutral' as Tone,
    );
    return {
      siteId: site.id,
      name: site.name,
      planes: site.planes.map((p) => p.name),
      nodeCount: members.length,
      internalEdges: internal,
      externalEdges: external,
      tone: members.length > 0 ? worst : 'neutral',
    };
  });

  return { nodes: nodeList, edges: edgeList, sites: siteList, omissions };
}

/** The newer of two ISO stamps, null-tolerant (null asserts no time). */
function latestStamp(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return a >= b ? a : b;
}

// ---------------------------------------------------------------------------
// The demo estate's graph — assembled from the fixtures, stamped fixed
// ---------------------------------------------------------------------------

/** The fixed stamp the demo world's topology reads carry (the SLE fixtures'
 *  convention): the demo graph is byte-identical on every build. */
export const DEMO_TOPOLOGY_STAMP = '2026-07-26T11:59:00.000Z';

/** The demo estate's device rows as merge input. */
export function demoTopologyDevices(): TopologyDeviceInput[] {
  return DEVICES.map((d) => ({
    name: d.name,
    model: d.model,
    type: d.type,
    serial: d.serial,
    mac: d.mac,
    plane: d.plane,
    claimedBy: d.claimedBy,
    siteId: d.siteId,
    siteName: d.siteName,
    state: d.state,
    tone: d.stateTone,
  }));
}

/**
 * The demo estate's reported neighbour facts, from the three places the demo
 * world carries them:
 *
 *  - AP_UPLINK — the portal's recorded AP → switch wiring (plane null: an
 *    asserted record, not a plane's observation). A record whose parent is
 *    filed at ANOTHER site is not drawn — the record contradicts the filing
 *    and the omission says so; a record naming a parent no plane returns
 *    draws a ghost, which is exactly what that switch is to the inventory.
 *  - MIST_AP_STATS — every AP's own LLDP uplink report, the same rows the
 *    live Mist poll carries and the same single-up-port speed rule the site
 *    graph applies (mistApStats.mistLldpTopology).
 *  - TOPOLOGY_EDGE_REPORTS — the authored cross-site and fabric links, one
 *    row per plane report, so a link two planes report merges here exactly
 *    as it would live.
 */
export function demoTopologyReports(): { reports: TopologyEdgeReportInput[]; omissions: string[] } {
  const reports: TopologyEdgeReportInput[] = [];
  const omissions: string[] = [];
  const byName = new Map(DEVICES.map((d) => [d.name.trim().toLowerCase(), d]));

  for (const [ap, parent] of Object.entries(AP_UPLINK)) {
    const apRow = byName.get(ap.trim().toLowerCase());
    const parentRow = byName.get(parent.trim().toLowerCase());
    if (apRow && parentRow && apRow.siteId !== parentRow.siteId) {
      omissions.push(
        `The recorded uplink ${ap} → ${parent} names a parent filed at another site ` +
          `(${apRow.siteName} vs ${parentRow.siteName}) — not drawn; the AP's own LLDP report names its uplink.`,
      );
      continue;
    }
    reports.push({
      plane: null,
      protocol: 'recorded uplink',
      from: { name: ap },
      to: { name: parent },
    });
  }

  for (const row of MIST_AP_STATS) {
    const lldp = row.lldpUplink;
    const systemName = (lldp?.systemName ?? '').trim();
    if (!lldp || systemName === '') continue;
    const upPorts = row.ports.filter((port) => port.up === true);
    reports.push({
      plane: 'MIST',
      protocol: 'LLDP',
      from: {
        name: row.deviceName,
        serial: row.serial,
        mac: row.mac,
        port: upPorts.length > 0 ? upPorts.map((port) => port.name).join('+') : null,
      },
      to: { name: systemName, mac: lldp.chassisId, port: lldp.portId },
      speedBps:
        upPorts.length === 1 && upPorts[0]!.speedMbps !== null ? upPorts[0]!.speedMbps * 1_000_000 : null,
      reportedAt: DEMO_TOPOLOGY_STAMP,
    });
  }

  reports.push(...TOPOLOGY_EDGE_REPORTS);
  return { reports, omissions };
}

/** The demo estate's merged graph — the route's demo branch and the client's
 *  backend-unreachable fallback build the SAME graph from this one function. */
export function buildDemoTopologyGraph(): TopologyGraph {
  const { reports, omissions } = demoTopologyReports();
  const graph = buildTopologyGraph(demoTopologyDevices(), reports, SITES);
  graph.omissions = [...omissions, ...graph.omissions];
  return graph;
}

/** The demo payload's footer notes — provenance wording both the route and
 *  the client fallback carry verbatim. */
export function demoTopologyNotes(): string[] {
  return [
    'Every edge is a reported neighbour fact: the Mist APs’ own LLDP uplink reports, the local collector’s LLDP and VSF reads, Classic’s stale CDP report at Riverside, and the portal’s recorded uplinks (no plane badge — asserted wiring, not an observed adjacency).',
    'A link two sources report renders both badges; a reported neighbour with no inventory row is a ghost, drawn as reported and never promoted to a managed device.',
  ];
}
