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
import { ToastProvider } from '../nightdesk';
import { getMetricsHistory, getOverview } from '../api/client';
import type { OverviewData } from '../api/client';
import { OVERVIEW_PLANES } from '@hpe/shared';
import type { AnomalyFlag, MetricPoint, MetricsEnvelopeWithAnomalies, MetricsHistoryEnvelope } from '@hpe/shared';

vi.mock('../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/client')>();
  // getMetricsHistory defaults to null (API unreachable/older server): plane
  // rows then carry no series rather than invented history.
  return { ...actual, getOverview: vi.fn(), getMetricsHistory: vi.fn(() => Promise.resolve(null)) };
});

const mockGetOverview = vi.mocked(getOverview);
const mockGetMetrics = vi.mocked(getMetricsHistory);

afterEach(() => {
  cleanup();
  mockGetOverview.mockReset();
  mockGetMetrics.mockReset();
  // mockReset strips the factory default too — restore it so tests that never
  // touch metrics still get a resolved null instead of `undefined`.
  mockGetMetrics.mockImplementation(() => Promise.resolve(null));
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
    <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <ToastProvider>
        <SettingsProvider>
          <Overview />
          <PathProbe />
        </SettingsProvider>
      </ToastProvider>
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

/* The stat tiles are the landing screen's counts, and every count is a
 * promise that a list exists behind it. Each known tile links to the screen
 * whose list its number summarises (the LibreNMS availability-map pattern);
 * a stat whose label nobody mapped stays plain text rather than guessing. */
describe('Overview stat tiles as links', () => {
  const TILE_STATS: OverviewData['stats'] = [
    { label: 'Devices reachable', value: '404 / 418', delta: '▼ 3 down', tone: 'negative' },
    { label: 'Open alerts', value: '7', delta: '▲ 2 critical', tone: 'negative' },
    { label: 'Config drift', value: '12', delta: '▼ 4 this week', tone: 'positive' },
    { label: 'Licences ≤60d', value: '34', delta: '▲ 12 renewals due', tone: 'neutral' },
    { label: 'Planes linked', value: '6 / 7', delta: 'Classic degraded', tone: 'negative' },
  ];

  it('links each known tile to the screen that lists what it counts', async () => {
    mockGetOverview.mockResolvedValue(liveData({ stats: TILE_STATS }));
    renderOverview();

    expect((await screen.findByText('Devices reachable')).closest('a')?.getAttribute('href')).toBe('/devices');
    expect(screen.getByText('Open alerts').closest('a')?.getAttribute('href')).toBe('/alerts');
    expect(screen.getByText('Config drift').closest('a')?.getAttribute('href')).toBe('/compliance');
    expect(screen.getByText('Licences ≤60d').closest('a')?.getAttribute('href')).toBe('/licenses');
    expect(screen.getByText('Planes linked').closest('a')?.getAttribute('href')).toBe('/systems');
  });

  it('navigates when a tile is clicked', async () => {
    mockGetOverview.mockResolvedValue(liveData({ stats: TILE_STATS }));
    renderOverview();

    fireEvent.click(await screen.findByText('Open alerts'));
    expect(screen.getByTestId('path').textContent).toBe('/alerts');
  });

  /* The labels are the same in demo and live (the fixtures and the server's
     liveOverviewStats share them), so the demo tiles link identically — the
     demo/live labelling around them is untouched. */
  it('links the demo tiles the same way', async () => {
    mockGetOverview.mockResolvedValue(liveData({ dataSource: 'demo', stats: TILE_STATS }));
    renderOverview();

    expect((await screen.findByText('Planes linked')).closest('a')?.getAttribute('href')).toBe('/systems');
  });

  it('leaves a stat it has no destination for as plain text', async () => {
    // A label no mapping claims ('Devices' alone would also match the Sites
    // table's column header, so the stat gets a name of its own).
    mockGetOverview.mockResolvedValue(
      liveData({ stats: [{ label: 'Mystery stat', value: '1', delta: '', tone: 'neutral' }] }),
    );
    renderOverview();

    expect((await screen.findByText('Mystery stat')).closest('a')).toBeNull();
  });
});

/* The Change log panel is a render of the write broker's audit tail. Its
 * empty state describes a blank log as "No brokered changes yet" — a claim
 * that nothing has happened. When a rotated generation cannot be opened the
 * tail comes back short (or empty) and that same panel makes the claim over
 * a history that exists and is unreachable, which is its opposite. */
describe('Overview change log completeness', () => {
  it('does not say "no brokered changes" when part of the record is unreadable', async () => {
    mockGetOverview.mockResolvedValue(liveData({ changes: [], changesUnreadable: 2 }));

    renderOverview();

    await waitFor(() =>
      expect(screen.getByText('Part of the change record could not be read')).toBeTruthy(),
    );
    expect(screen.queryByText('No brokered changes yet')).toBeNull();
    expect(screen.getByText(/2 rotated log generations could not be opened/)).toBeTruthy();
    expect(screen.getByText(/not a record of nothing happening/)).toBeTruthy();
  });

  it('marks a non-empty tail as short when a generation could not be read', async () => {
    mockGetOverview.mockResolvedValue(
      liveData({ changes: [{ time: '09:32', text: 'VLAN 812 added', who: 'NET-1' }], changesUnreadable: 1 }),
    );

    renderOverview();

    // The rows shown are real and stay shown; what is added is that they are
    // not the whole history.
    await waitFor(() => expect(screen.getByText('VLAN 812 added')).toBeTruthy());
    expect(screen.getByText(/1 rotated log generation could not be read — this tail is short/)).toBeTruthy();
  });

  it('leaves a genuinely quiet log reading as quiet', async () => {
    mockGetOverview.mockResolvedValue(liveData({ changes: [], changesUnreadable: 0 }));

    renderOverview();

    await waitFor(() => expect(screen.getByText('No brokered changes yet')).toBeTruthy());
    expect(screen.queryByText(/could not be/)).toBeNull();
  });

  // An older server (or demo fixtures) sends no such field; absent must not
  // be read as a hole in the record.
  it('says nothing when the route did not report readability at all', async () => {
    mockGetOverview.mockResolvedValue(liveData({ changes: [] }));

    renderOverview();

    await waitFor(() => expect(screen.getByText('No brokered changes yet')).toBeTruthy());
    expect(screen.queryByText(/could not be/)).toBeNull();
  });
});

/* The Management-planes sparklines render the metrics-history envelope's
 * per-plane device series: the demo rows' long names resolve through the
 * planeMetricsKey bridge, a plane with no device inventory gets nothing
 * rather than a flat zero, and the caption under the panel states the
 * metric, window and cadence. A null envelope leaves the panel spark-free. */
describe('Overview plane sparklines', () => {
  const TWO_HOURS_AGO = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();

  const LIVE_METRICS: MetricsHistoryEnvelope = {
    dataSource: 'live',
    since: TWO_HOURS_AGO,
    sampleMs: 300_000,
    retentionMs: 86_400_000,
    planes: {
      Central: {
        devices: [
          { t: '2026-07-25T11:50:00.000Z', v: 8 },
          { t: '2026-07-25T11:55:00.000Z', v: 9 },
          { t: '2026-07-25T12:00:00.000Z', v: 9 },
        ],
        devicesDown: [],
        clients: [],
        alerts: [],
      },
    },
    deviceClients: {},
  };

  it('draws the series a linked plane has, and says what window it covers', async () => {
    mockGetOverview.mockResolvedValue(liveData());
    mockGetMetrics.mockResolvedValue(LIVE_METRICS);
    renderOverview();

    expect(
      await screen.findByRole('img', { name: /9 devices reported · since \d{2}:\d{2} · sampled every 5m/ }),
    ).toBeTruthy();
    expect(screen.getByText(/devices reported per plane · since \d{2}:\d{2} · sampled every 5m/)).toBeTruthy();
  });

  it('resolves the demo rows’ long names through the label bridge', async () => {
    mockGetOverview.mockResolvedValue(liveData({ dataSource: 'demo', planes: OVERVIEW_PLANES }));
    mockGetMetrics.mockResolvedValue({
      ...LIVE_METRICS,
      dataSource: 'demo',
      planes: { CENTRAL: LIVE_METRICS.planes.Central! },
      note: 'synthesized demo history — no plane was sampled',
    });
    renderOverview();

    // Exactly one row has a series: 'HPE Aruba Central' → CENTRAL.
    expect(
      await screen.findAllByRole('img', {
        name: '9 devices reported · last 24h · sampled every 5m · synthesized demo',
      }),
    ).toHaveLength(1);
    expect(screen.getByText(/devices reported per plane · last 24h · sampled every 5m · synthesized demo/)).toBeTruthy();
  });

  it('gives a plane without a device series nothing, and one sample honest text', async () => {
    mockGetOverview.mockResolvedValue(
      liveData({
        planes: [
          { name: 'Central', scope: 'GLOBAL', state: 'linked', tone: 'success', sync: '09:38', linked: true },
          { name: 'Mist', scope: 'cloud', state: 'linked', tone: 'success', sync: '09:39', linked: true },
          { name: 'GreenLake', scope: 'workspace', state: 'linked', tone: 'success', sync: '09:39', linked: true },
        ],
      }),
    );
    mockGetMetrics.mockResolvedValue({
      ...LIVE_METRICS,
      planes: {
        ...LIVE_METRICS.planes,
        // The row name 'Mist' resolves to MIST through the label bridge.
        MIST: { devices: [{ t: '2026-07-25T12:00:00.000Z', v: 3 }], devicesDown: [], clients: [], alerts: [] },
      },
    });
    renderOverview();

    await screen.findByText('1 sample');
    // Central's polyline is the only role=img on the panel: Mist renders its
    // one-sample text, GreenLake (no device inventory) renders nothing.
    expect(screen.getAllByRole('img')).toHaveLength(1);
  });

  it('leaves the panel alone when the server sends no metrics envelope', async () => {
    mockGetOverview.mockResolvedValue(liveData());
    mockGetMetrics.mockResolvedValue(null);
    renderOverview();

    await screen.findByText('Central');
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.queryByText(/devices reported per plane/)).toBeNull();
  });
});

/* The anomaly markers ride the additive `anomalies` block of the metrics
 * envelope: the server flags samples unusual for their own series (robust
 * z-score, shared/anomaly.ts), the rows dot them in the warning tone, and
 * the panel caption says what the dots are — only when there is one to
 * explain. An older server sends no block and renders exactly as before. */
describe('Overview plane anomaly markers', () => {
  const TWO_HOURS_AGO = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();

  /** A 13-sample series with one spike at index 9, and the flag for it. */
  const SPIKE_T = '2026-07-25T10:45:00.000Z';
  const FLAGGED_SERIES: MetricPoint[] = Array.from({ length: 13 }, (_, i) => ({
    t: new Date(Date.parse('2026-07-25T12:00:00.000Z') - (12 - i) * 300_000).toISOString(),
    v: i === 9 ? 42 : 10,
  }));
  const FLAG: AnomalyFlag = { index: 9, t: SPIKE_T, v: 42, direction: 'high', z: 31.9 };

  const FLAGGED_METRICS: MetricsEnvelopeWithAnomalies = {
    dataSource: 'demo',
    since: FLAGGED_SERIES[0]!.t,
    sampleMs: 300_000,
    retentionMs: 86_400_000,
    planes: {
      CENTRAL: { devices: FLAGGED_SERIES, devicesDown: [], clients: [], alerts: [] },
    },
    deviceClients: {},
    note: 'synthesized demo history — no plane was sampled',
    anomalies: { planes: { CENTRAL: { devices: [FLAG] } }, deviceClients: {} },
  };

  /** The same series and flag served live (ring still filling) under the
   *  row's short name, which the label bridge passes through unchanged. */
  const LIVE_FLAGGED: MetricsEnvelopeWithAnomalies = {
    ...FLAGGED_METRICS,
    dataSource: 'live',
    since: TWO_HOURS_AGO,
    note: undefined,
    planes: { Central: FLAGGED_METRICS.planes.CENTRAL! },
    anomalies: { planes: { Central: { devices: [FLAG] } }, deviceClients: {} },
  };

  /** Same live series, but the server found nothing unusual in it. */
  const LIVE_CALM: MetricsEnvelopeWithAnomalies = {
    ...LIVE_FLAGGED,
    anomalies: { planes: {}, deviceClients: {} },
  };

  it('dots the flagged sample, says so in the aria label, and explains the dots once', async () => {
    mockGetOverview.mockResolvedValue(liveData({ dataSource: 'demo', planes: OVERVIEW_PLANES }));
    mockGetMetrics.mockResolvedValue(FLAGGED_METRICS);
    renderOverview();

    // Exactly one row has a series (HPE Aruba Central → CENTRAL), and its
    // accessible name carries the flag mention the server sent.
    const imgs = await screen.findAllByRole('img', {
      name: '10 devices reported · last 24h · sampled every 5m · synthesized demo · 1 point flagged unusual',
    });
    expect(imgs).toHaveLength(1);
    // The dot sits in the warning tone inside the decorative svg.
    const dots = [...imgs[0]!.querySelectorAll('circle')];
    expect(dots).toHaveLength(1);
    expect(dots[0]!.getAttribute('fill')).toBe('var(--nd-warning)');
    // The panel states what the dots are and the window they were judged
    // against — statistics over retained samples, never a prediction.
    expect(
      screen.getByText(/dots mark samples unusual vs the last 24h this portal retained/),
    ).toBeTruthy();
  });

  it('a filling live ring names the shorter window it actually compares against', async () => {
    mockGetOverview.mockResolvedValue(liveData());
    mockGetMetrics.mockResolvedValue(LIVE_FLAGGED);
    renderOverview();

    expect(
      await screen.findByText(/dots mark samples unusual vs what this portal has retained so far/),
    ).toBeTruthy();
    expect(screen.queryByText(/the last 24h this portal retained/)).toBeNull();
  });

  it('no flags and no block both render as silence — no dots, no note', async () => {
    // A server that computed the block but found nothing unusual…
    mockGetOverview.mockResolvedValue(liveData());
    mockGetMetrics.mockResolvedValue(LIVE_CALM);
    renderOverview();
    expect(await screen.findByRole('img', { name: /10 devices reported/ })).toBeTruthy();
    expect(document.querySelector('circle[fill="var(--nd-warning)"]')).toBeNull();
    expect(screen.queryByText(/dots mark samples unusual/)).toBeNull();
    cleanup();

    // …and an older server that sends no anomalies block at all.
    const { anomalies: _dropped, ...olderServer } = LIVE_CALM;
    mockGetOverview.mockResolvedValue(liveData());
    mockGetMetrics.mockResolvedValue(olderServer);
    renderOverview();
    expect(await screen.findByRole('img', { name: /10 devices reported/ })).toBeTruthy();
    expect(document.querySelector('circle[fill="var(--nd-warning)"]')).toBeNull();
    expect(screen.queryByText(/dots mark samples unusual/)).toBeNull();
  });
});
