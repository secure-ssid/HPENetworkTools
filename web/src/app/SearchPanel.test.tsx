import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getSearchIndex, searchInventory } from '../api/client';
import { exportTableCsv } from '../lib/csv';
import { downloadApiCsv } from '../lib/downloadApiCsv';
import { ToastProvider } from '../nightdesk';
import { pushRecentSearch, RECENT_SEARCH_KEY, SearchPanel } from './SearchPanel';

/** Hit rows live in the listbox — not the kind Select's native <option>s. */
function hitOptions() {
  return within(screen.getByRole('listbox', { name: 'Search results' })).getAllByRole('option');
}

async function findHitOptions() {
  const listbox = await screen.findByRole('listbox', { name: 'Search results' });
  return within(listbox).getAllByRole('option');
}

vi.mock('../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/client')>();
  return {
    ...actual,
    getSearchIndex: vi.fn(),
    searchInventory: vi.fn(),
  };
});

vi.mock('../lib/csv', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/csv')>();
  return {
    ...actual,
    exportTableCsv: vi.fn((_filename: string, _headers: string[], rows: Array<Array<unknown>>) => rows.length),
  };
});

vi.mock('../lib/downloadApiCsv', () => ({
  downloadApiCsv: vi.fn(async () => ({ ok: true as const })),
}));

const mockGetSearchIndex = vi.mocked(getSearchIndex);
const mockSearchInventory = vi.mocked(searchInventory);
const mockExportTableCsv = vi.mocked(exportTableCsv);
const mockDownloadApiCsv = vi.mocked(downloadApiCsv);

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname}{location.search}</div>;
}

function renderSearch() {
  return render(
    <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <ToastProvider>
        <SearchPanel />
        <LocationProbe />
      </ToastProvider>
    </MemoryRouter>,
  );
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

    renderSearch();

    fireEvent.change(screen.getByLabelText('Global search'), { target: { value: 'shared switch' } });
    await waitFor(() => expect(mockSearchInventory).toHaveBeenCalled());
    const hits = await findHitOptions();
    expect(hits).toHaveLength(1);
    expect(screen.getByText('CX 6300 · Campus')).toBeTruthy();

    fireEvent.click(hits[0]!);

    expect(screen.getByTestId('location').textContent).toBe(
      '/devices/Shared%20switch?plane=CENTRAL&serial=SER-1',
    );
  });
});

/* ⌘K is where an operator asks "does this thing exist?" — and the panel's
 * answer used to be a flat "Nothing matches that" whether the estate had been
 * searched or not. A plane whose read has not come back is never looked in. */
describe('SearchPanel search completeness', () => {
  it('will not call an unsearched estate a clean miss', async () => {
    mockGetSearchIndex.mockResolvedValue({ dataSource: 'live', entries: [] });
    mockSearchInventory.mockResolvedValue({
      nodes: [],
      total: 0,
      nextCursor: null,
      query: 'sw-riv',
      unsearchedPlanes: ['HPE Aruba Central'],
    });
    renderSearch();
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
    renderSearch();
    fireEvent.change(screen.getByLabelText('Global search'), { target: { value: 'nope' } });

    expect(await screen.findByText('Nothing matches that. Try a hostname, MAC prefix or site.')).toBeTruthy();
  });

  it('names the inventory search failure instead of a clean miss', async () => {
    // A rejected search read nothing anywhere. Naming planes would pin a
    // total failure on whichever ones the previous response happened to list —
    // but a clean "nothing matches" is also dishonest. Surface the error.
    mockGetSearchIndex.mockResolvedValue({ dataSource: 'live', entries: [] });
    mockSearchInventory.mockRejectedValue(new Error('offline'));
    renderSearch();
    fireEvent.change(screen.getByLabelText('Global search'), { target: { value: 'nope' } });

    expect(await screen.findByText(/Inventory search unavailable — offline/)).toBeTruthy();
    expect(screen.queryByText(/Nothing matches that/)).toBeNull();
    expect(screen.queryByText(/could not be searched/)).toBeNull();
  });
});

