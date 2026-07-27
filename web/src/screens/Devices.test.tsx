import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import Devices from './Devices';
import { SettingsProvider } from '../app/SettingsContext';
import { ToastProvider } from '../nightdesk';
import { getDevices } from '../api/client';
import { DEVICE_RECONCILIATION, DEVICES, LANE_META } from '../../../shared';
import type { DeviceRow } from '../../../shared';

vi.mock('../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/client')>();
  return { ...actual, getDevices: vi.fn() };
});

const mockGetDevices = vi.mocked(getDevices);

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
    <MemoryRouter>
      <SettingsProvider>
        <ToastProvider>
          <Devices />
        </ToastProvider>
      </SettingsProvider>
    </MemoryRouter>,
  );
}

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
      <MemoryRouter>
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
