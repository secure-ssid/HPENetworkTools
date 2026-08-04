import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getInventoryNode, getSystemsState, searchInventory } from '../api/client';
import { exportTableCsv } from '../lib/csv';
import { downloadApiCsv } from '../lib/downloadApiCsv';
import { ToastProvider } from '../nightdesk';
import Inventory, { buildInventoryShareUrl, inventorySectionLive } from './Inventory';

vi.mock('../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/client')>();
  return {
    ...actual,
    getInventoryNode: vi.fn(),
    searchInventory: vi.fn(),
    getSystemsState: vi.fn(),
  };
});

vi.mock('../lib/csv', () => ({
  exportTableCsv: vi.fn((_filename: string, _headers: string[], rows: Array<Array<unknown>>) => rows.length),
}));

vi.mock('../lib/downloadApiCsv', () => ({
  downloadApiCsv: vi.fn(),
}));

vi.mock('../components/InventoryTree', () => ({
  InventoryTree: ({
    expandedIds,
    onExpandedChange,
  }: {
    expandedIds?: string[];
    onExpandedChange?: (ids: string[]) => void;
  }) => (
    <div>
      <div data-testid="tree-exp">{(expandedIds ?? []).join(',')}</div>
      <button type="button" onClick={() => onExpandedChange?.(['group:systems', 'system:central'])}>
        Simulate expand
      </button>
    </div>
  ),
}));

vi.mock('./SseInventoryPanel', () => ({
  SseInventoryPanel: () => <div>SSE inventory</div>,
}));

const mockGetInventoryNode = vi.mocked(getInventoryNode);
const mockSearchInventory = vi.mocked(searchInventory);
const mockGetSystemsState = vi.mocked(getSystemsState);
const mockDownloadApiCsv = vi.mocked(downloadApiCsv);
const mockExportTableCsv = vi.mocked(exportTableCsv);

beforeEach(() => {
  mockGetSystemsState.mockResolvedValue(null);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  mockGetSystemsState.mockResolvedValue(null);
});

function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="loc">{`${loc.pathname}${loc.search}`}</div>;
}

describe('Inventory Explorer expand URL', () => {
  it('seeds expandedIds from ?exp= and writes toggles back', async () => {
    mockGetInventoryNode.mockRejectedValue(new Error('not selected'));
    mockSearchInventory.mockResolvedValue({ nodes: [], total: 0, nextCursor: null, query: '' });

    render(
      <ToastProvider>
        <MemoryRouter
          future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
          initialEntries={['/inventory?exp=group%3Asystems&node=system%3Acentral']}
        >
          <Routes>
            <Route
              path="/inventory"
              element={
                <>
                  <Inventory />
                  <LocationProbe />
                </>
              }
            />
          </Routes>
        </MemoryRouter>
      </ToastProvider>,
    );

    expect(screen.getByTestId('tree-exp').textContent).toBe('group:systems');
    fireEvent.click(screen.getByRole('button', { name: 'Simulate expand' }));
    await waitFor(() =>
      expect(screen.getByTestId('loc').textContent).toContain('exp=group%3Asystems%2Csystem%3Acentral'),
    );
    // Selection survives expand write-back.
    expect(screen.getByTestId('loc').textContent).toContain('node=system%3Acentral');
  });
});

