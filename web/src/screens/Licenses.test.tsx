import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import Licenses from './Licenses';
import { SettingsProvider } from '../app/SettingsContext';
import { ToastProvider } from '../nightdesk';
import { getLicenses } from '../api/client';
import type { LicensesData } from '../api/client';
import { downloadApiCsv } from '../lib/downloadApiCsv';
import { MIST_LICENSE_USAGES } from '@hpe/shared';
import type { MistLicenseUsageRow, SubscriptionRow } from '@hpe/shared';

vi.mock('../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/client')>();
  return {
    ...actual,
    getLicenses: vi.fn(),
  };
});

vi.mock('../lib/downloadApiCsv', () => ({
  downloadApiCsv: vi.fn(async () => ({ ok: true as const })),
}));

const mockGetLicenses = vi.mocked(getLicenses);
const mockDownloadApiCsv = vi.mocked(downloadApiCsv);

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

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="loc">{`${location.pathname}${location.search}`}</div>;
}

function renderLicenses(entry = '/licenses') {
  return render(
    <MemoryRouter
      future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
      initialEntries={[entry]}
    >
      <SettingsProvider>
        <ToastProvider>
          <Routes>
            <Route
              path="/licenses"
              element={
                <>
                  <Licenses />
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

/** A subscription row with every field fixed except the one a test exercises. */
function sub(over: Partial<SubscriptionRow> = {}): SubscriptionRow {
  return {
    name: 'Sub',
    sku: 'SKU · greenlake',
    plane: 'GREENLAKE',
    planeTone: 'accent',
    term: '3 yr subscription',
    qty: '10',
    assigned: '9',
    pct: '90%',
    expires: '01 Feb 27',
    status: 'active',
    tone: 'success',
    ...over,
  };
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

    const fills = Array.from(container.querySelectorAll<HTMLElement>('.nt-license-track > div'));
    expect(fills).toHaveLength(2);
    expect(fills[0].style.getPropertyValue('--nd-health')).toBe('97%');
    expect(fills[0].classList.contains('nt-license-fill--hot')).toBe(true);
    // '—' is not a percentage: the bar must not paint a full, healthy pool.
    expect(fills[1].style.getPropertyValue('--nd-health')).toBe('0%');
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
    // The route enforces the 180-day window, so the caption may name it — with
    // the count the payload actually carries, never a bare literal.
    expect(screen.getByText('NEXT 180 DAYS · 2')).toBeTruthy();
    expect(screen.getAllByText('Sep 2026')).toHaveLength(2);
  });

  it('separates "nothing falls due" from "nothing carries a date" in the renewals caption', async () => {
    // Dated subscriptions exist, none inside the window: the horizon is known.
    mockGetLicenses.mockResolvedValue({
      ...LIVE,
      subscriptions: [{ ...LIVE.subscriptions[0], expires: '14 Sep 28' }],
      renewals: [],
    });
    renderLicenses();
    expect(await screen.findByText('NEXT 180 DAYS · NOTHING DUE')).toBeTruthy();

    // No row carries an expiry at all: the window was never observed, so the
    // caption must not claim a clear 180 days.
    cleanup();
    mockGetLicenses.mockResolvedValue({
      ...LIVE,
      subscriptions: [{ ...LIVE.subscriptions[1], expires: '—' }],
      renewals: [],
    });
    renderLicenses();
    expect(await screen.findByText('NO DATED SUBSCRIPTIONS')).toBeTruthy();
    expect(screen.queryByText(/NOTHING DUE/)).toBeNull();
  });

  it('keeps the authored 180-day caption and demo stamp on the fixture path', async () => {
    mockGetLicenses.mockResolvedValue(DEMO);

    renderLicenses();

    expect(await screen.findByText('DEMO FIXTURES')).toBeTruthy();
    expect(screen.getByText('NEXT 180 DAYS')).toBeTruthy();
  });

  /* An `unchecked` row is the server saying it could not compare entitlements
     against the estate at all. It is not a finding, so it must not be counted
     into a headline that puts a number on money being wasted. */
  it('does not count a comparison that never ran as a gap worth money', async () => {
    mockGetLicenses.mockResolvedValue({
      ...LIVE,
      orphans: [
        {
          tag: 'unchecked',
          tone: 'neutral',
          what: '38 entitlements not checked against the estate',
          detail: 'CENTRAL contributed no device list this cycle',
        },
        { tag: 'gap', tone: 'info', what: '2 devices with no active subscription', detail: 'reported unassigned' },
      ],
    });

    renderLicenses();

    expect(await screen.findByText('1 reconciliation gap worth money')).toBeTruthy();
    // And the reason the count may be short is stated rather than left to be
    // spotted in the list below.
    expect(screen.getByText('The estate comparison could not be run this cycle')).toBeTruthy();
  });

  /* Two explanations for one silence, and the second one is false: the feed
     DID carry assignments, the inventory is what was short. */
  it('does not blame the subscriptions feed for a silence the inventory caused', async () => {
    mockGetLicenses.mockResolvedValue({
      ...LIVE,
      orphans: [
        {
          tag: 'unchecked',
          tone: 'neutral',
          what: '38 entitlements not checked against the estate',
          detail: 'CENTRAL contributed no device list this cycle',
        },
      ],
    });

    renderLicenses();

    expect(await screen.findByText('The estate comparison could not be run this cycle')).toBeTruthy();
    expect(screen.queryByText('Reconciliation gaps are not reported by this plane')).toBeNull();
  });

  it('still explains a genuinely silent feed when nothing went unchecked', async () => {
    mockGetLicenses.mockResolvedValue(LIVE);

    renderLicenses();

    expect(await screen.findByText('Reconciliation gaps are not reported by this plane')).toBeTruthy();
    expect(screen.queryByText('The estate comparison could not be run this cycle')).toBeNull();
  });

  it('keeps the authored two-gap Alert on the demo path', async () => {
    mockGetLicenses.mockResolvedValue(DEMO);

    renderLicenses();

    expect(await screen.findByText('Two reconciliation gaps worth money')).toBeTruthy();
    expect(screen.queryByText('Nothing to reclaim')).toBeNull();
  });
});


