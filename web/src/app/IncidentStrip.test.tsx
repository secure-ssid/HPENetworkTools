import type { ReactNode } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { IncidentProvider, useIncident } from './IncidentContext';
import { IncidentStrip } from './IncidentStrip';

function Seed({ children }: { children: ReactNode }) {
  const { setIncident } = useIncident();
  return (
    <>
      <button
        type="button"
        onClick={() =>
          setIncident({
            alertTitle: 'Core uplink flapping',
            deviceName: 'sw-core-01',
            devicePlane: 'central',
            sourcePath: '/alerts',
          })
        }
      >
        seed
      </button>
      {children}
    </>
  );
}

afterEach(() => cleanup());

describe('IncidentStrip', () => {
  it('stays hidden until an incident is set, then carries the spine and clears', () => {
    render(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <IncidentProvider>
          <Seed>
            <IncidentStrip />
          </Seed>
        </IncidentProvider>
      </MemoryRouter>,
    );

    expect(screen.queryByRole('region', { name: 'Active incident' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'seed' }));
    expect(screen.getByRole('region', { name: 'Active incident' })).toBeTruthy();
    expect(screen.getByText(/Core uplink flapping/)).toBeTruthy();
    expect(screen.getByText(/sw-core-01/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(screen.queryByRole('region', { name: 'Active incident' })).toBeNull();
  });
});