describe('Inventory Explorer exports', () => {
  it('downloads portal device inventory CSV via /api/devices/export', async () => {
    mockGetInventoryNode.mockRejectedValue(new Error('not selected'));
    mockSearchInventory.mockResolvedValue({ nodes: [], total: 0, nextCursor: null, query: '' });
    mockDownloadApiCsv.mockResolvedValue({ ok: true });

    render(
      <ToastProvider>
        <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }} initialEntries={['/inventory']}>
          <Routes>
            <Route path="/inventory" element={<Inventory />} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Download server CSV' }));
    await waitFor(() =>
      expect(mockDownloadApiCsv).toHaveBeenCalledWith('/api/devices/export', 'devices.csv'),
    );
    expect(await screen.findByText('Server CSV downloaded')).toBeTruthy();
  });

  it('passes active search q (≥2 chars) into Download server CSV (Loop 92)', async () => {
    mockGetInventoryNode.mockRejectedValue(new Error('not selected'));
    mockSearchInventory.mockResolvedValue({ nodes: [], total: 0, nextCursor: null, query: 'sw-core' });
    mockDownloadApiCsv.mockResolvedValue({ ok: true });

    render(
      <ToastProvider>
        <MemoryRouter
          future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
          initialEntries={['/inventory?q=sw-core']}
        >
          <Routes>
            <Route path="/inventory" element={<Inventory />} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Download server CSV' }));
    await waitFor(() => expect(mockDownloadApiCsv).toHaveBeenCalled());
    const path = String(mockDownloadApiCsv.mock.calls[0]?.[0] ?? '');
    expect(path.startsWith('/api/devices/export?')).toBe(true);
    expect(path).toMatch(/q=sw-core/);
  });

  it('exports loaded search hits client-side', async () => {
    mockGetInventoryNode.mockRejectedValue(new Error('not selected'));
    mockSearchInventory.mockResolvedValue({
      nodes: [
        {
          id: 'device:central:one',
          parentId: 'system-devices:central',
          kind: 'device',
          label: 'Switch one',
          status: 'current',
          tone: 'success',
          hasChildren: false,
        },
      ],
      total: 1,
      nextCursor: null,
      query: 'switch',
    });

    render(
      <ToastProvider>
        <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }} initialEntries={['/inventory']}>
          <Routes>
            <Route path="/inventory" element={<Inventory />} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>,
    );

    fireEvent.change(screen.getByLabelText('Search inventory'), { target: { value: 'switch' } });
    expect(await screen.findByText('Switch one')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }));
    expect(mockExportTableCsv).toHaveBeenCalled();
    expect(await screen.findByText(/Exported 1 result/)).toBeTruthy();
  });
});