describe('SearchPanel export CSV', () => {
  it('exports current hits as label/kind/meta/path', async () => {
    mockGetSearchIndex.mockResolvedValue({
      dataSource: 'live',
      entries: [
        {
          kind: 'device',
          label: 'edge-sw-01',
          meta: 'CX',
          view: 'device',
          arg: 'edge-sw-01',
        },
      ],
    });
    mockSearchInventory.mockResolvedValue({
      nodes: [],
      total: 0,
      nextCursor: null,
      query: 'edge',
      unsearchedPlanes: [],
    });

    renderSearch();
    /* Seed SEARCH_INDEX may match "edge" until live index resolves — wait for mock. */
    fireEvent.focus(screen.getByLabelText('Global search'));
    await screen.findByText('edge-sw-01');
    fireEvent.change(screen.getByLabelText('Global search'), { target: { value: 'edge' } });
    await waitFor(() => expect(hitOptions()).toHaveLength(1));

    fireEvent.click(screen.getByRole('button', { name: /export csv/i }));
    expect(mockExportTableCsv).toHaveBeenCalledWith(
      'search-hits.csv',
      ['label', 'kind', 'meta', 'path'],
      [['edge-sw-01', 'device', 'CX', '/devices/edge-sw-01']],
    );
  });

  it('Download server CSV hits search-index export with optional q (Loop 102)', async () => {
    mockGetSearchIndex.mockResolvedValue({
      dataSource: 'live',
      entries: [
        {
          kind: 'device',
          label: 'edge-sw-01',
          meta: 'CX',
          view: 'device',
          arg: 'edge-sw-01',
        },
      ],
    });
    mockSearchInventory.mockResolvedValue({
      nodes: [],
      total: 0,
      nextCursor: null,
      query: 'edge',
      unsearchedPlanes: [],
    });
    mockDownloadApiCsv.mockClear();

    renderSearch();
    fireEvent.focus(screen.getByLabelText('Global search'));
    await screen.findByText('edge-sw-01');
    fireEvent.click(screen.getByRole('button', { name: /download server csv/i }));
    await waitFor(() =>
      expect(mockDownloadApiCsv).toHaveBeenCalledWith('/api/search-index/export', 'search-index.csv'),
    );

    mockDownloadApiCsv.mockClear();
    fireEvent.change(screen.getByLabelText('Global search'), { target: { value: 'edge' } });
    await waitFor(() => expect(hitOptions()).toHaveLength(1));
    fireEvent.click(screen.getByRole('button', { name: /download server csv/i }));
    await waitFor(() =>
      expect(mockDownloadApiCsv).toHaveBeenCalledWith(
        '/api/search-index/export?q=edge',
        'search-index.csv',
      ),
    );
  });

  it('kind filter narrows hits and rides Download server CSV (Loop 110)', async () => {
    mockGetSearchIndex.mockResolvedValue({
      dataSource: 'live',
      entries: [
        {
          kind: 'device',
          label: 'edge-sw-01',
          meta: 'CX',
          view: 'device',
          arg: 'edge-sw-01',
        },
        {
          kind: 'site',
          label: 'edge campus',
          meta: 'HQ',
          view: 'site',
          arg: 'edge-campus',
        },
      ],
    });
    mockSearchInventory.mockResolvedValue({
      nodes: [],
      total: 0,
      nextCursor: null,
      query: 'edge',
      unsearchedPlanes: [],
    });
    mockDownloadApiCsv.mockClear();

    renderSearch();
    fireEvent.focus(screen.getByLabelText('Global search'));
    await screen.findByText('edge-sw-01');
    fireEvent.change(screen.getByLabelText('Global search'), { target: { value: 'edge' } });
    await waitFor(() => {
      expect(screen.getByText('edge campus')).toBeTruthy();
      expect(hitOptions()).toHaveLength(2);
    });

    fireEvent.change(screen.getByLabelText('Result kind'), { target: { value: 'site' } });
    await waitFor(() => expect(hitOptions()).toHaveLength(1));
    expect(screen.getByText('edge campus')).toBeTruthy();
    expect(screen.queryByText('edge-sw-01')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /download server csv/i }));
    await waitFor(() =>
      expect(mockDownloadApiCsv).toHaveBeenCalledWith(
        '/api/search-index/export?q=edge&kind=site',
        'search-index.csv',
      ),
    );
  });
});

