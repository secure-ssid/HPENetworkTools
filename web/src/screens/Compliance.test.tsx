import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import Compliance from './Compliance';
import { SettingsProvider } from '../app/SettingsContext';
import { ToastProvider } from '../nightdesk';
import { getCompliance, getConfigBackups, getConfigBackupDiff, getConfigBackupVersions, syncSystems } from '../api/client';
import type { ComplianceData } from '../api/client';
import type { ConfigBackupListEnvelope } from '@hpe/shared';

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

const mockGetCompliance = vi.mocked(getCompliance);
const mockSyncSystems = vi.mocked(syncSystems);
const mockGetConfigBackups = vi.mocked(getConfigBackups);
const mockGetConfigBackupVersions = vi.mocked(getConfigBackupVersions);
const mockGetConfigBackupDiff = vi.mocked(getConfigBackupDiff);

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

function renderCompliance() {
  return render(
    <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <SettingsProvider>
        <ToastProvider>
          <Compliance />
        </ToastProvider>
      </SettingsProvider>
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
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

  it('is not a keyboard grid — a finding row has no primary action to offer Enter', async () => {
    mockGetCompliance.mockResolvedValue(LIVE_COVERAGE);
    const { container } = renderCompliance();
    await screen.findByText('Firmware evidence not reported');

    expect(container.querySelector('table')?.getAttribute('role')).toBeNull();
    const rows = Array.from(container.querySelectorAll('tbody tr'));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((tr) => tr.getAttribute('tabindex') === null)).toBe(true);
    // …and no shortcuts overlay advertises row commands that do not exist.
    expect(screen.queryByRole('button', { name: 'Keyboard shortcuts' })).toBeNull();
  });
});