describe('Inventory Explorer search', () => {
  it('loads subsequent bounded search pages without replacing earlier matches', async () => {
    mockGetInventoryNode.mockRejectedValue(new Error('not selected'));
    mockSearchInventory
      .mockResolvedValueOnce({
        nodes: [
          {
            id: 'device:central:one',
            parentId: 'system-devices:central',
            kind: 'device',
            label: 'Switch one',
            status: 'current',
            tone: 'success',
            hasChildren: false,
          },
        ],
        total: 2,
        nextCursor: '1',
        query: 'switch',
      })
      .mockResolvedValueOnce({
        nodes: [
          {
            id: 'device:central:two',
            parentId: 'system-devices:central',
            kind: 'device',
            label: 'Switch two',
            status: 'current',
            tone: 'success',
            hasChildren: false,
          },
        ],
        total: 2,
        nextCursor: null,
        query: 'switch',
      });

    render(
      <ToastProvider>
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }} initialEntries={['/inventory']}>
        <Routes>
          <Route path="/inventory" element={<Inventory />} />
        </Routes>
      </MemoryRouter>
      </ToastProvider>,
    );

    fireEvent.change(screen.getByLabelText('Search inventory'), { target: { value: 'switch' } });
    expect(await screen.findByText('Switch one')).toBeTruthy();
    expect(screen.getByText('1 OF 2')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));

    await waitFor(() =>
      expect(mockSearchInventory).toHaveBeenLastCalledWith('switch', { cursor: '1', limit: 50 }),
    );
    expect(await screen.findByText('Switch two')).toBeTruthy();
    expect(screen.getByText('Switch one')).toBeTruthy();
    expect(screen.getByText('2 OF 2')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
  });

  /* Before this, a Load More that landed past the end of a shrunken estate
   * appended nothing, hid the button and left the header reading "1 OF 0" —
   * a ratio drawn from two different reads, over a list the operator was now
   * being told was complete. */
  it('says the estate moved when the next page no longer exists', async () => {
    mockGetInventoryNode.mockRejectedValue(new Error('not selected'));
    mockSearchInventory
      .mockResolvedValueOnce({
        nodes: [
          {
            id: 'device:central:one',
            parentId: 'system-devices:central',
            kind: 'device',
            label: 'Switch one',
            status: 'current',
            tone: 'success',
            hasChildren: false,
          },
        ],
        total: 40,
        nextCursor: '1',
        cursorState: 'ok',
        query: 'switch',
      })
      // The plane went stale between clicks: its rows left the cache, so the
      // page the cursor named is gone.
      .mockResolvedValueOnce({ nodes: [], total: 0, nextCursor: null, cursorState: 'past-end', query: 'switch' });

    render(
      <ToastProvider>
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }} initialEntries={['/inventory']}>
        <Routes>
          <Route path="/inventory" element={<Inventory />} />
        </Routes>
      </MemoryRouter>
      </ToastProvider>,
    );

    fireEvent.change(screen.getByLabelText('Search inventory'), { target: { value: 'switch' } });
    expect(await screen.findByText('Switch one')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));

    expect(
      await screen.findByText('The inventory changed while these results were being paged'),
    ).toBeTruthy();
    // The rows already read stay: they are still the best answer anyone has.
    expect(screen.getByText('Switch one')).toBeTruthy();
    // But the header stops pairing a count from one read with a total from
    // another, and stops implying the list is complete.
    expect(screen.getByText('1 SHOWN')).toBeTruthy();
    expect(screen.queryByText('1 OF 0')).toBeNull();
  });

  it('says nothing about a moved list when the last page is simply the last one', async () => {
    mockGetInventoryNode.mockRejectedValue(new Error('not selected'));
    mockSearchInventory
      .mockResolvedValueOnce({
        nodes: [
          {
            id: 'device:central:one',
            parentId: 'system-devices:central',
            kind: 'device',
            label: 'Switch one',
            status: 'current',
            tone: 'success',
            hasChildren: false,
          },
        ],
        total: 2,
        nextCursor: '1',
        cursorState: 'ok',
        query: 'switch',
      })
      .mockResolvedValueOnce({
        nodes: [
          {
            id: 'device:central:two',
            parentId: 'system-devices:central',
            kind: 'device',
            label: 'Switch two',
            status: 'current',
            tone: 'success',
            hasChildren: false,
          },
        ],
        total: 2,
        nextCursor: null,
        cursorState: 'ok',
        query: 'switch',
      });

    render(
      <ToastProvider>
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }} initialEntries={['/inventory']}>
        <Routes>
          <Route path="/inventory" element={<Inventory />} />
        </Routes>
      </MemoryRouter>
      </ToastProvider>,
    );

    fireEvent.change(screen.getByLabelText('Search inventory'), { target: { value: 'switch' } });
    expect(await screen.findByText('Switch one')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));

    expect(await screen.findByText('Switch two')).toBeTruthy();
    expect(screen.getByText('2 OF 2')).toBeTruthy();
    expect(screen.queryByText('The inventory changed while these results were being paged')).toBeNull();
  });

  it('leaves search mode and reveals an in-page SSE selection', async () => {
    mockGetInventoryNode.mockResolvedValue({
      id: 'sse-kind:users',
      parentId: 'system:sse',
      kind: 'sse-kind',
      label: 'Users',
      status: 'current',
      tone: 'success',
      hasChildren: true,
      identity: { plane: 'sse', sseKind: 'users' },
    });
    mockSearchInventory.mockResolvedValue({
      nodes: [
        {
          id: 'sse-kind:users',
          parentId: 'system:sse',
          kind: 'sse-kind',
          label: 'Users',
          status: 'current',
          tone: 'success',
          hasChildren: true,
          identity: { plane: 'sse', sseKind: 'users' },
        },
      ],
      total: 1,
      nextCursor: null,
      query: 'users',
    });

    render(
      <ToastProvider>
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }} initialEntries={['/inventory']}>
        <Routes>
          <Route path="/inventory" element={<Inventory />} />
        </Routes>
      </MemoryRouter>
      </ToastProvider>,
    );

    fireEvent.change(screen.getByLabelText('Search inventory'), { target: { value: 'users' } });
    const hit = await screen.findByText('Users');
    const row = hit.closest('tr');
    expect(row).toBeTruthy();
    fireEvent.click(row!);

    expect(await screen.findByText('SSE inventory')).toBeTruthy();
    expect(screen.queryByText('Search results')).toBeNull();
    expect((screen.getByLabelText('Search inventory') as HTMLInputElement).value).toBe('');
  });
});

/* The search walks whatever the poller currently holds, so a linked plane
 * whose read has not come back is never searched at all. "No inventory
 * matches" over an unsearched plane is a false negative — and an operator
 * typing a serial to ask "is this device in the estate?" reads it as no. */
