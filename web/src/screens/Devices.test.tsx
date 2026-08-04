import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import Devices from './Devices';
import { SettingsProvider } from '../app/SettingsContext';
import { ToastProvider } from '../nightdesk';
import { getDevices, getMetricsHistory } from '../api/client';
import { DEVICE_RECONCILIATION, DEVICES, LANE_META } from '@hpe/shared';
import type { DeviceRow, MetricsHistoryEnvelope } from '@hpe/shared';

vi.mock('../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/client')>();
  // getMetricsHistory defaults to null (API unreachable/older server): the
  // sparkline column hides rather than paints history the server never sent.
  return { ...actual, getDevices: vi.fn(), getMetricsHistory: vi.fn(() => Promise.resolve(null)) };
});

const mockGetDevices = vi.mocked(getDevices);
const mockGetMetrics = vi.mocked(getMetricsHistory);

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/** A reconciled live row — sparse, exactly as an adapter reports it. */
function liveRow(over: Partial<DeviceRow> = {}): DeviceRow {
  return {
    name: 'sw-live-1',
    model: 'unknown',
    type: 'switch',
    siteId: 'workspace',
    siteName: '—',
    plane: 'CENTRAL',
    planeTone: 'accent',
    state: 'unknown',
    stateTone: 'neutral',
    firmware: 'unknown',
    firmwareApproved: false,
    licence: '—',
    reconciliationIssue: false,
    localShell: false,
    ...over,
  };
}

function renderDevices() {
  return render(
    <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <SettingsProvider>
        <ToastProvider>
          <Devices />
        </ToastProvider>
      </SettingsProvider>
    </MemoryRouter>,
  );
}

/** Reads the location a device-row click actually navigated to, so a test can
 *  assert the exact plane+serial query string a row link carries — not just
 *  that navigation happened. */
function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{`${location.pathname}${location.search}`}</div>;
}

function renderDevicesWithRouting() {
  return render(
    <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }} initialEntries={['/devices']}>
      <SettingsProvider>
        <ToastProvider>
          <Routes>
            <Route path="/devices" element={<Devices />} />
            <Route path="/devices/:name" element={<LocationProbe />} />
          </Routes>
        </ToastProvider>
      </SettingsProvider>
    </MemoryRouter>,
  );
}

/* A Compliance finding's count links here with the set it counted. Before
   that link carried the set it went to /devices/<first name>, so clicking a
   count of 12 opened one device and silently dropped eleven. */
describe('Devices ?names= deep link', () => {
  function renderAt(entry: string) {
    return render(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }} initialEntries={[entry]}>
        <SettingsProvider>
          <ToastProvider>
            <Routes>
              <Route path="/devices" element={<Devices />} />
            </Routes>
          </ToastProvider>
        </SettingsProvider>
      </MemoryRouter>,
    );
  }

  const THREE = {
    dataSource: 'live' as const,
    devices: [liveRow({ name: 'ap-1' }), liveRow({ name: 'ap-2' }), liveRow({ name: 'sw-3' })],
    lanes: {},
    reconciliation: { doubleClaimed: 0, unclaimed: 0 },
  };

  it('narrows the inventory to exactly the named devices', async () => {
    mockGetDevices.mockResolvedValue(THREE);
    renderAt(`/devices?names=${encodeURIComponent('ap-1\nsw-3')}`);

    expect(await screen.findByText('2 of 3 indexed')).toBeTruthy();
    expect(screen.getByText('2 named devices — clear')).toBeTruthy();
    expect(screen.queryByText('ap-2')).toBeNull();
  });

  /* The screen must never just show fewer rows than were asked for. A finding
     names a set; by the time it is clicked the inventory may not hold all of
     it, and "10 of 12" is the difference between a stale link and an estate
     that shrank. */
  it('says so when the inventory no longer holds every named device', async () => {
    mockGetDevices.mockResolvedValue(THREE);
    renderAt(`/devices?names=${encodeURIComponent('ap-1\ngone-1\ngone-2')}`);

    expect(await screen.findByText('1 of 3 indexed')).toBeTruthy();
    expect(screen.getByText('1 of 3 named devices — 2 not in this inventory — clear')).toBeTruthy();
  });

  it('clears back to the whole inventory', async () => {
    mockGetDevices.mockResolvedValue(THREE);
    renderAt(`/devices?names=${encodeURIComponent('ap-1')}`);

    fireEvent.click(await screen.findByText('1 named devices — clear'));
    expect(await screen.findByText('3 of 3 indexed')).toBeTruthy();
    expect(screen.queryByText(/named devices/)).toBeNull();
  });

  /* An absent param is not a filter of zero names — that would empty the
     screen and let the estate take the blame for it. */
  it('ignores an empty names param instead of hiding everything', async () => {
    mockGetDevices.mockResolvedValue(THREE);
    renderAt('/devices?names=');

    expect(await screen.findByText('3 of 3 indexed')).toBeTruthy();
    expect(screen.queryByText(/named devices/)).toBeNull();
  });
});

/* An availability count's slice — /devices?state=down — narrows the inventory
 * to the rows in that state. The filter has no Select of its own (states are
 * the feed's free vocabulary, not a fixed option list), so the chip is what
 * keeps it visible and clearable, exactly as the ?names= chip does. */
describe('Devices ?state= deep link', () => {
  function renderAt(entry: string) {
    return render(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }} initialEntries={[entry]}>
        <SettingsProvider>
          <ToastProvider>
            <Routes>
              <Route path="/devices" element={<Devices />} />
            </Routes>
          </ToastProvider>
        </SettingsProvider>
      </MemoryRouter>,
    );
  }

  const MIXED = {
    dataSource: 'live' as const,
    devices: [
      liveRow({ name: 'ap-1', state: 'up', stateTone: 'success' as const }),
      liveRow({ name: 'sw-2', state: 'down', stateTone: 'danger' as const }),
      liveRow({ name: 'gw-3', state: 'down', stateTone: 'danger' as const }),
    ],
    lanes: {},
    reconciliation: { doubleClaimed: 0, unclaimed: 0 },
  };

  it('narrows the inventory to the rows in that state', async () => {
    mockGetDevices.mockResolvedValue(MIXED);
    renderAt('/devices?state=down');

    expect(await screen.findByText('2 of 3 indexed')).toBeTruthy();
    expect(screen.getByText('state: down — clear')).toBeTruthy();
    expect(screen.queryByText('ap-1')).toBeNull();
  });

  it('matches a multi-word state verbatim rather than an umbrella bucket', async () => {
    mockGetDevices.mockResolvedValue({
      ...MIXED,
      devices: [
        liveRow({ name: 'mc-1', state: 'no heartbeat', stateTone: 'danger' as const }),
        liveRow({ name: 'sw-2', state: 'down', stateTone: 'danger' as const }),
      ],
    });
    renderAt(`/devices?state=${encodeURIComponent('no heartbeat')}`);

    expect(await screen.findByText('1 of 2 indexed')).toBeTruthy();
    expect(screen.getByText('mc-1')).toBeTruthy();
    expect(screen.queryByText('sw-2')).toBeNull();
  });

  it('clears back to the whole inventory', async () => {
    mockGetDevices.mockResolvedValue(MIXED);
    renderAt('/devices?state=down');

    fireEvent.click(await screen.findByText('state: down — clear'));
    expect(await screen.findByText('3 of 3 indexed')).toBeTruthy();
    expect(screen.queryByText(/state: down/)).toBeNull();
  });

  /* A state nothing is currently in must not render as an empty estate: the
     chip stays up and the empty state names the filter, not the inventory. */
  it('keeps a state with no matching rows visible and clearable', async () => {
    mockGetDevices.mockResolvedValue(MIXED);
    renderAt('/devices?state=flapping');

    expect(await screen.findByText('0 of 3 indexed')).toBeTruthy();
    expect(screen.getByText('state: flapping — clear')).toBeTruthy();
    expect(screen.getByText('Nothing matches that filter')).toBeTruthy();
  });

  it('ignores an empty state param instead of hiding everything', async () => {
    mockGetDevices.mockResolvedValue(MIXED);
    renderAt('/devices?state=');

    expect(await screen.findByText('3 of 3 indexed')).toBeTruthy();
    expect(screen.queryByText(/state:/)).toBeNull();
  });
});

