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
