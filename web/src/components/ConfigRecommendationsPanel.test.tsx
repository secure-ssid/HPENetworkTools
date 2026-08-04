import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConfigRecommendation } from '@hpe/shared';
import { getRecommendations } from '../api/recommendations';
import { downloadApiCsv } from '../lib/downloadApiCsv';
import { exportTableCsv } from '../lib/csv';
import { ToastProvider } from '../nightdesk';
import { ConfigRecommendationsPanel } from './ConfigRecommendationsPanel';

vi.mock('../lib/downloadApiCsv', () => ({
  downloadApiCsv: vi.fn(),
}));

vi.mock('../lib/csv', () => ({
  exportTableCsv: vi.fn(() => 1),
}));

vi.mock('../api/recommendations', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/recommendations')>();
  return {
    ...actual,
    getRecommendations: vi.fn(),
  };
});

const mockDownloadApiCsv = vi.mocked(downloadApiCsv);
const mockExportTableCsv = vi.mocked(exportTableCsv);
const mockGetRecommendations = vi.mocked(getRecommendations);
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const sample: ConfigRecommendation = {
  id: 'rec-1',
  ruleId: 'firmware.target-gap',
  severity: 'warning',
  title: 'Firmware target 0.14.29',
  detail: 'Device lags the plane target.',
  category: 'firmware',
  actionType: 'examine',
  handoffPath: '/devices/ap-1',
  evidence: 'observed',
  device: 'ap-1',
};

function renderPanel(
  recs: ConfigRecommendation[],
  props: { device?: string; site?: string; clientMac?: string; showCopyLink?: boolean } = {},
  initialEntries: string[] = ['/'],
) {
  return render(
    <MemoryRouter initialEntries={initialEntries}>
      <ToastProvider>
        <ConfigRecommendationsPanel initialRecommendations={recs} {...props} />
      </ToastProvider>
    </MemoryRouter>,
  );
}

