/**
 * web/src/screens/Configure.test.tsx — per-entry-source queue semantics.
 *
 * The write broker's queue is authoritative whenever the backend answers
 * (getChangeQueue() non-null); entries queued while the broker is unreachable
 * are kept locally with `id: null`. Discard drops only them; Push leaves them
 * visible and reports that no broker acknowledgement occurred.
 *
 * The api client is mocked at the module boundary — no real fetch. All waits
 * are promise-based (waitFor/findBy); no timers are involved.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import Configure from './Configure';
import { SettingsProvider } from '../app/SettingsContext';
import { ToastProvider } from '../nightdesk';
import {
  applyConfigDirect,
  applySsidDirect,
  discardChange,
  dryRunConfig,
  getChangeHistory,
  getChangeQueue,
  getConfigure,
  getPortalSettings,
  getSsidCatalog,
  pushChange,
  queueChange,
} from '../api/client';
import type { BrokeredChange, ConfigureData } from '../api/client';
import { SSIDS } from '@hpe/shared';
import type { SsidApplyResult, SsidCatalog, SsidObject } from '@hpe/shared';

vi.mock('../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/client')>();
  return {
    ...actual,
    getConfigure: vi.fn(),
    getChangeQueue: vi.fn(),
    getChangeHistory: vi.fn(),
    queueChange: vi.fn(),
    pushChange: vi.fn(),
    discardChange: vi.fn(),
    dryRunConfig: vi.fn(),
    getSsidCatalog: vi.fn(),
    applySsidDirect: vi.fn(),
    getPortalSettings: vi.fn(),
    applyConfigDirect: vi.fn(),
  };
});

const mockGetConfigure = vi.mocked(getConfigure);
const mockGetChangeQueue = vi.mocked(getChangeQueue);
const mockGetChangeHistory = vi.mocked(getChangeHistory);
const mockQueueChange = vi.mocked(queueChange);
const mockPushChange = vi.mocked(pushChange);
const mockDiscardChange = vi.mocked(discardChange);
const mockDryRunConfig = vi.mocked(dryRunConfig);
const mockGetSsidCatalog = vi.mocked(getSsidCatalog);
const mockApplySsidDirect = vi.mocked(applySsidDirect);
const mockGetPortalSettings = vi.mocked(getPortalSettings);
const mockApplyConfigDirect = vi.mocked(applyConfigDirect);

// -- fixtures ---------------------------------------------------------------

const CENTRAL_ADMITTED_CAPABILITY = {
  plane: 'HPE Aruba Central',
  planeId: 'central',
  mode: 'brokered' as const,
  note: 'Central writes admitted',
  tone: 'accent' as const,
  linked: true,
  canBrokerWrite: true,
  canDirectWrite: true,
};

/** Minimal screen payload — the queue tests only need the sections to exist. */
const CONFIGURE_DATA: ConfigureData = {
  stats: [],
  ssids: [],
  ports: [],
  vlans: [],
  inventoryMode: 'unavailable',
  queued: [],
  capabilities: [CENTRAL_ADMITTED_CAPABILITY],
  dataSource: 'live',
};

const CENTRAL_VLAN_ROW = {
  kind: 'vlan' as const,
  origin: 'configured' as const,
  plane: 'CENTRAL' as const,
  scope: 'cx-campus-01' as const,
  id: '812',
  name: 'guest-wifi',
  detail: 'configured',
  role: 'Guest',
};

const CENTRAL_PORT_ROW = {
  kind: 'port' as const,
  origin: 'configured' as const,
  plane: 'CENTRAL' as const,
  serial: 'CN-CX-001',
  device: 'cx-core-1',
  port: '1/1/1',
  desc: 'uplink',
  summary: 'access · poe',
  state: 'up',
  tone: 'success' as const,
};

const OFFLINE_ERROR = 'cannot reach the portal backend: network down';

function serverChange(over: Partial<BrokeredChange> = {}): BrokeredChange {
  return {
    id: 'chg-server-1',
    object: {
      kind: 'vlan',
      form: { id: '812', name: 'guest-wifi', helpers: '10.42.0.20, 10.44.0.20', scope: 'cx-campus-01' },
    },
    what: 'Add DHCP helper 10.44.0.20 to vlan 812',
    ticket: 'NET-4100',
    state: 'ready',
    where: '2 core switches · local collector',
    rendered: 'vlan 812\n  name guest-wifi\n  ip helper-address 10.44.0.20',
    createdAt: '2026-07-26T09:00:00.000Z',
    expiresAt: '2026-07-26T09:15:00.000Z',
    ...over,
  };
}

const LOCAL_VLAN_WHAT = 'VLAN 999 live-test-vlan';
const LOCAL_VLAN_TICKET = 'NET-5001';
const QUEUED_NOTE =
  'Change queued against NET-5001. The write lease opens for fifteen minutes when you push the queue; a rollback snapshot is kept for 24 hours.';
const LOCAL_NOT_PUSHED_TOAST = '1 local change not pushed';

// -- helpers ----------------------------------------------------------------

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location-probe">{`${location.pathname}${location.search}`}</div>;
}

function renderConfigure(initialEntry = '/configure') {
  return render(
    <MemoryRouter initialEntries={[initialEntry]} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <SettingsProvider>
        <ToastProvider>
          <Configure />
          <LocationProbe />
        </ToastProvider>
      </SettingsProvider>
    </MemoryRouter>,
  );
}

/** The right-hand "Queued changes" column: header + rows + Push/Discard. */
function queueSection() {
  const label = screen.getByText('Queued changes');
  const header = label.closest('.nd-section-header');
  if (!header || !header.parentElement) throw new Error('queue section not found');
  return within(header.parentElement);
}

/**
 * Drive the drawer: New VLAN → ticket → Queue the change, with queueChange
 * rejecting as offline. Ends with the local entry rendered in the list.
 *
 * VLAN (not SSID) drives every generic queue-semantics test in this file:
 * SSID no longer goes through the ticketed queue/push broker at all — see
 * the "Configure — SSID direct apply" describe block below for its own
 * (ticket-free, review-confirmed) flow. Port/VLAN queue behaviour is
 * unchanged, so VLAN is exactly as good a stand-in for these broker-generic
 * assertions as SSID used to be.
 */
