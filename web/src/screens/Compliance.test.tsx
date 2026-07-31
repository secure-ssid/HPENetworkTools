import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
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
