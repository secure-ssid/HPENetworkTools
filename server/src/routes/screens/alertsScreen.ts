/**
 * Alerts list + CSV export + occurrence timeline routes.
 * Extracted from screens.ts so the god-route can shrink without contract drift.
 *
 * Registration order (static before params):
 *   1. GET /alerts/export
 *   2. GET /alerts
 *   3. GET /alerts/:fingerprint/timeline/export
 *   4. GET /alerts/:fingerprint/timeline
 *
 * Timeline join lives in alertTimeline.ts (facts are not re-persisted).
 * CSV columns are operator-visible facts only — no secrets.
 */

import type { Router } from 'express';
import { ALERTS } from '@hpe/shared';
import { sendCsv } from '../../lib/csv';
import { alertQueueView } from '../../services/silences';
import {
  blendFor,
  blendSection,
  envelopeFor,
  sourceFor,
  withBlended,
} from './context';
import {
  liveAlerts,
  liveCorrelation,
  planesMissingDataset,
  sortLiveAlerts,
} from './liveCore';
import { queryFlag, queryString, queryTokens } from '../../lib/query';
import { applyListPaging, sendCachedJson } from './listQuery';
import { withWebhookAlerts } from './webhookAlerts';
import { alertTimelineFor } from './alertTimeline';

/**
 * Optional `cleared=` tri-state matching the Alerts "Include cleared" switch
 * via shared queryFlag vocabulary (Loop 118):
 *   - false (`0`/`false`/`no`/`off`) → drop groups whose latest.state is cleared
 *   - true  (`1`/`true`/`yes`/`on`)  → keep cleared groups
 *   - null  (absent / unknown)       → no cleared filter (full queue; backward compatible)
 */
function clearedFilterMode(req: { query: Record<string, unknown> }): 'exclude' | 'include' | 'off' {
  const flag = queryFlag(req, 'cleared');
  if (flag === false) return 'exclude';
  if (flag === true) return 'include';
  return 'off';
}

/**
 * Optional `?q=` / `?plane=` / `?sev=` / `?site=` / `?unacked=` / `?cleared=` for
 * the operator queue (`groups`). Matches nested `latest` fields the Alerts UI
 * search + facets already cover (title/detail/site/device/plane/sev) plus
 * fingerprint — never invents rows. `plane`, `sev`, and `site` accept a single
 * value or comma-separated multi (OR within each key) so Download server CSV
 * can match FacetFilter ticks. `unacked` via queryFlag (`1`/`true`/`yes`/`on`)
 * keeps only latest.state=open (the "Unacknowledged only" switch). `cleared`
 * via queryFlag: false drops cleared groups (UI default hide); true keeps them;
 * null = no cleared gate.
 */
