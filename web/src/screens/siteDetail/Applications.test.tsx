/**
 * Application-visibility section tests: the section fetches once on mount for
 * a Central site and renders the shared aggregations — the risk strip, the
 * watchlist split, top talkers and the share-of-largest rollup — with the
 * estimates caveat verbatim; every no-table outcome (empty / failed /
 * not-fetched / not-reported / a broken read) is its own honest sentence,
 * and a non-Central site never spends a call.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SiteApplications } from './Applications';
import { getSiteApplications } from '../../api/client';
import { downloadApiCsv } from '../../lib/downloadApiCsv';
import { ToastProvider } from '../../nightdesk';
import { DPI_BYTES_ARE_ESTIMATES, SITE_APPLICATIONS_DEMO } from '@hpe/shared';
import type { SiteAppRow, SiteApplicationsLive } from '@hpe/shared';

vi.mock('../../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/client')>();
  return { ...actual, getSiteApplications: vi.fn() };
});

vi.mock('../../lib/downloadApiCsv', () => ({
  downloadApiCsv: vi.fn(),
}));

const mockGet = vi.mocked(getSiteApplications);
const mockDownloadApiCsv = vi.mocked(downloadApiCsv);

const DEMO = SITE_APPLICATIONS_DEMO['campus-01']!; // 12 apps, two suspicious, one unclassified

beforeEach(() => {
  mockGet.mockResolvedValue({ kind: 'ok', applications: DEMO });
  mockDownloadApiCsv.mockResolvedValue({ ok: true });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderSection(centralClaimed = true, live = false) {
  return render(
    <ToastProvider>
      <SiteApplications centralClaimed={centralClaimed} siteKey="campus-01" live={live} />
    </ToastProvider>,
  );
}

/** Wait out the on-mount read. */
async function settle() {
  await waitFor(() => expect(mockGet).toHaveBeenCalledWith('campus-01'));
}

/** A synthetic flagged-known row for the watchlist cap test. */
function flaggedApp(i: number): SiteAppRow {
  return {
    id: `app-flag-${i}`,
    name: `Flagged App ${String(i).padStart(2, '0')}`,
    riskRaw: 'high',
    risk: 'suspicious',
    state: 'active',
    rxBytes: 1000 + i,
    txBytes: 0,
    totalBytes: 1000 + i,
    categories: ['Peer-to-Peer'],
    applicationHostType: null,
    destLocation: [],
    experience: null,
    lastUsedAt: null,
    tlsVersion: null,
    certificateExpiryAt: null,
  };
}

describe('SiteApplications — the ok table', () => {
  it('fetches on mount and renders the risk strip, watchlist, talkers, rollup and the caveats', async () => {
    renderSection();
    await settle();

    // Provenance and the meta count.
    expect(screen.getByText('12 APPS · CENTRAL DPI')).toBeTruthy();
    expect(screen.getByText(/CENTRAL · READ \d{2}:\d{2}/)).toBeTruthy();

    // The risk strip: every bucket, worst first, zeros included.
    expect(screen.getByText('2 suspicious')).toBeTruthy();
    expect(screen.getByText('1 moderate')).toBeTruthy();
    expect(screen.getByText('3 low')).toBeTruthy();
    expect(screen.getByText('6 trustworthy')).toBeTruthy();
    expect(screen.getByText('0 unknown')).toBeTruthy();

    // The watchlist split: the unclassified investigation queue leads, with
    // its reason; the flagged-known rows follow with the plane's own risk
    // word beside the folded bucket. (A flagged app also appears in the top
    // talkers below — the two lists are different cuts of the same table.)
    expect(screen.getByText(/Aruba doesn't know what this is and doesn't like it/)).toBeTruthy();
    expect(screen.getAllByText('unknown-tcp-4410')).toHaveLength(2);
    expect(screen.getAllByText('BitTorrent')).toHaveLength(2);
    expect(screen.getByText('plane risk: high')).toBeTruthy();
    expect(screen.getByText('plane risk: very_high')).toBeTruthy();

    // Top talkers: byte-ranked, categories alongside, the null-total app last
    // with an honest dash rather than a zero.
    expect(screen.getByText('Top talkers')).toBeTruthy();
    expect(screen.getByText('Microsoft 365')).toBeTruthy();
    expect(screen.getByText('Epic Hyperspace')).toBeTruthy();
    expect(screen.getByText('NTP')).toBeTruthy();

    // The estimates caveat, verbatim, and the window note.
    expect(screen.getByText(DPI_BYTES_ARE_ESTIMATES)).toBeTruthy();
    expect(screen.getByText(/24 h window — the API refuses anything wider than 7 days/)).toBeTruthy();
  });

  it('sizes the rollup bars as shares of the LARGEST category, never percents of the total', async () => {
    const { container } = renderSection();
    await settle();

    // Scope to the rollup's grid rows — a talker row can carry the same word
    // as a category label.
    const rollupRows = [...container.querySelectorAll('.nt-dpi-grid')];
    const rowFor = (category: string) => {
      const row = rollupRows.find((r) => r.firstElementChild?.textContent === category);
      expect(row).toBeTruthy();
      return row!.querySelector('.nt-bar-fill') as HTMLElement;
    };
    // Collaboration is the largest category (8.62 GB of app bytes) — the 100%
    // bar; Streaming's 4.62 GB is 54% of it, and the note says why.
    expect(rowFor('Collaboration').style.getPropertyValue('--nd-health')).toBe('100%');
    expect(rowFor('Streaming').style.getPropertyValue('--nd-health')).toBe('54%');
    expect(screen.getByText(/share of the largest category/)).toBeTruthy();
    // Uncategorized is the synthetic bucket for apps the plane could not classify.
    expect(rowFor('Uncategorized')).toBeTruthy();
  });

  it('caps the flagged-known watchlist at 25 and counts the remainder', async () => {
    const apps = Array.from({ length: 30 }, (_, i) => flaggedApp(i));
    const payload: SiteApplicationsLive = {
      siteId: 'campus-01',
      window: DEMO.window,
      apps,
      source: { plane: 'central', at: DEMO.source.at, sections: { apps: 'ok' } },
    };
    mockGet.mockResolvedValue({ kind: 'ok', applications: payload });
    renderSection();
    await settle();

    expect(screen.getAllByText('Flagged App 00')).toHaveLength(2); // watchlist + talkers
    expect(screen.getAllByText('Flagged App 24')).toHaveLength(2);
    expect(screen.queryByText('Flagged App 25')).toBeNull();
    expect(screen.getByText('+5 more flagged, classified apps')).toBeTruthy();
  });

  it('says the table is a prefix when the paged walk did not finish', async () => {
    const payload: SiteApplicationsLive = {
      ...DEMO,
      truncated: true,
      source: {
        ...DEMO.source,
        note: 'applications: the paged walk did not finish — the table is a prefix of the full ranking',
      },
    };
    mockGet.mockResolvedValue({ kind: 'ok', applications: payload });
    renderSection();
    await settle();
    expect(screen.getByText(/prefix of the full ranking/)).toBeTruthy();
  });
});

