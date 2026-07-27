/**
 * web/src/app/SettingsContext.tsx — global shell settings.
 *
 * density ('comfortable' | 'compact') — threaded to every Table,
 * inventoryView ('Unified table' | 'Platform lanes') — Devices presentation,
 * showPlatformTags — hides plane Badges for a quieter single-plane look,
 * workspaceName — sidebar/footer/breadcrumb identity (default 'Meridian Health').
 *
 * Initialised synchronously from localStorage (no loading flash); every
 * change is persisted through saveSettings() (localStorage + PUT /api/settings).
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { DEFAULT_SETTINGS, SETTINGS_STORAGE_KEY, getSettings, saveSettings } from '../api/client';
import type { Settings } from '../api/client';

export type { Settings };
export type Density = Settings['density'];
export type InventoryView = Settings['inventoryView'];

type SettingsContextValue = Settings & {
  setDensity: (density: Density) => void;
  setInventoryView: (view: InventoryView) => void;
  setShowPlatformTags: (show: boolean) => void;
  setWorkspaceName: (name: string) => void;
  setPollIntervalSec: (seconds: number) => void;
  settingsError: string | null;
};

const SettingsContext = createContext<SettingsContextValue | null>(null);

function loadInitial(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (raw) return { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<Settings>) };
  } catch {
    /* corrupted local copy — fall through to defaults */
  }
  return DEFAULT_SETTINGS;
}

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<Settings>(loadInitial);
  const [settingsError, setSettingsError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void getSettings()
      .then((serverSettings) => {
        if (!active) return;
        setSettings(serverSettings);
        try {
          localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(serverSettings));
        } catch {
          /* Server settings remain authoritative when local storage is unavailable. */
        }
      })
      .catch((err: Error) => {
        if (active) setSettingsError(`settings could not be loaded: ${err.message}`);
      });
    return () => {
      active = false;
    };
  }, []);

  const update = useCallback((patch: Partial<Settings>) => {
    setSettingsError(null);
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      void saveSettings(next).then((result) => {
        if (result && !result.ok) setSettingsError(result.message);
      });
      return next;
    });
  }, []);

  const value = useMemo<SettingsContextValue>(
    () => ({
      ...settings,
      setDensity: (density) => update({ density }),
      setInventoryView: (inventoryView) => update({ inventoryView }),
      setShowPlatformTags: (showPlatformTags) => update({ showPlatformTags }),
      setWorkspaceName: (workspaceName) => update({ workspaceName }),
      setPollIntervalSec: (pollIntervalSec) => update({ pollIntervalSec }),
      settingsError,
    }),
    [settings, settingsError, update],
  );

  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

export function useSettings(): SettingsContextValue {
  const ctx = useContext(SettingsContext);
  if (!ctx) throw new Error('useSettings must be used within a SettingsProvider');
  return ctx;
}