export function applyAlertQueueFilters(
  req: { query: Record<string, unknown> },
  body: Record<string, unknown>,
): Record<string, unknown> {
  const groups = body.groups;
  if (!Array.isArray(groups)) return body;
  // Loop 118: shared queryString / queryFlag (yes/on/no/off parity with other screens).
  const q = queryString(req, 'q').toLowerCase();
  // Loop 111: shared queryTokens (comma multi OR) — same parser as OpenAPI/docs.
  const planes = queryTokens(req, 'plane');
  const sevs = queryTokens(req, 'sev');
  const sites = queryTokens(req, 'site');
  const unackedOnly = queryFlag(req, 'unacked') === true;
  const clearedMode = clearedFilterMode(req);
  if (
    !q &&
    planes.length === 0 &&
    sevs.length === 0 &&
    sites.length === 0 &&
    !unackedOnly &&
    clearedMode === 'off'
  ) {
    return body;
  }
  const filtered = (groups as Record<string, unknown>[]).filter((g) => {
    const latest = (g.latest as Record<string, unknown> | undefined) ?? {};
    const state = String(latest.state ?? '').toLowerCase();
    if (unackedOnly && state !== 'open') return false;
    if (clearedMode === 'exclude' && state === 'cleared') return false;
    // clearedMode === 'include' | 'off' → no extra gate on cleared
    if (planes.length > 0) {
      const p = String(latest.plane ?? '').toLowerCase();
      if (!planes.includes(p)) return false;
    }
    if (sevs.length > 0) {
      const s = String(latest.sev ?? '').toLowerCase();
      if (!sevs.includes(s)) return false;
    }
    if (sites.length > 0) {
      // UI FacetFilter stores siteId; share URLs and typed names may use siteName.
      const siteName = String(latest.siteName ?? '').toLowerCase();
      const siteId = String(latest.siteId ?? '').toLowerCase();
      if (!sites.includes(siteName) && !sites.includes(siteId)) return false;
    }
    if (q) {
      const hay = [
        latest.title,
        latest.detail,
        latest.siteName,
        latest.device,
        latest.plane,
        latest.sev,
        g.fingerprint,
      ]
        .map((v) => String(v ?? ''))
        .join(' ')
        .toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
  return { ...body, groups: filtered };
}

export function alertsBody(): Record<string, unknown> {
  if (sourceFor('alerts') === 'demo') {
    if (blendFor('alerts')) {
      const blended: string[] = [];
      const view = alertQueueView(
        withWebhookAlerts(blendSection('alerts', sortLiveAlerts(liveAlerts()), ALERTS, blended)),
      );
      // Only a swapped (real) queue gets a derived banner; the authored rows
      // keep the authored one the design wrote for them. The banner derives
      // from the ACTIVE rows — a silenced firing cannot headline the queue it
      // was benched from.
      const correlation = blended.includes('alerts') ? liveCorrelation(view.alerts) : undefined;
      // Same gate as the correlation: the authored rows are complete by
      // construction, so naming an unread plane against them would be a
      // warning about a queue those planes were never asked to fill.
      const swapped = blended.includes('alerts');
      return withBlended(
        envelopeFor('alerts', {
          alerts: view.alerts,
          groups: view.groups,
          silenced: view.silenced,
          ...(correlation === undefined ? {} : { correlation }),
          ...(swapped ? { missingSources: planesMissingDataset('alerts') } : {}),
        }),
        blended,
        'alerts',
      );
    }
    return envelopeFor('alerts', { ...alertQueueView(withWebhookAlerts(ALERTS)) });
  }
  const view = alertQueueView(sortLiveAlerts(withWebhookAlerts(liveAlerts())));
  return envelopeFor('alerts', {
    alerts: view.alerts,
    groups: view.groups,
    silenced: view.silenced,
    correlation: liveCorrelation(view.alerts),
    // A queue missing a plane's alerts is not a quiet estate. Without this
    // an unread plane and a plane with nothing open look the same, and the
    // empty state reads as all-clear (see liveCore.ts planesMissingDataset).
    missingSources: planesMissingDataset('alerts'),
  });
}

const TIMELINE_CSV_HEADER = [
  'fingerprint',
  'device',
  'ts',
  'kind',
  'label',
  'detail',
  'approximate',
  'correlation',
] as const;

export function registerAlertsRoutes(router: Router): void {
  /**
   * GET /api/alerts/export — CSV of active alert groups (latest row + count).
   * Must stay ahead of /alerts/:fingerprint so "export" is never a param.
   */
  router.get('/alerts/export', (req, res) => {
    const body = applyAlertQueueFilters(req, alertsBody());
    const groups = (body.groups as Array<Record<string, unknown>>) ?? [];
    sendCsv(
      res,
      'alerts-queue.csv',
      ['sev', 'title', 'detail', 'state', 'plane', 'site', 'device', 'count', 'fingerprint'],
      groups.map((g) => {
        const latest = (g.latest as Record<string, unknown> | undefined) ?? {};
        return [
          latest.sev,
          latest.title,
          latest.detail,
          latest.state,
          latest.plane,
          latest.siteName,
          latest.device ?? '',
          g.count,
          g.fingerprint,
        ];
      }),
    );
  });

  router.get('/alerts', (req, res) => {
    const body = applyAlertQueueFilters(req, alertsBody());
    // Page active groups (the operator-facing queue); alerts[] stays full for
    // stats/correlation honesty unless groups is absent. Filters apply before
    // paging so Load more walks the same q/plane slice as the UI search box.
    const paged = applyListPaging(req, body, 'groups');
    if ('error' in paged) {
      res.status(400).json({ error: paged.error, code: 'PAGINATION_VALIDATION' });
      return;
    }
    sendCachedJson(req, res, paged.body);
  });

  /**
   * GET /api/alerts/:fingerprint/timeline/export — CSV of one group's
   * occurrence history (firings, silences, changes, drift). No secrets.
   * Registered before the JSON timeline so "/export" is not swallowed.
   */
  router.get('/alerts/:fingerprint/timeline/export', (req, res) => {
    const fingerprint = req.params.fingerprint;
    const timeline = alertTimelineFor(fingerprint);
    if (!timeline) {
      res.status(404).json({ error: `unknown alert fingerprint '${fingerprint}'` });
      return;
    }
    const correlation = timeline.correlation ?? '';
    const safeName = fingerprint.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80);
    sendCsv(
      res,
      `alert-timeline-${safeName || 'export'}.csv`,
      [...TIMELINE_CSV_HEADER],
      timeline.events.map((e) => [
        timeline.fingerprint,
        timeline.device ?? '',
        e.ts,
        e.kind,
        e.label,
        e.detail ?? '',
        e.approximate ? 'true' : '',
        correlation,
      ]),
    );
  });

  /**
   * GET /api/alerts/:fingerprint/timeline — one group's occurrence history:
   * firings, silences, the device's change-log lines and config drift, joined
   * by alertTimeline.ts (facts are not re-persisted, only joined).
   * 404 when neither the queue nor any store knows the fingerprint — an empty
   * timeline would read as "nothing ever happened here".
   */
  router.get('/alerts/:fingerprint/timeline', (req, res) => {
    const timeline = alertTimelineFor(req.params.fingerprint);
    if (!timeline) {
      res.status(404).json({ error: `unknown alert fingerprint '${req.params.fingerprint}'` });
      return;
    }
    res.json(envelopeFor('alerts', { timeline }));
  });
}
