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
  type ClientRow,
  type ConfigRecommendation,
  type DeviceRecommendationInput,
  type RecommendationCategory,
  type RecommendationSeverity,
  type ScreenSection,
} from '@hpe/shared';
import { h } from './handler';
import { poller } from '../services/poller';
import { effectiveSectionSource, settings } from '../config/settings';
import { maybeNotModified, weakEtag } from '../lib/httpCache';
import { sendCsv } from '../lib/csv';
import { queryOneOf, queryString } from '../lib/query';

const REC_SEVERITIES = ['info', 'suggestion', 'warning'] as const satisfies readonly RecommendationSeverity[];
const REC_CATEGORIES = [
  'firmware',
  'configuration',
  'redundancy',
  'security',
  'performance',
  'compliance',
  'inventory',
] as const satisfies readonly RecommendationCategory[];

export const recommendationsRouter = Router();

/**
 * Whether a dataset should come from the authored estate.
 *
 * Recommendations are advice about the network the operator is looking at, so
 * each dataset follows its OWN screen's effective source — per-section
 * overrides and the blend swap included — exactly as the notifier, the alert
 * engine and the fleet report already do. The portal-wide demoMode flag was
 * not that rule: an operator who pinned Devices to live still got findings
 * derived from fixtures, and nothing disclosed it because nothing had failed.
 *
 * settings.get() is deliberately not wrapped. It throws only when the settings
 * file is unreadable, and answering that with fixtures would turn a broken
 * portal into confident advice about somebody else's network.
 */
function servesFixtures(section: ScreenSection, liveCount: number): boolean {
  const s = settings.get();
  if (effectiveSectionSource(s, section) !== 'demo') return false;
  const blend = s.blendLive === true && s.sectionMode?.[section] !== 'demo';
  return !(blend && liveCount > 0);
}

function deviceInputs(): DeviceRecommendationInput[] {
  const live = poller.getCache().devices ?? [];
  if (servesFixtures('devices', live.length)) {
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

function clientInputs(fixtures: boolean, live: readonly ClientRow[]): ClientRecommendationInput[] {
  if (fixtures) {
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

/** The client estate and the decision that produced it — endpointMap needs the
 *  same verdict, and /taxonomy/summary must not reach a different one. */
function clientSource(): { fixtures: boolean; inputs: ClientRecommendationInput[] } {
  const live = poller.getCache().clients ?? [];
  const fixtures = servesFixtures('clients', live.length);
  return { fixtures, inputs: clientInputs(fixtures, live) };
}

function endpointMap(fixtures: boolean) {
  const map = new Map<string, (typeof CLEARPASS_ENDPOINTS)[number]>();
  // Live mode must never borrow the demo endpoint repository. ClearPass's
  // endpoint read is best-effort and absent from a perfectly healthy pull, and
  // falling back to fixtures handed the rule engine somebody else's estate:
  // recommendationsForClient marks a finding `evidence: 'partial'` with a note
  // when no endpoint row is supplied, and a borrowed row silences exactly that
  // disclosure. An absent repository is no rows, not invented ones.
  const rows = fixtures ? CLEARPASS_ENDPOINTS : (poller.getCache().endpoints ?? []);
  for (const row of rows) {
    map.set(row.mac.toLowerCase(), row);
  }
  return map;
}

function buildAll(): ConfigRecommendation[] {
  const devices = deviceInputs();
  // Clients and their ClearPass endpoint rows must come from the SAME estate:
  // the two are joined by MAC, and a MAC matched across two different networks
  // is a coincidence, not evidence. One decision, used for both.
  const { fixtures: clientFixtures, inputs: clients } = clientSource();
  const endpoints = endpointMap(clientFixtures);
  return [
    ...devices.flatMap(recommendationsForDevice),
    ...clients.flatMap((c) => recommendationsForClient(c, endpoints.get(c.mac.toLowerCase()) ?? null)),
  ];
}

/**
 * Shared list/export query parse (Loop 114).
 * - device/site/client: trimmed strings via queryString (empty → undefined)
 * - severity/category: queryOneOf allow-list (unknown → honest no-op, never cast junk)
 * - limit: non-negative integer; missing/empty → undefined; garbage → NaN (route 400s)
 * Export ignores limit so operators always get the full filtered set.
 */
function parseRecQuery(req: { query: Record<string, unknown> }) {
  const device = queryString(req, 'device');
  const site = queryString(req, 'site');
  const client = queryString(req, 'client') || queryString(req, 'clientMac');
  const severity = queryOneOf(req, 'severity', REC_SEVERITIES) ?? undefined;
  const category = queryOneOf(req, 'category', REC_CATEGORIES) ?? undefined;

  const limitRaw = queryString(req, 'limit');
  let limit: number | undefined;
  if (limitRaw) {
    // Allow 0 (empty page) and positive ints; reject floats / scientific / negatives.
    if (!/^\d+$/.test(limitRaw)) limit = Number.NaN;
    else {
      const n = Number(limitRaw);
      limit = Number.isSafeInteger(n) ? n : Number.NaN;
    }
  }

  return {
    ...(device ? { device } : {}),
    ...(site ? { site } : {}),
    ...(client ? { clientMac: client } : {}),
    ...(category ? { category } : {}),
    ...(severity ? { severity } : {}),
    ...(limit !== undefined ? { limit } : {}),
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
    const clients = clientSource().inputs;
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