describe('SearchPanel recent searches (Loop 77)', () => {
  afterEach(() => {
    try {
      sessionStorage.removeItem(RECENT_SEARCH_KEY);
    } catch {
      /* ignore */
    }
  });

  it('pushRecentSearch dedupes and caps the session list', () => {
    sessionStorage.removeItem(RECENT_SEARCH_KEY);
    expect(pushRecentSearch('ab')).toEqual(['ab']);
    expect(pushRecentSearch('cd')).toEqual(['cd', 'ab']);
    expect(pushRecentSearch('AB')).toEqual(['AB', 'cd']); // case-insensitive dedupe, newest first
    expect(pushRecentSearch('x')).toEqual(['AB', 'cd']); // too short — unchanged
    expect(JSON.parse(sessionStorage.getItem(RECENT_SEARCH_KEY) ?? '[]')).toEqual(['AB', 'cd']);
  });

  it('shows seeded recent queries on empty open and replaying fills the field', async () => {
    sessionStorage.setItem(RECENT_SEARCH_KEY, JSON.stringify(['edge-sw']));
    mockGetSearchIndex.mockResolvedValue({ dataSource: 'live', entries: [] });
    mockSearchInventory.mockResolvedValue({
      nodes: [],
      total: 0,
      nextCursor: null,
      query: '',
      unsearchedPlanes: [],
    });

    renderSearch();
    fireEvent.focus(screen.getByLabelText('Global search'));
    const recent = await screen.findByRole('group', { name: 'Recent searches' });
    expect(recent.textContent).toMatch(/edge-sw/);

    fireEvent.click(screen.getByText('edge-sw'));
    expect((screen.getByLabelText('Global search') as HTMLInputElement).value).toBe('edge-sw');
  });

  it('Clear removes recent entries from the panel and sessionStorage', async () => {
    sessionStorage.setItem(RECENT_SEARCH_KEY, JSON.stringify(['sw-riv']));
    mockGetSearchIndex.mockResolvedValue({ dataSource: 'live', entries: [] });
    mockSearchInventory.mockResolvedValue({
      nodes: [],
      total: 0,
      nextCursor: null,
      query: '',
      unsearchedPlanes: [],
    });

    renderSearch();
    fireEvent.focus(screen.getByLabelText('Global search'));
    expect(await screen.findByText('sw-riv')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(screen.queryByRole('group', { name: 'Recent searches' })).toBeNull();
    expect(sessionStorage.getItem(RECENT_SEARCH_KEY)).toBeNull();
  });
});

/* Loop 189 — recent multi-select Export / Copy queries / Remove selected. */
describe('SearchPanel recent bulk (Loop 189)', () => {
  afterEach(() => {
    try {
      sessionStorage.removeItem(RECENT_SEARCH_KEY);
    } catch {
      /* ignore */
    }
  });

  it('exports, copies, and removes selected recent queries', async () => {
    sessionStorage.setItem(RECENT_SEARCH_KEY, JSON.stringify(['edge-sw', 'gw-core', 'ap-01']));
    mockGetSearchIndex.mockResolvedValue({ dataSource: 'live', entries: [] });
    mockSearchInventory.mockResolvedValue({
      nodes: [],
      total: 0,
      nextCursor: null,
      query: '',
      unsearchedPlanes: [],
    });
    mockExportTableCsv.mockClear();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    renderSearch();
    fireEvent.focus(screen.getByLabelText('Global search'));
    expect(await screen.findByRole('group', { name: 'Recent searches' })).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Recent search selection actions' })).toBeNull();

    fireEvent.click(screen.getByRole('checkbox', { name: 'Select recent query edge-sw' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select recent query gw-core' }));

    const bar = await screen.findByRole('region', { name: 'Recent search selection actions' });
    expect(within(bar).getByText('2 SELECTED')).toBeTruthy();

    fireEvent.click(within(bar).getByRole('button', { name: 'Export selected' }));
    expect(mockExportTableCsv).toHaveBeenCalled();
    const exportArgs = mockExportTableCsv.mock.calls.at(-1)!;
    expect(exportArgs[0]).toBe('search-recent-selected.csv');
    expect(exportArgs[2]).toEqual([['edge-sw'], ['gw-core']]);

    fireEvent.click(within(bar).getByRole('button', { name: 'Copy queries' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('edge-sw\ngw-core'));

    fireEvent.click(within(bar).getByRole('button', { name: 'Remove selected' }));
    await waitFor(() => expect(screen.queryByText('edge-sw')).toBeNull());
    expect(screen.queryByText('gw-core')).toBeNull();
    expect(screen.getByText('ap-01')).toBeTruthy();
    expect(JSON.parse(sessionStorage.getItem(RECENT_SEARCH_KEY) ?? '[]')).toEqual(['ap-01']);
    expect(screen.queryByRole('region', { name: 'Recent search selection actions' })).toBeNull();
  });
});

describe('SearchPanel screen jumps (Loop 128)', () => {
  it('surfaces Go to screen hits and navigates on Enter', async () => {
    mockGetSearchIndex.mockResolvedValue({ dataSource: 'live', entries: [] });
    mockSearchInventory.mockResolvedValue({
      nodes: [],
      total: 0,
      nextCursor: null,
      query: 'alerts',
      unsearchedPlanes: [],
    });

    renderSearch();
    const input = screen.getByLabelText('Global search');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'go alerts' } });

    const hit = await screen.findByText('Alerts');
    expect(hit.closest('[role="option"]')?.textContent).toMatch(/Go to/);
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/alerts'));
  });
});

describe('SearchPanel quick actions (Loop 131)', () => {
  it('ranks raise-ticket / silence / diagnostic actions and deep-links them', async () => {
    mockGetSearchIndex.mockResolvedValue({ dataSource: 'live', entries: [] });
    mockSearchInventory.mockResolvedValue({
      nodes: [],
      total: 0,
      nextCursor: null,
      query: 'raise ticket',
      unsearchedPlanes: [],
    });

    renderSearch();
    const input = screen.getByLabelText('Global search');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'raise ticket' } });

    const raise = await screen.findByText('Raise ticket from alert');
    expect(raise.closest('[role="option"]')?.getAttribute('data-kind')).toBe('action');
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() =>
      expect(screen.getByTestId('location').textContent).toBe('/alerts?tab=queue&action=ticket'),
    );
  });

  it('opens the silence workflow from hush', async () => {
    mockGetSearchIndex.mockResolvedValue({ dataSource: 'live', entries: [] });
    mockSearchInventory.mockResolvedValue({
      nodes: [],
      total: 0,
      nextCursor: null,
      query: 'hush',
      unsearchedPlanes: [],
    });

    renderSearch();
    const input = screen.getByLabelText('Global search');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'hush' } });

    await screen.findByText('Silence an alert');
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() =>
      expect(screen.getByTestId('location').textContent).toBe(
        '/alerts?tab=silences&action=silence',
      ),
    );
  });

  it('opens Devices diagnostics action from traceroute', async () => {
    mockGetSearchIndex.mockResolvedValue({ dataSource: 'live', entries: [] });
    mockSearchInventory.mockResolvedValue({
      nodes: [],
      total: 0,
      nextCursor: null,
      query: 'traceroute',
      unsearchedPlanes: [],
    });

    renderSearch();
    const input = screen.getByLabelText('Global search');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'traceroute' } });

    await screen.findByText('Run device diagnostic');
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() =>
      expect(screen.getByTestId('location').textContent).toBe('/devices?action=diagnostics'),
    );
  });
});

