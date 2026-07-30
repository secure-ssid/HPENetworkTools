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
      <MemoryRouter>
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
});
