import type { ReactElement } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { VisualReference } from '@hpe/shared';
import { ToastProvider } from '../nightdesk';
import { VisualReferencePanel } from './VisualReferencePanel';

afterEach(() => {
  cleanup();
});

const floorplan: VisualReference = {
  id: 'vr-1',
  target: { kind: 'site', id: 'northgate', plane: 'mist' },
  kind: 'floorplan',
  title: 'Northgate layout',
  source: 'upload',
  owner: 'local operator',
  updatedAt: '2026-08-01T12:00:00Z',
  assetId: 'asset-1',
  mimeType: 'image/png',
  attribution: 'facilities',
  unavailable: false,
};

function renderPanel(ui: ReactElement) {
  return render(<ToastProvider>{ui}</ToastProvider>);
}

describe('VisualReferencePanel', () => {
  it('renders an image reference with attribution and add controls', () => {
    renderPanel(
      <VisualReferencePanel
        target={{ kind: 'site', id: 'northgate', plane: 'mist' }}
        initialReferences={[floorplan]}
        editable
      />,
    );
    expect(screen.getByRole('img', { name: /northgate layout/i })).toBeTruthy();
    expect(screen.getByText(/uploaded by local operator/i)).toBeTruthy();
    expect(screen.getByText(/add visual reference/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /download references csv/i })).toBeTruthy();
  });

  it('shows empty state when there are no references', () => {
    renderPanel(
      <VisualReferencePanel
        target={{ kind: 'device', id: 'sw-01' }}
        initialReferences={[]}
        editable
      />,
    );
    expect(screen.getByText(/no visual references/i)).toBeTruthy();
    expect(screen.getAllByRole('button', { name: /add visual reference/i }).length).toBeGreaterThanOrEqual(1);
  });

  it('hides read-only empty panels (nothing actionable)', () => {
    const { container } = renderPanel(
      <VisualReferencePanel
        target={{ kind: 'device', id: 'sw-01' }}
        initialReferences={[]}
        editable={false}
      />,
    );
    expect(container.querySelector('.nt-visual-ref')).toBeNull();
    expect(screen.queryByText(/no visual references/i)).toBeNull();
    expect(screen.queryByText(/add visual reference/i)).toBeNull();
  });

  it('marks unavailable assets', () => {
    renderPanel(
      <VisualReferencePanel
        target={{ kind: 'site', id: 'northgate' }}
        initialReferences={[{ ...floorplan, unavailable: true, assetId: 'missing' }]}
      />,
    );
    expect(screen.getByText(/asset unavailable/i)).toBeTruthy();
  });
});