/* Loop 153 — Kind chip row toggles the same kind filter as the Select. */
describe('SearchPanel kind chips (Loop 153)', () => {
  it('kind chips narrow hits and keep server CSV kind= in sync', async () => {
    mockGetSearchIndex.mockResolvedValue({
      dataSource: 'live',
      entries: [
        {
          kind: 'device',
          label: 'Core switch',
          meta: 'Campus',
          view: 'device',
          arg: 'Core switch',
        },
        {
          kind: 'site',
          label: 'HQ campus',
          meta: 'Primary campus',
          view: 'site',
          arg: 'hq',
        },
        {
          kind: 'ticket',
          label: 'NET-100',
          meta: 'Open',
          view: 'tickets',
          arg: 'NET-100',
        },
      ],
    });
    mockSearchInventory.mockResolvedValue({
      nodes: [],
      total: 0,
      nextCursor: null,
      query: '',
      unsearchedPlanes: [],
    });

    renderSearch();
    const input = screen.getByLabelText('Global search');
    fireEvent.focus(input);
    /* Empty query shows the first index slice so every kind is chip-countable. */
    await waitFor(() => expect(screen.getByText('Core switch')).toBeTruthy());
    expect(screen.getByText('HQ campus')).toBeTruthy();
    expect(screen.getByText('NET-100')).toBeTruthy();

    const chips = screen.getByRole('group', { name: 'Search kind' });
    const site = within(chips).getByRole('button', { name: /site/i });
    expect(site.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(site);

    await waitFor(() => expect(screen.getByText('HQ campus')).toBeTruthy());
    expect(screen.queryByText('Core switch')).toBeNull();
    expect(screen.queryByText('NET-100')).toBeNull();
    expect(site.getAttribute('aria-pressed')).toBe('true');
    expect((screen.getByRole('combobox', { name: 'Result kind' }) as HTMLSelectElement).value).toBe(
      'site',
    );

    fireEvent.click(screen.getByRole('button', { name: 'Download server CSV' }));
    await waitFor(() => expect(mockDownloadApiCsv).toHaveBeenCalled());
    const csvUrl = String(mockDownloadApiCsv.mock.calls.at(-1)?.[0] ?? '');
    expect(csvUrl).toContain('kind=site');

    fireEvent.click(site);
    await waitFor(() => expect(screen.getByText('Core switch')).toBeTruthy());
    expect(screen.getByText('HQ campus')).toBeTruthy();
    expect(screen.getByText('NET-100')).toBeTruthy();
    expect(site.getAttribute('aria-pressed')).toBe('false');
  });
});

/* Loop 202 — keyboard shortcuts help on ⌘K panel. */
describe('SearchPanel Loop 202 residuals', () => {
  it('exposes keyboard shortcuts help when the panel is open', async () => {
    mockGetSearchIndex.mockResolvedValue({ dataSource: 'demo', entries: [] });
    mockSearchInventory.mockResolvedValue({
      nodes: [],
      total: 0,
      nextCursor: null,
      query: '',
      unsearchedPlanes: [],
    });
    renderSearch();
    const input = screen.getByLabelText('Global search');
    fireEvent.focus(input);
    expect(await screen.findByRole('button', { name: 'Keyboard shortcuts' })).toBeTruthy();
  });
});
