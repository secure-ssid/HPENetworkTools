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
import Configure from './Configure';
import { SettingsProvider } from '../app/SettingsContext';
import { ToastProvider } from '../nightdesk';
import {
  applySsidDirect,
  discardChange,
  dryRunConfig,
  getChangeHistory,
  getChangeQueue,
  getConfigure,
  getSsidCatalog,
  pushChange,
  queueChange,
} from '../api/client';
import type { BrokeredChange, ConfigureData } from '../api/client';
import type { SsidApplyResult, SsidCatalog } from '@hpe/shared';

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

// -- fixtures ---------------------------------------------------------------

/** Minimal screen payload — the queue tests only need the sections to exist. */
const CONFIGURE_DATA: ConfigureData = {
  stats: [],
  ssids: [],
  ports: [],
  vlans: [],
  inventoryMode: 'unavailable',
  queued: [],
  capabilities: [],
  dataSource: 'live',
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

function renderConfigure() {
  return render(
    <SettingsProvider>
      <ToastProvider>
        <Configure />
      </ToastProvider>
    </SettingsProvider>,
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
});

afterEach(cleanup);

describe('Configure — per-entry-source queue semantics', () => {
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

  it('a partial apply keeps every entered value and shows the warning breakdown without refreshing', async () => {
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
    // No refresh on anything less than a full success.
    expect(mockGetConfigure).toHaveBeenCalledTimes(1);
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