describe('SiteApplications — the honest no-table outcomes', () => {
  it('a non-Central site says so and never fetches', () => {
    renderSection(false);
    expect(screen.getByText('No linked plane publishes DPI application data for this site.')).toBeTruthy();
    expect(screen.getByText('NOT REPORTED')).toBeTruthy();
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('an authoritative empty table is an empty answer, not a failure', async () => {
    const payload: SiteApplicationsLive = {
      siteId: 'campus-01',
      window: DEMO.window,
      apps: [],
      source: { plane: 'central', at: DEMO.source.at, sections: { apps: 'empty' } },
    };
    mockGet.mockResolvedValue({ kind: 'ok', applications: payload });
    renderSection();
    await settle();
    expect(
      screen.getByText('Central answered for this site and reported no application traffic in the window.'),
    ).toBeTruthy();
  });

  it('a failed section says the call broke, with the plane note', async () => {
    const payload: SiteApplicationsLive = {
      siteId: 'campus-01',
      window: DEMO.window,
      source: {
        plane: 'central',
        at: DEMO.source.at,
        sections: { apps: 'failed' },
        note: 'applications: HTTP 500',
      },
    };
    mockGet.mockResolvedValue({ kind: 'ok', applications: payload });
    renderSection();
    await settle();
    expect(screen.getByText('The applications read did not complete — applications: HTTP 500.')).toBeTruthy();
  });

  it('a not-fetched section says we chose not to ask, with the budget note', async () => {
    const payload: SiteApplicationsLive = {
      siteId: 'campus-01',
      window: DEMO.window,
      source: {
        plane: 'central',
        at: DEMO.source.at,
        sections: {},
        note: 'Central has spent its stored daily call budget — no per-object detail read was issued',
      },
    };
    mockGet.mockResolvedValue({ kind: 'ok', applications: payload });
    renderSection();
    await settle();
    expect(screen.getByText(/Applications were not fetched — Central has spent its stored daily call budget/)).toBeTruthy();
  });

  it('404 words the section as "not reported", never as an empty table', async () => {
    mockGet.mockResolvedValue({ kind: 'not-reported' });
    renderSection();
    await settle();
    expect(screen.getByText(/No application table was reported for this site/)).toBeTruthy();
    expect(screen.queryByText('Top talkers')).toBeNull();
  });

  it('a broken read is a failure sentence, never an empty table', async () => {
    mockGet.mockResolvedValue({ kind: 'failed', message: 'HTTP 502' });
    renderSection();
    await settle();
    expect(screen.getByText('The application read failed — HTTP 502')).toBeTruthy();
  });
});

describe('SiteApplications — CSV export', () => {
  it('offers client Export CSV when the table is present, and server CSV only when live', async () => {
    renderSection(true, false);
    await settle();
    expect(screen.getByRole('button', { name: 'Export CSV' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Download server CSV' })).toBeNull();
  });

  it('downloads server CSV via downloadApiCsv when live', async () => {
    renderSection(true, true);
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Download server CSV' }));
    await waitFor(() => {
      expect(mockDownloadApiCsv).toHaveBeenCalledWith(
        '/api/sites/campus-01/applications/export',
        'site-applications-campus-01.csv',
      );
    });
  });
});

describe('SiteApplications — Copy section link (Loop 71)', () => {
  it('Copy section link shares section=applications', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    renderSection();
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Copy section link' }));
    expect(writeText).toHaveBeenCalled();
    expect(String(writeText.mock.calls[0]![0])).toMatch(/\?section=applications#applications/);
  });

  it('Copy section link stays available without a table', async () => {
    mockGet.mockResolvedValue({ kind: 'not-reported' });
    renderSection();
    await settle();
    expect(screen.getByRole('button', { name: 'Copy section link' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Export CSV' })).toBeNull();
  });
});
