/**
 * web/src/app/SettingsContext.tsx — global shell settings.
 *
 * density ('comfortable' | 'compact') — threaded to every Table,
 * inventoryView ('Unified table' | 'Platform lanes') — Devices presentation,
 * showPlatformTags — hides plane Badges for a quieter single-plane look,
 * workspaceName — sidebar/footer/breadcrumb identity (default 'Meridian Health').
 * tableColumns — per-table column-manager configs (DataTable's controlled
 * TableColumnsConfig), keyed by the screen's table id ('devices', …).
 * savedViews — per-screen named saved views (facets/filters, column config,
 * density), keyed by the screen's id ('devices', 'alerts', …).
 *
 * Initialised synchronously from localStorage (no loading flash); every
 * change is persisted through saveSettings() (localStorage + PUT /api/settings).
 * tableColumns and savedViews follow the same sync shape but live in their own
 * localStorage keys: the shell keys round-trip through shellSettingsOnly(),
 * which would strip anything it does not know. The server-side store passes
 * both maps through /api/settings (server/src/config/settings.ts), so the PUT
 * carries the current shell keys alongside — the write validates as one
 * settings update, and the shell values are unchanged no-ops. A backend that
 * is absent leaves the localStorage copy authoritative and no error is raised.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { DEFAULT_SETTINGS, SETTINGS_STORAGE_KEY, getSettings, saveSettings } from '../api/client';
import type { Settings } from '../api/client';
import { apiFetch, fromApi } from '../api/core';
import { shellSettingsOnly } from '../api/settings';
import type { TableColumnsConfig } from '../nightdesk/DataTable';

export type { Settings, TableColumnsConfig };
export type Density = Settings['density'];
export type InventoryView = Settings['inventoryView'];

/** Per-table column-manager configs, keyed by the screen's table id. */
export type TableColumnsMap = Record<string, TableColumnsConfig>;

export const TABLE_COLUMNS_STORAGE_KEY = 'nt-table-columns';

/**
 * A screen's named saved view: its facet selection, free text and switches in
 * `filters` (an opaque map — the shape is the screen's own), the DataTable
 * column-manager config, and the shell density at save time.
 */
export type SavedView = {
  name: string;
  filters: Record<string, unknown>;
  tableColumns?: TableColumnsConfig;
  density?: Density;
};

/** Per-screen saved-view lists, keyed by the screen's id ('devices', 'alerts', …). */
export type SavedViewsMap = Record<string, SavedView[]>;

export const SAVED_VIEWS_STORAGE_KEY = 'nt-saved-views';

/** A column config keeps only the keys it recognises. */
function cleanColumnsConfig(raw: Record<string, unknown>): TableColumnsConfig {
  const clean: TableColumnsConfig = {};
  if (Array.isArray(raw.order)) clean.order = raw.order.filter((k): k is string => typeof k === 'string');
  if (Array.isArray(raw.hidden)) clean.hidden = raw.hidden.filter((k): k is string => typeof k === 'string');
  if (raw.widths !== null && typeof raw.widths === 'object' && !Array.isArray(raw.widths)) {
    clean.widths = Object.fromEntries(
      Object.entries(raw.widths as Record<string, unknown>).filter(
        (entry): entry is [string, number] => typeof entry[1] === 'number' && Number.isFinite(entry[1]),
      ),
    );
  }
  return clean;
}

/**
 * Type-guard the persisted map (localStorage or the server copy): anything
 * that is not a plain object of plain config objects is dropped rather than
 * trusted.
 */
function sanitizeTableColumns(value: unknown): TableColumnsMap | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) return null;
  const out: TableColumnsMap = {};
  for (const [tableId, config] of Object.entries(value as Record<string, unknown>)) {
    if (config === null || typeof config !== 'object' || Array.isArray(config)) continue;
    out[tableId] = cleanColumnsConfig(config as Record<string, unknown>);
  }
  return out;
}

/**
 * Type-guard the persisted saved-views map, same rule as the column configs:
 * a screen's entry keeps only well-formed views (non-empty unique name, plain
 * filters object, recognised column-config and density keys) and drops the
 * rest rather than trusting it.
 */
function sanitizeSavedViews(value: unknown): SavedViewsMap | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) return null;
  const out: SavedViewsMap = {};
  for (const [screenId, list] of Object.entries(value as Record<string, unknown>)) {
    if (!Array.isArray(list)) continue;
    const seen = new Set<string>();
    const views: SavedView[] = [];
    for (const item of list) {
      if (item === null || typeof item !== 'object' || Array.isArray(item)) continue;
      const raw = item as Record<string, unknown>;
      if (typeof raw.name !== 'string' || raw.name.trim().length === 0) continue;
      if (raw.filters === null || typeof raw.filters !== 'object' || Array.isArray(raw.filters)) continue;
      const name = raw.name.trim();
      if (seen.has(name)) continue;
      seen.add(name);
      const view: SavedView = { name, filters: raw.filters as Record<string, unknown> };
      if (raw.tableColumns !== null && typeof raw.tableColumns === 'object' && !Array.isArray(raw.tableColumns)) {
        view.tableColumns = cleanColumnsConfig(raw.tableColumns as Record<string, unknown>);
      }
      if (raw.density === 'comfortable' || raw.density === 'compact') view.density = raw.density;
      views.push(view);
    }
    out[screenId] = views;
  }
  return out;
}

function loadInitialTableColumns(): TableColumnsMap {
  try {
    const raw = localStorage.getItem(TABLE_COLUMNS_STORAGE_KEY);
    if (raw) return sanitizeTableColumns(JSON.parse(raw)) ?? {};
  } catch {
    /* corrupted local copy — fall through to defaults */
  }
  return {};
}

