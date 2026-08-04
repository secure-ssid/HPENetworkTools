import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import type { ConfigRecommendation } from '@hpe/shared';
import { ToastProvider } from '../nightdesk';
import { ConfigRecommendationsPanel } from './ConfigRecommendationsPanel';

afterEach(() => cleanup());

const sample: ConfigRecommendation = {
  id: 'rec-1',
  ruleId: 'firmware.target-gap',
  severity: 'warning',
  title: 'Firmware target 0.14.29',
  detail: 'Device lags the plane target.',
  category: 'firmware',
  actionType: 'examine',
  handoffPath: '/devices/ap-1',
  evidence: 'observed',
  device: 'ap-1',
};

function renderPanel(recs: ConfigRecommendation[]) {
  return render(
    <MemoryRouter>
      <ToastProvider>
        <ConfigRecommendationsPanel initialRecommendations={recs} />
      </ToastProvider>
    </MemoryRouter>,
  );
}

describe('ConfigRecommendationsPanel', () => {
  it('renders recommendation cards and handoff', () => {
    renderPanel([sample]);
    expect(screen.getByText(/firmware target 0.14.29/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /open related screen/i })).toBeTruthy();
    expect(screen.getByText(/read only/i)).toBeTruthy();
  });

  it('shows empty state', () => {
    renderPanel([]);
    expect(screen.getByText(/no recommendations/i)).toBeTruthy();
  });
});
