/**
 * server/tests/topologyGraph.test.ts — the estate-level cross-plane topology
 * graph (shared/topologyGraph.ts) and its /api/topology payload.
 *
 * Unit coverage pins the honest-edge rules: devices deduped across planes by
 * serial/MAC/name with badges unioned, every edge tracing to a report (none
 * invented), ghosts for neighbours that resolve to nothing (never promoted,
 * deduped on their own keys), multi-plane adjacencies merging into one edge
 * with multi-source provenance, parallel links on distinct ports staying
 * distinct, staleness following the worst source, and refused reports worded
 * in `omissions` rather than dropped.
 *
 * The demo assembly is pinned byte-for-byte: the campus interconnect reads
 * LOCAL + MIST off the fixture rows, the 2 × 10G DC1 handoff stays two edges,
 * and the whole graph is identical on every build. The route test serves the
 * in-process app on an ephemeral port (same harness as mistApRoutes.test.ts):
 * HPE_SETTINGS_PATH/HPE_DATA_DIR point at a tmp dir so nothing touches the
 * real data/ files.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildDemoTopologyGraph,
  buildTopologyGraph,
  demoTopologyReports,
  type TopologyDeviceInput,
  type TopologyEdgeReportInput,
  type TopologyGraph,
  type TopologyGraphEdge,
} from '@hpe/shared';

// ---------------------------------------------------------------------------
// Builders' helpers
// ---------------------------------------------------------------------------

function device(over: Partial<TopologyDeviceInput> = {}): TopologyDeviceInput {
  return {
    name: 'sw-a',
    model: 'CX 6300',
    type: 'switch',
    plane: 'LOCAL',
    siteId: 'campus-01',
    siteName: 'Campus-01 HQ',
    state: 'up',
    tone: 'success',
    ...over,
  };
}

function report(over: Partial<TopologyEdgeReportInput> = {}): TopologyEdgeReportInput {
  return {
    plane: 'LOCAL',
    protocol: 'LLDP',
    from: { name: 'sw-a' },
    to: { name: 'sw-b' },
    ...over,
  };
}

function edgeBetween(graph: TopologyGraph, a: string, b: string): TopologyGraphEdge | undefined {
  return graph.edges.find((e) => {
    const na = graph.nodes.find((n) => n.id === e.from)?.name;
    const nb = graph.nodes.find((n) => n.id === e.to)?.name;
    return (na === a && nb === b) || (na === b && nb === a);
  });
}

// ---------------------------------------------------------------------------
// The merge
// ---------------------------------------------------------------------------

describe('buildTopologyGraph — device dedup across planes', () => {
  it('merges two rows for one serial into one node, badges unioned in order', () => {
    const graph = buildTopologyGraph(
      [device({ serial: 'SG123', plane: 'CENTRAL' }), device({ serial: 'sg123', plane: 'LOCAL', model: 'ignored' })],
      [],
    );
    expect(graph.nodes).toHaveLength(1);
    expect(graph.nodes[0]).toMatchObject({ serial: 'sg123', planes: ['CENTRAL', 'LOCAL'], ghost: false });
    // the first row's facts win fields both carry
    expect(graph.nodes[0]!.model).toBe('CX 6300');
  });

  it('joins a name-only row onto a serial-keyed one through the MAC', () => {
    const graph = buildTopologyGraph(
      [
        device({ name: 'sw-a', serial: 'SG123', mac: '3C:52:82:AA:BB:CC', plane: 'CENTRAL' }),
        device({ name: 'SW-A', mac: '3c5282aabbcc', plane: 'MIST' }),
      ],
      [],
    );
    expect(graph.nodes).toHaveLength(1);
    expect(graph.nodes[0]!.planes).toEqual(['CENTRAL', 'MIST']);
  });

  it('honours claimedBy when it is the wider badge set', () => {
    const graph = buildTopologyGraph(
      [device({ serial: 'S1', plane: 'CENTRAL', claimedBy: ['CENTRAL', 'LOCAL'] })],
      [],
    );
    expect(graph.nodes[0]!.planes).toEqual(['CENTRAL', 'LOCAL']);
  });
});

describe('buildTopologyGraph — edges and provenance', () => {
  const devices = [
    device({ name: 'sw-a', serial: 'SA' }),
    device({ name: 'sw-b', serial: 'SB', siteId: 'campus-02', siteName: 'Campus-02 Research' }),
  ];

  it('invents nothing: devices without reports produce zero edges', () => {
    const graph = buildTopologyGraph(devices, []);
    expect(graph.nodes).toHaveLength(2);
    expect(graph.edges).toHaveLength(0);
  });

  it('resolves report endpoints to managed devices — no ghost for a managed neighbour', () => {
    const graph = buildTopologyGraph(devices, [report({ from: { name: 'SW-A' }, to: { name: 'sw-b', serial: 'sb' } })]);
    expect(graph.nodes).toHaveLength(2);
    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0]!.crossSite).toBe(true);
  });

  it('merges two planes reporting one adjacency into one edge with both badges', () => {
    const graph = buildTopologyGraph(devices, [
      report({ plane: 'LOCAL', protocol: 'LLDP', from: { name: 'sw-a', port: '1/1/49' }, to: { name: 'sw-b', port: 'xe-0/1/0' } }),
      report({ plane: 'MIST', protocol: 'LLDP', from: { name: 'sw-b', port: 'xe-0/1/0' }, to: { name: 'sw-a', port: '1/1/49' } }),
    ]);
    expect(graph.edges).toHaveLength(1);
    const edge = graph.edges[0]!;
    expect(edge.provenance.map((p) => p.plane)).toEqual(['LOCAL', 'MIST']);
    expect(edge.protocols).toEqual(['LLDP']);
    expect(edge.fromPort).toBe('1/1/49');
    expect(edge.toPort).toBe('xe-0/1/0');
  });

  it('keeps parallel links on distinct port pairs as distinct edges', () => {
    const graph = buildTopologyGraph(devices, [
      report({ from: { name: 'sw-a', port: '1/1/1' }, to: { name: 'sw-b', port: '1/1/1' } }),
      report({ from: { name: 'sw-a', port: '1/1/2' }, to: { name: 'sw-b', port: '1/1/2' } }),
    ]);
    expect(graph.edges).toHaveLength(2);
  });

  it('joins a portless record to the ONE ported link it can only be — never across parallel links', () => {
    // one link: the recorded uplink and the LLDP report are the same adjacency
    const single = buildTopologyGraph(devices, [
      report({ plane: null, protocol: 'recorded uplink', from: { name: 'sw-a' }, to: { name: 'sw-b' } }),
      report({ plane: 'MIST', protocol: 'LLDP', from: { name: 'sw-b', port: 'ge-0/0/6' }, to: { name: 'sw-a', port: 'eth0' } }),
    ]);
    expect(single.edges).toHaveLength(1);
    expect(single.edges[0]!.provenance.map((p) => p.plane)).toEqual([null, 'MIST']);
    // the ported report fills the ports, on the end each belongs to
    expect(single.edges[0]!.fromPort).toBe('eth0');
    expect(single.edges[0]!.toPort).toBe('ge-0/0/6');
    // two parallel ported links: a portless report cannot be told apart, so it
    // starts its own edge rather than being pinned to a guessed jack
    const parallel = buildTopologyGraph(devices, [
      report({ from: { name: 'sw-a', port: '1/1/1' }, to: { name: 'sw-b', port: '1/1/1' } }),
      report({ from: { name: 'sw-a', port: '1/1/2' }, to: { name: 'sw-b', port: '1/1/2' } }),
      report({ plane: null, protocol: 'recorded uplink', from: { name: 'sw-a' }, to: { name: 'sw-b' } }),
      report({ plane: null, protocol: 'recorded uplink', from: { name: 'sw-a' }, to: { name: 'sw-b' } }),
    ]);
    expect(parallel.edges).toHaveLength(3); // the repeated record merges, not forks
    expect(parallel.edges.filter((e) => e.fromPort === null)).toHaveLength(1);
  });

  it('does not repeat the same report seen twice (two chains naming one pair)', () => {
    const same = report({ plane: null, protocol: 'recorded uplink' });
    const graph = buildTopologyGraph(devices, [same, { ...same }]);
    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0]!.provenance).toHaveLength(1);
    expect(edgeBetween(graph, 'sw-a', 'sw-b')!.provenance[0]!.plane).toBeNull();
  });

  it('marks an edge stale only when EVERY source is stale', () => {
    const allStale = buildTopologyGraph(devices, [
      report({ plane: 'CLASSIC', protocol: 'CDP', stale: true }),
      report({ plane: 'LOCAL', protocol: 'LLDP', stale: true }),
    ]);
    expect(allStale.edges[0]!.stale).toBe(true);
    const oneFresh = buildTopologyGraph(devices, [
      report({ plane: 'CLASSIC', protocol: 'CDP', stale: true }),
      report({ plane: 'LOCAL', protocol: 'LLDP' }),
    ]);
    expect(oneFresh.edges[0]!.stale).toBe(false);
    expect(oneFresh.edges[0]!.protocols).toEqual(['CDP', 'LLDP']);
  });

  it('carries the newest report stamp across the provenance', () => {
    const graph = buildTopologyGraph(devices, [
      report({ plane: 'LOCAL', reportedAt: '2026-07-26T10:00:00.000Z' }),
      report({ plane: 'MIST', reportedAt: '2026-07-26T11:00:00.000Z' }),
    ]);
    expect(graph.edges[0]!.reportedAt).toBe('2026-07-26T11:00:00.000Z');
  });

  it('refuses self-links and content-free reports, and says so in omissions', () => {
    const graph = buildTopologyGraph(devices, [
      report({ from: { name: 'sw-a' }, to: { name: 'sw-a', serial: 'sa' } }),
      report({ from: { name: 'sw-a' }, to: { name: '  ' } }),
    ]);
    expect(graph.edges).toHaveLength(0);
    expect(graph.omissions).toHaveLength(2);
    expect(graph.omissions[0]).toContain('own neighbour');
    expect(graph.omissions[1]).toContain('no usable system name');
  });
});

describe('buildTopologyGraph — ghosts', () => {
  const devices = [device({ name: 'ap-1', serial: 'AP1' })];

  it('draws an unresolvable neighbour as a ghost — reported, never promoted', () => {
    const graph = buildTopologyGraph(devices, [
      report({ from: { name: 'ap-1' }, to: { name: 'isp-cpe', port: 'gi0/0' } }),
    ]);
    const ghost = graph.nodes.find((n) => n.name === 'isp-cpe');
    expect(ghost).toMatchObject({ ghost: true, siteId: null, state: null, type: null, planes: ['LOCAL'] });
    expect(graph.edges).toHaveLength(1);
  });

  it('dedupes two reports of one neighbour onto ONE ghost, adopting the stronger key', () => {
    const graph = buildTopologyGraph(devices, [
      report({ plane: null, protocol: 'recorded uplink', from: { name: 'ap-1' }, to: { name: 'sw-upstairs' } }),
      report({ plane: 'MIST', protocol: 'LLDP', from: { name: 'ap-1' }, to: { name: 'SW-Upstairs', mac: '3c:52:82:c0:11:01' } }),
    ]);
    const ghosts = graph.nodes.filter((n) => n.ghost);
    expect(ghosts).toHaveLength(1);
    expect(ghosts[0]).toMatchObject({ mac: '3c5282c01101', planes: ['MIST'] });
    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0]!.provenance).toHaveLength(2);
  });

  it('a ghost-to-ghost edge is real too (the far end of a far end)', () => {
    const graph = buildTopologyGraph(devices, [
      report({ from: { name: 'sw-unmanaged' }, to: { name: 'isp-cpe' } }),
    ]);
    expect(graph.nodes.filter((n) => n.ghost)).toHaveLength(2);
    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0]!.crossSite).toBe(false);
  });
});

describe('buildTopologyGraph — site roll-ups', () => {
  it('counts internal and inter-site edges per site and rolls the worst tone up', () => {
    const graph = buildTopologyGraph(
      [
        device({ name: 'sw-a', tone: 'success' }),
        device({ name: 'sw-b', tone: 'danger' }),
        device({ name: 'sw-c', siteId: 'campus-02', siteName: 'Campus-02 Research' }),
      ],
      [report({}), report({ from: { name: 'sw-a' }, to: { name: 'sw-c' } })],
      [
        { id: 'campus-01', name: 'Campus-01 HQ', planes: [{ name: 'LOCAL', tone: 'neutral' }] },
        { id: 'campus-02', name: 'Campus-02 Research', planes: [{ name: 'MIST', tone: 'info' }] },
        { id: 'southpoint', name: 'Southpoint Clinic', planes: [{ name: 'MIST', tone: 'info' }] },
      ],
    );
    const campus01 = graph.sites.find((s) => s.siteId === 'campus-01')!;
    expect(campus01).toMatchObject({ nodeCount: 2, internalEdges: 1, externalEdges: 1, tone: 'danger' });
    const campus02 = graph.sites.find((s) => s.siteId === 'campus-02')!;
    expect(campus02).toMatchObject({ nodeCount: 1, internalEdges: 0, externalEdges: 1 });
    // a site with no nodes still appears — the estate picture stays complete
    const southpoint = graph.sites.find((s) => s.siteId === 'southpoint')!;
    expect(southpoint).toMatchObject({ nodeCount: 0, internalEdges: 0, externalEdges: 0, tone: 'neutral' });
  });
});

// ---------------------------------------------------------------------------
// The demo estate's graph
// ---------------------------------------------------------------------------

describe('buildDemoTopologyGraph — the authored estate story', () => {
  const graph = buildDemoTopologyGraph();

  it('is byte-identical on every build (fixed stamps, deterministic merge)', () => {
    expect(buildDemoTopologyGraph()).toEqual(graph);
  });

  it('reads the Campus-01 ↔ Campus-02 interconnect off BOTH planes', () => {
    const edge = edgeBetween(graph, 'sw-core-a', 'sw-cam02-1');
    expect(edge).toBeDefined();
    expect(edge!.crossSite).toBe(true);
    expect(edge!.provenance.map((p) => p.plane)).toEqual(['LOCAL', 'MIST']);
    expect(edge!.speedBps).toBe(10_000_000_000);
  });

  it('keeps the 2 × 10G DC1 handoff as two parallel edges', () => {
    const parallel = graph.edges.filter((e) => {
      const names = [e.from, e.to].map((id) => graph.nodes.find((n) => n.id === id)?.name);
      return names.includes('gw-edge-1') && names.includes('sw-wh1-1');
    });
    expect(parallel).toHaveLength(2);
    expect(new Set(parallel.map((e) => `${e.fromPort}→${e.toPort}`)).size).toBe(2);
  });

  it('one ghost for sw-ng-1, carrying its recorded uplink AND its Mist report', () => {
    const ghosts = graph.nodes.filter((n) => n.ghost && n.name === 'sw-ng-1');
    expect(ghosts).toHaveLength(1);
    const uplink = edgeBetween(graph, 'ap-ng-02', 'sw-ng-1');
    expect(uplink!.provenance.map((p) => p.plane)).toEqual([null, 'MIST']);
    expect(uplink!.protocols).toEqual(['recorded uplink', 'LLDP']);
  });

  it('marks Riverside’s Classic-reported ISP handoff stale — Classic is 6h behind', () => {
    const edge = edgeBetween(graph, 'sw-riv-1', 'isp-cpe-riv');
    expect(edge).toBeDefined();
    expect(edge!.stale).toBe(true);
    expect(edge!.provenance[0]).toMatchObject({ plane: 'CLASSIC', protocol: 'CDP', stale: true });
  });

  it('keeps the VSF stack link to the member that never rejoined', () => {
    const edge = edgeBetween(graph, 'sw-wh1-1', 'sw-wh1-3');
    expect(edge).toBeDefined();
    expect(edge!.protocols).toEqual(['VSF']);
    expect(graph.nodes.find((n) => n.name === 'sw-wh1-3')).toMatchObject({ state: 'missing', ghost: false });
  });

  it('every edge carries at least one provenance entry — nothing invented', () => {
    expect(graph.edges.length).toBeGreaterThan(0);
    expect(graph.edges.every((e) => e.provenance.length > 0)).toBe(true);
  });

  it('words the recorded uplinks it refused (the ap-3f-12/14 campus filing clash)', () => {
    expect(graph.omissions.some((o) => o.includes('ap-3f-12') && o.includes('not drawn'))).toBe(true);
    expect(graph.omissions.some((o) => o.includes('ap-3f-14'))).toBe(true);
    // and no drawn edge contradicts the filing either
    expect(edgeBetween(graph, 'ap-3f-12', 'sw-acc-3f-2')).toBeUndefined();
  });

  it('files cppm-01 nowhere — a managed device with no physical site', () => {
    const cppm = graph.nodes.find((n) => n.name === 'cppm-01');
    expect(cppm).toMatchObject({ ghost: false, siteId: 'core-services' });
    expect(graph.sites.some((s) => s.siteId === 'core-services')).toBe(false);
  });

  it('reports only what the fixtures carry (the demo report assembly)', () => {
    const { reports, omissions } = demoTopologyReports();
    // 5 drawable recorded uplinks + 3 Mist LLDP rows + 11 authored plane reports
    expect(reports).toHaveLength(5 + 3 + 11);
    expect(omissions).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// The route
// ---------------------------------------------------------------------------

let server: Server;
let base: string;
let tmpDir: string;

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'hpe-topology-routes-'));
  process.env.HPE_SETTINGS_PATH = join(tmpDir, 'settings.json');
  process.env.HPE_DATA_DIR = join(tmpDir, 'data');
  process.env.HPE_CREDENTIAL_INDEX_WAIT_MS = '0';
  const { createApp } = await import('../src/index');
  server = createApp().listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.HPE_SETTINGS_PATH;
  delete process.env.HPE_DATA_DIR;
  delete process.env.HPE_CREDENTIAL_INDEX_WAIT_MS;
});

async function getJson(path: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${path}`);
  return { status: res.status, body: await res.json() };
}

describe('GET /api/topology (demo mode)', () => {
  it('serves the demo estate graph in the standard envelope', async () => {
    const { status, body } = await getJson('/api/topology');
    expect(status).toBe(200);
    expect(body.dataSource).toBe('demo');
    expect(body.syncedAt).toBeTruthy();
    expect(Array.isArray(body.notes)).toBe(true);
    expect(body.notes.length).toBeGreaterThan(0);
    expect(body.graph.nodes.length).toBeGreaterThan(0);
    expect(body.graph.edges.length).toBeGreaterThan(0);
    expect(body.graph.sites.some((s: any) => s.siteId === 'campus-01')).toBe(true);
    // the multi-source story survives the wire
    const interconnect = body.graph.edges.find((e: any) =>
      e.provenance.some((p: any) => p.plane === 'LOCAL') && e.provenance.some((p: any) => p.plane === 'MIST'),
    );
    expect(interconnect).toBeDefined();
    expect(interconnect.crossSite).toBe(true);
  });

  it('is deterministic — two reads are the same payload apart from the stamp', async () => {
    const [a, b] = await Promise.all([getJson('/api/topology'), getJson('/api/topology')]);
    expect({ ...a.body, syncedAt: null }).toEqual({ ...b.body, syncedAt: null });
  });
});
