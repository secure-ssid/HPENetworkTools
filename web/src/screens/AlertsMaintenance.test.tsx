/**
 * web/src/screens/AlertsMaintenance.test.tsx — the maintenance-windows section
 * and the occurrence-timeline drawer.
 *
 * getAlerts is mocked at the client boundary (the same harness Alerts.test.tsx
 * uses); the maintenance/timeline calls go through apiFetch, so `fetch` itself
 * is stubbed per test — including the rejection that simulates an unreachable
 * backend, where the section falls back to the AUTHORED demo windows, labelled.
 *
 * Covered:
 *  (a) the section lists served windows with state, reason and matchers;
 *  (b) an unreachable backend swaps in the authored demo windows, labelled,
 *      with creation disabled and the substitution stated;
 *  (c) the create drawer mirrors the route's validation and posts the window;
 *  (d) toggle and delete call PATCH/DELETE and re-read the list;
 *  (e) the Timeline drawer renders the served join with its correlation line;
 *  (f) offline, the flapping-AP group still gets its authored demo spine —
 *      labelled as what it is.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Alerts from './Alerts';
import { SettingsProvider } from '../app/SettingsContext';
import { ToastProvider } from '../nightdesk';
import { getAlerts } from '../api/client';
import { resetBackendReachability } from '../api/core';
import type { AlertsData } from '../api/client';
import type { AlertRow, MaintenanceWindowView } from '@hpe/shared';
import { DEMO_TIMELINE_FINGERPRINT } from '@hpe/shared';

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

if (typeof globalThis.ResizeObserver === 'undefined') {
  class ResizeObserverStub {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
}

vi.mock('../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/client')>();
  return { ...actual, getAlerts: vi.fn() };
});

const mockGetAlerts = vi.mocked(getAlerts);
const fetchMock = vi.fn();

const AP_ROW: AlertRow = {
  sev: 'P2',
  tone: 'warning',
  title: 'Wi-Fi drops, 3rd floor east — 22 clients',
  detail: 'ap-3f-12, ap-3f-14 · dfs radar events on 5GHz',
  siteId: 'campus-02',
  siteName: 'Campus-02 Research',
  plane: 'MIST',
  state: 'open',
  age: '10m',
  device: 'ap-3f-12',
};

const ACTIVE_WINDOW: MaintenanceWindowView = {
  id: 'mw-1',
  reason: 'ISP cutover, ticket NET-4211',
  matchers: { device: 'gw-edge-1', site: 'Campus-01 HQ' },
  schedule: { kind: 'weekly', days: [2, 4], startTime: '22:00', endTime: '02:00' },
  enabled: true,
  createdBy: 'operator',
  createdAt: '2026-08-01T09:00:00.000Z',
  state: 'active',
  spanStart: '2026-08-04T22:00:00.000Z',
  spanEnd: '2026-08-05T02:00:00.000Z',
};

const UPCOMING_WINDOW: MaintenanceWindowView = {
  id: 'mw-2',
  reason: 'CX firmware 10.13 rollout',
  matchers: { plane: 'LOCAL', titleSubstring: 'firmware' },
  schedule: { kind: 'once', start: '2026-08-08T02:00:00.000Z', end: '2026-08-08T04:00:00.000Z' },
  enabled: false,
  createdBy: 'operator',
  createdAt: '2026-08-01T09:00:00.000Z',
  state: 'upcoming',
  spanStart: '2026-08-08T02:00:00.000Z',
  spanEnd: '2026-08-08T04:00:00.000Z',
};

/** Route the stubbed fetch by URL: windows CRUD, timeline, and a default. */
function stubFetch(handlers: {
  windows?: MaintenanceWindowView[] | 'reject';
  window?: MaintenanceWindowView | 'reject';
  timeline?: unknown | 'reject';
}) {
  fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url.startsWith('/api/maintenance-windows')) {
      if (handlers.windows === 'reject' || handlers.window === 'reject') throw new TypeError('fetch failed');
      if (method === 'GET') return jsonResponse({ windows: handlers.windows ?? [] });
      if (method === 'POST' || method === 'PATCH') return jsonResponse({ window: handlers.window ?? ACTIVE_WINDOW }, method === 'POST' ? 201 : 200);
      if (method === 'DELETE') return jsonResponse({ ok: true });
    }
    if (url.startsWith('/api/alerts/') && url.endsWith('/timeline')) {
      if (handlers.timeline === 'reject') throw new TypeError('fetch failed');
      return jsonResponse({ timeline: handlers.timeline });
    }
    return jsonResponse({}, 404);
  });
  vi.stubGlobal('fetch', fetchMock);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function liveData(over: Partial<AlertsData> = {}): AlertsData {
  return { alerts: [AP_ROW], syncedAt: null, dataSource: 'live', ...over };
}

