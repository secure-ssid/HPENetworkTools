import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { downloadApiCsv } from '../lib/downloadApiCsv';
import { getRecommendations } from '../api/recommendations';
import { ToastProvider } from '../nightdesk';
import Recommendations from './Recommendations';

vi.mock('../lib/downloadApiCsv', () => ({
  downloadApiCsv: vi.fn(),
}));

vi.mock('../components/VisualReferencePanel', () => ({
  VisualReferencePanel: () => <div data-testid="visual-refs">Visual references</div>,
}));

vi.mock('../api/recommendations', () => ({
  getRecommendations: vi.fn(async () => ({
    recommendations: [
      {
        id: 'rec-1',
        ruleId: 'firmware.target-gap',
        severity: 'warning',
        title: 'Firmware target gap',
        detail: 'Device lags target.',
        category: 'firmware',
        actionType: 'examine',
        handoffPath: '/devices/ap-1',
        evidence: 'observed',
        device: 'ap-1',
      },
    ],
    counts: {
      total: 3,
      bySeverity: { info: 1, suggestion: 1, warning: 1 },
      byCategory: { firmware: 1, configuration: 1, security: 1 },
    },
    readOnly: true as const,
    note: 'Suggestions only — the portal never auto-applies configuration from this endpoint.',
  })),
}));

const mockDownloadApiCsv = vi.mocked(downloadApiCsv);
const mockGetRecommendations = vi.mocked(getRecommendations);

function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="loc">{`${loc.pathname}${loc.search}`}</div>;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderPage(path = '/recommendations') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <ToastProvider>
        <Routes>
          <Route
            path="/recommendations"
            element={
              <>
                <Recommendations />
                <LocationProbe />
              </>
            }
          />
        </Routes>
      </ToastProvider>
    </MemoryRouter>,
  );
}

describe('Recommendations screen', () => {
  it('hydrates filters from deep-link query params', async () => {
    renderPage(
      '/recommendations?device=ap-1&site=Campus-01&client=aa%3Abb&severity=warning&category=firmware',
    );
    expect(await screen.findByDisplayValue('ap-1')).toBeTruthy();
    expect(screen.getByDisplayValue('Campus-01')).toBeTruthy();
    expect(screen.getByDisplayValue('aa:bb')).toBeTruthy();
    expect((screen.getByLabelText(/filter by severity/i) as HTMLSelectElement).value).toBe('warning');
    expect((screen.getByLabelText(/filter by category/i) as HTMLSelectElement).value).toBe('firmware');
    expect(screen.getByRole('heading', { name: 'Recommendations' })).toBeTruthy();
    expect(screen.getByText('READ ONLY')).toBeTruthy();
    expect(await screen.findByText(/firmware target gap/i)).toBeTruthy();
  });

  it('Copy filter link writes ?device=&site=&client=&severity=&category=', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    renderPage(
      '/recommendations?device=sw-core-a&site=Campus&severity=suggestion&category=configuration',
    );
    fireEvent.click(await screen.findByRole('button', { name: /copy filter link/i }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    const url = String(writeText.mock.calls[0]?.[0] ?? '');
    expect(url).toContain('/recommendations?');
    expect(url).toContain('device=sw-core-a');
    expect(url).toContain('site=Campus');
    expect(url).toContain('severity=suggestion');
    expect(url).toContain('category=configuration');
  });

  it('Download server CSV uses current filters including severity and category', async () => {
    mockDownloadApiCsv.mockResolvedValue({ ok: true });
    renderPage('/recommendations?device=ap-1&site=HQ&severity=warning&category=firmware');
    fireEvent.click(await screen.findByRole('button', { name: /^download server csv$/i }));
    await waitFor(() =>
      expect(mockDownloadApiCsv).toHaveBeenCalledWith(
        '/api/recommendations/export?device=ap-1&site=HQ&severity=warning&category=firmware',
        'config-recommendations.csv',
      ),
    );
    expect(await screen.findByText(/server csv downloaded/i)).toBeTruthy();
  });

  it('renders the visual references panel (Loop 67)', async () => {
    renderPage('/recommendations');
    expect(await screen.findByTestId('visual-refs')).toBeTruthy();
  });
});

/* Loop 137 — Severity chip row toggles the same severity= filter as the Select. */
describe('Recommendations severity chips (Loop 137)', () => {
  it('severity chips write severity back to the URL and can clear', async () => {
    renderPage('/recommendations');
    expect(await screen.findByRole('heading', { name: 'Recommendations' })).toBeTruthy();
    await waitFor(() => expect(mockGetRecommendations).toHaveBeenCalled());
    const chips = await screen.findByRole('group', { name: 'Recommendation severity' });
    const warning = within(chips).getByRole('button', { name: /Warning/i });
    expect(warning.getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(warning);
    await waitFor(() => expect(screen.getByTestId('loc').textContent).toContain('severity=warning'));
    expect(warning.getAttribute('aria-pressed')).toBe('true');
    expect((screen.getByLabelText(/filter by severity/i) as HTMLSelectElement).value).toBe('warning');

    fireEvent.click(warning);
    await waitFor(() => expect(screen.getByTestId('loc').textContent).not.toContain('severity='));
    expect((screen.getByLabelText(/filter by severity/i) as HTMLSelectElement).value).toBe('all');
  });

  it('Clear filters resets severity and text scopes', async () => {
    renderPage('/recommendations?device=ap-1&severity=warning&category=firmware');
    expect(await screen.findByDisplayValue('ap-1')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /clear filters/i }));
    await waitFor(() => {
      expect(screen.getByTestId('loc').textContent).toBe('/recommendations');
    });
    expect((screen.getByLabelText(/filter by severity/i) as HTMLSelectElement).value).toBe('all');
    expect((screen.getByLabelText(/filter by category/i) as HTMLSelectElement).value).toBe('all');
  });
});

/* Loop 146 — Category chip row toggles the same category= filter as the Select. */
describe('Recommendations category chips (Loop 146)', () => {
  it('category chips write category back to the URL and can clear', async () => {
    renderPage('/recommendations');
    expect(await screen.findByRole('heading', { name: 'Recommendations' })).toBeTruthy();
    await waitFor(() => expect(mockGetRecommendations).toHaveBeenCalled());
    const chips = await screen.findByRole('group', { name: 'Recommendation category' });
    const firmware = within(chips).getByRole('button', { name: /Firmware/i });
    expect(firmware.getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(firmware);
    await waitFor(() => expect(screen.getByTestId('loc').textContent).toContain('category=firmware'));
    expect(firmware.getAttribute('aria-pressed')).toBe('true');
    expect((screen.getByLabelText(/filter by category/i) as HTMLSelectElement).value).toBe('firmware');

    fireEvent.click(firmware);
    await waitFor(() => expect(screen.getByTestId('loc').textContent).not.toContain('category='));
    expect((screen.getByLabelText(/filter by category/i) as HTMLSelectElement).value).toBe('all');
  });
});
