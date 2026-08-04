/**
 * server/src/routes/systems.ts — live plane state, connection tests, credentials.
 *
 *   GET    /api/systems/state              registry truth + poller sync history
 *   POST   /api/systems/sync               immediately poll every linked plane
 *   POST   /api/systems/:plane/test        real connection test (see below)
 *   POST   /api/systems/:plane/credentials save creds, re-init the adapter
 *   DELETE /api/systems/:plane             clear creds, adapter becomes unlinked
 */

import { Router } from 'express';
import {
  connectorCatalogEntry,
  migrateLegacyPlaneRecord,
  parseConnectorConfig,
  type ConnectorConfig,
  type ConnectorId,
} from '@hpe/shared';
import { h } from './handler';
import { settings } from '../config/settings';
import { normalizeSseBaseUrl } from '../planes/sse';
import { registry } from '../planes/registry';
import { poller, type TickResult } from '../services/poller';
import { SseObjectsError, sseObjects, sseObjectsErrorBody } from '../services/sseObjects';
import { CentralWebhooksError, centralWebhooks } from '../services/centralWebhooks';
import { PLANE_IDS, type PlaneId } from '../planes/types';
import type { ConnectionProbeResult } from '../planes/types';
import { adapterCredentialsFor, connectorConfigFor } from '../connectors/catalog';
import { probeConnector } from '../planes/connectionProbe';
import { maybeNotModified, weakEtag } from '../lib/httpCache';

export const systemsRouter = Router();

function asPlaneId(value: string): PlaneId | null {
  return (PLANE_IDS as readonly string[]).includes(value) ? (value as PlaneId) : null;
}

// -- Live state ----------------------------------------------------------------

systemsRouter.get('/systems/state', (req, res) => {
  const states = registry.states();
  const planes = {} as Record<PlaneId, unknown>;
  for (const id of PLANE_IDS) {
    planes[id] = { ...states[id], recentCalls: registry.recentCalls(id) };
  }
  const body = {
    dataSource: 'live' as const,
    syncedAt: poller.lastSyncAny(),
    demoMode: settings.get().demoMode,
    planes,
    history: poller.history(),
  };
  if (maybeNotModified(req, res, weakEtag(body))) return;
  res.json(body);
});

systemsRouter.post(
  '/systems/sync',
  h(async (_req, res) => {
    const result = await poller.syncNow();
    const started = [...result.synced, ...result.failed];
    res.json({
      ok: result.failed.length === 0,
      requested: result.requested,
      started,
      synced: result.synced,
      ...(result.failed.length > 0 ? { failed: result.failed } : {}),
      ...(result.skipped.length > 0
        ? { skipped: result.skipped, skippedReason: result.skippedReason }
        : {}),
    });
  }),
);

/**
 * GET /api/systems/:plane/health — single-plane drill-down for operators.
 * Registry facts + recent call outcomes only; free-text notes become noteChars.
 */
systemsRouter.get('/systems/:plane/health', (req, res) => {
  const id = asPlaneId(String(req.params.plane ?? ''));
  if (!id) {
    res.status(404).json({ error: 'unknown plane', code: 'PLANE_NOT_FOUND' });
    return;
  }
  const st = registry.states()[id];
  const calls = registry.recentCalls(id);
  const events = registry.recentEvents(id);
  const body = {
    ok: true,
    plane: id,
    linked: st.linked,
    health: st.health,
    stale: st.stale,
    reason: st.reason,
    lastSync: st.lastSync,
    ageSec: st.ageSec,
    noteChars: typeof st.note === 'string' ? st.note.length : 0,
    recentCalls: calls.slice(0, 40).map((c) => ({
      time: c.time,
      path: c.path,
      ms: c.ms,
      code: c.code,
    })),
    recentEvents: events.slice(0, 20).map((e) => ({
      time: e.time,
      what: e.what,
      who: e.who,
    })),
  };
  if (maybeNotModified(req, res, weakEtag(body))) return;
  res.json(body);
});