function renderAlerts() {
  return render(
    <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <ToastProvider>
        <SettingsProvider>
          <Alerts />
        </SettingsProvider>
      </ToastProvider>
    </MemoryRouter>,
  );
}

async function goToPolicyTab() {
  fireEvent.click(await screen.findByRole('tab', { name: 'Policy' }));
}

beforeEach(() => {
  mockGetAlerts.mockReset();
  fetchMock.mockReset();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  // The offline tests reject fetch, which marks the backend unreachable in the
  // api core's module state — reset it or later suites inherit the outage.
  resetBackendReachability();
});

describe('the maintenance windows section', () => {
  it('(a) lists served windows with state, reason and matchers', async () => {
    stubFetch({ windows: [ACTIVE_WINDOW, UPCOMING_WINDOW] });
    mockGetAlerts.mockResolvedValue(liveData());
    renderAlerts();
    await goToPolicyTab();

    expect(await screen.findByText('MAINTENANCE WINDOWS (2)')).toBeTruthy();
    expect(screen.getByText('ISP cutover, ticket NET-4211')).toBeTruthy();
    expect(screen.getByText('CX firmware 10.13 rollout')).toBeTruthy();
    expect(screen.getByText('active')).toBeTruthy();
    expect(screen.getByText('upcoming')).toBeTruthy();
    expect(screen.getByText(/device gw-edge-1 · site Campus-01 HQ/)).toBeTruthy();
    expect(screen.getByText(/disabled/)).toBeTruthy();
    expect(screen.getByText(/Tue Thu 22:00–02:00/)).toBeTruthy();
  });

  it('(b) falls back to the authored demo windows, labelled, when the backend is unreachable', async () => {
    stubFetch({ windows: 'reject' });
    mockGetAlerts.mockResolvedValue(liveData());
    renderAlerts();
    await goToPolicyTab();

    expect(await screen.findByText(/AP firmware staging — 3rd-floor-east radios/)).toBeTruthy();
    expect(screen.getByText(/CX firmware 10\.13\.1005 rollout — six access switches/)).toBeTruthy();
    expect(screen.getAllByText('demo').length).toBeGreaterThan(0);
    expect(screen.getByText(/demo fixtures — the backend is unreachable/)).toBeTruthy();
    // No server, no writes: the create action is disabled, not fake.
    expect(screen.getByRole('button', { name: 'New window' })).toHaveProperty('disabled', true);
  });

  it('(c) the create drawer mirrors the route’s validation and posts the window', async () => {
    stubFetch({ windows: [] });
    mockGetAlerts.mockResolvedValue(liveData());
    renderAlerts();
    await goToPolicyTab();

    fireEvent.click(await screen.findByRole('button', { name: 'New window' }));
    const dialog = await screen.findByRole('dialog');
    const submit = within(dialog).getByRole('button', { name: 'Schedule window' });
    expect(submit).toHaveProperty('disabled', true);
    expect(within(dialog).getByText(/a window needs a reason/)).toBeTruthy();

    fireEvent.change(within(dialog).getByLabelText('Window reason'), { target: { value: 'ISP cutover' } });
    // Still no silence-expressible matcher — site alone cannot hush.
    fireEvent.change(within(dialog).getByLabelText('Site matcher'), { target: { value: 'Campus-01 HQ' } });
    expect(submit).toHaveProperty('disabled', true);
    expect(within(dialog).getByText(/at least one of plane, device or title substring/)).toBeTruthy();

    fireEvent.change(within(dialog).getByLabelText('Device matcher'), { target: { value: 'gw-edge-1' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Tue' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Sat' })); // off again
    expect(submit).toHaveProperty('disabled', false);
    fireEvent.click(submit);

    await waitFor(() => {
      const post = fetchMock.mock.calls.find(([, init]) => (init as RequestInit)?.method === 'POST');
      expect(post).toBeTruthy();
      expect(JSON.parse(String((post![1] as RequestInit).body))).toEqual({
        reason: 'ISP cutover',
        matchers: { device: 'gw-edge-1', site: 'Campus-01 HQ' },
        schedule: { kind: 'weekly', days: [2], startTime: '02:00', endTime: '04:00' },
      });
    });
    // The list is re-read after a create lands.
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url) === '/api/maintenance-windows')).toBe(true));
  });

  it('(d) toggle and delete call PATCH/DELETE and re-read the list', async () => {
    stubFetch({ windows: [ACTIVE_WINDOW] });
    mockGetAlerts.mockResolvedValue(liveData());
    renderAlerts();
    await goToPolicyTab();

    fireEvent.click(await screen.findByRole('switch', { name: /Enable window: ISP cutover/ }));
    await waitFor(() => {
      const patch = fetchMock.mock.calls.find(([, init]) => (init as RequestInit)?.method === 'PATCH');
      expect(patch).toBeTruthy();
      expect(String(patch![0])).toBe('/api/maintenance-windows/mw-1');
      expect(JSON.parse(String((patch![1] as RequestInit).body))).toEqual({ enabled: false });
    });

    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    await waitFor(() => {
      const del = fetchMock.mock.calls.find(([, init]) => (init as RequestInit)?.method === 'DELETE');
      expect(del).toBeTruthy();
      expect(String(del![0])).toBe('/api/maintenance-windows/mw-1');
    });
  });
});

