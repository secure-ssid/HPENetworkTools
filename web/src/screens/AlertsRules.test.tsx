/**
 * web/src/screens/AlertsRules.test.tsx — the device-down rules section.
 *
 * getAlerts is mocked at the client boundary (the same harness Alerts.test.tsx
 * and AlertsMaintenance.test.tsx use); the rule CRUD calls go through apiFetch,
 * so `fetch` itself is stubbed per test with a small in-memory store — including
 * the rejection that simulates an unreachable backend, where the section falls
 * back to the AUTHORED demo rule, labelled.
 *
 * Covered:
 *  (a) the section lists served rules with scope, thresholds and enabled state;
 *  (b) an unreachable backend swaps in the authored demo rule, labelled, with
 *      creation disabled and no fake controls on the row;
 *  (c) the create drawer mirrors the route's validation (the shared
 *      validateDeviceDownRule) and posts exactly the route's body;
 *  (d) the edit drawer seeds from the rule and a blanked site filter is sent
 *      as the tri-state clear (null), not silently kept;
 *  (e) the enabled switch PUTs {enabled} and the list re-reads;
 *  (f) delete goes through the confirm drawer — Cancel deletes nothing,
 *      Delete rule issues the DELETE and the list re-reads.
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
import type { AlertRow, DeviceDownRule, DeviceDownRuleInput } from '@hpe/shared';

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

const RULE_AP: DeviceDownRule = {
  id: 'arl-ap1',
  enabled: true,
  siteFilter: 'Campus-01 HQ',
  deviceTypeFilter: 'ap',
  offlineMinutes: 10,
  cooldownMinutes: 120,
  createdAt: '2026-08-01T09:00:00.000Z',
};

const RULE_ALL: DeviceDownRule = {
  id: 'arl-all1',
  enabled: false,
  offlineMinutes: 5,
  cooldownMinutes: 60,
  createdAt: '2026-08-01T10:00:00.000Z',
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/**
 * Route the stubbed fetch by URL: a small in-memory rule store so the
 * section's re-read after a mutation shows what the server would have kept —
 * or 'reject' for the unreachable-backend demo fallback.
 */
function stubFetch(initial: DeviceDownRule[] | 'reject') {
  let rules: DeviceDownRule[] = initial === 'reject' ? [] : [...initial];
  fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url === '/api/alert-rules') {
      if (initial === 'reject') throw new TypeError('fetch failed');
      if (method === 'GET') return jsonResponse({ rules });
      if (method === 'POST') {
        const body = JSON.parse(String(init?.body)) as DeviceDownRuleInput;
        const rule: DeviceDownRule = {
          id: 'arl-new',
          enabled: body.enabled ?? true,
          ...(typeof body.siteFilter === 'string' && body.siteFilter.trim()
            ? { siteFilter: body.siteFilter }
            : {}),
          ...(body.deviceTypeFilter && body.deviceTypeFilter !== 'all'
            ? { deviceTypeFilter: body.deviceTypeFilter }
            : {}),
          offlineMinutes: body.offlineMinutes ?? 5,
          cooldownMinutes: body.cooldownMinutes ?? 60,
          createdAt: '2026-08-02T00:00:00.000Z',
        };
        rules = [rule, ...rules];
        return jsonResponse({ rule }, 201);
      }
    }
    if (url.startsWith('/api/alert-rules/')) {
      if (initial === 'reject') throw new TypeError('fetch failed');
      const id = url.slice('/api/alert-rules/'.length);
      if (method === 'PUT') {
        const body = JSON.parse(String(init?.body)) as DeviceDownRuleInput;
        const idx = rules.findIndex((r) => r.id === id);
        if (idx === -1) return jsonResponse({ error: `unknown alert rule '${id}'` }, 404);
        const merged: DeviceDownRule = {
          ...rules[idx]!,
          ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
          ...(body.offlineMinutes !== undefined ? { offlineMinutes: body.offlineMinutes } : {}),
          ...(body.cooldownMinutes !== undefined ? { cooldownMinutes: body.cooldownMinutes } : {}),
        };
        if (body.siteFilter !== undefined) {
          if (typeof body.siteFilter === 'string' && body.siteFilter.trim()) merged.siteFilter = body.siteFilter;
          else delete merged.siteFilter;
        }
        if (body.deviceTypeFilter !== undefined) {
          if (body.deviceTypeFilter === 'all') delete merged.deviceTypeFilter;
          else merged.deviceTypeFilter = body.deviceTypeFilter;
        }
        rules[idx] = merged;
        return jsonResponse({ rule: merged });
      }
      if (method === 'DELETE') {
        rules = rules.filter((r) => r.id !== id);
        return jsonResponse({ ok: true });
      }
    }
    if (url.startsWith('/api/maintenance-windows')) return jsonResponse({ windows: [] });
    return jsonResponse({}, 404);
  });
  vi.stubGlobal('fetch', fetchMock);
}