function loadInitialSavedViews(): SavedViewsMap {
  try {
    const raw = localStorage.getItem(SAVED_VIEWS_STORAGE_KEY);
    if (raw) return sanitizeSavedViews(JSON.parse(raw)) ?? {};
  } catch {
    /* corrupted local copy — fall through to defaults */
  }
  return {};
}

/** The server half of the sync. Tolerant by design: a backend that is absent
 *  leaves the localStorage copy as the authoritative store, and there is
 *  nothing to tell the operator about. */
async function persistTableColumns(map: TableColumnsMap, shell: Settings): Promise<void> {
  try {
    await apiFetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...shellSettingsOnly(shell), tableColumns: map }),
    });
  } catch {
    /* backend absent — the local copy already written is authoritative */
  }
}

/** The saved-views half of the sync — same tolerant shape as the column configs. */
async function persistSavedViews(map: SavedViewsMap, shell: Settings): Promise<void> {
  try {
    await apiFetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...shellSettingsOnly(shell), savedViews: map }),
    });
  } catch {
    /* backend absent — the local copy already written is authoritative */
  }
}

type SettingsContextValue = Settings & {
  setDensity: (density: Density) => void;
  setInventoryView: (view: InventoryView) => void;
  setShowPlatformTags: (show: boolean) => void;
  setWorkspaceName: (name: string) => void;
  setPollIntervalSec: (seconds: number) => void;
  tableColumns: TableColumnsMap;
  setTableColumns: (tableId: string, config: TableColumnsConfig) => void;
  savedViews: SavedViewsMap;
  setSavedViews: (screenId: string, views: SavedView[]) => void;
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
  const [tableColumns, setTableColumnsState] = useState<TableColumnsMap>(loadInitialTableColumns);
  const [savedViews, setSavedViewsState] = useState<SavedViewsMap>(loadInitialSavedViews);
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
    // Column configs and saved views hydrate from the same endpoint. A server
    // that predates either key answers without it — the local copy of that key
    // stays authoritative.
    void fromApi<{ tableColumns?: unknown; savedViews?: unknown }>('/api/settings')
      .then((payload) => {
        if (!active || payload === null) return;
        const serverColumns = sanitizeTableColumns(payload.tableColumns);
        if (serverColumns !== null) {
          setTableColumnsState(serverColumns);
          try {
            localStorage.setItem(TABLE_COLUMNS_STORAGE_KEY, JSON.stringify(serverColumns));
          } catch {
            /* Server settings remain authoritative when local storage is unavailable. */
          }
        }
        const serverViews = sanitizeSavedViews(payload.savedViews);
        if (serverViews !== null) {
          setSavedViewsState(serverViews);
          try {
            localStorage.setItem(SAVED_VIEWS_STORAGE_KEY, JSON.stringify(serverViews));
          } catch {
            /* Server settings remain authoritative when local storage is unavailable. */
          }
        }
      })
      .catch(() => {
        /* backend absent — the local copy is authoritative */
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

  /* The sync PUT carries the current shell keys (so the write validates on a
     server that predates tableColumns); read them from a ref so this callback
     stays identity-stable like update() above. */
  const settingsRef = useRef(settings);
  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  /* Resize drags stream a config change per pointermove: state and
     localStorage take every change (cheap and synchronous), the network PUT
     is trailing-edge debounced so a drag costs one request, not sixty. Saved
     views are discrete edits, but they share the shape — and each map gets
     its own timer so a flush of one cannot cancel a pending PUT of the other
     (each PUT carries only its own key). */
  const persistTimer = useRef<number | null>(null);
  const viewsPersistTimer = useRef<number | null>(null);
  useEffect(() => {
    return () => {
      if (persistTimer.current !== null) window.clearTimeout(persistTimer.current);
      if (viewsPersistTimer.current !== null) window.clearTimeout(viewsPersistTimer.current);
    };
  }, []);

  const setTableColumns = useCallback((tableId: string, config: TableColumnsConfig) => {
    setTableColumnsState((prev) => {
      const next = { ...prev, [tableId]: config };
      try {
        localStorage.setItem(TABLE_COLUMNS_STORAGE_KEY, JSON.stringify(next));
      } catch {
        /* storage unavailable — the server copy may still succeed */
      }
      if (persistTimer.current !== null) window.clearTimeout(persistTimer.current);
      persistTimer.current = window.setTimeout(() => {
        persistTimer.current = null;
        void persistTableColumns(next, settingsRef.current);
      }, 250);
      return next;
    });
  }, []);

  const setSavedViews = useCallback((screenId: string, views: SavedView[]) => {
    setSavedViewsState((prev) => {
      const next = { ...prev, [screenId]: views };
      try {
        localStorage.setItem(SAVED_VIEWS_STORAGE_KEY, JSON.stringify(next));
      } catch {
        /* storage unavailable — the server copy may still succeed */
      }
      if (viewsPersistTimer.current !== null) window.clearTimeout(viewsPersistTimer.current);
      viewsPersistTimer.current = window.setTimeout(() => {
        viewsPersistTimer.current = null;
        void persistSavedViews(next, settingsRef.current);
      }, 250);
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
      tableColumns,
      setTableColumns,
      savedViews,
      setSavedViews,
      settingsError,
    }),
    [settings, settingsError, update, tableColumns, setTableColumns, savedViews, setSavedViews],
  );

  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

export function useSettings(): SettingsContextValue {
  const ctx = useContext(SettingsContext);
  if (!ctx) throw new Error('useSettings must be used within a SettingsProvider');
  return ctx;
}
