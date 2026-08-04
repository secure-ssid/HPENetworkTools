import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import Sites from './Sites';
import { SettingsProvider } from '../app/SettingsContext';
import { ToastProvider } from '../nightdesk';
import { getSites } from '../api/client';
import { downloadApiCsv } from '../lib/downloadApiCsv';
import type { SiteRow } from '@hpe/shared';

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
  return { ...actual, getSites: vi.fn() };
});

vi.mock('../lib/downloadApiCsv', () => ({
  downloadApiCsv: vi.fn(),
}));

const mockGetSites = vi.mocked(getSites);
const mockDownloadApiCsv = vi.mocked(downloadApiCsv);

/** A site as a live plane reports it — sparse, some fields never arrive. */
function liveSite(over: Partial<SiteRow> = {}): SiteRow {
  return {
    id: 'campus-01',
    name: 'Site A',
    subnet: '—',
    planes: [{ name: 'CENTRAL', tone: 'accent' }],
    mix: '4 ap',
    devices: 4,
    clients: '—',
    health: '98%',
    healthPct: '98%',
    tone: 'ok',
    alerts: '—',
    alertTone: 'neutral',
    sync: '—',
    ...over,
  };
}

function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="loc">{`${loc.pathname}${loc.search}`}</div>;
}

function renderSites(initial = '/sites') {
  return render(
    <MemoryRouter
      initialEntries={[initial]}
      future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
    >
      <ToastProvider>
        <SettingsProvider>
          <Routes>
            <Route
              path="/sites"
              element={
                <>
                  <Sites />
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

/** The footer's mono count node — asserted separately from the source stamp. */
const COUNT_RE = /^\d+ of \d+ sites · \d+ devices indexed$/;

describe('Sites footer provenance', () => {
  it('stamps a live payload LIVE · SYNCED beside — not inside — the count', async () => {
    mockGetSites.mockResolvedValue({
      dataSource: 'live',
      syncedAt: '2026-03-04T09:05:00.000Z',
      stats: [],
      sites: [liveSite()],
    });

    renderSites();

    await waitFor(() => expect(screen.getByText('Site A')).toBeTruthy());
    // Two distinct nodes: a claim, and the source that made it. The count text
    // must not have the stamp spliced into it.
    const count = screen.getByText(COUNT_RE);
    const stamp = screen.getByText(/^LIVE · SYNCED /);
    expect(count).not.toBe(stamp);
    expect(count.textContent).toBe('1 of 1 sites · 4 devices indexed');
    expect(screen.queryByText('DEMO FIXTURE')).toBeNull();
  });

  it('stamps an authored payload DEMO FIXTURE and never borrows a live sync time', async () => {
    mockGetSites.mockResolvedValue({
      dataSource: 'demo',
      // A demo envelope may still carry a sync time; the footer must not
      // promote it to a live claim.
      syncedAt: '2026-03-04T09:05:00.000Z',
      stats: [],
      sites: [liveSite(), liveSite({ id: 'campus-02', name: 'Site B', devices: 9 })],
    });

    renderSites();

    await waitFor(() => expect(screen.getByText('Site A')).toBeTruthy());
    const stamp = screen.getByText('DEMO FIXTURE');
    const count = screen.getByText(COUNT_RE);
    expect(count).not.toBe(stamp);
    expect(count.textContent).toBe('2 of 2 sites · 13 devices indexed');
    expect(screen.queryByText(/^LIVE · SYNCED /)).toBeNull();
  });
});

describe('Sites health rail', () => {
  it('renders an unreported health as "—" with the 70px rail still mounted and unfilled', async () => {
    mockGetSites.mockResolvedValue({
      dataSource: 'live',
      stats: [],
      sites: [
        liveSite({ id: 'lakeshore', name: 'Stale Site', health: null, healthPct: '—', tone: 'stale' }),
        liveSite({ id: 'campus-01', name: 'Site A' }),
      ],
    });

    const { container } = renderSites();

    await waitFor(() => expect(screen.getByText('Stale Site')).toBeTruthy());

    const cell = container.querySelector<HTMLElement>(
      '[title="health not reported by the managing plane"]',
    );
    expect(cell).toBeTruthy();
    // The rail keeps the column aligned even with nothing to plot…
    const rail = cell!.firstElementChild as HTMLElement;
    expect(rail.classList.contains('nt-health-track')).toBe(true);
    // …and carries no fill, so no percentage is implied.
    expect(rail.children.length).toBe(0);
    expect(within(cell!).getByText('—')).toBeTruthy();

    // The reported site keeps its fill and gets no "not reported" title.
    expect(screen.getByText('98%')).toBeTruthy();
    expect(
      container.querySelectorAll('[title="health not reported by the managing plane"]'),
    ).toHaveLength(1);
  });
});

describe('Sites live rows', () => {
  it('counts the indexed devices from the rows and names an unreported manager', async () => {
    mockGetSites.mockResolvedValue({
      dataSource: 'live',
      stats: [{ label: 'Sites', value: '2', delta: '2 reported', tone: 'neutral' }],
      sites: [
        liveSite(),
        liveSite({ id: 'campus-02', name: 'Site B', planes: [], devices: 9 }),
      ],
    });

    renderSites();

    await waitFor(() => expect(screen.getByText('Site A')).toBeTruthy());
    // 4 + 9 from the rows themselves — never the authored 418 estate total.
    expect(screen.getByText('2 of 2 sites · 13 devices indexed')).toBeTruthy();
    expect(screen.getByText('not reported')).toBeTruthy();
    // The authored "Ten sites" prose belongs to the fixtures, not a live estate.
    expect(screen.getByText('2 sites, and the plane each one actually answers to.')).toBeTruthy();
  });
});

/* Sites are derived from the merged device inventory, so a linked plane that
 * contributed no devices contributes no sites — its locations are absent from
 * the table rather than listed empty. The screen showed a count and an
 * unqualified subtitle over that, with nothing saying the estate was short. */
describe('Sites unread-inventory disclosure', () => {
  it('names the planes that contributed no inventory and qualifies the count', async () => {
    mockGetSites.mockResolvedValue({
      dataSource: 'live',
      syncedAt: '2026-03-04T09:05:00.000Z',
      stats: [],
      sites: [liveSite()],
      missingSources: ['CENTRAL', 'MIST'],
    });

    renderSites();

    await waitFor(() => expect(screen.getByText('Site A')).toBeTruthy());
    expect(screen.getByText(/2 linked planes contributed no inventory: CENTRAL, MIST/)).toBeTruthy();
    // 'unknown', not 'absent' — the table is short, it is not complete.
    expect(screen.getByText(/absent\s+from the table below — not listed as empty/)).toBeTruthy();
    // The count must not present a partial estate as the whole one.
    expect(screen.getByText(/1 site so far, and the plane each one actually answers to\./)).toBeTruthy();
  });

  it('says nothing when every linked plane reported', async () => {
    mockGetSites.mockResolvedValue({
      dataSource: 'live',
      syncedAt: '2026-03-04T09:05:00.000Z',
      stats: [],
      sites: [liveSite()],
      missingSources: [],
    });

    renderSites();

    await waitFor(() => expect(screen.getByText('Site A')).toBeTruthy());
    expect(screen.queryByText(/contributed no inventory/)).toBeNull();
    expect(screen.queryByText(/so far/)).toBeNull();
    expect(screen.getByText(/1 site, and the plane each one actually answers to\./)).toBeTruthy();
  });

  // An empty table with an unread plane behind it is not "no sites exist".
  it('does not let an empty table read as an estate with no sites', async () => {
    mockGetSites.mockResolvedValue({
      dataSource: 'live',
      syncedAt: '2026-03-04T09:05:00.000Z',
      stats: [],
      sites: [],
      missingSources: ['CENTRAL'],
    });

    renderSites();

    await waitFor(() => expect(screen.getByText('No sites from the planes that answered')).toBeTruthy());
    expect(
      screen.getByText(/CENTRAL contributed no inventory, so any site there is unknown rather than absent\./),
    ).toBeTruthy();
    expect(screen.queryByText('Nothing matches that filter')).toBeNull();
  });
});

describe('Sites filter persistence + load more', () => {
  it('seeds filters from the URL and writes q/plane back as they change', async () => {
    mockGetSites.mockResolvedValue({
      dataSource: 'live',
      syncedAt: '2026-03-04T09:05:00.000Z',
      stats: [],
      sites: [
        liveSite(),
        liveSite({ id: 'northgate', name: 'Branch West', planes: [{ name: 'MIST', tone: 'accent' }] }),
      ],
    });

    renderSites('/sites?q=Branch&plane=MIST');
    await waitFor(() => expect(screen.getByText('Branch West')).toBeTruthy());
    expect(screen.queryByText('Site A')).toBeNull();
    expect(screen.getByTestId('loc').textContent).toContain('q=Branch');
    expect(screen.getByTestId('loc').textContent).toContain('plane=MIST');

    fireEvent.change(screen.getByRole('textbox', { name: 'Filter sites' }), {
      target: { value: 'Site' },
    });
    await waitFor(() => expect(screen.getByTestId('loc').textContent).toContain('q=Site'));
    expect(screen.getByTestId('loc').textContent).toContain('plane=MIST');
  });

  it('seeds health filter from the URL, filters rows, and writes health back', async () => {
    mockGetSites.mockResolvedValue({
      dataSource: 'live',
      syncedAt: '2026-03-04T09:05:00.000Z',
      stats: [],
      sites: [
        liveSite({ id: 'campus-01', name: 'Healthy HQ', tone: 'ok' }),
        liveSite({
          id: 'campus-02',
          name: 'Critical Clinic',
          health: '42%',
          healthPct: '42%',
          tone: 'bad',
        }),
        liveSite({
          id: 'lakeshore',
          name: 'Unreported Site',
          health: null,
          healthPct: '—',
          tone: 'stale',
        }),
      ],
    });

    renderSites('/sites?health=bad');
    await waitFor(() => expect(screen.getByText('Critical Clinic')).toBeTruthy());
    expect(screen.queryByText('Healthy HQ')).toBeNull();
    expect(screen.queryByText('Unreported Site')).toBeNull();
    expect(screen.getByTestId('loc').textContent).toContain('health=bad');

    fireEvent.change(screen.getByRole('combobox', { name: 'Filter by health' }), {
      target: { value: 'stale' },
    });
    await waitFor(() => expect(screen.getByText('Unreported Site')).toBeTruthy());
    expect(screen.queryByText('Critical Clinic')).toBeNull();
    expect(screen.getByTestId('loc').textContent).toContain('health=stale');
  });

  /* Loop 130 — Health chip row toggles the same health= filter as the Select. */
  it('health chips filter the table and write health back to the URL', async () => {
    mockGetSites.mockResolvedValue({
      dataSource: 'live',
      syncedAt: '2026-03-04T09:05:00.000Z',
      stats: [],
      sites: [
        liveSite({ id: 'campus-01', name: 'Healthy HQ', tone: 'ok' }),
        liveSite({
          id: 'campus-02',
          name: 'Critical Clinic',
          health: '42%',
          healthPct: '42%',
          tone: 'bad',
        }),
        liveSite({
          id: 'lakeshore',
          name: 'Unreported Site',
          health: null,
          healthPct: '—',
          tone: 'stale',
        }),
      ],
    });

    renderSites('/sites');
    await waitFor(() => expect(screen.getByText('Healthy HQ')).toBeTruthy());
    const chips = screen.getByRole('group', { name: 'Site health' });
    const critical = within(chips).getByRole('button', { name: /Critical/i });
    expect(critical.getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(critical);
    await waitFor(() => expect(screen.getByText('Critical Clinic')).toBeTruthy());
    expect(screen.queryByText('Healthy HQ')).toBeNull();
    expect(screen.getByTestId('loc').textContent).toContain('health=bad');
    expect(critical.getAttribute('aria-pressed')).toBe('true');

    // Toggle off restores the full universe.
    fireEvent.click(critical);
    await waitFor(() => expect(screen.getByText('Healthy HQ')).toBeTruthy());
    expect(screen.getByText('Critical Clinic')).toBeTruthy();
    expect(screen.getByTestId('loc').textContent).not.toContain('health=');
  });

  /* Loop 139 — Plane chip row toggles the same plane= filter as the Select. */
  it('plane chips filter the table and write plane back to the URL', async () => {
    mockGetSites.mockResolvedValue({
      dataSource: 'live',
      syncedAt: '2026-03-04T09:05:00.000Z',
      stats: [],
      sites: [
        liveSite({
          id: 'campus-01',
          name: 'Central Campus',
          planes: [{ name: 'CENTRAL', tone: 'accent' }],
        }),
        liveSite({
          id: 'campus-02',
          name: 'Mist Branch',
          planes: [{ name: 'MIST', tone: 'accent' }],
        }),
        liveSite({
          id: 'northgate',
          name: 'Dual Site',
          planes: [
            { name: 'CENTRAL', tone: 'accent' },
            { name: 'MIST', tone: 'accent' },
          ],
        }),
      ],
    });

    renderSites('/sites');
    await waitFor(() => expect(screen.getByText('Central Campus')).toBeTruthy());
    const chips = screen.getByRole('group', { name: 'Site plane' });
    const mist = within(chips).getByRole('button', { name: /MIST/i });
    expect(mist.getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(mist);
    await waitFor(() => expect(screen.getByText('Mist Branch')).toBeTruthy());
    expect(screen.getByText('Dual Site')).toBeTruthy();
    expect(screen.queryByText('Central Campus')).toBeNull();
    expect(screen.getByTestId('loc').textContent).toContain('plane=MIST');
    expect(mist.getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(mist);
    await waitFor(() => expect(screen.getByText('Central Campus')).toBeTruthy());
    expect(screen.getByText('Mist Branch')).toBeTruthy();
    expect(screen.getByTestId('loc').textContent).not.toContain('plane=');
  });

  it('Copy filter link includes health with q and plane', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    mockGetSites.mockResolvedValue({
      dataSource: 'live',
      syncedAt: '2026-03-04T09:05:00.000Z',
      stats: [],
      sites: [liveSite({ name: 'Branch West', planes: [{ name: 'MIST', tone: 'accent' }], tone: 'warn' })],
    });

    renderSites('/sites?q=Branch&plane=MIST&health=warn');
    await waitFor(() => expect(screen.getByText('Branch West')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Copy filter link' }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    const url = String(writeText.mock.calls[0]![0]);
    expect(url).toContain('q=Branch');
    expect(url).toContain('plane=MIST');
    expect(url).toContain('health=warn');
  });

  it('Load more appends the next cursor page without dropping prior rows', async () => {
    mockGetSites.mockImplementation(async (query) => {
      if (query?.cursor === 'page-2') {
        return {
          dataSource: 'live',
          syncedAt: '2026-03-04T09:05:00.000Z',
          stats: [],
          sites: [liveSite({ id: 'campus-02', name: 'Site B', devices: 9 })],
          page: { total: 2, limit: 100, cursor: 'page-2', nextCursor: '' },
        };
      }
      return {
        dataSource: 'live',
        syncedAt: '2026-03-04T09:05:00.000Z',
        stats: [],
        sites: [liveSite()],
        page: { total: 2, limit: 100, cursor: '', nextCursor: 'page-2' },
      };
    });

    renderSites();
    await waitFor(() => expect(screen.getByText('Site A')).toBeTruthy());
    expect(screen.getByText('Loaded 1 of 2')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await waitFor(() => expect(screen.getByText('Site B')).toBeTruthy());
    expect(screen.getByText('Site A')).toBeTruthy();
    expect(screen.getByText('2 of 2 sites · 13 devices indexed')).toBeTruthy();
    expect(mockGetSites.mock.calls.some((c) => c[0]?.cursor === 'page-2')).toBe(true);
  });

  it('passes q/plane/health to getSites and Download server CSV', async () => {
    mockDownloadApiCsv.mockResolvedValue({ ok: true });
    mockGetSites.mockResolvedValue({
      dataSource: 'live',
      syncedAt: '2026-03-04T09:05:00.000Z',
      stats: [],
      sites: [liveSite({ name: 'Branch West', planes: [{ name: 'MIST', tone: 'accent' }], tone: 'warn' })],
    });

    renderSites('/sites?q=Branch&plane=MIST&health=warn');
    await waitFor(() => expect(screen.getByText('Branch West')).toBeTruthy());
    await waitFor(() =>
      expect(
        mockGetSites.mock.calls.some(
          (c) => c[0]?.q === 'Branch' && c[0]?.plane === 'MIST' && c[0]?.health === 'warn',
        ),
      ).toBe(true),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Download server CSV' }));
    await waitFor(() =>
      expect(mockDownloadApiCsv).toHaveBeenCalledWith(
        '/api/sites/export?q=Branch&plane=MIST&health=warn',
        'sites.csv',
      ),
    );
  });
});

/* Loop 163 — LIVE badge honesty + multi-select Export selected. */
describe('Sites Loop 163 residuals', () => {
  it('stamps LIVE on pure live sites', async () => {
    mockGetSites.mockResolvedValue({
      dataSource: 'live',
      syncedAt: '2026-03-04T09:05:00.000Z',
      stats: [],
      sites: [liveSite()],
    });
    renderSites();
    expect(await screen.findByText('LIVE')).toBeTruthy();
  });

  it('stamps LIVE when sites arrive via blend', async () => {
    mockGetSites.mockResolvedValue({
      dataSource: 'demo',
      blended: ['sites'],
      syncedAt: '2026-03-04T09:05:00.000Z',
      stats: [],
      sites: [liveSite()],
    });
    renderSites();
    expect(await screen.findByText('LIVE')).toBeTruthy();
    expect(screen.getByText(/^LIVE · SYNCED /)).toBeTruthy();
  });

  it('hides LIVE on demo fixtures without blend', async () => {
    mockGetSites.mockResolvedValue({
      dataSource: 'demo',
      syncedAt: null,
      stats: [],
      sites: [liveSite()],
    });
    renderSites();
    await waitFor(() => expect(screen.getByText('Site A')).toBeTruthy());
    expect(screen.queryByText('LIVE')).toBeNull();
  });

  it('shows bulk bar for selection: Export selected, Copy names, Copy selection link, Clear', async () => {
    const createObjectURL = vi.fn(() => 'blob:sites-selected');
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    mockGetSites.mockResolvedValue({
      dataSource: 'live',
      syncedAt: '2026-03-04T09:05:00.000Z',
      stats: [],
      sites: [liveSite(), liveSite({ id: 'campus-02', name: 'Site B', devices: 9 })],
    });
    const { container } = renderSites();
    expect(await screen.findByText('Site A')).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Site selection actions' })).toBeNull();

    const first = container.querySelector('tbody tr') as HTMLElement;
    expect(first).toBeTruthy();
    first.focus();
    fireEvent.keyDown(first, { key: 'x' });

    const bar = await screen.findByRole('region', { name: 'Site selection actions' });
    expect(within(bar).getByText('1 SELECTED')).toBeTruthy();
    expect(within(bar).getByRole('button', { name: 'Copy names' })).toBeTruthy();
    fireEvent.click(within(bar).getByRole('button', { name: 'Export selected' }));
    expect(await screen.findByText(/Exported 1 selected site/)).toBeTruthy();
    expect(createObjectURL).toHaveBeenCalled();

    fireEvent.click(within(bar).getByRole('button', { name: 'Copy selection link' }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(String(writeText.mock.calls[0]![0])).toMatch(/ids=campus-01|ids=campus%2D01|ids=/);

    fireEvent.click(within(bar).getByRole('button', { name: 'Clear' }));
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: 'Site selection actions' })).toBeNull(),
    );
  });

  it('deep-links ?ids= and shows a clearable selection chip', async () => {
    mockGetSites.mockResolvedValue({
      dataSource: 'live',
      syncedAt: '2026-03-04T09:05:00.000Z',
      stats: [],
      sites: [liveSite(), liveSite({ id: 'campus-02', name: 'Site B', devices: 9 })],
    });
    renderSites(`/sites?ids=${encodeURIComponent('campus-01')}`);
    expect(await screen.findByText('Site A')).toBeTruthy();
    expect(screen.queryByText('Site B')).toBeNull();
    const chip = screen.getByRole('button', { name: /1 selected site/i });
    fireEvent.click(chip);
    await waitFor(() => expect(screen.getByText('Site B')).toBeTruthy());
    expect(screen.getByTestId('loc').textContent).not.toMatch(/ids=/);
  });
});



/* Loop 186 — Sites bulk Copy names. */
describe('Sites bulk Copy names (Loop 186)', () => {
  it('copies unique newline-joined site names from the selection', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    mockGetSites.mockResolvedValue({
      dataSource: 'live',
      syncedAt: '2026-03-04T09:05:00.000Z',
      stats: [],
      sites: [liveSite(), liveSite({ id: 'campus-02', name: 'Site B', devices: 9 })],
    });
    const { container } = renderSites();
    expect(await screen.findByText('Site A')).toBeTruthy();

    const first = container.querySelector('tbody tr') as HTMLElement;
    first.focus();
    fireEvent.keyDown(first, { key: 'x' });

    const bar = await screen.findByRole('region', { name: 'Site selection actions' });
    expect(within(bar).getByRole('button', { name: 'Copy names' })).toBeTruthy();
    fireEvent.click(within(bar).getByRole('button', { name: 'Copy names' }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(String(writeText.mock.calls[0]![0])).toBe('Site A');
    expect(await screen.findByText(/Copied 1 name/)).toBeTruthy();
  });
});


/* Loop 214 — sites selection-empty Clear selection filter CTA. */
describe('Sites Loop 214 residuals', () => {
  it('offers Clear selection filter when ids deep link matches nothing', async () => {
    mockGetSites.mockResolvedValue({
      dataSource: 'live',
      syncedAt: '2026-03-04T09:05:00.000Z',
      stats: [],
      sites: [liveSite(), liveSite({ id: 'campus-02', name: 'Site B', devices: 9 })],
    });
    renderSites(`/sites?ids=${encodeURIComponent('site-missing-zzz')}`);
    expect(await screen.findByText('No sites match this selection')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Clear selection filter' }));
    await waitFor(() => expect(screen.getByTestId('loc').textContent).not.toMatch(/ids=/));
    await waitFor(() => expect(screen.getByText('Site A')).toBeTruthy());
    expect(screen.getByText('Site B')).toBeTruthy();
    expect(screen.queryByText('No sites match this selection')).toBeNull();
  });
});
