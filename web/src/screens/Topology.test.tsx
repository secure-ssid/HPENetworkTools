/**
 * web/src/screens/Topology.test.tsx — the estate-level topology screen.
 *
 * The api getter is mocked (the payload is the shared demo assembly, so the
 * screen renders exactly what the demo route serves). Coverage: the collapsed
 * estate view (one card per site, inter-site hairline labels with multi-plane
 * provenance, the ghost strip), per-site collapse/expand, click-through to
 * /sites/:siteId and /devices/:name (with the identity query pair), the focus
 * idiom shared with SiteTopology (shift+click isolates, Esc restores), and
 * the API-failure state.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { buildDemoTopologyGraph, demoTopologyNotes } from '@hpe/shared';
import Topology from './Topology';
import { SettingsProvider } from '../app/SettingsContext';
import { ToastProvider } from '../nightdesk';
import { getTopology } from '../api/client';
import type { TopologyData } from '../api/client';

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

vi.mock('../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/client')>();
  return { ...actual, getTopology: vi.fn() };
});

const mockGetTopology = vi.mocked(getTopology);

function demoPayload(): TopologyData {
  return {
    dataSource: 'demo',
    syncedAt: '2026-07-26T11:59:00.000Z',
    graph: buildDemoTopologyGraph(),
    notes: demoTopologyNotes(),
  };
}

function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="loc">{`${loc.pathname}${loc.search}`}</div>;
}

function renderTopology() {
  return render(
    <MemoryRouter initialEntries={['/topology']} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <ToastProvider>
        <SettingsProvider>
          <Routes>
            <Route path="/topology" element={<Topology />} />
            <Route path="*" element={<LocationProbe />} />
          </Routes>
        </SettingsProvider>
      </ToastProvider>
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('Topology — the collapsed estate view', () => {
  it('renders one card per site, collapsed, with the estate stats', async () => {
    mockGetTopology.mockResolvedValue(demoPayload());
    renderTopology();

    expect(await screen.findByRole('button', { name: 'Expand Campus-01 — Meridian HQ' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Expand Lakeshore Medical Center' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Expand Warehouse-DC1' })).toBeTruthy();
    // the stats band counts what the graph carries
    expect(screen.getByText('Reported links')).toBeTruthy();
    expect(screen.getByText('Cross-site links')).toBeTruthy();
    expect(screen.getByText('Neighbours filed nowhere')).toBeTruthy();
    // collapsed cards do not leak their devices
    expect(screen.queryByRole('button', { name: 'Open device sw-core-a' })).toBeNull();
  });

  it('words the inter-site edges with their multi-plane provenance', async () => {
    mockGetTopology.mockResolvedValue(demoPayload());
    renderTopology();

    // the Campus-01 ↔ Campus-02 interconnect, read by BOTH ends' planes
    expect(
      await screen.findByText('sw-core-a 1/1/49 ↔ sw-cam02-1 xe-0/1/0 · 10.0 Gbps · LLDP · LOCAL + MIST'),
    ).toBeTruthy();
    // the recorded uplink and the Mist LLDP report of sw-ng-1 merged onto one edge
    expect(
      screen.getByText('ap-ng-02 eth0 ↔ sw-ng-1 ge-0/0/6 · 1.0 Gbps · recorded uplink + LLDP · portal records + MIST'),
    ).toBeTruthy();
    // Riverside's Classic-reported handoff says it is stale
    expect(screen.getByText(/sw-riv-1 1\/1\/52 ↔ isp-cpe-riv gi0\/0 · 1\.0 Gbps · CDP · CLASSIC · stale/)).toBeTruthy();
  });

  it('draws the ghost strip: reported neighbours that resolve to nothing', async () => {
    mockGetTopology.mockResolvedValue(demoPayload());
    renderTopology();

    expect(await screen.findByText(/REPORTED, FILED NOWHERE/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Focus broadband-cpe-ng/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Focus isp-cpe-riv/ })).toBeTruthy();
    // a ghost is never promoted: no Open-device affordance, no invented state
    expect(screen.queryByRole('button', { name: /Open device broadband-cpe-ng/ })).toBeNull();
    // the omissions alert words the refused recorded uplinks
    expect(screen.getByText(/recorded uplink ap-3f-12 → sw-acc-3f-2 .* not drawn/)).toBeTruthy();
  });
});

describe('Topology — collapse/expand and navigation', () => {
  it('opens a site card to its devices and its internal reported links', async () => {
    mockGetTopology.mockResolvedValue(demoPayload());
    renderTopology();

    fireEvent.click(await screen.findByRole('button', { name: 'Expand Warehouse-DC1' }));
    expect(await screen.findByRole('button', { name: 'Open device sw-wh1-1' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Open device sw-wh1-3, missing/ })).toBeTruthy();
    expect(screen.getByText('REPORTED LINKS INSIDE')).toBeTruthy();
    expect(screen.getByText(/sw-wh1-1 1\/1\/27 ↔ sw-wh1-3 1\/1\/27 · VSF · LOCAL/)).toBeTruthy();

    // and collapses again
    fireEvent.click(screen.getByRole('button', { name: 'Collapse Warehouse-DC1' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Open device sw-wh1-1' })).toBeNull());
  });

  it('clicks a device through to its page with the identity pair', async () => {
    mockGetTopology.mockResolvedValue(demoPayload());
    renderTopology();

    fireEvent.click(await screen.findByRole('button', { name: 'Expand Campus-01 — Meridian HQ' }));
    fireEvent.click(await screen.findByRole('button', { name: /Open device sw-core-a/ }));
    expect((await screen.findByTestId('loc')).textContent).toBe('/devices/sw-core-a?plane=LOCAL');
  });

  it('clicks a site through to its own page', async () => {
    mockGetTopology.mockResolvedValue(demoPayload());
    renderTopology();

    fireEvent.click(await screen.findByRole('button', { name: 'Expand Lakeshore Medical Center' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Open site' }));
    expect((await screen.findByTestId('loc')).textContent).toBe('/sites/lakeshore');
  });
});

describe('Topology — focus mode', () => {
  it('shift+click isolates a site with its neighbours; Esc restores', async () => {
    mockGetTopology.mockResolvedValue(demoPayload());
    renderTopology();

    fireEvent.click(await screen.findByRole('button', { name: 'Expand Campus-01 — Meridian HQ' }), {
      shiftKey: true,
    });
    expect(await screen.findByText('focus')).toBeTruthy();
    expect(screen.getByText(/Campus-01 — Meridian HQ · .* in view/)).toBeTruthy();
    // every other site card now offers to MOVE the focus, not to expand
    expect(screen.getAllByRole('button', { name: /^Focus / }).length).toBeGreaterThan(3);

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByText('focus')).toBeNull());
  });

  it('plain-clicking a ghost focuses it (it has no page to open)', async () => {
    mockGetTopology.mockResolvedValue(demoPayload());
    renderTopology();

    fireEvent.click(await screen.findByRole('button', { name: /Focus broadband-cpe-ng/ }));
    expect(await screen.findByText(/broadband-cpe-ng · .* in view/)).toBeTruthy();
    // the exit chip restores the full graph
    fireEvent.click(screen.getByRole('button', { name: 'Exit focus' }));
    await waitFor(() => expect(screen.queryByText('focus')).toBeNull());
  });
});

describe('Topology — failure and provenance states', () => {
  it('renders the API error instead of a substituted graph', async () => {
    mockGetTopology.mockResolvedValue({
      dataSource: 'live',
      syncedAt: null,
      apiError: 'HTTP 500',
      graph: { nodes: [], edges: [], sites: [], omissions: [] },
      notes: [],
    });
    renderTopology();
    expect(await screen.findByText('HTTP 500')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Expand Campus-01/ })).toBeNull();
  });

  it('stamps the footer with the payload source', async () => {
    mockGetTopology.mockResolvedValue(demoPayload());
    renderTopology();
    expect(await screen.findByText(/nodes · \d+ reported links · DEMO FIXTURE/)).toBeTruthy();
  });
});
