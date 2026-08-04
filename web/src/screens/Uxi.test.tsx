/**
 * UXI screen — status/site/q filters, share link, load-more, export.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import Uxi from './Uxi';
import { SettingsProvider } from '../app/SettingsContext';
import { ToastProvider } from '../nightdesk';
import { getUxi } from '../api/client';
import type { ScreenListQuery, UxiData } from '../api/client';
import type { UxiSensorRow } from '@hpe/shared';

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
  return { ...actual, getUxi: vi.fn() };
});

const mockGetUxi = vi.mocked(getUxi);

function sensor(over: Partial<UxiSensorRow> = {}): UxiSensorRow {
  return {
    id: 's1',
    name: 'Lobby sensor',
    serial: 'UXI-100',
    model: 'S2',
    site: 'Campus A',
    isOnline: true,
    isTesting: true,
    issueCount: 0,
    issues: [],
    wifiMac: null,
    ethernetMac: null,
    ...over,
  };
}

const FLEET: UxiSensorRow[] = [
  sensor({ id: 'a', name: 'Lobby sensor', serial: 'UXI-100', site: 'Campus A', isOnline: true }),
  sensor({
    id: 'b',
    name: 'Warehouse probe',
    serial: 'UXI-200',
    site: 'DC West',
    isOnline: false,
    issueCount: 1,
    issues: [{ code: 'DHCP', severity: 'warning', status: 'open', context: null }],
  }),
  sensor({ id: 'c', name: 'Idle probe', serial: 'UXI-300', site: 'Campus A', isOnline: true, isTesting: false }),
];

function filterFleet(query?: ScreenListQuery): UxiData {
  let sensors = FLEET.slice();
  const q = query?.q?.trim().toLowerCase() ?? '';
  const status = query?.status?.trim().toLowerCase() ?? '';
  const site = query?.site?.trim().toLowerCase() ?? '';
  const severity = query?.severity?.trim().toLowerCase() ?? '';
  if (q) {
    sensors = sensors.filter((s) =>
      [s.name, s.serial ?? '', s.site ?? ''].join(' ').toLowerCase().includes(q),
    );
  }
  if (site) {
    sensors = sensors.filter((s) => String(s.site ?? '').trim().toLowerCase() === site);
  }
  if (severity) {
    sensors = sensors.filter((s) =>
      s.issues.some((i) => String(i.severity ?? '').toLowerCase() === severity),
    );
  }
  if (status === 'online') sensors = sensors.filter((s) => s.isOnline === true);
  if (status === 'offline') sensors = sensors.filter((s) => s.isOnline === false);
  if (status === 'issues') sensors = sensors.filter((s) => s.issueCount > 0);
  if (status === 'idle') sensors = sensors.filter((s) => s.isOnline === true && s.isTesting === false);

  const limit = query?.limit;
  if (limit != null && limit > 0) {
    const cursor = Math.max(0, Number.parseInt(query?.cursor ?? '0', 10) || 0);
    const slice = sensors.slice(cursor, cursor + limit);
    const next = cursor + limit < sensors.length ? String(cursor + limit) : null;
    return {
      dataSource: 'live',
      syncedAt: '2026-08-04T12:00:00.000Z',
      sensors: slice,
      page: { total: sensors.length, limit, cursor: String(cursor), nextCursor: next },
    };
  }
  return {
    dataSource: 'live',
    syncedAt: '2026-08-04T12:00:00.000Z',
    sensors,
  };
}

function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="loc">{`${loc.pathname}${loc.search}`}</div>;
}

function renderUxi(initial = '/uxi') {
  return render(
    <MemoryRouter initialEntries={[initial]} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <ToastProvider>
        <SettingsProvider>
          <Routes>
            <Route
              path="/uxi"
              element={
                <>
                  <Uxi />
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

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('Uxi filters, share, load-more', () => {
  beforeEach(() => {
    mockGetUxi.mockImplementation(async (query) => filterFleet(query));
  });

  it('filters sensors by name/serial/site and exports only matching rows', async () => {
    const createObjectURL = vi.fn(() => 'blob:uxi');
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    renderUxi();
    expect(await screen.findByText('Lobby sensor')).toBeTruthy();
    expect(screen.getByText('Warehouse probe')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Filter UXI sensors'), { target: { value: 'warehouse' } });
    await waitFor(() => expect(screen.queryByText('Lobby sensor')).toBeNull());
    expect(screen.getByText('Warehouse probe')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }));
    await waitFor(() => expect(createObjectURL).toHaveBeenCalled());
    expect(click).toHaveBeenCalled();
    click.mockRestore();
  });

  it('initializes q from the URL and offers Copy filter link', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    renderUxi('/uxi?q=UXI-200');
    expect(await screen.findByText('Warehouse probe')).toBeTruthy();
    expect(screen.queryByText('Lobby sensor')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Copy filter link' }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    const copied = String(writeText.mock.calls[0]?.[0] ?? '');
    expect(copied).toContain('q=UXI-200');
  });

  it('status filter narrows to offline sensors and write-back includes status', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    renderUxi('/uxi?status=offline');
    expect(await screen.findByText('Warehouse probe')).toBeTruthy();
    expect(screen.queryByText('Lobby sensor')).toBeNull();
    expect(screen.queryByText('Idle probe')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Copy filter link' }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(String(writeText.mock.calls[0]?.[0] ?? '')).toContain('status=offline');
  });

  it('severity filter narrows to sensors with matching issues and write-back includes severity (Loop 110)', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    renderUxi('/uxi?severity=warning');
    expect(await screen.findByText('Warehouse probe')).toBeTruthy();
    expect(screen.queryByText('Lobby sensor')).toBeNull();
    expect(screen.queryByText('Idle probe')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Copy filter link' }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(String(writeText.mock.calls[0]?.[0] ?? '')).toContain('severity=warning');
  });

  it('Load more appends the next page when nextCursor is present', async () => {
    mockGetUxi.mockImplementation(async (query) => {
      /* Force tiny pages so Load more appears on the 3-sensor fleet. */
      return filterFleet({ ...query, limit: 1, cursor: query?.cursor });
    });

    renderUxi();
    expect(await screen.findByText('Lobby sensor')).toBeTruthy();
    expect(screen.queryByText('Warehouse probe')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await waitFor(() => expect(screen.getByText('Warehouse probe')).toBeTruthy());
    expect(mockGetUxi.mock.calls.some((c) => c[0]?.cursor === '1')).toBe(true);
  });
});

