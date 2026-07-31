import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import Compliance from './Compliance';
import { SettingsProvider } from '../app/SettingsContext';
import { ToastProvider } from '../nightdesk';
import { getCompliance, syncSystems } from '../api/client';
import type { ComplianceData } from '../api/client';

vi.mock('../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/client')>();
  return {
    ...actual,
    getCompliance: vi.fn(),
    syncSystems: vi.fn(),
  };
});

const mockGetCompliance = vi.mocked(getCompliance);
const mockSyncSystems = vi.mocked(syncSystems);

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
    <MemoryRouter>
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
      <MemoryRouter initialEntries={['/compliance']}>
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
      <MemoryRouter initialEntries={['/compliance']}>
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
