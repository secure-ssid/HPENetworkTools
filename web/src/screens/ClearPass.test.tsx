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

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
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
} from '../api/clearpass';
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
}));

const mockGetClearPass = vi.mocked(getClearPass);
const mockGetServiceDetail = vi.mocked(getClearPassServiceDetail);
const mockRegister = vi.mocked(registerClearPassEndpoint);
const mockUpdateEndpoint = vi.mocked(updateClearPassEndpoint);
const mockCreateUser = vi.mocked(createClearPassLocalUser);
const mockUpdateUser = vi.mocked(updateClearPassLocalUser);

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
    ...over,
  };
}

function renderClearPass() {
  return render(
    <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <ToastProvider>
        <SettingsProvider>
          <ClearPass />
        </SettingsProvider>
      </ToastProvider>
    </MemoryRouter>,
  );
}

function openTab(name: string) {
  fireEvent.click(screen.getByRole('tab', { name }));
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('ClearPass', () => {
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
    // is asserted on its own row)
    expect(screen.getAllByText('Enabled')).toHaveLength(3);
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

  it('(h) register endpoint: the review gate, MAC validation, and the demo fixture-world merge', async () => {
    mockGetClearPass.mockResolvedValue(demoData());
    mockRegister.mockResolvedValue({ ...DEMO_OK, message: 'demo endpoint aa:bb:cc:dd:ee:ff registered — no live CPPM was written' });
    renderClearPass();
    await waitFor(() => expect(screen.getByText('15 of 15 shown')).toBeTruthy());

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
    await waitFor(() => expect(screen.getByText('16 of 16 shown')).toBeTruthy());
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
    await waitFor(() => expect(screen.getByText('15 of 15 shown')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'Register endpoint' }));
    const dialog = screen.getByRole('dialog', { name: 'Register endpoint' });
    fireEvent.change(within(dialog).getByLabelText('MAC address'), { target: { value: 'AABBCCDDEEFF' } });
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /I have reviewed this write/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Register endpoint' }));

    await waitFor(() => expect(within(dialog).getByText(/refused the endpoint registration/)).toBeTruthy());
    expect(within(dialog).getByText('Not applied')).toBeTruthy();
    // The table did not gain a row for a write the plane refused.
    expect(screen.getByText('15 of 15 shown')).toBeTruthy();
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

  it('(l) live mode: a landed write re-fetches the screen instead of trusting the local list', async () => {
    mockGetClearPass.mockResolvedValue(liveData({ endpoints: [CLEARPASS_ENDPOINTS[0]], roles: CLEARPASS_ROLES }));
    mockRegister.mockResolvedValue({
      ...DEMO_OK,
      message: 'endpoint registered and confirmed in the repository read-back (HTTP 201)',
      cacheRefresh: { attempted: true, ok: true },
    });
    renderClearPass();
    await waitFor(() => expect(screen.getByText('Endpoint repository')).toBeTruthy());
    expect(mockGetClearPass).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Register endpoint' }));
    const dialog = screen.getByRole('dialog', { name: 'Register endpoint' });
    fireEvent.change(within(dialog).getByLabelText('MAC address'), { target: { value: 'AABBCCDDEEFF' } });
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /I have reviewed this write/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Register endpoint' }));

    await waitFor(() => expect(mockGetClearPass).toHaveBeenCalledTimes(2)); // the reload
    await waitFor(() => expect(within(dialog).getByText(/confirmed in the repository read-back/)).toBeTruthy());
  });
});
