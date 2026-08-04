/**
 * Estate topology routes: GET /topology + CSV export of reported graph facts.
 *
 * Export columns are only facts the graph already carries — no invented edges.
 * `part=nodes` (default) or `part=edges`. Optional `q` / `plane` / `ghosts` /
 * `type` match the Topology screen filter (shared filterTopologyGraph) so
 * Download server CSV aligns with the drawn / client-exported view.
 */

import type { Request, Response, Router } from 'express';
import {
  buildDemoTopologyGraph,
  buildTopologyGraph,
  demoTopologyNotes,
  filterTopologyGraph,
  TOPOLOGY_EXPORT_PARTS,
  type Plane,
  type SiteId,
  type SiteRow,
  type SiteTopologyLive,
  type TopologyDeviceInput,
  type TopologyEdgeReportInput,
  type TopologyExportPart,
  type TopologyGraph,
  type TopologyPayload,
} from '@hpe/shared';
import { sendCsv } from '../../lib/csv';
import { queryFlag, queryOneOf, queryString } from '../../lib/query';
import { poller } from '../../services/poller';
import type { ReconciledDeviceRow } from '../../services/reconcile';
import { blending, dataSource, envelope, stalePlanes, withBlended } from './context';
import { settle, livePlaneSiteTopology } from './detailCache';
import { liveMerged } from './liveCore';
import { liveMistApStats } from './mistApStats';
import { devicesForTopology, liveTopologyNotes } from './topologyModel';

function portWords(ports: readonly { name: string }[]): string | null {
  const names = [...new Set(ports.map((port) => port.name.trim()).filter(Boolean))];
  return names.length > 0 ? names.join('+') : null;
}

function centralTopologyReports(topology: SiteTopologyLive | null, stale: boolean): TopologyEdgeReportInput[] {
  if (!topology?.links) return [];
  const nodes = new Map((topology.nodes ?? []).map((node) => [node.serial, node]));
  return topology.links.map((link) => {
    const from = nodes.get(link.from);
    const to = nodes.get(link.to);
    return {
      plane: 'CENTRAL' as const,
      protocol: 'Central topology',
      from: {
        name: from?.name || link.from,
        serial: link.from,
        mac: from?.mac ?? null,
        port: portWords(link.fromPorts),
      },
      to: {
        name: to?.name || link.to,
        serial: link.to,
        mac: to?.mac ?? null,
        port: portWords(link.toPorts),
      },
      speedBps: link.speedBps,
      reportedAt: topology.source.at || null,
      stale,
    };
  });
}

async function liveTopologyReports(sites: readonly SiteRow[]): Promise<TopologyEdgeReportInput[]> {
  const stale = stalePlanes();
  const mistAt = poller.freshness().mist;
  const reports: TopologyEdgeReportInput[] = [];
  for (const row of liveMistApStats()) {
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
      reportedAt: mistAt,
      stale: stale.has('mist'),
    });
  }
  const centralSites = sites.filter((site) => site.planes.some((badge) => badge.name === 'CENTRAL'));
  const centralTopologies = await Promise.all(
    centralSites.map((site) => livePlaneSiteTopology(site, 'central')),
  );
  for (const topology of centralTopologies) {
    reports.push(...centralTopologyReports(topology, stale.has('central')));
  }
  return reports;
}

/**
 * A device can be managed but filed under a bookkeeping bucket such as
 * `multiple`, which deliberately has no `/sites/:id` inventory profile. The
 * estate diagram still needs to show where that real device lives instead of
 * silently grouping it with unfiled ghosts.
 */
function estateTopologySites(
  sites: readonly Pick<SiteRow, 'id' | 'name' | 'planes'>[],
  devices: readonly ReconciledDeviceRow[],
): Pick<SiteRow, 'id' | 'name' | 'planes'>[] {
  const cards = sites.map((site) => ({ ...site, planes: [...site.planes] }));
  const known = new Set(cards.map((site) => site.id));
  const extras = new Map<SiteId, { name: string; planes: Set<Plane> }>();

  for (const device of devices) {
    if (!device.siteId || known.has(device.siteId)) continue;
    const extra = extras.get(device.siteId) ?? {
      name: device.siteName.trim() || device.siteId,
      planes: new Set<Plane>(),
    };
    for (const plane of device.claimedBy && device.claimedBy.length > 0 ? device.claimedBy : [device.plane]) {
      extra.planes.add(plane);
    }
    extras.set(device.siteId, extra);
  }

  for (const [id, extra] of extras) {
    cards.push({
      id,
      name: extra.name,
      planes: [...extra.planes].map((name) => ({ name, tone: 'neutral' as const })),
    });
  }
  return cards;
}

