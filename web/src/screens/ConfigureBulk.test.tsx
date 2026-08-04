/**
 * web/src/screens/ConfigureBulk.test.tsx — the change-queue bulk action bar.
 *
 * The queue table's selection (per-row checkboxes, the select-all header
 * checkbox, the DataTable's controlled selectedKeys pair) raises a contextual
 * "N selected — Approve / Reject" bar that applies the EXISTING per-item
 * push/discard flow in sequence — each change keeps its own brokered review,
 * and the summary toast names the per-item outcomes with the failures named.
 *
 * The api client is mocked at the module boundary — no real fetch. All waits
 * are promise-based (waitFor/findBy); no timers are involved.
 *
 * Covered:
 *  (a) select-all and per-row checkboxes drive the "N selected" bar; Clear resets;
 *  (b) Approve pushes the selection in queue order — sequentially, one broker
 *      call at a time — and the selection clears when the run completes;
 *  (c) a per-item push failure is named in the summary and its row stays
 *      listed — never folded into the applied count;
 *  (d) a not-ready row is skipped and named, never pushed;
 *  (e) with no broker behind the rows (the demo/offline showcase) Approve
 *      pushes nothing and says why;
 *  (f) Reject discards the selection in sequence and clears it;
 *  (g) a per-item discard failure is named and its row stays listed.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
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
import type { BrokeredChange, ConfigureData, PushResult } from '../api/client';

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

const SECOND = serverChange({
  id: 'chg-server-2',
  ticket: 'NET-4101',
  what: 'Port 1/1/12 on sw-core-1 — uplink to fw',
  where: 'sw-core-1 · local collector, recorded session',
});

function pushed(id: string): PushResult {
  return { ok: true, applied: true, changeId: id, ticket: 'NET-4100', kind: 'vlan', snapshot: true, message: 'pushed' };
}

// -- helpers ----------------------------------------------------------------

function renderConfigure() {
  return render(
    <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <SettingsProvider>
        <ToastProvider>
          <Configure />
        </ToastProvider>
      </SettingsProvider>
    </MemoryRouter>,
  );
}

/** The right-hand "Queued changes" column: header + table + bar + buttons. */
function queueSection() {
  const label = screen.getByText('Queued changes');
  const header = label.closest('.nd-section-header');
  if (!header || !header.parentElement) throw new Error('queue section not found');
  return within(header.parentElement);
}

/** Load the screen with the two-entry server queue. */
async function renderWithTwo() {
  mockGetChangeQueue.mockReset();
  mockGetChangeQueue.mockResolvedValueOnce([serverChange(), SECOND]).mockResolvedValue([]);
  renderConfigure();
  await waitFor(() => expect(queueSection().getByText('NET-4100')).toBeTruthy());
  expect(queueSection().getByText('NET-4101')).toBeTruthy();
}

function selectAll() {
  fireEvent.click(queueSection().getByRole('checkbox', { name: 'Select all queued changes' }));
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetConfigure.mockResolvedValue(CONFIGURE_DATA);
  mockGetChangeQueue.mockResolvedValue([serverChange()]);
  mockQueueChange.mockResolvedValue({ error: OFFLINE_ERROR, offline: true });
  mockPushChange.mockImplementation((id) => Promise.resolve(pushed(id)));
  mockDiscardChange.mockImplementation((id) => Promise.resolve({ ok: true, changeId: id }));
  mockDryRunConfig.mockResolvedValue({ error: 'dry run not exercised here' });
  mockGetChangeHistory.mockResolvedValue({ events: [], unreadable: [] });
  mockGetSsidCatalog.mockResolvedValue(null);
  mockApplySsidDirect.mockResolvedValue({ error: 'not exercised here' });
  mockGetPortalSettings.mockResolvedValue({ demoMode: false, pollIntervalSec: 60, configMode: false });
  mockApplyConfigDirect.mockResolvedValue({ error: 'not exercised here' });
});

afterEach(cleanup);

