import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import Licenses from './Licenses';
import { SettingsProvider } from '../app/SettingsContext';
import { ToastProvider } from '../nightdesk';
import { getLicenses } from '../api/client';
import type { LicensesData } from '../api/client';

vi.mock('../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/client')>();
  return {
    ...actual,
    getLicenses: vi.fn(),
  };
});

const mockGetLicenses = vi.mocked(getLicenses);

/** GreenLake with seat totals but no assignment counts and no device identities. */
const LIVE: LicensesData = {
  dataSource: 'live',
  stats: [
    { label: 'Subscriptions', value: '2', delta: '220 seats', tone: 'neutral' },
    { label: 'Assigned', value: '174', delta: '79% utilised', tone: 'neutral' },
    { label: 'Unassigned', value: '46', delta: 'all subscriptions in use', tone: 'neutral' },
    { label: 'Expiring <60d', value: '0', delta: 'none on the horizon', tone: 'positive' },
  ],
  subscriptions: [
    {
      name: 'Foundation AP', sku: 'R7G20AAE · greenlake', plane: 'GREENLAKE', planeTone: 'accent',
      term: '3 yr subscription', qty: '180', assigned: '174', pct: '97%', expires: '14 Sep 26',
      status: 'expiring', tone: 'warning',
    },
    {
      name: 'Advanced switch', sku: 'Q9Y77AAE · greenlake', plane: 'GREENLAKE', planeTone: 'accent',
      term: '1 yr subscription', qty: '—', assigned: '—', pct: '—', expires: '—',
      status: 'active', tone: 'success',
    },
  ],
  renewals: [],
  orphans: [],
};

const DEMO: LicensesData = {
  dataSource: 'demo',
  stats: LIVE.stats,
  subscriptions: LIVE.subscriptions,
  renewals: [{ date: '14 Sep 26', what: 'Foundation AP', days: '50d', color: 'var(--nd-warning)' }],
  orphans: [
    { tag: 'orphan', tone: 'warning', what: '6 Foundation AP subscriptions on decommissioned devices', detail: 'reclaim before renewal' },
  ],
};

function renderLicenses() {
  return render(
    <MemoryRouter>
      <SettingsProvider>
        <ToastProvider>
          <Licenses />
        </ToastProvider>
      </SettingsProvider>
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('Licences reconciliation honesty', () => {
  it('drops the authored gap prose in live mode and explains the empty lists', async () => {
    mockGetLicenses.mockResolvedValue(LIVE);

    renderLicenses();

    expect(await screen.findByText('Reconciliation gaps are not reported by this plane')).toBeTruthy();
    expect(screen.queryByText('Two reconciliation gaps worth money')).toBeNull();
    expect(screen.getByText('Nothing to reclaim')).toBeTruthy();
    expect(screen.getByText('No dated renewals')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reclaim all' }).hasAttribute('disabled')).toBe(true);
  });

  it('leaves the utilisation bar empty when GreenLake reports no percentage', async () => {
    mockGetLicenses.mockResolvedValue(LIVE);

    const { container } = renderLicenses();
    await screen.findByText('Foundation AP');

    const fills = Array.from(container.querySelectorAll<HTMLElement>('[style*="width: 80px"] > div'));
    expect(fills).toHaveLength(2);
    expect(fills[0].style.width).toBe('97%');
    expect(fills[0].style.background).toBe('var(--nd-warning)');
    // '—' is not a percentage: the bar must not paint a full, healthy pool.
    expect(fills[1].style.width).toBe('0px');
  });

  it('stamps GreenLake provenance and captions the renewals list with what it carries', async () => {
    mockGetLicenses.mockResolvedValue({
      ...LIVE,
      syncedAt: '2026-07-26T09:41:00.000Z',
      // Two subscriptions expiring in the same calendar month: the live feed's
      // month-precision dates must not collapse into one rendered row.
      renewals: [
        { date: 'Sep 2026', what: 'Foundation AP', days: '50d', color: 'var(--nd-warning)' },
        { date: 'Sep 2026', what: 'Advanced switch', days: '54d', color: 'var(--nd-warning)' },
      ],
    });

    renderLicenses();

    expect(await screen.findByText(/^GREENLAKE \d\d:\d\d$/)).toBeTruthy();
    expect(screen.queryByText('NEXT 180 DAYS')).toBeNull();
    expect(screen.getByText('2 DATED SUBSCRIPTIONS')).toBeTruthy();
    expect(screen.getAllByText('Sep 2026')).toHaveLength(2);
  });

  it('keeps the authored 180-day caption and demo stamp on the fixture path', async () => {
    mockGetLicenses.mockResolvedValue(DEMO);

    renderLicenses();

    expect(await screen.findByText('DEMO FIXTURES')).toBeTruthy();
    expect(screen.getByText('NEXT 180 DAYS')).toBeTruthy();
  });

  it('keeps the authored two-gap Alert on the demo path', async () => {
    mockGetLicenses.mockResolvedValue(DEMO);

    renderLicenses();

    expect(await screen.findByText('Two reconciliation gaps worth money')).toBeTruthy();
    expect(screen.queryByText('Nothing to reclaim')).toBeNull();
  });
});
