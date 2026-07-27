/**
 * web/src/screens/Overview.test.tsx — component tests for the Overview screen.
 *
 * The api client is mocked at the module boundary (getOverview only; the rest
 * of the module is kept real so SettingsProvider can use DEFAULT_SETTINGS).
 * Covered:
 *  (a) live mode with syncedAt = null → header stamp renders an em-dash
 *      ('SYNCED — · AUTO 60s'), never the string 'null';
 *  (b) live mode with an ISO syncedAt → the stamp renders in hhmm format,
 *      not the raw ISO string;
 *  (c) live alert rows render their meta text and site rows render the
 *      plane label / navigate with their siteId.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import Overview from './Overview';
import { SettingsProvider } from '../app/SettingsContext';
import { getOverview } from '../api/client';
import type { OverviewData } from '../api/client';

vi.mock('../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/client')>();
  return { ...actual, getOverview: vi.fn() };
});

const mockGetOverview = vi.mocked(getOverview);

afterEach(() => {
  cleanup();
  mockGetOverview.mockReset();
});

/** Minimal live-mode view model; per-test overrides go in `over`. */
function liveData(over: Partial<OverviewData> = {}): OverviewData {
  return {
    stats: [{ label: 'Devices', value: '128', delta: '+2 today', tone: 'positive' }],
    alerts: [
      {
        sev: 'P1',
        tone: 'danger',
        title: 'Gateway gw-edge-1 unreachable',
        meta: 'CENTRAL · campus-01 · gw-edge-1',
        plane: 'CENTRAL',
        age: '4m',
        device: 'gw-edge-1',
      },
    ],
    sites: [
      {
        name: 'Campus 01',
        siteId: 'campus-01',
        plane: 'Central · local',
        devices: 42,
        clients: '1,204',
        health: '96%',
        healthPct: '96%',
        tone: 'ok',
        alerts: '2',
        alertTone: 'warning',
      },
    ],
    planes: [{ name: 'Central', scope: 'GLOBAL', state: 'linked', tone: 'success', sync: '09:38' }],
    changes: [{ time: '09:32', text: 'SSID Corp-WiFi updated', who: 's.choate' }],
    launchpad: [{ label: 'Open alerts queue', hint: 'VIEW', target: { type: 'view', view: 'alerts' } }],
    syncedAt: null,
    dataSource: 'live',
    ...over,
  };
}

/** Exposes the current pathname so navigation assertions stay honest. */
function PathProbe() {
  const location = useLocation();
  return <div data-testid="path">{location.pathname}</div>;
}

function renderOverview() {
  return render(
    <MemoryRouter>
      <SettingsProvider>
        <Overview />
        <PathProbe />
      </SettingsProvider>
    </MemoryRouter>,
  );
}

describe('Overview', () => {
  it('(a) live mode with syncedAt null renders an em-dash stamp, not the string null', async () => {
    mockGetOverview.mockResolvedValue(liveData({ syncedAt: null }));
    renderOverview();

    const stamp = await screen.findByText('SYNCED — · AUTO 60s');
    expect(stamp.textContent).toContain('—');
    expect(stamp.textContent).not.toContain('null');
  });

  it('(b) live mode with an ISO syncedAt renders hhmm, not the raw ISO string', async () => {
    // No 'Z' suffix: parsed as local time, so hhmm is timezone-independent.
    const iso = '2026-07-26T09:05:00';
    mockGetOverview.mockResolvedValue(liveData({ syncedAt: iso }));
    renderOverview();

    const stamp = await screen.findByText('SYNCED 09:05 · AUTO 60s');
    expect(stamp.textContent).not.toContain(iso);
    expect(screen.queryByText(/2026-07-26/)).toBeNull();
  });

  it('(c) live alert rows render their meta text', async () => {
    mockGetOverview.mockResolvedValue(liveData());
    renderOverview();

    expect(await screen.findByText('Gateway gw-edge-1 unreachable')).toBeTruthy();
    expect(screen.getByText('CENTRAL · campus-01 · gw-edge-1')).toBeTruthy();
  });

  it('(c) live site rows render the plane label and navigate with their siteId', async () => {
    mockGetOverview.mockResolvedValue(liveData());
    renderOverview();

    // The Sites table shows the plane label per row.
    expect(await screen.findByText('Central · local')).toBeTruthy();

    // The site name button addresses its target by siteId.
    fireEvent.click(screen.getByRole('button', { name: 'Campus 01' }));
    expect(screen.getByTestId('path').textContent).toBe('/sites/campus-01');
  });
});