// ---------------------------------------------------------------------------
// The subscriptions table is a nightdesk DataTable: the column manager
// persists through SettingsContext (localStorage key 'nt-table-columns' under
// the 'licenses' table id), and two columns tint — utilisation at the bar's
// own 95% cut (plus over-subscription past a full pool) and expiry with the
// row's own status tone. The rows are deliberately NOT a keyboard grid: a
// subscription row has no primary action, so there is nothing honest for
// Enter to do. These tests pin the wiring, not the mechanics.
// ---------------------------------------------------------------------------
describe('Licences table superpowers', () => {
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

  it('hides only an idle subscription with a known numeric zero assignment', async () => {
    const idleZero = sub({ name: 'Idle AP pool', assigned: '0', status: 'idle', tone: 'neutral' });
    mockGetLicenses.mockResolvedValue({ ...LIVE, subscriptions: [...LIVE.subscriptions, idleZero] });

    renderLicenses();

    await screen.findByText('Foundation AP');
    expect(screen.queryByText('Idle AP pool')).toBeNull();
  });

  it('uses the filtered subscription list for the empty count state', async () => {
    mockGetLicenses.mockResolvedValue({
      ...LIVE,
      subscriptions: [sub({ name: 'Idle AP pool', assigned: '0', status: 'idle', tone: 'neutral' })],
    });

    renderLicenses();

    expect(await screen.findByText('No subscriptions to show')).toBeTruthy();
    expect(screen.getByText('All reported subscriptions are idle with zero assigned seats.')).toBeTruthy();
  });

  it('retains assigned or unknown idle subscriptions and every active, expiring, or retiring zero-assignment record', async () => {
    mockGetLicenses.mockResolvedValue({
      ...LIVE,
      subscriptions: [
        sub({ name: 'Expiring capacity', assigned: '0', status: 'expiring', tone: 'warning', daysLeft: 5 }),
        sub({ name: 'Retiring capacity', assigned: '0', status: 'retiring', tone: 'danger', daysLeft: 5 }),
        sub({ name: 'Assigned idle capacity', assigned: '1', status: 'idle', tone: 'neutral' }),
        sub({ name: 'Unknown idle capacity', assigned: '—', status: 'idle', tone: 'neutral' }),
        sub({ name: 'Retiring zero capacity', assigned: '0', status: 'retiring', tone: 'danger', daysLeft: -1 }),
      ],
    });

    renderLicenses();

    expect(await screen.findByText('Expiring capacity')).toBeTruthy();
    expect(screen.getByText('Retiring capacity')).toBeTruthy();
    expect(screen.getByText('Assigned idle capacity')).toBeTruthy();
    expect(screen.getByText('Unknown idle capacity')).toBeTruthy();
    expect(screen.getByText('Retiring zero capacity')).toBeTruthy();
  });

  it('exports the same operational subscriptions shown in the table', async () => {
    const idleZero = sub({
      name: 'Idle AP pool',
      assigned: '0',
      status: 'idle',
      tone: 'neutral',
    });
    const activeUnused = sub({ name: 'Available AP pool', assigned: '0', status: 'active' });
    const retiringUnused = sub({ name: 'Retiring AP pool', assigned: '0', status: 'retiring', tone: 'danger', daysLeft: -1 });
    let csv: Blob | undefined;
    vi.stubGlobal('URL', {
      createObjectURL: (blob: Blob) => {
        csv = blob;
        return 'blob:licences';
      },
      revokeObjectURL: vi.fn(),
    });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    mockGetLicenses.mockResolvedValue({
      ...LIVE,
      subscriptions: [idleZero, activeUnused, retiringUnused, ...LIVE.subscriptions],
    });

    renderLicenses();

    await screen.findByText('Available AP pool');
    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }));
    expect(click).toHaveBeenCalledOnce();
    const contents = await csv?.text();
    expect(contents).toContain('Available AP pool');
    expect(contents).toContain('Retiring AP pool');
    expect(contents).not.toContain('Idle AP pool');
  });

  it('hides and restores a column from View options, persisted to localStorage', async () => {
    mockGetLicenses.mockResolvedValue(LIVE);
    const { container } = renderLicenses();
    await screen.findByText('Foundation AP');
    expect(container.querySelector('th[data-column-key="term"]')).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'View options' }));
    // The primary identifier is not offered for hiding.
    expect(screen.getByRole('checkbox', { name: 'Subscription' }).hasAttribute('disabled')).toBe(true);

    fireEvent.click(screen.getByRole('checkbox', { name: 'Term' }));
    expect(container.querySelector('th[data-column-key="term"]')).toBeNull();
    expect(JSON.parse(localStorage.getItem('nt-table-columns') ?? '{}')).toEqual({
      licenses: { hidden: ['term'] },
    });

    fireEvent.click(screen.getByRole('checkbox', { name: 'Term' }));
    expect(container.querySelector('th[data-column-key="term"]')).not.toBeNull();
  });

  it('seeds the table from the persisted column config on mount', async () => {
    localStorage.setItem('nt-table-columns', JSON.stringify({ licenses: { hidden: ['term'] } }));
    mockGetLicenses.mockResolvedValue(LIVE);
    const { container } = renderLicenses();
    await screen.findByText('Foundation AP');
    expect(container.querySelector('th[data-column-key="term"]')).toBeNull();
    expect(container.querySelector('th[data-column-key="qty"]')).not.toBeNull();
  });

  /* The 95% line is the utilisation bar's own amber cut; past 100% more seats
     are consumed than the pool holds, which the bar caps at a full fill and
     only the tint can say. '—' is no figure and no judgement. */
  it('tints utilisation at the documented cutoffs, boundary by boundary', async () => {
    mockGetLicenses.mockResolvedValue({
      ...LIVE,
      subscriptions: [
        sub({ name: 'sub-94', pct: '94%' }),
        sub({ name: 'sub-95', pct: '95%' }),
        sub({ name: 'sub-100', pct: '100%' }),
        sub({ name: 'sub-101', pct: '101%' }),
      ],
    });
    renderLicenses();
    await screen.findByText('sub-101');

    const utilCell = (pct: string) => screen.getByText(pct).closest('td') as HTMLElement;
    expect(utilCell('94%').className).toContain('nd-table__td--tint-success');
    expect(utilCell('95%').className).toContain('nd-table__td--tint-warning');
    expect(utilCell('100%').className).toContain('nd-table__td--tint-warning');
    expect(utilCell('101%').className).toContain('nd-table__td--tint-danger');
  });

  it('tints no utilisation cell when GreenLake reports no percentage', async () => {
    mockGetLicenses.mockResolvedValue({
      ...LIVE,
      subscriptions: [sub({ name: 'sub-dash', pct: '—' })],
    });
    renderLicenses();
    await screen.findByText('sub-dash');

    const utilCell = screen.getByText('—').closest('td') as HTMLElement;
    expect(utilCell.className).not.toContain('nd-table__td--tint');
  });

  /* The expiry tint is the row's own status tone — the payload's days-to-expiry
     judgement, rendered identically by the Status badge beside it. */
  it('tints expiry with the row’s own status tone', async () => {
    mockGetLicenses.mockResolvedValue({
      ...LIVE,
      subscriptions: [
        sub({ name: 'sub-active', expires: '01 Feb 27', status: 'active', tone: 'success' }),
        sub({ name: 'sub-expiring', expires: '14 Sep 26', status: 'expiring', tone: 'warning' }),
        sub({ name: 'sub-retiring', expires: '12 Aug 26', status: 'retiring', tone: 'danger' }),
        sub({ name: 'sub-idle', expires: 'support 31 Jan 27', status: 'idle', tone: 'neutral' }),
      ],
    });
    renderLicenses();
    await screen.findByText('sub-retiring');

    const cell = (text: string) => screen.getByText(text).closest('td') as HTMLElement;
    expect(cell('01 Feb 27').className).toContain('nd-table__td--tint-success');
    expect(cell('14 Sep 26').className).toContain('nd-table__td--tint-warning');
    expect(cell('12 Aug 26').className).toContain('nd-table__td--tint-danger');
    expect(cell('support 31 Jan 27').className).toContain('nd-table__td--tint-neutral');
  });

  it('is a selection keyboard grid without a primary Enter action (Loop 162 bulk)', async () => {
    mockGetLicenses.mockResolvedValue(LIVE);
    const { container } = renderLicenses();
    await screen.findByText('Foundation AP');

    /* Multi-select enables the DataTable keyboard grid (x toggles); there is
     * still no onRowActivate, so Enter must not navigate or open anything. */
    expect(container.querySelector('table')?.getAttribute('role')).toBe('grid');
    const rows = Array.from(container.querySelectorAll('tbody tr'));
    expect(rows.length).toBeGreaterThan(0);
    const first = rows[0] as HTMLElement;
    first.focus();
    fireEvent.keyDown(first, { key: 'Enter' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByTestId('loc').textContent).toBe('/licenses');
  });
});

