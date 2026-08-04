/**
 * web/src/screens/ClearPass.test.tsx — the policy-plane inventories.
 *
 * The api client is mocked at the module boundary (getClearPass only; the rest
 * stays real so SettingsProvider can use DEFAULT_SETTINGS).
 * Covered:
 *  (a) the endpoints tab renders the operator's description line and Device
 *      Insight's tags as badges on the rows that carry them;
 *  (b) each inventory tab renders its reported rows (NADs, auth sources,
 *      roles, local users);
 *  (c) the enforcement tab resolves the policy→default-profile→profile chain
 *      when the named profile is in the payload;
 *  (d) a key the envelope does not carry reads "Not reported by this CPPM" —
 *      never an authoritative-looking empty table — in demo AND live;
 *  (e) the services tab renders the richer 6.11 shape (enabled badge,
 *      template, hit count, order, auth sources, rules summary) from the
 *      demo fixtures, keeps "not available on this CPPM" for an absent key
 *      on an older box, and says a present-but-empty answer as a fact;
 *      device groups read "not available on this CPPM" in both modes;
 *  (f) the local-users tab carries no password material of any kind;
 *  (g) the services tab carries no credential material of any kind.
 *  (g2) static inventory rows open local, read-only details only; absent
 *       inventories remain absent and no credential-shaped data crosses.
 *
 * The reviewed-write drawers (api/clearpass mocked at the module boundary):
 *  (h/h2) 'Register endpoint' gates Apply on a valid MAC AND the explicit
 *      review checkbox, applies to the demo fixture world on success, and
 *      reports a refused write without merging it;
 *  (i) the per-endpoint edit applies only real changes (status/description);
 *  (j) 'Add local user' picks its role from the roles dataset and keeps the
 *      password write-only — sent, never displayed anywhere;
 *  (k) the per-user edit is prefilled, password optional, only changes cross;
 *  (l) live mode re-fetches the screen after a landed write.
 *
 * The service detail drawer (getClearPassServiceDetail mocked at the same
 *  boundary):
 *  (m) a service row's View action fetches the detail by id and renders every
 *      CPPM section — summary, match rules (the rule editor's table),
 *      authentication, authorization, enforcement, options;
 *  (n) the service name itself activates the same drawer;
 *  (o) fields the box did not report render 'Not reported', and a service
 *      with no conditions says so — nothing is invented;
 *  (p) a 404 read is 'no such service', a failed read says it broke, and the
 *      route's not-reported/failed answers stay four distinct sentences;
 *  (q) the drawer renders the whitelisted fields only — no credential
 *      material even when a payload tries to smuggle it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import ClearPass from './ClearPass';
import { SettingsProvider } from '../app/SettingsContext';
import { ToastProvider } from '../nightdesk';
import { getClearPass, getClearPassServiceDetail } from '../api/client';
import type { ClearPassData } from '../api/client';
import {
  registerClearPassEndpoint,
  updateClearPassEndpoint,
  createClearPassLocalUser,
  updateClearPassLocalUser,
  getClearPassEndpointPage,
} from '../api/clearpass';
import { downloadApiCsv } from '../lib/downloadApiCsv';
import {
  AUTH_EVENTS,
  CLEARPASS_AUTH_SOURCES,
  CLEARPASS_ENDPOINTS,
  CLEARPASS_ENFORCEMENT_POLICIES,
  CLEARPASS_ENFORCEMENT_PROFILES,
  CLEARPASS_LOCAL_USERS,
  CLEARPASS_NETWORK_DEVICES,
  CLEARPASS_ROLES,
  CLEARPASS_SERVICES,
  CLEARPASS_SERVICE_DETAILS,
  type ClearPassServiceDetailLive,
} from '@hpe/shared';

const { mockLabConfigMode } = vi.hoisted(() => ({ mockLabConfigMode: vi.fn(() => ({ lab: false })) }));
vi.mock('../hooks/useLabConfigMode', () => ({ useLabConfigMode: mockLabConfigMode }));

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
  return { ...actual, getClearPass: vi.fn(), getClearPassServiceDetail: vi.fn() };
});

vi.mock('../api/clearpass', () => ({
  registerClearPassEndpoint: vi.fn(),
  updateClearPassEndpoint: vi.fn(),
  createClearPassLocalUser: vi.fn(),
  updateClearPassLocalUser: vi.fn(),
  getClearPassEndpointPage: vi.fn(),
}));

vi.mock('../lib/downloadApiCsv', () => ({
  downloadApiCsv: vi.fn(),
}));

const mockGetClearPass = vi.mocked(getClearPass);
const mockGetServiceDetail = vi.mocked(getClearPassServiceDetail);
const mockRegister = vi.mocked(registerClearPassEndpoint);
const mockUpdateEndpoint = vi.mocked(updateClearPassEndpoint);
const mockCreateUser = vi.mocked(createClearPassLocalUser);
const mockUpdateUser = vi.mocked(updateClearPassLocalUser);
const mockGetEndpointPage = vi.mocked(getClearPassEndpointPage);
const mockDownloadApiCsv = vi.mocked(downloadApiCsv);

/** Demo envelope from the real fixtures — deviceGroups stays absent. */
function demoData(over: Partial<ClearPassData> = {}): ClearPassData {
  return {
    endpoints: CLEARPASS_ENDPOINTS,
    authEvents: AUTH_EVENTS,
    networkDevices: CLEARPASS_NETWORK_DEVICES,
    authSources: CLEARPASS_AUTH_SOURCES,
    roles: CLEARPASS_ROLES,
    enforcementPolicies: CLEARPASS_ENFORCEMENT_POLICIES,
    enforcementProfiles: CLEARPASS_ENFORCEMENT_PROFILES,
    localUsers: CLEARPASS_LOCAL_USERS,
    services: CLEARPASS_SERVICES,
    dataSource: 'demo',
    syncedAt: '09:41',
    ...over,
  };
}

/** Minimal live envelope; per-test overrides (the inventory keys) go in `over`. */
function liveData(over: Partial<ClearPassData> = {}): ClearPassData {
  return {
    endpoints: [],
    authEvents: [],
    syncedAt: null,
    dataSource: 'live',
    canWrite: true,
    ...over,
  };
}

function endpointPage(over: Partial<Awaited<ReturnType<typeof getClearPassEndpointPage>>> = {}) {
  return {
    dataSource: 'demo' as const,
    state: 'ok' as const,
    endpoints: CLEARPASS_ENDPOINTS,
    offset: 0,
    limit: 50,
    total: CLEARPASS_ENDPOINTS.length,
    nextOffset: null,
    more: 'no' as const,
    ...over,
  };
}

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="loc">{`${location.pathname}${location.search}`}</div>;
}

function renderClearPass(entry = '/clearpass') {
  return render(
    <MemoryRouter
      future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
      initialEntries={[entry]}
    >
      <ToastProvider>
        <SettingsProvider>
          <Routes>
            <Route
              path="/clearpass"
              element={
                <>
                  <ClearPass />
                  <LocationProbe />
                </>
              }
            />
          </Routes>
        </SettingsProvider>
      </ToastProvider>
    </MemoryRouter>,
  );
}

function openTab(name: string) {
  fireEvent.click(screen.getByRole('tab', { name }));
}

beforeEach(() => {
  mockGetEndpointPage.mockResolvedValue(endpointPage());
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  mockLabConfigMode.mockReturnValue({ lab: false });
});

