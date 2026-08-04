import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import type { ConfigActionCapability } from '@hpe/shared';
import { ConfigActionPanel } from './ConfigActionPanel';

afterEach(() => {
  cleanup();
});

const centralSsidCapability: ConfigActionCapability = {
  id: 'central-ssid-edit',
  plane: 'CENTRAL',
  targetKind: 'ssid',
  action: 'ssid-edit',
  label: 'Edit Central SSID',
  dryRun: true,
  reviewRequired: true,
  handoffPath: '/configure?edit=ssid&plane=CENTRAL',
};

const opsrampReadonly: ConfigActionCapability = {
  id: 'opsramp-readonly',
  plane: 'OPSRAMP',
  targetKind: 'device',
  action: 'port-vlan',
  label: 'OpsRamp configuration',
  dryRun: false,
  reviewRequired: true,
  handoffPath: '/systems',
  readOnlyReason: 'OpsRamp is inventory and alerts only — the portal does not push configuration to it.',
};

describe('ConfigActionPanel', () => {
  it('requires preview/review before any push handoff', async () => {
    render(
      <MemoryRouter>
        <ConfigActionPanel
          capability={centralSsidCapability}
          target={{ kind: 'ssid', id: 'MRDN-Guest', plane: 'CENTRAL' }}
        />
      </MemoryRouter>,
    );
    expect(screen.getByRole('button', { name: /preview change/i })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^push$/i })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /preview change/i }));
    expect(screen.getByText(/review required/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /open reviewed workflow/i })).toBeTruthy();
  });

  it('explains read-only products without a push control', () => {
    render(
      <MemoryRouter>
        <ConfigActionPanel capability={opsrampReadonly} target={{ kind: 'device', id: 'host-1' }} />
      </MemoryRouter>,
    );
    expect(screen.getByText(/does not push configuration/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /preview change/i })).toBeNull();
  });
});