// -- Connection test -----------------------------------------------------------

interface TestResult extends ConnectionProbeResult {
  plane: PlaneId;
  ms: number;
  source: 'request' | 'stored';
}

function sanitizeCreds(input: unknown): Record<string, string> | null {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return null;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (k === 'scopes' && Array.isArray(v) && v.every((scope) => typeof scope === 'string')) {
      out.scopes = v.map((scope) => scope.trim()).filter(Boolean).join(',');
      continue;
    }
    if (k === 'scopes' && typeof v === 'string') {
      out.scopes = v.trim();
      continue;
    }
    if (typeof v === 'string' && v.trim().length > 0) out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : null;
}

function buildSseCredentialRecord(
  stored: Record<string, string> | null | undefined,
  submitted: Record<string, string> | null,
): Record<string, string> {
  const merged: Record<string, string> = { ...(stored ?? {}), ...(submitted ?? {}) };
  merged.baseUrl = normalizeSseBaseUrl(merged.baseUrl);
  return merged;
}

function connectorFromLegacy(
  plane: PlaneId,
  submitted: Record<string, string> | null,
): { config: ConnectorConfig | null; source: 'request' | 'stored' } {
  if (plane === 'aos10') {
    const err = new Error('AOS-10 is discovered through Central and has no independent connector probe') as Error & { status?: number };
    err.status = 400;
    throw err;
  }
  const id = plane as ConnectorId;
  const stored = connectorConfigFor(settings.get(), id);
  if (!submitted) return { config: stored, source: 'stored' };
  let legacy = { ...submitted };
  if (id === 'sse') legacy = buildSseCredentialRecord(stored ? adapterCredentialsFor(stored) : null, submitted);
  if (legacy.scopes !== undefined) {
    const allowed = new Set(connectorCatalogEntry(id).scopeOptions.map((scope) => scope.value));
    const normalized = new Set<string>();
    for (const scope of legacy.scopes.split(',').map((value) => value.trim()).filter(Boolean)) {
      if (allowed.has(scope)) normalized.add(scope);
      else if (scope.includes('write') && allowed.has('write:direct')) normalized.add('write:direct');
      else if (scope.startsWith('read') && allowed.has('read:inventory')) normalized.add('read:inventory');
    }
    legacy.scopes = [...normalized].join(',');
  }
  try {
    const config = migrateLegacyPlaneRecord(id, legacy);
    if (!config) throw new Error('incomplete');
    return { config: { ...config, enabled: true } as ConnectorConfig, source: 'request' };
  } catch {
    const err = new Error(`the submitted connector configuration for ${id} is incomplete or unsafe`) as Error & { status?: number };
    err.status = 400;
    throw err;
  }
}

function typedConnectorFromRequest(plane: PlaneId, input: unknown): ConnectorConfig | undefined {
  if (plane === 'aos10' || input === null || typeof input !== 'object' || Array.isArray(input)) return undefined;
  if (!Object.prototype.hasOwnProperty.call(input, 'auth')) return undefined;
  const id = plane as ConnectorId;
  try {
    return parseConnectorConfig(id, input) as ConnectorConfig;
  } catch {
    const err = new Error(`the submitted connector configuration for ${id} is incomplete or unsafe`) as Error & { status?: number };
    err.status = 400;
    throw err;
  }
}

