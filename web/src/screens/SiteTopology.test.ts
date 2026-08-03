/**
 * web/src/screens/SiteTopology.test.tsx — the live topology view-model builder.
 *
 * `buildLiveSiteTopology` turns a plane's undirected physical graph into the
 * layered diagram model. It is pure, exported, and until now untested, which
 * is a poor combination for the one function that decides what a site's
 * wiring LOOKS like — everything it leaves out leaves out silently, because
 * a diagram has no natural place to show an absence.
 */

import { describe, expect, it } from 'vitest';
import type { SiteTopologyLive, TopologyDeviceNode, TopologyLink } from '@hpe/shared';
import { buildLiveSiteTopology, liveTopologyLinkFact } from './SiteTopology';

function node(serial: string, name: string, type: string, deviceFunction = '-'): TopologyDeviceNode {
  return {
    serial,
    name,
    type,
    deviceFunction,
    status: 'ONLINE',
    health: 'Good',
    healthReason: null,
    model: null,
    ipv4: null,
    mac: null,
    internet: false,
  };
}

function link(from: string, to: string, over: Partial<TopologyLink> = {}): TopologyLink {
  return {
    from,
    to,
    fromPorts: [{ name: '1/1/1' }],
    toPorts: [{ name: 'eth0' }],
    speedBps: 1_000_000_000,
    health: 'Good',
    ...over,
  } as TopologyLink;
}

function live(over: Partial<SiteTopologyLive> = {}): SiteTopologyLive {
  return {
    siteId: 'site-a',
    nodes: [node('SW', 'core-1', 'Switch'), node('AP1', 'ap-1', 'Access Point')],
    links: [link('SW', 'AP1')],
    source: { plane: 'central', at: null, sections: { nodes: 'ok', links: 'ok' }, cached: false },
    ...over,
  } as SiteTopologyLive;
}

describe('buildLiveSiteTopology — what the diagram leaves out', () => {
  it('reports no omissions when every reported link and device is on the graph', () => {
    expect(buildLiveSiteTopology(live()).omissions).toEqual([]);
  });

  it('names the missing endpoint of a link it cannot draw', () => {
    const diagram = buildLiveSiteTopology(live({ links: [link('SW', 'AP1'), link('SW', 'GHOST')] }));
    // The edge is genuinely undrawable — there is no card to draw it to — so
    // the fix is to say so, not to invent a node for it.
    expect(diagram.edges).toHaveLength(1);
    expect(diagram.omissions).toHaveLength(1);
    expect(diagram.omissions?.[0]).toContain('1 reported link is not drawn');
    expect(diagram.omissions?.[0]).toContain('GHOST');
  });

  it('counts several undrawable links once and lists each missing end once', () => {
    const diagram = buildLiveSiteTopology(
      live({ links: [link('SW', 'GHOST'), link('AP1', 'GHOST'), link('SW', 'OTHER')] }),
    );
    expect(diagram.omissions?.[0]).toContain('3 reported links are not drawn');
    expect(diagram.omissions?.[0]).toContain('GHOST, OTHER');
    expect(diagram.omissions?.[0]).not.toContain('GHOST, GHOST');
  });

  it("passes on the plane's own count of devices it could not place", () => {
    const diagram = buildLiveSiteTopology(live({ isolatedDevicesCount: 4, isolatedHealth: 'Poor' }));
    expect(diagram.omissions).toHaveLength(1);
    expect(diagram.omissions?.[0]).toContain('could not place 4 devices on this graph');
    expect(diagram.omissions?.[0]).toContain('reported health poor');
    // The distinction the whole field exists to preserve.
    expect(diagram.omissions?.[0]).toContain('not a site with no such devices');
  });

  it('treats a zero isolated count as nothing to disclose, not as an unknown', () => {
    expect(buildLiveSiteTopology(live({ isolatedDevicesCount: 0 })).omissions).toEqual([]);
    expect(buildLiveSiteTopology(live({ isolatedDevicesCount: null })).omissions).toEqual([]);
  });

  it('carries both kinds of omission at once rather than reporting the first', () => {
    const diagram = buildLiveSiteTopology(
      live({ links: [link('SW', 'GHOST')], isolatedDevicesCount: 2 }),
    );
    expect(diagram.omissions).toHaveLength(2);
  });

  it('says nothing about health it was not given', () => {
    const diagram = buildLiveSiteTopology(live({ isolatedDevicesCount: 1, isolatedHealth: null }));
    expect(diagram.omissions?.[0]).toContain('could not place 1 device');
    expect(diagram.omissions?.[0]).not.toContain('reported health');
  });
});

