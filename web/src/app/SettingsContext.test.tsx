import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { getSettings, saveSettings } from '../api/client';
import { SettingsProvider, useSettings } from './SettingsContext';

vi.mock('../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/client')>();
  return {
    ...actual,
    getSettings: vi.fn(),
    saveSettings: vi.fn().mockResolvedValue({ ok: true, message: 'saved' }),
  };
});

const mockGetSettings = vi.mocked(getSettings);
const mockSaveSettings = vi.mocked(saveSettings);

beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
    clear: () => values.clear(),
  });
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
  mockGetSettings.mockReset();
  mockSaveSettings.mockClear();
});

function Probe() {
  const settings = useSettings();
  return <div>{`${settings.workspaceName}|${settings.pollIntervalSec}|${settings.settingsError ?? ''}`}</div>;
}

describe('SettingsProvider', () => {
  it('hydrates workspace identity and poll cadence from the server settings', async () => {
    mockGetSettings.mockResolvedValue({
      density: 'compact',
      inventoryView: 'Platform lanes',
      showPlatformTags: false,
      workspaceName: 'SecureSSID',
      pollIntervalSec: 30,
    });

    render(
      <SettingsProvider>
        <Probe />
      </SettingsProvider>,
    );

    await waitFor(() => expect(screen.getByText('SecureSSID|30|')).toBeTruthy());
    expect(JSON.parse(localStorage.getItem('nt-settings') ?? '{}')).toMatchObject({
      workspaceName: 'SecureSSID',
      pollIntervalSec: 30,
    });
  });

  it('surfaces an answered settings load failure instead of leaving an unhandled rejection', async () => {
    mockGetSettings.mockRejectedValue(new Error('HTTP 500'));

    render(
      <SettingsProvider>
        <Probe />
      </SettingsProvider>,
    );

    await waitFor(() => expect(screen.getByText(/settings could not be loaded: HTTP 500/)).toBeTruthy());
  });
});

function ColumnsProbe() {
  const { tableColumns, setTableColumns } = useSettings();
  return (
    <div>
      <div data-testid="columns">{JSON.stringify(tableColumns)}</div>
      <button type="button" onClick={() => setTableColumns('devices', { hidden: ['model'] })}>
        hide-model
      </button>
    </div>
  );
}

describe('SettingsProvider tableColumns', () => {
  it('starts empty when nothing is persisted', async () => {
    mockGetSettings.mockResolvedValue({
      density: 'comfortable',
      inventoryView: 'Unified table',
      showPlatformTags: true,
      workspaceName: 'Meridian Health',
      pollIntervalSec: 60,
    });
    render(
      <SettingsProvider>
        <ColumnsProbe />
      </SettingsProvider>,
    );
    expect(screen.getByTestId('columns').textContent).toBe('{}');
  });

  it('seeds from the localStorage copy synchronously', () => {
    localStorage.setItem('nt-table-columns', JSON.stringify({ devices: { hidden: ['site'], order: ['state', 'device'] } }));
    mockGetSettings.mockRejectedValue(new Error('offline'));
    render(
      <SettingsProvider>
        <ColumnsProbe />
      </SettingsProvider>,
    );
    expect(screen.getByTestId('columns').textContent).toBe(
      JSON.stringify({ devices: { order: ['state', 'device'], hidden: ['site'] } }),
    );
  });

  it('drops a corrupt local copy instead of trusting it', () => {
    localStorage.setItem('nt-table-columns', '{not json');
    mockGetSettings.mockRejectedValue(new Error('offline'));
    render(
      <SettingsProvider>
        <ColumnsProbe />
      </SettingsProvider>,
    );
    expect(screen.getByTestId('columns').textContent).toBe('{}');
  });

  it('persists a change to localStorage immediately and PUTs it with the shell keys after the debounce', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({}),
    });
    vi.stubGlobal('fetch', fetchMock);
    mockGetSettings.mockResolvedValue({
      density: 'compact',
      inventoryView: 'Unified table',
      showPlatformTags: true,
      workspaceName: 'Meridian Health',
      pollIntervalSec: 60,
    });
    render(
      <SettingsProvider>
        <ColumnsProbe />
      </SettingsProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'hide-model' }));

    // Synchronous halves: context state and the localStorage copy.
    expect(screen.getByTestId('columns').textContent).toBe(JSON.stringify({ devices: { hidden: ['model'] } }));
    expect(JSON.parse(localStorage.getItem('nt-table-columns') ?? '{}')).toEqual({
      devices: { hidden: ['model'] },
    });

    // The network half is trailing-edge debounced; the PUT carries the shell
    // keys so a server that predates tableColumns still validates the write.
    // (The mount-time hydrate GET hits the same fetch stub, so find the PUT.)
    await waitFor(() =>
      expect(fetchMock.mock.calls.some((call) => (call[1] as RequestInit | undefined)?.method === 'PUT')).toBe(true),
    );
    const putCall = fetchMock.mock.calls.find(
      (call) => (call[1] as RequestInit | undefined)?.method === 'PUT',
    ) as [string, RequestInit];
    expect(putCall[0]).toBe('/api/settings');
    expect(JSON.parse(putCall[1].body as string)).toEqual({
      density: 'compact',
      inventoryView: 'Unified table',
      showPlatformTags: true,
      workspaceName: 'Meridian Health',
      pollIntervalSec: 60,
      tableColumns: { devices: { hidden: ['model'] } },
    });
  });

  it('adopts the server copy of the column configs when the settings payload carries one', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ tableColumns: { devices: { hidden: ['site'] } } }),
    });
    vi.stubGlobal('fetch', fetchMock);
    mockGetSettings.mockResolvedValue({
      density: 'comfortable',
      inventoryView: 'Unified table',
      showPlatformTags: true,
      workspaceName: 'Meridian Health',
      pollIntervalSec: 60,
    });
    render(
      <SettingsProvider>
        <ColumnsProbe />
      </SettingsProvider>,
    );
    await waitFor(() =>
      expect(screen.getByTestId('columns').textContent).toBe(JSON.stringify({ devices: { hidden: ['site'] } })),
    );
    expect(JSON.parse(localStorage.getItem('nt-table-columns') ?? '{}')).toEqual({
      devices: { hidden: ['site'] },
    });
  });
});