describe('Inventory search completeness', () => {
  const renderInventory = () =>
    render(
      <ToastProvider>
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }} initialEntries={['/inventory']}>
        <Routes>
          <Route path="/inventory" element={<Inventory />} />
        </Routes>
      </MemoryRouter>
      </ToastProvider>,
    );

  it('refuses to report a clean miss when a plane could not be searched', async () => {
    mockGetInventoryNode.mockRejectedValue(new Error('not selected'));
    mockSearchInventory.mockResolvedValue({
      nodes: [],
      total: 0,
      nextCursor: null,
      query: 'sw-riv',
      unsearchedPlanes: ['HPE Aruba Central', 'Mist'],
    });
    renderInventory();
    fireEvent.change(screen.getByLabelText('Search inventory'), { target: { value: 'sw-riv' } });

    expect(await screen.findByText('HPE Aruba Central, Mist could not be searched')).toBeTruthy();
    expect(screen.getByText('No matches in the planes that could be searched')).toBeTruthy();
    expect(screen.queryByText('No inventory matches')).toBeNull();
  });

  it('warns beside real results too, because a hit elsewhere proves nothing', async () => {
    mockGetInventoryNode.mockRejectedValue(new Error('not selected'));
    mockSearchInventory.mockResolvedValue({
      nodes: [
        {
          id: 'device:mist:one',
          parentId: 'system-devices:mist',
          kind: 'device',
          label: 'Switch one',
          status: 'current',
          tone: 'success',
          hasChildren: false,
        },
      ],
      total: 1,
      nextCursor: null,
      query: 'switch',
      unsearchedPlanes: ['HPE Aruba Central'],
    });
    renderInventory();
    fireEvent.change(screen.getByLabelText('Search inventory'), { target: { value: 'switch' } });

    expect(await screen.findByText('Switch one')).toBeTruthy();
    expect(screen.getByText('HPE Aruba Central could not be searched')).toBeTruthy();
  });

  it('keeps the plain miss when every linked plane was searched', async () => {
    mockGetInventoryNode.mockRejectedValue(new Error('not selected'));
    mockSearchInventory.mockResolvedValue({
      nodes: [],
      total: 0,
      nextCursor: null,
      query: 'nope',
      unsearchedPlanes: [],
    });
    renderInventory();
    fireEvent.change(screen.getByLabelText('Search inventory'), { target: { value: 'nope' } });

    expect(await screen.findByText('No inventory matches')).toBeTruthy();
    expect(screen.queryByText(/could not be searched/)).toBeNull();
  });

  it('says nothing when the route never reported on searchability', async () => {
    // Absent field, not an empty one — an older server that never looked must
    // not render as one that looked and found every plane searchable.
    mockGetInventoryNode.mockRejectedValue(new Error('not selected'));
    mockSearchInventory.mockResolvedValue({ nodes: [], total: 0, nextCursor: null, query: 'nope' });
    renderInventory();
    fireEvent.change(screen.getByLabelText('Search inventory'), { target: { value: 'nope' } });

    expect(await screen.findByText('No inventory matches')).toBeTruthy();
    expect(screen.queryByText(/could not be searched/)).toBeNull();
  });
});

describe('Inventory Explorer search share (Loop 74)', () => {
  it('seeds the search box from ?q= and writes the query back to the URL', async () => {
    mockGetInventoryNode.mockRejectedValue(new Error('not selected'));
    mockSearchInventory.mockResolvedValue({
      nodes: [
        {
          id: 'device:central:one',
          parentId: 'system-devices:central',
          kind: 'device',
          label: 'Core switch',
          status: 'current',
          tone: 'success',
          hasChildren: false,
        },
      ],
      total: 1,
      nextCursor: null,
      query: 'core',
    });

    render(
      <ToastProvider>
        <MemoryRouter
          future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
          initialEntries={['/inventory?q=core']}
        >
          <Routes>
            <Route
              path="/inventory"
              element={
                <>
                  <Inventory />
                  <LocationProbe />
                </>
              }
            />
          </Routes>
        </MemoryRouter>
      </ToastProvider>,
    );

    expect((screen.getByLabelText('Search inventory') as HTMLInputElement).value).toBe('core');
    expect(await screen.findByText('Core switch')).toBeTruthy();
    expect(screen.getByTestId('loc').textContent).toContain('q=core');

    fireEvent.change(screen.getByLabelText('Search inventory'), { target: { value: 'sw' } });
    await waitFor(() => expect(screen.getByTestId('loc').textContent).toContain('q=sw'));
  });

  it('Copy view link includes the active search query', async () => {
    mockGetInventoryNode.mockRejectedValue(new Error('not selected'));
    mockSearchInventory.mockResolvedValue({ nodes: [], total: 0, nextCursor: null, query: 'ap' });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });

    render(
      <ToastProvider>
        <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }} initialEntries={['/inventory']}>
          <Routes>
            <Route path="/inventory" element={<Inventory />} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>,
    );

    fireEvent.change(screen.getByLabelText('Search inventory'), { target: { value: 'ap-01' } });
    fireEvent.click(screen.getByRole('button', { name: 'Copy view link' }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(String(writeText.mock.calls[0]![0])).toMatch(/q=ap-01/);
  });

  it('buildInventoryShareUrl omits short q and empty node/exp', () => {
    expect(buildInventoryShareUrl({ q: 'a', origin: 'http://x', pathname: '/inventory' })).toBe(
      'http://x/inventory',
    );
    expect(
      buildInventoryShareUrl({
        q: 'core',
        node: 'system:central',
        exp: ['group:systems'],
        origin: 'http://x',
        pathname: '/inventory',
      }),
    ).toBe('http://x/inventory?q=core&node=system%3Acentral&exp=group%3Asystems');
  });
});