describe('Devices sparse live inventory', () => {
  it('uses live reconciliation metadata and never renders authored demo totals or examples', async () => {
    mockGetDevices.mockResolvedValue({
      dataSource: 'live',
      devices: [
        {
          name: 'sw-live-1',
          model: 'unknown',
          type: 'switch',
          siteId: 'workspace',
          siteName: '—',
          plane: 'CENTRAL',
          planeTone: 'accent',
          state: 'unknown',
          stateTone: 'neutral',
          firmware: 'unknown',
          firmwareApproved: false,
          licence: '—',
          reconciliationIssue: true,
          localShell: false,
        },
      ],
      lanes: {},
      reconciliation: { doubleClaimed: 1, unclaimed: 0 },
    });

    render(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <SettingsProvider>
          <ToastProvider>
            <Devices />
          </ToastProvider>
        </SettingsProvider>
      </MemoryRouter>,
    );

    expect(await screen.findByText('1 of 1 indexed')).toBeTruthy();
    // No authored estate figure survives anywhere on a live render — the
    // subtitle used to assert "418 devices, six inventories" unconditionally.
    expect(screen.queryByText(/418/)).toBeNull();
    expect(screen.getByText('1 device, 1 inventory, one reconciled list.')).toBeTruthy();
    expect(screen.queryByText(/sw-riv-2/)).toBeNull();
    expect(screen.getByText('Reconciliation: 1 device claimed by two inventories, 0 by none')).toBeTruthy();
    expect(screen.getAllByText('Not reported').length).toBeGreaterThanOrEqual(3);
  });
});

/* A linked plane whose device read never came back contributes nothing to the
 * reconciled list. The list is short by whatever that plane manages, and a
 * shorter list says nothing about why — so an unreachable Central renders
 * exactly like a Central that manages nothing. The lanes view has always made
 * this legible; the unified table, which is the default, did not. */
describe('Devices missing inventories', () => {
  const withMissing = (missingInventories: string[]) => ({
    dataSource: 'live' as const,
    devices: [liveRow({ name: 'sw-live-1', plane: 'CENTRAL' })],
    lanes: {},
    reconciliation: { doubleClaimed: 0, unclaimed: 0 },
    missingInventories,
  });

  const renderDevices = () =>
    render(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <SettingsProvider>
          <ToastProvider>
            <Devices />
          </ToastProvider>
        </SettingsProvider>
      </MemoryRouter>,
    );

  it('warns that the list is incomplete and names every plane missing from it', async () => {
    mockGetDevices.mockResolvedValue(withMissing(['CENTRAL', 'MIST']) as never);
    renderDevices();

    expect(
      await screen.findByText('2 linked inventories are not represented below: CENTRAL, MIST'),
    ).toBeTruthy();
    // The distinction that matters: unread, not empty.
    expect(screen.getByText(/it is an unread one/)).toBeTruthy();
  });

  it('says how many inventories are reporting rather than implying they all are', async () => {
    mockGetDevices.mockResolvedValue(withMissing(['MIST']) as never);
    renderDevices();

    // One lane comes from the row's own plane; MIST is missing, so the header
    // must not present the estate as fully reported.
    expect(await screen.findByText(/inventor(y|ies) reporting, one reconciled list\./)).toBeTruthy();
  });

  it('stays silent — and keeps the plain count — when every linked inventory reported', async () => {
    mockGetDevices.mockResolvedValue(withMissing([]) as never);
    renderDevices();

    expect(await screen.findByText('1 device, 1 inventory, one reconciled list.')).toBeTruthy();
    expect(screen.queryByText(/not represented below/)).toBeNull();
  });

  it('says nothing at all when the route did not report on missing inventories', async () => {
    // Absent is not the same as an empty array: an older server that never
    // looked must not be rendered as one that looked and found nothing wrong.
    mockGetDevices.mockResolvedValue({
      dataSource: 'live',
      devices: [liveRow({ name: 'sw-live-1', plane: 'CENTRAL' })],
      lanes: {},
      reconciliation: { doubleClaimed: 0, unclaimed: 0 },
    } as never);
    renderDevices();

    expect(await screen.findByText('1 device, 1 inventory, one reconciled list.')).toBeTruthy();
    expect(screen.queryByText(/not represented below/)).toBeNull();
  });
});

describe('Devices reconciliation flags', () => {
  it('names every claiming plane and marks the row double-claimed', async () => {
    mockGetDevices.mockResolvedValue({
      dataSource: 'live',
      devices: [
        liveRow({
          name: 'sw-both-1',
          claimedBy: ['CENTRAL', 'CLASSIC'],
          reconciliationIssue: true,
          state: 'up',
          stateTone: 'success',
        }),
      ],
      lanes: {},
      reconciliation: { doubleClaimed: 1, unclaimed: 0 },
    });

    renderDevices();

    expect(await screen.findByText('sw-both-1')).toBeTruthy();
    // The second claimant is not a filter option, so a single hit proves the
    // Managed-by cell rendered it as a badge.
    expect(screen.getByText('CLASSIC')).toBeTruthy();
    expect(screen.getByText('double-claimed')).toBeTruthy();
  });

  it('marks a collector-only row as having no cloud plane', async () => {
    mockGetDevices.mockResolvedValue({
      dataSource: 'live',
      devices: [
        liveRow({
          name: 'sw-wh-9',
          plane: 'LOCAL',
          planeTone: 'neutral',
          claimedBy: ['LOCAL'],
          reconciliationIssue: true,
        }),
      ],
      lanes: {},
      reconciliation: { doubleClaimed: 0, unclaimed: 1 },
    });

    renderDevices();

    expect(await screen.findByText('sw-wh-9')).toBeTruthy();
    expect(screen.getByText('no cloud plane')).toBeTruthy();
    expect(screen.queryByText('double-claimed')).toBeNull();
  });

  it('states the authored estate reconciliation truth in demo mode', async () => {
    // Exactly what the demo /api/devices branch (and the client's offline demo
    // fallback) now serves: the estate figures ride on the envelope, so the
    // screen reads the payload rather than re-importing the fixture itself.
    mockGetDevices.mockResolvedValue({
      dataSource: 'demo',
      devices: DEVICES,
      lanes: LANE_META,
      reconciliation: DEVICE_RECONCILIATION,
    });

    renderDevices();

    // 28 fixture rows are a sample of a 418-device estate: the counts are the
    // authored truth, not a tally of the loaded rows (which would say "2").
    expect(
      await screen.findByText(
        'Reconciliation: 3 devices claimed by two inventories, 14 by none',
      ),
    ).toBeTruthy();
    // Demo keeps the authored prose verbatim.
    expect(
      screen.getByText('418 devices, six inventories, one reconciled list.'),
    ).toBeTruthy();
  });

  it('never asserts the authored estate counts over a payload that carries none', async () => {
    // The 418-device figures are estate truth the ENVELOPE carries. A payload
    // with no reconciliation block has said nothing about the estate, so the
    // banner counts the rows it actually holds rather than the screen reaching
    // behind the payload for a fixture it was not sent.
    mockGetDevices.mockResolvedValue({
      dataSource: 'demo',
      devices: [
        liveRow({ name: 'sw-both-1', claimedBy: ['CENTRAL', 'LOCAL'], reconciliationIssue: true }),
      ],
      lanes: LANE_META,
    });

    renderDevices();

    expect(
      await screen.findByText('Reconciliation: 1 device claimed by two inventories, 0 by none'),
    ).toBeTruthy();
    expect(screen.queryByText(/14 by none/)).toBeNull();
  });
});