// ---------------------------------------------------------------------------
// The Mist per-site usage section. The payload carries /licenses/usages rows
// verbatim — per-service consumption against the fully-loaded demand — and the
// screen keeps the four payload states distinct: rows, an answered-but-empty
// list, "Mist reported nothing" (null), and no section at all (older server).
// ---------------------------------------------------------------------------
describe('Licences Mist per-site usage', () => {
  it('renders usage against fully-loaded demand, keeping an explicit 0 a real count', async () => {
    mockGetLicenses.mockResolvedValue({ ...DEMO, mistLicenseUsages: MIST_LICENSE_USAGES });

    renderLicenses();

    expect(await screen.findByText('Mist per-site subscription usage')).toBeTruthy();
    expect(screen.getByText('3 SITES · USED / FULLY-LOADED')).toBeTruthy();
    expect(screen.getByText('Campus-02 Research')).toBeTruthy();
    expect(screen.getByText('96 devices · 72 APs')).toBeTruthy();
    expect(screen.getByText('SUB-WLAN 72 / 72 · SUB-SW 22 / 24 · SUB-ENG 72 / 72')).toBeTruthy();
    // Southpoint's SUB-SW 0 / 4 is the orphan list's four unassigned wired
    // SUBs — a reported zero, rendered as one, never softened to a dash.
    expect(screen.getByText('SUB-WLAN 10 / 10 · SUB-SW 0 / 4 · SUB-ENG — / 10')).toBeTruthy();
    // Northgate's demand map names SUB-ENG without a consumption count: the
    // row did not state it, so the cell says '—', not a fabricated 0.
    expect(screen.getByText('SUB-WLAN 12 / 12 · SUB-SW 4 / 4 · SUB-ENG — / 12')).toBeTruthy();
  });

  it('says "not reported" for the maps and counts a row did not carry', async () => {
    const sparse: MistLicenseUsageRow = {
      siteId: 'riverside',
      siteName: 'Riverside Clinic',
      numDevices: null,
      numAps: null,
      usages: null,
      fullyLoaded: null,
    };
    mockGetLicenses.mockResolvedValue({ ...LIVE, mistLicenseUsages: [sparse] });

    renderLicenses();

    expect(await screen.findByText('Riverside Clinic')).toBeTruthy();
    expect(screen.getByText('device counts not reported')).toBeTruthy();
    expect(screen.getByText('consumption not reported')).toBeTruthy();
    expect(screen.getByText('1 SITE · USED / FULLY-LOADED')).toBeTruthy();
  });

  it('explains a null section as not-reported, never as zero consumption', async () => {
    mockGetLicenses.mockResolvedValue({ ...LIVE, mistLicenseUsages: null });

    renderLicenses();

    expect(await screen.findByText('Mist licence usage not reported')).toBeTruthy();
    expect(screen.getByText('NOT REPORTED')).toBeTruthy();
    expect(screen.getByText(/per-site consumption is unknown, not zero/)).toBeTruthy();
    expect(screen.queryByText(/SUB-WLAN/)).toBeNull();
  });

  it('tells an answered-but-empty read apart from a missing one', async () => {
    mockGetLicenses.mockResolvedValue({ ...LIVE, mistLicenseUsages: [] });

    renderLicenses();

    expect(await screen.findByText('No per-site usage rows')).toBeTruthy();
    expect(screen.getByText('NO USAGE ROWS')).toBeTruthy();
    expect(screen.queryByText('Mist licence usage not reported')).toBeNull();
  });

  it('renders no section at all when the payload never carried the key', async () => {
    // DEMO has no mistLicenseUsages key — the shape an older server serves.
    mockGetLicenses.mockResolvedValue(DEMO);

    renderLicenses();

    await screen.findByText('Two reconciliation gaps worth money');
    expect(screen.queryByText('Mist per-site subscription usage')).toBeNull();
  });
});