describe('ConfigRecommendationsPanel', () => {
  it('renders recommendation cards and handoff', () => {
    renderPanel([sample]);
    expect(screen.getByText(/firmware target 0.14.29/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /open related screen/i })).toBeTruthy();
    expect(screen.getByText(/read only/i)).toBeTruthy();
    expect(screen.getByText(/no auto-apply/i)).toBeTruthy();
  });

  it('shows empty state', () => {
    renderPanel([]);
    expect(screen.getByText(/no recommendations/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /export csv/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /download server csv/i })).toBeNull();
  });

  it('shows only the error when the recommendations envelope fails', async () => {
    mockGetRecommendations.mockRejectedValue(new Error('poller unavailable'));
    render(
      <MemoryRouter>
        <ToastProvider>
          <ConfigRecommendationsPanel />
        </ToastProvider>
      </MemoryRouter>,
    );
    expect(await screen.findByText(/recommendations unavailable/i)).toBeTruthy();
    expect(screen.getByText(/poller unavailable/i)).toBeTruthy();
    expect(screen.queryByText(/no recommendations/i)).toBeNull();
  });

  it('exports client CSV of rows currently in view', () => {
    renderPanel([sample]);
    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }));
    expect(mockExportTableCsv).toHaveBeenCalledWith(
      'config-recommendations.csv',
      expect.arrayContaining(['id', 'ruleId', 'severity', 'title', 'detail']),
      expect.arrayContaining([
        expect.arrayContaining([
          'rec-1',
          'firmware.target-gap',
          'warning',
          'firmware',
          'Firmware target 0.14.29',
        ]),
      ]),
    );
    expect(screen.getByText(/exported 1 recommendation/i)).toBeTruthy();
  });

  it('downloads server CSV with scope filters', async () => {
    mockDownloadApiCsv.mockResolvedValue({ ok: true });
    renderPanel([sample], { device: 'ap-1', site: 'Campus', clientMac: 'aa:bb' });
    fireEvent.click(screen.getByRole('button', { name: /download server csv/i }));
    await waitFor(() =>
      expect(mockDownloadApiCsv).toHaveBeenCalledWith(
        '/api/recommendations/export?device=ap-1&site=Campus&client=aa%3Abb',
        'config-recommendations.csv',
      ),
    );
    expect(await screen.findByText(/server csv downloaded/i)).toBeTruthy();
  });

  it('toasts honestly when server CSV fails', async () => {
    mockDownloadApiCsv.mockResolvedValue({ ok: false, error: 'Server export failed (HTTP 503)' });
    renderPanel([sample]);
    fireEvent.click(screen.getByRole('button', { name: /download server csv/i }));
    expect(await screen.findByText(/server csv failed/i)).toBeTruthy();
  });

  it('copies panel context link to /recommendations with filters', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    renderPanel([sample], { device: 'ap-1', site: 'Campus-01', clientMac: 'aa:bb:cc' });
    fireEvent.click(screen.getByRole('button', { name: /copy panel context link/i }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    const copied = String(writeText.mock.calls[0]?.[0] ?? '');
    expect(copied).toContain('/recommendations?');
    expect(copied).toContain('device=ap-1');
    expect(copied).toContain('site=Campus-01');
    expect(copied).toContain('client=aa%3Abb%3Acc');
    expect(await screen.findByText(/panel context link copied/i)).toBeTruthy();
  });

  it('reads device/site/client deep-link params when props are omitted', async () => {
    mockDownloadApiCsv.mockResolvedValue({ ok: true });
    renderPanel(
      [sample],
      {},
      ['/recommendations?device=sw-core-a&site=Campus&client=11%3A22'],
    );
    fireEvent.click(screen.getByRole('button', { name: /download server csv/i }));
    await waitFor(() =>
      expect(mockDownloadApiCsv).toHaveBeenCalledWith(
        '/api/recommendations/export?device=sw-core-a&site=Campus&client=11%3A22',
        'config-recommendations.csv',
      ),
    );
  });
});

/* Loop 186 — Recommendations multi-select bulk. */
describe('ConfigRecommendationsPanel bulk (Loop 186)', () => {
  const sampleB: ConfigRecommendation = {
    id: 'rec-2',
    ruleId: 'config.drift',
    severity: 'suggestion',
    title: 'Config drift',
    detail: 'Running config differs from intended.',
    category: 'configuration',
    actionType: 'examine',
    handoffPath: '/configure',
    evidence: 'observed',
    device: 'sw-1',
  };

  it('shows bulk bar: Export selected, Copy IDs, Copy selection link, Clear', async () => {
    const createObjectURL = vi.fn(() => 'blob:recs-selected');
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    renderPanel([sample, sampleB]);
    expect(screen.queryByRole('region', { name: 'Recommendation selection actions' })).toBeNull();

    fireEvent.click(screen.getByRole('checkbox', { name: /select recommendation firmware target/i }));
    const bar = await screen.findByRole('region', { name: 'Recommendation selection actions' });
    expect(within(bar).getByText('1 SELECTED')).toBeTruthy();

    fireEvent.click(within(bar).getByRole('button', { name: 'Export selected' }));
    expect(mockExportTableCsv).toHaveBeenCalledWith(
      'config-recommendations-selected.csv',
      expect.arrayContaining(['id', 'ruleId', 'severity', 'title']),
      expect.arrayContaining([expect.arrayContaining(['rec-1', 'firmware.target-gap'])]),
    );
    expect(await screen.findByText(/Exported 1 selected recommendation/i)).toBeTruthy();

    fireEvent.click(within(bar).getByRole('button', { name: 'Copy IDs' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('rec-1'));

    writeText.mockClear();
    fireEvent.click(within(bar).getByRole('button', { name: 'Copy selection link' }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    const url = String(writeText.mock.calls[0]![0]);
    expect(url).toContain('/recommendations?');
    expect(url).toMatch(/ids=rec-1|ids=rec%2D1/);

    fireEvent.click(within(bar).getByRole('button', { name: 'Clear' }));
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: 'Recommendation selection actions' })).toBeNull(),
    );
  });

  it('deep-links ?ids= and shows a clearable selection chip', async () => {
    renderPanel([sample, sampleB], {}, [`/recommendations?ids=${encodeURIComponent('rec-1')}`]);
    expect(await screen.findByRole('button', { name: /1 selected recommendation/i })).toBeTruthy();
    expect(screen.getByText(/firmware target 0.14.29/i)).toBeTruthy();
    expect(screen.queryByText(/config drift/i)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /1 selected recommendation/i }));
    await waitFor(() => expect(screen.getByText(/config drift/i)).toBeTruthy());
  });
});

