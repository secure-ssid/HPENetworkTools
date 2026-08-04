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
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { buildDemoTopologyGraph, demoTopologyNotes } from '@hpe/shared';
import Topology, { filterTopologyGraph, focusFromParam, focusToParam } from './Topology';
import { SettingsProvider } from '../app/SettingsContext';
import { ToastProvider } from '../nightdesk';
import { getTopology } from '../api/client';
import type { TopologyData } from '../api/client';
import { downloadApiCsv } from '../lib/downloadApiCsv';

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

vi.mock('../lib/downloadApiCsv', () => ({
  downloadApiCsv: vi.fn(),
}));

/* jsdom has no WebGL — keep 3D mode from exploding when view=3d is selected. */
vi.mock('./Topology3DCanvas', () => ({
  Topology3DCanvas: () => <div data-testid="topo-3d-stub">3d stub</div>,
}));

const mockGetTopology = vi.mocked(getTopology);
const mockDownloadApiCsv = vi.mocked(downloadApiCsv);

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

    expect(await screen.findByRole('region', { name: 'Site connections' })).toBeTruthy();
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

describe('Topology filter helpers', () => {
  it('filterTopologyGraph keeps edges only when both ends remain', () => {
    const full = buildDemoTopologyGraph();
    const filtered = filterTopologyGraph(full, { q: 'Campus-01', plane: 'all', ghostsOnly: false });
    expect(filtered.sites.some((s) => /Campus-01/i.test(s.name))).toBe(true);
    const ids = new Set(filtered.nodes.map((n) => n.id));
    for (const e of filtered.edges) {
      expect(ids.has(e.from)).toBe(true);
      expect(ids.has(e.to)).toBe(true);
    }
  });

  it('filterTopologyGraph type= keeps only matching node classes (Loop 104)', () => {
    const full = buildDemoTopologyGraph();
    const typed = full.nodes.map((n) => (n.type ?? '').trim()).filter(Boolean);
    expect(typed.length).toBeGreaterThan(0);
    const sample = typed[0]!.toLowerCase();
    const filtered = filterTopologyGraph(full, {
      q: '',
      plane: 'all',
      ghostsOnly: false,
      type: sample,
    });
    expect(filtered.nodes.length).toBeGreaterThan(0);
    for (const n of filtered.nodes) {
      expect((n.type ?? '').trim().toLowerCase()).toBe(sample);
    }
    const ids = new Set(filtered.nodes.map((n) => n.id));
    for (const e of filtered.edges) {
      expect(ids.has(e.from)).toBe(true);
      expect(ids.has(e.to)).toBe(true);
    }
  });

  it('parses and serializes focus query params', () => {
    expect(focusFromParam('site:campus-01')).toEqual({ kind: 'site', id: 'campus-01' });
    expect(focusFromParam('node:sw-core-a')).toEqual({ kind: 'node', id: 'sw-core-a' });
    expect(focusFromParam('nope')).toBeNull();
    expect(focusToParam({ kind: 'site', id: 'x' })).toBe('site:x');
  });
});