describe('ClearPass', () => {
  it('loads a separate endpoint page and documents filter scope', async () => {
    mockGetClearPass.mockResolvedValue(demoData({ endpoints: [] }));
    mockGetEndpointPage.mockResolvedValue(endpointPage({ endpoints: [CLEARPASS_ENDPOINTS[0]], total: 101, nextOffset: 50, more: 'yes' }));
    renderClearPass();

    await waitFor(() => expect(mockGetEndpointPage).toHaveBeenCalledWith(0, 50, {}));
    expect(screen.getByText('1 loaded endpoint row')).toBeTruthy();
    expect(screen.getByLabelText('Filter endpoints')).toBeTruthy();
    expect(screen.getByText('Showing 1 endpoint on this page.')).toBeTruthy();
    expect(screen.getByText('Ward 3E rounds iPad — Dr. Okonjo')).toBeTruthy();
  });

  it('loads exact next and previous offsets, and resets to the first page when a filter changes', async () => {
    mockGetClearPass.mockResolvedValue(demoData({ endpoints: [] }));
    mockGetEndpointPage
      .mockResolvedValueOnce(endpointPage({ endpoints: [CLEARPASS_ENDPOINTS[0]], total: 101, nextOffset: 50, more: 'yes' }))
      .mockResolvedValueOnce(endpointPage({ endpoints: [CLEARPASS_ENDPOINTS[1]], offset: 50, total: 101, nextOffset: 51, more: 'yes' }))
      .mockResolvedValueOnce(endpointPage({ endpoints: [CLEARPASS_ENDPOINTS[0]], total: 101, nextOffset: 50, more: 'yes' }));
    renderClearPass();

    await screen.findByRole('button', { name: 'Next endpoint page' });
    fireEvent.click(screen.getByRole('button', { name: 'Next endpoint page' }));
    await waitFor(() => expect(mockGetEndpointPage).toHaveBeenLastCalledWith(50, 50, {}));
    fireEvent.change(screen.getByLabelText('Filter endpoints'), { target: { value: CLEARPASS_ENDPOINTS[0].mac } });
    await waitFor(() =>
      expect(mockGetEndpointPage).toHaveBeenLastCalledWith(0, 50, { q: CLEARPASS_ENDPOINTS[0].mac }),
    );
    expect(screen.getByRole('button', { name: 'Previous endpoint page' })).toBeTruthy();
  });

  it('does not let a slower older page overwrite a later filter reset', async () => {
    let resolveNext!: (page: ReturnType<typeof endpointPage>) => void;
    let resolveReset!: (page: ReturnType<typeof endpointPage>) => void;
    const next = new Promise<ReturnType<typeof endpointPage>>((resolve) => { resolveNext = resolve; });
    const reset = new Promise<ReturnType<typeof endpointPage>>((resolve) => { resolveReset = resolve; });
    mockGetClearPass.mockResolvedValue(liveData({ endpoints: [] }));
    mockGetEndpointPage
      .mockResolvedValueOnce(endpointPage({ dataSource: 'live', endpoints: [CLEARPASS_ENDPOINTS[0]], total: 101, nextOffset: 50, more: 'yes' }))
      .mockReturnValueOnce(next)
      .mockReturnValueOnce(reset);
    renderClearPass();

    await screen.findByText(CLEARPASS_ENDPOINTS[0].mac);
    fireEvent.click(screen.getByRole('button', { name: 'Next endpoint page' }));
    fireEvent.change(screen.getByLabelText('Filter endpoints'), { target: { value: CLEARPASS_ENDPOINTS[0].mac } });

    await act(async () => {
      resolveReset(endpointPage({ dataSource: 'live', endpoints: [CLEARPASS_ENDPOINTS[0]], total: 101, nextOffset: 50, more: 'yes' }));
      await reset;
    });
    expect(await screen.findByText(CLEARPASS_ENDPOINTS[0].mac)).toBeTruthy();

    await act(async () => {
      resolveNext(endpointPage({ dataSource: 'live', endpoints: [CLEARPASS_ENDPOINTS[1]], offset: 50, total: 101, nextOffset: 100, more: 'yes' }));
      await next;
    });
    expect(screen.getByText(CLEARPASS_ENDPOINTS[0].mac)).toBeTruthy();
    expect(screen.queryByText(CLEARPASS_ENDPOINTS[1].mac)).toBeNull();
  });

  it('keeps unavailable, failed, and empty endpoint pages distinct and never shows fixture rows for a failed live page', async () => {
    mockGetClearPass.mockResolvedValue(liveData({ endpoints: [] }));
    mockGetEndpointPage.mockResolvedValue({
      dataSource: 'live', state: 'failed', endpoints: [], offset: 0, limit: 50,
      total: null, nextOffset: null, more: 'unknown',
    });
    renderClearPass();
    expect(await screen.findByText('Endpoint page could not be loaded')).toBeTruthy();
    expect(screen.queryByText('Ward 3E rounds iPad — Dr. Okonjo')).toBeNull();
  });

  it('uses the proven repository total when the requested page is empty', async () => {
    mockGetClearPass.mockResolvedValue(liveData({ endpointTotal: 101 }));
    mockGetEndpointPage.mockResolvedValue({
      dataSource: 'live', state: 'empty', endpoints: [], offset: 100, limit: 50,
      total: 101, nextOffset: null, more: 'no',
    });
    renderClearPass();

    expect(await screen.findByText('ClearPass returned an empty endpoint page')).toBeTruthy();
    expect(screen.getByText('ClearPass reports 101 total endpoints; this requested page contains no rows.')).toBeTruthy();
    expect(screen.queryByText(/does not establish a repository-wide total/i)).toBeNull();
  });

  it('keeps a live read-only connector inventory-only', async () => {
    mockGetClearPass.mockResolvedValue(liveData({
      canWrite: false,
      localUsers: CLEARPASS_LOCAL_USERS,
    }));
    mockGetEndpointPage.mockResolvedValue(endpointPage({
      dataSource: 'live',
      endpoints: [CLEARPASS_ENDPOINTS[0]],
      total: 1,
    }));
    renderClearPass();

    expect(await screen.findByText(CLEARPASS_ENDPOINTS[0].mac)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Register endpoint' })).toBeNull();
    expect(screen.queryByRole('button', { name: `Edit endpoint ${CLEARPASS_ENDPOINTS[0].mac}` })).toBeNull();
    openTab('Local users');
    expect(screen.queryByRole('button', { name: 'Add local user' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Edit local user/ })).toBeNull();
    expect(screen.getByText(/read-only connector grant/i)).toBeTruthy();
  });

  it('(a) the endpoints tab renders descriptions and Device Insight tags on the rows that carry them', async () => {
    mockGetClearPass.mockResolvedValue(demoData());
    renderClearPass();

    // The operator's free-text note rides under the hostname…
    await waitFor(() => expect(screen.getByText('Ward 3E rounds iPad — Dr. Okonjo')).toBeTruthy());
    // …and the profiler's evidence badges under the category.
    expect(screen.getAllByText('Apple iOS').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Medical Device').length).toBeGreaterThan(0);
    // A row with neither stays plain — no placeholder tags, no empty note.
    expect(screen.getByText('6e:41:0d:99:2b:af')).toBeTruthy();
  });

  it('(b) the inventory tabs render the reported NADs, auth sources, roles and local users', async () => {
    mockGetClearPass.mockResolvedValue(demoData());
    renderClearPass();
    await waitFor(() => expect(screen.getByText('Endpoint repository')).toBeTruthy());

    openTab('Network devices');
    expect(screen.getByText('sw-core-a')).toBeTruthy();
    expect(screen.getByText('10.42.8.11')).toBeTruthy();
    expect(screen.getByText('Campus-02 core · EX4400 virtual chassis · RadSec to cppm-01')).toBeTruthy();

    openTab('Auth sources');
    expect(screen.getByText('AD meridian.health')).toBeTruthy();
    expect(screen.getByText('Active Directory')).toBeTruthy();

    openTab('Roles');
    expect(screen.getByText('vlan 820 · clinical apps + internet')).toBeTruthy();

    openTab('Local users');
    expect(screen.getByText('portal-collector')).toBeTruthy();
    expect(screen.getByText('Front Desk Sponsor')).toBeTruthy();
    expect(screen.getAllByText('Enabled').length).toBe(2);
  });

  it('(c) the enforcement tab resolves the policy→default-profile→profile chain', async () => {
    mockGetClearPass.mockResolvedValue(demoData());
    renderClearPass();
    await waitFor(() => expect(screen.getByText('Endpoint repository')).toBeTruthy());

    openTab('Enforcement');
    expect(screen.getByText('MRDN Wireless 802.1X Enforcement')).toBeTruthy();
    // 'Quarantine' resolves to the reported RADIUS profile — the chain shows
    // what the fallback actually returns.
    expect(
      screen.getByText((_, el) => el?.textContent === '→ RADIUS · remediation portal only'),
    ).toBeTruthy();
    expect(
      screen.getByText((_, el) => el?.textContent === '→ RADIUS · vlan 812 + internet-only ACL'),
    ).toBeTruthy();
  });

  it('(d) an inventory key the envelope does not carry reads "Not reported by this CPPM", demo and live', async () => {
    mockGetClearPass.mockResolvedValue(liveData()); // live pull reported no inventories
    renderClearPass();
    await waitFor(() => expect(screen.getByText('Endpoint repository')).toBeTruthy());

    openTab('Roles');
    expect(screen.getByText('Not reported by this CPPM')).toBeTruthy();
    expect(screen.queryByText('ClearPass reports no roles')).toBeNull(); // never the empty-answer wording
  });

  it('(e) the services tab renders the richer 6.11 rows from the demo fixtures', async () => {
    mockGetClearPass.mockResolvedValue(demoData()); // the demo CPPM is a 6.11 build
    renderClearPass();
    await waitFor(() => expect(screen.getByText('Endpoint repository')).toBeTruthy());

    openTab('Services');
    expect(screen.getByText('MRDN Guest 802.1X')).toBeTruthy();
    expect(screen.getByText('Device Admin (TACACS+)')).toBeTruthy();
    // the enabled/disabled state as a badge — the eduroam pilot is the demo's
    // one disabled service ('Disabled' also labels a stat card, so the badge
    // is asserted on its own row). Loop 95 services filter Select also exposes
    // an "Enabled" option, so count includes that control.
    expect(screen.getAllByText('Enabled').length).toBeGreaterThanOrEqual(3);
    // type + template, hit count and order
    expect(screen.getByText('TACACS')).toBeTruthy();
    expect(screen.getByText('TACACS+ Enforcement')).toBeTruthy();
    expect(screen.getByText('1,204')).toBeTruthy();
    const pilot = screen.getByText('eduroam 802.1X').closest('tr') as HTMLElement;
    expect(within(pilot).getByText('0')).toBeTruthy(); // 0 hits
    expect(within(pilot).getByText('11')).toBeTruthy(); // order_no 11
    expect(within(pilot).getByText('Disabled')).toBeTruthy();
    // auth sources — eduroam names none, so its cell is the honest dash
    expect(screen.getByText('AD meridian.health, Local User Repository')).toBeTruthy();
    expect(within(pilot).getByText('—')).toBeTruthy();
    // the one-line read of the match rules — never raw JSON
    expect(screen.getByText('Connection:NAD-IP-Address EQUALS 10.42.8.11')).toBeTruthy();
    expect(screen.getByText('Radius:Called-Station-Id EQUALS eduroam')).toBeTruthy();
    // …while device groups stay the absent collection, stated plainly
    expect(screen.getByText('Device groups are not available on this CPPM')).toBeTruthy();
    expect(screen.queryByText('Services are not available on this CPPM')).toBeNull();
  });

  it('(e2) an absent services key still reads "not available on this CPPM" (an older box, live mode)', async () => {
    mockGetClearPass.mockResolvedValue(liveData()); // a box that 404s both service paths
    renderClearPass();
    await waitFor(() => expect(screen.getByText('Endpoint repository')).toBeTruthy());

    openTab('Services');
    expect(screen.getByText('Services are not available on this CPPM')).toBeTruthy();
    expect(screen.getByText('Device groups are not available on this CPPM')).toBeTruthy();
    expect(screen.queryByText('ClearPass reports no services')).toBeNull(); // never the empty-answer wording
  });

  it('(e3) a present-but-empty services answer is stated as a fact, distinct from absent', async () => {
    mockGetClearPass.mockResolvedValue(liveData({ services: [], deviceGroups: [], roles: [] }));
    renderClearPass();
    await waitFor(() => expect(screen.getByText('Endpoint repository')).toBeTruthy());

    openTab('Services');
    expect(screen.getByText('ClearPass reports no services')).toBeTruthy();
    expect(screen.getByText('ClearPass reports no device groups')).toBeTruthy();
    expect(screen.queryByText(/not available on this CPPM/)).toBeNull();

    openTab('Roles');
    expect(screen.getByText('ClearPass reports no roles')).toBeTruthy();
    expect(screen.queryByText('Not reported by this CPPM')).toBeNull();
  });

  it('(f) the local-users tab carries no password material of any kind', async () => {
    mockGetClearPass.mockResolvedValue(demoData());
    const { container } = renderClearPass();
    await waitFor(() => expect(screen.getByText('Endpoint repository')).toBeTruthy());

    openTab('Local users');
    expect(screen.getByText('portal-collector')).toBeTruthy();
    expect(container.textContent?.toLowerCase()).not.toContain('password');
    expect(container.textContent?.toLowerCase()).not.toContain('secret');
    expect(container.textContent?.toLowerCase()).not.toContain('hash');
  });

  it('(g) the services tab carries no credential material of any kind', async () => {
    mockGetClearPass.mockResolvedValue(demoData());
    const { container } = renderClearPass();
    await waitFor(() => expect(screen.getByText('Endpoint repository')).toBeTruthy());

    openTab('Services');
    expect(screen.getByText('Device Admin (TACACS+)')).toBeTruthy();
    // a TACACS service sits next to shared secrets in CPPM — none may cross
    expect(container.textContent?.toLowerCase()).not.toContain('password');
    expect(container.textContent?.toLowerCase()).not.toContain('secret');
    expect(container.textContent?.toLowerCase()).not.toContain('hash');
  });

  it('(g2) static inventory primary rows open and close a local read-only detail drawer without credential-shaped fields', async () => {
    const networkDeviceWithUntrustedExtra = {
      ...CLEARPASS_NETWORK_DEVICES[0],
      secret: 'must-not-render',
      password: 'must-not-render',
    };
    mockGetClearPass.mockResolvedValue(
      demoData({ networkDevices: [networkDeviceWithUntrustedExtra] as typeof CLEARPASS_NETWORK_DEVICES }),
    );
    const { container } = renderClearPass();
    await waitFor(() => expect(screen.getByText('Endpoint repository')).toBeTruthy());

    openTab('Network devices');
    fireEvent.click(screen.getByRole('button', { name: 'View network device sw-core-a' }));

    const dialog = screen.getByRole('dialog', { name: 'sw-core-a' });
    expect(dialog).toBeTruthy();
    expect(within(dialog).getByText('Read-only inventory detail. No ClearPass changes can be made here.')).toBeTruthy();
    expect(within(dialog).getByText('10.42.8.11')).toBeTruthy();
    expect(container.textContent?.toLowerCase()).not.toContain('must-not-render');
    expect(container.textContent?.toLowerCase()).not.toContain('password');
    expect(container.textContent).not.toContain('{"');

    fireEvent.click(screen.getByRole('button', { name: 'Close dialog' }));
    expect(screen.queryByRole('dialog', { name: 'sw-core-a' })).toBeNull();
  });

  it('(g3) each reported static inventory uses an accessible primary-row detail action while absent collections keep InventoryGate wording', async () => {
    mockGetClearPass.mockResolvedValue(
      demoData({
        deviceGroups: [{ id: 'campus', name: 'Campus devices', description: 'Campus estate' }],
      }),
    );
    renderClearPass();
    await waitFor(() => expect(screen.getByText('Endpoint repository')).toBeTruthy());

    openTab('Auth sources');
    expect(screen.getByRole('button', { name: 'View authentication source AD meridian.health' })).toBeTruthy();
    openTab('Roles');
    expect(screen.getAllByRole('button', { name: /View role / }).length).toBeGreaterThan(0);
    openTab('Enforcement');
    expect(screen.getByRole('button', { name: 'View enforcement policy MRDN Wireless 802.1X Enforcement' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'View enforcement profile Quarantine' })).toBeTruthy();
    openTab('Services');
    expect(screen.getByRole('button', { name: 'View device group Campus devices' })).toBeTruthy();

    cleanup();
    mockGetClearPass.mockResolvedValue(liveData());
    renderClearPass();
    await waitFor(() => expect(screen.getByText('Endpoint repository')).toBeTruthy());
    openTab('Roles');
    expect(screen.getByText('Not reported by this CPPM')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /View role / })).toBeNull();
  });
});