/* Loop 171 — Inventory header LIVE badge honesty (systems registry non-demo). */
describe('Inventory Loop 171 residuals', () => {
  it('inventorySectionLive is true only for non-demo systems state', () => {
    expect(inventorySectionLive(null)).toBe(false);
    expect(inventorySectionLive(undefined)).toBe(false);
    expect(inventorySectionLive({ dataSource: 'demo', demoMode: false })).toBe(false);
    expect(inventorySectionLive({ dataSource: 'live', demoMode: true })).toBe(false);
    expect(inventorySectionLive({ dataSource: 'live', demoMode: false })).toBe(true);
    expect(inventorySectionLive({ demoMode: false })).toBe(true);
  });

  it('stamps LIVE when systems registry is pure live', async () => {
    mockGetInventoryNode.mockRejectedValue(new Error('not selected'));
    mockSearchInventory.mockResolvedValue({ nodes: [], total: 0, nextCursor: null, query: '' });
    mockGetSystemsState.mockResolvedValue({
      dataSource: 'live',
      demoMode: false,
      syncedAt: '2026-08-04T12:00:00.000Z',
      planes: {},
      history: [],
    });

    render(
      <ToastProvider>
        <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }} initialEntries={['/inventory']}>
          <Routes>
            <Route path="/inventory" element={<Inventory />} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>,
    );

    expect(await screen.findByText('LIVE')).toBeTruthy();
  });

  it('keeps demo chrome quiet (no LIVE badge)', async () => {
    mockGetInventoryNode.mockRejectedValue(new Error('not selected'));
    mockSearchInventory.mockResolvedValue({ nodes: [], total: 0, nextCursor: null, query: '' });
    mockGetSystemsState.mockResolvedValue({
      dataSource: 'live',
      demoMode: true,
      syncedAt: null,
      planes: {},
      history: [],
    });

    render(
      <ToastProvider>
        <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }} initialEntries={['/inventory']}>
          <Routes>
            <Route path="/inventory" element={<Inventory />} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>,
    );

    await waitFor(() => expect(screen.getByText('Inventory explorer')).toBeTruthy());
    expect(screen.queryByText('LIVE')).toBeNull();
  });
});

