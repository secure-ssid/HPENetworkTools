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
 *  (c) live alert rows render their meta text, an alert carrying its own
 *      siteName/siteId renders the site as an openable element instead of a
 *      prose prefix (and never twice), and site rows render the plane label /
 *      navigate with their siteId;
 *  (d) live mode derives the section links and the subtitle from the payload
 *      instead of printing the prototype's "All 7 alerts" / "All 10 sites" /
 *      "Ten sites, six management planes";
 *  (e) a demo-sourced payload keeps the authored fixture prose verbatim;
 *  (f) the Sites table stays a six-row preview while the link names the total;
 *  (j) change-log rows sharing a time + text both render (unique React keys);
 *  (k) an empty live section drops its "all N →" link instead of offering one
 *      that leads to nothing.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
    planes: [{ name: 'Central', scope: 'GLOBAL', state: 'linked', tone: 'success', sync: '09:38', linked: true }],
    changes: [{ time: '09:32', text: 'SSID Corp-WiFi updated', who: 's.choate' }],
    launchpad: [{ label: 'Open alerts queue', hint: 'VIEW', target: { type: 'view', view: 'alerts' } }],
    syncedAt: null,
    dataSource: 'live',
    ...over,
  };
}

/** N distinct site rows, so preview-slicing and count derivation are visible. */
function siteRows(n: number): OverviewData['sites'] {
  return Array.from({ length: n }, (_, i) => ({
    name: `Site ${i + 1}`,
    siteId: 'campus-01' as const,
    plane: 'Central',
    devices: 4,
    clients: '10',
    health: '99%',
    healthPct: '99%',
    tone: 'ok' as const,
    alerts: 'clear',
    alertTone: 'success' as const,
  }));
}

/**
 * React reports a duplicate-key collision through console.error and still
 * renders both children, so "both rows are on screen" alone cannot see the bug
 * — the warning is the assertion.
 */