describe('Configure — the change-queue bulk action bar', () => {
  it('(a) select-all and per-row checkboxes drive the bar; Clear resets the selection', async () => {
    await renderWithTwo();

    // Nothing selected, no bar.
    expect(queueSection().queryByText(/SELECTED/)).toBeNull();

    selectAll();
    expect(queueSection().getByText(/2 selected/i)).toBeTruthy();

    // Unchecking one row narrows the same selection the bar reads.
    fireEvent.click(
      queueSection().getByRole('checkbox', { name: 'Select change: Add DHCP helper 10.44.0.20 to vlan 812' }),
    );
    expect(queueSection().getByText(/1 selected/i)).toBeTruthy();

    // Select-all again checks everything, Clear empties it and the bar goes.
    selectAll();
    expect(queueSection().getByText(/2 selected/i)).toBeTruthy();
    fireEvent.click(queueSection().getByRole('button', { name: 'Clear' }));
    expect(queueSection().queryByText(/SELECTED/)).toBeNull();
    expect(
      queueSection()
        .getAllByRole('checkbox')
        .every((box) => (box as HTMLInputElement).checked === false),
    ).toBe(true);
  });

  it('(b) Approve pushes the selection in queue order, one broker call at a time, then clears the selection', async () => {
    await renderWithTwo();
    // The first push hangs until the test releases it: a parallel burst would
    // call the second id before the first resolved, and fail this assertion.
    let releaseFirst!: (result: PushResult) => void;
    mockPushChange.mockReset();
    mockPushChange.mockImplementation((id) =>
      id === 'chg-server-1'
        ? new Promise<PushResult>((resolve) => {
            releaseFirst = resolve;
          })
        : Promise.resolve(pushed(id)),
    );

    selectAll();
    fireEvent.click(queueSection().getByRole('button', { name: 'Approve' }));

    await waitFor(() => expect(mockPushChange).toHaveBeenCalledTimes(1));
    expect(mockPushChange).toHaveBeenCalledWith('chg-server-1');
    releaseFirst(pushed('chg-server-1'));

    await waitFor(() => expect(mockPushChange).toHaveBeenCalledTimes(2));
    expect(mockPushChange.mock.calls[1]?.[0]).toBe('chg-server-2');

    // The summary reports the run and the selection clears with it; the
    // refreshed queue (both pushed) is honestly empty.
    expect(await screen.findByText('Bulk approve — 2 of 2 applied')).toBeTruthy();
    await waitFor(() => expect(queueSection().queryByText(/SELECTED/)).toBeNull());
    await waitFor(() => expect(queueSection().getByText('No changes queued')).toBeTruthy());
  });

  it('(c) a per-item push failure is named in the summary and its row stays listed', async () => {
    mockGetChangeQueue.mockReset();
    // After the run the broker still holds the failed entry — the refresh
    // must keep it listed, not paint a clean queue over a failed push.
    mockGetChangeQueue.mockResolvedValueOnce([serverChange(), SECOND]).mockResolvedValue([SECOND]);
    mockPushChange.mockReset();
    mockPushChange.mockImplementation((id) =>
      id === 'chg-server-2' ? Promise.resolve({ error: 'push rejected — the write lease has expired' }) : Promise.resolve(pushed(id)),
    );
    renderConfigure();
    await waitFor(() => expect(queueSection().getByText('NET-4101')).toBeTruthy());

    selectAll();
    fireEvent.click(queueSection().getByRole('button', { name: 'Approve' }));

    expect(await screen.findByText('Bulk approve — 1 of 2 applied')).toBeTruthy();
    expect(screen.getByText(/failed: Port 1\/1\/12 on sw-core-1 — uplink to fw/)).toBeTruthy();
    // The failed row remains in the queue; the selection does not.
    await waitFor(() => expect(queueSection().getByText('NET-4101')).toBeTruthy());
    expect(queueSection().getByText(/Port 1\/1\/12 on sw-core-1 — uplink to fw/)).toBeTruthy();
    expect(queueSection().queryByText(/SELECTED/)).toBeNull();
  });

  it('separates an unknown push outcome from retryable failures and keeps its applying row', async () => {
    mockGetChangeQueue.mockReset();
    mockGetChangeQueue
      .mockResolvedValueOnce([serverChange(), SECOND])
      .mockResolvedValue([serverChange({ state: 'applying' })]);
    mockPushChange.mockReset();
    mockPushChange.mockImplementation((id) =>
      id === 'chg-server-1'
        ? Promise.resolve({
            ok: false,
            outcomeUnknown: true,
            changeId: id,
            ticket: 'NET-4100',
            kind: 'vlan',
            snapshot: true,
            message: 'outcome unknown — reconcile before any retry',
          })
        : Promise.resolve(pushed(id)),
    );
    renderConfigure();
    await waitFor(() => expect(queueSection().getByText('NET-4101')).toBeTruthy());

    selectAll();
    fireEvent.click(queueSection().getByRole('button', { name: 'Approve' }));

    expect(await screen.findByText('Bulk approve — 1 of 2 applied')).toBeTruthy();
    expect(screen.getByText(/outcome unknown — reconciliation required: Add DHCP helper/)).toBeTruthy();
    expect(screen.queryByText(/failed: Add DHCP helper/)).toBeNull();
    await waitFor(() => expect(queueSection().getByText('applying')).toBeTruthy());
  });

  it('(d) a not-ready row is skipped and named, never pushed', async () => {
    mockGetChangeQueue.mockReset();
    mockGetChangeQueue
      .mockResolvedValueOnce([serverChange(), serverChange({ ...SECOND, state: 'needs window', id: 'chg-server-3' })])
      .mockResolvedValue([]);
    renderConfigure();
    await waitFor(() => expect(queueSection().getByText('NET-4101')).toBeTruthy());

    selectAll();
    fireEvent.click(queueSection().getByRole('button', { name: 'Approve' }));

    expect(await screen.findByText('Bulk approve — 1 of 2 applied')).toBeTruthy();
    expect(
      screen.getByText(/skipped \(not ready or no broker id\): Port 1\/1\/12 on sw-core-1 — uplink to fw/),
    ).toBeTruthy();
    expect(mockPushChange).toHaveBeenCalledTimes(1);
    expect(mockPushChange).toHaveBeenCalledWith('chg-server-1');
  });

  it('(e) with no broker behind the rows, Approve pushes nothing and says why', async () => {
    // The demo/offline showcase: the broker's queue endpoint never answers,
    // so the section payload's rows are all there is — local, id-less.
    mockGetChangeQueue.mockReset();
    mockGetChangeQueue.mockResolvedValue(null);
    mockGetConfigure.mockResolvedValue({
      ...CONFIGURE_DATA,
      queued: [
        {
          state: 'ready',
          tone: 'success',
          what: 'VLAN 42 guest-wifi',
          where: 'Core switches only (2) · local collector',
          ticket: 'NET-9999',
        },
      ],
      dataSource: 'demo',
    });
    renderConfigure();
    await waitFor(() => expect(queueSection().getByText('NET-9999')).toBeTruthy());

    selectAll();
    expect(queueSection().getByText(/1 selected/i)).toBeTruthy();
    fireEvent.click(queueSection().getByRole('button', { name: 'Approve' }));

    expect(await screen.findByText('Bulk approve — 0 of 1 applied')).toBeTruthy();
    expect(
      screen.getByText(/not pushed — reconnect the portal backend, then queue the change again: VLAN 42 guest-wifi/),
    ).toBeTruthy();
    expect(mockPushChange).not.toHaveBeenCalled();
    // Nothing was pushed, so nothing leaves the list.
    expect(queueSection().getByText('NET-9999')).toBeTruthy();
    expect(queueSection().queryByText(/SELECTED/)).toBeNull();
  });

  it('(f) Reject discards the selection in sequence and clears it', async () => {
    await renderWithTwo();

    selectAll();
    fireEvent.click(queueSection().getByRole('button', { name: 'Reject' }));

    await waitFor(() => expect(mockDiscardChange).toHaveBeenCalledTimes(2));
    expect(mockDiscardChange.mock.calls[0]?.[0]).toBe('chg-server-1');
    expect(mockDiscardChange.mock.calls[1]?.[0]).toBe('chg-server-2');
    expect(await screen.findByText('Bulk reject — 2 of 2 discarded')).toBeTruthy();
    await waitFor(() => expect(queueSection().getByText('No changes queued')).toBeTruthy());
    expect(queueSection().queryByText(/SELECTED/)).toBeNull();
  });

  it('(g) a per-item discard failure is named and its row stays listed', async () => {
    mockGetChangeQueue.mockReset();
    mockGetChangeQueue.mockResolvedValueOnce([serverChange(), SECOND]).mockResolvedValue([SECOND]);
    mockDiscardChange.mockReset();
    mockDiscardChange.mockImplementation((id) =>
      id === 'chg-server-2' ? Promise.resolve({ error: OFFLINE_ERROR, offline: true }) : Promise.resolve({ ok: true, changeId: id }),
    );
    renderConfigure();
    await waitFor(() => expect(queueSection().getByText('NET-4101')).toBeTruthy());

    selectAll();
    fireEvent.click(queueSection().getByRole('button', { name: 'Reject' }));

    expect(await screen.findByText('Bulk reject — 1 of 2 discarded')).toBeTruthy();
    expect(screen.getByText(/failed: Port 1\/1\/12 on sw-core-1 — uplink to fw/)).toBeTruthy();
    await waitFor(() => expect(queueSection().getByText('NET-4101')).toBeTruthy());
    expect(queueSection().queryByText(/SELECTED/)).toBeNull();
  });
});
