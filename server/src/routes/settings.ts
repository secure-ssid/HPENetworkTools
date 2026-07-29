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
import { normalizeSseBaseUrl, SseEndpointValidationError } from '../planes/sse';
import { PLANE_IDS, type PlaneId } from '../planes/types';
import { poller } from '../services/poller';
import { SseObjectsError, sseObjects, sseObjectsErrorBody } from '../services/sseObjects';
import { CentralWebhooksError, centralWebhooks } from '../services/centralWebhooks';

export const settingsRouter = Router();

const SETTING_KEYS = new Set([
  'demoMode',
  'blendLive',
  'configMode',
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
    ['configMode', patch.configMode === undefined || typeof patch.configMode === 'boolean'],
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
  const requestedPlanes = (req.body as Record<string, unknown>).planes;
  if (
    requestedPlanes &&
    typeof requestedPlanes === 'object' &&
    !Array.isArray(requestedPlanes) &&
    Object.prototype.hasOwnProperty.call(requestedPlanes, 'central')
  ) {
    try {
      centralWebhooks.assertCentralCredentialsMutable();
    } catch (err) {
      if (err instanceof CentralWebhooksError) {
        res.status(err.status).json({ error: err.message });
        return;
      }
      throw err;
    }
  }
  if (
    requestedPlanes &&
    typeof requestedPlanes === 'object' &&
    !Array.isArray(requestedPlanes) &&
    Object.prototype.hasOwnProperty.call(requestedPlanes, 'sse')
  ) {
    const requestedSse = (requestedPlanes as Record<string, unknown>).sse;
    if (requestedSse !== null && typeof requestedSse === 'object' && !Array.isArray(requestedSse)) {
      const ssePatch = requestedSse as Record<string, unknown>;
      const existingBaseUrl = settings.get().planes.sse?.baseUrl;
      const effectiveBaseUrl = typeof ssePatch.baseUrl === 'string' ? ssePatch.baseUrl : existingBaseUrl;
      try {
        const normalized = normalizeSseBaseUrl(effectiveBaseUrl);
        if (typeof ssePatch.baseUrl === 'string') ssePatch.baseUrl = normalized;
      } catch (err) {
        if (err instanceof SseEndpointValidationError) {
          res.status(err.status).json({ error: err.message });
          return;
        }
        throw err;
      }
    }
    try {
      sseObjects.assertCredentialsMutable();
    } catch (err) {
      if (err instanceof SseObjectsError) {
        if (err.status >= 500) console.error(`error: ${err.message}`);
        res.status(err.status).json(sseObjectsErrorBody(err));
        return;
      }
      throw err;
    }
  }
  const previous = settings.get();
  const before = previous.pollIntervalSec;
  // Snapshot each plane's stored record so we can tell a real credential save
  // from a shell preference PUT that merely echoed `planes` back at us.
  const wasCreds = new Map<PlaneId, string>();
  for (const id of PLANE_IDS) wasCreds.set(id, JSON.stringify(previous.planes[id] ?? null));

  const updated = settings.update(req.body);
  // Keep the registry and cache in sync when plane credentials change through
  // here. Clear first so old rows cannot be attributed to the rebuilt adapter.
  // Only for planes whose record ACTUALLY changed — a density or workspace-name
  // write that round-trips the whole settings blob must not wipe every plane's
  // live cache and freshness stamps.
  const planes = (req.body as Record<string, unknown> | undefined)?.planes;
  if (planes && typeof planes === 'object' && !Array.isArray(planes)) {
    for (const id of Object.keys(planes)) {
      if ((PLANE_IDS as readonly string[]).includes(id)) {
        const plane = id as PlaneId;
        if (JSON.stringify(updated.planes[plane] ?? null) === wasCreds.get(plane)) continue;
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