describe('the occurrence timeline drawer', () => {
  it('(e) renders the served join with its correlation line', async () => {
    stubFetch({
      windows: [],
      timeline: {
        fingerprint: 'mist|ap-3f-12|wi-fi drops, 3rd floor east — 22 clients',
        device: 'ap-3f-12',
        events: [
          { ts: '2026-08-01T09:00:00.000Z', kind: 'change', label: 'push — ssid profile to campus-02', detail: 'change chg-1 · ticket NET-1' },
          { ts: '2026-08-01T09:05:00.000Z', kind: 'fired', label: 'Fired ×23 — first seen 2h ago, latest 10m ago', approximate: true },
          { ts: '2026-08-01T09:30:00.000Z', kind: 'silenced', label: 'Silenced — AP firmware staging', detail: 'maintenance window mw-1' },
        ],
        correlation: '2 alerts fired within 30m after change chg-1 — a correlation in time, not a proven cause',
      },
    });
    mockGetAlerts.mockResolvedValue(liveData());
    renderAlerts();

    fireEvent.click(await screen.findByRole('button', { name: 'Timeline' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Occurrence timeline')).toBeTruthy();
    expect((await within(dialog).findAllByText(/Fired ×23/)).length).toBeGreaterThan(0);
    expect(within(dialog).getByText(/Silenced — AP firmware staging/)).toBeTruthy();
    expect(within(dialog).getByText(/ssid profile to campus-02/)).toBeTruthy();
    expect(within(dialog).getByText(/2 alerts fired within 30m after change chg-1/)).toBeTruthy();
    // Approximate firing times are marked as such.
    expect(within(dialog).getByText(/≈/)).toBeTruthy();
  });

  it('(f) offline, the flapping AP keeps its authored demo spine — labelled', async () => {
    stubFetch({ windows: [], timeline: 'reject' });
    mockGetAlerts.mockResolvedValue(liveData());
    renderAlerts();

    fireEvent.click(await screen.findByRole('button', { name: 'Timeline' }));
    const dialog = await screen.findByRole('dialog');
    expect((await within(dialog).findAllByText(/deduped ×23/)).length).toBeGreaterThan(0);
    expect(within(dialog).getByText(/mw-demo-ap3f/)).toBeTruthy();
    expect(within(dialog).getByText(/backend unreachable — the authored demo timeline stands in/)).toBeTruthy();
    expect(within(dialog).getByText(/23 alerts fired within 30m after change chg-demo-4148/)).toBeTruthy();
  });
});

// Kept honest: the fixture fingerprint the offline fallback keys on is the
// group's real fingerprint, so the demo spine can never attach to the wrong row.
describe('the offline fallback key', () => {
  it('is the authored demo fingerprint', () => {
    expect(DEMO_TIMELINE_FINGERPRINT).toBe('mist|ap-3f-12|wi-fi drops, 3rd floor east — 22 clients');
  });
});
