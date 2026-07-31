import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getSearchIndex, searchInventory } from '../api/client';
import { SearchPanel } from './SearchPanel';

vi.mock('../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/client')>();
  return {
    ...actual,
    getSearchIndex: vi.fn(),
    searchInventory: vi.fn(),
  };
});

const mockGetSearchIndex = vi.mocked(getSearchIndex);
const mockSearchInventory = vi.mocked(searchInventory);

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname}{location.search}</div>;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('SearchPanel exact inventory priority', () => {
  it('suppresses an overlapping legacy device result and opens the exact identity target', async () => {
    mockGetSearchIndex.mockResolvedValue({
      dataSource: 'live',
      entries: [
        {
          kind: 'device',
          label: 'Shared switch',
          meta: 'legacy name-only result',
          view: 'device',
          arg: 'Shared switch',
        },
      ],
    });
    mockSearchInventory.mockResolvedValue({
      nodes: [
        {
          id: 'device:central:SER-1',
          parentId: 'system-devices:central',
          kind: 'switch',
          label: 'Shared switch',
          meta: 'CX 6300 · Campus',
          status: 'current',
          tone: 'success',
          hasChildren: false,
          target: '/devices/Shared%20switch?plane=CENTRAL&serial=SER-1',
          identity: { plane: 'CENTRAL', serial: 'SER-1' },
        },
      ],
      total: 1,
      nextCursor: null,
      query: 'shared switch',
    });

    render(
      <MemoryRouter>
        <SearchPanel />
        <LocationProbe />
      </MemoryRouter>,
    );

    fireEvent.change(screen.getByLabelText('Global search'), { target: { value: 'shared switch' } });
    await waitFor(() => expect(mockSearchInventory).toHaveBeenCalled());
    expect(await screen.findAllByRole('option')).toHaveLength(1);
    expect(screen.getByText('CX 6300 · Campus')).toBeTruthy();

    fireEvent.click(screen.getByRole('option'));

    expect(screen.getByTestId('location').textContent).toBe(
      '/devices/Shared%20switch?plane=CENTRAL&serial=SER-1',
    );
  });
});

/* ⌘K is where an operator asks "does this thing exist?" — and the panel's
 * answer used to be a flat "Nothing matches that" whether the estate had been
 * searched or not. A plane whose read has not come back is never looked in. */
describe('SearchPanel search completeness', () => {
  const renderPanel = () =>
    render(
      <MemoryRouter>
        <SearchPanel />
        <LocationProbe />
      </MemoryRouter>,
    );

  it('will not call an unsearched estate a clean miss', async () => {
    mockGetSearchIndex.mockResolvedValue({ dataSource: 'live', entries: [] });
    mockSearchInventory.mockResolvedValue({
      nodes: [],
      total: 0,
      nextCursor: null,
      query: 'sw-riv',
      unsearchedPlanes: ['HPE Aruba Central'],
    });
    renderPanel();
    fireEvent.change(screen.getByLabelText('Global search'), { target: { value: 'sw-riv' } });

    expect(
      await screen.findByText(
        'Nothing matched in the planes that answered. HPE Aruba Central could not be searched.',
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/Try a hostname, MAC prefix or site/)).toBeNull();
  });

  it('keeps the plain miss wording when the whole estate was searched', async () => {
    mockGetSearchIndex.mockResolvedValue({ dataSource: 'live', entries: [] });
    mockSearchInventory.mockResolvedValue({
      nodes: [],
      total: 0,
      nextCursor: null,
      query: 'nope',
      unsearchedPlanes: [],
    });
    renderPanel();
    fireEvent.change(screen.getByLabelText('Global search'), { target: { value: 'nope' } });

    expect(await screen.findByText('Nothing matches that. Try a hostname, MAC prefix or site.')).toBeTruthy();
  });

  it('blames nobody when the search request itself failed', async () => {
    // A rejected search read nothing anywhere. Naming planes would pin a
    // total failure on whichever ones the previous response happened to list.
    mockGetSearchIndex.mockResolvedValue({ dataSource: 'live', entries: [] });
    mockSearchInventory.mockRejectedValue(new Error('offline'));
    renderPanel();
    fireEvent.change(screen.getByLabelText('Global search'), { target: { value: 'nope' } });

    expect(await screen.findByText('Nothing matches that. Try a hostname, MAC prefix or site.')).toBeTruthy();
    expect(screen.queryByText(/could not be searched/)).toBeNull();
  });
});
