/**
 * server/src/routes/settings.ts — settings read/update.
 *
 * GET returns the masked view; PUT applies a partial update and returns the
 * masked view. Secrets are never sent unmasked, and masked values written
 * back are ignored by the store (see config/settings.ts).
 */

import { Router } from 'express';
import { settings } from '../config/settings';
import { registry } from '../planes/registry';
import { PLANE_IDS, type PlaneId } from '../planes/types';
import { poller } from '../services/poller';

export const settingsRouter = Router();

const SETTING_KEYS = new Set([
  'demoMode',
  'blendLive',
  'sectionMode',
  'hiddenDemoDevices',
  'workspaceName',
  'pollIntervalSec',
  'planes',
  'mcp',
  'llm',
  'chatWriteMode',
  'density',
  'inventoryView',
  'showPlatformTags',
]);

function settingsBodyError(body: unknown): string | null {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return 'settings body must be an object';
  }
  const patch = body as Record<string, unknown>;
  const present = Object.keys(patch).filter((key) => SETTING_KEYS.has(key));
  if (present.length === 0) return 'settings body contains no supported fields';
  const checks: Array<[string, boolean]> = [
    ['demoMode', patch.demoMode === undefined || typeof patch.demoMode === 'boolean'],
    ['blendLive', patch.blendLive === undefined || typeof patch.blendLive === 'boolean'],
    ['chatWriteMode', patch.chatWriteMode === undefined || typeof patch.chatWriteMode === 'boolean'],
    ['showPlatformTags', patch.showPlatformTags === undefined || typeof patch.showPlatformTags === 'boolean'],
    ['workspaceName', patch.workspaceName === undefined || (typeof patch.workspaceName === 'string' && patch.workspaceName.trim().length > 0)],
    ['pollIntervalSec', patch.pollIntervalSec === undefined || (typeof patch.pollIntervalSec === 'number' && Number.isFinite(patch.pollIntervalSec) && patch.pollIntervalSec >= 5)],
    ['density', patch.density === undefined || patch.density === 'comfortable' || patch.density === 'compact'],
    ['inventoryView', patch.inventoryView === undefined || patch.inventoryView === 'Unified table' || patch.inventoryView === 'Platform lanes'],
    ['sectionMode', patch.sectionMode === undefined || (!!patch.sectionMode && typeof patch.sectionMode === 'object' && !Array.isArray(patch.sectionMode))],
    ['hiddenDemoDevices', patch.hiddenDemoDevices === undefined || Array.isArray(patch.hiddenDemoDevices)],
    ['planes', patch.planes === undefined || (!!patch.planes && typeof patch.planes === 'object' && !Array.isArray(patch.planes))],
    ['mcp', patch.mcp === undefined || patch.mcp === null || (typeof patch.mcp === 'object' && !Array.isArray(patch.mcp))],
    ['llm', patch.llm === undefined || patch.llm === null || (typeof patch.llm === 'object' && !Array.isArray(patch.llm))],
  ];
  const invalid = checks.filter(([, valid]) => !valid).map(([key]) => key);
  return invalid.length > 0 ? `invalid settings fields: ${invalid.join(', ')}` : null;
}

settingsRouter.get('/settings', (_req, res) => {
  res.json(settings.maskedView());
});

settingsRouter.put('/settings', (req, res) => {
  const bodyError = settingsBodyError(req.body);
  if (bodyError) {
    res.status(400).json({ error: bodyError });
    return;
  }
  const before = settings.get().pollIntervalSec;
  const updated = settings.update(req.body);
  // Keep the registry and cache in sync when plane credentials change through
  // here. Clear first so old rows cannot be attributed to the rebuilt adapter.
  const planes = (req.body as Record<string, unknown> | undefined)?.planes;
  if (planes && typeof planes === 'object' && !Array.isArray(planes)) {
    for (const id of Object.keys(planes)) {
      if ((PLANE_IDS as readonly string[]).includes(id)) {
        const plane = id as PlaneId;
        poller.clearPlane(plane);
        registry.reinitPlane(plane);
      }
    }
  }
  // Pick up a cadence change without a restart — but only when the poller is
  // actually running; createApp() promises no side effects, so a settings PUT
  // against it must not spawn one. (demoMode is re-read by the poller on
  // every tick, so no action is needed for that one.)
  if (updated.pollIntervalSec !== before && poller.isRunning()) poller.restart();
  res.json(settings.maskedView());
});
