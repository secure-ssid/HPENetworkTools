import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { ShiftStrip, shiftFreshnessLabel, shiftStatusSummary } from './ShiftStrip';
import { SettingsProvider } from './SettingsContext';
import { ToastProvider } from '../nightdesk';

function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="loc">{`${loc.pathname}${loc.search}`}</div>;
}

const getSystemsState = vi.fn();
const getOverview = vi.fn();

vi.mock('../api/client', () => ({
  DEFAULT_SETTINGS: {
    density: 'comfortable',
    inventoryView: 'Unified table',
    showPlatformTags: true,
    workspaceName: 'Meridian Health',
    pollIntervalSec: 60,
  },
  SETTINGS_STORAGE_KEY: 'nt-settings',
  saveSettings: vi.fn().mockResolvedValue(undefined),
  getSettings: vi.fn().mockResolvedValue({
    density: 'comfortable',
    inventoryView: 'Unified table',
    showPlatformTags: true,
    workspaceName: 'Meridian Health',
    pollIntervalSec: 60,
  }),
  getSystemsState: (...args: unknown[]) => getSystemsState(...args),
  getOverview: (...args: unknown[]) => getOverview(...args),
}));

afterEach(() => {
  cleanup();
  getSystemsState.mockReset();
  getOverview.mockReset();
});

function renderStrip() {
  return render(
    <SettingsProvider>
      <ToastProvider>
        <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
          <ShiftStrip />
        </MemoryRouter>
      </ToastProvider>
    </SettingsProvider>,
  );
}

describe('ShiftStrip', () => {
  it('renders env, mode, P1s, planes, and freshness from systems + overview', async () => {
    getSystemsState.mockResolvedValue({
      demoMode: false,
      syncedAt: '2026-03-04T09:41:00.000Z',
      planes: {
        central: { id: 'central', linked: true, health: 'healthy', lastSync: '2026-03-04T09:41:00.000Z' },
        mist: { id: 'mist', linked: true, health: 'degraded', lastSync: '2026-03-04T09:10:00.000Z' },
      },
      history: [],
    });
    getOverview.mockResolvedValue({
      dataSource: 'live',
      alerts: [
        { sev: 'P1', tone: 'danger', title: 'Core down', meta: '', plane: 'central', age: '2m', device: 'sw-1' },
        { sev: 'P2', tone: 'warning', title: 'Noise', meta: '', plane: 'mist', age: '5m', device: 'ap-1' },
      ],
      sites: [],
      planes: [],
      changes: [],
      launchpad: [],
      stats: [],
      syncedAt: '2026-03-04T09:41:00.000Z',
      workspace: 'Meridian Health',
    });

    renderStrip();

    await waitFor(() => {
      expect(screen.getByRole('status', { name: 'Shift status' })).toBeTruthy();
    });
    expect(screen.getByText('Meridian Health')).toBeTruthy();
    expect(screen.getByText('Live')).toBeTruthy();
    expect(screen.getByRole('button', { name: /1 P1/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /1 plane degraded/i })).toBeTruthy();
    expect(document.querySelector('.nt-shift-strip__fresh')?.textContent).toMatch(/Fresh .+ ago/i);
    /* Polite live region carries the full shift summary for AT users. */
    const live = document.querySelector('.nt-shift-strip [aria-live="polite"]');
    expect(live?.textContent).toMatch(/1 P1/i);
    expect(live?.textContent).toMatch(/degraded/i);
  });

  it('routes P1 chip to alerts?sev=P1 (Loop 134)', async () => {
    getSystemsState.mockResolvedValue({ demoMode: true, planes: {}, history: [], syncedAt: null });
    getOverview.mockResolvedValue({
      dataSource: 'demo',
      alerts: [{ sev: 'P1', tone: 'danger', title: 'X', meta: '', plane: 'central', age: '1m', device: '' }],
      sites: [],
      planes: [],
      changes: [],
      launchpad: [],
      stats: [],
      syncedAt: null,
    });

    render(
      <SettingsProvider>
        <ToastProvider>
          <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
            <Routes>
              <Route
                path="*"
                element={
                  <>
                    <ShiftStrip />
                    <LocationProbe />
                  </>
                }
              />
            </Routes>
          </MemoryRouter>
        </ToastProvider>
      </SettingsProvider>,
    );
    const p1 = await screen.findByRole('button', { name: /1 P1/i });
    fireEvent.click(p1);
    await waitFor(() => {
      expect(screen.getByTestId('loc').textContent).toBe('/alerts?sev=P1');
    });
  });

  it('announces plane poll deltas when the degraded set changes (Loop 131)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    getSystemsState
      .mockResolvedValueOnce({
        demoMode: false,
        syncedAt: '2026-03-04T09:41:00.000Z',
        planes: {
          central: { id: 'central', linked: true, health: 'healthy', lastSync: '2026-03-04T09:41:00.000Z' },
        },
        history: [],
      })
      .mockResolvedValue({
        demoMode: false,
        syncedAt: '2026-03-04T09:42:00.000Z',
        planes: {
          central: { id: 'central', linked: true, health: 'degraded', lastSync: '2026-03-04T09:42:00.000Z' },
        },
        history: [],
      });
    getOverview.mockResolvedValue({
      dataSource: 'live',
      alerts: [],
      sites: [],
      planes: [],
      changes: [],
      launchpad: [],
      stats: [],
      syncedAt: '2026-03-04T09:41:00.000Z',
      workspace: 'Meridian Health',
    });

    renderStrip();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Planes ok/i })).toBeTruthy();
    });
    /* Baseline snapshot must not announce cold start. */
    expect(screen.getByTestId('plane-poll-delta').textContent).toBe('');

    await vi.advanceTimersByTimeAsync(60_000);
    await waitFor(() => {
      expect(screen.getByTestId('plane-poll-delta').textContent).toMatch(/central became degraded/i);
    });
    vi.useRealTimers();
  });
});

describe('shiftFreshnessLabel / shiftStatusSummary', () => {
  const NOW = Date.parse('2026-03-04T09:45:00.000Z');

  it('prefers relative age with clock title', () => {
    const f = shiftFreshnessLabel('2026-03-04T09:41:00.000Z', false, NOW);
    expect(f.label).toBe('Fresh 4m ago');
    expect(f.title).toMatch(/4m ago/);
  });

  it('handles missing backend and awaiting sync', () => {
    expect(shiftFreshnessLabel(null, true, NOW).label).toBe('No backend');
    expect(shiftFreshnessLabel(null, false, NOW).label).toBe('Awaiting sync');
  });

  it('summarises mode, heat, and freshness for the live region', () => {
    const text = shiftStatusSummary(
      {
        env: 'Meridian Health',
        mode: 'live',
        p1Count: 2,
        degraded: ['mist'],
        syncedAt: '2026-03-04T09:41:00.000Z',
        backendMissing: false,
      },
      NOW,
    );
    expect(text).toContain('Meridian Health');
    expect(text).toContain('Live');
    expect(text).toContain('2 P1s');
    expect(text).toContain('1 plane degraded');
    expect(text).toContain('Fresh 4m ago');
  });
});