describe('buildLiveSiteTopology — layout without inventing facts', () => {
  it('puts the best-connected switch on the core layer and the rest on access', () => {
    const diagram = buildLiveSiteTopology(
      live({
        nodes: [node('SW1', 'core-1', 'Switch'), node('SW2', 'edge-1', 'Switch'), node('AP1', 'ap-1', 'Access Point')],
        links: [link('SW1', 'AP1'), link('SW1', 'SW2')],
      }),
    );
    const byLabel = Object.fromEntries(diagram.nodes.map((n) => [n.label, n]));
    expect(byLabel['core-1'].layer).toBe('core');
    expect(byLabel['edge-1'].layer).toBe('access');
    expect(byLabel['ap-1'].layer).toBe('edge');
  });

  it('marks a node as clickable only when the site device list actually claims it', () => {
    const diagram = buildLiveSiteTopology(live(), [{ name: 'core-1' } as never]);
    const byLabel = Object.fromEntries(diagram.nodes.map((n) => [n.label, n]));
    // An unmanaged neighbour has no device page to open, so it must not offer
    // one — the plane supplied the name and nothing else.
    expect(byLabel['core-1'].device).toBe('core-1');
    expect(byLabel['ap-1'].device).toBeNull();
  });

  /* 'offline' is the same word for a switch that dropped four minutes ago and
     one unracked in March — an incident and a tidying job. Central sent the
     stamp that tells them apart and the diagram threw it away. */
  it('says how long a device the plane cannot see has been gone', () => {
    const now = Date.parse('2026-03-01T12:00:00.000Z');
    const diagram = buildLiveSiteTopology(
      live({
        nodes: [
          { ...node('SW', 'core-1', 'Switch'), status: 'OFFLINE', lastSeen: now - 4 * 3600_000 },
          { ...node('AP1', 'ap-1', 'Access Point'), status: 'UP', lastSeen: now - 4 * 3600_000 },
        ],
      }),
      [],
      now,
    );
    expect(diagram.nodes[0].state).toBe('offline · last seen 4h ago');
    // A device the plane still sees was last seen a moment ago — that is a
    // fact about the poll, not about the AP, and it earns no words.
    expect(diagram.nodes[1].state).toBe('up');
  });

  /* TopologyDeviceNode.lastSeen carries the warning in its own doc comment:
     zero and null both mean the plane sent no stamp, and neither may become
     1970. An invented 56-year outage is worse than no answer. */
  it('refuses to date an outage the plane put no stamp on', () => {
    const now = Date.parse('2026-03-01T12:00:00.000Z');
    const unusable = [0, null, undefined, Number.NaN, 8.64e15 * 2, now + 3 * 86_400_000];
    for (const lastSeen of unusable) {
      const diagram = buildLiveSiteTopology(
        live({ nodes: [{ ...node('SW', 'core-1', 'Switch'), status: 'DOWN', lastSeen }] }),
        [],
        now,
      );
      expect(diagram.nodes[0].state).toBe('down');
    }
  });

  /* A stamp a minute ahead is a third clock, not a missing one. `lastSeen` is
     the PLANE's epoch, read against the browser's clock, and the two are never
     synchronised — so a stamp slightly in the future is the plane saying "just
     now". Refusing it dropped the phrase from exactly the devices the plane
     had most recently seen, which is the wrong way round; the answer is only
     ever as precise as the drift, and at this granularity that is fine. */
  it('dates a device the plane stamped a moment into the future', () => {
    const now = Date.parse('2026-03-01T12:00:00.000Z');
    const diagram = buildLiveSiteTopology(
      live({ nodes: [{ ...node('SW', 'core-1', 'Switch'), status: 'DOWN', lastSeen: now + 60_000 }] }),
      [],
      now,
    );
    expect(diagram.nodes[0].state).toBe('down · last seen 1s ago');
  });

  /* Eight cluster members are drawn as eight cards, which reads as eight
     independent devices. It is one logical device, and the conductor is the
     one holding the running configuration — a change pushed at a member goes
     nowhere. Central sends both facts on adjacent adapter lines. */
  it('says which card is the conductor and which are its members', () => {
    const diagram = buildLiveSiteTopology(
      live({
        nodes: [
          { ...node('SW1', 'core-1', 'Switch'), deployment: 'Cluster', conductorSerial: 'SW1' },
          { ...node('SW2', 'core-2', 'Switch'), deployment: 'Cluster', conductorSerial: 'SW1' },
          // A conductor outside the drawn set stays visible as its serial
          // rather than being dropped for not having a card.
          { ...node('SW3', 'core-3', 'Switch'), deployment: 'Cluster', conductorSerial: 'SW9' },
        ],
      }),
      [],
    );
    expect(diagram.nodes[0].sub).toContain('conductor');
    expect(diagram.nodes[1].sub).toContain('member of core-1');
    expect(diagram.nodes[2].sub).toContain('member of SW9');
  });

  it('words a cluster the plane named without naming a conductor, and says nothing for a standalone', () => {
    const diagram = buildLiveSiteTopology(
      live({
        nodes: [
          { ...node('SW1', 'core-1', 'Switch'), deployment: 'Cluster' },
          { ...node('SW2', 'core-2', 'Switch'), deployment: 'Standalone' },
          node('SW3', 'core-3', 'Switch'),
        ],
      }),
      [],
    );
    expect(diagram.nodes[0].sub).toContain('cluster');
    // The ordinary case earns no words, the same rule the link facts follow.
    expect(diagram.nodes[1].sub).not.toContain('standalone');
    expect(diagram.nodes[2].sub).not.toContain('cluster');
  });

  it('leaves an unreported health neutral rather than reading it as good', () => {
    const diagram = buildLiveSiteTopology(
      live({ nodes: [{ ...node('SW', 'core-1', 'Switch'), health: null }] }),
    );
    expect(diagram.nodes[0].tone).toBe('neutral');
  });

  it('keeps link wording undirected and omits a speed it does not have', () => {
    expect(liveTopologyLinkFact(link('SW', 'AP1', { speedBps: null }))).toBe('1/1/1 ↔ eth0');
    expect(liveTopologyLinkFact(link('SW', 'AP1'), false)).toBe('eth0 ↔ 1/1/1 · 1.0 Gbps');
  });

  /* A blocked link is up, Good, at full speed and carrying nothing. Without
     this it is drawn as the identical twin of the link beside it that is
     doing all the work — and it is usually the answer to why. */
  it('says when STP has stopped a link carrying traffic', () => {
    expect(liveTopologyLinkFact(link('SW', 'AP1', { stpState: 'Blocking' }))).toBe(
      '1/1/1 ↔ eth0 · 1.0 Gbps · STP blocking',
    );
    // Forwarding is the ordinary case and earns no words.
    expect(liveTopologyLinkFact(link('SW', 'AP1', { stpState: 'Forwarding' }))).toBe('1/1/1 ↔ eth0 · 1.0 Gbps');
    // An unreported STP state is not a claim that the link forwards.
    expect(liveTopologyLinkFact(link('SW', 'AP1', { stpState: null }))).toBe('1/1/1 ↔ eth0 · 1.0 Gbps');
  });

  /* The diagram is read as what the plane can see. An edge somebody typed is
     an assertion, and a wrong one survives the recabling that would have
     removed a discovered edge. */
  it('marks an edge the plane was told about rather than found', () => {
    expect(liveTopologyLinkFact(link('SW', 'AP1', { edgeType: 'Manual' }))).toBe(
      '1/1/1 ↔ eth0 · 1.0 Gbps · added manually',
    );
    expect(liveTopologyLinkFact(link('SW', 'AP1', { edgeType: 'System' }))).toBe('1/1/1 ↔ eth0 · 1.0 Gbps');
  });

  /* A stacking cable looks exactly like an uplink on a diagram and is not one:
     it carries no user traffic, cannot be re-patched, and losing it splits a
     device rather than a path. */
  it('marks a stacking cable as one rather than drawing it as an uplink', () => {
    expect(liveTopologyLinkFact(link('SW1', 'SW2', { isSibling: true }))).toContain('stack link');
    expect(liveTopologyLinkFact(link('SW1', 'SW2', { isSibling: false }))).not.toContain('stack link');
    expect(liveTopologyLinkFact(link('SW1', 'SW2'))).not.toContain('stack link');
  });

  it('keeps every exception when a link has more than one', () => {
    expect(
      liveTopologyLinkFact(link('SW', 'AP1', { stpState: 'Discarding', edgeType: 'Manual', health: 'Fair' })),
    ).toBe('1/1/1 ↔ eth0 · 1.0 Gbps · STP discarding · added manually · link fair');
  });
});

