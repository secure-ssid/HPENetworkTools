import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import Compliance from './Compliance';
import { SettingsProvider } from '../app/SettingsContext';
import { ToastProvider } from '../nightdesk';
import { getCompliance, getConfigBackups, getConfigBackupDiff, getConfigBackupVersions, syncSystems } from '../api/client';
import type { ComplianceData } from '../api/client';
import type { ConfigBackupListEnvelope } from '@hpe/shared';
import { exportTableCsv } from '../lib/csv';
import { downloadApiCsv } from '../lib/downloadApiCsv';

vi.mock('../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/client')>();
  return {
    ...actual,
    getCompliance: vi.fn(),
    syncSystems: vi.fn(),
    // Null by default: the drift section is additive and hides itself when the
    // backup API does not answer, which is what the pre-existing suites assert.
    getConfigBackups: vi.fn(() => Promise.resolve(null)),
    getConfigBackupVersions: vi.fn(),
    getConfigBackupDiff: vi.fn(),
  };
});

vi.mock('../lib/csv', () => ({
  exportTableCsv: vi.fn((_filename: string, _headers: string[], rows: Array<Array<unknown>>) => rows.length),
}));

vi.mock('../lib/downloadApiCsv', () => ({
  downloadApiCsv: vi.fn(),
}));

vi.mock('../components/VisualReferencePanel', () => ({
  VisualReferencePanel: () => <div data-testid="visual-refs">Visual references</div>,
}));

vi.mock('../components/ConfigRecommendationsPanel', () => ({
  ConfigRecommendationsPanel: ({ title }: { title?: string }) => (
    <div data-testid="config-recs">{title ?? 'Recommendations'}</div>
  ),
}));

const mockGetCompliance = vi.mocked(getCompliance);
const mockSyncSystems = vi.mocked(syncSystems);
const mockGetConfigBackups = vi.mocked(getConfigBackups);
const mockGetConfigBackupVersions = vi.mocked(getConfigBackupVersions);
const mockGetConfigBackupDiff = vi.mocked(getConfigBackupDiff);
const mockExportTableCsv = vi.mocked(exportTableCsv);
const mockDownloadApiCsv = vi.mocked(downloadApiCsv);

const LIVE_COVERAGE: ComplianceData = {
  dataSource: 'live',
  evidenceMode: 'coverage',
  stats: [
    { label: 'Evidence checks', value: '4', delta: 'current poller snapshot', tone: 'neutral' },
  ],
  findings: [
    {
      sev: 'low',
      tone: 'info',
      title: 'Firmware evidence not reported',
      detail: 'The linked plane did not supply this field',
      rule: 'scan.coverage.firmware',
      plane: 'CENTRAL',
      count: '1',
      fix: 'ssh scan',
      fixColor: 'var(--nd-text-muted)',
      device: 'ap-1',
      baseline: 'Live evidence coverage',
    },
  ],
  baselines: [
    { label: 'Firmware evidence', value: 0, note: '0 of 1 devices have usable live evidence' },
  ],
  diff: 'Live evidence coverage\n- Firmware evidence: 0 of 1 devices have usable live evidence',
};

/** One check, two planes: the live route emits one finding per (rule, plane). */
const LIVE_SAME_RULE_TWO_PLANES: ComplianceData = {
  ...LIVE_COVERAGE,
  findings: [
    { ...LIVE_COVERAGE.findings[0], plane: 'CENTRAL', device: 'ap-1', count: '1' },
    { ...LIVE_COVERAGE.findings[0], plane: 'MIST', device: 'ap-9', count: '4' },
    // A manual fix carries the server's amber token, not the muted one.
    {
      ...LIVE_COVERAGE.findings[0],
      rule: 'inventory.reconciliation',
      title: 'Device ownership needs reconciliation',
      plane: 'CENTRAL',
      device: 'sw-core-a',
      count: '2',
      fix: 'manual',
      fixColor: 'var(--nd-warning)',
    },
  ],
};

/** Live mode with no plane returning device inventory: nothing to score. */
const LIVE_UNAVAILABLE: ComplianceData = {
  dataSource: 'live',
  evidenceMode: 'unavailable',
  stats: [],
  findings: [],
  baselines: [],
  diff: '',
};

function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="loc">{`${loc.pathname}${loc.search}`}</div>;
}

function renderCompliance(initialPath = '/compliance') {
  return render(
    <MemoryRouter
      initialEntries={[initialPath]}
      future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
    >
      <SettingsProvider>
        <ToastProvider>
          <Compliance />
          <LocationProbe />
        </ToastProvider>
      </SettingsProvider>
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  /* clearAllMocks drops implementations — restore additive API defaults. */
  mockGetConfigBackups.mockResolvedValue(null);
  mockGetCompliance.mockReset();
  mockSyncSystems.mockReset();
});

