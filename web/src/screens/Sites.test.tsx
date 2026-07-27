import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
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