describe('LLDP-derived edges (Mist AP stats uplinks)', () => {
  /* Mist's AP-stats edges carry edgeType 'LLDP': each is one AP's own report
     of its uplink neighbour, not a plane-observed full-graph adjacency. The
     word is the edge's evidence and rides verbatim; 'System' (observed) and
     'Manual' (asserted) keep their existing handling. */
  it('words the edge evidence verbatim', () => {
    expect(liveTopologyLinkFact(link('AP1', 'SW', { edgeType: 'LLDP' }))).toBe(
      '1/1/1 ↔ eth0 · 1.0 Gbps · LLDP',
    );
    expect(liveTopologyLinkFact(link('SW', 'AP1', { edgeType: 'System' }))).toBe('1/1/1 ↔ eth0 · 1.0 Gbps');
    expect(liveTopologyLinkFact(link('SW', 'AP1', { edgeType: 'Manual' }))).toContain('added manually');
  });

  it('an all-LLDP graph names its provenance in the note, not the full-graph claim', () => {
    const diagram = buildLiveSiteTopology(live({ links: [link('SW', 'AP1', { edgeType: 'LLDP' })] }));
    expect(diagram.note).toContain("one AP's own LLDP report");
    expect(diagram.note).toContain('not traffic direction');
    expect(diagram.note).not.toContain('reports these links as physical adjacency');
  });

  it('a graph with any non-LLDP edge keeps the default note', () => {
    const mixed = buildLiveSiteTopology(
      live({ links: [link('SW', 'AP1', { edgeType: 'LLDP' }), link('SW', 'AP1')] }),
    );
    expect(mixed.note).toContain('reports these links as physical adjacency');
    // …and so does a graph that never named its evidence.
    expect(buildLiveSiteTopology(live()).note).toContain('reports these links as physical adjacency');
  });
});