/* Loop 136 — Status chip row toggles the same status= filter as the Select. */
describe('UXI status chips (Loop 136)', () => {
  it('status chips filter the table and write status back to the URL', async () => {
    /* Return the full fleet so chip counts stay visible while a status is active
     * (client-side status pass mirrors Sites health chips). */
    mockGetUxi.mockResolvedValue({
      dataSource: 'live',
      syncedAt: '2026-08-04T12:00:00.000Z',
      sensors: FLEET.slice(),
    });

    renderUxi('/uxi');
    expect(await screen.findByText('Lobby sensor')).toBeTruthy();
    const chips = screen.getByRole('group', { name: 'Sensor status' });
    const offline = within(chips).getByRole('button', { name: /Offline/i });
    expect(offline.getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(offline);
    await waitFor(() => expect(screen.getByText('Warehouse probe')).toBeTruthy());
    expect(screen.queryByText('Lobby sensor')).toBeNull();
    expect(screen.queryByText('Idle probe')).toBeNull();
    expect(offline.getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(offline);
    await waitFor(() => expect(screen.getByText('Lobby sensor')).toBeTruthy());
    expect(screen.getByText('Warehouse probe')).toBeTruthy();
    expect(offline.getAttribute('aria-pressed')).toBe('false');
  });

  it('Clear filters also clears severity', async () => {
    mockGetUxi.mockImplementation(async (query) => filterFleet(query));
    renderUxi('/uxi?status=offline&severity=warning&q=zzz');
    expect(await screen.findByRole('button', { name: 'Clear filters' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    await waitFor(() => expect(screen.getByText('Lobby sensor')).toBeTruthy());
    expect(screen.getByText('Warehouse probe')).toBeTruthy();
  });
});

/* Loop 146 — Severity chip row toggles the same severity= filter as the Select. */
describe('UXI severity chips (Loop 146)', () => {
  it('severity chips filter the table and write severity back to the URL', async () => {
    mockGetUxi.mockResolvedValue({
      dataSource: 'live',
      syncedAt: '2026-08-04T12:00:00.000Z',
      sensors: FLEET.slice(),
    });

    renderUxi('/uxi');
    expect(await screen.findByText('Lobby sensor')).toBeTruthy();
    const chips = screen.getByRole('group', { name: 'Sensor issue severity' });
    const warning = within(chips).getByRole('button', { name: /Warning/i });
    expect(warning.getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(warning);
    await waitFor(() => expect(screen.getByTestId('loc').textContent).toContain('severity=warning'));
    expect(screen.getByText('Warehouse probe')).toBeTruthy();
    expect(screen.queryByText('Lobby sensor')).toBeNull();
    expect(screen.queryByText('Idle probe')).toBeNull();
    expect(warning.getAttribute('aria-pressed')).toBe('true');
    await waitFor(() => {
      expect((screen.getByLabelText('Issue severity') as HTMLSelectElement).value).toBe('warning');
    });

    fireEvent.click(warning);
    await waitFor(() => expect(screen.getByTestId('loc').textContent).not.toContain('severity='));
    expect(screen.getByText('Lobby sensor')).toBeTruthy();
    expect(screen.getByText('Warehouse probe')).toBeTruthy();
    expect(warning.getAttribute('aria-pressed')).toBe('false');
  });
});

/* Loop 151 — Site chip row toggles the same site= filter as the Select. */
describe('UXI site chips (Loop 151)', () => {
  it('site chips filter the table and write site back to the URL', async () => {
    mockGetUxi.mockResolvedValue({
      dataSource: 'live',
      syncedAt: '2026-08-04T12:00:00.000Z',
      sensors: FLEET.slice(),
    });

    renderUxi('/uxi');
    expect(await screen.findByText('Lobby sensor')).toBeTruthy();
    expect(screen.getByText('Warehouse probe')).toBeTruthy();

    const chips = screen.getByRole('group', { name: 'Sensor sites' });
    const campus = within(chips).getByRole('button', { name: /Campus A/i });
    expect(campus.getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(campus);
    await waitFor(() => expect(screen.getByTestId('loc').textContent).toContain('site=Campus'));
    expect(screen.getByText('Lobby sensor')).toBeTruthy();
    expect(screen.getByText('Idle probe')).toBeTruthy();
    expect(screen.queryByText('Warehouse probe')).toBeNull();
    expect(campus.getAttribute('aria-pressed')).toBe('true');
    await waitFor(() => {
      expect((screen.getByLabelText('Sensor site') as HTMLSelectElement).value).toBe('Campus A');
    });

    fireEvent.click(campus);
    await waitFor(() => expect(screen.getByTestId('loc').textContent).not.toContain('site='));
    expect(screen.getByText('Warehouse probe')).toBeTruthy();
    expect(campus.getAttribute('aria-pressed')).toBe('false');
  });
});


/* Loop 159 — LIVE blend honesty + bulk Export selected. */
describe('UXI Loop 159 residuals', () => {
  it('stamps LIVE on pure live fleet', async () => {
    mockGetUxi.mockResolvedValue({
      dataSource: 'live',
      syncedAt: '2026-08-04T12:00:00.000Z',
      sensors: FLEET.slice(),
    });
    renderUxi();
    expect(await screen.findByText('LIVE')).toBeTruthy();
  });

  it('stamps LIVE when uxi arrives via blend', async () => {
    mockGetUxi.mockResolvedValue({
      dataSource: 'demo',
      blended: ['uxi'],
      sensors: FLEET.slice(),
    });
    renderUxi();
    expect(await screen.findByText('LIVE')).toBeTruthy();
  });

  it('shows bulk bar for selection: Export selected + Clear', async () => {
    const createObjectURL = vi.fn(() => 'blob:uxi-selected');
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL });

    mockGetUxi.mockResolvedValue({
      dataSource: 'live',
      syncedAt: '2026-08-04T12:00:00.000Z',
      sensors: FLEET.slice(),
    });
    const { container } = renderUxi();
    expect(await screen.findByText('Lobby sensor')).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'UXI sensor selection actions' })).toBeNull();

    const first = container.querySelector('tbody tr') as HTMLElement;
    expect(first).toBeTruthy();
    first.focus();
    fireEvent.keyDown(first, { key: 'x' });

    const bar = await screen.findByRole('region', { name: 'UXI sensor selection actions' });
    expect(within(bar).getByText('1 SELECTED')).toBeTruthy();
    fireEvent.click(within(bar).getByRole('button', { name: 'Export selected' }));
    expect(await screen.findByText(/Exported 1 selected sensor/)).toBeTruthy();
    expect(createObjectURL).toHaveBeenCalled();

    fireEvent.click(within(bar).getByRole('button', { name: 'Clear' }));
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: 'UXI sensor selection actions' })).toBeNull(),
    );
  });
});