export type TopologyBody = TopologyPayload & {
  dataSource?: string;
  syncedAt?: string | null;
  blended?: string[];
};

/**
 * Same payload assembly as GET /api/topology — reported graph facts only.
 */
export async function topologyBody(): Promise<Record<string, unknown>> {
  const live = liveMerged();
  // Blend mode swaps the whole graph to live rows once any plane reports
  // devices — fixture and live rows never mix inside one payload.
  const useLive = dataSource() === 'live' || (blending() && live.devices.length > 0);
  if (!useLive) {
    return envelope({ graph: buildDemoTopologyGraph(), notes: demoTopologyNotes() });
  }
  const devices: TopologyDeviceInput[] = devicesForTopology(live.devices);
  const reports = await liveTopologyReports(live.sites);
  const payload: Record<string, unknown> = {
    dataSource: 'live',
    syncedAt: poller.lastSyncFor('devices', 'sites'),
    graph: buildTopologyGraph(devices, reports, estateTopologySites(live.sites, live.devices)),
    notes: liveTopologyNotes(reports),
  };
  return dataSource() === 'demo' ? withBlended(payload, ['devices']) : payload;
}

const NODE_HEADER = ['id', 'name', 'type', 'siteId', 'serial', 'ghost', 'planes'] as const;
const EDGE_HEADER = ['from', 'to', 'crossSite', 'stale', 'fromPort', 'toPort', 'protocols', 'reportedAt'] as const;

function graphFromBody(body: Record<string, unknown>): TopologyGraph {
  const graph = body.graph as TopologyGraph | undefined;
  return graph ?? { nodes: [], edges: [], sites: [], omissions: [] };
}

function nodeCsvRows(graph: TopologyGraph): unknown[][] {
  return graph.nodes.map((n) => [
    n.id,
    n.name,
    n.type ?? '',
    n.siteId ?? '',
    n.serial ?? '',
    n.ghost ? 'yes' : 'no',
    (n.planes ?? []).join('|'),
  ]);
}

function edgeCsvRows(graph: TopologyGraph): unknown[][] {
  return graph.edges.map((e) => [
    e.from,
    e.to,
    e.crossSite ? 'yes' : 'no',
    e.stale ? 'yes' : 'no',
    e.fromPort ?? '',
    e.toPort ?? '',
    (e.protocols ?? []).join('|'),
    e.reportedAt ?? '',
  ]);
}

async function serveTopology(res: Response): Promise<void> {
  res.json(await topologyBody());
}

/**
 * Topology export filters (Loop 116 shared parsers).
 * - q / plane / type via queryString (empty plane/type → 'all' for filterTopologyGraph)
 * - ghosts via queryFlag (1/true/yes/on → ghosts-only; unknown/false → full graph)
 */
function topologyExportFilters(req: Request): {
  q: string;
  plane: string;
  ghostsOnly: boolean;
  type: string;
} {
  const q = queryString(req, 'q');
  const plane = queryString(req, 'plane') || 'all';
  const ghostsOnly = queryFlag(req, 'ghosts') === true;
  const type = queryString(req, 'type') || 'all';
  return { q, plane, ghostsOnly, type };
}

async function serveTopologyExport(req: Request, res: Response): Promise<void> {
  // Missing part defaults to nodes; unknown part → 400 (never silent wrong slice).
  const partRaw = queryString(req, 'part');
  const part: TopologyExportPart | null = partRaw
    ? queryOneOf(req, 'part', TOPOLOGY_EXPORT_PARTS)
    : 'nodes';
  if (part === null) {
    res.status(400).json({ error: "part must be 'nodes' or 'edges'" });
    return;
  }
  const body = await topologyBody();
  const graph = filterTopologyGraph(graphFromBody(body), topologyExportFilters(req));
  if (part === 'edges') {
    sendCsv(res, 'topology-edges.csv', [...EDGE_HEADER], edgeCsvRows(graph));
    return;
  }
  sendCsv(res, 'topology-nodes.csv', [...NODE_HEADER], nodeCsvRows(graph));
}

export function registerTopologyRoutes(router: Router): void {
  /**
   * GET /api/topology/export?part=nodes|edges — CSV of reported graph facts.
   * Optional q / plane / ghosts / type match the screen filter. Must stay
   * ahead of any future /topology/:param route.
   */
  router.get('/topology/export', (req, res) => {
    settle(res, serveTopologyExport(req, res));
  });

  router.get('/topology', (_req, res) => {
    settle(res, serveTopology(res));
  });
}