describe('ClearPass service detail drawer', () => {
  /** A row of the drawer: the fact label's own row carries its value. Labels
   *  the conditions table reuses ('Type', 'Name') match the Summary fact
   *  first — Summary renders above Match rules. */
  function factRow(dialog: HTMLElement, label: string): string {
    const matches = within(dialog).getAllByText(label);
    return matches[0]?.parentElement?.textContent ?? '';
  }

  it('(m) the View action fetches the detail by id and renders every CPPM section', async () => {
    mockGetClearPass.mockResolvedValue(demoData());
    mockGetServiceDetail.mockResolvedValue({ kind: 'ok', detail: CLEARPASS_SERVICE_DETAILS['svc-001'] });
    renderClearPass();
    await waitFor(() => expect(screen.getByText('Endpoint repository')).toBeTruthy());

    openTab('Services');
    fireEvent.click(screen.getByRole('button', { name: 'View service MRDN Guest 802.1X' }));
    expect(mockGetServiceDetail).toHaveBeenCalledWith('svc-001');

    const dialog = await screen.findByRole('dialog');
    // SUMMARY — the row's identity plus the facts only the detail object carries
    await waitFor(() => expect(factRow(dialog, 'Type')).toContain('RADIUS'));
    expect(factRow(dialog, 'Name')).toContain('MRDN Guest 802.1X');
    expect(factRow(dialog, 'ID')).toContain('svc-001');
    expect(factRow(dialog, 'Template')).toContain('802.1X Wireless');
    expect(factRow(dialog, 'Order')).toContain('3');
    expect(factRow(dialog, 'Status')).toContain('Enabled');
    expect(factRow(dialog, 'Hit count')).toContain('412');
    expect(factRow(dialog, 'Description')).toContain('guest SSID · sponsor-approved accounts');
    expect(factRow(dialog, 'Monitor mode')).toContain('Disabled');
    // MATCH RULES — the match type as CPPM words it, then the rule editor's rows
    expect(factRow(dialog, 'Match type')).toContain('Matches ALL of the following conditions');
    expect(within(dialog).getByText('Radius')).toBeTruthy();
    expect(within(dialog).getByText('Called-Station-Id')).toBeTruthy();
    expect(within(dialog).getByText('CONTAINS')).toBeTruthy();
    expect(within(dialog).getByText('MRDN-Guest')).toBeTruthy();
    // AUTHENTICATION / AUTHORIZATION / ENFORCEMENT
    expect(factRow(dialog, 'Methods')).toContain('PEAP, MSCHAPv2');
    expect(factRow(dialog, 'Sources')).toContain('Local User Repository');
    expect(factRow(dialog, 'Strip username')).toContain('Disabled');
    expect(factRow(dialog, 'Role mapping')).toContain('MRDN Guest Role Mapping');
    expect(factRow(dialog, 'Policy')).toContain('MRDN Guest Portal Enforcement');
    // OPTIONS — the flags as enabled/disabled, never assumed
    expect(factRow(dialog, 'Posture')).toContain('Disabled');
    expect(factRow(dialog, 'Audit')).toContain('Disabled');
    expect(factRow(dialog, 'Profiler')).toContain('Enabled');
    expect(factRow(dialog, 'Accounting proxy')).toContain('Disabled');
    expect(factRow(dialog, 'Cached results')).toContain('Enabled');
    // provenance rides along
    expect(within(dialog).getByText(/CLEARPASS · READ/)).toBeTruthy();
  });

  it('(n) the service name itself activates the same drawer', async () => {
    mockGetClearPass.mockResolvedValue(demoData());
    mockGetServiceDetail.mockResolvedValue({ kind: 'ok', detail: CLEARPASS_SERVICE_DETAILS['svc-001'] });
    renderClearPass();
    await waitFor(() => expect(screen.getByText('Endpoint repository')).toBeTruthy());

    openTab('Services');
    fireEvent.click(screen.getByRole('button', { name: 'MRDN Guest 802.1X' }));
    expect(mockGetServiceDetail).toHaveBeenCalledWith('svc-001');
    expect(await screen.findByRole('dialog')).toBeTruthy();
  });

  it('(o) fields the box did not report render Not reported, and empty conditions say so', async () => {
    const sparse: ClearPassServiceDetailLive = {
      service: {
        id: 'svc-9',
        name: 'Sparse Service',
        type: null,
        template: null,
        enabled: null,
        hitCount: null,
        orderNo: null,
        description: null,
        monitorMode: null,
        rulesMatchType: null,
        rulesConditions: [],
        authMethods: [],
        authSources: [],
        stripUsername: null,
        roleMappingPolicy: null,
        enforcementPolicy: null,
        useCachedPolicyResults: null,
        postureEnabled: null,
        auditEnabled: null,
        profilerEnabled: null,
        acctProxyEnabled: null,
      },
      source: { plane: 'clearpass', at: '2026-07-26T11:59:00.000Z', sections: { service: 'ok' } },
    };
    mockGetClearPass.mockResolvedValue(demoData());
    mockGetServiceDetail.mockResolvedValue({ kind: 'ok', detail: sparse });
    renderClearPass();
    await waitFor(() => expect(screen.getByText('Endpoint repository')).toBeTruthy());

    openTab('Services');
    fireEvent.click(screen.getByRole('button', { name: 'View service eduroam 802.1X' }));
    const dialog = await screen.findByRole('dialog');
    await waitFor(() => expect(within(dialog).getByText('No match conditions were reported for this service.')).toBeTruthy());
    // every absent fact is 'Not reported' — the identity fields stay facts
    expect(factRow(dialog, 'Name')).toContain('Sparse Service');
    expect(factRow(dialog, 'Type')).toContain('Not reported');
    expect(factRow(dialog, 'Status')).toContain('Not reported');
    expect(factRow(dialog, 'Match type')).toContain('Not reported');
    expect(factRow(dialog, 'Methods')).toContain('Not reported');
    expect(factRow(dialog, 'Sources')).toContain('Not reported');
    expect(factRow(dialog, 'Role mapping')).toContain('Not reported');
    expect(factRow(dialog, 'Policy')).toContain('Not reported');
    expect(factRow(dialog, 'Posture')).toContain('Not reported');
    expect(factRow(dialog, 'Profiler')).toContain('Not reported');
    // …and null is never flattened into a confident-looking 'Disabled'
    expect(dialog.textContent).not.toContain('Disabled');
  });

  it('(p) 404, failed, not-reported and request-failed stay four distinct sentences', async () => {
    mockGetClearPass.mockResolvedValue(demoData());
    renderClearPass();
    await waitFor(() => expect(screen.getByText('Endpoint repository')).toBeTruthy());
    openTab('Services');
    const view = screen.getByRole('button', { name: 'View service MRDN Guest 802.1X' });

    // the box 404'd — 'empty' is no such service, not an error
    mockGetServiceDetail.mockResolvedValueOnce({
      kind: 'ok',
      detail: {
        service: null,
        source: {
          plane: 'clearpass',
          at: '2026-07-26T11:59:00.000Z',
          sections: { service: 'empty' },
          note: "this CPPM answered 404 for service 'svc-001' — no such service",
        },
      },
    });
    fireEvent.click(view);
    let dialog = await screen.findByRole('dialog');
    await waitFor(() => expect(within(dialog).getByText(/no such service/)).toBeTruthy());
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close dialog' }));

    // the read broke — the note travels, never rendered as an empty drawer
    mockGetServiceDetail.mockResolvedValueOnce({
      kind: 'ok',
      detail: {
        service: null,
        source: {
          plane: 'clearpass',
          at: '2026-07-26T11:59:00.000Z',
          sections: { service: 'failed' },
          note: 'HTTP 500',
        },
      },
    });
    fireEvent.click(screen.getByRole('button', { name: 'View service MRDN Guest 802.1X' }));
    dialog = await screen.findByRole('dialog');
    await waitFor(() => expect(within(dialog).getByText(/The service read failed — HTTP 500/)).toBeTruthy());
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close dialog' }));

    // the portal has no read for this id at all
    mockGetServiceDetail.mockResolvedValueOnce({ kind: 'not-reported' });
    fireEvent.click(screen.getByRole('button', { name: 'View service MRDN Guest 802.1X' }));
    dialog = await screen.findByRole('dialog');
    await waitFor(() => expect(within(dialog).getByText(/No detail was reported for this service/)).toBeTruthy());
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close dialog' }));

    // the request itself failed
    mockGetServiceDetail.mockResolvedValueOnce({ kind: 'failed', message: 'the backend dropped' });
    fireEvent.click(screen.getByRole('button', { name: 'View service MRDN Guest 802.1X' }));
    dialog = await screen.findByRole('dialog');
    await waitFor(() => expect(within(dialog).getByText(/The service detail read failed — the backend dropped/)).toBeTruthy());
  });

  it('(q) the drawer renders the whitelisted fields only — no credential material', async () => {
    mockGetClearPass.mockResolvedValue(demoData());
    mockGetServiceDetail.mockResolvedValue({
      kind: 'ok',
      detail: {
        ...CLEARPASS_SERVICE_DETAILS['svc-001'],
        service: {
          ...CLEARPASS_SERVICE_DETAILS['svc-001'].service!,
          // a payload that tries to smuggle TACACS/shared secrets past the
          // boundary — the drawer reads the whitelisted fields and nothing else
          shared_secret: 'hunter2',
          tacacs_secret: 's3cr3t',
          password: 'p@ssw0rd',
        } as ClearPassServiceDetailLive['service'],
      },
    });
    renderClearPass();
    await waitFor(() => expect(screen.getByText('Endpoint repository')).toBeTruthy());

    openTab('Services');
    fireEvent.click(screen.getByRole('button', { name: 'View service Device Admin (TACACS+)' }));
    const dialog = await screen.findByRole('dialog');
    await waitFor(() => expect(factRow(dialog, 'Type')).toContain('RADIUS'));
    expect(dialog.textContent).not.toContain('hunter2');
    expect(dialog.textContent).not.toContain('s3cr3t');
    expect(dialog.textContent).not.toContain('p@ssw0rd');
  });
});

