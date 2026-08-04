/**
 * server/src/routes/recommendations.ts — read-only config hygiene suggestions.
 *
 *   GET /api/recommendations?device=&site=&client=&category=&severity=&limit=
 *   GET /api/taxonomy/summary   device/client category buckets for filters
 *
 * Never mutates configuration. Built from the same inventory the screens use
 * (demo fixtures or live poller cache).
 */

import { Router } from 'express';
import {
  CLEARPASS_ENDPOINTS,
  CLIENTS,
  DEVICES,
  clientTypeBuckets,
  deviceTypeBuckets,
  filterRecommendations,
  recommendationCounts,
  recommendationsForClient,
  recommendationsForDevice,
  type ClientRecommendationInput,
  type ConfigRecommendation,
  type DeviceRecommendationInput,
  type RecommendationCategory,
  type RecommendationSeverity,
} from '@hpe/shared';
import { h } from './handler';
import { poller } from '../services/poller';
import { settings } from '../config/settings';
import { maybeNotModified, weakEtag } from '../lib/httpCache';
import { sendCsv } from '../lib/csv';

export const recommendationsRouter = Router();

function useDemoInventory(): boolean {
  try {
    return !!settings.get().demoMode;
  } catch {
    return true;
  }
}

function deviceInputs(): DeviceRecommendationInput[] {
  if (useDemoInventory()) {
    return DEVICES.map((d) => ({
      name: d.name,
      type: d.type,
      model: d.model,
      site: d.siteName ?? d.siteId,
      siteName: d.siteName,
      siteId: d.siteId,
      plane: d.plane,
      state: d.state,
      firmware: d.firmware,
      firmwareTarget: d.firmwareTarget,
      firmwareApproved: d.firmwareApproved,
      firmwareUpdate: d.firmwareUpdate,
      reconciliationIssue: d.reconciliationIssue,
      licence: d.licence,
      localShell: d.localShell,
    }));
  }
  const live = poller.getCache().devices ?? [];
  return live.map((d) => ({
    name: d.name,
    type: d.type,
    model: d.model,
    site: d.siteName ?? d.siteId,
    siteName: d.siteName,
    siteId: d.siteId,
    plane: d.plane,
    state: d.state,
    firmware: d.firmware,
    firmwareTarget: d.firmwareTarget,
    firmwareApproved: d.firmwareApproved,
    firmwareUpdate: d.firmwareUpdate,
    reconciliationIssue: d.reconciliationIssue,
    licence: d.licence,
    localShell: d.localShell,
  }));
}

function clientInputs(): ClientRecommendationInput[] {
  if (useDemoInventory()) {
    return CLIENTS.map((c) => ({
      name: c.name,
      mac: c.mac,
      type: c.type,
      model: c.model,
      site: c.siteName ?? c.siteId,
      siteName: c.siteName,
      siteId: c.siteId,
      plane: c.plane,
      ip: c.ip,
      problem: c.problem,
      health: c.health,
      auth: c.auth,
      role: c.role,
    }));
  }
  const live = poller.getCache().clients ?? [];
  return live.map((c) => ({
    name: c.name,
    mac: c.mac,
    type: c.type,
    model: c.model,
    site: c.siteName ?? c.siteId,
    siteName: c.siteName,
    siteId: c.siteId,
    plane: c.plane,
    ip: c.ip,
    problem: c.problem,
    health: c.health,
    auth: c.auth,
    role: c.role,
  }));
}

function endpointMap() {
  const map = new Map<string, (typeof CLEARPASS_ENDPOINTS)[number]>();
  const rows = useDemoInventory() ? CLEARPASS_ENDPOINTS : poller.getCache().endpoints ?? CLEARPASS_ENDPOINTS;
  for (const row of rows) {
    map.set(row.mac.toLowerCase(), row);
  }
  return map;
}

function buildAll(): ConfigRecommendation[] {
  const devices = deviceInputs();
  const clients = clientInputs();
  const endpoints = endpointMap();
  return [
    ...devices.flatMap(recommendationsForDevice),
    ...clients.flatMap((c) => recommendationsForClient(c, endpoints.get(c.mac.toLowerCase()) ?? null)),
  ];
}

function parseRecQuery(req: { query: import('express').Request['query'] }) {
  return {
    device: typeof req.query.device === 'string' ? req.query.device : undefined,
    site: typeof req.query.site === 'string' ? req.query.site : undefined,
    clientMac:
      typeof req.query.client === 'string'
        ? req.query.client
        : typeof req.query.clientMac === 'string'
          ? req.query.clientMac
          : undefined,
    category: typeof req.query.category === 'string' ? (req.query.category as RecommendationCategory) : undefined,
    severity: typeof req.query.severity === 'string' ? (req.query.severity as RecommendationSeverity) : undefined,
    limit: typeof req.query.limit === 'string' ? Number(req.query.limit) : undefined,
  };
}

recommendationsRouter.get(
  '/recommendations',
  h((req, res) => {
    const q = parseRecQuery(req);
    if (q.limit !== undefined && (!Number.isFinite(q.limit) || q.limit < 0)) {
      res.status(400).json({ error: 'limit must be a non-negative number', code: 'RECOMMENDATION_VALIDATION' });
      return;
    }
    const recommendations = filterRecommendations(buildAll(), q);
    const body = {
      recommendations,
      counts: recommendationCounts(recommendations),
      readOnly: true as const,
      note: 'Suggestions only — the portal never auto-applies configuration from this endpoint.',
    };
    if (maybeNotModified(req, res, weakEtag(body))) return;
    res.json(body);
  }),
);

/**
 * GET /api/recommendations/export — CSV of the same filtered suggestions.
 * Read-only; never applies config. Optional filters match the JSON list.
 */
recommendationsRouter.get(
  '/recommendations/export',
  h((req, res) => {
    const q = parseRecQuery(req);
    // Export ignores limit so operators get the full filtered set.
    const { limit: _limit, ...filters } = q;
    void _limit;
    if (q.limit !== undefined && (!Number.isFinite(q.limit) || q.limit < 0)) {
      res.status(400).json({ error: 'limit must be a non-negative number', code: 'RECOMMENDATION_VALIDATION' });
      return;
    }
    const recommendations = filterRecommendations(buildAll(), filters);
    const header = [
      'id',
      'ruleId',
      'severity',
      'title',
      'detail',
      'category',
      'actionType',
      'device',
      'site',
      'clientMac',
      'plane',
      'handoffPath',
      'evidence',
      'impactCount',
    ];
    sendCsv(
      res,
      'config-recommendations.csv',
      header,
      recommendations.map((r: ConfigRecommendation) => [
        r.id,
        r.ruleId,
        r.severity,
        r.title,
        r.detail,
        r.category,
        r.actionType,
        r.device,
        r.site,
        r.clientMac,
        r.plane,
        r.handoffPath,
        r.evidence,
        r.impactCount,
      ]),
    );
  }),
);

recommendationsRouter.get(
  '/taxonomy/summary',
  h((_req, res) => {
    const devices = deviceInputs();
    const clients = clientInputs();
    res.json({
      devices: {
        total: devices.length,
        byType: deviceTypeBuckets(devices),
      },
      clients: {
        total: clients.length,
        byType: clientTypeBuckets(clients),
      },
    });
  }),
);
