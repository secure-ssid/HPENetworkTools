/**
 * web/src/screens/SiteTopologyDiagram.test.tsx — the diagram's focus mode.
 *
 * Focus mode isolates one node with its 1-hop neighbours: entered by
 * shift+click on any card (or a plain click on a card with no other action),
 * moved by clicking another card while active, and left via the exit chip,
 * Esc, or a click on the diagram background. A plain click keeps its existing
 * meaning — device cards navigate, group chips expand — while no focus is
 * active, so the feature costs the existing pointer patterns nothing.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { SiteTopology, SiteTopologyLive, TopologyDeviceNode, TopologyLink } from '@hpe/shared';
import { SiteTopologyDiagram, buildLiveSiteTopology } from './SiteTopology';

if (!window.matchMedia) {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
}

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

function link(from: string, to: string): TopologyLink {
  return {
    from,
    to,
    fromPorts: [{ name: '1/1/1' }],
    toPorts: [{ name: 'eth0' }],
    speedBps: 1_000_000_000,
    health: 'Good',
  } as TopologyLink;
}

/** core-1 — access-1 — ap-1, with an unmanaged neighbour off access-1. */
const TOPOLOGY: SiteTopologyLive = {
  siteId: 'site-a',
  nodes: [
    node('SW1', 'core-1', 'Switch'),
    node('SW2', 'access-1', 'Switch'),
    node('AP1', 'ap-1', 'Access Point'),
    { ...node('U1', 'printer-9', 'Unmanaged'), health: null },
  ],
  links: [link('SW1', 'SW2'), link('SW2', 'AP1'), link('SW2', 'U1')],
  source: { plane: 'central', at: '2026-07-28T00:00:00.000Z', sections: { nodes: 'ok', links: 'ok' }, cached: false },
} as SiteTopologyLive;

function renderDiagram(onDevice = vi.fn()) {
  const devices = [
    { name: 'core-1' },
    { name: 'access-1' },
    { name: 'ap-1' },
  ] as never[];
  const diagram = buildLiveSiteTopology(TOPOLOGY, devices);
  const utils = render(<SiteTopologyDiagram topology={diagram} onDevice={onDevice} />);
  return { onDevice, ...utils };
}

function cardOpacity(name: RegExp): string {
  return (screen.getByRole('button', { name }) as HTMLButtonElement).style.opacity;
}

