/**
 * SLE section + drill-down drawer tests: the polled MistSleRow renders one
 * clickable row per metric, and the drawer words every read outcome honestly —
 * payload sections (ok / failed), 404 "not reported", 500 "failed" — never an
 * empty drill standing in for a broken read.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import {
  SiteSle,
  siteSleSectionUrl,
  sleDrillCsvRows,
  sleMetricCsvRows,
  sleMetricFromParam,
  SLE_DRILL_CSV_HEADERS,
  SLE_METRIC_CSV_HEADERS,
} from './Sle';
import { getSleMetricDetail } from '../../api/client';
import { MIST_SLE_DRILLDOWN, SITE_SLE, hhmmLocal as hhmm } from '@hpe/shared';
import type { MistSleMetricDetail } from '@hpe/shared';
import { ToastProvider } from '../../nightdesk';
import { exportTableCsv } from '../../lib/csv';
import { downloadApiCsv } from '../../lib/downloadApiCsv';

vi.mock('../../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/client')>();
  return { ...actual, getSleMetricDetail: vi.fn() };
});

vi.mock('../../lib/csv', () => ({
  exportTableCsv: vi.fn(() => 6),
}));

vi.mock('../../lib/downloadApiCsv', () => ({
  downloadApiCsv: vi.fn(async () => ({ ok: true as const })),
}));

const mockDrill = vi.mocked(getSleMetricDetail);
const mockExportTableCsv = vi.mocked(exportTableCsv);
const mockDownloadApiCsv = vi.mocked(downloadApiCsv);

const SLE = SITE_SLE['campus-02']!; // six metrics, overall 0.96
const DRILL = MIST_SLE_DRILLDOWN['campus-02|coverage']!;

beforeEach(() => {
  mockDrill.mockResolvedValue({ kind: 'ok', detail: DRILL });
  mockExportTableCsv.mockReturnValue(6);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderSle(
  _sle?: Parameters<typeof SiteSle>[0]['sle'],
  mistClaimed = true,
  entry = '/sites/campus-02',
) {
  // Prefer raw arguments so an explicit `undefined` is not collapsed by defaults.
  const value = arguments.length === 0 ? SLE : (arguments[0] as Parameters<typeof SiteSle>[0]['sle']);
  return render(
    <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }} initialEntries={[entry]}>
      <ToastProvider>
        <SiteSle sle={value} mistClaimed={mistClaimed} siteKey="campus-02" siteName="Campus-02 Research" />
      </ToastProvider>
    </MemoryRouter>,
  );
}

/** Open the drill drawer for one metric row and wait out the read. */
async function openDrill(rowName: RegExp) {
  const before = mockDrill.mock.calls.length;
  fireEvent.click(screen.getByRole('button', { name: rowName }));
  expect(screen.getByRole('dialog')).toBeTruthy();
  await waitFor(() => expect(mockDrill.mock.calls.length).toBeGreaterThan(before));
}

