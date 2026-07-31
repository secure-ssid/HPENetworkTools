import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getInventoryNode, searchInventory } from '../api/client';
import Inventory from './Inventory';

vi.mock('../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/client')>();
  return {
    ...actual,
    getInventoryNode: vi.fn(),
    searchInventory: vi.fn(),
  };
});

vi.mock('../components/InventoryTree', () => ({
  InventoryTree: () => <div>Inventory tree</div>,
}));

vi.mock('./SseInventoryPanel', () => ({
  SseInventoryPanel: () => <div>SSE inventory</div>,
}));

const mockGetInventoryNode = vi.mocked(getInventoryNode);
const mockSearchInventory = vi.mocked(searchInventory);

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
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
      <MemoryRouter initialEntries={['/inventory']}>
        <Routes>
          <Route path="/inventory" element={<Inventory />} />
        </Routes>
      </MemoryRouter>,
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
      <MemoryRouter initialEntries={['/inventory']}>
        <Routes>
          <Route path="/inventory" element={<Inventory />} />
        </Routes>
      </MemoryRouter>,
    );

    fireEvent.change(screen.getByLabelText('Search inventory'), { target: { value: 'users' } });
    fireEvent.click(await screen.findByRole('button', { name: /Users/ }));

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
      <MemoryRouter initialEntries={['/inventory']}>
        <Routes>
          <Route path="/inventory" element={<Inventory />} />
        </Routes>
      </MemoryRouter>,
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