function lineOpacities(container: HTMLElement): string[] {
  return [...container.querySelectorAll('line')].map((l) => l.getAttribute('stroke-opacity') ?? '1');
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('SiteTopologyDiagram — entering focus', () => {
  it('shift+click isolates the node with its 1-hop neighbours and dims everything else', () => {
    const { container } = renderDiagram();
    fireEvent.click(screen.getByRole('button', { name: /Open device access-1/ }), { shiftKey: true });

    // The chip names the focus and the hop count; core-1, ap-1 and printer-9
    // are all one hop off access-1, so nothing outside the hop stays lit.
    expect(screen.getByText(/access-1 · 3 neighbours in view/)).toBeTruthy();
    expect(cardOpacity(/Focus access-1/)).toBe('1');
    expect(cardOpacity(/Focus core-1/)).toBe('1');
    expect(cardOpacity(/Focus ap-1/)).toBe('1');

    // Every edge here touches access-1, so all three stay lit; dimming shows
    // when an edge does not reach the focus — see the core-1 focus below.
    expect(lineOpacities(container)).toEqual(['1', '1', '1']);
  });

  it('dims the edges that do not reach the focused node', () => {
    const { container } = renderDiagram();
    fireEvent.click(screen.getByRole('button', { name: /Open device core-1/ }), { shiftKey: true });

    expect(screen.getByText(/core-1 · 1 neighbour in view/)).toBeTruthy();
    // Only core-1 — access-1 is lit; the access-1 descendants dim.
    expect(cardOpacity(/Focus access-1/)).toBe('1');
    expect(cardOpacity(/Focus ap-1/)).toBe('0.25');
    expect(cardOpacity(/Focus printer-9/)).toBe('0.25');
    // One lit edge, two dimmed.
    expect(lineOpacities(container).sort()).toEqual(['0.15', '0.15', '1']);
  });

  it('a plain click on a card with no other action focuses it', () => {
    renderDiagram();
    // printer-9 is an unmanaged neighbour: no device page, no group.
    fireEvent.click(screen.getByRole('button', { name: /Focus printer-9/ }));
    expect(screen.getByText(/printer-9 · 1 neighbour in view/)).toBeTruthy();
    expect(cardOpacity(/Focus core-1/)).toBe('0.25');
  });

  it('a plain click keeps navigating while no focus is active', () => {
    const onDevice = vi.fn();
    renderDiagram(onDevice);
    fireEvent.click(screen.getByRole('button', { name: /Open device ap-1/ }));
    expect(onDevice).toHaveBeenCalledWith('ap-1');
    expect(screen.queryByText(/neighbours? in view/)).toBeNull();
  });
});

describe('SiteTopologyDiagram — while focused', () => {
  it('a plain click moves the focus instead of navigating', () => {
    const onDevice = vi.fn();
    renderDiagram(onDevice);
    fireEvent.click(screen.getByRole('button', { name: /Open device core-1/ }), { shiftKey: true });
    fireEvent.click(screen.getByRole('button', { name: /Focus access-1/ }));
    expect(screen.getByText(/access-1 · 3 neighbours in view/)).toBeTruthy();
    expect(onDevice).not.toHaveBeenCalled();
  });

  it('the exit chip restores the full graph', () => {
    renderDiagram();
    fireEvent.click(screen.getByRole('button', { name: /Open device core-1/ }), { shiftKey: true });
    fireEvent.click(screen.getByRole('button', { name: 'Exit focus' }));
    expect(screen.queryByText(/neighbours? in view/)).toBeNull();
    // Nothing is dimmed any more, and the navigation labels are back.
    expect(cardOpacity(/Open device ap-1/)).toBe('1');
    expect(screen.getByRole('button', { name: /Open device core-1/ })).toBeTruthy();
  });

  it('Esc restores the full graph', () => {
    renderDiagram();
    fireEvent.click(screen.getByRole('button', { name: /Open device core-1/ }), { shiftKey: true });
    expect(screen.getByText(/core-1 · 1 neighbour in view/)).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByText(/neighbours? in view/)).toBeNull();
    expect(screen.getByRole('button', { name: /Open device core-1/ })).toBeTruthy();
  });

  it('a background click restores the full graph', () => {
    const { container } = renderDiagram();
    fireEvent.click(screen.getByRole('button', { name: /Open device core-1/ }), { shiftKey: true });
    expect(screen.getByText(/core-1 · 1 neighbour in view/)).toBeTruthy();
    const svg = container.querySelector('svg');
    if (!svg) throw new Error('svg missing');
    fireEvent.click(svg);
    expect(screen.queryByText(/neighbours? in view/)).toBeNull();
  });
});

describe('SiteTopologyDiagram — groups under focus', () => {
  it('an expanded group member focuses through its chip: the parent edge stays lit', () => {
    // Two APs sharing one parent collapse into a group chip — the recorded-
    // profile model's shape, built directly (the live builder draws one card
    // per node; the group collapse is the demo model's).
    const diagram: SiteTopology = {
      layers: ['access', 'edge'],
      nodes: [
        { id: 'dev:access-1', layer: 'access', label: 'access-1', sub: 'switch', state: 'up', tone: 'success', device: 'access-1', members: null },
        {
          id: 'grp:access-1:ap',
          layer: 'edge',
          label: '2 APs',
          sub: 'on access-1',
          state: 'up',
          tone: 'success',
          device: null,
          members: [
            { name: 'ap-1', state: 'up', tone: 'success' },
            { name: 'ap-2', state: 'up', tone: 'success' },
          ],
        },
      ],
      edges: [{ from: 'dev:access-1', to: 'grp:access-1:ap', label: null }],
      note: 'wiring from recorded uplink and chain data',
    };
    render(<SiteTopologyDiagram topology={diagram} onDevice={vi.fn()} />);

    // Expand the group, then shift+click a member: it focuses through the
    // chip, so the member and the parent switch stay lit and ap-2 dims.
    fireEvent.click(screen.getByRole('button', { name: /Expand 2 APs/ }));
    fireEvent.click(screen.getByRole('button', { name: /Open device ap-1/ }), { shiftKey: true });
    expect(screen.getByText(/ap-1 · 1 neighbour in view/)).toBeTruthy();
    expect(cardOpacity(/Focus ap-1/)).toBe('1');
    expect(cardOpacity(/Focus access-1/)).toBe('1');
    expect(cardOpacity(/Focus ap-2/)).toBe('0.25');
  });
});