systemsRouter.post(
  '/systems/:plane/test',
  h(async (req, res) => {
    const plane = asPlaneId(req.params.plane);
    if (!plane) {
      res.status(404).json({ error: `unknown plane '${req.params.plane}'` });
      return;
    }
    const raw = req.body as Record<string, unknown> | undefined;
    const submitted = raw && typeof raw === 'object' && raw.credentials !== undefined ? raw.credentials : raw;
    const typed = typedConnectorFromRequest(plane, submitted);
    const bodyCreds = typed ? null : sanitizeCreds(submitted);
    const resolved = typed
      ? { config: typed, source: 'request' as const }
      : connectorFromLegacy(plane, bodyCreds);
    if (!resolved.config) {
      res
        .status(400)
        .json({ error: `no credentials for ${plane} — pass a complete set in the request body or save credentials first` });
      return;
    }

    const started = Date.now();
    const outcome = await probeConnector(resolved.config, (call) => registry.recordCall(plane, call));
    const ms = Date.now() - started;

    const result: TestResult = { ...outcome, plane, ms, source: resolved.source };
    res.status(outcome.ok ? 200 : 502).json(result);
  }),
);

// -- Credentials ---------------------------------------------------------------

const CREDENTIAL_INDEX_WAIT_MS = Number(process.env.HPE_CREDENTIAL_INDEX_WAIT_MS ?? 9_000);

export type FirstPollOutcome = TickResult | 'pending';

async function firstPollOutcome(plane: PlaneId): Promise<FirstPollOutcome> {
  const poll = poller.syncNowFor(plane);
  if (CREDENTIAL_INDEX_WAIT_MS <= 0) {
    void poll.catch(() => {});
    return 'pending';
  }
  let timer: NodeJS.Timeout | undefined;
  const budget = new Promise<'pending'>((resolve) => {
    timer = setTimeout(() => resolve('pending'), CREDENTIAL_INDEX_WAIT_MS);
    timer.unref?.();
  });
  try {
    return await Promise.race([poll, budget]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

systemsRouter.post(
  '/systems/:plane/credentials',
  h(async (req, res) => {
    const plane = asPlaneId(req.params.plane);
    if (!plane) {
      res.status(404).json({ error: `unknown plane '${req.params.plane}'` });
      return;
    }
    const body = req.body as Record<string, unknown> | undefined;
    const rawSubmitted = body && typeof body === 'object' && body.credentials !== undefined
      ? body.credentials
      : body;
    const typed = typedConnectorFromRequest(plane, rawSubmitted);
    const submitted = typed ? null : sanitizeCreds(rawSubmitted);
    if (!typed && !submitted) {
      res.status(400).json({ error: 'body must be an object with at least one non-empty credential field' });
      return;
    }

    const resolved = typed
      ? { config: typed, source: 'request' as const }
      : connectorFromLegacy(plane, submitted);
    if (!resolved.config) {
      res.status(400).json({ error: `the submitted connector configuration for ${plane} is incomplete` });
      return;
    }
    if (plane === 'central') {
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
    if (plane === 'sse') {
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
    const started = Date.now();
    const probe = await probeConnector(resolved.config, (call) => registry.recordCall(plane, call));
    registry.recordCall(plane, {
      path: `authenticated ${probe.dataset} probe (credential save)`,
      ms: Date.now() - started,
      code: probe.ok ? 'ok' : 'fail',
    });
    if (!probe.ok) {
      res.status(502).json({ ...probe, plane });
      return;
    }

    settings.update({ connectors: { [plane]: resolved.config } });
    poller.clearPlane(plane);
    registry.reinitPlane(plane);
    const indexed = await firstPollOutcome(plane);
    res.json({
      plane,
      state: registry.get(plane).state(),
      indexed,
      credentials: settings.maskedView().planes[plane],
      connector: plane === 'aos10' ? null : settings.maskedView().connectors[plane as ConnectorId],
    });
  }),
);

systemsRouter.delete('/systems/:plane', (req, res) => {
  const plane = asPlaneId(req.params.plane);
  if (!plane) {
    res.status(404).json({ error: `unknown plane '${req.params.plane}'` });
    return;
  }
  if (plane === 'sse') {
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
  if (plane === 'central') {
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
  settings.update({ planes: { [plane]: null } });
  poller.clearPlane(plane);
  const state = registry.reinitPlane(plane);
  res.json({ plane, state });
});