describe('SiteSle section', () => {
  it('renders the overall meta and one clickable row per scored metric', () => {
    renderSle();
    expect(screen.getByText('OVERALL 96% · MIST SLE')).toBeTruthy();
    expect(screen.getByRole('button', { name: /time to connect/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /coverage/i })).toBeTruthy();
    // Sample counts and impact come straight off the metric row.
    expect(screen.getByText(/123 degraded of 4,112 samples/)).toBeTruthy();
    expect(screen.getByText(/36 of 1,240 users · 4 of 72 APs/)).toBeTruthy();
  });

  it('a site with no SLE row says so — a Mist site and a non-Mist site word it differently', () => {
    renderSle(null, true);
    expect(screen.getByText(/Mist reported no SLE scores for this site this cycle/)).toBeTruthy();
    cleanup();
    renderSle(null, false);
    expect(screen.getByText('No linked plane publishes SLE scores for this site.')).toBeTruthy();
    // Never a fabricated 0% anywhere.
    expect(screen.queryByText('0%')).toBeNull();
  });

  it('an absent sle key is "not reported", not an empty estate', () => {
    renderSle(undefined, true);
    expect(screen.getByText('The portal did not say whether this site reports SLE scores.')).toBeTruthy();
  });

  it('a row without per-metric detail shows the headline scores without drill affordance', () => {
    const { metrics: _metrics, ...headline } = SLE;
    renderSle(headline);
    expect(screen.getByText('Coverage')).toBeTruthy();
    expect(screen.getByText('WAN')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /drill/i })).toBeNull();
    expect(screen.getByText(/there is nothing to drill into/)).toBeTruthy();
  });

  it('Copy section link shares section=sle and Export CSV dumps metric scores', () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    renderSle();
    fireEvent.click(screen.getByRole('button', { name: 'Copy section link' }));
    expect(writeText).toHaveBeenCalled();
    expect(String(writeText.mock.calls[0]![0])).toMatch(/\?section=sle#sle/);
    mockExportTableCsv.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }));
    expect(mockExportTableCsv).toHaveBeenCalledTimes(1);
    const [filename, headers, rows] = mockExportTableCsv.mock.calls[0]!;
    expect(filename).toBe('site-sle-campus-02.csv');
    expect(headers).toEqual([...SLE_METRIC_CSV_HEADERS]);
    expect(rows.length).toBeGreaterThan(0);
  });

  it('Download server CSV hits /api/sites/:id/sle/export (Loop 98)', async () => {
    mockDownloadApiCsv.mockResolvedValue({ ok: true });
    renderSle();
    fireEvent.click(screen.getByRole('button', { name: 'Download server CSV' }));
    await waitFor(() => {
      expect(mockDownloadApiCsv).toHaveBeenCalledWith(
        '/api/sites/campus-02/sle/export',
        'site-sle-campus-02.csv',
      );
    });
  });

  it('sleMetricCsvRows and sleDrillCsvRows keep summary columns only', () => {
    expect(siteSleSectionUrl('/sites/campus-02')).toMatch(/\/sites\/campus-02\?section=sle#sle/);
    expect(siteSleSectionUrl('/sites/campus-02', 'coverage')).toMatch(
      /\/sites\/campus-02\?section=sle&metric=coverage#sle/,
    );
    expect(sleMetricFromParam('coverage')).toBe('coverage');
    expect(sleMetricFromParam('  ')).toBeNull();
    const metrics = sleMetricCsvRows(SLE);
    expect(metrics[0]?.[0]).toBeTruthy();
    const drill = sleDrillCsvRows(DRILL);
    expect(drill.some((r) => r[0] === 'classifier')).toBe(true);
    expect(JSON.stringify(drill)).not.toMatch(/password|secret|token/i);
    expect(SLE_DRILL_CSV_HEADERS[0]).toBe('section');
  });
});

