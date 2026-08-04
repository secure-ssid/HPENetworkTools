import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { VisualReference } from '@hpe/shared';
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

describe('VisualReferencePanel', () => {
  it('renders an image reference with attribution and add controls', () => {
    render(
      <VisualReferencePanel
        target={{ kind: 'site', id: 'northgate', plane: 'mist' }}
        initialReferences={[floorplan]}
        editable
      />,
    );
    expect(screen.getByRole('img', { name: /northgate layout/i })).toBeTruthy();
    expect(screen.getByText(/uploaded by local operator/i)).toBeTruthy();
    expect(screen.getByText(/add visual reference/i)).toBeTruthy();
  });

  it('shows empty state when there are no references', () => {
    render(
      <VisualReferencePanel
        target={{ kind: 'device', id: 'sw-01' }}
        initialReferences={[]}
        editable={false}
      />,
    );
    expect(screen.getByText(/no visual references/i)).toBeTruthy();
    expect(screen.queryByText(/add visual reference/i)).toBeNull();
  });

  it('marks unavailable assets', () => {
    render(
      <VisualReferencePanel
        target={{ kind: 'site', id: 'northgate' }}
        initialReferences={[{ ...floorplan, unavailable: true, assetId: 'missing' }]}
      />,
    );
    expect(screen.getByText(/asset unavailable/i)).toBeTruthy();
  });
});