describe('edge enrichment — the carried port fields the label used to drop', () => {
  /* Central's topology links carry each member port's LAG name, but the label
     printed only the member names — a bundle read as two unrelated cables. */
  it('names the bundle when the plane says the member ports are one', () => {
    expect(
      liveTopologyLinkFact(
        link('SW', 'AP1', {
          fromPorts: [
            { name: '1/1/1', lag: 'Po2' },
            { name: '1/1/2', lag: 'Po2' },
          ],
        }),
      ),
    ).toBe('1/1/1+1/1/2 (Po2) ↔ eth0 · 1.0 Gbps');
    // No lag reported: the wording is exactly what it was.
    expect(liveTopologyLinkFact(link('SW', 'AP1'))).toBe('1/1/1 ↔ eth0 · 1.0 Gbps');
  });

  /* The link-level verdict can read 'Good' over a bundle whose second member
     is flapping; the carried port health was the only place that said so. */
  it('words a member port the plane scored as anything but good', () => {
    expect(
      liveTopologyLinkFact(link('SW', 'AP1', { toPorts: [{ name: '1/1/9', health: 'Poor' }] })),
    ).toBe('1/1/1 ↔ 1/1/9 · 1.0 Gbps · port 1/1/9 poor');
    // A 'Good' member is the ordinary case and earns no words.
    expect(
      liveTopologyLinkFact(link('SW', 'AP1', { toPorts: [{ name: '1/1/9', health: 'Good' }] })),
    ).toBe('1/1/1 ↔ 1/1/9 · 1.0 Gbps');
  });
});