describe('SiteSle drill drawer', () => {
  it('opens on a metric click and renders classifiers, impacted clients/APs and the trend', async () => {
    renderSle();
    await openDrill(/coverage/i);
    expect(mockDrill).toHaveBeenCalledWith('campus-02', 'coverage');

    // Header: the metric, the site, and the read's own provenance stamp.
    expect(screen.getByText('Coverage', { selector: '.nd-drawer__title' })).toBeTruthy();
    expect(screen.getByText('Campus-02 Research · Mist SLE drill-down')).toBeTruthy();
    expect(screen.getByText(`MIST · READ ${hhmm(DRILL.source.at)}`)).toBeTruthy();

    // Classifiers — the WHY, with degraded/sample counts and impact.
    expect(screen.getByText('Signal strength')).toBeTruthy();
    expect(screen.getByText(/141 degraded of 141 samples/)).toBeTruthy();
    expect(screen.getByText('Interference')).toBeTruthy();

    // Impacted clients — name when the row names one, bare MAC when not.
    expect(screen.getByText('s.mehta')).toBeTruthy();
    expect(screen.getByText('6e:41:0d:99:2b:af')).toBeTruthy();
    expect(screen.getByText('31 degraded samples')).toBeTruthy();

    // Impacted APs and the trend sparkline (aria label carries the values).
    expect(screen.getByText('ap-3f-14')).toBeTruthy();
    const trend = screen.getByRole('img', { name: /Coverage success, 24 intervals/ });
    expect(trend).toBeTruthy();

    // Drill export — classifiers + impacted only.
    mockExportTableCsv.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Export drill CSV' }));
    expect(mockExportTableCsv).toHaveBeenCalledTimes(1);
    const [filename, headers] = mockExportTableCsv.mock.calls[0]!;
    expect(filename).toBe('site-sle-campus-02-coverage.csv');
    expect(headers).toEqual([...SLE_DRILL_CSV_HEADERS]);

    mockDownloadApiCsv.mockClear();
    mockDownloadApiCsv.mockResolvedValue({ ok: true });
    // Section + drill both expose the label — scope to the open drawer dialog.
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Download server CSV' }),
    );
    await waitFor(() => {
      expect(mockDownloadApiCsv).toHaveBeenCalledWith(
        '/api/sites/campus-02/sle/coverage/export',
        'site-sle-campus-02-coverage.csv',
      );
    });
  });

  it('404 words the drawer as "not reported", never as an empty drill', async () => {
    mockDrill.mockResolvedValue({ kind: 'not-reported' });
    renderSle();
    await openDrill(/roaming/i);
    expect(screen.getByText(/No drill-down was reported for this metric at this site/)).toBeTruthy();
    expect(screen.queryByText('Classifiers')).toBeNull();
  });

  it('500 words the drawer as a failed read, with the server message', async () => {
    mockDrill.mockResolvedValue({ kind: 'failed', message: 'HTTP 500' });
    renderSle();
    await openDrill(/capacity/i);
    expect(screen.getByText('The drill-down read failed — HTTP 500')).toBeTruthy();
  });

  it('a payload whose sections failed says the call broke, not that nothing exists', async () => {
    const failed: MistSleMetricDetail = {
      siteId: 'campus-02',
      siteName: 'Campus-02 Research',
      metric: 'coverage',
      source: {
        plane: 'mist',
        at: '2026-07-26T11:59:00.000Z',
        sections: { classifiers: 'failed', impactedClients: 'failed', impactedAps: 'failed', trend: 'failed' },
        note: 'the detail read did not answer within 10s',
      },
    };
    mockDrill.mockResolvedValue({ kind: 'ok', detail: failed });
    renderSle();
    await openDrill(/coverage/i);
    expect(screen.getByText('The classifiers read failed — the detail read did not answer within 10s.')).toBeTruthy();
    expect(screen.getByText('The impacted clients read failed — the detail read did not answer within 10s.')).toBeTruthy();
    expect(screen.getByText('The trend read failed — the detail read did not answer within 10s.')).toBeTruthy();
  });

  it('closing and reopening a metric re-reads (the server TTL cache keeps it off the plane)', async () => {
    renderSle();
    await openDrill(/coverage/i);
    fireEvent.click(screen.getByRole('button', { name: 'Close dialog' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await openDrill(/coverage/i);
    expect(mockDrill).toHaveBeenCalledTimes(2);
  });

  /* Loop 78 — ?metric= deep-link opens the drill; Copy drill link shares it. */
  it('opens the drill from ?section=sle&metric= and Copy drill link shares metric=', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    renderSle(SLE, true, '/sites/campus-02?section=sle&metric=coverage');
    expect(await screen.findByRole('dialog')).toBeTruthy();
    await waitFor(() => expect(mockDrill).toHaveBeenCalledWith('campus-02', 'coverage'));
    fireEvent.click(screen.getByRole('button', { name: 'Copy drill link' }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(String(writeText.mock.calls[0]![0])).toMatch(/section=sle/);
    expect(String(writeText.mock.calls[0]![0])).toMatch(/metric=coverage/);
  });
});