/* Loop 205 — selection-empty Clear selection filter CTA. */
describe('ConfigRecommendationsPanel Loop 205 residuals', () => {
  it('offers Clear selection filter when ids deep link matches nothing', async () => {
    renderPanel(
      [sample],
      {},
      [`/recommendations?ids=${encodeURIComponent('missing-rec')}`],
    );
    expect(await screen.findByText('No recommendations match this selection')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Clear selection filter' }));
    expect(await screen.findByText(/firmware target 0.14.29/i)).toBeTruthy();
    expect(screen.queryByText('No recommendations match this selection')).toBeNull();
  });
});

/* Loop 222 — scope-filter empty Clear filters CTA (not selection). */
describe('ConfigRecommendationsPanel Loop 222 residuals', () => {
  it('offers Clear filters when parent scope leaves the list empty', () => {
    const onClearFilters = vi.fn();
    render(
      <MemoryRouter>
        <ToastProvider>
          <ConfigRecommendationsPanel
            initialRecommendations={[]}
            device="missing-device-zzz"
            onClearFilters={onClearFilters}
          />
        </ToastProvider>
      </MemoryRouter>,
    );
    expect(screen.getByText('No recommendations match these filters')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Clear selection filter' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(onClearFilters).toHaveBeenCalledTimes(1);
  });

  it('clears URL-owned scope filters when no parent pins the scope', async () => {
    function Loc() {
      const loc = useLocation();
      return <div data-testid="loc">{`${loc.pathname}${loc.search}`}</div>;
    }
    render(
      <MemoryRouter initialEntries={['/recommendations?device=missing-device-zzz']}>
        <ToastProvider>
          <ConfigRecommendationsPanel initialRecommendations={[]} />
          <Loc />
        </ToastProvider>
      </MemoryRouter>,
    );
    expect(screen.getByText('No recommendations match these filters')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    await waitFor(() => expect(screen.getByTestId('loc').textContent).toBe('/recommendations'));
  });

  it('does not offer Clear filters when a parent-pinned scope has no callback', () => {
    renderPanel([], { device: 'ap-pinned' });
    expect(screen.getByText('No recommendations match these filters')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Clear filters' })).toBeNull();
  });
});

/* Loop 234 — bulk Copy titles beside Copy IDs. */
describe('ConfigRecommendationsPanel Loop 234 residuals', () => {
  it('Copy titles joins unique recommendation titles from the selection', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    renderPanel([sample]);
    fireEvent.click(screen.getByRole('checkbox', { name: /select recommendation firmware target/i }));
    const bar = await screen.findByRole('region', { name: 'Recommendation selection actions' });
    expect(within(bar).getByRole('button', { name: 'Copy titles' })).toBeTruthy();
    fireEvent.click(within(bar).getByRole('button', { name: 'Copy titles' }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    const text = String(writeText.mock.calls[0]![0] ?? '');
    expect(text).toMatch(/firmware target/i);
    expect(text).not.toMatch(/^rec-/);
    expect(await screen.findByText(/Copied \d+ title/)).toBeTruthy();
  });
});