async function queueLocalVlanWhileOffline() {
  fireEvent.click(screen.getByRole('button', { name: 'New VLAN' }));
  fireEvent.change(screen.getByLabelText('ID'), { target: { value: '999' } });
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'live-test-vlan' } });
  fireEvent.change(screen.getByLabelText('DHCP helpers'), { target: { value: '10.44.0.20' } });
  fireEvent.change(screen.getByPlaceholderText('NET-4166'), {
    target: { value: LOCAL_VLAN_TICKET },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Queue the change' }));
  await waitFor(() => expect(queueSection().getByText(LOCAL_VLAN_WHAT)).toBeTruthy());
}

/** A complete, fully-available SSID catalog — the default in beforeEach so
 *  any test that opens the SSID drawer gets a populated, non-error state. */
const SSID_CATALOG: SsidCatalog = {
  scopes: [
    { id: 'site-1', label: 'Campus-01', category: 'site' },
    { id: 'coll-1', label: 'All clinics', category: 'site-collection' },
    { id: 'grp-1', label: 'lakeshore-medical', category: 'ap-group' },
    { id: 'ap-1', label: 'ap-3f-12 (AP-635)', category: 'ap' },
  ],
  roles: [{ id: 'guest', label: 'guest' }, { id: 'authenticated', label: 'authenticated' }],
  authServerGroups: [{ id: 'clearpass', label: 'clearpass' }],
  captivePortalProfiles: [{ id: 'guest-portal', label: 'guest-portal' }],
  unavailable: [],
  source: 'Central /network-config/v1alpha1 · 7/7 sections',
};

const SSID_APPLIED: SsidApplyResult = {
  ok: true,
  partial: false,
  profile: { ok: true, action: 'created', verified: true, httpCode: 201, message: 'profile created — HTTP 201' },
  assignments: [
    {
      scopeId: 'site-1',
      label: 'Campus-01',
      ok: true,
      verified: true,
      httpCode: 200,
      message: 'assignment accepted — HTTP 200 — confirmed present on re-read',
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  mockGetConfigure.mockResolvedValue(CONFIGURE_DATA);
  // Backend reachable on load: the broker's queue is authoritative.
  mockGetChangeQueue.mockResolvedValue([serverChange()]);
  mockQueueChange.mockResolvedValue({ error: OFFLINE_ERROR, offline: true });
  mockPushChange.mockResolvedValue({
    ok: true,
    applied: true,
    changeId: 'chg-server-1',
    ticket: 'NET-4100',
    kind: 'vlan',
    snapshot: true,
    message: 'pushed',
  });
  mockDiscardChange.mockResolvedValue({ ok: true, changeId: 'chg-server-1' });
  mockDryRunConfig.mockResolvedValue({ error: 'dry run not exercised here' });
  mockGetChangeHistory.mockResolvedValue({ events: [], unreadable: [] });
  mockGetSsidCatalog.mockResolvedValue(SSID_CATALOG);
  mockApplySsidDirect.mockResolvedValue(SSID_APPLIED);
  // Existing broker tests exercise the explicit hardened fallback. A missing
  // server setting is intentionally lab-direct and is covered separately.
  mockGetPortalSettings.mockResolvedValue({ demoMode: false, pollIntervalSec: 60, configMode: false });
  mockApplyConfigDirect.mockResolvedValue({
    ok: true,
    applied: true,
    changeId: 'direct-vlan-1',
    kind: 'vlan',
    message: 'VLAN applied and confirmed',
  });
});

afterEach(cleanup);

describe('Configure — per-entry-source queue semantics', () => {
  it('confirmed lab mode does not let an unavailable broker prevent direct configuration', async () => {
    mockGetPortalSettings.mockResolvedValue({ demoMode: false, pollIntervalSec: 60, configMode: true });
    mockGetChangeQueue.mockResolvedValue({ error: 'broker queue unavailable' });
    renderConfigure();

    await screen.findByRole('button', { name: 'New SSID' });
    expect(mockGetChangeQueue).not.toHaveBeenCalled();
    expect(screen.queryByText('broker queue unavailable')).toBeNull();
    expect(screen.queryByText('Queued changes')).toBeNull();
    expect(screen.getByText(/No exact configured Central port row is available to apply/i)).toBeTruthy();
    expect(screen.getByText(/No exact configured Central VLAN row is available to apply/i)).toBeTruthy();
  });

  it('keeps default demo VLANs preview-only when no Central connector admits the vendor write', async () => {
    mockGetPortalSettings.mockResolvedValue({ demoMode: true, pollIntervalSec: 60, configMode: true });
    mockGetConfigure.mockResolvedValue({ ...CONFIGURE_DATA, dataSource: 'demo', capabilities: [] });
    renderConfigure();

    await screen.findByRole('button', { name: 'New VLAN' });
    expect(screen.getByText(/forms remain preview-only/i)).toBeTruthy();
    expect(screen.queryByText('Lab writes apply immediately')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'New VLAN' }));
    fireEvent.change(screen.getByLabelText('ID'), { target: { value: '999' } });
    expect(screen.getByRole('button', { name: 'Apply' })).toHaveProperty('disabled', true);
    expect(screen.getByText(/no linked Central connector currently admits/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(mockApplyConfigDirect).not.toHaveBeenCalled();
  });

  it('only offers configured live rows and never seeds unknown port/VLAN fields from demo fixtures', async () => {
    mockGetPortalSettings.mockResolvedValue({ demoMode: false, pollIntervalSec: 60, configMode: true });
    mockGetConfigure.mockResolvedValue({
      ...CONFIGURE_DATA,
      inventoryMode: 'configured',
      ports: [CENTRAL_PORT_ROW],
      vlans: [CENTRAL_VLAN_ROW],
    });
    renderConfigure();
    await screen.findByText('guest-wifi');

    expect(screen.queryByRole('button', { name: 'New VLAN' })).toBeNull();
    expect(screen.queryByRole('button', { name: '+ Configure a port' })).toBeNull();
    expect(screen.queryByRole('button', { name: '+ Add VLAN' })).toBeNull();

    fireEvent.click(screen.getByText('guest-wifi').closest('button') as HTMLButtonElement);
    expect(screen.getByLabelText('DHCP helpers')).toHaveProperty('value', '');
    expect(screen.getByRole('button', { name: 'Apply' })).toHaveProperty('disabled', true);
    expect(document.body.textContent).not.toContain('10.42.0.20');
    fireEvent.change(screen.getByLabelText('DHCP helpers'), { target: { value: '10.44.0.20' } });
    expect(screen.getByRole('button', { name: 'Apply' })).toHaveProperty('disabled', false);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    fireEvent.click(screen.getByRole('button', { name: /cx-core-1/i }));
    fireEvent.click(screen.getByRole('button', { name: /1\/1\/1.*cx-core-1/i }));
    expect(screen.getByLabelText('VLAN')).toHaveProperty('value', '');
    expect(screen.getByRole('button', { name: 'Apply' })).toHaveProperty('disabled', true);
    expect(mockApplyConfigDirect).not.toHaveBeenCalled();
  });

  it('requires exact configured provenance, Central serial identity, and server write admission', async () => {
    mockGetPortalSettings.mockResolvedValue({ demoMode: false, pollIntervalSec: 60, configMode: true });
    mockGetConfigure.mockResolvedValue({
      ...CONFIGURE_DATA,
      inventoryMode: 'observed',
      capabilities: [{ ...CENTRAL_ADMITTED_CAPABILITY, canBrokerWrite: false }],
      ports: [{ ...CENTRAL_PORT_ROW, serial: undefined, summary: 'access · vlan 812' }],
      vlans: [
        { ...CENTRAL_VLAN_ROW, origin: 'observed' },
        { ...CENTRAL_VLAN_ROW, id: '813', name: 'clinical', origin: 'configured' },
      ],
    });
    renderConfigure();

    fireEvent.click((await screen.findByText('guest-wifi')).closest('button') as HTMLButtonElement);
    fireEvent.change(screen.getByLabelText('DHCP helpers'), { target: { value: '10.44.0.20' } });
    expect(screen.getByRole('button', { name: 'Apply' })).toHaveProperty('disabled', true);
    expect(screen.getByText(/configured Central inventory row/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    fireEvent.click(screen.getByText('clinical').closest('button') as HTMLButtonElement);
    fireEvent.change(screen.getByLabelText('DHCP helpers'), { target: { value: '10.44.0.20' } });
    expect(screen.getByRole('button', { name: 'Apply' })).toHaveProperty('disabled', true);
    expect(screen.getByText(/does not currently admit this configuration write/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    fireEvent.click(screen.getByRole('button', { name: /cx-core-1/i }));
    fireEvent.click(screen.getByRole('button', { name: /1\/1\/1.*cx-core-1/i }));
    expect(screen.getByLabelText('VLAN')).toHaveProperty('value', '812');
    expect(screen.getByRole('button', { name: 'Apply' })).toHaveProperty('disabled', true);
    expect(screen.getByText(/exact Central identity/i)).toBeTruthy();
    expect(mockApplyConfigDirect).not.toHaveBeenCalled();
  });

  it('disables a complete Central SSID when the served target admission is read-only', async () => {
    mockGetPortalSettings.mockResolvedValue({ demoMode: false, pollIntervalSec: 60, configMode: true });
    mockGetConfigure.mockResolvedValue({
      ...CONFIGURE_DATA,
      capabilities: [{ ...CENTRAL_ADMITTED_CAPABILITY, canDirectWrite: false }],
    });
    renderConfigure();
    await screen.findByRole('button', { name: 'New SSID' });
    fireEvent.click(screen.getByRole('button', { name: 'New SSID' }));
    await fillReadySsidForm();

    expect(screen.getByText(/Central SSID writes are unavailable/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Apply' })).toHaveProperty('disabled', true);
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(mockApplySsidDirect).not.toHaveBeenCalled();
  });

  it('keeps queue and dry run disabled until the hardened generic form is complete', async () => {
    renderConfigure();
    await waitFor(() => expect(queueSection().getByText('NET-4100')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'New VLAN' }));
    fireEvent.change(screen.getByPlaceholderText('NET-4166'), { target: { value: 'NET-9000' } });

    expect(screen.getByRole('button', { name: 'Queue the change' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'Dry run' })).toHaveProperty('disabled', true);
  });

  it('removes queue and dry-run wording from the complete lab drawer while hardened mode retains it', async () => {
    mockGetPortalSettings.mockResolvedValue({ demoMode: false, pollIntervalSec: 60, configMode: true });
    mockGetConfigure.mockResolvedValue({
      ...CONFIGURE_DATA,
      inventoryMode: 'configured',
      vlans: [CENTRAL_VLAN_ROW],
    });
    renderConfigure();
    fireEvent.click((await screen.findByText('guest-wifi')).closest('button') as HTMLButtonElement);
    const labDialog = screen.getByRole('dialog', { name: 'VLAN' });
    expect(within(labDialog).getByText('What will be applied')).toBeTruthy();
    expect(labDialog.textContent).toContain('# exact write plane → Central');
    expect(labDialog.textContent).toContain('when confirmation succeeds');
    expect(labDialog.textContent).not.toContain('planes that can accept it');
    expect(labDialog.textContent?.toLowerCase()).not.toContain('queue');
    expect(labDialog.textContent?.toLowerCase()).not.toContain('dry run');

    cleanup();
    mockGetPortalSettings.mockResolvedValue({ demoMode: false, pollIntervalSec: 60, configMode: false });
    renderConfigure();
    await waitFor(() => expect(queueSection().getByText('NET-4100')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'New VLAN' }));
    const hardenedDialog = screen.getByRole('dialog', { name: 'VLAN' });
    expect(within(hardenedDialog).getByText('What gets pushed')).toBeTruthy();
    expect(within(hardenedDialog).getByRole('button', { name: 'Dry run' })).toBeTruthy();
    expect(hardenedDialog.textContent?.toLowerCase()).toContain('queue');
  });

  it('renders a thrown direct transport outcome as unknown and never as not applied', async () => {
    mockGetPortalSettings.mockResolvedValue({ demoMode: false, pollIntervalSec: 60, configMode: true });
    mockGetConfigure.mockResolvedValue({
      ...CONFIGURE_DATA,
      inventoryMode: 'configured',
      vlans: [CENTRAL_VLAN_ROW],
    });
    mockApplyConfigDirect.mockResolvedValue({
      ok: false,
      outcomeUnknown: true,
      changeId: 'direct-vlan-unknown',
      kind: 'vlan',
      message: 'outcome unknown — reconcile Central before another attempt',
    });
    renderConfigure();
    const vlanRow = await screen.findByText('guest-wifi');
    fireEvent.click(vlanRow.closest('button') as HTMLButtonElement);
    fireEvent.change(screen.getByLabelText('DHCP helpers'), { target: { value: '10.44.0.20' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));

    expect(await screen.findByText('Outcome unknown')).toBeTruthy();
    expect(screen.getAllByText(/reconcile Central before another attempt/).length).toBeGreaterThan(0);
    expect(screen.queryByText('Not applied')).toBeNull();
    expect(screen.getByRole('button', { name: 'Apply' })).toHaveProperty('disabled', true);
  });

  it('blocks replay after Central accepted a generic write without confirming it', async () => {
    mockGetPortalSettings.mockResolvedValue({ demoMode: false, pollIntervalSec: 60, configMode: true });
    mockGetConfigure.mockResolvedValue({
      ...CONFIGURE_DATA,
      inventoryMode: 'configured',
      vlans: [CENTRAL_VLAN_ROW],
    });
    mockApplyConfigDirect.mockResolvedValue({
      ok: true,
      applied: false,
      accepted: true,
      changeId: 'direct-vlan-accepted',
      kind: 'vlan',
      message: 'accepted by Central, not yet confirmed',
    });
    renderConfigure();
    fireEvent.click((await screen.findByText('guest-wifi')).closest('button') as HTMLButtonElement);
    fireEvent.change(screen.getByLabelText('DHCP helpers'), { target: { value: '10.44.0.20' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));

    expect(await screen.findByText('Accepted — not yet confirmed')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Apply' })).toHaveProperty('disabled', true);
  });

  it('unavailable settings preserve hardened queue, ticket, dry-run, and SSID review controls', async () => {
    mockGetPortalSettings.mockResolvedValue(null);
    renderConfigure();

    await waitFor(() => expect(queueSection().getByText('NET-4100')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'New VLAN' }));
    expect(screen.getByPlaceholderText('NET-4166')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Queue the change' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Dry run' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Apply' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    fireEvent.click(screen.getByRole('button', { name: 'New SSID' }));
    await screen.findByText('Campus-01');
    expect(
      screen.getByRole('checkbox', {
        name: 'I have reviewed this profile and these scope assignments — apply directly, no ticket.',
      }),
    ).toBeTruthy();
    expect(mockApplyConfigDirect).not.toHaveBeenCalled();
  });

  it('a legacy settings response applies only the configured VLAN id and scope with result evidence', async () => {
    // A returned, pre-configMode settings payload means the server will use
    // its lab-direct default. `null` still means unreachable and stays hard.
    mockGetPortalSettings.mockResolvedValue({ demoMode: false, pollIntervalSec: 60 });
    mockGetConfigure.mockResolvedValue({
      ...CONFIGURE_DATA,
      inventoryMode: 'configured',
      vlans: [CENTRAL_VLAN_ROW],
    });
    renderConfigure();

    const vlanRow = await screen.findByText('guest-wifi');
    expect(screen.queryByText('Queued changes')).toBeNull();
    expect(screen.queryByText('Push queue')).toBeNull();
    expect(screen.queryByPlaceholderText('NET-4166')).toBeNull();

    fireEvent.click(vlanRow.closest('button') as HTMLButtonElement);
    fireEvent.change(screen.getByLabelText('Apply to'), { target: { value: 'cx-all' } });
    expect(screen.getByRole('button', { name: 'Apply' })).toHaveProperty('disabled', true);
    fireEvent.change(screen.getByLabelText('Apply to'), { target: { value: 'cx-campus-01' } });
    fireEvent.change(screen.getByLabelText('ID'), { target: { value: '999' } });
    expect(screen.getByRole('button', { name: 'Apply' })).toHaveProperty('disabled', true);
    expect(screen.getByText(/immutable VLAN id and scope/i)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('ID'), { target: { value: '812' } });
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'lab-vlan' } });
    fireEvent.change(screen.getByLabelText('DHCP helpers'), { target: { value: '10.44.0.20' } });
    expect(screen.queryByRole('button', { name: 'Dry run' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Apply' })).toHaveProperty('disabled', false);
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));

    await waitFor(() =>
      expect(mockApplyConfigDirect).toHaveBeenCalledWith(
        'vlan',
        expect.objectContaining({ plane: 'CENTRAL', id: '812', scope: 'cx-campus-01', name: 'lab-vlan' }),
      ),
    );
    expect(screen.getByText('Applied')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Apply' })).toHaveProperty('disabled', true);
  });

  it('lab SSIDs skip the review checkbox but retain their dedicated apply path', async () => {
    mockGetPortalSettings.mockResolvedValue({ demoMode: false, pollIntervalSec: 60, configMode: true });
    renderConfigure();
    await screen.findByRole('button', { name: 'New SSID' });
    fireEvent.click(screen.getByRole('button', { name: 'New SSID' }));
    await screen.findByText('Campus-01');
    await fillReadySsidForm();

    expect(
      screen.queryByRole('checkbox', {
        name: 'I have reviewed this profile and these scope assignments — apply directly, no ticket.',
      }),
    ).toBeNull();
    expect(screen.getByRole('button', { name: 'Apply' })).toHaveProperty('disabled', false);
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));

    await waitFor(() => expect(mockApplySsidDirect).toHaveBeenCalledTimes(1));
    expect(mockApplySsidDirect.mock.calls[0][1]).toBeUndefined();
    expect(mockApplyConfigDirect).not.toHaveBeenCalled();
  });

  it('opens a blank live SSID form, loads the live scope catalog, and starts with Apply disabled', async () => {
    renderConfigure();
    await waitFor(() => expect(queueSection().getByText('NET-4100')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'New SSID' }));

    expect(screen.getByPlaceholderText('Enter SSID name')).toHaveProperty('value', '');
    expect(screen.queryByDisplayValue('MRDN-New')).toBeNull();
    expect(screen.queryByText(/268/)).toBeNull();
    expect(screen.queryByText(/2,472/)).toBeNull();
    expect(screen.getByText('Configuration assignments requested')).toBeTruthy();

    // The live scope catalog loads on open — no free-text/fabricated group,
    // and immutable plane-native scope options render grouped by category.
    await waitFor(() => expect(screen.getByText('Campus-01')).toBeTruthy());
    expect(screen.queryByPlaceholderText('Enter Central group')).toBeNull();
    expect(mockGetSsidCatalog).toHaveBeenCalledTimes(1);
    // Nothing pre-selected and not yet reviewed — Apply starts disabled.
    expect(screen.getByRole('button', { name: 'Apply directly' })).toHaveProperty('disabled', true);
  });

  it('appends the change locally (id null) when queueChange rejects offline, alongside the authoritative server queue', async () => {
    renderConfigure();
    // Server queue rendered first — the broker is authoritative.
    await waitFor(() => expect(queueSection().getByText('NET-4100')).toBeTruthy());

    await queueLocalVlanWhileOffline();

    expect(mockQueueChange).toHaveBeenCalledWith(
      'vlan',
      expect.objectContaining({ id: '999', name: 'live-test-vlan' }),
      LOCAL_VLAN_TICKET,
    );
    // The local entry renders with its what / where / ticket summary.
    expect(queueSection().getByText(LOCAL_VLAN_WHAT)).toBeTruthy();
    expect(queueSection().getByText('Core switches only (2) · local collector')).toBeTruthy();
    expect(queueSection().getByText(LOCAL_VLAN_TICKET)).toBeTruthy();
    // The server entry is still listed; the header counts both.
    expect(queueSection().getByText('Add DHCP helper 10.44.0.20 to vlan 812')).toBeTruthy();
    expect(queueSection().getByText('2')).toBeTruthy();
    // The offline path still confirms with the "Queued for push" alert.
    expect(screen.getByText('Queued for push')).toBeTruthy();
    expect(screen.getByText(QUEUED_NOTE)).toBeTruthy();
  });

  /* The offline fallback in queueIt() is the sharp edge. With the broker
   * unreachable nothing validates the form at all, so a VLAN the broker was
   * written to refuse was parked in the local queue and listed there as a
   * change waiting to be pushed, alongside changes that could be. */
  it('will not queue a VLAN the broker would refuse, offline or not', async () => {
    renderConfigure();
    await waitFor(() => expect(queueSection().getByText('NET-4100')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'New VLAN' }));
    fireEvent.change(screen.getByLabelText('ID'), { target: { value: '4095' } });
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'live-test-vlan' } });
    fireEvent.change(screen.getByPlaceholderText('NET-4166'), { target: { value: 'NET-9001' } });

    await waitFor(() =>
      expect(screen.getByText('Queueing is disabled — the broker would refuse this form')).toBeTruthy(),
    );
    expect(screen.getByText('VLAN id must be a number between 1 and 4094')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Queue the change' }) as HTMLButtonElement).disabled).toBe(true);
    // Nor a dry run, which the broker validates through the same path.
    expect((screen.getByRole('button', { name: 'Dry run' }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(screen.getByLabelText('ID'), { target: { value: '4094' } });
    fireEvent.change(screen.getByLabelText('DHCP helpers'), { target: { value: '10.44.0.20' } });
    await waitFor(() =>
      expect((screen.getByRole('button', { name: 'Queue the change' }) as HTMLButtonElement).disabled).toBe(false),
    );
  });

  it('Discard with the broker down drops only the local (id null) entries and keeps the server entries listed', async () => {
    renderConfigure();
    await waitFor(() => expect(queueSection().getByText('NET-4100')).toBeTruthy());
    await queueLocalVlanWhileOffline();

    // The broker drops out from under us: discard and re-read both fail.
    mockDiscardChange.mockResolvedValue({ error: OFFLINE_ERROR, offline: true });
    mockGetChangeQueue.mockResolvedValue(null);

    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));

    // The server-side discard was attempted for the brokered entry…
    await waitFor(() => expect(mockDiscardChange).toHaveBeenCalledWith('chg-server-1'));
    // …its failure is surfaced verbatim as a danger toast…
    await waitFor(() => expect(screen.getByText(OFFLINE_ERROR)).toBeTruthy());
    // …the local entry is gone…
    await waitFor(() =>
      expect(queueSection().queryByText(LOCAL_VLAN_WHAT)).toBeNull(),
    );
    // …but the server entry stays listed — it is still on the broker.
    expect(queueSection().getByText('NET-4100')).toBeTruthy();
    expect(queueSection().getByText('1')).toBeTruthy();
  });

  it('Push keeps local entries visible when no server acknowledgement is possible', async () => {
    // A server entry that is NOT ready — only the local entry is pushable.
    mockGetChangeQueue.mockResolvedValue([
      serverChange({
        id: 'chg-server-2',
        what: 'Tunnel MTU 1400 on mc-lake-3',
        ticket: 'NET-4149',
        state: 'needs window',
        where: 'AOS-8 · window 01:00–04:00',
      }),
    ]);
    renderConfigure();
    await waitFor(() => expect(queueSection().getByText('NET-4149')).toBeTruthy());
    await queueLocalVlanWhileOffline();

    mockGetChangeQueue.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Push queue' }));

    // The honest offline outcome: warning toast and entry remains pending.
    await waitFor(() => expect(screen.getByText(LOCAL_NOT_PUSHED_TOAST)).toBeTruthy());
    expect(queueSection().getByText(LOCAL_VLAN_WHAT)).toBeTruthy();
    // No server push happened for the id-less local entry.
    expect(mockPushChange).not.toHaveBeenCalled();
    // The not-ready server entry is untouched and still listed.
    expect(queueSection().getByText('NET-4149')).toBeTruthy();
    expect(queueSection().getByText('needs window')).toBeTruthy();
  });
});

// -- the section-payload queue path ------------------------------------------
//
// When GET /api/configure/queue itself never answers (getChangeQueue() → null)
// the ConfigureData payload's own `queued` rows are all there is. Those rows
// now carry the broker's `id` and `expiresAt`, so the screen must honour them
// instead of flattening every row to a local, id-less, lease-less one.

/** A queued row as the section payload serves it: brokered, with a live lease. */
function payloadRow(over: Partial<ConfigureData['queued'][number]> = {}) {
  return {
    id: 'chg-broker-7',
    state: 'ready' as const,
    tone: 'success' as const,
    what: 'Add DHCP helper 10.44.0.20 to vlan 812',
    where: '2 core switches · local collector',
    ticket: 'NET-7007',
    expiresAt: new Date(Date.now() + 11 * 60_000).toISOString(),
    ...over,
  };
}

describe('Configure — section-payload queue rows', () => {
  it('keeps the broker id and lease from the section payload when the queue endpoint is unreachable', async () => {
    mockGetChangeQueue.mockResolvedValue(null);
    mockGetConfigure.mockResolvedValue({
      ...CONFIGURE_DATA,
      // Two rows the OLD `${ticket}-${what}` fallback key could not tell
      // apart: only keying by the broker's own id renders both.
      queued: [payloadRow(), payloadRow({ id: 'chg-broker-8' })],
    });

    renderConfigure();

    await waitFor(() => expect(queueSection().getAllByText('NET-7007')).toHaveLength(2));
    expect(queueSection().getAllByText('Add DHCP helper 10.44.0.20 to vlan 812')).toHaveLength(2);
    expect(queueSection().getByText('2')).toBeTruthy();
    // The rows ARE on the broker, so the id-less disclaimer must not appear…
    expect(queueSection().queryByText('not on the broker — no lease')).toBeNull();
    // …and the lease they carry is counted down instead.
    expect(queueSection().getAllByText(/^lease \d+m left$/)).toHaveLength(2);
  });

  it('says an elapsed lease must be re-queued rather than offering a push the broker would reject', async () => {
    mockGetChangeQueue.mockResolvedValue(null);
    mockGetConfigure.mockResolvedValue({
      ...CONFIGURE_DATA,
      queued: [payloadRow({ expiresAt: new Date(Date.now() - 60_000).toISOString() })],
    });

    renderConfigure();

    await waitFor(() => expect(queueSection().getByText('NET-7007')).toBeTruthy());
    expect(queueSection().getByText('lease expired — re-queue before pushing')).toBeTruthy();
    expect(queueSection().queryByText('not on the broker — no lease')).toBeNull();
  });

  it('reports an id-bearing section row as unpushed too when the broker queue never answered', async () => {
    mockGetChangeQueue.mockResolvedValue(null);
    mockGetConfigure.mockResolvedValue({ ...CONFIGURE_DATA, queued: [payloadRow()] });

    renderConfigure();
    await waitFor(() => expect(queueSection().getByText('NET-7007')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'Push queue' }));

    // The broker's own queue never answered, so nothing was pushed — the row
    // must not fall silently between the server and local branches.
    await waitFor(() => expect(screen.getByText(LOCAL_NOT_PUSHED_TOAST)).toBeTruthy());
    expect(mockPushChange).not.toHaveBeenCalled();
    expect(queueSection().getByText('NET-7007')).toBeTruthy();
  });
});

// -- what the screen claims about this deployment's write surface -------------

const LEASE_SENTENCE = 'Every push needs a ticket reference and holds a fifteen-minute lease.';

describe('Configure — derived claims and empty states', () => {
  it('derives the brokered-write sentence from the served capability matrix', async () => {
    mockGetConfigure.mockResolvedValue({
      ...CONFIGURE_DATA,
      capabilities: [
        { plane: 'Central', mode: 'brokered', note: 'ticketed write', tone: 'success', linked: true },
        { plane: 'Local collector', mode: 'ssh', note: 'recorded session', tone: 'accent', linked: true },
        { plane: 'Mist', mode: 'read only', note: 'no write path', tone: 'neutral', linked: true },
      ],
    });

    renderConfigure();

    await waitFor(() => expect(screen.getByText('Writes are brokered, never standing')).toBeTruthy());
    // Only the planes this deployment actually reported — the authored
    // "Central, the local collector and AOS-8" claim would name a plane that
    // was never linked here.
    expect(
      screen.getByText(
        `${LEASE_SENTENCE} Central and Local collector accept pushes from here; Mist is read-only, so those changes open in their own console with the payload pre-filled.`,
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/AOS-8/)).toBeNull();
  });

  it('says nothing can be pushed at all when no plane reported a write capability', async () => {
    mockGetConfigure.mockResolvedValue({ ...CONFIGURE_DATA, capabilities: [] });

    renderConfigure();

    await waitFor(() => expect(screen.getByText('Writes are brokered, never standing')).toBeTruthy());
    expect(
      screen.getByText(
        `${LEASE_SENTENCE} No plane has reported a write capability, so nothing here can be pushed until one is linked on Connected systems.`,
      ),
    ).toBeTruthy();
  });

  it('names each empty section rather than heading an empty list', async () => {
    mockGetChangeQueue.mockResolvedValue([]);
    mockGetConfigure.mockResolvedValue(CONFIGURE_DATA);

    renderConfigure();

    await waitFor(() => expect(screen.getByText('No SSIDs reported')).toBeTruthy());
    expect(screen.getByText('No switch ports reported')).toBeTruthy();
    expect(screen.getByText('No VLANs reported')).toBeTruthy();
    expect(queueSection().getByText('No changes queued')).toBeTruthy();
    // On a live section the empty state says the add path still works.
    expect(
      screen.getByText(
        'No linked plane reported wireless configuration. "+ Add SSID" still renders and queues a new one.',
      ),
    ).toBeTruthy();
    // Push is inert with nothing ready — never a control that cannot act.
    expect(screen.getByRole('button', { name: 'Push queue' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'Discard' })).toHaveProperty('disabled', true);
  });

  it('follows the blended section, not the envelope, when configure is swapped live', async () => {
    // README §blendLive: the envelope still reads 'demo' while THIS section is
    // real, so every live-flavoured affordance must follow `blended`.
    mockGetConfigure.mockResolvedValue({
      ...CONFIGURE_DATA,
      dataSource: 'demo',
      blended: ['configure'],
    });

    renderConfigure();

    await waitFor(() => expect(screen.getByText('Queued changes')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'New SSID' }));

    // The live form: blank, no fabricated blast-radius counts, and the live
    // scope catalog still loads under a blended envelope.
    expect(screen.getByPlaceholderText('Enter SSID name')).toHaveProperty('value', '');
    expect(screen.queryByDisplayValue('MRDN-New')).toBeNull();
    await waitFor(() => expect(screen.getByText('Campus-01')).toBeTruthy());
    expect(screen.getByText('Impact evidence')).toBeTruthy();
    expect(screen.queryByText('Blast radius')).toBeNull();
    expect(screen.getByText('Configuration assignments requested')).toBeTruthy();
  });
});

// -- the Change history drawer (GET /api/configure/history) --------------------
//
// The header button used to be an honest toast ("not in this build"); the route
// exists now, so the button opens the broker's real audit log. The row is
// {ts,event,changeId,ticket,kind,result} and NOTHING else — shared/types.ts
// pins that rendered configuration bodies are never part of it.

const AUDIT_ROW = {
  ts: '2026-07-26T09:41:00.000Z',
  event: 'push',
  changeId: 'chg-7f21',
  ticket: 'NET-4166',
  kind: 'vlan',
  result: 'applied',
};

async function openHistoryDrawer() {
  renderConfigure();
  await waitFor(() => expect(screen.getByText('Queued changes')).toBeTruthy());
  fireEvent.click(screen.getByRole('button', { name: 'Change history' }));
}

describe('Configure — change history drawer', () => {
  it('renders the broker audit rows and never the rendered payload body', async () => {
    mockGetChangeHistory.mockResolvedValue({ events: [
      AUDIT_ROW,
      {
        ts: '2026-07-26T08:12:00.000Z',
        event: 'dry-run',
        changeId: 'chg-4a09',
        ticket: 'NET-4149',
        kind: 'ssid',
        result: 'render-only (read-only plane)',
      },
    ], unreadable: [] });

    await openHistoryDrawer();

    const dialog = await screen.findByRole('dialog');
    const drawer = within(dialog);
    // Wall-clock of the stamp in whatever zone the run is in — the drawer must
    // show the operator's clock, not the raw ISO string.
    await waitFor(() => expect(drawer.getByText('chg-7f21')).toBeTruthy());
    expect(drawer.getByText(new Date(AUDIT_ROW.ts).toTimeString().slice(0, 5))).toBeTruthy();
    expect(drawer.queryByText(AUDIT_ROW.ts)).toBeNull();
    expect(drawer.getByText('push vlan')).toBeTruthy();
    expect(drawer.getByText('NET-4166')).toBeTruthy();
    expect(drawer.getByText('applied')).toBeTruthy();
    expect(drawer.getByText('dry-run ssid')).toBeTruthy();
    expect(drawer.getByText('render-only (read-only plane)')).toBeTruthy();
    // The old honest-toast claim is gone — the route exists.
    expect(screen.queryByText(/not in this build/)).toBeNull();
    // SECURITY: the audit row carries no config body, and the drawer adds none.
    expect(drawer.queryByText(/ip helper-address/)).toBeNull();
    expect(dialog.querySelector('.nd-code-block')).toBeNull();
  });

  it('names the empty audit log rather than opening a blank panel', async () => {
    mockGetChangeHistory.mockResolvedValue({ events: [], unreadable: [] });

    await openHistoryDrawer();

    const drawer = within(await screen.findByRole('dialog'));
    await waitFor(() => expect(drawer.getByText('No brokered changes recorded yet')).toBeTruthy());
  });

  it('uses direct-apply audit copy in lab mode without broker, ticket, queue, or dry-run claims', async () => {
    mockGetPortalSettings.mockResolvedValue({ demoMode: false, pollIntervalSec: 60, configMode: true });
    mockGetChangeHistory.mockResolvedValue({ events: [], unreadable: [] });

    renderConfigure();
    await screen.findByRole('button', { name: 'Change history' });
    fireEvent.click(screen.getByRole('button', { name: 'Change history' }));

    const drawer = within(await screen.findByRole('dialog'));
    await waitFor(() => expect(drawer.getByText('No direct applies recorded yet')).toBeTruthy());
    expect(drawer.getByText(/configuration audit log/i)).toBeTruthy();
    expect(drawer.queryByText(/broker|ticket|queue|dry run/i)).toBeNull();
  });

  it('says the audit log could not be read instead of showing an empty history', async () => {
    mockGetChangeHistory.mockResolvedValue({ error: 'audit log unreadable' });

    await openHistoryDrawer();

    const drawer = within(await screen.findByRole('dialog'));
    await waitFor(() => expect(drawer.getByText('The audit log could not be read')).toBeTruthy());
    expect(drawer.getByText('audit log unreadable')).toBeTruthy();
    // An error is not an empty log.
    expect(drawer.queryByText('No brokered changes recorded yet')).toBeNull();
  });

  it('says the backend never answered rather than implying nothing was ever brokered', async () => {
    mockGetChangeHistory.mockResolvedValue(null);

    await openHistoryDrawer();

    const drawer = within(await screen.findByRole('dialog'));
    await waitFor(() => expect(drawer.getByText('The portal backend did not answer')).toBeTruthy());
    expect(drawer.queryByText('No brokered changes recorded yet')).toBeNull();
  });

  it('re-reads the log on every open so a second visit is not a stale claim', async () => {
    mockGetChangeHistory.mockResolvedValue({ events: [AUDIT_ROW], unreadable: [] });

    await openHistoryDrawer();
    const first = within(await screen.findByRole('dialog'));
    await waitFor(() => expect(first.getByText('chg-7f21')).toBeTruthy());
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    mockGetChangeHistory.mockResolvedValue({ events: [
      AUDIT_ROW,
      { ...AUDIT_ROW, ts: '2026-07-26T10:05:00.000Z', changeId: 'chg-9b02', result: 'rejected' },
    ], unreadable: [] });
    fireEvent.click(screen.getByRole('button', { name: 'Change history' }));

    const second = within(await screen.findByRole('dialog'));
    await waitFor(() => expect(second.getByText('chg-9b02')).toBeTruthy());
    expect(mockGetChangeHistory).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// SSID direct apply — no ticket, no queue. The drawer loads a live catalog
// on open, renders conditional security-dependency fields, and applies
// through POST /api/configure/ssids/apply behind an explicit review
// checkbox. See server/src/services/ssidDirectWrite.ts for the server half.
// ---------------------------------------------------------------------------

const EXISTING_SSID = {
  kind: 'ssid' as const,
  origin: 'configured' as const,
  name: 'MRDN-Prod',
  vlan: 'vlan 820',
  security: 'WPA3-Enterprise',
  targets: 'Enabled profile · scope assignment not read',
  plane: 'CENTRAL',
  tone: 'accent' as const,
};

/** Fill in everything a wpa2-psk SSID needs so Apply is enabled, without
 *  checking the review box (tests that need it call this then tick it). */
async function fillReadySsidForm() {
  fireEvent.change(screen.getByPlaceholderText('Enter SSID name'), { target: { value: 'MRDN-Guest' } });
  fireEvent.change(screen.getByPlaceholderText('1-4094'), { target: { value: '830' } });
  await waitFor(() => expect(screen.getByText('Campus-01')).toBeTruthy());
  fireEvent.click(screen.getByRole('checkbox', { name: 'Campus-01' }));
  fireEvent.change(screen.getByPlaceholderText('Enter the PSK passphrase'), { target: { value: 'sup3r-secret' } });
  fireEvent.change(screen.getByRole('combobox', { name: 'Default role' }), { target: { value: 'guest' } });
}

describe('Configure — SSID direct apply', () => {
  it('renders scope choices grouped by category and the wpa2-psk dependency fields', async () => {
    renderConfigure();
    await waitFor(() => expect(queueSection().getByText('NET-4100')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'New SSID' }));

    await waitFor(() => expect(screen.getByText('Campus-01')).toBeTruthy());
    expect(screen.getByText('Sites')).toBeTruthy();
    expect(screen.getByText('Site collections')).toBeTruthy();
    expect(screen.getByText('AP device groups')).toBeTruthy();
    expect(screen.getByText('Individual APs')).toBeTruthy();
    expect(screen.getByText('All clinics')).toBeTruthy();
    expect(screen.getByText('lakeshore-medical')).toBeTruthy();
    expect(screen.getByText('ap-3f-12 (AP-635)')).toBeTruthy();

    // wpa2-psk (the live default): role + passphrase, no server group/captive portal.
    expect(screen.getByPlaceholderText('Enter the PSK passphrase')).toBeTruthy();
    expect(screen.queryByText('Authentication server group')).toBeNull();
    expect(screen.queryByText('Captive-portal profile')).toBeNull();
  });

  it('swaps the conditional dependency fields when the security mode changes', async () => {
    renderConfigure();
    await waitFor(() => expect(queueSection().getByText('NET-4100')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'New SSID' }));
    await waitFor(() => expect(screen.getByText('Campus-01')).toBeTruthy());

    fireEvent.change(screen.getByRole('combobox', { name: 'Security' }), { target: { value: 'wpa3-enterprise' } });
    expect(screen.getByText('Authentication server group')).toBeTruthy();
    expect(screen.queryByPlaceholderText('Enter the PSK passphrase')).toBeNull();
    expect(screen.queryByText('Captive-portal profile')).toBeNull();

    fireEvent.change(screen.getByRole('combobox', { name: 'Security' }), { target: { value: 'psk-portal' } });
    expect(screen.getByText('Captive-portal profile')).toBeTruthy();
    expect(screen.getByPlaceholderText('Enter the PSK passphrase')).toBeTruthy();

    fireEvent.change(screen.getByRole('combobox', { name: 'Security' }), { target: { value: 'open' } });
    expect(screen.queryByText('Authentication server group')).toBeNull();
    expect(screen.queryByText('Captive-portal profile')).toBeNull();
    expect(screen.queryByPlaceholderText('Enter the PSK passphrase')).toBeNull();
    // Every mode still needs a role.
    expect(screen.getByText('Default role')).toBeTruthy();
  });

  it.each([
    ['open', false],
    ['wpa3-enterprise', true],
  ] as const)('clears an invalid PSK when changing to %s and applies without a passphrase', async (security, enterprise) => {
    renderConfigure();
    await waitFor(() => expect(queueSection().getByText('NET-4100')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'New SSID' }));
    await waitFor(() => expect(screen.getByText('Campus-01')).toBeTruthy());

    fireEvent.change(screen.getByPlaceholderText('Enter SSID name'), { target: { value: 'MRDN-Guest' } });
    fireEvent.change(screen.getByPlaceholderText('1-4094'), { target: { value: '830' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Campus-01' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Default role' }), { target: { value: 'guest' } });
    fireEvent.change(screen.getByPlaceholderText('Enter the PSK passphrase'), { target: { value: 'short' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Security' }), { target: { value: security } });
    if (enterprise) {
      fireEvent.change(screen.getByRole('combobox', { name: 'Authentication server group' }), {
        target: { value: 'clearpass' },
      });
    }
    fireEvent.click(
      screen.getByRole('checkbox', { name: 'I have reviewed this profile and these scope assignments — apply directly, no ticket.' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Apply directly' }));

    await waitFor(() => expect(mockApplySsidDirect).toHaveBeenCalledTimes(1));
    const submitted = mockApplySsidDirect.mock.calls[0][0];
    expect(submitted).toMatchObject({ security, defaultRole: 'guest' });
    expect(submitted).not.toHaveProperty('passphrase');

    fireEvent.change(screen.getByRole('combobox', { name: 'Security' }), { target: { value: 'wpa2-psk' } });
    expect(screen.getByPlaceholderText('Enter the PSK passphrase')).toHaveProperty('value', '');
    expect(screen.getByRole('combobox', { name: 'Default role' })).toHaveProperty('value', 'guest');
  });

  it('clears the enterprise authentication group when changing to PSK', async () => {
    renderConfigure();
    await waitFor(() => expect(queueSection().getByText('NET-4100')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'New SSID' }));
    await waitFor(() => expect(screen.getByText('Campus-01')).toBeTruthy());

    fireEvent.change(screen.getByPlaceholderText('Enter SSID name'), { target: { value: 'MRDN-Guest' } });
    fireEvent.change(screen.getByPlaceholderText('1-4094'), { target: { value: '830' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Campus-01' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Default role' }), { target: { value: 'guest' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Security' }), { target: { value: 'wpa3-enterprise' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Authentication server group' }), {
      target: { value: 'clearpass' },
    });
    fireEvent.change(screen.getByRole('combobox', { name: 'Security' }), { target: { value: 'wpa2-psk' } });
    fireEvent.change(screen.getByPlaceholderText('Enter the PSK passphrase'), { target: { value: 'sup3r-secret' } });
    fireEvent.click(
      screen.getByRole('checkbox', { name: 'I have reviewed this profile and these scope assignments — apply directly, no ticket.' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Apply directly' }));

    await waitFor(() => expect(mockApplySsidDirect).toHaveBeenCalledTimes(1));
    expect(mockApplySsidDirect.mock.calls[0][0]).not.toHaveProperty('authServerGroupId');
    fireEvent.change(screen.getByRole('combobox', { name: 'Security' }), { target: { value: 'wpa3-enterprise' } });
    expect(screen.getByRole('combobox', { name: 'Authentication server group' })).toHaveProperty('value', '');
  });

  it.each(['wpa2-psk', 'open'] as const)('clears the captive portal when changing portal security to %s', async (security) => {
    renderConfigure();
    await waitFor(() => expect(queueSection().getByText('NET-4100')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'New SSID' }));
    await waitFor(() => expect(screen.getByText('Campus-01')).toBeTruthy());

    fireEvent.change(screen.getByPlaceholderText('Enter SSID name'), { target: { value: 'MRDN-Guest' } });
    fireEvent.change(screen.getByPlaceholderText('1-4094'), { target: { value: '830' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Campus-01' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Default role' }), { target: { value: 'guest' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Security' }), { target: { value: 'psk-portal' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Captive-portal profile' }), {
      target: { value: 'guest-portal' },
    });
    fireEvent.change(screen.getByPlaceholderText('Enter the PSK passphrase'), { target: { value: 'sup3r-secret' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Security' }), { target: { value: security } });
    fireEvent.click(
      screen.getByRole('checkbox', { name: 'I have reviewed this profile and these scope assignments — apply directly, no ticket.' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Apply directly' }));

    await waitFor(() => expect(mockApplySsidDirect).toHaveBeenCalledTimes(1));
    const submitted = mockApplySsidDirect.mock.calls[0][0];
    expect(submitted).not.toHaveProperty('captivePortalProfileId');
    if (security === 'open') expect(submitted).not.toHaveProperty('passphrase');
    fireEvent.change(screen.getByRole('combobox', { name: 'Security' }), { target: { value: 'psk-portal' } });
    expect(screen.getByRole('combobox', { name: 'Captive-portal profile' })).toHaveProperty('value', '');
  });

  it('keeps Apply disabled until a scope, the required dependencies, and the review checkbox are all satisfied', async () => {
    renderConfigure();
    await waitFor(() => expect(queueSection().getByText('NET-4100')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'New SSID' }));
    await waitFor(() => expect(screen.getByText('Campus-01')).toBeTruthy());

    const applyButton = () => screen.getByRole('button', { name: 'Apply directly' });
    expect(applyButton()).toHaveProperty('disabled', true);

    await fillReadySsidForm();
    // Filled in, but not yet reviewed.
    expect(applyButton()).toHaveProperty('disabled', true);

    fireEvent.click(
      screen.getByRole('checkbox', { name: 'I have reviewed this profile and these scope assignments — apply directly, no ticket.' }),
    );
    expect(applyButton()).toHaveProperty('disabled', false);
  });

  it('disables Apply and names the missing dependency when a required catalog section is unavailable', async () => {
    mockGetSsidCatalog.mockResolvedValue({
      ...SSID_CATALOG,
      authServerGroups: [],
      unavailable: ['authServerGroups'],
    });
    renderConfigure();
    await waitFor(() => expect(queueSection().getByText('NET-4100')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'New SSID' }));
    await waitFor(() => expect(screen.getByText('Campus-01')).toBeTruthy());
    fireEvent.change(screen.getByRole('combobox', { name: 'Security' }), { target: { value: 'wpa3-enterprise' } });

    expect(screen.getByText(/Central did not report any authentication server groups/)).toBeTruthy();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Campus-01' }));
    fireEvent.click(
      screen.getByRole('checkbox', { name: 'I have reviewed this profile and these scope assignments — apply directly, no ticket.' }),
    );
    expect(screen.getByRole('button', { name: 'Apply directly' })).toHaveProperty('disabled', true);
    expect(screen.getByText('Apply is disabled — a required live dependency is unavailable')).toBeTruthy();
  });

  it('applies successfully: posts reviewConfirmed:true, shows the per-assignment breakdown, and refreshes /api/configure', async () => {
    renderConfigure();
    await waitFor(() => expect(queueSection().getByText('NET-4100')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'New SSID' }));
    await waitFor(() => expect(screen.getByText('Campus-01')).toBeTruthy());
    await fillReadySsidForm();
    fireEvent.click(
      screen.getByRole('checkbox', { name: 'I have reviewed this profile and these scope assignments — apply directly, no ticket.' }),
    );

    expect(mockGetConfigure).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Apply directly' }));

    await waitFor(() => expect(mockApplySsidDirect).toHaveBeenCalledTimes(1));
    expect(mockApplySsidDirect.mock.calls[0][1]).toBe(true);
    expect(mockApplySsidDirect.mock.calls[0][0]).toMatchObject({ name: 'MRDN-Guest', scopeIds: ['site-1'] });

    await waitFor(() => expect(screen.getByText('Applied')).toBeTruthy());
    expect(screen.getAllByText(/profile created — HTTP 201/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/confirmed present on re-read/).length).toBeGreaterThan(0);
    // /api/configure is refreshed after a successful apply.
    await waitFor(() => expect(mockGetConfigure).toHaveBeenCalledTimes(2));
  });

  it('a partial apply keeps every entered value and shows the warning breakdown', async () => {
    mockApplySsidDirect.mockResolvedValue({
      ok: false,
      partial: true,
      profile: { ok: true, action: 'updated', verified: true, httpCode: 200, message: 'profile updated — HTTP 200' },
      assignments: [{ scopeId: 'site-1', label: 'Campus-01', ok: false, httpCode: 500, message: 'assignment failed — HTTP 500' }],
    });
    renderConfigure();
    await waitFor(() => expect(queueSection().getByText('NET-4100')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'New SSID' }));
    await waitFor(() => expect(screen.getByText('Campus-01')).toBeTruthy());
    await fillReadySsidForm();
    fireEvent.click(
      screen.getByRole('checkbox', { name: 'I have reviewed this profile and these scope assignments — apply directly, no ticket.' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Apply directly' }));

    await waitFor(() => expect(screen.getByText('Partial — profile applied, an assignment failed')).toBeTruthy());
    expect(screen.getByText(/assignment failed — HTTP 500/)).toBeTruthy();
    // The entered values are still there for a retry.
    expect(screen.getByPlaceholderText('Enter SSID name')).toHaveProperty('value', 'MRDN-Guest');
    expect(screen.getByRole('checkbox', { name: 'Campus-01' })).toHaveProperty('checked', true);
    // The profile half succeeded and is explicitly not rolled back, so the
    // list is out of date whatever the assignments did. This used to skip the
    // refresh on the rule "nothing less than a full success", which left the
    // operator retrying from a list that could not show what had just landed.
    await waitFor(() => expect(mockGetConfigure).toHaveBeenCalledTimes(2));
  });

  /* The VLAN box is labelled "1-4094" and accepted 4095 anyway; the SSID name
   * box accepted 40 characters. Both are rules the server has always enforced,
   * so the operator filled the form, read the blast radius, ticked "I have
   * reviewed this" and pressed Apply to be told the value was never legal. */
  it('will not let a form Central would refuse be applied', async () => {
    renderConfigure();
    await waitFor(() => expect(queueSection().getByText('NET-4100')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'New SSID' }));
    await waitFor(() => expect(screen.getByText('Campus-01')).toBeTruthy());
    await fillReadySsidForm();
    fireEvent.click(
      screen.getByRole('checkbox', { name: 'I have reviewed this profile and these scope assignments — apply directly, no ticket.' }),
    );
    // Ready, until a VLAN outside the range the box itself advertises.
    await waitFor(() =>
      expect((screen.getByRole('button', { name: 'Apply directly' }) as HTMLButtonElement).disabled).toBe(false),
    );

    fireEvent.change(screen.getByPlaceholderText('1-4094'), { target: { value: '4095' } });

    await waitFor(() =>
      expect(screen.getByText('Apply is disabled — Central would refuse this form')).toBeTruthy(),
    );
    expect(screen.getByText('VLAN id must be a number between 1 and 4094')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Apply directly' }) as HTMLButtonElement).disabled).toBe(true);
    expect(mockApplySsidDirect).not.toHaveBeenCalled();

    // And the other two value rules, on the same form.
    fireEvent.change(screen.getByPlaceholderText('1-4094'), { target: { value: '830' } });
    fireEvent.change(screen.getByPlaceholderText('Enter SSID name'), {
      target: { value: 'MRDN-Guest-Wireless-Network-For-Visitors' },
    });
    await waitFor(() => expect(screen.getByText('SSID name must be 32 characters or fewer')).toBeTruthy());

    fireEvent.change(screen.getByPlaceholderText('Enter SSID name'), { target: { value: 'MRDN-Guest' } });
    fireEvent.change(screen.getByPlaceholderText('Enter the PSK passphrase'), { target: { value: 'short' } });
    await waitFor(() =>
      expect(
        screen.getByText('passphrase must be 8-63 characters, or exactly 64 hexadecimal characters'),
      ).toBeTruthy(),
    );
    expect((screen.getByRole('button', { name: 'Apply directly' }) as HTMLButtonElement).disabled).toBe(true);
  });

  // An untouched field is incomplete, not wrong. Apply is already off for it.
  it('does not accuse an operator of a bad value before they have typed one', async () => {
    renderConfigure();
    await waitFor(() => expect(queueSection().getByText('NET-4100')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'New SSID' }));
    await waitFor(() => expect(screen.getByText('Campus-01')).toBeTruthy());

    expect(screen.queryByText('Apply is disabled — Central would refuse this form')).toBeNull();
    expect(screen.queryByText('VLAN id must be a number between 1 and 4094')).toBeNull();
  });

  /* The profile half of the same distinction. Central answered the PUT with a
   * 201 — the SSID is very likely on the tenant — and only the read-back that
   * would prove it failed. Reporting that as "Not applied" in red is the
   * opposite of what happened, and the operator's response to it is to create
   * the same SSID a second time. */
  it('shows a written-but-unverified profile as unconfirmed, not as "Not applied"', async () => {
    mockApplySsidDirect.mockResolvedValue({
      ok: false,
      partial: false,
      profile: {
        ok: false,
        action: 'created',
        verified: false,
        httpCode: 201,
        message: 'profile created — HTTP 201; verification read-back failed — HTTP 503',
      },
      assignments: [],
    });
    renderConfigure();
    await waitFor(() => expect(queueSection().getByText('NET-4100')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'New SSID' }));
    await waitFor(() => expect(screen.getByText('Campus-01')).toBeTruthy());
    await fillReadySsidForm();
    fireEvent.click(
      screen.getByRole('checkbox', { name: 'I have reviewed this profile and these scope assignments — apply directly, no ticket.' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Apply directly' }));

    await waitFor(() => expect(screen.getByText('Profile created, not confirmed')).toBeTruthy());
    expect(screen.queryByText('Not applied')).toBeNull();
  });

  // The other side of it: Central refused the write, and that IS "not applied".
  it('still says Not applied when Central refused the profile write', async () => {
    mockApplySsidDirect.mockResolvedValue({
      ok: false,
      partial: false,
      profile: {
        ok: false,
        action: 'failed',
        verified: false,
        httpCode: 403,
        message: 'profile create failed — HTTP 403',
      },
      assignments: [],
    });
    renderConfigure();
    await waitFor(() => expect(queueSection().getByText('NET-4100')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'New SSID' }));
    await waitFor(() => expect(screen.getByText('Campus-01')).toBeTruthy());
    await fillReadySsidForm();
    fireEvent.click(
      screen.getByRole('checkbox', { name: 'I have reviewed this profile and these scope assignments — apply directly, no ticket.' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Apply directly' }));

    await waitFor(() => expect(screen.getByText('Not applied')).toBeTruthy());
  });

  /* Central taking the assignment POST and then not listing it is neither a
   * success nor a rejection: the operator should wait and re-check, not retry.
   * Rendering it as ✗ under "an assignment failed" sends them to the wrong
   * action; rendering it as ✓ would claim the SSID is live at a site where it
   * may not be broadcasting at all. */
  it('shows an accepted-but-unconfirmed assignment as its own outcome, not as a failure', async () => {
    mockApplySsidDirect.mockResolvedValue({
      ok: false,
      partial: true,
      profile: { ok: true, action: 'updated', verified: true, httpCode: 200, message: 'profile updated — HTTP 200' },
      assignments: [
        {
          scopeId: 'site-1',
          label: 'Campus-01',
          ok: false,
          verified: false,
          httpCode: 202,
          message: 'assignment accepted — HTTP 202, but the assignment is absent when the list is read back.',
        },
      ],
    });
    renderConfigure();
    await waitFor(() => expect(queueSection().getByText('NET-4100')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'New SSID' }));
    await waitFor(() => expect(screen.getByText('Campus-01')).toBeTruthy());
    await fillReadySsidForm();
    fireEvent.click(
      screen.getByRole('checkbox', { name: 'I have reviewed this profile and these scope assignments — apply directly, no ticket.' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Apply directly' }));

    await waitFor(() =>
      expect(screen.getByText('Partial — profile applied, scope assignments not confirmed')).toBeTruthy(),
    );
    // The per-assignment line is marked as pending confirmation, not failed.
    expect(screen.getByText(/⧗ Campus-01/)).toBeTruthy();
    expect(screen.queryByText(/✗ Campus-01/)).toBeNull();
    expect(screen.queryByText('Partial — profile applied, an assignment failed')).toBeNull();
  });

  /* The third state. When Central answers the assignment POST but will not
   * hand back its assignment list, the adapter leaves `verified` undefined
   * and keeps ok:true — the write happened, and there is no evidence it took
   * effect. The screen used to return '✓' on ok alone, before it ever looked
   * at verified, so an apply nobody could confirm was a green "Applied" panel
   * with a tick against every scope. The caveat was in the message text the
   * whole time, underneath a badge saying it had worked. */
  async function applyWith(result: SsidApplyResult): Promise<void> {
    mockApplySsidDirect.mockResolvedValue(result);
    renderConfigure();
    await waitFor(() => expect(queueSection().getByText('NET-4100')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'New SSID' }));
    await waitFor(() => expect(screen.getByText('Campus-01')).toBeTruthy());
    await fillReadySsidForm();
    fireEvent.click(
      screen.getByRole('checkbox', { name: 'I have reviewed this profile and these scope assignments — apply directly, no ticket.' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Apply directly' }));
  }

  const UNREAD_ASSIGNMENT = {
    scopeId: 'site-1',
    label: 'Campus-01',
    ok: true,
    httpCode: 200,
    message: 'assignment accepted — HTTP 200; could not re-read the assignment list to confirm it landed',
  };

  it('does not tick a scope assignment it was never able to read back', async () => {
    await applyWith({
      ok: true,
      partial: false,
      profile: { ok: true, action: 'created', verified: true, httpCode: 201, message: 'profile created — HTTP 201' },
      assignments: [UNREAD_ASSIGNMENT],
    });

    await waitFor(() =>
      expect(screen.getByText('Applied — no scope assignment could be confirmed')).toBeTruthy(),
    );
    expect(screen.getByText(/\? Campus-01/)).toBeTruthy();
    expect(screen.queryByText(/✓ Campus-01/)).toBeNull();
    // Not a failure and not in flight — those send the operator elsewhere.
    expect(screen.queryByText(/✗ Campus-01/)).toBeNull();
    expect(screen.queryByText(/⧗ Campus-01/)).toBeNull();
  });

  it('counts the unconfirmed scopes when only some of them were read back', async () => {
    await applyWith({
      ok: true,
      partial: false,
      profile: { ok: true, action: 'created', verified: true, httpCode: 201, message: 'profile created — HTTP 201' },
      assignments: [
        { scopeId: 'site-2', label: 'Branch-02', ok: true, verified: true, httpCode: 200, message: 'confirmed present on re-read' },
        UNREAD_ASSIGNMENT,
      ],
    });

    await waitFor(() =>
      expect(screen.getByText('Applied — 1 scope assignment was not confirmed')).toBeTruthy(),
    );
    expect(screen.getByText(/✓ Branch-02/)).toBeTruthy();
    expect(screen.getByText(/\? Campus-01/)).toBeTruthy();
  });

  // Must not over-apply, part one: a skipped assignment was found already on
  // file, which IS a successful read of the list in question.
  it('still ticks an assignment that was skipped because it was already on file', async () => {
    await applyWith({
      ok: true,
      partial: false,
      profile: { ok: true, action: 'unchanged', verified: true, httpCode: 200, message: 'profile unchanged' },
      assignments: [
        { scopeId: 'site-1', label: 'Campus-01', ok: true, skipped: true, httpCode: 200, message: 'already assigned' },
      ],
    });

    await waitFor(() => expect(screen.getByText('Applied')).toBeTruthy());
    expect(screen.getByText(/✓ Campus-01/)).toBeTruthy();
    expect(screen.queryByText(/\? Campus-01/)).toBeNull();
  });

  /* The list on this screen is served from the poll cache. When the server
     could not re-read Central after the write, re-fetching it returns the
     pre-change snapshot — so a green "applied" toast sits above a list with no
     such SSID in it, which reads as a failure and invites a second apply. */
  it('says the list is behind when Central could not be re-read', async () => {
    await applyWith({
      ...SSID_APPLIED,
      cacheRefresh: { attempted: true, ok: false, message: 'Central could not be re-read (poll error)' },
    });

    await waitFor(() => expect(screen.getByText('Applied')).toBeTruthy());
    expect(
      screen.getByText(/could not be re-read \(Central could not be re-read \(poll error\)\), so it does not show this change yet — do not apply it again/),
    ).toBeTruthy();
  });

  // Must not over-apply: a refresh that landed says nothing at all.
  it('stays quiet about the cache when the re-read worked', async () => {
    await applyWith({ ...SSID_APPLIED, cacheRefresh: { attempted: true, ok: true } });

    await waitFor(() => expect(screen.getByText('Applied')).toBeTruthy());
    expect(screen.queryByText(/does not show this change yet/)).toBeNull();
  });

  /* A partial apply is explicitly not rolled back — the profile is on the
     estate — and this branch never re-fetched the list at all, so the operator
     was sent to retry from a list that could not show what had just landed. */
  it('re-fetches the inventory after a partial apply, because the profile stands', async () => {
    const before = mockGetConfigure.mock.calls.length;
    await applyWith({
      ok: false,
      partial: true,
      profile: { ok: true, action: 'created', verified: true, httpCode: 201, message: 'profile created — HTTP 201' },
      assignments: [
        { scopeId: 'site-1', label: 'Campus-01', ok: false, httpCode: 500, message: 'assignment failed — HTTP 500' },
      ],
      cacheRefresh: { attempted: true, ok: true },
    });

    await waitFor(() => expect(mockGetConfigure.mock.calls.length).toBeGreaterThan(before + 1));
  });

  // Must not over-apply, part two: a fully confirmed apply keeps its green.
  it('leaves a confirmed apply reading as plainly applied', async () => {
    await applyWith(SSID_APPLIED);

    await waitFor(() => expect(screen.getByText('Applied')).toBeTruthy());
    expect(screen.getByText(/✓ Campus-01/)).toBeTruthy();
  });

  it('still calls a genuinely rejected assignment a failure', async () => {
    mockApplySsidDirect.mockResolvedValue({
      ok: false,
      partial: true,
      profile: { ok: true, action: 'updated', verified: true, httpCode: 200, message: 'profile updated — HTTP 200' },
      assignments: [
        { scopeId: 'site-1', label: 'Campus-01', ok: false, httpCode: 500, message: 'assignment failed — HTTP 500' },
      ],
    });
    renderConfigure();
    await waitFor(() => expect(queueSection().getByText('NET-4100')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'New SSID' }));
    await waitFor(() => expect(screen.getByText('Campus-01')).toBeTruthy());
    await fillReadySsidForm();
    fireEvent.click(
      screen.getByRole('checkbox', { name: 'I have reviewed this profile and these scope assignments — apply directly, no ticket.' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Apply directly' }));

    await waitFor(() => expect(screen.getByText('Partial — profile applied, an assignment failed')).toBeTruthy());
    expect(screen.getByText(/✗ Campus-01/)).toBeTruthy();
  });

  it('a failed apply (offline) surfaces the error, keeps the form, and a retry can still succeed', async () => {
    mockApplySsidDirect.mockResolvedValueOnce({ error: 'cannot reach the portal backend: network down', offline: true });
    renderConfigure();
    await waitFor(() => expect(queueSection().getByText('NET-4100')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'New SSID' }));
    await waitFor(() => expect(screen.getByText('Campus-01')).toBeTruthy());
    await fillReadySsidForm();
    fireEvent.click(
      screen.getByRole('checkbox', { name: 'I have reviewed this profile and these scope assignments — apply directly, no ticket.' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Apply directly' }));

    await waitFor(() => expect(screen.getByText('Apply failed')).toBeTruthy());
    expect(screen.getAllByText('cannot reach the portal backend: network down').length).toBeGreaterThan(0);
    expect(screen.getByPlaceholderText('Enter SSID name')).toHaveProperty('value', 'MRDN-Guest');

    // Retry: the second attempt is the default mocked success.
    fireEvent.click(screen.getByRole('button', { name: 'Apply directly' }));
    await waitFor(() => expect(screen.getByText('Applied')).toBeTruthy());
    expect(mockApplySsidDirect).toHaveBeenCalledTimes(2);
  });

  it('editing an existing SSID seeds only the known fields — scope and dependency selections start empty, never invented', async () => {
    mockGetConfigure.mockResolvedValue({ ...CONFIGURE_DATA, ssids: [EXISTING_SSID] });
    renderConfigure();
    await waitFor(() => expect(queueSection().getByText('NET-4100')).toBeTruthy());

    fireEvent.click(screen.getByText('MRDN-Prod'));

    expect(screen.getByPlaceholderText('Enter SSID name')).toHaveProperty('value', 'MRDN-Prod');
    expect(screen.getByPlaceholderText('1-4094')).toHaveProperty('value', '820');
    await waitFor(() => expect(screen.getByText('Campus-01')).toBeTruthy());
    // No scope pre-checked — the read side never reported scope assignment.
    expect(screen.getByRole('checkbox', { name: 'Campus-01' })).toHaveProperty('checked', false);
    expect(screen.getByRole('button', { name: 'Apply directly' })).toHaveProperty('disabled', true);
  });

  it('names the catalog read failure instead of silently offering an empty scope list', async () => {
    mockGetSsidCatalog.mockResolvedValue({ error: 'catalog unreadable' });
    renderConfigure();
    await waitFor(() => expect(queueSection().getByText('NET-4100')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'New SSID' }));

    await waitFor(() => expect(screen.getByText('The scope catalog could not be read')).toBeTruthy());
    expect(screen.getByText('catalog unreadable')).toBeTruthy();
  });
});

/**
 * A partially-read audit log.
 *
 * The server can only return the generations it managed to open. Before this,
 * a log missing a stretch came back as a shorter list that looked exactly like
 * a quieter install — the drawer would render a continuous history with an
 * invisible hole, which is the same failure as showing an unread section as
 * empty, on the one screen where being trusted matters most.
 */
describe('Configure — change history that could not be fully read', () => {
  it('says the log is partial and stops presenting the count as a total', async () => {
    mockGetChangeHistory.mockResolvedValue({
      events: [AUDIT_ROW],
      unreadable: ['change-log.2.jsonl'],
    });
    await openHistoryDrawer();

    await waitFor(() =>
      expect(screen.getByText('Part of the audit log could not be read')).toBeTruthy(),
    );
    // The rows it did read are still shown — a partial answer beats none.
    expect(screen.getByText('chg-7f21')).toBeTruthy();
    // The generation is named so the operator can go and look at it.
    expect(screen.getByText(/change-log\.2\.jsonl/)).toBeTruthy();
    // "1" would assert there is one; "1 readable" asserts only what was seen.
    expect(screen.getByText('1 readable')).toBeTruthy();
  });

  it('shows no such warning, and a plain count, when the whole log was read', async () => {
    mockGetChangeHistory.mockResolvedValue({ events: [AUDIT_ROW], unreadable: [] });
    await openHistoryDrawer();

    await waitFor(() => expect(screen.getByText('chg-7f21')).toBeTruthy());
    // A clean read must not carry a scary caveat — an alarm that is always on
    // is one the operator learns to ignore on the day it matters.
    expect(screen.queryByText('Part of the audit log could not be read')).toBeNull();
    // Scoped to the drawer's own header: a bare "1" and other section metas
    // exist elsewhere on the screen.
    const header = screen.getByText('Brokered changes').closest('div');
    expect(header?.querySelector('.nd-section-header__meta')?.textContent).toBe('1');
  });

  it('warns even when every generation holding events was unreadable', async () => {
    // The dangerous case: an empty list that reads as "nothing was ever
    // brokered here" while the record actually exists and is unreachable.
    mockGetChangeHistory.mockResolvedValue({
      events: [],
      unreadable: ['change-log.1.jsonl', 'change-log.2.jsonl'],
    });
    await openHistoryDrawer();

    await waitFor(() =>
      expect(screen.getByText('Part of the audit log could not be read')).toBeTruthy(),
    );
    expect(screen.getByText(/2 rotated logs/)).toBeTruthy();
  });
});

/**
 * A push Central accepted but has not confirmed.
 *
 * `applied` drove a green success toast, and the broker used to set it on any
 * 2xx — so a 202 ended the operator's involvement in a change that Central had
 * only promised to look at. The change is off the queue either way (a second
 * PUT could duplicate the write), which is exactly why the toast has to carry
 * the caveat: it is the operator's last chance to learn there is something to
 * go and verify.
 */
describe('Configure — a push accepted but not confirmed', () => {
  it('renders a thrown push transport outcome as unknown and never suggests retrying it', async () => {
    mockGetChangeQueue
      .mockResolvedValueOnce([serverChange()])
      .mockResolvedValue([serverChange({ state: 'applying' })]);
    mockPushChange.mockResolvedValue({
      ok: false,
      outcomeUnknown: true,
      changeId: 'chg-server-1',
      ticket: 'NET-4100',
      kind: 'vlan',
      snapshot: true,
      message: 'outcome unknown — Central transport confirmation was lost; reconcile before any retry',
    });
    renderConfigure();
    await waitFor(() => expect(queueSection().getByText('NET-4100')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'Push queue' }));

    expect(await screen.findByText('Outcome unknown — reconciliation required')).toBeTruthy();
    expect(screen.getByText(/Central transport confirmation was lost/)).toBeTruthy();
    expect(screen.queryByText(/push failed|re-queue/i)).toBeNull();
    await waitFor(() => expect(queueSection().getByText('applying')).toBeTruthy());
  });

  it('does not celebrate a 202 as a completed change', async () => {
    mockPushChange.mockResolvedValue({
      ok: true,
      applied: false,
      accepted: true,
      changeId: 'chg-server-1',
      ticket: 'NET-4100',
      kind: 'vlan',
      httpCode: 202,
      snapshot: true,
      message: 'accepted for later action by Central — HTTP 202; Central has NOT confirmed the change is in effect, so verify it on the plane before relying on it.',
    });
    renderConfigure();
    await waitFor(() => expect(queueSection().getByText('NET-4100')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'Push queue' }));

    await waitFor(() =>
      expect(screen.getByText('Accepted by Central, not yet confirmed')).toBeTruthy(),
    );
    // The instruction to go and check has to reach the screen, not just the
    // server's log.
    expect(screen.getByText(/verify it on the plane/)).toBeTruthy();
  });

  /* The push loop re-read the ticket queue and nothing else. The change left
     the queue, a green toast said "pushed", and the SSID/VLAN/port lists on the
     same screen carried on showing the estate from before it — which is the
     only evidence the operator has that the push did anything. */
  it('re-reads the estate after an applied push, not only the ticket queue', async () => {
    renderConfigure();
    await waitFor(() => expect(queueSection().getByText('NET-4100')).toBeTruthy());
    const before = mockGetConfigure.mock.calls.length;

    fireEvent.click(screen.getByRole('button', { name: 'Push queue' }));

    await waitFor(() => expect(mockGetConfigure.mock.calls.length).toBeGreaterThan(before));
  });

  it('says the lists are behind when Central could not be re-read after a push', async () => {
    mockPushChange.mockResolvedValue({
      ok: true,
      applied: true,
      changeId: 'chg-server-1',
      ticket: 'NET-4100',
      kind: 'vlan',
      snapshot: true,
      message: 'pushed',
      cacheRefresh: { attempted: true, ok: false, message: 'Central could not be re-read (poll error)' },
    });
    renderConfigure();
    await waitFor(() => expect(queueSection().getByText('NET-4100')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'Push queue' }));

    await waitFor(() =>
      expect(screen.getByText(/could not be re-read \(Central could not be re-read \(poll error\)\), so they do not show this yet\. Do not queue it again\./)).toBeTruthy(),
    );
  });

  it('still reports a confirmed push plainly, with no caveat attached', async () => {
    // The other half: a real success must not be dressed up as uncertain, or
    // the caveat stops meaning anything on the day it matters.
    renderConfigure();
    await waitFor(() => expect(queueSection().getByText('NET-4100')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'Push queue' }));

    await waitFor(() => expect(mockPushChange).toHaveBeenCalledWith('chg-server-1'));
    expect(screen.queryByText('Accepted by Central, not yet confirmed')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The SSID inventory list renders each row's own facts: the site attribution
// the adapter merged into `targets` ('Site A + Site B · enabled') and the
// redaction note a secret-bearing row carries — the marker, never the secret.
// ---------------------------------------------------------------------------
describe('Configure SSID rows — site attribution and the redaction note', () => {
  it('renders the merged multi-site targets and the note, never a PSK value', async () => {
    const CANARY = 'sup3r-s3cret-canary';
    // The row as the Mist site-WLAN walk maps it, PLUS a canary no SsidObject
    // should ever carry: if a secret ever rode the payload, the screen must
    // still not render it (the adapter whitelist is the real guard — this
    // pins the screen as the second fence).
    const mistRow = Object.assign(
      {
        kind: 'ssid',
        origin: 'configured',
        name: 'MRDN-IoT',
        vlan: '830',
        security: 'WPA2-PSK',
        targets: 'Campus-02 Research + Northgate Clinic · enabled',
        plane: 'MIST',
        tone: 'accent',
        note: 'PSK set — redacted by the portal',
      } as SsidObject,
      { psk: CANARY, auth: { psk: CANARY } },
    );
    mockGetConfigure.mockResolvedValue({ ...CONFIGURE_DATA, ssids: [mistRow] });

    renderConfigure();

    expect(await screen.findByText('MRDN-IoT')).toBeTruthy();
    expect(screen.getByText('Campus-02 Research + Northgate Clinic · enabled')).toBeTruthy();
    expect(screen.getByText('PSK set — redacted by the portal')).toBeTruthy();
    expect(document.body.textContent).not.toContain(CANARY);
  });

  it('renders the authored demo notes on the fixture path', async () => {
    mockGetConfigure.mockResolvedValue({
      ...CONFIGURE_DATA,
      ssids: SSIDS,
      inventoryMode: 'configured',
      dataSource: 'demo',
    });

    renderConfigure();

    // The three authored PSK rows carry the same marker the live adapter
    // stamps — including MRDN-Research, the demo's purely-Mist WLAN.
    expect((await screen.findAllByText('PSK set — redacted by the portal')).length).toBe(3);
    expect(screen.getByText('guest-lobby, northgate-public · 96 APs')).toBeTruthy();
    expect(screen.getByText('all groups · 268 APs')).toBeTruthy();
    expect(screen.getByText('Campus-02 Research · enabled')).toBeTruthy();
    // The note marks a redaction; no fixture field holds a passphrase to leak.
    expect(document.body.textContent).not.toMatch(/passphrase/i);
  });
});

// ---------------------------------------------------------------------------
// Mist SSID direct write — the drawer rides the same reviewed flow, targeted
// at Mist. The catalog mock answers per plane so the suite proves which
// catalog the drawer asked for.
// ---------------------------------------------------------------------------

const MIST_CATALOG: SsidCatalog = {
  scopes: [
    { id: 'campus-02', label: 'Campus-02 Research', category: 'site' },
    { id: 'northgate', label: 'Northgate Clinic', category: 'site' },
  ],
  roles: [],
  authServerGroups: [],
  captivePortalProfiles: [],
  unavailable: [],
  source: 'Mist /api/v1/sites/{site}/wlans · 2 sites',
};

/** The deployment reports Central brokered + Mist direct — the combination
 *  that makes the drawer offer the plane choice. */
const MIST_DIRECT_CAPS = [
  { ...CENTRAL_ADMITTED_CAPABILITY, note: 'brokered write, ticket required' },
  { plane: 'Mist', planeId: 'mist', mode: 'direct' as const, note: 'reviewed SSID writes, no ticket', tone: 'accent' as const, linked: true, canDirectWrite: true },
];

/** A configured Mist WLAN row as the live config read maps it — disabled,
 *  with the redaction note its cleartext-PSK payload earned. */
const MIST_ROW: SsidObject = {
  kind: 'ssid',
  origin: 'configured',
  name: 'MRDN-Research',
  vlan: 'vlan 822',
  security: 'WPA2-PSK',
  targets: 'Campus-02 Research · disabled',
  plane: 'MIST',
  tone: 'info',
  note: 'PSK set — redacted by the portal',
  enabled: false,
};

const MIST_APPLIED: SsidApplyResult = {
  ok: true,
  partial: false,
  profile: { ok: true, action: 'updated', verified: true, message: 'site-scoped WLAN · updated at 1 site' },
  assignments: [
    { scopeId: 'campus-02', label: 'Campus-02 Research', ok: true, verified: true, httpCode: 200, message: 'WLAN updated — HTTP 200' },
  ],
};

function mockCatalogsByPlane() {
  mockGetSsidCatalog.mockImplementation(async (plane) => (plane === 'mist' ? MIST_CATALOG : SSID_CATALOG));
}

describe('Configure — Mist SSID direct write', () => {
  it('consumes one exact WLAN query after loaded inventory selects the real Mist row', async () => {
    mockCatalogsByPlane();
    mockGetConfigure.mockResolvedValue({
      ...CONFIGURE_DATA,
      ssids: [MIST_ROW],
      capabilities: MIST_DIRECT_CAPS,
      inventoryMode: 'configured',
    });
    const query = new URLSearchParams({
      edit: 'ssid',
      plane: 'MIST',
      name: 'MRDN-Research',
      vlan: 'vlan 822',
      targets: 'Campus-02 Research · disabled',
    });
    renderConfigure(`/configure?${query.toString()}`);

    expect((await screen.findByLabelText('SSID name') as HTMLInputElement).value).toBe('MRDN-Research');
    await waitFor(() => expect(mockGetSsidCatalog).toHaveBeenCalledTimes(1));
    expect(mockGetSsidCatalog).toHaveBeenCalledWith('mist');
    expect(screen.getByTestId('location-probe').textContent).toBe('/configure');
  });

  it('uses the confirmed Mist link plane when the matched WLAN row is shared across planes', async () => {
    mockCatalogsByPlane();
    const sharedRow: SsidObject = { ...MIST_ROW, plane: 'CENTRAL + MIST' };
    mockGetConfigure.mockResolvedValue({
      ...CONFIGURE_DATA,
      ssids: [sharedRow],
      capabilities: MIST_DIRECT_CAPS,
      inventoryMode: 'configured',
    });
    const query = new URLSearchParams({
      edit: 'ssid',
      plane: 'MIST',
      name: sharedRow.name,
      vlan: sharedRow.vlan,
      targets: sharedRow.targets,
    });
    renderConfigure(`/configure?${query.toString()}`);

    await screen.findByLabelText('SSID name');
    await waitFor(() => expect(mockGetSsidCatalog).toHaveBeenCalledWith('mist'));
    expect(screen.getByRole('combobox', { name: 'Plane' })).toHaveProperty('value', 'MIST');
    expect(screen.queryByText('Default role')).toBeNull();
  });

  it('warns and consumes a missing WLAN query without opening a writable form', async () => {
    mockGetConfigure.mockResolvedValue({ ...CONFIGURE_DATA, ssids: [MIST_ROW], inventoryMode: 'configured' });
    const query = new URLSearchParams({
      edit: 'ssid',
      plane: 'MIST',
      name: 'MRDN-Research',
      vlan: 'vlan 822',
      targets: 'Other site',
    });
    renderConfigure(`/configure?${query.toString()}`);

    expect(await screen.findByText('The requested WLAN is no longer an exact loaded inventory row. Nothing was opened.')).toBeTruthy();
    expect(mockGetSsidCatalog).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('SSID name')).toBeNull();
    expect(screen.getByTestId('location-probe').textContent).toBe('/configure');
  });

  it('a Mist SSID row opens the Mist edit flow: Mist catalog, no Central dependencies, admin state seeded from the row', async () => {
    mockCatalogsByPlane();
    mockGetConfigure.mockResolvedValue({
      ...CONFIGURE_DATA,
      ssids: [MIST_ROW],
      capabilities: MIST_DIRECT_CAPS,
      inventoryMode: 'configured',
    });
    renderConfigure();
    fireEvent.click(await screen.findByRole('button', { name: /MRDN-Research/ }));

    // The Mist catalog was asked for BY NAME — the Central one would be the
    // wrong scopes for a site-scoped write.
    await waitFor(() => expect(mockGetSsidCatalog).toHaveBeenCalledWith('mist'));
    await screen.findByRole('checkbox', { name: 'Campus-02 Research' });
    expect(screen.getByRole('checkbox', { name: 'Northgate Clinic' })).toBeTruthy();

    // Plane reads MIST; Central's role/server-group/portal selects are gone.
    expect(screen.getByRole('combobox', { name: 'Plane' })).toHaveProperty('value', 'MIST');
    expect(screen.queryByText('Default role')).toBeNull();
    expect(screen.queryByText('Authentication server group')).toBeNull();
    expect(screen.queryByText('Captive-portal profile')).toBeNull();

    // The row said disabled — the switch is seeded off, never assumed on.
    expect(screen.getByRole('switch', { name: 'WLAN enabled' }).getAttribute('aria-checked')).toBe('false');
    // wpa2-psk: the write-only passphrase field is the one dependency Mist has.
    expect(screen.getByPlaceholderText('Enter the PSK passphrase')).toBeTruthy();
    // Name/VLAN seeded from the row.
    expect(screen.getByPlaceholderText('Enter SSID name')).toHaveProperty('value', 'MRDN-Research');
    expect(screen.getByPlaceholderText('1-4094')).toHaveProperty('value', '822');
  });

  it('refuses enterprise/portal modes in the drawer with the shared sentence — Apply disabled', async () => {
    mockCatalogsByPlane();
    mockGetConfigure.mockResolvedValue({
      ...CONFIGURE_DATA,
      ssids: [MIST_ROW],
      capabilities: MIST_DIRECT_CAPS,
      inventoryMode: 'configured',
    });
    renderConfigure();
    fireEvent.click(await screen.findByRole('button', { name: /MRDN-Research/ }));
    await screen.findByRole('checkbox', { name: 'Campus-02 Research' });

    fireEvent.change(screen.getByRole('combobox', { name: 'Security' }), { target: { value: 'wpa3-enterprise' } });
    await screen.findByText('Apply is disabled — Mist cannot express this security mode');
    expect(document.body.textContent).toMatch(/RADIUS servers/);
    expect(screen.getByRole('button', { name: 'Apply directly' })).toHaveProperty('disabled', true);

    fireEvent.change(screen.getByRole('combobox', { name: 'Security' }), { target: { value: 'psk-portal' } });
    // The refusal renders in the alert AND on the preview's refused auth line.
    expect((await screen.findAllByText(/a Mist captive portal is the WLAN/)).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Apply directly' })).toHaveProperty('disabled', true);

    // Back to a representable mode: the refusal clears.
    fireEvent.change(screen.getByRole('combobox', { name: 'Security' }), { target: { value: 'wpa2-psk' } });
    await waitFor(() => expect(screen.queryByText('Apply is disabled — Mist cannot express this security mode')).toBeNull());
    expect(mockApplySsidDirect).not.toHaveBeenCalled();
  });

  it('applies the Mist edit end-to-end: plane MIST, site scope, enabled state, write-only passphrase', async () => {
    mockCatalogsByPlane();
    mockApplySsidDirect.mockResolvedValue(MIST_APPLIED);
    mockGetConfigure.mockResolvedValue({
      ...CONFIGURE_DATA,
      ssids: [MIST_ROW],
      capabilities: MIST_DIRECT_CAPS,
      inventoryMode: 'configured',
    });
    renderConfigure();
    fireEvent.click(await screen.findByRole('button', { name: /MRDN-Research/ }));
    await screen.findByRole('checkbox', { name: 'Campus-02 Research' });

    fireEvent.change(screen.getByPlaceholderText('Enter the PSK passphrase'), { target: { value: 'sup3r-secret-psk' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Campus-02 Research' }));
    fireEvent.click(
      screen.getByRole('checkbox', { name: 'I have reviewed this profile and these scope assignments — apply directly, no ticket.' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Apply directly' }));

    await waitFor(() => expect(mockApplySsidDirect).toHaveBeenCalledTimes(1));
    const [form, reviewConfirmed] = mockApplySsidDirect.mock.calls[0];
    expect(reviewConfirmed).toBe(true);
    expect(form).toMatchObject({
      plane: 'MIST',
      name: 'MRDN-Research',
      vlan: '822',
      security: 'wpa2-psk',
      scopeIds: ['campus-02'],
      passphrase: 'sup3r-secret-psk',
      enabled: false, // the row's admin state rides through — not silently re-enabled
    });
    // Central constructs must not leak into a Mist write. The base form seeds
    // these keys with explicit `undefined` (JSON drops them), so assert the
    // VALUE is undefined rather than the key's absence.
    expect((form as Partial<{ defaultRole: string }>).defaultRole).toBeUndefined();
    expect((form as Partial<{ authServerGroupId: string }>).authServerGroupId).toBeUndefined();
    expect((form as Partial<{ captivePortalProfileId: string }>).captivePortalProfileId).toBeUndefined();

    // The result panel names the per-site write (toast AND panel render it),
    // and the passphrase never renders anywhere.
    expect((await screen.findAllByText(/site-scoped WLAN · updated at 1 site/)).length).toBeGreaterThan(0);
    expect(document.body.textContent).not.toContain('sup3r-secret-psk');
  });

  it('New SSID offers the plane choice — switching to Mist reloads the Mist catalog and drops Central dependencies', async () => {
    mockCatalogsByPlane();
    mockGetConfigure.mockResolvedValue({ ...CONFIGURE_DATA, capabilities: MIST_DIRECT_CAPS });
    renderConfigure();
    await waitFor(() => expect(queueSection().getByText('NET-4100')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'New SSID' }));

    // Default is Central, with the Central catalog and the role dependency.
    await waitFor(() => expect(mockGetSsidCatalog).toHaveBeenCalledWith('central'));
    await screen.findByRole('checkbox', { name: 'Campus-01' });
    expect(screen.getByText('Default role')).toBeTruthy();
    expect(screen.queryByRole('switch', { name: 'WLAN enabled' })).toBeNull();

    fireEvent.change(screen.getByRole('combobox', { name: 'Plane' }), { target: { value: 'MIST' } });
    await waitFor(() => expect(mockGetSsidCatalog).toHaveBeenCalledWith('mist'));
    await screen.findByRole('checkbox', { name: 'Campus-02 Research' });
    expect(screen.queryByText('Default role')).toBeNull();
    expect(screen.queryByRole('checkbox', { name: 'Campus-01' })).toBeNull(); // Central scopes cleared with the plane
    // A new Mist WLAN starts enabled — the operator can say otherwise.
    expect(screen.getByRole('switch', { name: 'WLAN enabled' }).getAttribute('aria-checked')).toBe('true');

    fireEvent.change(screen.getByRole('combobox', { name: 'Plane' }), { target: { value: 'CENTRAL' } });
    await waitFor(() => expect(screen.getByText('Default role')).toBeTruthy());
    expect(screen.queryByRole('switch', { name: 'WLAN enabled' })).toBeNull();
  });

  it('no reported Mist write path → no plane choice, and the read-only sentence stands', async () => {
    mockCatalogsByPlane();
    mockGetConfigure.mockResolvedValue({
      ...CONFIGURE_DATA,
      capabilities: [{ plane: 'Mist', planeId: 'mist', mode: 'read only' as const, note: 'no write path', tone: 'neutral' as const, linked: true }],
    });
    renderConfigure();
    await waitFor(() => expect(queueSection().getByText('NET-4100')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'New SSID' }));
    await waitFor(() => expect(mockGetSsidCatalog).toHaveBeenCalledWith('central'));
    expect(screen.queryByRole('combobox', { name: 'Plane' })).toBeNull();
    // The capability matrix row keeps its honest read-only badge.
    expect(screen.getByText('read only')).toBeTruthy();
  });

  it('the brokered-write sentence names reviewed SSID writes for a direct plane — never a push it cannot take', async () => {
    mockGetConfigure.mockResolvedValue({ ...CONFIGURE_DATA, capabilities: MIST_DIRECT_CAPS });
    renderConfigure();
    await waitFor(() => expect(screen.getByText('Writes are brokered, never standing')).toBeTruthy());
    expect(
      screen.getByText(
        `${LEASE_SENTENCE} HPE Aruba Central accepts pushes from here; Mist takes reviewed SSID writes without a ticket.`,
      ),
    ).toBeTruthy();
  });
});
