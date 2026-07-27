import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { getSettings, saveSettings } from '../api/client';
import { SettingsProvider, useSettings } from './SettingsContext';

vi.mock('../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/client')>();
  return {
    ...actual,
    getSettings: vi.fn(),
    saveSettings: vi.fn().mockResolvedValue({ ok: true, message: 'saved' }),
  };
});

const mockGetSettings = vi.mocked(getSettings);
const mockSaveSettings = vi.mocked(saveSettings);

beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
    clear: () => values.clear(),
  });
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
  mockGetSettings.mockReset();
  mockSaveSettings.mockClear();
});

function Probe() {
  const settings = useSettings();
  return <div>{`${settings.workspaceName}|${settings.pollIntervalSec}|${settings.settingsError ?? ''}`}</div>;
}

describe('SettingsProvider', () => {
  it('hydrates workspace identity and poll cadence from the server settings', async () => {
    mockGetSettings.mockResolvedValue({
      density: 'compact',
      inventoryView: 'Platform lanes',
      showPlatformTags: false,
      workspaceName: 'SecureSSID',
      pollIntervalSec: 30,
    });

    render(
      <SettingsProvider>
        <Probe />
      </SettingsProvider>,
    );

    await waitFor(() => expect(screen.getByText('SecureSSID|30|')).toBeTruthy());
    expect(JSON.parse(localStorage.getItem('nt-settings') ?? '{}')).toMatchObject({
      workspaceName: 'SecureSSID',
      pollIntervalSec: 30,
    });
  });

  it('surfaces an answered settings load failure instead of leaving an unhandled rejection', async () => {
    mockGetSettings.mockRejectedValue(new Error('HTTP 500'));

    render(
      <SettingsProvider>
        <Probe />
      </SettingsProvider>,
    );

    await waitFor(() => expect(screen.getByText(/settings could not be loaded: HTTP 500/)).toBeTruthy());
  });
});