describe('Compliance live evidence coverage', () => {
  it('labels inventory checks honestly and refreshes them through the poller', async () => {
    mockGetCompliance.mockResolvedValue(LIVE_COVERAGE);
    mockSyncSystems.mockResolvedValue({ ok: true, message: '1 linked system synchronized' });

    renderCompliance();

    expect(await screen.findByText('Coverage findings are not configuration drift')).toBeTruthy();
    expect(screen.getByText('Firmware evidence not reported')).toBeTruthy();
    expect(screen.queryByText('Push fix to 2 devices')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Run scan now' }));
    await waitFor(() => expect(mockSyncSystems).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(mockGetCompliance).toHaveBeenCalledTimes(2));
  });
});

describe('Compliance findings table', () => {
  it('renders every (rule, plane) finding and colours the fix class from the payload token', async () => {
    mockGetCompliance.mockResolvedValue(LIVE_SAME_RULE_TWO_PLANES);

    const { container } = renderCompliance();
    await screen.findByText('Device ownership needs reconciliation');

    // Three findings share two rule strings — all three rows must survive.
    const bodyRows = container.querySelectorAll('tbody tr');
    expect(bodyRows).toHaveLength(3);
    expect(screen.getByText('3 of 3 findings · poller snapshot not stamped yet')).toBeTruthy();

    // fixColor is the payload's own token: muted → neutral, warning → warning.
    const fixBadges = Array.from(container.querySelectorAll('tbody tr'))
      .map((row) => row.querySelector('td:last-child .nd-badge'))
      .map((badge) => badge?.className ?? '');
    expect(fixBadges[0]).toContain('nd-badge--neutral');
    expect(fixBadges[2]).toContain('nd-badge--warning');
  });
});

/* The count is the link, and a finding is every device of one plane that
   failed one check. It used to navigate to /devices/<f.device>, the first row
   of the group — so a count of 4 opened one device, chosen by iteration
   order, and nothing on the way said the other three had been dropped. */
describe('Compliance finding count link', () => {
  function Probe() {
    const location = useLocation();
    return <div data-testid="loc">{`${location.pathname}${location.search}`}</div>;
  }

  function renderWithRouting() {
    return render(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }} initialEntries={['/compliance']}>
        <SettingsProvider>
          <ToastProvider>
            <Routes>
              <Route path="/compliance" element={<Compliance />} />
              <Route path="/devices" element={<Probe />} />
              <Route path="/devices/:name" element={<Probe />} />
            </Routes>
          </ToastProvider>
        </SettingsProvider>
      </MemoryRouter>,
    );
  }

  it('opens every device the count counted, not just the first', async () => {
    mockGetCompliance.mockResolvedValue({
      ...LIVE_COVERAGE,
      findings: [
        {
          ...LIVE_COVERAGE.findings[0],
          count: '4',
          device: 'ap-9',
          devices: ['ap-9', 'ap-10', 'ap-11', 'ap-12'],
        },
      ],
    });

    renderWithRouting();
    // By role: the 'Evidence checks' stat tile also renders a bare 4.
    fireEvent.click(await screen.findByRole('button', { name: '4' }));

    const loc = screen.getByTestId('loc').textContent ?? '';
    expect(loc.startsWith('/devices?names=')).toBe(true);
    const names = new URL(loc, 'http://x').searchParams.get('names');
    expect(names?.split('\n')).toEqual(['ap-9', 'ap-10', 'ap-11', 'ap-12']);
  });

  /* Guard: one device is still one device, and the drill-down straight to it
     is the more useful link. */
  it('opens the device itself when the finding covers exactly one', async () => {
    mockGetCompliance.mockResolvedValue({
      ...LIVE_COVERAGE,
      findings: [{ ...LIVE_COVERAGE.findings[0], count: '1', device: 'ap-1', devices: ['ap-1'] }],
    });

    renderWithRouting();
    fireEvent.click(await screen.findByRole('button', { name: '1' }));
    expect(screen.getByTestId('loc').textContent).toBe('/devices/ap-1');
  });

  /* Demo fixtures predate the field and carry only `device`. */
  it('falls back to the single device when a finding carries no set', async () => {
    mockGetCompliance.mockResolvedValue(LIVE_COVERAGE);
    renderWithRouting();
    fireEvent.click(await screen.findByRole('button', { name: '1' }));
    expect(screen.getByTestId('loc').textContent).toBe('/devices/ap-1');
  });
});

describe('Compliance with no live evidence', () => {
  it('explains the empty findings and baseline lists instead of rendering blank chrome', async () => {
    mockGetCompliance.mockResolvedValue(LIVE_UNAVAILABLE);

    renderCompliance();

    expect(await screen.findByText('No findings to report')).toBeTruthy();
    expect(screen.getByText('No linked plane returned device inventory, so no evidence check could run.')).toBeTruthy();
    expect(screen.getByText('No baseline results')).toBeTruthy();
  });

  it('renders the unavailable Alert in the page body, not inside the 210px baseline Select', async () => {
    mockGetCompliance.mockResolvedValue(LIVE_UNAVAILABLE);

    renderCompliance();

    const alert = await screen.findByText('No live inventory evidence is available');
    expect(alert.closest('[style*="width: 210px"]')).toBeNull();
  });
});

/* evidenceMode 'coverage' only means SOMETHING was read. The route's guard is
 * datasetReported('devices'), true as soon as one plane answers — so a scan
 * over one plane's devices while another linked plane's whole inventory went
 * unread rendered as an ordinary, complete coverage report. This is the screen
 * an operator would screenshot for an audit. */
/* The demo scan reports 900 ms after it is asked for, and the operator can
   have moved on by then. A stranded setState is quiet; a toast is app-level
   chrome, so 'Scan complete' announced a run of a screen the operator was no
   longer looking at, on whatever screen they had reached. */
