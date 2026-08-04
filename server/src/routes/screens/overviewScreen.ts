/**
 * Overview (operations landing) routes + multi-slice CSV export.
 * Extracted from screens.ts so the god-route can shrink without contract drift.
 *
 * Registration order (static before any future /overview/:param):
 *   1. GET /overview/export?part=alerts|planes|sites|changes
 *   2. GET /overview
 *
 * Export columns are operator-visible landing facts only — no secrets.
 * `part=sites` also honours optional `?health=` (ok|warn|bad|stale).
 */

import type { Request, Response, Router } from 'express';
import {
  OVERVIEW_CHANGES,
  OVERVIEW_EXPORT_PARTS,
  OVERVIEW_LAUNCHPAD,
  OVERVIEW_PLANES,
  OVERVIEW_SITES,
  type OverviewExportPart,
  type SiteHealthTone,
} from '@hpe/shared';
import { sendCsv } from '../../lib/csv';
import { queryString } from '../../lib/query';
import { settings } from '../../config/settings';
import { alertQueueView } from '../../services/silences';
import { registry } from '../../planes/registry';
import { PLANE_IDS } from '../../planes/types';
import {
  blendFor,
  blendSection,
  envelopeFor,
  sourceFor,
  withBlended,
} from './context';
import { sendCachedJson } from './listQuery';
import { liveMerged } from './liveCore';
import {
  demoOverviewQueue,
  liveLaunchpad,
  liveOverviewChanges,
  liveOverviewPlanes,
  liveOverviewSite,
  liveOverviewStats,
  needsYouNowAlerts,
} from './overviewModel';
import { withWebhookAlerts } from './webhookAlerts';

const ALERT_CSV_HEADER = ['sev', 'title', 'plane', 'age', 'device', 'site', 'meta'] as const;
const PLANE_CSV_HEADER = ['name', 'scope', 'state', 'sync', 'linked'] as const;
const SITE_CSV_HEADER = ['name', 'siteId', 'plane', 'devices', 'clients', 'health', 'tone', 'alerts'] as const;
const CHANGE_CSV_HEADER = ['time', 'text', 'who'] as const;

const SITE_HEALTH = new Set<SiteHealthTone>(['ok', 'warn', 'bad', 'stale']);

/**
 * Loop 121: shared queryString for health (trim; non-string → '' → 'all').
 * Named-but-unknown still 400 so a typo cannot silently widen the CSV.
 */
function parseOverviewHealth(req: Request): SiteHealthTone | 'all' | { error: string } {
  const v = queryString(req, 'health').toLowerCase();
  if (!v || v === 'all') return 'all';
  if (SITE_HEALTH.has(v as SiteHealthTone)) return v as SiteHealthTone;
  return { error: "health must be 'ok', 'warn', 'bad', or 'stale'" };
}

/** Overview envelope body (demo / blend / live) — shared by JSON + CSV. */
export function overviewBody(): Record<string, unknown> {
  if (sourceFor('overview') === 'demo') {
    // Silences are real operator data in every mode: the demo panel and its
    // 'Open alerts' tile go through the same hush the Alerts screen applies,
    // or a silenced P1 would still headline the landing screen.
    const demoQueue = demoOverviewQueue();
    if (blendFor('overview')) {
      const live = liveMerged();
      // The same partition /api/alerts serves — the panel, the tile and the
      // Alerts screen can never disagree about what still needs someone.
      const queue = alertQueueView(withWebhookAlerts(live.alerts));
      const blended: string[] = [];
      // The plane roster now always has nine rows (unlinked planes included),
      // so "is there live plane state to swap to?" is the LINKED count, not
      // the row count — otherwise a blend with nothing connected would paint
      // nine dark rows over the fixture panel.
      const anyLinked = PLANE_IDS.some((id) => registry.state(id).linked);
      const livePlanes = anyLinked ? liveOverviewPlanes() : [];
      // Stats are computed, not collected — swap them once a plane has
      // actually REPORTED rows (a linked-but-failing plane would otherwise
      // paint '0 / 0' over the fixture strip between syncs).
      const statsLive = live.devices.length > 0 || live.alerts.length > 0;
      const stats = statsLive ? liveOverviewStats({ ...live, alerts: queue.alerts }) : demoQueue.stats;
      if (statsLive) blended.push('stats');
      const liveChanges = liveOverviewChanges();
      return withBlended(
        envelopeFor('overview', {
          workspace: settings.get().workspaceName,
          stats,
          alerts: blendSection('alerts', needsYouNowAlerts(queue.alerts), demoQueue.alerts, blended),
          sites: blendSection('sites', live.sites.map(liveOverviewSite), OVERVIEW_SITES, blended),
          planes: blendSection('planes', livePlanes, OVERVIEW_PLANES, blended),
          changes: blendSection('changes', liveChanges.changes, OVERVIEW_CHANGES, blended),
          // Only meaningful once the live tail actually displaced the
          // authored rows — the fixtures are complete by construction, so
          // warning that the record is short would be about a log they were
          // never read from.
          ...(blended.includes('changes') && liveChanges.unreadable > 0
            ? { changesUnreadable: liveChanges.unreadable }
            : {}),
          // Once a plane is linked the authored rows would offer consoles
          // and an SSH target this estate does not have — and the device
          // row would 404 against the swapped device section.
          launchpad: blendSection(
            'launchpad',
            livePlanes.length > 0 ? liveLaunchpad(live.devices) : [],
            OVERVIEW_LAUNCHPAD,
            blended,
          ),
        }),
        blended,
        'overview',
      );
    }
    return envelopeFor('overview', {
      workspace: settings.get().workspaceName,
      stats: demoQueue.stats,
      alerts: demoQueue.alerts,
      sites: OVERVIEW_SITES,
      planes: OVERVIEW_PLANES,
      changes: OVERVIEW_CHANGES,
      launchpad: OVERVIEW_LAUNCHPAD,
    });
  }
  const live = liveMerged();
  // The same partition /api/alerts serves, applied to everything the overview
  // derives from the queue: a silenced firing neither headlines "Needs you
  // now" nor counts on the 'Open alerts' tile.
  const queue = alertQueueView(withWebhookAlerts(live.alerts));
  const liveChanges = liveOverviewChanges();
  return envelopeFor('overview', {
    workspace: settings.get().workspaceName,
    stats: liveOverviewStats({ ...live, alerts: queue.alerts }),
    alerts: needsYouNowAlerts(queue.alerts),
    sites: live.sites.map(liveOverviewSite),
    planes: liveOverviewPlanes(),
    changes: liveChanges.changes,
    // A blank change log is a fact until the record cannot be read; then it
    // is a failure wearing the same panel.
    changesUnreadable: liveChanges.unreadable,
    launchpad: liveLaunchpad(live.devices),
  });
}