/* Loop 180 — Inventory search multi-select Export selected + Copy serials bulk bar. */
describe('Inventory search bulk selection (Loop 180)', () => {
  it('shows bulk bar for selection: Export selected, Copy serials, Clear', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    mockGetInventoryNode.mockRejectedValue(new Error('not selected'));
    mockSearchInventory.mockResolvedValue({
      nodes: [
        {
          id: 'device:central:one',
          parentId: 'system-devices:central',
          kind: 'device',
          label: 'Switch one',
          status: 'current',
          tone: 'success',
          hasChildren: false,
          identity: { plane: 'CENTRAL', serial: 'SN-INV-1' },
        },
        {
          id: 'device:central:two',
          parentId: 'system-devices:central',
          kind: 'device',
          label: 'Switch two',
          status: 'current',
          tone: 'success',
          hasChildren: false,
          identity: { plane: 'CENTRAL', serial: 'SN-INV-2' },
        },
      ],
      total: 2,
      nextCursor: null,
      query: 'switch',
    });

    const { container } = render(
      <ToastProvider>
        <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }} initialEntries={['/inventory']}>
          <Routes>
            <Route path="/inventory" element={<Inventory />} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>,
    );

    fireEvent.change(screen.getByLabelText('Search inventory'), { target: { value: 'switch' } });
    expect(await screen.findByText('Switch one')).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Inventory search selection actions' })).toBeNull();

    const table = await waitFor(() => {
      const el = container.querySelector('[aria-label="Inventory search results"]') as HTMLElement | null;
      if (!el) throw new Error('Inventory search table missing');
      return el;
    });
    const first = table.querySelector('tbody tr') as HTMLElement;
    expect(first).toBeTruthy();
    first.focus();
    fireEvent.keyDown(first, { key: 'x' });

    const bar = await screen.findByRole('region', { name: 'Inventory search selection actions' });
    expect(within(bar).getByText('1 SELECTED')).toBeTruthy();

    fireEvent.click(within(bar).getByRole('button', { name: 'Export selected' }));
    expect(await screen.findByText(/Exported 1 selected result/)).toBeTruthy();
    expect(mockExportTableCsv).toHaveBeenCalled();
    expect(
      mockExportTableCsv.mock.calls.some((c) => c[0] === 'inventory-search-selected.csv'),
    ).toBe(true);

    fireEvent.click(within(bar).getByRole('button', { name: 'Copy serials' }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(String(writeText.mock.calls[0]![0])).toContain('SN-INV-1');
    expect(await screen.findByText(/Copied 1 serial/)).toBeTruthy();

    fireEvent.click(within(bar).getByRole('button', { name: 'Clear' }));
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: 'Inventory search selection actions' })).toBeNull(),
    );
  });
});

/* Loop 184 — Inventory search bulk Copy selection link (?ids=) + clearable chip. */
describe('Inventory search selection link (Loop 184)', () => {
  it('Copy selection link writes ids=', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    mockGetInventoryNode.mockRejectedValue(new Error('not selected'));
    mockSearchInventory.mockResolvedValue({
      nodes: [
        {
          id: 'device:central:one',
          parentId: 'system-devices:central',
          kind: 'device',
          label: 'Switch one',
          status: 'current',
          tone: 'success',
          hasChildren: false,
          identity: { plane: 'CENTRAL', serial: 'SN-INV-1' },
        },
        {
          id: 'device:central:two',
          parentId: 'system-devices:central',
          kind: 'device',
          label: 'Switch two',
          status: 'current',
          tone: 'success',
          hasChildren: false,
          identity: { plane: 'CENTRAL', serial: 'SN-INV-2' },
        },
      ],
      total: 2,
      nextCursor: null,
      query: 'switch',
    });

    const { container } = render(
      <ToastProvider>
        <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }} initialEntries={['/inventory']}>
          <Routes>
            <Route path="/inventory" element={<Inventory />} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>,
    );

    fireEvent.change(screen.getByLabelText('Search inventory'), { target: { value: 'switch' } });
    expect(await screen.findByText('Switch one')).toBeTruthy();

    const table = await waitFor(() => {
      const el = container.querySelector('[aria-label="Inventory search results"]') as HTMLElement | null;
      if (!el) throw new Error('Inventory search table missing');
      return el;
    });
    const first = table.querySelector('tbody tr') as HTMLElement;
    first.focus();
    fireEvent.keyDown(first, { key: 'x' });

    const bar = await screen.findByRole('region', { name: 'Inventory search selection actions' });
    fireEvent.click(within(bar).getByRole('button', { name: 'Copy selection link' }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    const url = decodeURIComponent(String(writeText.mock.calls[0]![0]));
    expect(url).toMatch(/ids=/);
    expect(url).toContain('device:central:one');
    expect(await screen.findByText(/Selection link copied/)).toBeTruthy();
  });

  it('deep-links ?ids= and shows a clearable selection chip', async () => {
    mockGetInventoryNode.mockRejectedValue(new Error('not selected'));
    mockSearchInventory.mockResolvedValue({
      nodes: [
        {
          id: 'device:central:one',
          parentId: 'system-devices:central',
          kind: 'device',
          label: 'Switch one',
          status: 'current',
          tone: 'success',
          hasChildren: false,
          identity: { plane: 'CENTRAL', serial: 'SN-INV-1' },
        },
        {
          id: 'device:central:two',
          parentId: 'system-devices:central',
          kind: 'device',
          label: 'Switch two',
          status: 'current',
          tone: 'success',
          hasChildren: false,
          identity: { plane: 'CENTRAL', serial: 'SN-INV-2' },
        },
      ],
      total: 2,
      nextCursor: null,
      query: 'switch',
    });

    const { container } = render(
      <ToastProvider>
        <MemoryRouter
          future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
          initialEntries={[`/inventory?q=switch&ids=${encodeURIComponent('device:central:one')}`]}
        >
          <Routes>
            <Route path="/inventory" element={<Inventory />} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>,
    );

    expect(await screen.findByText('Switch one')).toBeTruthy();
    const table = await waitFor(() => {
      const el = container.querySelector('[aria-label="Inventory search results"]') as HTMLElement | null;
      if (!el) throw new Error('Inventory search table missing');
      return el;
    });
    expect(within(table).queryByText('Switch two')).toBeNull();
    const chip = screen.getByRole('group', { name: 'Selection deep link' });
    expect(within(chip).getByText(/1 selected id/)).toBeTruthy();
    fireEvent.click(within(chip).getByRole('button'));
    await waitFor(() => expect(screen.queryByRole('group', { name: 'Selection deep link' })).toBeNull());
    expect(await within(table).findByText('Switch two')).toBeTruthy();
  });
});

