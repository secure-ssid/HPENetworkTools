import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { useLabConfigMode } from './useLabConfigMode';

const { getPortalSettings } = vi.hoisted(() => ({ getPortalSettings: vi.fn() }));

vi.mock('../api/settings', () => ({ getPortalSettings }));

function Probe() {
  const mode = useLabConfigMode();
  return <output>{mode.lab ? 'lab' : 'hardened'}</output>;
}

afterEach(() => {
  cleanup();
  getPortalSettings.mockReset();
});

describe('useLabConfigMode', () => {
  it('uses hardened mode while settings are loading, unavailable, or explicitly disabled', async () => {
    let resolveSettings: (value: { configMode?: boolean } | null) => void = () => undefined;
    getPortalSettings.mockReturnValue(new Promise((resolve) => { resolveSettings = resolve; }));
    render(<Probe />);
    expect(screen.getByText('hardened')).toBeTruthy();

    resolveSettings(null);
    await waitFor(() => expect(screen.getByText('hardened')).toBeTruthy());

    getPortalSettings.mockResolvedValue({ configMode: false });
    cleanup();
    render(<Probe />);
    await waitFor(() => expect(screen.getByText('hardened')).toBeTruthy());
  });

  it('keeps the hardened fallback when the settings request fails', async () => {
    getPortalSettings.mockRejectedValue(new Error('settings unavailable'));
    render(<Probe />);
    await waitFor(() => expect(screen.getByText('hardened')).toBeTruthy());
  });

  it('adopts lab mode only after a successful settings response that does not disable it', async () => {
    getPortalSettings.mockResolvedValue({ configMode: undefined });
    render(<Probe />);
    expect(screen.getByText('hardened')).toBeTruthy();
    await waitFor(() => expect(screen.getByText('lab')).toBeTruthy());
  });
});
