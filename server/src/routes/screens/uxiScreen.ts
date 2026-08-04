/**
 * UXI sensor fleet routes: list envelope + CSV export.
 * Extracted from screens.ts so the god-route can shrink without contract drift.
 *
 * UXI's contribution is a single structured dataset (`uxiSensors`), not a row
 * array merged across planes — missing-source is "linked but silent", not
 * multi-plane planesMissingDataset().
 *
 * List GET supports the shared optional inventory filters (`q`) plus UXI-only
 * `status` (online|offline|issues|unknown|idle), `site` (exact, case-
 * insensitive), and `severity` (critical|warning|info — sensors with at least
 * one active issue of that severity). Optional `?limit=&cursor=` paging
 * attaches `page` the same way devices/sites/auth-events do so the UI can
 * Load more large fleets.
 */

import type { Request, Router } from 'express';
import { UXI_SENSORS, type Plane } from '@hpe/shared';
import { sendCsv } from '../../lib/csv';
import { queryOneOf, queryString } from '../../lib/query';
import { registry } from '../../planes/registry';
import { poller } from '../../services/poller';
import { envelopeFor, sourceFor } from './context';
import { applyListFilters, applyListPaging, sendCachedJson } from './listQuery';

/**
 * Linked-but-silent for the ONE plane this screen reads.
 */
function uxiMissingSources(): Plane[] {
  const state = registry.state('uxi');
  if (!state.linked) return [];
  const pull = poller.contributionsByPlane().get('uxi');
  return pull?.uxiSensors === undefined ? (['UXI'] as Plane[]) : [];
}

export function uxiSensorsBody(): { sensors: unknown[]; missingSources?: Plane[] } {
  if (sourceFor('uxi') === 'demo') {
    return { sensors: UXI_SENSORS };
  }
  const pull = poller.contributionsByPlane().get('uxi');
  return {
    sensors: pull?.uxiSensors ?? [],
    missingSources: uxiMissingSources(),
  };
}

const UXI_LIST_FIELDS = ['name', 'serial', 'site', 'model', 'wifiMac', 'ethernetMac'] as const;
/** Loop 118: shared queryOneOf allow-lists (unknown → honest no-op). */
const UXI_STATUSES = ['online', 'offline', 'issues', 'unknown', 'idle'] as const;
const UXI_SEVERITIES = ['critical', 'warning', 'info'] as const;

type UxiSensorLike = {
  site?: string | null;
  isOnline?: boolean | null;
  isTesting?: boolean | null;
  issueCount?: number;
  issues?: Array<{ severity?: string }>;
};

/**
 * UXI-only status / site / severity filters applied after the shared q
 * substring filter. Loop 118: queryString / queryOneOf. Unknown
 * status/severity values are ignored (no invented empty list).
 */
export function applyUxiSensorFilters(
  req: Request,
  body: Record<string, unknown>,
): Record<string, unknown> {
  const list = body.sensors;
  if (!Array.isArray(list)) return body;

  const status = queryOneOf(req, 'status', UXI_STATUSES) ?? '';
  const site = queryString(req, 'site').toLowerCase();
  const severity = queryOneOf(req, 'severity', UXI_SEVERITIES) ?? '';

  if (!status && !site && !severity) return body;

  const filtered = (list as UxiSensorLike[]).filter((row) => {
    if (site) {
      const s = String(row.site ?? '')
        .trim()
        .toLowerCase();
      if (s !== site) return false;
    }
    if (severity) {
      const issues = Array.isArray(row.issues) ? row.issues : [];
      const hit = issues.some(
        (issue) => String(issue?.severity ?? '').trim().toLowerCase() === severity,
      );
      if (!hit) return false;
    }
    if (status) {
      const online = row.isOnline;
      const issues = typeof row.issueCount === 'number' ? row.issueCount : 0;
      switch (status) {
        case 'online':
          if (online !== true) return false;
          break;
        case 'offline':
          if (online !== false) return false;
          break;
        case 'unknown':
          if (online !== null && online !== undefined) return false;
          break;
        case 'issues':
          if (!(issues > 0)) return false;
          break;
        case 'idle':
          /* Online but not currently running synthetic tests. */
          if (online !== true || row.isTesting !== false) return false;
          break;
      }
    }
    return true;
  });
  return { ...body, sensors: filtered };
}

export function registerUxiRoutes(router: Router): void {
  router.get('/uxi', (req, res) => {
    const body = envelopeFor('uxi', uxiSensorsBody()) as Record<string, unknown>;
    const qFiltered = applyListFilters(req, body, 'sensors', [...UXI_LIST_FIELDS]);
    const filtered = applyUxiSensorFilters(req, qFiltered);
    const paged = applyListPaging(req, filtered, 'sensors');
    if ('error' in paged) {
      res.status(400).json({ error: paged.error, code: 'UXI_PAGING' });
      return;
    }
    sendCachedJson(req, res, paged.body);
  });

  /** GET /api/uxi/export — CSV of UXI sensors (no credentials). Honours q/status/site/severity. */
  router.get('/uxi/export', (req, res) => {
    const body = uxiSensorsBody() as Record<string, unknown>;
    const qFiltered = applyListFilters(req, body, 'sensors', [...UXI_LIST_FIELDS]);
    const filtered = applyUxiSensorFilters(req, qFiltered);
    const sensors = (filtered.sensors as Array<Record<string, unknown>>) ?? [];
    sendCsv(
      res,
      'uxi-sensors.csv',
      ['id', 'name', 'serial', 'model', 'site', 'isOnline', 'isTesting', 'issueCount', 'wifiMac', 'ethernetMac'],
      sensors.map((s) => [
        s.id,
        s.name,
        s.serial ?? '',
        s.model ?? '',
        s.site ?? '',
        s.isOnline === null || s.isOnline === undefined ? '' : s.isOnline ? 'true' : 'false',
        s.isTesting === null || s.isTesting === undefined ? '' : s.isTesting ? 'true' : 'false',
        s.issueCount,
        s.wifiMac ?? '',
        s.ethernetMac ?? '',
      ]),
    );
  });
}
