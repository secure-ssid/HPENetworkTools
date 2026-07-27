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
        { plane: 'Central', mode: 'brokered', note: 'ticketed write', tone: 'success' },
        { plane: 'Local collector', mode: 'ssh', note: 'recorded session', tone: 'accent' },
        { plane: 'Mist', mode: 'read only', note: 'no write path', tone: 'neutral' },
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

    // The live form: blank, with a free-text Central group rather than the
    // authored group Select, and no fabricated blast-radius counts.
    expect(screen.getByPlaceholderText('Enter SSID name')).toHaveProperty('value', '');
    expect(screen.getByPlaceholderText('Enter Central group')).toBeTruthy();
    expect(screen.queryByDisplayValue('MRDN-New')).toBeNull();
    expect(screen.getByText('Impact evidence')).toBeTruthy();
    expect(screen.queryByText('Blast radius')).toBeNull();
    expect(screen.getAllByText('requires dry run').length).toBeGreaterThan(0);
  });
});