describe('Topology filters + Copy view link', () => {
  it('filters by query and copies share params', async () => {
    mockGetTopology.mockResolvedValue(demoPayload());
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    render(
      <MemoryRouter
        initialEntries={['/topology?q=Campus-01&view=2d']}
        future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
      >
        <ToastProvider>
          <SettingsProvider>
            <Routes>
              <Route path="/topology" element={<Topology />} />
            </Routes>
          </SettingsProvider>
        </ToastProvider>
      </MemoryRouter>,
    );

    expect(await screen.findByRole('button', { name: /Expand Campus-01/ })).toBeTruthy();
    // Other campus cards drop out of the filtered graph.
    expect(screen.queryByRole('button', { name: /Expand Campus-02/ })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Copy view link' }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    const url = String(writeText.mock.calls[0]![0]);
    expect(url).toContain('q=Campus-01');
    expect(url).toContain('view=2d');
  });
});

/* Loop 72 — view mode always lives in the address bar (default + toggle). */
describe('Topology view=3d / view=2d param', () => {
  it('writes a default view param when the URL omits it', async () => {
    mockGetTopology.mockResolvedValue(demoPayload());
    render(
      <MemoryRouter
        initialEntries={['/topology']}
        future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
      >
        <ToastProvider>
          <SettingsProvider>
            <Routes>
              <Route
                path="/topology"
                element={
                  <>
                    <Topology />
                    <LocationProbe />
                  </>
                }
              />
            </Routes>
          </SettingsProvider>
        </ToastProvider>
      </MemoryRouter>,
    );

    await screen.findByRole('button', { name: /Expand Campus-01/ });
    await waitFor(() => {
      const loc = screen.getByTestId('loc').textContent ?? '';
      expect(loc === '/topology?view=2d' || loc === '/topology?view=3d').toBe(true);
    });
  });

  it('toggles view=3d and view=2d in the address bar', async () => {
    mockGetTopology.mockResolvedValue(demoPayload());
    render(
      <MemoryRouter
        initialEntries={['/topology?view=2d']}
        future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
      >
        <ToastProvider>
          <SettingsProvider>
            <Routes>
              <Route
                path="/topology"
                element={
                  <>
                    <Topology />
                    <LocationProbe />
                  </>
                }
              />
            </Routes>
          </SettingsProvider>
        </ToastProvider>
      </MemoryRouter>,
    );

    await screen.findByRole('button', { name: /Expand Campus-01/ });
    fireEvent.click(screen.getByRole('button', { name: '3D Graph' }));
    await waitFor(() => expect(screen.getByTestId('loc').textContent).toContain('view=3d'));
    expect(screen.getByTestId('topo-3d-stub')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '2D Cards' }));
    await waitFor(() => expect(screen.getByTestId('loc').textContent).toContain('view=2d'));
  });
});