/** The fetch calls that hit the rule store with a given method. */
function ruleCalls(method: string) {
  return fetchMock.mock.calls.filter(
    ([url, init]) => String(url).startsWith('/api/alert-rules') && (init as RequestInit | undefined)?.method === method,
  );
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

/** The device-down rules section container — toasts render outside it, so a
 *  scoped query never matches the summary a toast repeats. */
function rulesSection() {
  const label = screen.getByText(/^DEVICE-DOWN RULES/);
  const header = label.closest('div');
  if (!header || !header.parentElement) throw new Error('rules section not found');
  return within(header.parentElement);
}

beforeEach(() => {
  mockGetAlerts.mockReset();
  fetchMock.mockReset();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  // The offline test rejects fetch, which marks the backend unreachable in the
  // api core's module state — reset it or later suites inherit the outage.
  resetBackendReachability();
});

describe('the device-down rules section', () => {
  it('(a) lists served rules with scope, thresholds and enabled state', async () => {
    stubFetch([RULE_AP, RULE_ALL]);
    mockGetAlerts.mockResolvedValue(liveData());
    renderAlerts();
    await goToPolicyTab();

    expect(await screen.findByText('DEVICE-DOWN RULES (2)')).toBeTruthy();
    expect(rulesSection().getByText('Access points')).toBeTruthy();
    expect(rulesSection().getByText('Campus-01 HQ')).toBeTruthy();
    expect(rulesSection().getByText(/alert after 10m offline · cooldown 120m/)).toBeTruthy();
    expect(rulesSection().getByText('All device types')).toBeTruthy();
    expect(rulesSection().getByText('all sites')).toBeTruthy();
    expect(rulesSection().getByText('disabled')).toBeTruthy();
    expect(rulesSection().getByRole('button', { name: 'New rule' })).toHaveProperty('disabled', false);
    expect(
      rulesSection()
        .getByRole('switch', { name: 'Enable rule: ap · site Campus-01 HQ — alert after 10m offline · cooldown 120m' })
        .getAttribute('aria-checked'),
    ).toBe('true');
  });

  it('(b) falls back to the authored demo rule, labelled, when the backend is unreachable', async () => {
    stubFetch('reject');
    mockGetAlerts.mockResolvedValue(liveData());
    renderAlerts();
    await goToPolicyTab();

    expect(await screen.findByText('DEVICE-DOWN RULES (1)')).toBeTruthy();
    expect(screen.getByText(/demo fixture — the backend is unreachable/)).toBeTruthy();
    expect(screen.getByText('demo')).toBeTruthy();
    // The authored demo rule: all types, all sites, 1m/60m (shared DEMO_DEVICE_DOWN_RULE).
    expect(screen.getByText(/alert after 1m offline · cooldown 60m/)).toBeTruthy();
    // No server, no writes: creation is disabled and the row carries no fake controls.
    expect(screen.getByRole('button', { name: 'New rule' })).toHaveProperty('disabled', true);
    expect(screen.queryByRole('switch', { name: /Enable rule:/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
  });

  it('(c) the create drawer mirrors the route’s validation and posts the rule', async () => {
    stubFetch([]);
    mockGetAlerts.mockResolvedValue(liveData());
    renderAlerts();
    await goToPolicyTab();

    fireEvent.click(await screen.findByRole('button', { name: 'New rule' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('New device-down rule')).toBeTruthy();
    const submit = within(dialog).getByRole('button', { name: 'Create rule' });
    // The defaults (5m / 60m) are valid — the route would apply them anyway.
    expect(submit).toHaveProperty('disabled', false);

    fireEvent.change(within(dialog).getByLabelText('Offline minutes'), { target: { value: '0' } });
    expect(submit).toHaveProperty('disabled', true);
    expect(
      within(dialog).getByText(/offlineMinutes must be a whole number of minutes between 1 and 1440/),
    ).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText('Offline minutes'), { target: { value: '1441' } });
    expect(submit).toHaveProperty('disabled', true);
    fireEvent.change(within(dialog).getByLabelText('Offline minutes'), { target: { value: '2.5' } });
    expect(submit).toHaveProperty('disabled', true);
    fireEvent.change(within(dialog).getByLabelText('Offline minutes'), { target: { value: '' } });
    expect(within(dialog).getByText(/offline and cooldown minutes are both required/)).toBeTruthy();

    fireEvent.change(within(dialog).getByLabelText('Offline minutes'), { target: { value: '10' } });
    fireEvent.change(within(dialog).getByLabelText('Cooldown minutes'), { target: { value: '120' } });
    fireEvent.change(within(dialog).getByLabelText('Site filter'), { target: { value: 'Campus-01 HQ' } });
    fireEvent.change(within(dialog).getByLabelText('Device type filter'), { target: { value: 'ap' } });
    expect(submit).toHaveProperty('disabled', false);
    fireEvent.click(submit);

    await waitFor(() => {
      const posts = ruleCalls('POST');
      expect(posts).toHaveLength(1);
      expect(JSON.parse(String((posts[0]![1] as RequestInit).body))).toEqual({
        enabled: true,
        deviceTypeFilter: 'ap',
        offlineMinutes: 10,
        cooldownMinutes: 120,
        siteFilter: 'Campus-01 HQ',
      });
    });
    // The list is re-read after a create lands, and the new rule renders.
    expect(await screen.findByText('DEVICE-DOWN RULES (1)')).toBeTruthy();
    expect(rulesSection().getByText(/alert after 10m offline · cooldown 120m/)).toBeTruthy();
  });

  it('(d) the edit drawer seeds from the rule and a blanked site filter clears (null), never keeps', async () => {
    stubFetch([RULE_AP]);
    mockGetAlerts.mockResolvedValue(liveData());
    renderAlerts();
    await goToPolicyTab();

    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Edit device-down rule')).toBeTruthy();
    expect(within(dialog).getByLabelText('Site filter')).toHaveProperty('value', 'Campus-01 HQ');
    expect(within(dialog).getByLabelText('Offline minutes')).toHaveProperty('value', '10');
    expect(within(dialog).getByLabelText('Cooldown minutes')).toHaveProperty('value', '120');

    fireEvent.change(within(dialog).getByLabelText('Site filter'), { target: { value: '' } });
    fireEvent.change(within(dialog).getByLabelText('Device type filter'), { target: { value: 'all' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save rule' }));

    await waitFor(() => {
      const puts = ruleCalls('PUT');
      expect(puts).toHaveLength(1);
      expect(String(puts[0]![0])).toBe('/api/alert-rules/arl-ap1');
      expect(JSON.parse(String((puts[0]![1] as RequestInit).body))).toEqual({
        enabled: true,
        deviceTypeFilter: 'all',
        offlineMinutes: 10,
        cooldownMinutes: 120,
        siteFilter: null,
      });
    });
    // The re-read shows the cleared narrowing.
    expect(await screen.findByText('all sites')).toBeTruthy();
    expect(screen.getByText('All device types')).toBeTruthy();
  });

  it('(e) the enabled switch PUTs {enabled} and the list re-reads', async () => {
    stubFetch([RULE_AP]);
    mockGetAlerts.mockResolvedValue(liveData());
    renderAlerts();
    await goToPolicyTab();

    fireEvent.click(
      await screen.findByRole('switch', {
        name: 'Enable rule: ap · site Campus-01 HQ — alert after 10m offline · cooldown 120m',
      }),
    );
    await waitFor(() => {
      const puts = ruleCalls('PUT');
      expect(puts).toHaveLength(1);
      expect(String(puts[0]![0])).toBe('/api/alert-rules/arl-ap1');
      expect(JSON.parse(String((puts[0]![1] as RequestInit).body))).toEqual({ enabled: false });
    });
    expect(await screen.findByText('disabled')).toBeTruthy();
  });

  it('(f) delete goes through the confirm drawer — Cancel deletes nothing, Delete rule issues the DELETE', async () => {
    stubFetch([RULE_AP]);
    mockGetAlerts.mockResolvedValue(liveData());
    renderAlerts();
    await goToPolicyTab();

    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Delete device-down rule')).toBeTruthy();
    expect(
      within(dialog).getByText(/ap · site Campus-01 HQ — alert after 10m offline · cooldown 120m/),
    ).toBeTruthy();

    // The click is not the decision: Cancel keeps the rule and sends nothing.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(ruleCalls('DELETE')).toHaveLength(0);
    expect(screen.getByText('DEVICE-DOWN RULES (1)')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    const confirm = await screen.findByRole('dialog');
    fireEvent.click(within(confirm).getByRole('button', { name: 'Delete rule' }));
    await waitFor(() => {
      const deletes = ruleCalls('DELETE');
      expect(deletes).toHaveLength(1);
      expect(String(deletes[0]![0])).toBe('/api/alert-rules/arl-ap1');
    });
    // The re-read is honest about the empty store.
    expect(
      await screen.findByText(/No device-down rules — a device that stops reporting raises nothing/),
    ).toBeTruthy();
  });
});