export function registerOverviewRoutes(router: Router): void {
  /**
   * GET /api/overview/export?part=alerts|planes|sites|changes
   * Must stay ahead of any future /overview/:param so "export" is never a param.
   * `part=sites` accepts optional `?health=` matching the Overview Sites preview.
   */
  router.get('/overview/export', (req, res) => {
    // Loop 121: shared queryString — empty/missing defaults to alerts; non-string
    // is treated as missing (honest default), not a 400. Named-unknown still 400.
    const raw = queryString(req, 'part').toLowerCase() || 'alerts';
    const part = (OVERVIEW_EXPORT_PARTS as readonly string[]).includes(raw)
      ? (raw as OverviewExportPart)
      : null;
    if (part === null) {
      res.status(400).json({
        error: "part must be 'alerts', 'planes', 'sites', or 'changes'",
      });
      return;
    }
    const body = overviewBody();
    if (part === 'alerts') {
      const alerts = (body.alerts as Array<Record<string, unknown>>) ?? [];
      sendCsv(
        res,
        'overview-alerts.csv',
        [...ALERT_CSV_HEADER],
        alerts.map((a) => [
          a.sev,
          a.title,
          a.plane,
          a.age,
          a.device,
          a.siteName ?? '',
          a.meta,
        ]),
      );
      return;
    }
    if (part === 'planes') {
      const planes = (body.planes as Array<Record<string, unknown>>) ?? [];
      sendCsv(
        res,
        'overview-planes.csv',
        [...PLANE_CSV_HEADER],
        planes.map((p) => [
          p.name,
          p.scope,
          p.state,
          p.sync,
          p.linked === true ? 'yes' : 'no',
        ]),
      );
      return;
    }
    if (part === 'sites') {
      const health = parseOverviewHealth(req);
      if (typeof health === 'object' && 'error' in health) {
        res.status(400).json({ error: health.error });
        return;
      }
      const sites = ((body.sites as Array<Record<string, unknown>>) ?? []).filter((s) => {
        if (health === 'all') return true;
        return String(s.tone ?? '') === health;
      });
      sendCsv(
        res,
        'overview-sites.csv',
        [...SITE_CSV_HEADER],
        sites.map((s) => [
          s.name,
          s.siteId,
          s.plane,
          s.devices,
          s.clients,
          s.health ?? '',
          s.tone ?? '',
          s.alerts,
        ]),
      );
      return;
    }
    // part === 'changes'
    const changes = (body.changes as Array<Record<string, unknown>>) ?? [];
    sendCsv(
      res,
      'overview-changes.csv',
      [...CHANGE_CSV_HEADER],
      changes.map((c) => [c.time, c.text, c.who]),
    );
  });

  /** GET /api/overview — operations landing envelope (weak ETag / 304). */
  router.get('/overview', (req: Request, res: Response) => {
    sendCachedJson(req, res, overviewBody());
  });
}
