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
  discardChange,
  dryRunConfig,
  getChangeQueue,
  getConfigure,
  pushChange,
  queueChange,
} from '../api/client';
import type { BrokeredChange, ConfigureData } from '../api/client';

vi.mock('../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/client')>();
  return {
    ...actual,
    getConfigure: vi.fn(),
    getChangeQueue: vi.fn(),
    queueChange: vi.fn(),
    pushChange: vi.fn(),
    discardChange: vi.fn(),
    dryRunConfig: vi.fn(),
  };
});

const mockGetConfigure = vi.mocked(getConfigure);
const mockGetChangeQueue = vi.mocked(getChangeQueue);
const mockQueueChange = vi.mocked(queueChange);
const mockPushChange = vi.mocked(pushChange);
const mockDiscardChange = vi.mocked(discardChange);
const mockDryRunConfig = vi.mocked(dryRunConfig);

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

const LOCAL_SSID_WHAT = 'Update wireless SSID Live-Test';
const LOCAL_SSID_TICKET = 'NET-5001';
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
 * Drive the drawer: New SSID → ticket → Queue the change, with queueChange
 * rejecting as offline. Ends with the local entry rendered in the list.
 */
async function queueLocalSsidWhileOffline() {
  fireEvent.click(screen.getByRole('button', { name: 'New SSID' }));
  fireEvent.change(screen.getByPlaceholderText('Enter SSID name'), {
    target: { value: 'Live-Test' },
  });
  fireEvent.change(screen.getByPlaceholderText('1-4094'), {
    target: { value: '830' },
  });
  fireEvent.change(screen.getByPlaceholderText('Enter Central group'), {
    target: { value: 'live-group' },
  });
  fireEvent.change(screen.getByPlaceholderText('NET-4166'), {
    target: { value: LOCAL_SSID_TICKET },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Queue the change' }));
  await waitFor(() => expect(queueSection().getByText(LOCAL_SSID_WHAT)).toBeTruthy());
}

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
});

afterEach(cleanup);

describe('Configure — per-entry-source queue semantics', () => {
  it('opens a blank live SSID form without authored tenant names or fabricated impact counts', async () => {
    renderConfigure();
    await waitFor(() => expect(queueSection().getByText('NET-4100')).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'New SSID' }));

    expect(screen.getByPlaceholderText('Enter SSID name')).toHaveProperty('value', '');
    expect(screen.queryByDisplayValue('MRDN-New')).toBeNull();
    expect(screen.queryByText(/268/)).toBeNull();
    expect(screen.queryByText(/2,472/)).toBeNull();
    expect(screen.getAllByText('requires dry run').length).toBeGreaterThan(0);
  });

  it('appends the change locally (id null) when queueChange rejects offline, alongside the authoritative server queue', async () => {
    renderConfigure();
    // Server queue rendered first — the broker is authoritative.
    await waitFor(() => expect(queueSection().getByText('NET-4100')).toBeTruthy());

    await queueLocalSsidWhileOffline();

    expect(mockQueueChange).toHaveBeenCalledWith(
      'ssid',
      expect.objectContaining({ name: 'Live-Test', group: 'live-group', plane: 'CENTRAL' }),
      LOCAL_SSID_TICKET,
    );
    // The local entry renders with its what / where / ticket summary.
    expect(queueSection().getByText(LOCAL_SSID_WHAT)).toBeTruthy();
    expect(queueSection().getByText('CENTRAL · target group live-group')).toBeTruthy();
    expect(queueSection().getByText(LOCAL_SSID_TICKET)).toBeTruthy();
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
    await queueLocalSsidWhileOffline();

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
      expect(queueSection().queryByText(LOCAL_SSID_WHAT)).toBeNull(),
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
    await queueLocalSsidWhileOffline();

    mockGetChangeQueue.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Push queue' }));

    // The honest offline outcome: warning toast and entry remains pending.
    await waitFor(() => expect(screen.getByText(LOCAL_NOT_PUSHED_TOAST)).toBeTruthy());
    expect(queueSection().getByText(LOCAL_SSID_WHAT)).toBeTruthy();
    // No server push happened for the id-less local entry.
    expect(mockPushChange).not.toHaveBeenCalled();
    // The not-ready server entry is untouched and still listed.
    expect(queueSection().getByText('NET-4149')).toBeTruthy();
    expect(queueSection().getByText('needs window')).toBeTruthy();
  });
});