/* Loop 198 — keyboard shortcuts help on inventory search results. */
describe('Inventory Loop 198 residuals', () => {
  it('exposes keyboard shortcuts help on the explorer header', async () => {
    mockGetInventoryNode.mockRejectedValue(new Error('not selected'));
    mockSearchInventory.mockResolvedValue({ nodes: [], total: 0, nextCursor: null, query: '' });

    render(
      <ToastProvider>
        <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }} initialEntries={['/inventory']}>
          <Routes>
            <Route path="/inventory" element={<Inventory />} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>,
    );

    expect(screen.getByRole('button', { name: 'Keyboard shortcuts' })).toBeTruthy();
  });
});

/* Loop 204 — inventory search empty Clear search CTA. */
describe('Inventory Loop 204 residuals', () => {
  it('offers Clear search when inventory search returns no matches', async () => {
    mockGetInventoryNode.mockRejectedValue(new Error('not selected'));
    mockSearchInventory.mockResolvedValue({ nodes: [], total: 0, nextCursor: null, query: 'zzzz-no-match' });

    render(
      <ToastProvider>
        <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }} initialEntries={['/inventory']}>
          <Routes>
            <Route path="/inventory" element={<Inventory />} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>,
    );

    fireEvent.change(screen.getByLabelText('Search inventory'), { target: { value: 'zzzz-no-match' } });
    expect(await screen.findByText('No inventory matches')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
    await waitFor(() => {
      expect((screen.getByLabelText('Search inventory') as HTMLInputElement).value).toBe('');
    });
    expect(screen.queryByText('No inventory matches')).toBeNull();
  });
});

/* Loop 208 — inventory search selection-empty Clear selection filter CTA. */
describe('Inventory Loop 208 residuals', () => {
  it('offers Clear selection filter when search ids deep link matches nothing', async () => {
    mockGetInventoryNode.mockRejectedValue(new Error('not selected'));
    mockSearchInventory.mockResolvedValue({
      nodes: [
        {
          id: 'device:central:one',
          parentId: 'system-devices:central',
          kind: 'device',
          label: 'Switch one',
          status: 'current',
          tone: 'success',
          hasChildren: false,
          identity: { plane: 'CENTRAL', serial: 'SN-INV-1' },
        },
      ],
      total: 1,
      nextCursor: null,
      query: 'switch',
    });

    render(
      <ToastProvider>
        <MemoryRouter
          future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
          initialEntries={[`/inventory?q=switch&ids=${encodeURIComponent('device:missing:zzz')}`]}
        >
          <Routes>
            <Route
              path="/inventory"
              element={
                <>
                  <Inventory />
                  <LocationProbe />
                </>
              }
            />
          </Routes>
        </MemoryRouter>
      </ToastProvider>,
    );

    expect(await screen.findByText(/No search hits match the selection deep link/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Clear selection filter' }));
    await waitFor(() => expect(screen.getByTestId('loc').textContent).not.toMatch(/ids=/));
    expect(await screen.findByText('Switch one')).toBeTruthy();
    expect(screen.queryByText(/No search hits match the selection deep link/i)).toBeNull();
  });
});
