import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import Devices from './Devices';
import { SettingsProvider } from '../app/SettingsContext';
import { ToastProvider } from '../nightdesk';
import { getDevices } from '../api/client';
import { DEVICES, LANE_META } from '../../../shared';
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
    expect(screen.queryByText(/418 total/)).toBeNull();
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
    mockGetDevices.mockResolvedValue({
      dataSource: 'demo',
      devices: DEVICES,
      lanes: LANE_META,
    });

    renderDevices();

    // 28 fixture rows are a sample of a 418-device estate: the counts are the
    // authored truth, not a tally of the loaded rows (which would say "2").
    expect(
      await screen.findByText(
        'Reconciliation: 3 devices claimed by two inventories, 14 by none',
      ),
    ).toBeTruthy();
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
});
