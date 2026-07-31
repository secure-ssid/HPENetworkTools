/** Portal and shell settings. */

import { apiFetch, fetchScreen, fromApi, serverMessage } from './core';
import { SystemMutationResult } from './systems';
import { type SectionMode } from '@hpe/shared';

// Settings — /api/settings with a localStorage fallback
// ---------------------------------------------------------------------------

export interface Settings {
  density: 'comfortable' | 'compact';
  inventoryView: 'Unified table' | 'Platform lanes';
  showPlatformTags: boolean;
  workspaceName: string;
  pollIntervalSec: number;
}

export const DEFAULT_SETTINGS: Settings = {
  density: 'comfortable',
  inventoryView: 'Unified table',
  showPlatformTags: true,
  workspaceName: 'Meridian Health',
  pollIntervalSec: 60,
};

export const SETTINGS_STORAGE_KEY = 'nt-settings';

/**
 * Project the shell keys out of a settings payload. GET /api/settings answers
 * with the WHOLE masked store (demoMode, blendLive, sectionMode,
 * hiddenDemoDevices, planes, mcp, llm …), so spreading it wholesale would make
 * the shell carry — and then PUT back — settings it does not own: a density
 * change would echo a mount-time demoMode over whatever Connected systems set
 * in the meantime, and echo `planes` back at the plane registry.
 */
export function shellSettingsOnly(raw: Partial<Settings> | null | undefined): Settings {
  const source = raw ?? {};
  return {
    density: source.density ?? DEFAULT_SETTINGS.density,
    inventoryView: source.inventoryView ?? DEFAULT_SETTINGS.inventoryView,
    showPlatformTags: source.showPlatformTags ?? DEFAULT_SETTINGS.showPlatformTags,
    workspaceName: source.workspaceName ?? DEFAULT_SETTINGS.workspaceName,
    pollIntervalSec: source.pollIntervalSec ?? DEFAULT_SETTINGS.pollIntervalSec,
  };
}

export async function getSettings(): Promise<Settings> {
  const result = await fetchScreen<Partial<Settings>>('/api/settings');
  if (result.kind === 'ok') return shellSettingsOnly(result.data);
  if (result.kind === 'http-error') throw new Error(result.message);
  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (raw) return shellSettingsOnly(JSON.parse(raw) as Partial<Settings>);
  } catch {
    /* corrupted local copy — fall through to defaults */
  }
  return DEFAULT_SETTINGS;
}

export async function saveSettings(settings: Settings): Promise<SystemMutationResult> {
  // Narrow patch, never the caller's state object: the PUT must change the
  // five shell preferences and nothing else in the store.
  const patch = shellSettingsOnly(settings);
  try {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(patch));
  } catch {
    /* storage unavailable — the server copy may still succeed */
  }
  try {
    const r = await apiFetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    if (r.ok) return { ok: true, message: 'settings saved' };
    return { ok: false, message: await serverMessage(r, `save failed — HTTP ${r.status}`) };
  } catch (err) {
    return {
      ok: false,
      message: `settings saved locally; portal backend unavailable: ${(err as Error).message}`,
    };
  }
}

/** The portal-behaviour slice of the server settings (demo mode + poll cadence). */
export interface PortalSettings {
  demoMode: boolean;
  /** Demo mode only: swap a screen section to live rows once a plane reports them. */
  blendLive?: boolean;
  /** Per-screen demo/live overrides; a section absent here follows demoMode. */
  sectionMode?: SectionMode;
  /** Fixture device names hidden from the demo inventory. */
  hiddenDemoDevices?: string[];
  /** Lab config mode: writes go through without a ticket reference. */
  configMode?: boolean;
  pollIntervalSec: number;
}

/** GET /api/settings, narrowed to the portal keys; null when backend absent. */
export async function getPortalSettings(): Promise<PortalSettings | null> {
  return fromApi<PortalSettings>('/api/settings');
}

/**
 * PUT /api/settings with a portal partial. A pollIntervalSec change is picked
 * up by the server without a restart (it restarts the poller); demoMode is
 * re-read on every poll tick and on every screen fetch.
 */
export async function savePortalSettings(
  patch: Partial<PortalSettings>,
): Promise<SystemMutationResult> {
  try {
    const r = await apiFetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    if (r.ok) return { ok: true, message: 'portal settings saved' };
    return { ok: false, message: await serverMessage(r, `save failed — HTTP ${r.status}`) };
  } catch (err) {
    return { ok: false, message: `cannot reach the portal backend: ${(err as Error).message}` };
  }
}