function ViewsProbe() {
  const { savedViews, setSavedViews } = useSettings();
  return (
    <div>
      <div data-testid="views">{JSON.stringify(savedViews)}</div>
      <button
        type="button"
        onClick={() => setSavedViews('devices', [{ name: 'WAN focus', filters: { q: 'wan' }, density: 'compact' }])}
      >
        save-view
      </button>
    </div>
  );
}

function renderViewsProbe() {
  mockGetSettings.mockResolvedValue({
    density: 'comfortable',
    inventoryView: 'Unified table',
    showPlatformTags: true,
    workspaceName: 'Meridian Health',
    pollIntervalSec: 60,
  });
  return render(
    <SettingsProvider>
      <ViewsProbe />
    </SettingsProvider>,
  );
}

describe('SettingsProvider savedViews', () => {
  it('starts empty when nothing is persisted', () => {
    renderViewsProbe();
    expect(screen.getByTestId('views').textContent).toBe('{}');
  });

  it('seeds from the localStorage copy synchronously, dropping malformed entries', () => {
    localStorage.setItem(
      'nt-saved-views',
      JSON.stringify({
        devices: [
          { name: 'Good', filters: { q: 'x' } },
          { name: '  ', filters: {} }, // empty name — dropped
          { name: 'NoFilters' }, // filters missing — dropped
          { name: 'Good', filters: { q: 'dup' } }, // duplicate name — first wins
          { name: 'Full', filters: {}, tableColumns: { hidden: ['site'], bogus: 1 }, density: 'compact' },
          'junk',
        ],
        alerts: 'not-an-array', // not a list — the screen key is skipped
      }),
    );
    renderViewsProbe();
    expect(JSON.parse(screen.getByTestId('views').textContent ?? '{}')).toEqual({
      devices: [
        { name: 'Good', filters: { q: 'x' } },
        { name: 'Full', filters: {}, tableColumns: { hidden: ['site'] }, density: 'compact' },
      ],
    });
  });

  it('drops a corrupt local copy instead of trusting it', () => {
    localStorage.setItem('nt-saved-views', '{not json');
    renderViewsProbe();
    expect(screen.getByTestId('views').textContent).toBe('{}');
  });

  it('persists a change to localStorage immediately and PUTs it with the shell keys after the debounce', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({}),
    });
    vi.stubGlobal('fetch', fetchMock);
    mockGetSettings.mockResolvedValue({
      density: 'compact',
      inventoryView: 'Unified table',
      showPlatformTags: true,
      workspaceName: 'Meridian Health',
      pollIntervalSec: 60,
    });
    render(
      <SettingsProvider>
        <ViewsProbe />
      </SettingsProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'save-view' }));

    const expected = { devices: [{ name: 'WAN focus', filters: { q: 'wan' }, density: 'compact' }] };
    // Synchronous halves: context state and the localStorage copy.
    expect(JSON.parse(screen.getByTestId('views').textContent ?? '{}')).toEqual(expected);
    expect(JSON.parse(localStorage.getItem('nt-saved-views') ?? '{}')).toEqual(expected);

    // The network half is trailing-edge debounced; the PUT carries the shell
    // keys so the write validates as one settings update. (The mount-time
    // hydrate GET hits the same fetch stub, so find the PUT.)
    await waitFor(() =>
      expect(fetchMock.mock.calls.some((call) => (call[1] as RequestInit | undefined)?.method === 'PUT')).toBe(true),
    );
    const putCall = fetchMock.mock.calls.find(
      (call) => (call[1] as RequestInit | undefined)?.method === 'PUT',
    ) as [string, RequestInit];
    expect(putCall[0]).toBe('/api/settings');
    expect(JSON.parse(putCall[1].body as string)).toEqual({
      density: 'compact',
      inventoryView: 'Unified table',
      showPlatformTags: true,
      workspaceName: 'Meridian Health',
      pollIntervalSec: 60,
      savedViews: expected,
    });
  });

  it('adopts the server copy of the saved views when the settings payload carries one', async () => {
    const serverViews = { alerts: [{ name: 'P1s', filters: { facets: { sev: ['P1'] } } }] };
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ savedViews: serverViews }),
    });
    vi.stubGlobal('fetch', fetchMock);
    renderViewsProbe();
    await waitFor(() =>
      expect(JSON.parse(screen.getByTestId('views').textContent ?? '{}')).toEqual(serverViews),
    );
    expect(JSON.parse(localStorage.getItem('nt-saved-views') ?? '{}')).toEqual(serverViews);
  });
});