/* Loop 169 — bulk Copy serials (Devices Copy serials pattern). */
describe('UXI Loop 169 residuals', () => {
  it('Copy serials writes unique newline-joined published serials', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    mockGetUxi.mockResolvedValue({
      dataSource: 'live',
      syncedAt: '2026-08-04T12:00:00.000Z',
      sensors: [
        sensor({ id: 'a', name: 'Lobby sensor', serial: 'UXI-100' }),
        sensor({ id: 'b', name: 'Dup serial probe', serial: 'UXI-100' }),
        sensor({ id: 'c', name: 'No serial', serial: null }),
        sensor({ id: 'd', name: 'Warehouse probe', serial: 'UXI-200' }),
      ],
    });
    const { container } = renderUxi();
    expect(await screen.findByText('Lobby sensor')).toBeTruthy();

    const rows = container.querySelectorAll('tbody tr');
    expect(rows.length).toBeGreaterThanOrEqual(4);
    for (const row of Array.from(rows).slice(0, 4)) {
      (row as HTMLElement).focus();
      fireEvent.keyDown(row, { key: 'x' });
    }

    const bar = await screen.findByRole('region', { name: 'UXI sensor selection actions' });
    fireEvent.click(within(bar).getByRole('button', { name: 'Copy serials' }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(String(writeText.mock.calls[0]?.[0] ?? '')).toBe('UXI-100\nUXI-200');
    expect(await screen.findByText(/Copied 2 serials/)).toBeTruthy();
  });
});

/* Loop 175 — bulk Copy selection link (?ids=) + clearable chip. */
describe('UXI Loop 175 residuals', () => {
  it('Copy selection link writes ids= and the deep link filters the fleet', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    mockGetUxi.mockResolvedValue({
      dataSource: 'live',
      syncedAt: '2026-08-04T12:00:00.000Z',
      sensors: FLEET.slice(),
    });
    const { container } = renderUxi('/uxi');
    expect(await screen.findByText('Lobby sensor')).toBeTruthy();
    expect(await screen.findByText('Warehouse probe')).toBeTruthy();

    const first = container.querySelector('tbody tr') as HTMLElement;
    expect(first).toBeTruthy();
    first.focus();
    fireEvent.keyDown(first, { key: 'x' });

    const bar = await screen.findByRole('region', { name: 'UXI sensor selection actions' });
    fireEvent.click(within(bar).getByRole('button', { name: 'Copy selection link' }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(String(writeText.mock.calls[0]![0])).toMatch(/ids=/);
    expect(String(writeText.mock.calls[0]![0])).toContain('a');
    expect(await screen.findByText(/Selection link copied/)).toBeTruthy();
  });

  it('deep-links ?ids= and shows a clearable selection chip', async () => {
    mockGetUxi.mockResolvedValue({
      dataSource: 'live',
      syncedAt: '2026-08-04T12:00:00.000Z',
      sensors: FLEET.slice(),
    });
    renderUxi(`/uxi?ids=${encodeURIComponent('a')}`);
    expect(await screen.findByText('Lobby sensor')).toBeTruthy();
    expect(screen.queryByText('Warehouse probe')).toBeNull();
    const chip = screen.getByRole('group', { name: 'Selection deep link' });
    expect(within(chip).getByText(/1 selected sensor/)).toBeTruthy();
    fireEvent.click(within(chip).getByRole('button'));
    await waitFor(() => expect(screen.getByTestId('loc').textContent).not.toMatch(/ids=/));
    expect(await screen.findByText('Warehouse probe')).toBeTruthy();
  });
});

/* Loop 192 — keyboard shortcuts help on the sensors table. */
describe('UXI Loop 192 residuals', () => {
  it('exposes keyboard shortcuts help beside the sensors table', async () => {
    mockGetUxi.mockResolvedValue({
      dataSource: 'live',
      syncedAt: '2026-08-04T12:00:00.000Z',
      sensors: FLEET.slice(),
    });
    renderUxi('/uxi');
    expect(await screen.findByText('Lobby sensor')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Keyboard shortcuts' })).toBeTruthy();
  });
});
