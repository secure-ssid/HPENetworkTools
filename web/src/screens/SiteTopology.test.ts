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
});