describe('Devices search', () => {
  it('matches the serial, MAC and management IP the placeholder advertises', async () => {
    mockGetDevices.mockResolvedValue({
      dataSource: 'live',
      devices: [
        liveRow({ name: 'sw-a', serial: 'SG09KLM4X2', mac: 'aa:bb:cc:dd:ee:ff', ip: '10.42.8.11' }),
        liveRow({ name: 'sw-b' }),
      ],
      lanes: {},
      reconciliation: { doubleClaimed: 0, unclaimed: 0 },
    });

    renderDevices();

    const box = await screen.findByPlaceholderText('name, model, serial, ip…');

    fireEvent.change(box, { target: { value: 'SG09KLM4X2' } });
    expect(await screen.findByText('1 of 2 indexed')).toBeTruthy();
    expect(screen.getByText('sw-a')).toBeTruthy();

    fireEvent.change(box, { target: { value: '10.42.8.11' } });
    expect(await screen.findByText('1 of 2 indexed')).toBeTruthy();

    // A MAC pasted from another tool rarely uses the same separators.
    fireEvent.change(box, { target: { value: 'AABB.CCDD.EEFF' } });
    expect(await screen.findByText('1 of 2 indexed')).toBeTruthy();
    expect(screen.getByText('sw-a')).toBeTruthy();
  });
});

