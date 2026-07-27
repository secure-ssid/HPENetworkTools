import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Sites from './Sites';
import { SettingsProvider } from '../app/SettingsContext';
import { ToastProvider } from '../nightdesk';
import { getSites } from '../api/client';
import type { SiteRow } from '../../../shared';

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

const mockGetSites = vi.mocked(getSites);

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

function renderSites() {
  return render(
    <MemoryRouter>
      <ToastProvider>
        <SettingsProvider>
          <Sites />
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
    expect(rail.style.width).toBe('70px');
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