describe('ClearPass reviewed writes', () => {
  /** The demo-mode canned outcome the service answers with. */
  const DEMO_OK = {
    ok: true,
    action: 'created' as const,
    verified: true,
    httpCode: 200,
    message: 'demo write applied — no live CPPM was written',
  };

  it('in lab mode submits a valid endpoint without a review confirmation', async () => {
    mockLabConfigMode.mockReturnValue({ lab: true });
    mockGetClearPass.mockResolvedValue(demoData());
    mockRegister.mockResolvedValue(DEMO_OK);
    renderClearPass();
    await screen.findByText('15 loaded endpoint rows');
    fireEvent.click(screen.getByRole('button', { name: 'Register endpoint' }));
    const dialog = screen.getByRole('dialog', { name: 'Register endpoint' });
    fireEvent.change(within(dialog).getByLabelText('MAC address'), { target: { value: 'AABBCCDDEEFF' } });
    expect(within(dialog).queryByLabelText(/I have reviewed this write/)).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Register endpoint' }));
    await waitFor(() => expect(mockRegister).toHaveBeenCalledWith(expect.objectContaining({ mac: 'AABBCCDDEEFF' }), undefined));
  });

  it('(h) register endpoint: the review gate, MAC validation, and the demo fixture-world merge', async () => {
    mockGetClearPass.mockResolvedValue(demoData());
    mockRegister.mockResolvedValue({ ...DEMO_OK, message: 'demo endpoint aa:bb:cc:dd:ee:ff registered — no live CPPM was written' });
    renderClearPass();
    await waitFor(() => expect(screen.getByText('15 loaded endpoint rows')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'Register endpoint' }));
    const dialog = screen.getByRole('dialog', { name: 'Register endpoint' });
    const apply = within(dialog).getByRole('button', { name: 'Register endpoint' });
    // An empty form is refused before the review even matters.
    expect(apply).toHaveProperty('disabled', true);
    fireEvent.change(within(dialog).getByLabelText('MAC address'), { target: { value: 'AABBCCDDEEFF' } });
    // A valid form is still gated on the explicit review.
    expect(apply).toHaveProperty('disabled', true);
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /I have reviewed this write/ }));
    expect(apply).toHaveProperty('disabled', false);
    // The review shows exactly what will be written — the normalised MAC.
    expect(within(dialog).getByText('aa:bb:cc:dd:ee:ff')).toBeTruthy();

    fireEvent.click(apply);
    await waitFor(() => expect(mockRegister).toHaveBeenCalledTimes(1));
    expect(mockRegister.mock.calls[0][0]).toMatchObject({ mac: 'AABBCCDDEEFF', status: 'Known' });
    expect(mockRegister.mock.calls[0][1]).toBe(true); // reviewConfirmed
    // The demo world gained the row, and the outcome is shown verbatim.
    await waitFor(() => expect(screen.getByText('16 loaded endpoint rows')).toBeTruthy());
    expect(within(dialog).getByText(/no live CPPM was written/)).toBeTruthy();
  });

  it('(h2) register endpoint: a refused write is reported, never merged', async () => {
    mockGetClearPass.mockResolvedValue(demoData());
    mockRegister.mockResolvedValue({
      ok: false,
      action: 'failed' as const,
      httpCode: 422,
      message: 'ClearPass refused the endpoint registration (HTTP 422)',
    });
    renderClearPass();
    await waitFor(() => expect(screen.getByText('15 loaded endpoint rows')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'Register endpoint' }));
    const dialog = screen.getByRole('dialog', { name: 'Register endpoint' });
    fireEvent.change(within(dialog).getByLabelText('MAC address'), { target: { value: 'AABBCCDDEEFF' } });
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /I have reviewed this write/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Register endpoint' }));

    await waitFor(() => expect(within(dialog).getByText(/refused the endpoint registration/)).toBeTruthy());
    expect(within(dialog).getByText('Not applied')).toBeTruthy();
    // The table did not gain a row for a write the plane refused.
    expect(screen.getByText('15 loaded endpoint rows')).toBeTruthy();
  });

  it('(i) edit endpoint: only real changes apply, and the demo row follows', async () => {
    mockGetClearPass.mockResolvedValue(demoData());
    mockUpdateEndpoint.mockResolvedValue({ ...DEMO_OK, action: 'updated' as const, message: 'demo endpoint updated — no live CPPM was written' });
    renderClearPass();
    await waitFor(() => expect(screen.getByText('Endpoint repository')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'Edit endpoint 00:1b:c5:09:7f:22' })); // ep-002, Known
    const dialog = screen.getByRole('dialog', { name: 'Edit endpoint 00:1b:c5:09:7f:22' });
    const apply = within(dialog).getByRole('button', { name: 'Apply update' });
    // Seeded from the row, so there is nothing to write yet — even reviewed.
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /I have reviewed this write/ }));
    expect(apply).toHaveProperty('disabled', true);
    expect(within(dialog).getByText(/there is nothing to write/)).toBeTruthy();

    fireEvent.change(within(dialog).getByLabelText('Endpoint status'), { target: { value: 'Disabled' } });
    expect(apply).toHaveProperty('disabled', false);
    fireEvent.click(apply);
    await waitFor(() => expect(mockUpdateEndpoint).toHaveBeenCalledTimes(1));
    expect(mockUpdateEndpoint.mock.calls[0][0]).toBe('ep-002');
    expect(mockUpdateEndpoint.mock.calls[0][1]).toEqual({ status: 'Disabled' }); // only what changed
    expect(mockUpdateEndpoint.mock.calls[0][2]).toBe(true);

    // The fixture world reflects it — the row's badge flips to Disabled.
    await waitFor(() => {
      const row = screen.getByText('infusion-4a-12').closest('tr') as HTMLElement;
      expect(within(row).getByText('Disabled')).toBeTruthy();
    });
  });

  it('(j) add local user: role from the roles dataset, password write-only, demo merge', async () => {
    mockGetClearPass.mockResolvedValue(demoData());
    mockCreateUser.mockResolvedValue({ ...DEMO_OK, message: "demo local user 'noc-op' created — no live CPPM was written" });
    renderClearPass();
    await waitFor(() => expect(screen.getByText('Endpoint repository')).toBeTruthy());

    openTab('Local users');
    fireEvent.click(screen.getByRole('button', { name: 'Add local user' }));
    const dialog = screen.getByRole('dialog', { name: 'Add local user' });
    const apply = within(dialog).getByRole('button', { name: 'Create local user' });
    expect(apply).toHaveProperty('disabled', true);

    fireEvent.change(within(dialog).getByLabelText('User ID'), { target: { value: 'noc-op' } });
    // The role picker is the reported roles dataset — not free text.
    const roleSelect = within(dialog).getByLabelText('Role');
    expect(within(roleSelect).getByText('Clinical staff')).toBeTruthy();
    fireEvent.change(roleSelect, { target: { value: 'Clinical staff' } });
    const pw = within(dialog).getByLabelText('Password') as HTMLInputElement;
    expect(pw.type).toBe('password');
    fireEvent.change(pw, { target: { value: 'hunter2-secret' } });

    fireEvent.click(within(dialog).getByRole('checkbox', { name: /I have reviewed this write/ }));
    // The review states the password is write-only — and never shows it.
    expect(within(dialog).getByText('set — write-only, never displayed')).toBeTruthy();
    expect(dialog.textContent).not.toContain('hunter2-secret');
    expect(apply).toHaveProperty('disabled', false);

    fireEvent.click(apply);
    await waitFor(() => expect(mockCreateUser).toHaveBeenCalledTimes(1));
    expect(mockCreateUser.mock.calls[0][0]).toEqual({
      userId: 'noc-op',
      roleName: 'Clinical staff',
      enabled: true,
      password: 'hunter2-secret', // sent to the server — where it belongs
    });
    // The demo world gained the row (the drawer stays open with its own
    // review copy, so the proof is a match inside a table row), and the whole
    // document carries no secret.
    await waitFor(() => {
      expect(screen.getAllByText('noc-op').some((el) => el.closest('tr') !== null)).toBe(true);
    });
    expect(document.body.textContent).not.toContain('hunter2-secret');
  });

  it('(k) edit local user: prefilled from the row, password optional, only changes cross', async () => {
    mockGetClearPass.mockResolvedValue(demoData());
    mockUpdateUser.mockResolvedValue({ ...DEMO_OK, action: 'updated' as const, message: 'demo local user updated — no live CPPM was written' });
    renderClearPass();
    await waitFor(() => expect(screen.getByText('Endpoint repository')).toBeTruthy());

    openTab('Local users');
    fireEvent.click(screen.getByRole('button', { name: 'Edit local user portal-collector' }));
    const dialog = screen.getByRole('dialog', { name: 'Edit local user portal-collector' });
    const apply = within(dialog).getByRole('button', { name: 'Apply update' });
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /I have reviewed this write/ }));
    expect(apply).toHaveProperty('disabled', true); // seeded from the row — nothing changed

    // The password stays optional on edit…
    expect((within(dialog).getByLabelText('New password') as HTMLInputElement).type).toBe('password');
    // …and an enabled toggle is a change on its own.
    fireEvent.click(within(dialog).getByRole('switch'));
    expect(apply).toHaveProperty('disabled', false);
    fireEvent.click(apply);
    await waitFor(() => expect(mockUpdateUser).toHaveBeenCalledTimes(1));
    expect(mockUpdateUser.mock.calls[0][0]).toBe('lu-001');
    expect(mockUpdateUser.mock.calls[0][1]).toEqual({ enabled: false }); // no password key at all

    // The fixture world reflects it — the row's badge flips to Disabled (the
    // drawer's review keeps its own copy of the user id, so the table row is
    // found by scoping to a <tr>).
    await waitFor(() => {
      const cell = screen.getAllByText('portal-collector').find((el) => el.closest('tr') !== null);
      expect(cell).toBeTruthy();
      const row = (cell as HTMLElement).closest('tr') as HTMLElement;
      expect(within(row).getByText('Disabled')).toBeTruthy();
    });
  });

  it('(l) live mode: a landed endpoint write refreshes both the overview and current endpoint page', async () => {
    mockGetClearPass.mockResolvedValue(liveData({ endpoints: [CLEARPASS_ENDPOINTS[0]], roles: CLEARPASS_ROLES }));
    mockGetEndpointPage.mockResolvedValue(
      endpointPage({ dataSource: 'live', endpoints: [CLEARPASS_ENDPOINTS[0]], total: 1, nextOffset: null, more: 'no' }),
    );
    mockRegister.mockResolvedValue({
      ...DEMO_OK,
      message: 'endpoint registered and confirmed in the repository read-back (HTTP 201)',
      cacheRefresh: { attempted: true, ok: true },
    });
    renderClearPass();
    await waitFor(() => expect(screen.getByText('Endpoint repository')).toBeTruthy());
    expect(mockGetClearPass).toHaveBeenCalledTimes(1);
    expect(mockGetEndpointPage).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Register endpoint' }));
    const dialog = screen.getByRole('dialog', { name: 'Register endpoint' });
    fireEvent.change(within(dialog).getByLabelText('MAC address'), { target: { value: 'AABBCCDDEEFF' } });
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /I have reviewed this write/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Register endpoint' }));

    await waitFor(() => expect(mockGetClearPass).toHaveBeenCalledTimes(2)); // the reload
    await waitFor(() => expect(mockGetEndpointPage).toHaveBeenCalledTimes(2)); // the refreshed endpoint page
    await waitFor(() => expect(within(dialog).getByText(/confirmed in the repository read-back/)).toBeTruthy());
  });

  it('keeps the newest full-envelope capability result and clears an open drawer when write access is revoked', async () => {
    let resolveStaleWritable!: (data: ClearPassData) => void;
    const staleWritable = new Promise<ClearPassData>((resolve) => {
      resolveStaleWritable = resolve;
    });
    mockGetClearPass
      .mockResolvedValueOnce(liveData({ roles: CLEARPASS_ROLES, canWrite: true }))
      .mockReturnValueOnce(staleWritable)
      .mockResolvedValueOnce(liveData({ roles: CLEARPASS_ROLES, canWrite: false }));
    mockRegister.mockResolvedValue({
      ...DEMO_OK,
      message: 'endpoint registered and confirmed in the repository read-back (HTTP 201)',
      cacheRefresh: { attempted: true, ok: true },
    });
    renderClearPass();
    await screen.findByRole('button', { name: 'Register endpoint' });

    fireEvent.click(screen.getByRole('button', { name: 'Register endpoint' }));
    let dialog = screen.getByRole('dialog', { name: 'Register endpoint' });
    fireEvent.change(within(dialog).getByLabelText('MAC address'), { target: { value: 'AABBCCDDEEFF' } });
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /I have reviewed this write/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Register endpoint' }));
    await waitFor(() => expect(mockGetClearPass).toHaveBeenCalledTimes(2));

    dialog = screen.getByRole('dialog', { name: 'Register endpoint' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Register endpoint' }));
    await waitFor(() => expect(mockGetClearPass).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Register endpoint' })).toBeNull());
    expect(screen.queryByRole('button', { name: 'Register endpoint' })).toBeNull();
    expect(screen.getByText(/read-only connector grant/i)).toBeTruthy();

    await act(async () => {
      resolveStaleWritable(liveData({ roles: CLEARPASS_ROLES, canWrite: true }));
      await staleWritable;
    });
    expect(screen.queryByRole('button', { name: 'Register endpoint' })).toBeNull();
    expect(screen.queryByRole('dialog', { name: 'Register endpoint' })).toBeNull();
  });
});

describe('ClearPass tab + filter deep links (Loop 64)', () => {
  it('opens the named tab from ?tab= and write-back keeps tab + endpoint filters shareable', async () => {
    mockGetClearPass.mockResolvedValue(
      demoData({
        networkDevices: CLEARPASS_NETWORK_DEVICES,
        roles: CLEARPASS_ROLES,
      }),
    );
    renderClearPass('/clearpass?tab=network');
    expect(await screen.findByRole('tab', { name: 'Network devices', selected: true })).toBeTruthy();
    expect(screen.getByTestId('loc').textContent).toContain('tab=network');

    openTab('Endpoints');
    await waitFor(() => expect(screen.getByTestId('loc').textContent).not.toContain('tab='));
    fireEvent.change(screen.getByLabelText('Filter endpoints'), {
      target: { value: 'aa:bb' },
    });
    await waitFor(() => expect(screen.getByTestId('loc').textContent).toContain('q=aa%3Abb'));
  });

  it('Copy filter link includes the written-back tab query', async () => {
    mockGetClearPass.mockResolvedValue(demoData({ roles: CLEARPASS_ROLES }));
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    renderClearPass('/clearpass?tab=roles');
    await screen.findByRole('tab', { name: 'Roles', selected: true });
    fireEvent.click(screen.getByRole('button', { name: 'Copy filter link' }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(String(writeText.mock.calls[0]![0])).toMatch(/tab=roles/);
  });
});

describe('ClearPass server CSV filters (Loop 80)', () => {
  it('Download server CSV passes status/category and part=endpoints on the endpoints tab', async () => {
    mockGetClearPass.mockResolvedValue(
      liveData({
        endpoints: CLEARPASS_ENDPOINTS,
        authEvents: AUTH_EVENTS,
      }),
    );
    mockGetEndpointPage.mockResolvedValue(endpointPage({ dataSource: 'live' }));
    mockDownloadApiCsv.mockResolvedValue({ ok: true });

    const known = CLEARPASS_ENDPOINTS.find((e) => e.status === 'Known');
    const status = known?.status ?? 'Known';
    const category = known?.category ?? 'Computer';

    renderClearPass(`/clearpass?status=${encodeURIComponent(status)}&category=${encodeURIComponent(category)}`);
    await screen.findByRole('button', { name: 'Download server CSV' });

    fireEvent.click(screen.getByRole('button', { name: 'Download server CSV' }));
    await waitFor(() => expect(mockDownloadApiCsv).toHaveBeenCalled());
    const path = String(mockDownloadApiCsv.mock.calls[0]![0]);
    expect(path.startsWith('/api/clearpass/export?')).toBe(true);
    const qs = new URLSearchParams(path.split('?')[1]);
    expect(qs.get('part')).toBe('endpoints');
    expect(qs.get('status')).toBe(status);
    expect(qs.get('category')).toBe(category);
  });

  it('Download server CSV uses part=sessions on the Auth events tab', async () => {
    mockGetClearPass.mockResolvedValue(liveData({ authEvents: AUTH_EVENTS }));
    mockDownloadApiCsv.mockResolvedValue({ ok: true });
    renderClearPass('/clearpass?tab=auth');
    await screen.findByRole('tab', { name: 'Auth events', selected: true });
    fireEvent.click(screen.getByRole('button', { name: 'Download server CSV' }));
    await waitFor(() => expect(mockDownloadApiCsv).toHaveBeenCalled());
    const path = String(mockDownloadApiCsv.mock.calls[0]![0]);
    const qs = new URLSearchParams(path.split('?')[1] ?? '');
    expect(qs.get('part')).toBe('sessions');
  });

  it('Download server CSV uses part=services + enabled/q on Services tab (Loop 95)', async () => {
    mockGetClearPass.mockResolvedValue(
      liveData({
        services: CLEARPASS_SERVICES,
      }),
    );
    mockDownloadApiCsv.mockResolvedValue({ ok: true });
    renderClearPass('/clearpass?tab=services&q=eduroam&enabled=0');
    await screen.findByRole('tab', { name: 'Services', selected: true });
    expect(await screen.findByDisplayValue('eduroam')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Download server CSV' }));
    await waitFor(() => expect(mockDownloadApiCsv).toHaveBeenCalled());
    const path = String(mockDownloadApiCsv.mock.calls[0]![0]);
    expect(path.startsWith('/api/clearpass/export?')).toBe(true);
    const qs = new URLSearchParams(path.split('?')[1]);
    expect(qs.get('part')).toBe('services');
    expect(qs.get('q')).toBe('eduroam');
    expect(qs.get('enabled')).toBe('0');
    expect(String(mockDownloadApiCsv.mock.calls[0]![1])).toBe('clearpass-services.csv');
  });
});

describe('ClearPass services filter helper (Loop 95)', () => {
  it('filterServicesForView honours q and enabled', async () => {
    const { filterServicesForView } = await import('./ClearPass');
    const all = filterServicesForView(CLEARPASS_SERVICES, '', 'all');
    expect(all?.length).toBe(CLEARPASS_SERVICES.length);
    const q = filterServicesForView(CLEARPASS_SERVICES, 'eduroam', 'all');
    expect(q?.every((s) => s.name.toLowerCase().includes('eduroam'))).toBe(true);
    const disabled = filterServicesForView(CLEARPASS_SERVICES, '', '0');
    expect(disabled?.length).toBeGreaterThan(0);
    expect(disabled?.every((s) => s.enabled === false)).toBe(true);
    const miss = filterServicesForView(CLEARPASS_SERVICES, '__nope__', 'all');
    expect(miss).toEqual([]);
  });
});

/* Loop 136 — Status chip row toggles the same status= filter as the Select. */
describe('ClearPass endpoint status chips (Loop 136)', () => {
  it('status chips filter the endpoint table and write status back to the URL', async () => {
    mockGetClearPass.mockResolvedValue(
      liveData({
        endpoints: CLEARPASS_ENDPOINTS,
        authEvents: AUTH_EVENTS,
      }),
    );
    /* Full repository page so chip counts stay visible while a status is active. */
    mockGetEndpointPage.mockResolvedValue(
      endpointPage({ dataSource: 'live', endpoints: CLEARPASS_ENDPOINTS }),
    );

    const known = CLEARPASS_ENDPOINTS.find((e) => e.status === 'Known');
    const unknown = CLEARPASS_ENDPOINTS.find((e) => e.status === 'Unknown');
    expect(known && unknown).toBeTruthy();

    renderClearPass('/clearpass');
    await screen.findByText(known!.mac);
    expect(screen.getByText(unknown!.mac)).toBeTruthy();

    const chips = screen.getByRole('group', { name: 'Endpoint status' });
    const unknownChip = within(chips).getByRole('button', { name: /Unknown/i });
    expect(unknownChip.getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(unknownChip);
    await waitFor(() => expect(screen.getByText(unknown!.mac)).toBeTruthy());
    expect(screen.queryByText(known!.mac)).toBeNull();
    expect(screen.getByTestId('loc').textContent).toContain('status=Unknown');
    expect(unknownChip.getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(unknownChip);
    await waitFor(() => expect(screen.getByText(known!.mac)).toBeTruthy());
    expect(screen.getByText(unknown!.mac)).toBeTruthy();
    expect(screen.getByTestId('loc').textContent).not.toContain('status=');
  });
});

/* Loop 142 — Category chip row toggles the same category= filter as the Select. */
describe('ClearPass endpoint category chips (Loop 142)', () => {
  it('category chips filter the endpoint table and write category back to the URL', async () => {
    mockGetClearPass.mockResolvedValue(
      liveData({
        endpoints: CLEARPASS_ENDPOINTS,
        authEvents: AUTH_EVENTS,
      }),
    );
    mockGetEndpointPage.mockResolvedValue(
      endpointPage({ dataSource: 'live', endpoints: CLEARPASS_ENDPOINTS }),
    );

    const printer = CLEARPASS_ENDPOINTS.find((e) => e.category === 'Printer');
    const phone = CLEARPASS_ENDPOINTS.find((e) => e.category === 'Phone');
    expect(printer && phone).toBeTruthy();

    renderClearPass('/clearpass');
    await screen.findByText(printer!.mac);
    expect(screen.getByText(phone!.mac)).toBeTruthy();

    const chips = screen.getByRole('group', { name: 'Endpoint category' });
    const printerChip = within(chips).getByRole('button', { name: /Printer/i });
    expect(printerChip.getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(printerChip);
    await waitFor(() => expect(screen.getByText(printer!.mac)).toBeTruthy());
    expect(screen.queryByText(phone!.mac)).toBeNull();
    expect(screen.getByTestId('loc').textContent).toContain('category=Printer');
    expect(printerChip.getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(printerChip);
    await waitFor(() => expect(screen.getByText(phone!.mac)).toBeTruthy());
    expect(screen.getByText(printer!.mac)).toBeTruthy();
    expect(screen.getByTestId('loc').textContent).not.toContain('category=');
  });
});

/* Loop 149 — Enabled chip row toggles the same enabled= filter as the Select. */
describe('ClearPass service enabled chips (Loop 149)', () => {
  it('enabled chips filter services and write enabled back to the URL', async () => {
    mockGetClearPass.mockResolvedValue(demoData({ services: CLEARPASS_SERVICES }));
    renderClearPass('/clearpass?tab=services');
    const chips = await screen.findByRole('group', { name: 'Service enabled state' });
    const buttons = within(chips).getAllByRole('button');
    expect(buttons.length).toBeGreaterThan(0);
    const enabledChip = within(chips).queryByRole('button', { name: /Enabled/i })
      ?? buttons[0]!;
    expect(enabledChip.getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(enabledChip);
    await waitFor(() => expect(screen.getByTestId('loc').textContent).toMatch(/enabled=1/));
    expect(enabledChip.getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(enabledChip);
    await waitFor(() => expect(screen.getByTestId('loc').textContent).not.toMatch(/[?&]enabled=/));
    expect(enabledChip.getAttribute('aria-pressed')).toBe('false');
  });

  it('disabled chip writes enabled=0', async () => {
    mockGetClearPass.mockResolvedValue(demoData({ services: CLEARPASS_SERVICES }));
    renderClearPass('/clearpass?tab=services');
    const chips = await screen.findByRole('group', { name: 'Service enabled state' });
    const disabled = within(chips).getByRole('button', { name: /Disabled/i });
    fireEvent.click(disabled);
    await waitFor(() => expect(screen.getByTestId('loc').textContent).toMatch(/enabled=0/));
    expect(disabled.getAttribute('aria-pressed')).toBe('true');
  });
});

/* Loop 162 — endpoint multi-select Export selected + Copy MACs bulk bar. */
describe('ClearPass endpoint bulk selection (Loop 162)', () => {
  it('shows bulk bar for selection: Export selected, Copy MACs, Clear', async () => {
    const createObjectURL = vi.fn(() => 'blob:clearpass-selected');
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    mockGetClearPass.mockResolvedValue(
      liveData({
        endpoints: CLEARPASS_ENDPOINTS,
        authEvents: AUTH_EVENTS,
      }),
    );
    mockGetEndpointPage.mockResolvedValue(
      endpointPage({ dataSource: 'live', endpoints: CLEARPASS_ENDPOINTS }),
    );

    const firstMac = CLEARPASS_ENDPOINTS[0]!.mac;
    const { container } = renderClearPass('/clearpass');
    expect(await screen.findByText(firstMac)).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Endpoint selection actions' })).toBeNull();

    const first = container.querySelector('tbody tr') as HTMLElement;
    expect(first).toBeTruthy();
    first.focus();
    fireEvent.keyDown(first, { key: 'x' });

    const bar = await screen.findByRole('region', { name: 'Endpoint selection actions' });
    expect(within(bar).getByText('1 SELECTED')).toBeTruthy();

    fireEvent.click(within(bar).getByRole('button', { name: 'Export selected' }));
    expect(await screen.findByText(/Exported 1 selected endpoint/)).toBeTruthy();
    expect(createObjectURL).toHaveBeenCalled();

    fireEvent.click(within(bar).getByRole('button', { name: 'Copy MACs' }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(String(writeText.mock.calls[0]![0])).toContain(firstMac);
    expect(await screen.findByText(/Copied 1 MAC/)).toBeTruthy();

    fireEvent.click(within(bar).getByRole('button', { name: 'Clear' }));
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: 'Endpoint selection actions' })).toBeNull(),
    );
  });
});

/* Loop 175 — endpoint bulk Copy selection link (?macs=) + clearable chip. */
describe('ClearPass Loop 175 residuals', () => {
  it('Copy selection link writes macs= and the deep link filters endpoints', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    mockGetClearPass.mockResolvedValue(
      liveData({
        endpoints: CLEARPASS_ENDPOINTS,
        authEvents: AUTH_EVENTS,
      }),
    );
    mockGetEndpointPage.mockResolvedValue(
      endpointPage({ dataSource: 'live', endpoints: CLEARPASS_ENDPOINTS }),
    );

    const firstMac = CLEARPASS_ENDPOINTS[0]!.mac;
    const secondMac = CLEARPASS_ENDPOINTS[1]!.mac;
    const { container } = renderClearPass('/clearpass');
    expect(await screen.findByText(firstMac)).toBeTruthy();
    expect(screen.getByText(secondMac)).toBeTruthy();

    const first = container.querySelector('tbody tr') as HTMLElement;
    expect(first).toBeTruthy();
    first.focus();
    fireEvent.keyDown(first, { key: 'x' });

    const bar = await screen.findByRole('region', { name: 'Endpoint selection actions' });
    fireEvent.click(within(bar).getByRole('button', { name: 'Copy selection link' }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    const copied = decodeURIComponent(String(writeText.mock.calls[0]![0]));
    expect(copied).toMatch(/macs=/);
    expect(copied).toContain(firstMac);
    expect(await screen.findByText(/Selection link copied/)).toBeTruthy();
  });

  it('deep-links ?macs= and shows a clearable selection chip', async () => {
    mockGetClearPass.mockResolvedValue(
      liveData({
        endpoints: CLEARPASS_ENDPOINTS,
        authEvents: AUTH_EVENTS,
      }),
    );
    mockGetEndpointPage.mockResolvedValue(
      endpointPage({ dataSource: 'live', endpoints: CLEARPASS_ENDPOINTS }),
    );

    const firstMac = CLEARPASS_ENDPOINTS[0]!.mac;
    const secondMac = CLEARPASS_ENDPOINTS[1]!.mac;
    renderClearPass(`/clearpass?macs=${encodeURIComponent(firstMac)}`);
    expect(await screen.findByText(firstMac)).toBeTruthy();
    expect(screen.queryByText(secondMac)).toBeNull();
    const chip = screen.getByRole('group', { name: 'Selection deep link' });
    expect(within(chip).getByText(/1 selected MAC/)).toBeTruthy();
    fireEvent.click(within(chip).getByRole('button'));
    await waitFor(() => expect(screen.getByTestId('loc').textContent).not.toMatch(/macs=/));
    expect(await screen.findByText(secondMac)).toBeTruthy();
  });
});

/* Loop 168 — LIVE badge honesty (pure live + clearpass blend). */
describe('ClearPass Loop 168 residuals', () => {
  it('stamps LIVE on pure live ClearPass', async () => {
    mockGetClearPass.mockResolvedValue(liveData({ authEvents: AUTH_EVENTS }));
    mockGetEndpointPage.mockResolvedValue(endpointPage({ dataSource: 'live' }));
    renderClearPass('/clearpass');
    expect(await screen.findByRole('heading', { name: 'ClearPass' })).toBeTruthy();
    expect(screen.getByText('LIVE')).toBeTruthy();
  });

  it('stamps LIVE when clearpass arrives via blend', async () => {
    mockGetClearPass.mockResolvedValue(
      demoData({ blended: ['clearpass'], syncedAt: '2026-07-26T11:59:00.000Z' }),
    );
    mockGetEndpointPage.mockResolvedValue(endpointPage());
    renderClearPass('/clearpass');
    expect(await screen.findByRole('heading', { name: 'ClearPass' })).toBeTruthy();
    expect(screen.getByText('LIVE')).toBeTruthy();
  });

  it('hides LIVE on demo fixtures without blend', async () => {
    mockGetClearPass.mockResolvedValue(demoData());
    mockGetEndpointPage.mockResolvedValue(endpointPage());
    renderClearPass('/clearpass');
    expect(await screen.findByRole('heading', { name: 'ClearPass' })).toBeTruthy();
    expect(screen.queryByText('LIVE')).toBeNull();
  });
});

/* Loop 174 — services multi-select Export selected + Copy names bulk bar. */
describe('ClearPass services bulk selection (Loop 174)', () => {
  it('shows bulk bar for selection: Export selected, Copy names, Clear', async () => {
    const createObjectURL = vi.fn(() => 'blob:clearpass-services-selected');
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    mockGetClearPass.mockResolvedValue(demoData());
    mockGetEndpointPage.mockResolvedValue(endpointPage());

    const firstName = CLEARPASS_SERVICES[0]!.name;
    const { container } = renderClearPass('/clearpass?tab=services');
    expect(await screen.findByText(firstName)).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Service selection actions' })).toBeNull();

    const table = container.querySelector('[aria-label="ClearPass services"]') as HTMLElement;
    expect(table).toBeTruthy();
    const first = table.querySelector('tbody tr') as HTMLElement;
    expect(first).toBeTruthy();
    first.focus();
    fireEvent.keyDown(first, { key: 'x' });

    const bar = await screen.findByRole('region', { name: 'Service selection actions' });
    expect(within(bar).getByText('1 SELECTED')).toBeTruthy();

    fireEvent.click(within(bar).getByRole('button', { name: 'Export selected' }));
    expect(await screen.findByText(/Exported 1 selected service/)).toBeTruthy();
    expect(createObjectURL).toHaveBeenCalled();

    fireEvent.click(within(bar).getByRole('button', { name: 'Copy names' }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(String(writeText.mock.calls[0]![0])).toContain(firstName);
    expect(await screen.findByText(/Copied 1 name/)).toBeTruthy();

    fireEvent.click(within(bar).getByRole('button', { name: 'Clear' }));
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: 'Service selection actions' })).toBeNull(),
    );
  });
});

/* Loop 181 — services bulk Copy selection link (?services=) + clearable chip. */
describe('ClearPass services selection link (Loop 181)', () => {
  it('Copy selection link writes services= and tab=services', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    mockGetClearPass.mockResolvedValue(demoData({ services: CLEARPASS_SERVICES }));
    mockGetEndpointPage.mockResolvedValue(endpointPage());

    const firstId = CLEARPASS_SERVICES[0]!.id;
    const firstName = CLEARPASS_SERVICES[0]!.name;
    const { container } = renderClearPass('/clearpass?tab=services');
    expect(await screen.findByText(firstName)).toBeTruthy();

    const table = container.querySelector('[aria-label="ClearPass services"]') as HTMLElement;
    const first = table.querySelector('tbody tr') as HTMLElement;
    first.focus();
    fireEvent.keyDown(first, { key: 'x' });

    const bar = await screen.findByRole('region', { name: 'Service selection actions' });
    fireEvent.click(within(bar).getByRole('button', { name: 'Copy selection link' }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    const url = decodeURIComponent(String(writeText.mock.calls[0]![0]));
    expect(url).toMatch(/services=/);
    expect(url).toContain(firstId);
    expect(url).toMatch(/tab=services/);
    expect(await screen.findByText(/Selection link copied/)).toBeTruthy();
  });

  it('deep-links ?services= and shows a clearable selection chip', async () => {
    mockGetClearPass.mockResolvedValue(demoData({ services: CLEARPASS_SERVICES }));
    mockGetEndpointPage.mockResolvedValue(endpointPage());

    const firstId = CLEARPASS_SERVICES[0]!.id;
    const firstName = CLEARPASS_SERVICES[0]!.name;
    const secondName = CLEARPASS_SERVICES[1]!.name;
    const { container } = renderClearPass(
      `/clearpass?tab=services&services=${encodeURIComponent(firstId)}`,
    );
    expect(await screen.findByText(firstName)).toBeTruthy();
    const table = container.querySelector('[aria-label="ClearPass services"]') as HTMLElement;
    expect(table).toBeTruthy();
    expect(within(table).queryByText(secondName)).toBeNull();
    const chip = screen.getByRole('group', { name: 'Selection deep link' });
    expect(within(chip).getByText(/1 selected service/)).toBeTruthy();
    fireEvent.click(within(chip).getByRole('button'));
    await waitFor(() => expect(screen.getByTestId('loc').textContent).not.toMatch(/services=/));
    expect(await within(table).findByText(secondName)).toBeTruthy();
  });
});

/* Loop 195 — keyboard shortcuts help on the endpoints table. */
describe('ClearPass Loop 195 residuals', () => {
  it('exposes keyboard shortcuts help beside the endpoints table', async () => {
    mockGetClearPass.mockResolvedValue(demoData({ endpoints: [] }));
    mockGetEndpointPage.mockResolvedValue(endpointPage());
    renderClearPass('/clearpass');
    // Selection-wired DataTable is an ARIA grid (j/k/x), not a plain table.
    expect(await screen.findByRole('grid', { name: 'ClearPass endpoints' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Keyboard shortcuts' })).toBeTruthy();
  });
});

/* Loop 213 — services selection-empty Clear selection filter CTA. */
describe('ClearPass Loop 213 residuals', () => {
  it('offers Clear selection filter when services deep link matches nothing', async () => {
    mockGetClearPass.mockResolvedValue(demoData({ services: CLEARPASS_SERVICES }));
    mockGetEndpointPage.mockResolvedValue(endpointPage());
    const firstName = CLEARPASS_SERVICES[0]!.name;
    renderClearPass(`/clearpass?tab=services&services=${encodeURIComponent('svc-missing-zzz')}`);
    expect(await screen.findByText('No services match this selection')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Clear selection filter' }));
    await waitFor(() => expect(screen.getByTestId('loc').textContent).not.toMatch(/services=/));
    expect(await screen.findByText(firstName)).toBeTruthy();
    expect(screen.queryByText('No services match this selection')).toBeNull();
  });
});

/* Loop 219 — endpoints selection-empty Clear selection filter CTA. */
describe('ClearPass Loop 219 residuals', () => {
  it('offers Clear selection filter when endpoints macs deep link matches nothing', async () => {
    mockGetClearPass.mockResolvedValue(demoData());
    mockGetEndpointPage.mockResolvedValue(
      endpointPage({ dataSource: 'live', endpoints: CLEARPASS_ENDPOINTS }),
    );
    const firstMac = CLEARPASS_ENDPOINTS[0]!.mac;
    renderClearPass(`/clearpass?macs=${encodeURIComponent('ff:ff:ff:ff:ff:ff')}`);
    expect(await screen.findByText('No endpoints match this selection')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Clear selection filter' }));
    await waitFor(() => expect(screen.getByTestId('loc').textContent).not.toMatch(/macs=/));
    expect(await screen.findByText(firstMac)).toBeTruthy();
    expect(screen.queryByText('No endpoints match this selection')).toBeNull();
  });
});

/* Loop 222 — services filtered-empty Clear filters + services keyboard help. */
describe('ClearPass Loop 222 residuals', () => {
  it('offers Clear filters when services q/enabled filters match nothing', async () => {
    mockGetClearPass.mockResolvedValue(demoData({ services: CLEARPASS_SERVICES }));
    mockGetEndpointPage.mockResolvedValue(endpointPage());
    const firstName = CLEARPASS_SERVICES[0]!.name;
    renderClearPass(`/clearpass?tab=services&q=${encodeURIComponent('__no_such_service_zzz__')}`);
    expect(await screen.findByText('Nothing matches that filter')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Clear selection filter' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    await waitFor(() => expect(screen.getByTestId('loc').textContent).not.toMatch(/[?&]q=/));
    expect(await screen.findByText(firstName)).toBeTruthy();
    expect(screen.queryByText('Nothing matches that filter')).toBeNull();
  });

  it('exposes keyboard shortcuts help beside the services table', async () => {
    mockGetClearPass.mockResolvedValue(demoData({ services: CLEARPASS_SERVICES }));
    mockGetEndpointPage.mockResolvedValue(endpointPage());
    renderClearPass('/clearpass?tab=services');
    expect(await screen.findByRole('grid', { name: 'ClearPass services' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Keyboard shortcuts' })).toBeTruthy();
  });
});

/* Loop 228 — endpoint bulk Copy names (hostnames) beside Copy MACs. */
describe('ClearPass Loop 228 residuals', () => {
  it('Copy names joins unique endpoint hostnames from the selection', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    mockGetClearPass.mockResolvedValue(
      liveData({
        endpoints: CLEARPASS_ENDPOINTS,
        authEvents: AUTH_EVENTS,
      }),
    );
    mockGetEndpointPage.mockResolvedValue(
      endpointPage({ dataSource: 'live', endpoints: CLEARPASS_ENDPOINTS }),
    );

    const firstHost = CLEARPASS_ENDPOINTS[0]!.hostname!;
    const secondHost = CLEARPASS_ENDPOINTS[1]!.hostname!;
    const { container } = renderClearPass('/clearpass');
    expect(await screen.findByText(CLEARPASS_ENDPOINTS[0]!.mac)).toBeTruthy();

    const rows = container.querySelectorAll('tbody tr');
    expect(rows.length).toBeGreaterThanOrEqual(2);
    for (let i = 0; i < 2; i++) {
      (rows[i] as HTMLElement).focus();
      fireEvent.keyDown(rows[i] as HTMLElement, { key: 'x' });
    }

    const bar = await screen.findByRole('region', { name: 'Endpoint selection actions' });
    expect(within(bar).getByRole('button', { name: 'Copy names' })).toBeTruthy();
    fireEvent.click(within(bar).getByRole('button', { name: 'Copy names' }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    const text = String(writeText.mock.calls[0]![0]);
    expect(text.split('\n').sort()).toEqual([firstHost, secondHost].sort());
    expect(await screen.findByText(/Copied 2 names/)).toBeTruthy();
  });
});