describe('Licences renewals CSV + share link', () => {
  it('exports the renewals table as its own CSV', async () => {
    let csv: Blob | undefined;
    vi.stubGlobal('URL', {
      createObjectURL: (blob: Blob) => {
        csv = blob;
        return 'blob:renewals';
      },
      revokeObjectURL: vi.fn(),
    });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    mockGetLicenses.mockResolvedValue(DEMO);

    renderLicenses();
    fireEvent.click(await screen.findByRole('button', { name: 'Export renewals CSV' }));
    expect(click).toHaveBeenCalledOnce();
    const contents = await csv?.text();
    expect(contents).toContain('Foundation AP');
    expect(contents).toMatch(/^"?date"?,"?what"?,"?days"?/m);
    click.mockRestore();
  });

  it('Copy view link carries idle=1 when idle capacity is shown', async () => {
    const idleZero = sub({
      name: 'Idle AP pool',
      assigned: '0',
      status: 'idle',
      tone: 'neutral',
    });
    mockGetLicenses.mockResolvedValue({
      ...LIVE,
      subscriptions: [...LIVE.subscriptions, idleZero],
    });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    renderLicenses();
    fireEvent.click(await screen.findByRole('switch'));
    await waitFor(() => expect(screen.getByTestId('loc').textContent).toContain('idle=1'));
    fireEvent.click(screen.getByRole('button', { name: 'Copy view link' }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(String(writeText.mock.calls[0]![0])).toMatch(/idle=1/);
  });

  it('seeds idle from the URL and write-back keeps the spare-capacity switch shareable', async () => {
    const idleZero = sub({
      name: 'Idle AP pool',
      assigned: '0',
      status: 'idle',
      tone: 'neutral',
    });
    mockGetLicenses.mockResolvedValue({
      ...LIVE,
      subscriptions: [...LIVE.subscriptions, idleZero],
    });

    renderLicenses('/licenses?idle=1');
    expect(await screen.findByText('Idle AP pool')).toBeTruthy();
    expect(screen.getByTestId('loc').textContent).toContain('idle=1');
    expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('true');

    fireEvent.click(screen.getByRole('switch'));
    await waitFor(() => expect(screen.getByTestId('loc').textContent).not.toContain('idle=1'));
    expect(screen.queryByText('Idle AP pool')).toBeNull();
  });

  it('Download server CSV passes idle=1 only when spare capacity is shown (Loop 77)', async () => {
    const idleZero = sub({
      name: 'Idle AP pool',
      assigned: '0',
      status: 'idle',
      tone: 'neutral',
    });
    mockGetLicenses.mockResolvedValue({
      ...LIVE,
      subscriptions: [...LIVE.subscriptions, idleZero],
    });
    mockDownloadApiCsv.mockClear();

    renderLicenses();
    fireEvent.click(await screen.findByRole('button', { name: 'Download server CSV' }));
    await waitFor(() => expect(mockDownloadApiCsv).toHaveBeenCalled());
    expect(mockDownloadApiCsv.mock.calls[0]?.[0]).toBe('/api/licenses/export');

    mockDownloadApiCsv.mockClear();
    fireEvent.click(screen.getByRole('switch'));
    await waitFor(() => expect(screen.getByTestId('loc').textContent).toContain('idle=1'));
    fireEvent.click(screen.getByRole('button', { name: 'Download server CSV' }));
    await waitFor(() =>
      expect(mockDownloadApiCsv).toHaveBeenCalledWith(
        '/api/licenses/export?idle=1',
        'licenses.csv',
      ),
    );
  });

  it('plane filter write-back + Download server CSV pass plane (Loop 86)', async () => {
    mockGetLicenses.mockResolvedValue({
      ...LIVE,
      subscriptions: [
        sub({ name: 'GL AP', plane: 'GREENLAKE' }),
        sub({ name: 'Mist WLAN', plane: 'MIST', planeTone: 'info' }),
      ],
    });
    mockDownloadApiCsv.mockClear();

    renderLicenses('/licenses?plane=MIST');
    expect(await screen.findByText('Mist WLAN')).toBeTruthy();
    expect(screen.queryByText('GL AP')).toBeNull();
    await waitFor(() => expect(screen.getByTestId('loc').textContent).toContain('plane=MIST'));

    fireEvent.click(screen.getByRole('button', { name: 'Download server CSV' }));
    await waitFor(() =>
      expect(mockDownloadApiCsv).toHaveBeenCalledWith(
        '/api/licenses/export?plane=MIST',
        'licenses.csv',
      ),
    );
  });

  it('q= write-back filters the table and rides Download server CSV (Loop 100)', async () => {
    mockGetLicenses.mockResolvedValue({
      ...LIVE,
      subscriptions: [
        sub({ name: 'Foundation AP', sku: 'R7G20AAE' }),
        sub({ name: 'Advanced switch', sku: 'Q9Y77AAE' }),
      ],
    });
    mockDownloadApiCsv.mockClear();

    renderLicenses('/licenses?q=Foundation');
    expect(await screen.findByText('Foundation AP')).toBeTruthy();
    expect(screen.queryByText('Advanced switch')).toBeNull();
    await waitFor(() => expect(screen.getByTestId('loc').textContent).toContain('q=Foundation'));

    fireEvent.click(screen.getByRole('button', { name: 'Download server CSV' }));
    await waitFor(() =>
      expect(mockDownloadApiCsv).toHaveBeenCalledWith(
        '/api/licenses/export?q=Foundation',
        'licenses.csv',
      ),
    );
  });
});

/* Loop 133 — Status chip row toggles the same status= filter as the Select. */
describe('Licences status chips (Loop 133)', () => {
  it('status chips filter the table and write status back to the URL', async () => {
    mockGetLicenses.mockResolvedValue({
      ...LIVE,
      subscriptions: [
        sub({ name: 'Active AP', status: 'active', tone: 'success' }),
        sub({ name: 'Expiring SW', status: 'expiring', tone: 'warning' }),
      ],
    });

    renderLicenses('/licenses');
    expect(await screen.findByText('Active AP')).toBeTruthy();
    expect(screen.getByText('Expiring SW')).toBeTruthy();
    const chips = screen.getByRole('group', { name: 'Subscription status' });
    const expiring = within(chips).getByRole('button', { name: /expiring/i });
    fireEvent.click(expiring);
    await waitFor(() => expect(screen.getByTestId('loc').textContent).toContain('status=expiring'));
    expect(screen.getByText('Expiring SW')).toBeTruthy();
    expect(screen.queryByText('Active AP')).toBeNull();
    expect(expiring.getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(expiring);
    await waitFor(() => expect(screen.getByTestId('loc').textContent).not.toContain('status='));
    expect(screen.getByText('Active AP')).toBeTruthy();
  });

  it('Clear filters on empty restores subscriptions', async () => {
    mockGetLicenses.mockResolvedValue({
      ...LIVE,
      subscriptions: [
        sub({ name: 'Foundation AP', status: 'active', tone: 'success' }),
        sub({ name: 'Advanced switch', status: 'expiring', tone: 'warning' }),
      ],
    });

    renderLicenses('/licenses?status=retiring');
    expect(await screen.findByText('No subscriptions to show')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(await screen.findByText('Foundation AP')).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId('loc').textContent).not.toContain('status='));
  });
});

/* Loop 142 — Plane chip row toggles the same plane= filter as the Select. */
describe('Licences plane chips (Loop 142)', () => {
  it('plane chips filter the table and write plane back to the URL', async () => {
    mockGetLicenses.mockResolvedValue({
      ...LIVE,
      subscriptions: [
        sub({ name: 'GL AP', plane: 'GREENLAKE' }),
        sub({ name: 'Mist WLAN', plane: 'MIST', planeTone: 'info' }),
      ],
    });

    renderLicenses('/licenses');
    expect(await screen.findByText('GL AP')).toBeTruthy();
    expect(screen.getByText('Mist WLAN')).toBeTruthy();
    const chips = screen.getByRole('group', { name: 'Subscription plane' });
    const mist = within(chips).getByRole('button', { name: /MIST/i });
    fireEvent.click(mist);
    await waitFor(() => expect(screen.getByTestId('loc').textContent).toContain('plane=MIST'));
    expect(screen.getByText('Mist WLAN')).toBeTruthy();
    expect(screen.queryByText('GL AP')).toBeNull();
    expect(mist.getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(mist);
    await waitFor(() => expect(screen.getByTestId('loc').textContent).not.toContain('plane='));
    expect(screen.getByText('GL AP')).toBeTruthy();
  });
});

/* Loop 151 — Idle chip row toggles the same idle=1 filter as the Switch. */
describe('Licences idle chips (Loop 151)', () => {
  it('idle chips reveal zero-assignment idle seats and write idle back to the URL', async () => {
    const idleZero = sub({
      name: 'Idle AP pool',
      assigned: '0',
      status: 'idle',
      tone: 'neutral',
    });
    mockGetLicenses.mockResolvedValue({
      ...LIVE,
      subscriptions: [...LIVE.subscriptions, idleZero],
    });

    renderLicenses('/licenses');
    expect(await screen.findByText('Foundation AP')).toBeTruthy();
    expect(screen.queryByText('Idle AP pool')).toBeNull();

    const chips = screen.getByRole('group', { name: 'Idle capacity' });
    const idle = within(chips).getByRole('button', { name: /Idle/i });
    expect(idle.getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(idle);
    await waitFor(() => expect(screen.getByTestId('loc').textContent).toContain('idle=1'));
    expect(screen.getByText('Idle AP pool')).toBeTruthy();
    expect(idle.getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(idle);
    await waitFor(() => expect(screen.getByTestId('loc').textContent).not.toContain('idle='));
    expect(screen.queryByText('Idle AP pool')).toBeNull();
    expect(idle.getAttribute('aria-pressed')).toBe('false');
  });
});

/* Loop 162 — multi-select Export selected + Copy SKUs bulk bar. */
describe('Licences bulk selection (Loop 162)', () => {
  it('shows bulk bar for selection: Export selected, Copy SKUs, Clear', async () => {
    const createObjectURL = vi.fn(() => 'blob:licences-selected');
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectURL });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    mockGetLicenses.mockResolvedValue(LIVE);
    const { container } = renderLicenses('/licenses');
    expect(await screen.findByText('Foundation AP')).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Subscription selection actions' })).toBeNull();

    const first = container.querySelector('tbody tr') as HTMLElement;
    expect(first).toBeTruthy();
    first.focus();
    fireEvent.keyDown(first, { key: 'x' });

    const bar = await screen.findByRole('region', { name: 'Subscription selection actions' });
    expect(within(bar).getByText('1 SELECTED')).toBeTruthy();

    fireEvent.click(within(bar).getByRole('button', { name: 'Export selected' }));
    expect(await screen.findByText(/Exported 1 selected subscription/)).toBeTruthy();
    expect(createObjectURL).toHaveBeenCalled();

    fireEvent.click(within(bar).getByRole('button', { name: 'Copy SKUs' }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(String(writeText.mock.calls[0]![0])).toContain('R7G20AAE · greenlake');
    expect(await screen.findByText(/Copied 1 SKU/)).toBeTruthy();

    fireEvent.click(within(bar).getByRole('button', { name: 'Clear' }));
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: 'Subscription selection actions' })).toBeNull(),
    );
  });
});

/* Loop 166 — LIVE badge honesty (pure live + licenses blend). */
describe('Licences Loop 166 residuals', () => {
  it('stamps LIVE on pure live licences', async () => {
    mockGetLicenses.mockResolvedValue(LIVE);
    renderLicenses('/licenses');
    expect(await screen.findByText('Licences & subscriptions')).toBeTruthy();
    expect(screen.getByText('LIVE')).toBeTruthy();
  });

  it('stamps LIVE when licences arrive via blend', async () => {
    mockGetLicenses.mockResolvedValue({
      ...DEMO,
      blended: ['licenses'],
      syncedAt: '2026-07-26T11:59:00.000Z',
    });
    renderLicenses('/licenses');
    expect(await screen.findByText('Licences & subscriptions')).toBeTruthy();
    expect(screen.getByText('LIVE')).toBeTruthy();
    expect(screen.getByText(/GREENLAKE /)).toBeTruthy();
    expect(screen.queryByText('DEMO FIXTURES')).toBeNull();
  });

  it('hides LIVE on demo fixtures without blend', async () => {
    mockGetLicenses.mockResolvedValue(DEMO);
    renderLicenses('/licenses');
    expect(await screen.findByText('DEMO FIXTURES')).toBeTruthy();
    expect(screen.queryByText('LIVE')).toBeNull();
  });
});

/* Loop 172 — bulk Copy selection link (?skus=) + clearable chip. */
describe('Licences Loop 172 residuals', () => {
  it('Copy selection link writes skus= and the deep link filters the roster', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    mockGetLicenses.mockResolvedValue(LIVE);
    const { container } = renderLicenses('/licenses');
    expect(await screen.findByText('Foundation AP')).toBeTruthy();
    expect(await screen.findByText('Advanced switch')).toBeTruthy();

    const first = container.querySelector('tbody tr') as HTMLElement;
    expect(first).toBeTruthy();
    first.focus();
    fireEvent.keyDown(first, { key: 'x' });

    const bar = await screen.findByRole('region', { name: 'Subscription selection actions' });
    fireEvent.click(within(bar).getByRole('button', { name: 'Copy selection link' }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(String(writeText.mock.calls[0]![0])).toMatch(/skus=/);
    expect(String(writeText.mock.calls[0]![0])).toContain('R7G20AAE');
    expect(await screen.findByText(/Selection link copied/)).toBeTruthy();
  });

  it('deep-links ?skus= and shows a clearable selection chip', async () => {
    mockGetLicenses.mockResolvedValue(LIVE);
    renderLicenses(`/licenses?skus=${encodeURIComponent('R7G20AAE · greenlake')}`);
    expect(await screen.findByText('Foundation AP')).toBeTruthy();
    expect(screen.queryByText('Advanced switch')).toBeNull();
    const chip = screen.getByRole('group', { name: 'Selection deep link' });
    expect(within(chip).getByText(/1 selected SKU/)).toBeTruthy();
    fireEvent.click(within(chip).getByRole('button'));
    await waitFor(() => expect(screen.getByTestId('loc').textContent).not.toMatch(/skus=/));
    expect(await screen.findByText('Advanced switch')).toBeTruthy();
  });
});

/* Loop 192 — keyboard shortcuts help + live empty Connected systems CTA. */
describe('Licences Loop 192 residuals', () => {
  it('exposes keyboard shortcuts help on the subscriptions table', async () => {
    mockGetLicenses.mockResolvedValue(LIVE);
    renderLicenses('/licenses');
    expect(await screen.findByText('Foundation AP')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Keyboard shortcuts' })).toBeTruthy();
  });

  it('offers Connected systems when live subscriptions are empty', async () => {
    mockGetLicenses.mockResolvedValue({
      ...LIVE,
      subscriptions: [],
      renewals: [],
      orphans: [],
    });
    render(
      <MemoryRouter
        future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
        initialEntries={['/licenses']}
      >
        <SettingsProvider>
          <ToastProvider>
            <Routes>
              <Route
                path="/licenses"
                element={
                  <>
                    <Licenses />
                    <LocationProbe />
                  </>
                }
              />
              <Route path="/systems" element={<LocationProbe />} />
            </Routes>
          </ToastProvider>
        </SettingsProvider>
      </MemoryRouter>,
    );
    expect(await screen.findByText('No subscriptions to show')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Connected systems' }));
    await waitFor(() => expect(screen.getByTestId('loc').textContent).toBe('/systems'));
  });
});