function captureConsoleErrors() {
  const errors: unknown[][] = [];
  const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    errors.push(args);
  });
  return { errors, restore: () => spy.mockRestore() };
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

  it('(c) an alert that carries its own site renders it as an element, not a meta prefix', async () => {
    mockGetOverview.mockResolvedValue(
      liveData({
        alerts: [
          {
            sev: 'P1',
            tone: 'danger',
            title: 'Gateway gw-edge-1 unreachable',
            // A route that sends the field may still lead the prose with it —
            // the site must be printed once, not twice.
            meta: 'Lakeshore Medical Center · CENTRAL · gw-edge-1',
            siteName: 'Lakeshore Medical Center',
            siteId: 'lakeshore',
            plane: 'CENTRAL',
            age: '4m',
            device: 'gw-edge-1',
          },
        ],
      }),
    );
    renderOverview();

    // The site is its own element and opens the site it names.
    const siteButton = await screen.findByRole('button', { name: 'Lakeshore Medical Center' });
    expect(screen.getByText('CENTRAL · gw-edge-1')).toBeTruthy();
    expect(screen.queryByText('Lakeshore Medical Center · CENTRAL · gw-edge-1')).toBeNull();
    fireEvent.click(siteButton);
    expect(screen.getByTestId('path').textContent).toBe('/sites/lakeshore');
  });

  it('(c) an alert with a site name but no canonical id names it without offering a dead link', async () => {
    mockGetOverview.mockResolvedValue(
      liveData({
        alerts: [
          {
            sev: 'P2',
            tone: 'warning',
            title: 'Radio down',
            meta: 'MIST · ap-3f-12',
            siteName: 'Unmapped Annex',
            plane: 'MIST',
            age: '9m',
            device: 'ap-3f-12',
          },
        ],
      }),
    );
    renderOverview();

    expect(await screen.findByText('Unmapped Annex')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Unmapped Annex' })).toBeNull();
    // The rest of the meta line is untouched when it never carried the site.
    expect(screen.getByText('MIST · ap-3f-12')).toBeTruthy();
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

  it('(d) live mode derives the section links and subtitle from the payload', async () => {
    mockGetOverview.mockResolvedValue(
      liveData({
        alerts: [
          { sev: 'P1', tone: 'danger', title: 'A', meta: 'm', plane: 'CENTRAL', age: '1m', device: 'd1' },
          { sev: 'P2', tone: 'warning', title: 'B', meta: 'm', plane: 'CENTRAL', age: '2m', device: 'd2' },
          { sev: 'P3', tone: 'info', title: 'C', meta: 'm', plane: 'CENTRAL', age: '3m', device: 'd3' },
        ],
        sites: siteRows(3),
        planes: [
          { name: 'Central', scope: 'GLOBAL', state: 'linked', tone: 'success', sync: '09:38', linked: true },
          { name: 'ClearPass', scope: 'GLOBAL', state: 'linked', tone: 'success', sync: '09:37', linked: true },
        ],
      }),
    );
    renderOverview();

    expect(await screen.findByText('All 3 alerts →')).toBeTruthy();
    expect(screen.getByText('All 3 sites →')).toBeTruthy();
    expect(
      screen.getByText('3 sites, 2 management planes — one queue of things that actually need you.'),
    ).toBeTruthy();
    // None of the prototype's baked counts survive into a live render.
    expect(screen.queryByText('All 7 alerts →')).toBeNull();
    expect(screen.queryByText('All 10 sites →')).toBeNull();
    expect(screen.queryByText(/Ten sites, six management planes/)).toBeNull();
  });

  it('(d2) planes with no credentials collapse to one line instead of filling the panel', async () => {
    mockGetOverview.mockResolvedValue(
      liveData({
        planes: [
          { name: 'Central', scope: '13 devices', state: 'healthy', tone: 'success', sync: '34s', linked: true },
          { name: 'Mist', scope: 'no credentials configured', state: 'not linked', tone: 'neutral', sync: '—', linked: false },
          { name: 'ClearPass', scope: 'no credentials configured', state: 'not linked', tone: 'neutral', sync: '—', linked: false },
          { name: 'UXI', scope: 'no credentials configured', state: 'not linked', tone: 'neutral', sync: '—', linked: false },
        ],
      }),
    );
    renderOverview();

    // The linked plane keeps its own row; the three dark ones become one line.
    expect(await screen.findByText('Central')).toBeTruthy();
    expect(screen.getByText('3 planes not linked')).toBeTruthy();
    expect(screen.queryByText('Mist')).toBeNull();
    expect(screen.queryByText('ClearPass')).toBeNull();
    expect(screen.queryByText('UXI')).toBeNull();

    // The line is the route to fixing it, not a dead label.
    fireEvent.click(screen.getByText('3 planes not linked'));
    expect(screen.getByTestId('path').textContent).toBe('/systems');
  });

  it('(e) a demo-sourced payload keeps the authored fixture prose', async () => {
    mockGetOverview.mockResolvedValue(
      liveData({ dataSource: 'demo', sites: siteRows(6) }),
    );
    renderOverview();

    expect(await screen.findByText('All 7 alerts →')).toBeTruthy();
    expect(screen.getByText('All 10 sites →')).toBeTruthy();
    expect(
      screen.getByText('Ten sites, six management planes — one queue of things that actually need you.'),
    ).toBeTruthy();
  });

  it('(f) the Sites table previews six rows while the link names the estate total', async () => {
    mockGetOverview.mockResolvedValue(liveData({ sites: siteRows(9) }));
    renderOverview();

    expect(await screen.findByText('All 9 sites →')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Site 6' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Site 7' })).toBeNull();
  });

  it('(g) blend mode stamps the real poll time and badges which sections are live', async () => {
    mockGetOverview.mockResolvedValue(
      liveData({
        dataSource: 'demo',
        blended: ['stats', 'alerts'],
        syncedAt: '2026-07-26T09:05:00',
      }),
    );
    renderOverview();

    // Real rows are on screen, so the prototype's fixed stamp must not be asserted.
    expect(await screen.findByText('SYNCED 09:05 · AUTO 60s')).toBeTruthy();
    expect(screen.queryByText(/SYNCED 09:41/)).toBeNull();
    // The envelope names the swapped sections; the chrome says which is which.
    expect(screen.getByText('LIVE')).toBeTruthy();
    expect(screen.getAllByText('DEMO').length).toBeGreaterThan(0);
  });

  it('(h) an empty live payload renders per-section empty states, not naked headers', async () => {
    mockGetOverview.mockResolvedValue(
      liveData({ alerts: [], sites: [], planes: [], changes: [], launchpad: [] }),
    );
    renderOverview();

    expect(await screen.findByText('Nothing needs you right now')).toBeTruthy();
    expect(screen.getByText('No sites reported yet')).toBeTruthy();
    expect(screen.getByText('No management planes linked')).toBeTruthy();
    expect(screen.getByText('No brokered changes yet')).toBeTruthy();
    expect(screen.getByText('No launch targets')).toBeTruthy();
  });

  it('(j) change-log rows sharing a time and text both render', async () => {
    // The live broker tail really does repeat itself: two 19:33 "alert-ack"
    // rows differing only by ticket. A key of time+text collided and React
    // dropped one of them.
    const { errors, restore } = captureConsoleErrors();
    mockGetOverview.mockResolvedValue(
      liveData({
        changes: [
          { time: '19:33', text: 'alert-ack alert — validated', who: 'NET-4202 · write broker' },
          { time: '19:33', text: 'alert-ack alert — validated', who: 'NET-0000 · write broker' },
        ],
      }),
    );
    renderOverview();

    expect((await screen.findAllByText('alert-ack alert — validated')).length).toBe(2);
    expect(screen.getByText('NET-4202 · write broker')).toBeTruthy();
    expect(screen.getByText('NET-0000 · write broker')).toBeTruthy();
    expect(errors.filter((e) => String(e[0]).includes('same key'))).toEqual([]);
    restore();
  });

  it('(j) change-log rows identical in every field keep distinct keys', async () => {
    const { errors, restore } = captureConsoleErrors();
    const row = { time: '19:33', text: 'disconnect client — validated', who: 'write broker' };
    mockGetOverview.mockResolvedValue(liveData({ changes: [{ ...row }, { ...row }] }));
    renderOverview();

    expect((await screen.findAllByText('disconnect client — validated')).length).toBe(2);
    expect(errors.filter((e) => String(e[0]).includes('same key'))).toEqual([]);
    restore();
  });

  it('(k) a live section with nothing in it offers no "all N →" link', async () => {
    mockGetOverview.mockResolvedValue(liveData({ alerts: [], sites: [] }));
    renderOverview();

    expect(await screen.findByText('Nothing needs you right now')).toBeTruthy();
    expect(screen.queryByText('All 0 alerts →')).toBeNull();
    expect(screen.queryByText('All 0 sites →')).toBeNull();
    expect(screen.queryByText(/All 0 /)).toBeNull();
    // The demo prose must not stand in for a live section that reported nothing.
    expect(screen.queryByText('All 7 alerts →')).toBeNull();
    expect(screen.queryByText('All 10 sites →')).toBeNull();
  });

  it('(i) the overline names the workspace the API computed for this screen', async () => {
    mockGetOverview.mockResolvedValue(liveData({ workspace: 'Meridian Health' }));
    renderOverview();

    // The trail is carried as data, not painted: the sticky topbar already
    // renders the same breadcrumbs above the screen header.
    await waitFor(() =>
      expect(document.querySelector('[data-path="Meridian Health / Single pane"]')).toBeTruthy(),
    );
  });
});