describe('Devices platform lanes', () => {
  it('never claims a lane is linked when the payload carries no lane meta', async () => {
    mockGetDevices.mockResolvedValue({
      dataSource: 'live',
      devices: [liveRow()],
      lanes: {},
      reconciliation: { doubleClaimed: 0, unclaimed: 0 },
    });

    renderDevices();

    expect(await screen.findByText('1 of 1 indexed')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'Platform lanes' }));

    expect(await screen.findByText('no sync stamp')).toBeTruthy();
    expect(screen.getByText('freshness not reported')).toBeTruthy();
    expect(screen.queryByText('linked')).toBeNull();
  });

  it('keeps a lane for a linked plane that reported no inventory at all', async () => {
    mockGetDevices.mockResolvedValue({
      dataSource: 'live',
      devices: [liveRow()],
      lanes: {
        CENTRAL: { tone: 'success', sync: 'synced 40s', note: '', mark: 'var(--nd-accent)' },
        LOCAL: { tone: 'warning', sync: 'never synced', note: '', mark: 'var(--nd-border-strong)' },
      },
      reconciliation: { doubleClaimed: 0, unclaimed: 0 },
    });

    renderDevices();

    expect(await screen.findByText('1 of 1 indexed')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'Platform lanes' }));

    // The empty plane is exactly the gap the lanes view exists to show — it
    // must not disappear, and it must not read as "filtered out".
    expect(await screen.findByText('never synced')).toBeTruthy();
    expect(screen.getByText('No inventory reported by this plane.')).toBeTruthy();
    expect(screen.queryByText('Nothing in this lane matches the filter.')).toBeNull();
  });

  it('distinguishes a filtered-out lane from a plane that reported nothing', async () => {
    mockGetDevices.mockResolvedValue({
      dataSource: 'live',
      devices: [liveRow({ name: 'sw-live-1' })],
      lanes: {
        CENTRAL: { tone: 'success', sync: 'synced 40s', note: '', mark: 'var(--nd-accent)' },
      },
      reconciliation: { doubleClaimed: 0, unclaimed: 0 },
    });

    renderDevices();

    const box = await screen.findByPlaceholderText('name, model, serial, ip…');
    fireEvent.change(box, { target: { value: 'no-such-device' } });
    fireEvent.click(screen.getByRole('tab', { name: 'Platform lanes' }));

    expect(await screen.findByText('Nothing in this lane matches the filter.')).toBeTruthy();
    expect(screen.queryByText('No inventory reported by this plane.')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Routing — every row link must carry exact plane+serial identity
// (fix-device-detail-identity): reconciliation can leave two rows sharing a
// display name (same name, different serial — services/reconcile.ts
// identityKey), so a bare `/devices/:name` link cannot tell them apart. Each
// row's link must resolve its OWN serial, never the other row's.
// ---------------------------------------------------------------------------
describe('Devices row links carry exact plane+serial identity', () => {
  it('two rows sharing a display name each link to their own plane+serial', async () => {
    mockGetDevices.mockResolvedValue({
      dataSource: 'live',
      devices: [
        liveRow({ name: 'ap-dup', plane: 'CENTRAL', planeTone: 'accent', serial: 'DUP-CENTRAL-001' }),
        liveRow({ name: 'ap-dup', plane: 'MIST', planeTone: 'info', serial: 'DUP-MIST-002' }),
      ],
      lanes: {},
      reconciliation: { doubleClaimed: 0, unclaimed: 0 },
    });

    renderDevicesWithRouting();

    const rows = await screen.findAllByText('ap-dup');
    expect(rows).toHaveLength(2);

    fireEvent.click(rows[0]);
    expect((await screen.findByTestId('location')).textContent).toBe(
      '/devices/ap-dup?plane=CENTRAL&serial=DUP-CENTRAL-001',
    );
  });

  it("the SECOND duplicate row's link resolves its own serial, not the first row's", async () => {
    mockGetDevices.mockResolvedValue({
      dataSource: 'live',
      devices: [
        liveRow({ name: 'ap-dup', plane: 'CENTRAL', planeTone: 'accent', serial: 'DUP-CENTRAL-001' }),
        liveRow({ name: 'ap-dup', plane: 'MIST', planeTone: 'info', serial: 'DUP-MIST-002' }),
      ],
      lanes: {},
      reconciliation: { doubleClaimed: 0, unclaimed: 0 },
    });

    renderDevicesWithRouting();

    const rows = await screen.findAllByText('ap-dup');
    fireEvent.click(rows[1]);
    expect((await screen.findByTestId('location')).textContent).toBe(
      '/devices/ap-dup?plane=MIST&serial=DUP-MIST-002',
    );
  });

  it('a unique row with no serial still links by name alone (legacy fallback stays honoured)', async () => {
    mockGetDevices.mockResolvedValue({
      dataSource: 'live',
      devices: [liveRow({ name: 'sw-fixture-only', plane: 'CENTRAL' })],
      lanes: {},
      reconciliation: { doubleClaimed: 0, unclaimed: 0 },
    });

    renderDevicesWithRouting();

    fireEvent.click(await screen.findByText('sw-fixture-only'));
    expect((await screen.findByTestId('location')).textContent).toBe(
      '/devices/sw-fixture-only?plane=CENTRAL',
    );
  });

  it('the platform-lanes row link also carries plane+serial, matching the unified table', async () => {
    mockGetDevices.mockResolvedValue({
      dataSource: 'live',
      devices: [liveRow({ name: 'ap-dup', plane: 'CENTRAL', planeTone: 'accent', serial: 'DUP-CENTRAL-001' })],
      lanes: {
        CENTRAL: { tone: 'success', sync: 'synced 40s', note: '', mark: 'var(--nd-accent)' },
      },
      reconciliation: { doubleClaimed: 0, unclaimed: 0 },
    });

    renderDevicesWithRouting();

    await screen.findByText('1 of 1 indexed');
    fireEvent.click(screen.getByRole('tab', { name: 'Platform lanes' }));
    fireEvent.click(await screen.findByText('ap-dup'));
    expect((await screen.findByTestId('location')).textContent).toBe(
      '/devices/ap-dup?plane=CENTRAL&serial=DUP-CENTRAL-001',
    );
  });
});

/* The attached-client sparkline column rides the metrics-history envelope:
 * real or synthesized-demo series only, window and cadence stated in the
 * header, and honest text (never a flat fake line) where a device has no
 * series. A null envelope — older server, unreachable API — hides the column
 * entirely rather than painting history the server never claimed. */
describe('Devices client sparkline column', () => {
  const METRICS: MetricsHistoryEnvelope = {
    dataSource: 'demo',
    since: '2026-07-24T12:00:00.000Z',
    sampleMs: 300_000,
    retentionMs: 86_400_000,
    planes: {},
    deviceClients: {
      'ap-1f-04': [
        { t: '2026-07-25T11:50:00.000Z', v: 3 },
        { t: '2026-07-25T11:55:00.000Z', v: 5 },
        { t: '2026-07-25T12:00:00.000Z', v: 4 },
      ],
      // One sample so far: honest text, not a one-point "line".
      'sw-core-a': [{ t: '2026-07-25T12:00:00.000Z', v: 1 }],
    },
    note: 'synthesized demo history — no plane was sampled',
  };

  function demoDevices() {
    return {
      dataSource: 'demo' as const,
      devices: DEVICES,
      lanes: LANE_META,
      reconciliation: DEVICE_RECONCILIATION,
    };
  }

  it('labels the column with the window and cadence, and draws the series a device has', async () => {
    mockGetDevices.mockResolvedValue(demoDevices());
    mockGetMetrics.mockResolvedValue(METRICS);
    renderDevices();

    expect(await screen.findByText('last 24h · sampled every 5m · synthesized demo')).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: /Clients/ })).toBeTruthy();
    // The aria label carries the value — the SVG itself is decorative.
    expect(
      screen.getByRole('img', { name: '4 attached clients · last 24h · sampled every 5m · synthesized demo' }),
    ).toBeTruthy();
  });

  it('renders one sample as text and no series as an honest dash, never a flat line', async () => {
    mockGetDevices.mockResolvedValue(demoDevices());
    mockGetMetrics.mockResolvedValue(METRICS);
    const { container } = renderDevices();

    await screen.findByText('1 sample');
    // sw-core-b has no series at all: a dash whose title says why.
    const dash = container.querySelector('[title="no attached-client samples for this device"]');
    expect(dash).not.toBeNull();
    expect(dash!.textContent).toBe('—');
  });

  it('hides the whole column when the server sends no metrics envelope', async () => {
    mockGetDevices.mockResolvedValue(demoDevices());
    mockGetMetrics.mockResolvedValue(null);
    renderDevices();

    await screen.findByText(new RegExp(`${DEVICES.length} of ${DEVICES.length} indexed`));
    expect(screen.queryByRole('columnheader', { name: /Clients/ })).toBeNull();
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('follows the density token — compact rows get a shorter sparkline', async () => {
    // The SettingsContext seeds density from localStorage at construction
    // (stubbed the SettingsContext.test.tsx way — plain localStorage is not
    // reliable in this environment).
    const values = new Map<string, string>([['nt-settings', JSON.stringify({ density: 'compact' })]]);
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
      clear: () => values.clear(),
    });
    try {
      mockGetDevices.mockResolvedValue(demoDevices());
      mockGetMetrics.mockResolvedValue(METRICS);
      renderDevices();

      const spark = await screen.findByRole('img', {
        name: '4 attached clients · last 24h · sampled every 5m · synthesized demo',
      });
      expect(spark.querySelector('svg')!.getAttribute('height')).toBe('14');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

// ---------------------------------------------------------------------------
// The unified table is the nightdesk DataTable reference integration: the
// column manager persists through SettingsContext (localStorage key
// 'nt-table-columns' under the 'devices' table id), the rows are a keyboard
// grid (j/k move, Enter opens the device, x selects, Esc clears) and '?'
// lists the commands. These tests pin the wiring, not the mechanics — the
// mechanics live in nightdesk/DataTable.test.tsx.
// ---------------------------------------------------------------------------
describe('Devices table superpowers', () => {
  const THREE = {
    dataSource: 'live' as const,
    devices: [liveRow({ name: 'ap-1' }), liveRow({ name: 'ap-2' }), liveRow({ name: 'sw-3' })],
    lanes: {},
    reconciliation: { doubleClaimed: 0, unclaimed: 0 },
  };

  beforeEach(() => {
    // Plain localStorage is not reliable in this environment — stub it the
    // SettingsContext.test.tsx way, fresh per test so no config leaks.
    const values = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
      clear: () => values.clear(),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function bodyRows(container: HTMLElement): HTMLTableRowElement[] {
    return Array.from(container.querySelectorAll('tbody tr'));
  }

  it('hides and restores a column from View options, persisted to localStorage', async () => {
    mockGetDevices.mockResolvedValue(THREE);
    const { container } = renderDevices();
    await screen.findByText('3 of 3 indexed');
    expect(container.querySelector('th[data-column-key="model"]')).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'View options' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Model' }));
    expect(container.querySelector('th[data-column-key="model"]')).toBeNull();
    expect(JSON.parse(localStorage.getItem('nt-table-columns') ?? '{}')).toEqual({
      devices: { hidden: ['model'] },
    });

    fireEvent.click(screen.getByRole('checkbox', { name: 'Model' }));
    expect(container.querySelector('th[data-column-key="model"]')).not.toBeNull();
    expect(JSON.parse(localStorage.getItem('nt-table-columns') ?? '{}')).toEqual({
      devices: { hidden: [] },
    });
  });

  it('seeds the table from the persisted column config on mount', async () => {
    localStorage.setItem(
      'nt-table-columns',
      JSON.stringify({ devices: { hidden: ['model'], order: ['state', 'device', 'model', 'type', 'site', 'managedBy', 'firmware', 'licence'] } }),
    );
    mockGetDevices.mockResolvedValue(THREE);
    const { container } = renderDevices();
    await screen.findByText('3 of 3 indexed');
    expect(container.querySelector('th[data-column-key="model"]')).toBeNull();
    const keys = Array.from(container.querySelectorAll('th')).map((th) => th.getAttribute('data-column-key'));
    expect(keys[0]).toBe('state');
    expect(keys[1]).toBe('device');
  });

  it('moves the focused row with j/k and opens the device on Enter', async () => {
    mockGetDevices.mockResolvedValue(THREE);
    const { container } = renderDevicesWithRouting();
    await screen.findByText('3 of 3 indexed');
    const [first, second] = bodyRows(container);

    expect(first.getAttribute('tabindex')).toBe('0');
    fireEvent.keyDown(first, { key: 'j' });
    expect(document.activeElement).toBe(second);
    fireEvent.keyDown(second, { key: 'k' });
    expect(document.activeElement).toBe(first);

    fireEvent.keyDown(first, { key: 'Enter' });
    expect((await screen.findByTestId('location')).textContent).toBe('/devices/ap-1?plane=CENTRAL');
  });

  it('toggles row selection with x and clears it with Escape', async () => {
    mockGetDevices.mockResolvedValue(THREE);
    const { container } = renderDevices();
    await screen.findByText('3 of 3 indexed');
    const [first] = bodyRows(container);

    fireEvent.keyDown(first, { key: 'x' });
    expect(first.getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(first, { key: 'x' });
    expect(first.getAttribute('aria-selected')).toBe('false');

    fireEvent.keyDown(first, { key: 'x' });
    fireEvent.keyDown(first, { key: 'Escape' });
    expect(first.getAttribute('aria-selected')).toBe('false');
  });

  /* Loop 78 — selection raises Export selected + Copy selection link bulk bar.
   * Loop 130 — Copy serials joins published inventory serials for paste. */
  it('shows bulk bar for selection: Export selected, Copy selection link, Copy serials, Clear', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    // jsdom has no blob URLs — stub the download path used by Export selected.
    const createObjectURL = vi.fn(() => 'blob:devices-selected');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', { ...URL, createObjectURL, revokeObjectURL });
    mockGetDevices.mockResolvedValue({
      ...THREE,
      devices: [
        liveRow({ name: 'ap-1', serial: 'SN-AP-1' }),
        liveRow({ name: 'ap-2', serial: 'SN-AP-2' }),
        liveRow({ name: 'sw-3' }),
      ],
    });
    const { container } = renderDevices();
    await screen.findByText('3 of 3 indexed');
    const [first, second] = bodyRows(container);

    expect(screen.queryByRole('region', { name: 'Device selection actions' })).toBeNull();
    fireEvent.keyDown(first, { key: 'x' });
    fireEvent.keyDown(second, { key: 'x' });

    const bar = screen.getByRole('region', { name: 'Device selection actions' });
    expect(within(bar).getByText(/2 selected/i)).toBeTruthy();
    fireEvent.click(within(bar).getByRole('button', { name: 'Export selected' }));
    expect(await screen.findByText(/Exported 2 selected devices/i)).toBeTruthy();
    expect(createObjectURL).toHaveBeenCalled();

    fireEvent.click(within(bar).getByRole('button', { name: 'Copy selection link' }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    const url = String(writeText.mock.calls[0]![0]);
    expect(url).toMatch(/names=/);
    expect(decodeURIComponent(url)).toMatch(/ap-1/);

    writeText.mockClear();
    fireEvent.click(within(bar).getByRole('button', { name: 'Copy serials' }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(String(writeText.mock.calls[0]![0])).toBe('SN-AP-1\nSN-AP-2');
    expect(await screen.findByText(/Copied 2 serials/i)).toBeTruthy();

    fireEvent.click(within(bar).getByRole('button', { name: 'Clear' }));
    expect(screen.queryByRole('region', { name: 'Device selection actions' })).toBeNull();
  });

  it("lists the row commands on '?'", async () => {
    mockGetDevices.mockResolvedValue(THREE);
    renderDevices();
    await screen.findByText('3 of 3 indexed');

    fireEvent.keyDown(document.body, { key: '?' });
    expect(await screen.findByRole('dialog')).toBeTruthy();
    expect(screen.getByText('Move to the next row')).toBeTruthy();
    expect(screen.getByText("Run the focused row's primary action")).toBeTruthy();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

/* The faceted filters (plane / state / site) replaced the old plane and site
 * Selects: OR within a facet, AND across facets, counts computed over the
 * rows the OTHER facets and every non-facet filter let through. The ?plane=
 * deep link seeds the plane facet. */
describe('Devices facets', () => {
  beforeEach(() => {
    const values = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
      clear: () => values.clear(),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const FOUR = {
    dataSource: 'live' as const,
    devices: [
      liveRow({ name: 'ap-1', plane: 'CENTRAL', state: 'up', stateTone: 'success', siteId: 'campus-01', siteName: 'Campus-01 HQ' }),
      liveRow({ name: 'sw-2', plane: 'CENTRAL', state: 'down', stateTone: 'danger', siteId: 'campus-01', siteName: 'Campus-01 HQ' }),
      liveRow({ name: 'ap-3', plane: 'MIST', planeTone: 'info', state: 'down', stateTone: 'danger', siteId: 'campus-02', siteName: 'Campus-02 Lab' }),
      liveRow({ name: 'gw-4', plane: 'MIST', planeTone: 'info', siteId: 'campus-02', siteName: 'Campus-02 Lab' }),
    ],
    lanes: {},
    reconciliation: { doubleClaimed: 0, unclaimed: 0 },
  };

  function renderAt(entry: string) {
    return render(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }} initialEntries={[entry]}>
        <SettingsProvider>
          <ToastProvider>
            <Routes>
              <Route path="/devices" element={<Devices />} />
            </Routes>
          </ToastProvider>
        </SettingsProvider>
      </MemoryRouter>,
    );
  }

  it('narrows the inventory by facet with honest live counts', async () => {
    mockGetDevices.mockResolvedValue(FOUR);
    renderDevices();
    await screen.findByText('4 of 4 indexed');

    fireEvent.click(screen.getByRole('button', { name: 'Plane' }));
    const planePanel = screen.getByRole('group', { name: 'Plane filter' });
    expect(within(planePanel).getByRole('checkbox', { name: 'CENTRAL' }).closest('li')!.textContent).toContain('2');
    expect(within(planePanel).getByRole('checkbox', { name: 'MIST' }).closest('li')!.textContent).toContain('2');

    // AND across facets: plane CENTRAL leaves the two CENTRAL rows…
    fireEvent.click(within(planePanel).getByRole('checkbox', { name: 'CENTRAL' }));
    expect(screen.getByText('2 of 4 indexed')).toBeTruthy();
    expect(screen.getByText('ap-1')).toBeTruthy();
    expect(screen.queryByText('ap-3')).toBeNull();
    fireEvent.keyDown(document, { key: 'Escape' });

    // …and the state facet's counts reflect the plane selection (MIST's down
    // row is not counted), while MIST itself stays listed at 0 in its own facet.
    fireEvent.click(screen.getByRole('button', { name: 'State' }));
    const statePanel = screen.getByRole('group', { name: 'State filter' });
    expect(within(statePanel).getByRole('checkbox', { name: 'up' }).closest('li')!.textContent).toContain('1');
    expect(within(statePanel).getByRole('checkbox', { name: 'down' }).closest('li')!.textContent).toContain('1');
    expect(within(statePanel).getByRole('checkbox', { name: 'unknown' }).closest('li')!.textContent).toContain('0');
    fireEvent.click(within(statePanel).getByRole('checkbox', { name: 'down' }));
    expect(screen.getByText('1 of 4 indexed')).toBeTruthy();
    expect(screen.getByText('sw-2')).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });

    fireEvent.click(screen.getByRole('button', { name: '2 facet values — clear' }));
    expect(screen.getByText('4 of 4 indexed')).toBeTruthy();
  });

  it('facets compose with the free-text filter (AND), counts following the text', async () => {
    mockGetDevices.mockResolvedValue(FOUR);
    renderDevices();
    await screen.findByText('4 of 4 indexed');

    const box = screen.getByPlaceholderText('name, model, serial, ip…');
    fireEvent.change(box, { target: { value: 'ap-' } });
    expect(screen.getByText('2 of 4 indexed')).toBeTruthy();

    // The facet universe is the text-filtered set: one CENTRAL and one MIST row.
    fireEvent.click(screen.getByRole('button', { name: 'Plane' }));
    const planePanel = screen.getByRole('group', { name: 'Plane filter' });
    expect(within(planePanel).getByRole('checkbox', { name: 'CENTRAL' }).closest('li')!.textContent).toContain('1');
    expect(within(planePanel).getByRole('checkbox', { name: 'MIST' }).closest('li')!.textContent).toContain('1');

    fireEvent.click(within(planePanel).getByRole('checkbox', { name: 'MIST' }));
    expect(screen.getByText('1 of 4 indexed')).toBeTruthy();
    expect(screen.getByText('ap-3')).toBeTruthy();
    expect(screen.queryByText('ap-1')).toBeNull();
  });

  it('labels the site facet by site name, keyed on the site id', async () => {
    mockGetDevices.mockResolvedValue(FOUR);
    renderDevices();
    await screen.findByText('4 of 4 indexed');

    fireEvent.click(screen.getByRole('button', { name: 'Site' }));
    const sitePanel = screen.getByRole('group', { name: 'Site filter' });
    fireEvent.click(within(sitePanel).getByRole('checkbox', { name: 'Campus-02 Lab' }));
    expect(screen.getByText('2 of 4 indexed')).toBeTruthy();
    expect(screen.getByText('ap-3')).toBeTruthy();
    expect(screen.getByText('gw-4')).toBeTruthy();
    expect(screen.queryByText('ap-1')).toBeNull();
  });

  it('seeds the plane facet from the ?plane= deep link', async () => {
    mockGetDevices.mockResolvedValue(FOUR);
    renderAt('/devices?plane=mist');

    expect(await screen.findByText('2 of 4 indexed')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Plane · 1' })).toBeTruthy();
    expect(screen.queryByText('ap-1')).toBeNull();
  });

  it('keeps a deep-linked plane with no rows visible and clearable, count 0', async () => {
    mockGetDevices.mockResolvedValue(FOUR);
    renderAt('/devices?plane=uxi');

    // The old Select unioned the value in as "(no devices)"; the facet keeps
    // it listed at 0 — the hiding filter never turns invisible.
    expect(await screen.findByText('0 of 4 indexed')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Plane · 1' }));
    const planePanel = screen.getByRole('group', { name: 'Plane filter' });
    expect(within(planePanel).getByRole('checkbox', { name: 'UXI' }).closest('li')!.textContent).toContain('0');

    fireEvent.click(within(planePanel).getByRole('button', { name: 'Clear plane' }));
    expect(screen.getByText('4 of 4 indexed')).toBeTruthy();
  });
});

/* The saved-views dropdown captures the facet selection, free text, type and
 * issues switch, the column-manager config and the density — persisted through
 * SettingsContext under the 'devices' screen id. */
describe('Devices saved views', () => {
  beforeEach(() => {
    const values = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
      clear: () => values.clear(),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const FOUR = {
    dataSource: 'live' as const,
    devices: [
      liveRow({ name: 'ap-1', plane: 'CENTRAL' }),
      liveRow({ name: 'sw-2', plane: 'CENTRAL' }),
      liveRow({ name: 'ap-3', plane: 'MIST', planeTone: 'info' }),
      liveRow({ name: 'gw-4', plane: 'MIST', planeTone: 'info' }),
    ],
    lanes: {},
    reconciliation: { doubleClaimed: 0, unclaimed: 0 },
  };

  it('saves the current filters and layout, and applying a view restores them', async () => {
    mockGetDevices.mockResolvedValue(FOUR);
    const { container } = renderDevices();
    await screen.findByText('4 of 4 indexed');

    // Set up a view: plane facet CENTRAL, the Model column hidden.
    fireEvent.click(screen.getByRole('button', { name: 'Plane' }));
    fireEvent.click(
      within(screen.getByRole('group', { name: 'Plane filter' })).getByRole('checkbox', { name: 'CENTRAL' }),
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: 'View options' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Model' }));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.getByText('2 of 4 indexed')).toBeTruthy();

    // Save it, then tear the filters down again.
    fireEvent.click(screen.getByRole('button', { name: 'Views' }));
    fireEvent.change(screen.getByLabelText('New view name'), { target: { value: 'Central only' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByRole('button', { name: 'Views · 1' })).toBeTruthy();

    const persisted = JSON.parse(localStorage.getItem('nt-saved-views') ?? '{}');
    expect(persisted.devices).toHaveLength(1);
    expect(persisted.devices[0].name).toBe('Central only');
    expect(persisted.devices[0].filters.facets).toEqual({ plane: ['CENTRAL'] });
    expect(persisted.devices[0].tableColumns).toEqual({ hidden: ['model'] });

    fireEvent.click(screen.getByRole('button', { name: '1 facet value — clear' }));
    fireEvent.click(screen.getByRole('button', { name: 'View options' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Model' }));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.getByText('4 of 4 indexed')).toBeTruthy();
    expect(container.querySelector('th[data-column-key="model"]')).not.toBeNull();

    // Applying the view restores the facet selection AND the column layout.
    fireEvent.click(screen.getByRole('button', { name: 'Views · 1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Central only' }));
    expect(screen.getByText('2 of 4 indexed')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Plane · 1' })).toBeTruthy();
    expect(container.querySelector('th[data-column-key="model"]')).toBeNull();
  });
});

describe('Devices firmware verdicts', () => {
  /* The plane's own firmware words, rendered — never interpreted into prose:
     behind = warning with the recommended train named, the upgrade-state word
     verbatim, at-target and unknown quiet. */
  it('behind: warning badge naming the target, in-progress word verbatim', async () => {
    mockGetDevices.mockResolvedValue({
      dataSource: 'live' as const,
      devices: [
        liveRow({
          name: 'ap-fw-1',
          type: 'ap',
          plane: 'MIST',
          planeTone: 'info',
          firmware: '0.13.18',
          firmwareApproved: false,
          firmwareTarget: '0.14.29',
          firmwareUpdate: 'inprogress',
        }),
      ],
      lanes: {},
      reconciliation: { doubleClaimed: 0, unclaimed: 0 },
    });

    renderDevices();

    expect(await screen.findByText('behind → 0.14.29')).toBeTruthy();
    expect(screen.getByText('inprogress')).toBeTruthy();
    expect(screen.getByText('0.13.18')).toBeTruthy();
  });

  it('at target and unknown stay quiet — no badge, no invented state', async () => {
    mockGetDevices.mockResolvedValue({
      dataSource: 'live' as const,
      devices: [
        liveRow({ name: 'ap-fw-ok', type: 'ap', firmware: '0.14.29', firmwareApproved: true, firmwareTarget: '0.14.29' }),
        liveRow({ name: 'sw-fw-unknown', firmware: 'unknown', firmwareApproved: true }),
      ],
      lanes: {},
      reconciliation: { doubleClaimed: 0, unclaimed: 0 },
    });

    renderDevices();

    expect(await screen.findByText('0.14.29')).toBeTruthy();
    expect(screen.queryByText(/behind →/)).toBeNull();
    expect(screen.queryByText('inprogress')).toBeNull();
  });

  it('demo: the fixture estate shows the NET-4188 AP mid-upgrade off the recommended train', async () => {
    mockGetDevices.mockResolvedValue({
      dataSource: 'demo' as const,
      devices: DEVICES,
      lanes: LANE_META,
      reconciliation: DEVICE_RECONCILIATION,
    });

    renderDevices();

    // ap-3f-14 runs 0.13.18 with 0.14.29 suggested and an upgrade in progress.
    expect(await screen.findByText('behind → 0.14.29')).toBeTruthy();
    expect(screen.getByText('inprogress')).toBeTruthy();
    // Its sibling ap-3f-12 is at the suggested train and stays quiet — exactly
    // one behind badge on the whole table.
    expect(screen.getAllByText(/behind →/)).toHaveLength(1);
  });
});

/* Loop 56 — filter-row state writes into the address bar so Copy view link
 * shares q/type/issues/plane/site (plus names/state deep links). */
describe('Devices filter share link completeness', () => {
  function LocationProbe() {
    const location = useLocation();
    return <div data-testid="loc">{`${location.pathname}${location.search}`}</div>;
  }

  function renderAt(entry: string) {
    return render(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }} initialEntries={[entry]}>
        <SettingsProvider>
          <ToastProvider>
            <Routes>
              <Route
                path="/devices"
                element={
                  <>
                    <Devices />
                    <LocationProbe />
                  </>
                }
              />
            </Routes>
          </ToastProvider>
        </SettingsProvider>
      </MemoryRouter>,
    );
  }

  it('seeds q/type/issues from the URL and write-back keeps them shareable', async () => {
    mockGetDevices.mockResolvedValue({
      dataSource: 'live' as const,
      devices: [
        liveRow({ name: 'sw-core', type: 'switch', plane: 'CENTRAL', reconciliationIssue: true }),
        liveRow({ name: 'ap-1', type: 'ap', plane: 'MIST', model: 'AP-635' }),
      ],
      lanes: {},
      reconciliation: { doubleClaimed: 0, unclaimed: 0 },
    });

    renderAt('/devices?q=core&type=switch&issues=1&plane=CENTRAL');
    expect(await screen.findByText('sw-core')).toBeTruthy();
    expect(screen.queryByText('ap-1')).toBeNull();

    const loc = screen.getByTestId('loc').textContent ?? '';
    expect(loc).toContain('q=core');
    expect(loc).toContain('type=switch');
    expect(loc).toContain('issues=1');
    expect(loc).toContain('plane=CENTRAL');

    fireEvent.change(screen.getByRole('textbox', { name: 'Filter devices' }), {
      target: { value: 'sw' },
    });
    await waitFor(() => expect(screen.getByTestId('loc').textContent).toContain('q=sw'));
    expect(screen.getByTestId('loc').textContent).toContain('type=switch');
  });

  it('Copy view link includes the written-back filter query', async () => {
    mockGetDevices.mockResolvedValue({
      dataSource: 'live' as const,
      devices: [liveRow({ name: 'sw-core', type: 'switch' })],
      lanes: {},
      reconciliation: { doubleClaimed: 0, unclaimed: 0 },
    });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    renderAt('/devices?q=core&type=switch');
    await screen.findByText('sw-core');
    fireEvent.click(screen.getByRole('button', { name: 'Copy view link' }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    const url = String(writeText.mock.calls[0]![0]);
    expect(url).toContain('q=core');
    expect(url).toContain('type=switch');
  });
});

/* Loop 145 — Issues chip row toggles the same issues= filter as the Switch. */
describe('Devices issues chips (Loop 145)', () => {
  function SearchProbe() {
    const location = useLocation();
    return <div data-testid="search">{location.search}</div>;
  }

  function renderAt(path = '/devices') {
    return render(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }} initialEntries={[path]}>
        <ToastProvider>
          <SettingsProvider>
            <Routes>
              <Route
                path="/devices"
                element={
                  <>
                    <Devices />
                    <SearchProbe />
                  </>
                }
              />
            </Routes>
          </SettingsProvider>
        </ToastProvider>
      </MemoryRouter>,
    );
  }

  it('issues chips filter the table and write issues back to the URL', async () => {
    mockGetDevices.mockResolvedValue({
      dataSource: 'live' as const,
      devices: [
        liveRow({ name: 'sw-issue', type: 'switch', reconciliationIssue: true }),
        liveRow({ name: 'ap-clean', type: 'ap', plane: 'MIST', reconciliationIssue: false }),
      ],
      lanes: {},
      reconciliation: { doubleClaimed: 1, unclaimed: 0 },
    });

    renderAt('/devices');
    expect(await screen.findByText('sw-issue')).toBeTruthy();
    expect(screen.getByText('ap-clean')).toBeTruthy();

    const chips = screen.getByRole('group', { name: 'Device issues' });
    const issues = within(chips).getByRole('button', { name: /Issues/i });
    expect(issues.getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(issues);
    await waitFor(() => expect(screen.getByText('sw-issue')).toBeTruthy());
    expect(screen.queryByText('ap-clean')).toBeNull();
    expect(screen.getByTestId('search').textContent).toContain('issues=1');
    expect(issues.getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(issues);
    await waitFor(() => expect(screen.getByText('ap-clean')).toBeTruthy());
    expect(screen.getByText('sw-issue')).toBeTruthy();
    expect(screen.getByTestId('search').textContent).not.toContain('issues=');
  });

  it('clean chip hides reconciliation issues and writes issues=0', async () => {
    mockGetDevices.mockResolvedValue({
      dataSource: 'live' as const,
      devices: [
        liveRow({ name: 'sw-issue', type: 'switch', reconciliationIssue: true }),
        liveRow({ name: 'ap-clean', type: 'ap', plane: 'MIST', reconciliationIssue: false }),
      ],
      lanes: {},
      reconciliation: { doubleClaimed: 1, unclaimed: 0 },
    });

    renderAt('/devices');
    expect(await screen.findByText('sw-issue')).toBeTruthy();

    const chips = screen.getByRole('group', { name: 'Device issues' });
    const clean = within(chips).getByRole('button', { name: /Clean/i });
    fireEvent.click(clean);
    await waitFor(() => expect(screen.getByText('ap-clean')).toBeTruthy());
    expect(screen.queryByText('sw-issue')).toBeNull();
    expect(screen.getByTestId('search').textContent).toContain('issues=0');
    expect(clean.getAttribute('aria-pressed')).toBe('true');
  });
});

/* Loop 154 — State chip row toggles the same state= deep-link filter. */
describe('Devices state chips (Loop 154)', () => {
  function SearchProbe() {
    const location = useLocation();
    return <div data-testid="search">{location.search}</div>;
  }

  function renderAt(path = '/devices') {
    return render(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }} initialEntries={[path]}>
        <ToastProvider>
          <SettingsProvider>
            <Routes>
              <Route
                path="/devices"
                element={
                  <>
                    <Devices />
                    <SearchProbe />
                  </>
                }
              />
            </Routes>
          </SettingsProvider>
        </ToastProvider>
      </MemoryRouter>,
    );
  }

  it('state chips filter the table and write state back to the URL', async () => {
    mockGetDevices.mockResolvedValue({
      dataSource: 'live' as const,
      devices: [
        liveRow({ name: 'sw-up', type: 'switch', state: 'up', stateTone: 'success' }),
        liveRow({ name: 'ap-down', type: 'ap', plane: 'MIST', state: 'down', stateTone: 'danger' }),
      ],
      lanes: {},
      reconciliation: { doubleClaimed: 0, unclaimed: 0 },
    });

    renderAt('/devices');
    expect(await screen.findByText('sw-up')).toBeTruthy();
    expect(screen.getByText('ap-down')).toBeTruthy();

    const chips = screen.getByRole('group', { name: 'Device state' });
    const down = within(chips).getByRole('button', { name: /down/i });
    expect(down.getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(down);
    await waitFor(() => expect(screen.getByText('ap-down')).toBeTruthy());
    expect(screen.queryByText('sw-up')).toBeNull();
    expect(screen.getByTestId('search').textContent).toContain('state=down');
    expect(down.getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(down);
    await waitFor(() => expect(screen.getByText('sw-up')).toBeTruthy());
    expect(screen.getByText('ap-down')).toBeTruthy();
    expect(screen.getByTestId('search').textContent).not.toContain('state=');
  });
});

/* Loop 153 — Type chip row toggles the same type= filter as the Select. */
describe('Devices type chips (Loop 153)', () => {
  function SearchProbe() {
    const location = useLocation();
    return <div data-testid="search">{location.search}</div>;
  }

  function renderAt(path = '/devices') {
    return render(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }} initialEntries={[path]}>
        <ToastProvider>
          <SettingsProvider>
            <Routes>
              <Route
                path="/devices"
                element={
                  <>
                    <Devices />
                    <SearchProbe />
                  </>
                }
              />
            </Routes>
          </SettingsProvider>
        </ToastProvider>
      </MemoryRouter>,
    );
  }

  it('type chips filter the table and write type back to the URL', async () => {
    mockGetDevices.mockResolvedValue({
      dataSource: 'live' as const,
      devices: [
        liveRow({ name: 'sw-core', type: 'switch' }),
        liveRow({ name: 'ap-lobby', type: 'ap', plane: 'MIST' }),
      ],
      lanes: {},
      reconciliation: { doubleClaimed: 0, unclaimed: 0 },
    });

    renderAt('/devices');
    expect(await screen.findByText('sw-core')).toBeTruthy();
    expect(screen.getByText('ap-lobby')).toBeTruthy();

    const chips = screen.getByRole('group', { name: 'Device type' });
    const ap = within(chips).getByRole('button', { name: /ap/i });
    expect(ap.getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(ap);
    await waitFor(() => expect(screen.getByText('ap-lobby')).toBeTruthy());
    expect(screen.queryByText('sw-core')).toBeNull();
    expect(screen.getByTestId('search').textContent).toContain('type=ap');
    expect(ap.getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(ap);
    await waitFor(() => expect(screen.getByText('sw-core')).toBeTruthy());
    expect(screen.getByText('ap-lobby')).toBeTruthy();
    expect(screen.getByTestId('search').textContent).not.toContain('type=');
  });
});

/* Loop 157 — Plane chip row toggles the same plane facet / ?plane= write-back. */
describe('Devices plane chips (Loop 157)', () => {
  function SearchProbe() {
    const location = useLocation();
    return <div data-testid="search">{location.search}</div>;
  }

  function renderAt(path = '/devices') {
    return render(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }} initialEntries={[path]}>
        <ToastProvider>
          <SettingsProvider>
            <Routes>
              <Route
                path="/devices"
                element={
                  <>
                    <Devices />
                    <SearchProbe />
                  </>
                }
              />
            </Routes>
          </SettingsProvider>
        </ToastProvider>
      </MemoryRouter>,
    );
  }

  it('plane chips filter the table and write plane back to the URL', async () => {
    mockGetDevices.mockResolvedValue({
      dataSource: 'live' as const,
      devices: [
        liveRow({ name: 'sw-central', type: 'switch', plane: 'CENTRAL' }),
        liveRow({ name: 'ap-mist', type: 'ap', plane: 'MIST' }),
      ],
      lanes: {},
      reconciliation: { doubleClaimed: 0, unclaimed: 0 },
    });

    renderAt('/devices');
    expect(await screen.findByText('sw-central')).toBeTruthy();
    expect(screen.getByText('ap-mist')).toBeTruthy();

    const chips = screen.getByRole('group', { name: 'Device plane' });
    const mist = within(chips).getByRole('button', { name: /MIST/i });
    expect(mist.getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(mist);
    await waitFor(() => expect(screen.getByText('ap-mist')).toBeTruthy());
    expect(screen.queryByText('sw-central')).toBeNull();
    expect(screen.getByTestId('search').textContent).toMatch(/plane=MIST/);
    expect(mist.getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(mist);
    await waitFor(() => expect(screen.getByText('sw-central')).toBeTruthy());
    expect(screen.getByText('ap-mist')).toBeTruthy();
    expect(screen.getByTestId('search').textContent).not.toMatch(/plane=/);
  });
});

/* Loop 156 — Site chip row toggles the same site facet / ?site= write-back. */
describe('Devices site chips (Loop 156)', () => {
  function SearchProbe() {
    const location = useLocation();
    return <div data-testid="search">{location.search}</div>;
  }

  function renderAt(path = '/devices') {
    return render(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }} initialEntries={[path]}>
        <ToastProvider>
          <SettingsProvider>
            <Routes>
              <Route
                path="/devices"
                element={
                  <>
                    <Devices />
                    <SearchProbe />
                  </>
                }
              />
            </Routes>
          </SettingsProvider>
        </ToastProvider>
      </MemoryRouter>,
    );
  }

  it('site chips filter the table and write site back to the URL', async () => {
    mockGetDevices.mockResolvedValue({
      dataSource: 'live' as const,
      devices: [
        liveRow({
          name: 'sw-hq',
          type: 'switch',
          siteId: 'campus-01',
          siteName: 'Campus-01 HQ',
        }),
        liveRow({
          name: 'ap-lab',
          type: 'ap',
          plane: 'MIST',
          siteId: 'campus-02',
          siteName: 'Campus-02 Lab',
        }),
      ],
      lanes: {},
      reconciliation: { doubleClaimed: 0, unclaimed: 0 },
    });

    renderAt('/devices');
    expect(await screen.findByText('sw-hq')).toBeTruthy();
    expect(screen.getByText('ap-lab')).toBeTruthy();

    const chips = screen.getByRole('group', { name: 'Device site' });
    const lab = within(chips).getByRole('button', { name: /Campus-02 Lab/i });
    expect(lab.getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(lab);
    await waitFor(() => expect(screen.getByText('ap-lab')).toBeTruthy());
    expect(screen.queryByText('sw-hq')).toBeNull();
    expect(screen.getByTestId('search').textContent).toMatch(/site=campus-02/);
    expect(lab.getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(lab);
    await waitFor(() => expect(screen.getByText('sw-hq')).toBeTruthy());
    expect(screen.getByText('ap-lab')).toBeTruthy();
    expect(screen.getByTestId('search').textContent).not.toMatch(/site=/);
  });
});

/* Loop 163 — LIVE badge honesty (pure live + blend). */
describe('Devices Loop 163 residuals', () => {
  it('stamps LIVE on pure live inventory', async () => {
    mockGetDevices.mockResolvedValue({
      dataSource: 'live',
      devices: [liveRow()],
      lanes: LANE_META,
    });
    renderDevices();
    expect(await screen.findByText('LIVE')).toBeTruthy();
  });

  it('stamps LIVE when devices arrive via blend', async () => {
    mockGetDevices.mockResolvedValue({
      dataSource: 'demo',
      blended: ['devices'],
      devices: [liveRow()],
      lanes: LANE_META,
    });
    renderDevices();
    expect(await screen.findByText('LIVE')).toBeTruthy();
  });

  it('hides LIVE on demo fixtures without blend', async () => {
    mockGetDevices.mockResolvedValue({
      dataSource: 'demo',
      devices: DEVICES,
      lanes: LANE_META,
      reconciliation: DEVICE_RECONCILIATION,
    });
    renderDevices();
    await screen.findByText(/devices, six inventories/i);
    expect(screen.queryByText('LIVE')).toBeNull();
  });
});


/* Loop 202 — filtered empty Clear filters CTA. */
describe('Devices Loop 202 residuals', () => {
  function renderAt(entry: string) {
    return render(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }} initialEntries={[entry]}>
        <SettingsProvider>
          <ToastProvider>
            <Routes>
              <Route path="/devices" element={<Devices />} />
            </Routes>
          </ToastProvider>
        </SettingsProvider>
      </MemoryRouter>,
    );
  }

  it('offers Clear filters when the inventory filter is empty', async () => {
    mockGetDevices.mockResolvedValue({
      dataSource: 'live',
      devices: [
        liveRow({ name: 'sw-core-a', type: 'switch' }),
        liveRow({ name: 'ap-1', type: 'ap', plane: 'MIST' }),
      ],
      lanes: LANE_META,
    });
    renderAt('/devices?q=zzzz-no-match');
    expect(await screen.findByText('Nothing matches that filter')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(await screen.findByText('sw-core-a')).toBeTruthy();
    expect(screen.getByText('ap-1')).toBeTruthy();
  });
});
