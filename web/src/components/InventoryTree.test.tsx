import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { InventoryTree } from './InventoryTree';
import { getInventoryTree } from '../api/client';
import type { InventoryTreeNode, InventoryTreePage } from '@hpe/shared';

vi.mock('../api/client', () => ({
  getInventoryTree: vi.fn(),
}));

const mockGetInventoryTree = vi.mocked(getInventoryTree);

const ROOT: InventoryTreeNode = {
  id: 'group:systems',
  parentId: null,
  kind: 'group',
  label: 'Connected systems',
  status: 'current',
  tone: 'neutral',
  hasChildren: true,
  childCount: 1,
  target: '/systems',
};

const CENTRAL: InventoryTreeNode = {
  id: 'system:central',
  parentId: ROOT.id,
  kind: 'system',
  label: 'HPE Aruba Central',
  status: 'current',
  tone: 'success',
  hasChildren: true,
  childCount: 1,
  target: '/systems?plane=central',
};

const DEVICES: InventoryTreeNode = {
  id: 'system-devices:central',
  parentId: CENTRAL.id,
  kind: 'device-group',
  label: 'Devices',
  status: 'current',
  tone: 'neutral',
  hasChildren: false,
  childCount: 0,
  target: '/devices?plane=central',
};

function page(parentId: string | null, nodes: InventoryTreeNode[]): InventoryTreePage {
  return { parentId, nodes, total: nodes.length, nextCursor: null, query: '' };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('InventoryTree', () => {
  it('loads only the expanded branch and supports arrow-key focus movement', async () => {
    mockGetInventoryTree.mockImplementation(async (options = {}) => {
      const { parent } = options;
      if (!parent) return page(null, [ROOT]);
      if (parent === ROOT.id) return page(ROOT.id, [CENTRAL]);
      if (parent === CENTRAL.id) return page(CENTRAL.id, [DEVICES]);
      return page(parent ?? null, []);
    });

    render(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <InventoryTree />
      </MemoryRouter>,
    );

    await screen.findByText('HPE Aruba Central');
    expect(mockGetInventoryTree).not.toHaveBeenCalledWith(
      expect.objectContaining({ parent: CENTRAL.id }),
    );

    const rootRow = screen.getByText('Connected systems').closest('[role="treeitem"]') as HTMLElement;
    rootRow.focus();
    fireEvent.keyDown(rootRow, { key: 'ArrowDown' });
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByText('HPE Aruba Central').closest('[role="treeitem"]'),
      ),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Expand HPE Aruba Central' }));
    await screen.findByText('Devices');
    expect(mockGetInventoryTree).toHaveBeenCalledWith(
      expect.objectContaining({ parent: CENTRAL.id }),
    );
  });

  /* A branch that shrinks under a half-paged read answers Load More with no
   * rows and no next cursor — the same answer as the genuine last page. The
   * button then simply disappeared, which reads as "those were all of them"
   * over a branch that had just got shorter. */
  it('says the branch changed rather than letting Load more silently vanish', async () => {
    mockGetInventoryTree.mockImplementation(async (options = {}) => {
      const { parent, cursor } = options;
      if (!parent) return page(null, [ROOT]);
      if (parent === ROOT.id) return { ...page(ROOT.id, [CENTRAL]), nextCursor: '1', cursorState: 'ok' };
      if (parent === ROOT.id && cursor) return page(ROOT.id, []);
      return page(parent ?? null, []);
    });

    render(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <InventoryTree />
      </MemoryRouter>,
    );

    await screen.findByText('HPE Aruba Central');
    expect(screen.queryByText(/list changed while loading/)).toBeNull();

    mockGetInventoryTree.mockResolvedValueOnce({
      ...page(ROOT.id, []),
      cursorState: 'past-end',
    });
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));

    expect(await screen.findByText(/list changed while loading/)).toBeTruthy();
    // What was already read stays on screen — it is still the best answer
    // anyone has for that branch.
    expect(screen.getByText('HPE Aruba Central')).toBeTruthy();
  });

  it('leaves a branch alone when its last page is simply the last one', async () => {
    mockGetInventoryTree.mockImplementation(async (options = {}) => {
      const { parent } = options;
      if (!parent) return page(null, [ROOT]);
      if (parent === ROOT.id) return { ...page(ROOT.id, [CENTRAL]), nextCursor: '1', cursorState: 'ok' };
      return page(parent ?? null, []);
    });

    render(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <InventoryTree />
      </MemoryRouter>,
    );

    await screen.findByText('HPE Aruba Central');
    mockGetInventoryTree.mockResolvedValueOnce({
      ...page(ROOT.id, [DEVICES]),
      cursorState: 'ok',
    });
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));

    await screen.findByText('Devices');
    expect(screen.queryByText(/list changed while loading/)).toBeNull();
  });
});