describe('Topology estate server CSV', () => {
  it('offers Download server CSV (nodes/edges) only on live payloads', async () => {
    mockGetTopology.mockResolvedValue({
      ...demoPayload(),
      dataSource: 'live',
      syncedAt: '2026-07-26T11:59:00.000Z',
    });
    mockDownloadApiCsv.mockResolvedValue({ ok: true });
    renderTopology();

    fireEvent.click(await screen.findByRole('button', { name: 'Download server CSV (nodes)' }));
    await waitFor(() =>
      expect(mockDownloadApiCsv).toHaveBeenCalledWith(
        '/api/topology/export?part=nodes',
        'topology-nodes.csv',
      ),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Download server CSV (edges)' }));
    await waitFor(() =>
      expect(mockDownloadApiCsv).toHaveBeenCalledWith(
        '/api/topology/export?part=edges',
        'topology-edges.csv',
      ),
    );
  });

  it('passes active q/plane/ghosts filters into Download server CSV (Loop 80)', async () => {
    mockGetTopology.mockResolvedValue({
      ...demoPayload(),
      dataSource: 'live',
      syncedAt: '2026-07-26T11:59:00.000Z',
    });
    mockDownloadApiCsv.mockResolvedValue({ ok: true });
    render(
      <MemoryRouter
        initialEntries={['/topology?q=Campus-01&plane=MIST&ghosts=1&view=2d']}
        future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
      >
        <ToastProvider>
          <SettingsProvider>
            <Routes>
              <Route path="/topology" element={<Topology />} />
            </Routes>
          </SettingsProvider>
        </ToastProvider>
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Download server CSV (nodes)' }));
    await waitFor(() => {
      expect(mockDownloadApiCsv).toHaveBeenCalled();
      const path = String(mockDownloadApiCsv.mock.calls[0]![0]);
      expect(path.startsWith('/api/topology/export?')).toBe(true);
      const qs = new URLSearchParams(path.split('?')[1]);
      expect(qs.get('part')).toBe('nodes');
      expect(qs.get('q')).toBe('Campus-01');
      expect(qs.get('plane')).toBe('MIST');
      expect(qs.get('ghosts')).toBe('1');
    });
  });

  it('passes type= into share URL and Download server CSV (Loop 104)', async () => {
    mockGetTopology.mockResolvedValue({
      ...demoPayload(),
      dataSource: 'live',
      syncedAt: '2026-07-26T11:59:00.000Z',
    });
    mockDownloadApiCsv.mockResolvedValue({ ok: true });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    render(
      <MemoryRouter
        initialEntries={['/topology?type=ap&view=2d']}
        future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
      >
        <ToastProvider>
          <SettingsProvider>
            <Routes>
              <Route path="/topology" element={<Topology />} />
            </Routes>
          </SettingsProvider>
        </ToastProvider>
      </MemoryRouter>,
    );

    expect(await screen.findByLabelText('Device type filter')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Copy view link' }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(String(writeText.mock.calls[0]![0])).toMatch(/[?&]type=ap/);

    fireEvent.click(screen.getByRole('button', { name: 'Download server CSV (nodes)' }));
    await waitFor(() => {
      const path = String(mockDownloadApiCsv.mock.calls[0]![0]);
      const qs = new URLSearchParams(path.split('?')[1]);
      expect(qs.get('part')).toBe('nodes');
      expect(qs.get('type')).toBe('ap');
    });
  });

  it('keeps client Export CSV on demo and hides estate server downloads', async () => {
    mockGetTopology.mockResolvedValue(demoPayload());
    renderTopology();
    expect(await screen.findByRole('button', { name: 'Export CSV' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Download server CSV (nodes)' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Download server CSV (edges)' })).toBeNull();
  });
});

/* Loop 136 — Type chip row toggles the same type= filter as the Select. */
describe('Topology type chips (Loop 136)', () => {
  function renderTopologyAt(entry: string) {
    return render(
      <MemoryRouter
        initialEntries={[entry]}
        future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
      >
        <ToastProvider>
          <SettingsProvider>
            <Routes>
              <Route
                path="/topology"
                element={
                  <>
                    <Topology />
                    <LocationProbe />
                  </>
                }
              />
            </Routes>
          </SettingsProvider>
        </ToastProvider>
      </MemoryRouter>,
    );
  }

  it('type chips filter the graph and write type back to the URL', async () => {
    mockGetTopology.mockResolvedValue({
      ...demoPayload(),
      dataSource: 'live',
      syncedAt: '2026-07-26T11:59:00.000Z',
    });
    renderTopologyAt('/topology?view=2d');
    expect(await screen.findByRole('group', { name: 'Device type' })).toBeTruthy();
    const chips = screen.getByRole('group', { name: 'Device type' });
    const apChip = within(chips).getByRole('button', { name: /^ap/i });
    expect(apChip.getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(apChip);
    await waitFor(() => expect(screen.getByTestId('loc').textContent).toMatch(/[?&]type=ap/));
    expect(apChip.getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(apChip);
    await waitFor(() => expect(screen.getByTestId('loc').textContent).not.toMatch(/[?&]type=/));
    expect(apChip.getAttribute('aria-pressed')).toBe('false');
  });

  it('Clear filters also clears type=', async () => {
    mockGetTopology.mockResolvedValue({
      ...demoPayload(),
      dataSource: 'live',
      syncedAt: '2026-07-26T11:59:00.000Z',
    });
    renderTopologyAt('/topology?type=ap&view=2d');
    expect(await screen.findByRole('button', { name: 'Clear filters' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    await waitFor(() => expect(screen.getByTestId('loc').textContent).not.toMatch(/[?&]type=/));
  });
});

/* Loop 142 — Plane chip row toggles the same plane= filter as the Select. */
describe('Topology plane chips (Loop 142)', () => {
  function renderTopologyAt(entry: string) {
    return render(
      <MemoryRouter
        initialEntries={[entry]}
        future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
      >
        <ToastProvider>
          <SettingsProvider>
            <Routes>
              <Route
                path="/topology"
                element={
                  <>
                    <Topology />
                    <LocationProbe />
                  </>
                }
              />
            </Routes>
          </SettingsProvider>
        </ToastProvider>
      </MemoryRouter>,
    );
  }

  it('plane chips filter the graph and write plane back to the URL', async () => {
    mockGetTopology.mockResolvedValue({
      ...demoPayload(),
      dataSource: 'live',
      syncedAt: '2026-07-26T11:59:00.000Z',
    });
    renderTopologyAt('/topology?view=2d');
    const chips = await screen.findByRole('group', { name: 'Topology plane' });
    const buttons = within(chips).getAllByRole('button');
    expect(buttons.length).toBeGreaterThan(0);
    const planeChip = buttons[0]!;
    const label = planeChip.textContent ?? '';
    const planeKey = label.replace(/\d+$/, '').trim();
    expect(planeKey.length).toBeGreaterThan(0);
    expect(planeChip.getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(planeChip);
    await waitFor(() =>
      expect(screen.getByTestId('loc').textContent).toMatch(new RegExp(`[?&]plane=${planeKey}`)),
    );
    expect(planeChip.getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(planeChip);
    await waitFor(() => expect(screen.getByTestId('loc').textContent).not.toMatch(/[?&]plane=/));
    expect(planeChip.getAttribute('aria-pressed')).toBe('false');
  });

  it('Clear filters also clears plane=', async () => {
    mockGetTopology.mockResolvedValue({
      ...demoPayload(),
      dataSource: 'live',
      syncedAt: '2026-07-26T11:59:00.000Z',
    });
    renderTopologyAt('/topology?plane=CENTRAL&view=2d');
    expect(await screen.findByRole('button', { name: 'Clear filters' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    await waitFor(() => expect(screen.getByTestId('loc').textContent).not.toMatch(/[?&]plane=/));
  });
});

/* Loop 148 — Ghosts chip row toggles the same ghosts= filter as the Switch. */
describe('Topology ghosts chips (Loop 148)', () => {
  function renderTopologyAt(entry: string) {
    return render(
      <MemoryRouter
        initialEntries={[entry]}
        future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
      >
        <ToastProvider>
          <SettingsProvider>
            <Routes>
              <Route
                path="/topology"
                element={
                  <>
                    <Topology />
                    <LocationProbe />
                  </>
                }
              />
            </Routes>
          </SettingsProvider>
        </ToastProvider>
      </MemoryRouter>,
    );
  }

  it('ghosts chip filters the graph and writes ghosts=1 back to the URL', async () => {
    mockGetTopology.mockResolvedValue({
      ...demoPayload(),
      dataSource: 'live',
      syncedAt: '2026-07-26T11:59:00.000Z',
    });
    renderTopologyAt('/topology?view=2d');
    const chips = await screen.findByRole('group', { name: 'Topology ghosts' });
    const ghostChip = within(chips).getByRole('button', { name: /Ghosts/i });
    expect(ghostChip.getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(ghostChip);
    await waitFor(() => expect(screen.getByTestId('loc').textContent).toMatch(/[?&]ghosts=1/));
    expect(ghostChip.getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('switch', { name: /Ghosts only/i }).getAttribute('aria-checked')).toBe(
      'true',
    );

    fireEvent.click(ghostChip);
    await waitFor(() => expect(screen.getByTestId('loc').textContent).not.toMatch(/[?&]ghosts=/));
    expect(ghostChip.getAttribute('aria-pressed')).toBe('false');
  });

  it('Clear filters also clears ghosts=', async () => {
    mockGetTopology.mockResolvedValue({
      ...demoPayload(),
      dataSource: 'live',
      syncedAt: '2026-07-26T11:59:00.000Z',
    });
    renderTopologyAt('/topology?ghosts=1&view=2d');
    expect(await screen.findByRole('button', { name: 'Clear filters' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    await waitFor(() => expect(screen.getByTestId('loc').textContent).not.toMatch(/[?&]ghosts=/));
  });
});

/* Loop 163 — LIVE badge honesty (pure live + blend) + footer provenance. */
describe('Topology Loop 163 residuals', () => {
  it('stamps LIVE on pure live topology', async () => {
    mockGetTopology.mockResolvedValue({
      ...demoPayload(),
      dataSource: 'live',
      syncedAt: '2026-07-26T11:59:00.000Z',
    });
    renderTopology();
    expect(await screen.findByText('LIVE')).toBeTruthy();
    expect(screen.getByText(/LIVE · SYNCED /)).toBeTruthy();
  });

  it('stamps LIVE when topology arrives via blend', async () => {
    mockGetTopology.mockResolvedValue({
      ...demoPayload(),
      dataSource: 'demo',
      blended: ['topology'],
      syncedAt: '2026-07-26T11:59:00.000Z',
    });
    renderTopology();
    expect(await screen.findByText('LIVE')).toBeTruthy();
    expect(screen.getByText(/LIVE · SYNCED /)).toBeTruthy();
    expect(screen.queryByText(/DEMO FIXTURE/)).toBeNull();
  });

  it('hides LIVE on demo fixtures without blend', async () => {
    mockGetTopology.mockResolvedValue(demoPayload());
    renderTopology();
    expect(await screen.findByText(/nodes · \d+ reported links · DEMO FIXTURE/)).toBeTruthy();
    expect(screen.queryByText('LIVE')).toBeNull();
  });
});


/* Loop 186 — Topology nodes multi-select bulk bar. */
describe('Topology nodes bulk (Loop 186)', () => {
  function renderTopologyAt(entry: string) {
    return render(
      <MemoryRouter
        initialEntries={[entry]}
        future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
      >
        <ToastProvider>
          <SettingsProvider>
            <Routes>
              <Route
                path="/topology"
                element={
                  <>
                    <Topology />
                    <LocationProbe />
                  </>
                }
              />
            </Routes>
          </SettingsProvider>
        </ToastProvider>
      </MemoryRouter>,
    );
  }

  it('shows bulk bar for node selection: Export selected, Copy serials, Copy selection link, Clear', async () => {
    const createObjectURL = vi.fn(() => 'blob:topology-nodes-selected');
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    mockGetTopology.mockResolvedValue({
      ...demoPayload(),
      dataSource: 'live',
      syncedAt: '2026-07-26T11:59:00.000Z',
    });
    const { container } = renderTopologyAt('/topology?view=2d');
    expect(await screen.findByRole('grid', { name: 'Topology nodes' })).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Topology node selection actions' })).toBeNull();

    const table = screen.getByRole('grid', { name: 'Topology nodes' });
    const first = table.querySelector('tbody tr') as HTMLElement;
    expect(first).toBeTruthy();
    first.focus();
    fireEvent.keyDown(first, { key: 'x' });

    const bar = await screen.findByRole('region', { name: 'Topology node selection actions' });
    expect(within(bar).getByText('1 SELECTED')).toBeTruthy();
    fireEvent.click(within(bar).getByRole('button', { name: 'Export selected' }));
    expect(await screen.findByText(/Exported 1 selected node/)).toBeTruthy();
    expect(createObjectURL).toHaveBeenCalled();

    fireEvent.click(within(bar).getByRole('button', { name: 'Copy serials' }));
    /* First row may be a ghost without a serial — either path is honest. */
    await waitFor(() => {
      const copied = writeText.mock.calls.some((c) => String(c[0] ?? '').trim().length > 0);
      const noSerialToast = screen.queryByText(/No serials on the selected nodes/i);
      expect(copied || noSerialToast).toBeTruthy();
    });

    writeText.mockClear();
    fireEvent.click(within(bar).getByRole('button', { name: 'Copy selection link' }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(String(writeText.mock.calls[0]![0])).toMatch(/ids=/);

    fireEvent.click(within(bar).getByRole('button', { name: 'Clear' }));
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: 'Topology node selection actions' })).toBeNull(),
    );
    expect(container).toBeTruthy();
  });

  it('deep-links ?ids= and shows a clearable selection chip', async () => {
    const graph = buildDemoTopologyGraph();
    const node = graph.nodes.find((n) => n.serial) ?? graph.nodes[0]!;
    mockGetTopology.mockResolvedValue({
      ...demoPayload(),
      dataSource: 'live',
      syncedAt: '2026-07-26T11:59:00.000Z',
    });
    renderTopologyAt(`/topology?view=2d&ids=${encodeURIComponent(node.id)}`);
    const chip = await screen.findByRole('button', { name: /1 selected node/i });
    expect(chip.textContent ?? '').toMatch(/^1 selected node/);
    const table = screen.getByRole('grid', { name: 'Topology nodes' });
    expect(within(table).getByText(node.name)).toBeTruthy();
    /* Other nodes should be filtered out of the table. */
    const other = graph.nodes.find((n) => n.id !== node.id && n.name !== node.name);
    if (other) {
      expect(within(table).queryByText(other.name)).toBeNull();
    }
    fireEvent.click(chip);
    await waitFor(() => expect(screen.getByTestId('loc').textContent).not.toMatch(/ids=/));
  });
});

/* Loop 192 — keyboard shortcuts help + empty graph CTAs. */
describe('Topology Loop 192 residuals', () => {
  function renderTopologyAt(entry: string) {
    return render(
      <MemoryRouter
        initialEntries={[entry]}
        future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
      >
        <ToastProvider>
          <SettingsProvider>
            <Routes>
              <Route
                path="/topology"
                element={
                  <>
                    <Topology />
                    <LocationProbe />
                  </>
                }
              />
              <Route path="/inventory" element={<LocationProbe />} />
              <Route path="/systems" element={<LocationProbe />} />
            </Routes>
          </SettingsProvider>
        </ToastProvider>
      </MemoryRouter>,
    );
  }

  it('exposes keyboard shortcuts help beside the nodes table', async () => {
    mockGetTopology.mockResolvedValue({
      ...demoPayload(),
      dataSource: 'live',
      syncedAt: '2026-07-26T11:59:00.000Z',
    });
    renderTopologyAt('/topology?view=2d');
    expect(await screen.findByRole('grid', { name: 'Topology nodes' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Keyboard shortcuts' })).toBeTruthy();
  });

  it('offers Inventory + Connected systems when the graph is empty', async () => {
    mockGetTopology.mockResolvedValue({
      dataSource: 'live',
      syncedAt: '2026-07-26T11:59:00.000Z',
      graph: { nodes: [], edges: [], sites: [], omissions: [] },
      notes: ['No neighbour facts this cycle.'],
    });
    renderTopologyAt('/topology?view=2d');
    expect(await screen.findByText('Nothing to draw yet')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Inventory' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Connected systems' }));
    await waitFor(() => expect(screen.getByTestId('loc').textContent).toBe('/systems'));
  });

  it('offers Clear filters on a filtered empty graph', async () => {
    mockGetTopology.mockResolvedValue({
      ...demoPayload(),
      dataSource: 'live',
      syncedAt: '2026-07-26T11:59:00.000Z',
    });
    renderTopologyAt('/topology?view=2d&q=zzznomatch');
    expect(await screen.findByText('Nothing matches that filter')).toBeTruthy();
    const clears = screen.getAllByRole('button', { name: 'Clear filters' });
    expect(clears.length).toBeGreaterThanOrEqual(1);
    fireEvent.click(clears[clears.length - 1]!);
    await waitFor(() => expect(screen.getByTestId('loc').textContent).not.toMatch(/[?&]q=/));
  });
});

/* Loop 208 — nodes selection-empty Clear selection filter CTA. */
describe('Topology Loop 208 residuals', () => {
  function renderTopologyAt(entry: string) {
    return render(
      <MemoryRouter
        initialEntries={[entry]}
        future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
      >
        <ToastProvider>
          <SettingsProvider>
            <Routes>
              <Route
                path="/topology"
                element={
                  <>
                    <Topology />
                    <LocationProbe />
                  </>
                }
              />
            </Routes>
          </SettingsProvider>
        </ToastProvider>
      </MemoryRouter>,
    );
  }

  it('offers Clear selection filter when nodes ids deep link matches nothing', async () => {
    mockGetTopology.mockResolvedValue({
      ...demoPayload(),
      dataSource: 'live',
      syncedAt: '2026-07-26T11:59:00.000Z',
    });
    renderTopologyAt(`/topology?view=2d&ids=${encodeURIComponent('missing-node-id')}`);
    expect(
      await screen.findByText(/No topology nodes match the selection deep link/i),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Clear selection filter' }));
    await waitFor(() => expect(screen.getByTestId('loc').textContent).not.toMatch(/ids=/));
    expect(await screen.findByRole('grid', { name: 'Topology nodes' })).toBeTruthy();
    expect(screen.queryByText(/No topology nodes match the selection deep link/i)).toBeNull();
  });
});

/* Loop 223 — nodes bulk Copy names (non-selection-empty residual). */
describe('Topology Loop 223 residuals', () => {
  function renderTopologyAt(entry: string) {
    return render(
      <MemoryRouter
        initialEntries={[entry]}
        future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
      >
        <ToastProvider>
          <SettingsProvider>
            <Routes>
              <Route
                path="/topology"
                element={
                  <>
                    <Topology />
                    <LocationProbe />
                  </>
                }
              />
            </Routes>
          </SettingsProvider>
        </ToastProvider>
      </MemoryRouter>,
    );
  }

  it('Copy names joins unique node names from the selection', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    mockGetTopology.mockResolvedValue({
      ...demoPayload(),
      dataSource: 'live',
      syncedAt: '2026-07-26T11:59:00.000Z',
    });
    renderTopologyAt('/topology?view=2d');
    const table = await screen.findByRole('grid', { name: 'Topology nodes' });
    const first = table.querySelector('tbody tr') as HTMLElement;
    expect(first).toBeTruthy();
    first.focus();
    fireEvent.keyDown(first, { key: 'x' });

    const bar = await screen.findByRole('region', { name: 'Topology node selection actions' });
    fireEvent.click(within(bar).getByRole('button', { name: 'Copy names' }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    const text = String(writeText.mock.calls[0]![0] ?? '');
    expect(text.trim().length).toBeGreaterThan(0);
    expect(text).not.toMatch(/ids=/);
    expect(await screen.findByText(/Copied \d+ name/)).toBeTruthy();
  });
});
