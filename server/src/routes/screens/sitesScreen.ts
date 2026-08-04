/**
 * Sites list + CSV export routes.
 * Extracted from screens.ts so the god-route can shrink without contract drift.
 *
 * Site detail (/sites/:siteId, SLE, applications) lives in siteDetailScreen.ts
 * and is registered after this module so Express never treats "export" as a
 * site id.
 */

import type { Request, Router } from 'express';
import { SITE_SLE, SITE_STATS, SITES } from '@hpe/shared';
import { sendCsv } from '../../lib/csv';
import { queryOneOf, queryString } from '../../lib/query';
import {
  blendFor,
  envelopeFor,
  sourceFor,
  withBlended,
} from './context';
import {
  liveMerged,
  liveMistSle,
  liveSiteStats,
  planesMissingDevices,
} from './liveCore';
import { applyListPaging, sendCachedJson } from './listQuery';

const SITE_LIST_FIELDS = ['name', 'id', 'subnet', 'mix', 'sync'] as const;
/** Health tones accepted by `?health=` (Loop 116 via shared queryOneOf). */
const SITE_HEALTH_TONES = ['ok', 'warn', 'bad', 'stale'] as const;

/**
 * Sites list filters: `?q=` (name/id/subnet/mix/sync), `?plane=` (badge name on
 * `planes[]`, case-insensitive — sites have no scalar `plane` field), and
 * `?health=` (`ok`/`warn`/`bad`/`stale` matching row `tone`).
 * Parsers are shared queryString / queryOneOf (Loop 116). Unknown health → no-op.
 */
export function applySiteListFilters(
  req: Request,
  body: Record<string, unknown>,
): Record<string, unknown> {
  const list = body.sites;
  if (!Array.isArray(list)) return body;

  const q = queryString(req, 'q').toLowerCase();
  const plane = queryString(req, 'plane').toLowerCase();
  const health = queryOneOf(req, 'health', SITE_HEALTH_TONES) ?? '';
  if (!q && !plane && !health) return body;

  const filtered = (list as Record<string, unknown>[]).filter((row) => {
    if (health && String(row.tone ?? '').toLowerCase() !== health) return false;
    if (plane) {
      const badges = Array.isArray(row.planes) ? (row.planes as unknown[]) : [];
      const hit = badges.some((b) => {
        if (typeof b === 'string') return b.toLowerCase() === plane;
        if (b && typeof b === 'object') {
          const name = (b as { name?: unknown }).name;
          return typeof name === 'string' && name.toLowerCase() === plane;
        }
        return false;
      });
      if (!hit) return false;
    }
    if (q) {
      const hay = SITE_LIST_FIELDS.map((f) => String(row[f] ?? ''))
        .join(' ')
        .toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
  return { ...body, sites: filtered };
}

export function sitesBody(): Record<string, unknown> {
  if (sourceFor('sites') === 'demo') {
    if (blendFor('sites')) {
      const blended: string[] = [];
      const live = liveMerged();
      if (live.sites.length > 0) {
        blended.push('sites');
        const missing = planesMissingDevices();
        return withBlended(
          envelopeFor('sites', {
            stats: liveSiteStats(live.sites, live.devices, live.clients, live.alerts, missing),
            sites: live.sites,
            missingSources: missing,
            sleBySiteId: liveMistSle(),
          }),
          blended,
          'sites',
        );
      }
    }
    return envelopeFor('sites', { stats: SITE_STATS, sites: SITES, sleBySiteId: SITE_SLE });
  }
  const live = liveMerged();
  // Sites are derived from the merged inventory, so a plane that contributed
  // no devices contributes no sites either — its locations are absent from
  // the table entirely rather than shown empty. Without this the screen
  // reports a count for a smaller estate than the operator is asking about.
  const missing = planesMissingDevices();
  return envelopeFor('sites', {
    stats: liveSiteStats(live.sites, live.devices, live.clients, live.alerts, missing),
    sites: live.sites,
    missingSources: missing,
    sleBySiteId: liveMistSle(),
  });
}

export function registerSitesRoutes(router: Router): void {
  /**
   * GET /api/sites/export — CSV of sites (optional q/plane/health).
   * Must stay ahead of /sites/:siteId so "export" is never a param.
   */
  router.get('/sites/export', (req, res) => {
    const body = sitesBody();
    const filtered = applySiteListFilters(req, body);
    const rows = (filtered.sites as Array<Record<string, unknown>>) ?? [];
    sendCsv(
      res,
      'sites.csv',
      ['name', 'id', 'subnet', 'mix', 'devices', 'clients', 'health', 'alerts', 'sync', 'planes'],
      rows.map((s) => [
        s.name,
        s.id,
        s.subnet,
        s.mix,
        s.devices,
        s.clients,
        s.health ?? s.healthPct ?? '',
        s.alerts,
        s.sync,
        Array.isArray(s.planes)
          ? (s.planes as unknown[])
              .map((p) =>
                typeof p === 'string'
                  ? p
                  : String((p as { name?: string; plane?: string }).name ?? (p as { plane?: string }).plane ?? p),
              )
              .join('|')
          : s.planes ?? '',
      ]),
    );
  });

  router.get('/sites', (req, res) => {
    const body = sitesBody();
    const paged = applyListPaging(req, applySiteListFilters(req, body), 'sites');
    if ('error' in paged) {
      res.status(400).json({ error: paged.error, code: 'PAGINATION_VALIDATION' });
      return;
    }
    sendCachedJson(req, res, paged.body);
  });
}