describe('Compliance scan finishing after the operator has left', () => {
  function Away() {
    const navigate = useNavigate();
    return (
      <button type="button" onClick={() => navigate('/elsewhere')}>
        leave
      </button>
    );
  }

  /* ToastProvider stays mounted above the routes, exactly as the app shell
     holds it — unmounting the provider too would hide the bug rather than
     test it. */
  function renderRoutable() {
    return render(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }} initialEntries={['/compliance']}>
        <SettingsProvider>
          <ToastProvider>
            <Away />
            <Routes>
              <Route path="/compliance" element={<Compliance />} />
              <Route path="/elsewhere" element={<div>somewhere else</div>} />
            </Routes>
          </ToastProvider>
        </SettingsProvider>
      </MemoryRouter>,
    );
  }

  const DEMO: ComplianceData = { ...LIVE_COVERAGE, dataSource: 'demo' };

  it('does not announce the scan on the screen the operator moved to', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      mockGetCompliance.mockResolvedValue(DEMO);
      renderRoutable();
      fireEvent.click(await screen.findByText('Run scan now'));
      fireEvent.click(screen.getByText('leave'));
      expect(screen.getByText('somewhere else')).toBeTruthy();

      await act(async () => {
        vi.advanceTimersByTime(2_000);
      });
      expect(screen.queryByText(/Scan complete/)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  /* Guard: the announcement is the point of the button when the operator is
     still there to read it. */
  it('still announces the scan to an operator who stayed', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      mockGetCompliance.mockResolvedValue(DEMO);
      renderRoutable();
      fireEvent.click(await screen.findByText('Run scan now'));

      await act(async () => {
        vi.advanceTimersByTime(2_000);
      });
      expect(screen.getByText(/Scan complete/)).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('Compliance scan scope', () => {
  it('says which planes the scan does not cover, above everything it claims', async () => {
    mockGetCompliance.mockResolvedValue({
      ...LIVE_COVERAGE,
      missingInventories: ['CENTRAL', 'MIST'],
    } as ComplianceData);
    renderCompliance();

    expect(await screen.findByText('This scan does not cover CENTRAL, MIST')).toBeTruthy();
    expect(screen.getByText(/not a verdict on the estate/)).toBeTruthy();
  });

  it('uses the singular when exactly one plane is missing', async () => {
    mockGetCompliance.mockResolvedValue({
      ...LIVE_COVERAGE,
      missingInventories: ['CENTRAL'],
    } as ComplianceData);
    renderCompliance();

    expect(await screen.findByText('This scan does not cover CENTRAL')).toBeTruthy();
    expect(screen.getByText(/That plane is linked but contributed no device inventory/)).toBeTruthy();
  });

  it('stays silent when the scan covers every linked inventory', async () => {
    mockGetCompliance.mockResolvedValue({ ...LIVE_COVERAGE, missingInventories: [] } as ComplianceData);
    renderCompliance();

    await waitFor(() => expect(mockGetCompliance).toHaveBeenCalled());
    expect(screen.queryByText(/does not cover/)).toBeNull();
  });

  it('stays silent when the route said nothing about scan scope', async () => {
    // Absent is not empty: an older server that never looked must not render
    // as one that looked and found the scan complete.
    mockGetCompliance.mockResolvedValue(LIVE_COVERAGE);
    renderCompliance();

    await waitFor(() => expect(mockGetCompliance).toHaveBeenCalled());
    expect(screen.queryByText(/does not cover/)).toBeNull();
  });
});

/* The 'Config drift' stat card and the versioned-backup drift section + drawer.
   The card's numbers come from the server's liveComplianceData (the backup
   service's rollup); the section lists only DRIFTED devices and opens the
   unified diff between the two newest snapshots — demo synthesis is labelled. */
describe('Compliance config drift (running-config backups)', () => {
  const BACKUPS: ConfigBackupListEnvelope = {
    dataSource: 'demo',
    note: 'synthesized demo snapshots — no device was contacted',
    devices: [
      {
        device: 'sw-core-a',
        plane: 'LOCAL',
        ip: '10.42.0.10',
        status: 'ok',
        versions: 2,
        drift: true,
        latest: {
          version: 2,
          takenAt: '2026-07-25T12:00:00Z',
          source: 'demo synthesis',
          lines: 22,
          sha256: 'a'.repeat(64),
          driftFromPrevious: true,
        },
      },
      {
        device: 'sw-core-b',
        plane: 'LOCAL',
        ip: '10.42.0.11',
        status: 'ok',
        versions: 1,
        drift: false,
        latest: {
          version: 1,
          takenAt: '2026-07-25T12:00:00Z',
          source: 'demo synthesis',
          lines: 20,
          sha256: 'b'.repeat(64),
          driftFromPrevious: false,
        },
      },
      {
        device: 'ap-1f-04',
        plane: 'CENTRAL',
        ip: null,
        status: 'no-source',
        note: 'cloud-claimed device class — the portal has no read-only config channel for it',
        versions: 0,
        latest: null,
        drift: false,
      },
    ],
    summary: { total: 3, eligible: 2, backedUp: 2, drift: 1, failed: 0 },
  };

  const LIT_CARD: ComplianceData = {
    ...LIVE_COVERAGE,
    stats: [
      ...LIVE_COVERAGE.stats,
      { label: 'Config drift', value: '1', delta: 'of 2 devices with config snapshots', tone: 'negative' },
    ],
  };

  it('lights the stat card from the payload instead of the dead em-dash', async () => {
    mockGetCompliance.mockResolvedValue(LIT_CARD);
    renderCompliance();

    expect(await screen.findByText('Config drift')).toBeTruthy();
    expect(screen.getByText('of 2 devices with config snapshots')).toBeTruthy();
    expect(screen.queryByText('no running-config baseline source')).toBeNull();
  });

  it('lists only drifted devices, with the demo provenance label', async () => {
    mockGetCompliance.mockResolvedValue(LIT_CARD);
    mockGetConfigBackups.mockResolvedValue(BACKUPS);
    renderCompliance();

    expect(await screen.findByText('Config drift — running-config snapshots')).toBeTruthy();
    expect(screen.getByText('2 backed up · 1 drifting')).toBeTruthy();
    expect(screen.getByText('synthesized demo snapshots — no device was contacted')).toBeTruthy();
    expect(screen.getByText('sw-core-a')).toBeTruthy();
    // A backed-up device WITHOUT drift is not a finding; neither is a
    // no-source AP. Only the drifted row is listed.
    expect(screen.queryByText('sw-core-b')).toBeNull();
    expect(screen.queryByText('ap-1f-04')).toBeNull();
  });

  it('Download server CSV hits config-backups export with drift=1 (Loop 96)', async () => {
    mockGetCompliance.mockResolvedValue(LIT_CARD);
    mockGetConfigBackups.mockResolvedValue(BACKUPS);
    mockDownloadApiCsv.mockResolvedValue({ ok: true });
    renderCompliance();

    expect(await screen.findByText('Config drift — running-config snapshots')).toBeTruthy();
    // Findings header also has Download server CSV — click the one under the drift section.
    const driftLabel = screen.getByText('Config drift — running-config snapshots');
    const section = driftLabel.closest('.nt-stack-col') ?? driftLabel.parentElement?.parentElement;
    if (!section) throw new Error('drift section not found');
    const buttons = within(section as HTMLElement).getAllByRole('button', { name: 'Download server CSV' });
    fireEvent.click(buttons[0]!);
    await waitFor(() =>
      expect(mockDownloadApiCsv).toHaveBeenCalledWith(
        '/api/config-backups/export?drift=1',
        'config-backups.csv',
      ),
    );
  });

  it('says so honestly when nothing drifts', async () => {
    mockGetCompliance.mockResolvedValue(LIT_CARD);
    mockGetConfigBackups.mockResolvedValue({
      ...BACKUPS,
      devices: BACKUPS.devices.filter((d) => !d.drift),
      summary: { ...BACKUPS.summary, drift: 0 },
    });
    renderCompliance();

    expect(await screen.findByText('No drift across 2 devices with snapshots.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'View diff' })).toBeNull();
  });

  it('opens the drawer with the unified diff between the two newest versions', async () => {
    mockGetCompliance.mockResolvedValue(LIT_CARD);
    mockGetConfigBackups.mockResolvedValue(BACKUPS);
    mockGetConfigBackupVersions.mockResolvedValue({
      device: 'sw-core-a',
      versions: [
        { version: 2, takenAt: '2026-07-25T12:00:00Z', source: 'demo synthesis', lines: 22, sha256: 'a'.repeat(64), driftFromPrevious: true },
        { version: 1, takenAt: '2026-07-25T06:00:00Z', source: 'demo synthesis', lines: 20, sha256: 'b'.repeat(64), driftFromPrevious: false },
      ],
    });
    mockGetConfigBackupDiff.mockResolvedValue({
      device: 'sw-core-a',
      fromVersion: 1,
      toVersion: 2,
      fromTakenAt: '2026-07-25T06:00:00Z',
      toTakenAt: '2026-07-25T12:00:00Z',
      added: 2,
      removed: 1,
      collapsed: false,
      lines: [
        { kind: 'same', text: 'hostname sw-core-a' },
        { kind: 'del', text: 'ntp server 10.42.0.20 iburst' },
        { kind: 'add', text: 'ntp server 10.42.0.21 iburst' },
        { kind: 'add', text: 'vlan 99' },
      ],
      text: '  hostname sw-core-a\n- ntp server 10.42.0.20 iburst\n+ ntp server 10.42.0.21 iburst\n+ vlan 99',
    });
    renderCompliance();

    fireEvent.click(await screen.findByRole('button', { name: 'View diff' }));

    // Older first: v1 → v2, never the newest-guess order.
    await waitFor(() => expect(mockGetConfigBackupDiff).toHaveBeenCalledWith('sw-core-a', 1, 2));
    expect(await screen.findByText('Config drift — sw-core-a')).toBeTruthy();
    expect(screen.getByText('v1 → v2 · +2 −1 · demo synthesis')).toBeTruthy();
    expect(screen.getByText(/- ntp server 10\.42\.0\.20 iburst/)).toBeTruthy();
    expect(screen.getByText(/\+ ntp server 10\.42\.0\.21 iburst/)).toBeTruthy();
  });

  it('tells the operator when there are not two snapshots to diff', async () => {
    mockGetCompliance.mockResolvedValue(LIT_CARD);
    mockGetConfigBackups.mockResolvedValue(BACKUPS);
    mockGetConfigBackupVersions.mockResolvedValue({
      device: 'sw-core-a',
      versions: [
        { version: 2, takenAt: '2026-07-25T12:00:00Z', source: 'demo synthesis', lines: 22, sha256: 'a'.repeat(64), driftFromPrevious: true },
      ],
    });
    renderCompliance();

    fireEvent.click(await screen.findByRole('button', { name: 'View diff' }));

    expect(await screen.findByText('Diff unavailable')).toBeTruthy();
    expect(mockGetConfigBackupDiff).not.toHaveBeenCalled();
  });

  it('hides the section entirely when the backup API does not answer', async () => {
    mockGetCompliance.mockResolvedValue(LIT_CARD);
    mockGetConfigBackups.mockResolvedValue(null);
    renderCompliance();

    await screen.findByText('Firmware evidence not reported');
    expect(screen.queryByText('Config drift — running-config snapshots')).toBeNull();
  });
});


// ---------------------------------------------------------------------------
// The findings table is a nightdesk DataTable: the column manager persists
// through SettingsContext (localStorage key 'nt-table-columns' under the
// 'compliance' table id), and Sev is the one tinted column — with the
// finding's own severity tone, the same field the Sev Badge renders. The rows
// are deliberately NOT a keyboard grid: a finding row has no primary action
// (the device count is a nested button, keyboard-reachable on its own), so
// there is nothing honest for Enter to do. These tests pin the wiring, not
// the mechanics.
// ---------------------------------------------------------------------------
describe('Compliance findings table superpowers', () => {
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

  it('hides and restores a column from View options, persisted to localStorage', async () => {
    mockGetCompliance.mockResolvedValue(LIVE_COVERAGE);
    const { container } = renderCompliance();
    await screen.findByText('Firmware evidence not reported');
    expect(container.querySelector('th[data-column-key="rule"]')).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'View options' }));
    // The primary identifier is not offered for hiding.
    expect(screen.getByRole('checkbox', { name: 'Finding' }).hasAttribute('disabled')).toBe(true);

    fireEvent.click(screen.getByRole('checkbox', { name: 'Rule' }));
    expect(container.querySelector('th[data-column-key="rule"]')).toBeNull();
    expect(JSON.parse(localStorage.getItem('nt-table-columns') ?? '{}')).toEqual({
      compliance: { hidden: ['rule'] },
    });

    fireEvent.click(screen.getByRole('checkbox', { name: 'Rule' }));
    expect(container.querySelector('th[data-column-key="rule"]')).not.toBeNull();
  });

  it('seeds the table from the persisted column config on mount', async () => {
    localStorage.setItem('nt-table-columns', JSON.stringify({ compliance: { hidden: ['rule'] } }));
    mockGetCompliance.mockResolvedValue(LIVE_COVERAGE);
    const { container } = renderCompliance();
    await screen.findByText('Firmware evidence not reported');
    expect(container.querySelector('th[data-column-key="rule"]')).toBeNull();
    expect(container.querySelector('th[data-column-key="fix"]')).not.toBeNull();
  });

  /* Severity is the one value on the row that is itself a threshold
     judgement, and the payload already computed it: high → danger,
     med → warning, low → info, cell wash and Badge off the same field. */
  it('tints the Sev cell with the finding’s own severity tone', async () => {
    mockGetCompliance.mockResolvedValue({
      ...LIVE_COVERAGE,
      findings: [
        { ...LIVE_COVERAGE.findings[0], sev: 'high', tone: 'danger', title: 'sev-high', device: 'd-1' },
        { ...LIVE_COVERAGE.findings[0], sev: 'med', tone: 'warning', title: 'sev-med', device: 'd-2' },
        { ...LIVE_COVERAGE.findings[0], sev: 'low', tone: 'info', title: 'sev-low', device: 'd-3' },
      ],
    });
    const { container } = renderCompliance();
    await screen.findByText('sev-high');

    const rows = Array.from(container.querySelectorAll('tbody tr'));
    expect(rows).toHaveLength(3);
    const sevClass = (row: Element) => (row.querySelector('td') as HTMLElement).className;
    expect(sevClass(rows[0])).toContain('nd-table__td--tint-danger');
    expect(sevClass(rows[1])).toContain('nd-table__td--tint-warning');
    expect(sevClass(rows[2])).toContain('nd-table__td--tint-info');
    // …and only Sev: no other cell on the row carries a threshold.
    expect((rows[0].querySelectorAll('td')[1] as HTMLElement).className).not.toContain('tint');
  });

  it('is a selection keyboard grid without a primary Enter action (Loop 162 bulk)', async () => {
    mockGetCompliance.mockResolvedValue(LIVE_COVERAGE);
    const { container } = renderCompliance();
    await screen.findByText('Firmware evidence not reported');

    /* Multi-select enables the DataTable keyboard grid (x toggles); there is
     * still no onRowActivate, so Enter must not navigate or open anything.
     * Shortcuts help is expected whenever the grid is armed for selection. */
    expect(container.querySelector('table')?.getAttribute('role')).toBe('grid');
    const rows = Array.from(container.querySelectorAll('tbody tr'));
    expect(rows.length).toBeGreaterThan(0);
    const first = rows[0] as HTMLElement;
    first.focus();
    fireEvent.keyDown(first, { key: 'Enter' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('button', { name: 'Keyboard shortcuts' })).toBeTruthy();
  });
});

/* Loop 45 — export, share, server CSV, recommendations, baseline deep-link. */
describe('Compliance export, share, and recommendations', () => {
  beforeEach(() => {
    mockExportTableCsv.mockClear();
    mockDownloadApiCsv.mockReset();
  });

  it('exports the findings currently in view (baseline filter applied)', async () => {
    mockGetCompliance.mockResolvedValue(LIVE_SAME_RULE_TWO_PLANES);
    renderCompliance();
    await screen.findByText('Device ownership needs reconciliation');

    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }));
    expect(mockExportTableCsv).toHaveBeenCalledTimes(1);
    const [filename, headers, rows] = mockExportTableCsv.mock.calls[0]!;
    expect(filename).toBe('compliance-findings');
    expect(headers).toContain('baseline');
    expect(headers).toContain('rule');
    expect(rows).toHaveLength(3);
    expect(await screen.findByText(/Exported 3 findings/)).toBeTruthy();
  });

  it('offers Download server CSV on live payloads and hits /api/compliance/export', async () => {
    mockDownloadApiCsv.mockResolvedValue({ ok: true });
    mockGetCompliance.mockResolvedValue(LIVE_COVERAGE);
    renderCompliance();
    await screen.findByText('Firmware evidence not reported');

    fireEvent.click(screen.getByRole('button', { name: 'Download server CSV' }));
    await waitFor(() =>
      expect(mockDownloadApiCsv).toHaveBeenCalledWith('/api/compliance/export', 'compliance-findings.csv'),
    );
    expect(await screen.findByText(/Server CSV downloaded/i)).toBeTruthy();
  });

  /* Loop 75 — server CSV carries the same baseline/sev/plane slice as the filter row. */
  it('passes active filters into Download server CSV path', async () => {
    mockDownloadApiCsv.mockResolvedValue({ ok: true });
    mockGetCompliance.mockResolvedValue({
      ...LIVE_COVERAGE,
      findings: [
        {
          ...LIVE_COVERAGE.findings[0],
          sev: 'high',
          tone: 'danger',
          plane: 'CENTRAL',
          baseline: 'Live evidence coverage',
          title: 'high-central-export',
        },
        {
          ...LIVE_COVERAGE.findings[0],
          sev: 'low',
          tone: 'info',
          plane: 'MIST',
          baseline: 'Live evidence coverage',
          title: 'low-mist-export',
          rule: 'r.low',
        },
      ],
    });
    render(
      <MemoryRouter
        future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
        initialEntries={['/compliance?sev=high&plane=CENTRAL&baseline=Live%20evidence%20coverage']}
      >
        <SettingsProvider>
          <ToastProvider>
            <Compliance />
          </ToastProvider>
        </SettingsProvider>
      </MemoryRouter>,
    );
    expect(await screen.findByText('high-central-export')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Download server CSV' }));
    await waitFor(() => expect(mockDownloadApiCsv).toHaveBeenCalled());
    const path = String(mockDownloadApiCsv.mock.calls[0]?.[0] ?? '');
    expect(path.startsWith('/api/compliance/export?')).toBe(true);
    expect(path).toMatch(/sev=high/);
    expect(path).toMatch(/plane=CENTRAL/);
    expect(path).toMatch(/baseline=Live(\+|%20)evidence(\+|%20)coverage/);
  });

  /* Loop 92 — free-text q= on share + client filter + server CSV. */
  it('seeds q from URL, filters the table, and passes q on Download server CSV', async () => {
    mockDownloadApiCsv.mockResolvedValue({ ok: true });
    mockGetCompliance.mockResolvedValue({
      ...LIVE_COVERAGE,
      findings: [
        {
          ...LIVE_COVERAGE.findings[0],
          title: 'Firmware evidence not reported',
          detail: 'missing train on sw-core-a',
          rule: 'fw.train',
          device: 'sw-core-a',
        },
        {
          ...LIVE_COVERAGE.findings[0],
          title: 'Other finding',
          detail: 'unrelated',
          rule: 'other.rule',
          device: 'ap-1',
        },
      ],
    });
    render(
      <MemoryRouter
        future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
        initialEntries={['/compliance?q=firmware']}
      >
        <SettingsProvider>
          <ToastProvider>
            <Compliance />
          </ToastProvider>
        </SettingsProvider>
      </MemoryRouter>,
    );
    expect(await screen.findByText('Firmware evidence not reported')).toBeTruthy();
    expect(screen.queryByText('Other finding')).toBeNull();
    const search = screen.getByRole('textbox', { name: 'Search findings' }) as HTMLInputElement;
    expect(search.value).toBe('firmware');
    fireEvent.click(screen.getByRole('button', { name: 'Download server CSV' }));
    await waitFor(() => expect(mockDownloadApiCsv).toHaveBeenCalled());
    const path = String(mockDownloadApiCsv.mock.calls[0]?.[0] ?? '');
    expect(path).toMatch(/\/api\/compliance\/export\?/);
    expect(path).toMatch(/q=firmware/);
  });

  it('hides Download server CSV on demo fixtures', async () => {
    mockGetCompliance.mockResolvedValue({ ...LIVE_COVERAGE, dataSource: 'demo' });
    renderCompliance();
    await screen.findByText('Firmware evidence not reported');
    expect(screen.getByRole('button', { name: 'Export CSV' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Download server CSV' })).toBeNull();
  });

  it('Copy filter link writes ?baseline= when a baseline is selected', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    mockGetCompliance.mockResolvedValue(LIVE_COVERAGE);
    renderCompliance();
    await screen.findByText('Firmware evidence not reported');

    fireEvent.change(screen.getByRole('combobox', { name: 'Baseline' }), {
      target: { value: 'Live evidence coverage' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Copy filter link' }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    const copied = new URL(String(writeText.mock.calls[0]![0]));
    expect(copied.searchParams.get('baseline')).toBe('Live evidence coverage');
    expect(screen.getByText(/Filter link copied/i)).toBeTruthy();
  });

  it('seeds the baseline filter from ?baseline=', async () => {
    mockGetCompliance.mockResolvedValue({
      ...LIVE_SAME_RULE_TWO_PLANES,
      findings: [
        { ...LIVE_COVERAGE.findings[0], baseline: 'Live evidence coverage', title: 'cov-only', device: 'ap-1' },
        {
          ...LIVE_COVERAGE.findings[0],
          baseline: 'Other baseline',
          title: 'other-only',
          device: 'ap-2',
          rule: 'other.rule',
        },
      ],
    });
    render(
      <MemoryRouter
        future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
        initialEntries={['/compliance?baseline=Other%20baseline']}
      >
        <SettingsProvider>
          <ToastProvider>
            <Compliance />
          </ToastProvider>
        </SettingsProvider>
      </MemoryRouter>,
    );
    expect(await screen.findByText('other-only')).toBeTruthy();
    expect(screen.queryByText('cov-only')).toBeNull();
    expect(screen.getByText(/1 of 2 findings/)).toBeTruthy();
  });

  it('mounts VisualReference and Compliance recommendations panels', async () => {
    mockGetCompliance.mockResolvedValue(LIVE_COVERAGE);
    renderCompliance();
    await screen.findByText('Firmware evidence not reported');
    expect(screen.getByTestId('visual-refs')).toBeTruthy();
    expect(screen.getByTestId('config-recs').textContent).toMatch(/Compliance recommendations/i);
  });
});

/* Loop 61 — severity/plane share completeness. */
describe('Compliance filter share completeness (Loop 61)', () => {
  it('seeds sev+plane from the URL and Copy filter link keeps them with baseline', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    mockGetCompliance.mockResolvedValue({
      ...LIVE_SAME_RULE_TWO_PLANES,
      findings: [
        {
          ...LIVE_COVERAGE.findings[0],
          sev: 'high',
          tone: 'danger',
          plane: 'CENTRAL',
          baseline: 'Live evidence coverage',
          title: 'high-central',
          device: 'ap-1',
          rule: 'r.high',
        },
        {
          ...LIVE_COVERAGE.findings[0],
          sev: 'low',
          tone: 'info',
          plane: 'MIST',
          baseline: 'Live evidence coverage',
          title: 'low-mist',
          device: 'ap-2',
          rule: 'r.low',
        },
      ],
    });

    render(
      <MemoryRouter
        future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
        initialEntries={['/compliance?sev=high&plane=CENTRAL']}
      >
        <SettingsProvider>
          <ToastProvider>
            <Compliance />
          </ToastProvider>
        </SettingsProvider>
      </MemoryRouter>,
    );

    expect(await screen.findByText('high-central')).toBeTruthy();
    expect(screen.queryByText('low-mist')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Copy filter link' }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    const copied = String(writeText.mock.calls[0]?.[0] ?? '');
    expect(copied).toMatch(/sev=high/);
    expect(copied).toMatch(/plane=CENTRAL/);
  });
});

/* Loop 110 — fix-class filter parity. */
describe('Compliance fix filter (Loop 110)', () => {
  beforeEach(() => {
    mockDownloadApiCsv.mockReset();
  });

  it('seeds fix from URL, filters the table, and passes fix on Download server CSV', async () => {
    mockDownloadApiCsv.mockResolvedValue({ ok: true });
    mockGetCompliance.mockResolvedValue({
      ...LIVE_COVERAGE,
      findings: [
        {
          ...LIVE_COVERAGE.findings[0],
          fix: 'manual',
          fixColor: 'var(--nd-warning)',
          title: 'manual-fix-row',
          device: 'sw-a',
          rule: 'r.manual',
        },
        {
          ...LIVE_COVERAGE.findings[0],
          fix: 'auto',
          fixColor: 'var(--nd-success)',
          title: 'auto-fix-row',
          device: 'sw-b',
          rule: 'r.auto',
        },
      ],
    });

    render(
      <MemoryRouter
        future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
        initialEntries={['/compliance?fix=manual']}
      >
        <SettingsProvider>
          <ToastProvider>
            <Compliance />
          </ToastProvider>
        </SettingsProvider>
      </MemoryRouter>,
    );

    expect(await screen.findByText('manual-fix-row')).toBeTruthy();
    expect(screen.queryByText('auto-fix-row')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Download server CSV' }));
    await waitFor(() => expect(mockDownloadApiCsv).toHaveBeenCalled());
    const path = String(mockDownloadApiCsv.mock.calls[0]?.[0] ?? '');
    expect(path).toMatch(/fix=manual/);
  });
});

/* Loop 143 — Plane chip row toggles the same plane= filter as the Select. */
describe('Compliance plane chips (Loop 143)', () => {
  function LocationProbe() {
    const location = useLocation();
    return <div data-testid="loc">{`${location.pathname}${location.search}`}</div>;
  }

  it('plane chips filter findings and write plane back to the URL', async () => {
    mockGetCompliance.mockResolvedValue({
      ...LIVE_COVERAGE,
      findings: [
        {
          ...LIVE_COVERAGE.findings[0],
          sev: 'high',
          tone: 'danger',
          title: 'plane-central',
          device: 'd-central',
          rule: 'r.central',
          plane: 'CENTRAL',
        },
        {
          ...LIVE_COVERAGE.findings[0],
          sev: 'high',
          tone: 'danger',
          title: 'plane-mist',
          device: 'd-mist',
          rule: 'r.mist',
          plane: 'MIST',
        },
      ],
    });

    render(
      <MemoryRouter
        future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
        initialEntries={['/compliance']}
      >
        <SettingsProvider>
          <ToastProvider>
            <Routes>
              <Route
                path="/compliance"
                element={
                  <>
                    <Compliance />
                    <LocationProbe />
                  </>
                }
              />
            </Routes>
          </ToastProvider>
        </SettingsProvider>
      </MemoryRouter>,
    );

    expect(await screen.findByText('plane-central')).toBeTruthy();
    expect(screen.getByText('plane-mist')).toBeTruthy();
    const chips = screen.getByRole('group', { name: 'Finding plane' });
    const mist = within(chips).getByRole('button', { name: /MIST/i });
    expect(mist.getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(mist);
    await waitFor(() => expect(screen.getByTestId('loc').textContent).toContain('plane=MIST'));
    expect(screen.getByText('plane-mist')).toBeTruthy();
    expect(screen.queryByText('plane-central')).toBeNull();
    expect(mist.getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(mist);
    await waitFor(() => expect(screen.getByTestId('loc').textContent).not.toContain('plane='));
    expect(screen.getByText('plane-central')).toBeTruthy();
    expect(screen.getByText('plane-mist')).toBeTruthy();
  });
});

/* Loop 133 — Severity chip row toggles the same sev= filter as the Select. */
describe('Compliance severity chips (Loop 133)', () => {
  function LocationProbe() {
    const location = useLocation();
    return <div data-testid="loc">{`${location.pathname}${location.search}`}</div>;
  }

  it('severity chips filter findings and write sev back to the URL', async () => {
    mockGetCompliance.mockResolvedValue({
      ...LIVE_COVERAGE,
      findings: [
        {
          ...LIVE_COVERAGE.findings[0],
          sev: 'high',
          tone: 'danger',
          title: 'chip-high',
          device: 'd-high',
          rule: 'r.high',
        },
        {
          ...LIVE_COVERAGE.findings[0],
          sev: 'low',
          tone: 'info',
          title: 'chip-low',
          device: 'd-low',
          rule: 'r.low',
        },
      ],
    });

    render(
      <MemoryRouter
        future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
        initialEntries={['/compliance']}
      >
        <SettingsProvider>
          <ToastProvider>
            <Routes>
              <Route
                path="/compliance"
                element={
                  <>
                    <Compliance />
                    <LocationProbe />
                  </>
                }
              />
            </Routes>
          </ToastProvider>
        </SettingsProvider>
      </MemoryRouter>,
    );

    expect(await screen.findByText('chip-high')).toBeTruthy();
    expect(screen.getByText('chip-low')).toBeTruthy();
    const chips = screen.getByRole('group', { name: 'Finding severity' });
    const high = within(chips).getByRole('button', { name: /High/i });
    fireEvent.click(high);
    await waitFor(() => expect(screen.getByTestId('loc').textContent).toContain('sev=high'));
    expect(screen.getByText('chip-high')).toBeTruthy();
    expect(screen.queryByText('chip-low')).toBeNull();
    expect(high.getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(high);
    await waitFor(() => expect(screen.getByTestId('loc').textContent).not.toContain('sev='));
    expect(screen.getByText('chip-low')).toBeTruthy();
  });

  it('Clear filters on empty restores findings', async () => {
    mockGetCompliance.mockResolvedValue({
      ...LIVE_COVERAGE,
      findings: [
        {
          ...LIVE_COVERAGE.findings[0],
          sev: 'high',
          tone: 'danger',
          title: 'keep-high',
          device: 'd-1',
          rule: 'r.keep',
        },
      ],
    });

    render(
      <MemoryRouter
        future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
        initialEntries={['/compliance?sev=low']}
      >
        <SettingsProvider>
          <ToastProvider>
            <Compliance />
          </ToastProvider>
        </SettingsProvider>
      </MemoryRouter>,
    );

    expect(await screen.findByText('Nothing matches these filters')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(await screen.findByText('keep-high')).toBeTruthy();
  });
});

/* Loop 146 — Fix chip row toggles the same fix= filter as the Select. */
describe('Compliance fix chips (Loop 146)', () => {
  function LocationProbe() {
    const location = useLocation();
    return <div data-testid="loc">{`${location.pathname}${location.search}`}</div>;
  }

  it('fix chips filter findings and write fix back to the URL', async () => {
    mockGetCompliance.mockResolvedValue({
      ...LIVE_COVERAGE,
      findings: [
        {
          ...LIVE_COVERAGE.findings[0],
          sev: 'high',
          tone: 'danger',
          title: 'fix-auto',
          device: 'd-auto',
          rule: 'r.auto',
          fix: 'auto',
        },
        {
          ...LIVE_COVERAGE.findings[0],
          sev: 'high',
          tone: 'danger',
          title: 'fix-manual',
          device: 'd-manual',
          rule: 'r.manual',
          fix: 'manual',
        },
      ],
    });

    render(
      <MemoryRouter
        future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
        initialEntries={['/compliance']}
      >
        <SettingsProvider>
          <ToastProvider>
            <Routes>
              <Route
                path="/compliance"
                element={
                  <>
                    <Compliance />
                    <LocationProbe />
                  </>
                }
              />
            </Routes>
          </ToastProvider>
        </SettingsProvider>
      </MemoryRouter>,
    );

    expect(await screen.findByText('fix-auto')).toBeTruthy();
    expect(screen.getByText('fix-manual')).toBeTruthy();
    const chips = screen.getByRole('group', { name: 'Finding fix class' });
    const manual = within(chips).getByRole('button', { name: /Manual/i });
    expect(manual.getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(manual);
    await waitFor(() => expect(screen.getByTestId('loc').textContent).toContain('fix=manual'));
    expect(screen.getByText('fix-manual')).toBeTruthy();
    expect(screen.queryByText('fix-auto')).toBeNull();
    expect(manual.getAttribute('aria-pressed')).toBe('true');
    expect((screen.getByLabelText('Fix class') as HTMLSelectElement).value).toBe('manual');

    fireEvent.click(manual);
    await waitFor(() => expect(screen.getByTestId('loc').textContent).not.toContain('fix='));
    expect(screen.getByText('fix-auto')).toBeTruthy();
    expect(screen.getByText('fix-manual')).toBeTruthy();
  });
});

/* Loop 152 — Baseline chip row toggles the same baseline= filter as the Select. */
describe('Compliance baseline chips (Loop 152)', () => {
  function LocationProbe() {
    const location = useLocation();
    return <div data-testid="loc">{`${location.pathname}${location.search}`}</div>;
  }

  it('baseline chips filter findings and write baseline back to the URL', async () => {
    mockGetCompliance.mockResolvedValue({
      ...LIVE_COVERAGE,
      findings: [
        {
          ...LIVE_COVERAGE.findings[0],
          title: 'base-a-finding',
          device: 'd-a',
          rule: 'r.a',
          baseline: 'Baseline A',
        },
        {
          ...LIVE_COVERAGE.findings[0],
          title: 'base-b-finding',
          device: 'd-b',
          rule: 'r.b',
          baseline: 'Baseline B',
        },
      ],
    });

    render(
      <MemoryRouter
        future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
        initialEntries={['/compliance']}
      >
        <SettingsProvider>
          <ToastProvider>
            <Routes>
              <Route
                path="/compliance"
                element={
                  <>
                    <Compliance />
                    <LocationProbe />
                  </>
                }
              />
            </Routes>
          </ToastProvider>
        </SettingsProvider>
      </MemoryRouter>,
    );

    expect(await screen.findByText('base-a-finding')).toBeTruthy();
    expect(screen.getByText('base-b-finding')).toBeTruthy();
    const chips = screen.getByRole('group', { name: 'Finding baseline' });
    const b = within(chips).getByRole('button', { name: /Baseline B/i });
    expect(b.getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(b);
    await waitFor(() => expect(screen.getByTestId('loc').textContent).toContain('baseline=Baseline+B'));
    expect(screen.getByText('base-b-finding')).toBeTruthy();
    expect(screen.queryByText('base-a-finding')).toBeNull();
    expect(b.getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(b);
    await waitFor(() => expect(screen.getByTestId('loc').textContent).not.toContain('baseline='));
    expect(screen.getByText('base-a-finding')).toBeTruthy();
    expect(screen.getByText('base-b-finding')).toBeTruthy();
  });
});


/* Loop 159 — LIVE badge honesty (pure live + blend). */
describe('Compliance Loop 159 residuals', () => {
  it('stamps LIVE on pure live findings', async () => {
    mockGetCompliance.mockResolvedValue(LIVE_COVERAGE);
    renderCompliance();
    expect(await screen.findByText('LIVE')).toBeTruthy();
  });

  it('stamps LIVE when compliance arrives via blend', async () => {
    mockGetCompliance.mockResolvedValue({
      ...LIVE_COVERAGE,
      dataSource: 'demo',
      blended: ['compliance'],
    });
    renderCompliance();
    expect(await screen.findByText('LIVE')).toBeTruthy();
  });

  it('hides LIVE on demo fixtures without blend', async () => {
    mockGetCompliance.mockResolvedValue({ ...LIVE_COVERAGE, dataSource: 'demo', blended: undefined });
    renderCompliance();
    await screen.findByText('Firmware evidence not reported');
    expect(screen.queryByText('LIVE')).toBeNull();
  });
});

/* Loop 165 — bulk Export selected on findings. */
describe('Compliance Loop 165 residuals', () => {
  it('shows bulk bar for selection: Export selected + Clear', async () => {
    mockExportTableCsv.mockClear();
    mockGetCompliance.mockResolvedValue(LIVE_COVERAGE);
    const { container } = renderCompliance();
    expect(await screen.findByText(LIVE_COVERAGE.findings[0]!.title)).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Compliance finding selection actions' })).toBeNull();

    const first = container.querySelector('tbody tr') as HTMLElement;
    expect(first).toBeTruthy();
    first.focus();
    fireEvent.keyDown(first, { key: 'x' });

    const bar = await screen.findByRole('region', { name: 'Compliance finding selection actions' });
    expect(within(bar).getByText('1 SELECTED')).toBeTruthy();
    fireEvent.click(within(bar).getByRole('button', { name: 'Export selected' }));
    expect(await screen.findByText(/Exported 1 selected finding/)).toBeTruthy();
    expect(mockExportTableCsv).toHaveBeenCalled();
    expect(String(mockExportTableCsv.mock.calls.at(-1)?.[0] ?? '')).toContain('selected');

    fireEvent.click(within(bar).getByRole('button', { name: 'Clear' }));
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: 'Compliance finding selection actions' })).toBeNull(),
    );
  });
});

/* Loop 172 — bulk Copy rules (Devices Copy serials pattern). */
describe('Compliance Loop 172 residuals', () => {
  it('Copy rules writes unique newline-joined rule ids', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    mockGetCompliance.mockResolvedValue(LIVE_SAME_RULE_TWO_PLANES);
    const { container } = renderCompliance();
    /* Same title on two plane rows — assert plural, not unique text. */
    expect((await screen.findAllByText(LIVE_SAME_RULE_TWO_PLANES.findings[0]!.title)).length).toBeGreaterThanOrEqual(2);

    const rows = container.querySelectorAll('tbody tr');
    expect(rows.length).toBeGreaterThanOrEqual(2);
    (rows[0] as HTMLElement).focus();
    fireEvent.keyDown(rows[0] as HTMLElement, { key: 'x' });
    (rows[1] as HTMLElement).focus();
    fireEvent.keyDown(rows[1] as HTMLElement, { key: 'x' });

    const bar = await screen.findByRole('region', { name: 'Compliance finding selection actions' });
    fireEvent.click(within(bar).getByRole('button', { name: 'Copy rules' }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    /* Two planes share scan.coverage.firmware — copy once. */
    expect(String(writeText.mock.calls[0]![0])).toBe('scan.coverage.firmware');
    expect(await screen.findByText(/Copied 1 rule/)).toBeTruthy();
  });
});

/* Loop 231 — findings bulk Copy names (titles) beside Copy rules. */
describe('Compliance Loop 231 residuals', () => {
  it('Copy names joins unique finding titles from the selection', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    mockGetCompliance.mockResolvedValue(LIVE_SAME_RULE_TWO_PLANES);
    const { container } = renderCompliance();
    expect(
      (await screen.findAllByText(LIVE_SAME_RULE_TWO_PLANES.findings[0]!.title)).length,
    ).toBeGreaterThanOrEqual(2);
    expect(await screen.findByText('Device ownership needs reconciliation')).toBeTruthy();

    const rows = container.querySelectorAll('tbody tr');
    expect(rows.length).toBeGreaterThanOrEqual(3);
    for (let i = 0; i < 3; i++) {
      (rows[i] as HTMLElement).focus();
      fireEvent.keyDown(rows[i] as HTMLElement, { key: 'x' });
    }

    const bar = await screen.findByRole('region', { name: 'Compliance finding selection actions' });
    expect(within(bar).getByRole('button', { name: 'Copy names' })).toBeTruthy();
    fireEvent.click(within(bar).getByRole('button', { name: 'Copy names' }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    /* Two planes share the firmware title — unique set is two titles. */
    expect(String(writeText.mock.calls[0]![0])).toBe(
      'Firmware evidence not reported\nDevice ownership needs reconciliation',
    );
    expect(await screen.findByText(/Copied 2 names/)).toBeTruthy();
  });
});

/* Loop 177 — bulk Copy selection link (?rules=) + clearable chip. */
describe('Compliance Loop 177 residuals', () => {
  it('Copy selection link writes rules= and the deep link filters findings', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    mockGetCompliance.mockResolvedValue(LIVE_SAME_RULE_TWO_PLANES);
    const { container } = renderCompliance();
    expect(
      (await screen.findAllByText(LIVE_SAME_RULE_TWO_PLANES.findings[0]!.title)).length,
    ).toBeGreaterThanOrEqual(2);
    expect(await screen.findByText('Device ownership needs reconciliation')).toBeTruthy();

    const rows = container.querySelectorAll('tbody tr');
    expect(rows.length).toBeGreaterThanOrEqual(2);
    (rows[0] as HTMLElement).focus();
    fireEvent.keyDown(rows[0] as HTMLElement, { key: 'x' });

    const bar = await screen.findByRole('region', { name: 'Compliance finding selection actions' });
    fireEvent.click(within(bar).getByRole('button', { name: 'Copy selection link' }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(String(writeText.mock.calls[0]![0])).toMatch(/rules=/);
    expect(String(writeText.mock.calls[0]![0])).toContain('scan.coverage.firmware');
    expect(await screen.findByText(/Selection link copied/)).toBeTruthy();
  });

  it('deep-links ?rules= and shows a clearable selection chip', async () => {
    mockGetCompliance.mockResolvedValue(LIVE_SAME_RULE_TWO_PLANES);
    renderCompliance(`/compliance?rules=${encodeURIComponent('scan.coverage.firmware')}`);
    expect(
      (await screen.findAllByText(LIVE_SAME_RULE_TWO_PLANES.findings[0]!.title)).length,
    ).toBeGreaterThanOrEqual(2);
    expect(screen.queryByText('Device ownership needs reconciliation')).toBeNull();
    const chip = screen.getByRole('group', { name: 'Selection deep link' });
    expect(within(chip).getByText(/1 selected rule/)).toBeTruthy();
    fireEvent.click(within(chip).getByRole('button'));
    await waitFor(() => expect(screen.getByTestId('loc').textContent).not.toMatch(/rules=/));
    expect(await screen.findByText('Device ownership needs reconciliation')).toBeTruthy();
  });
});

/* Loop 199 — keyboard shortcuts help on findings. */
describe('Compliance Loop 199 residuals', () => {
  it('exposes keyboard shortcuts help on the findings screen', async () => {
    mockGetCompliance.mockResolvedValue(LIVE_SAME_RULE_TWO_PLANES);
    renderCompliance('/compliance');
    expect(
      (await screen.findAllByText(LIVE_SAME_RULE_TWO_PLANES.findings[0]!.title)).length,
    ).toBeGreaterThanOrEqual(1);
    expect(screen.getByRole('button', { name: 'Keyboard shortcuts' })).toBeTruthy();
  });
});

/* Loop 213 — findings selection-empty Clear selection filter CTA. */
describe('Compliance Loop 213 residuals', () => {
  it('offers Clear selection filter when rules deep link matches nothing', async () => {
    mockGetCompliance.mockResolvedValue(LIVE_SAME_RULE_TWO_PLANES);
    renderCompliance(`/compliance?rules=${encodeURIComponent('missing.rule.zzz')}`);
    expect(await screen.findByText('No findings match this selection')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Clear selection filter' }));
    await waitFor(() => expect(screen.getByTestId('loc').textContent).not.toMatch(/rules=/));
    expect(
      (await screen.findAllByText(LIVE_SAME_RULE_TWO_PLANES.findings[0]!.title)).length,
    ).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText('No findings match this selection')).toBeNull();
  });
});
