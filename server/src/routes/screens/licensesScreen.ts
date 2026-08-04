/**
 * Licences screen routes: list + CSV export.
 * Extracted from screens.ts so the god-route can shrink without contract drift.
 */

import type { Router } from 'express';
import {
  LICENSE_STATS,
  LICENSES_EXPORT_PARTS,
  MIST_LICENSE_USAGES,
  ORPHANS,
  RENEWALS,
  SUBSCRIPTIONS,
  type LicensesExportPart,
  type MistLicenseUsageRow,
} from '@hpe/shared';
import { sendCsv } from '../../lib/csv';
import { queryFlag, queryString } from '../../lib/query';
import { poller } from '../../services/poller';
import {
  blendFor,
  envelopeFor,
  sourceFor,
  withBlended,
} from './context';
import {
  liveAssignments,
  liveLicenseStats,
  liveOrphans,
  liveRenewals,
} from './licenseModel';
import {
  LiveSubscription,
  liveDeviceData,
  planesMissingDevices,
} from './liveCore';

/**
 * Mist's per-site licence consumption (/orgs/{org}/licenses/usages) — the one
 * plane that publishes it, read straight off the Mist contribution rather than
 * merged across planes (there is nothing to merge), same pattern as
 * liveMistSle. `null` when the contribution carries no usages key (Mist not
 * linked, or this cycle's read failed): the screen renders that as "not
 * reported", never as zero consumption.
 */
function liveMistLicenseUsagesForLicenses(): MistLicenseUsageRow[] | null {
  return poller.contributionsByPlane().get('mist')?.mistLicenseUsages ?? null;
}

function licensesBody(): Record<string, unknown> {
  if (sourceFor('licenses') === 'demo') {
    if (blendFor('licenses')) {
      const subs = poller.getCache().subscriptions as LiveSubscription[];
      if (subs.length > 0) {
        const blendDevices = liveDeviceData().devices;
        const blendAssignments = liveAssignments();
        return withBlended(
          envelopeFor('licenses', {
            stats: liveLicenseStats(subs, blendDevices, blendAssignments),
            subscriptions: subs,
            renewals: liveRenewals(subs),
            orphans: liveOrphans(blendDevices, subs, blendAssignments, planesMissingDevices()),
            // The usage rows follow the section they describe: a swapped
            // payload carries what Mist really reported (null when it did
            // not), not the authored fixtures.
            mistLicenseUsages: liveMistLicenseUsagesForLicenses(),
          }),
          ['licenses'],
          'licenses',
        );
      }
    }
    return envelopeFor('licenses', {
      stats: LICENSE_STATS,
      subscriptions: SUBSCRIPTIONS,
      renewals: RENEWALS,
      orphans: ORPHANS,
      mistLicenseUsages: MIST_LICENSE_USAGES,
    });
  }
  // GreenLake subscriptions from the poller cache, with stats + renewals
  // computed from the rows' metric hints, and the reclaim list derived from
  // the plane's device→subscription join when it read one. A plane that did
  // not publish assignments contributes no orphan/gap rows at all — the
  // screen's own empty state then says why, instead of a confident '0'.
  const subs = poller.getCache().subscriptions as LiveSubscription[];
  const devices = liveDeviceData().devices;
  const assignments = liveAssignments();
  return envelopeFor('licenses', {
    stats: liveLicenseStats(subs, devices, assignments),
    subscriptions: subs,
    renewals: liveRenewals(subs),
    orphans: liveOrphans(devices, subs, assignments, planesMissingDevices()),
    mistLicenseUsages: liveMistLicenseUsagesForLicenses(),
  });
}

/**
 * Matches the Licences screen default: hide only idle rows with a known
 * numeric zero assignment. Active/expiring/retiring zeros and idle-with-seats
 * stay. Used by GET /licenses/export so server CSV matches the operator view.
 */
export function isOperationalSubscriptionRow(row: {
  status?: unknown;
  assigned?: unknown;
}): boolean {
  const status = String(row.status ?? '')
    .trim()
    .toLowerCase();
  const assigned = String(row.assigned ?? '')
    .replace(/,/g, '')
    .trim();
  const isNumericZero =
    assigned !== '' && Number.isFinite(Number(assigned)) && Number(assigned) === 0;
  return !(status === 'idle' && isNumericZero);
}

/** `?idle=1` / `true` / `yes` / `on` includes spare-capacity rows; else hide. */
export function includeIdleCapacity(req: { query: Record<string, unknown> }): boolean {
  return queryFlag(req, 'idle') === true;
}

/**
 * Exact plane filter for licence subscriptions (case-insensitive). Empty /
 * unknown values are no-ops — never invent an empty export from a typo alone
 * when the operator meant the full table (unknown plane simply matches nothing).
 */
export function applyLicensePlaneFilter<T extends { plane?: unknown }>(
  req: { query: Record<string, unknown> },
  rows: T[],
): T[] {
  const plane = queryString(req, 'plane').toLowerCase();
  if (!plane) return rows;
  return rows.filter((r) => String(r.plane ?? '').trim().toLowerCase() === plane);
}

/**
 * Exact status filter for licence subscriptions (case-insensitive). Empty is a
 * no-op. Unknown status simply matches nothing — never invents rows. Applies
 * after the idle-hide rule so `status=idle` only shows idle seats still visible
 * (non-zero / unknown assignment) unless `idle=1` is also set.
 */
export function applyLicenseStatusFilter<T extends { status?: unknown }>(
  req: { query: Record<string, unknown> },
  rows: T[],
): T[] {
  const status = queryString(req, 'status').toLowerCase();
  if (!status) return rows;
  return rows.filter((r) => String(r.status ?? '').trim().toLowerCase() === status);
}

/**
 * Substring `?q=` on operator-visible subscription fields (name/sku/plane/
 * term/status). Empty q is a no-op. Matches the Licences filter strip so
 * Download server CSV keeps the same slice as the table.
 */
export function applyLicenseTextFilter<
  T extends {
    name?: unknown;
    sku?: unknown;
    plane?: unknown;
    term?: unknown;
    status?: unknown;
  },
>(req: { query: Record<string, unknown> }, rows: T[]): T[] {
  const q = queryString(req, 'q').toLowerCase();
  if (!q) return rows;
  return rows.filter((r) => {
    const hay = [r.name, r.sku, r.plane, r.term, r.status]
      .map((v) => String(v ?? '').toLowerCase())
      .join(' ');
    return hay.includes(q);
  });
}

export function registerLicensesRoutes(router: Router): void {
  router.get('/licenses', (_req, res) => {
    res.json(licensesBody());
  });

  /**
   * GET /api/licenses/export?part=subscriptions|renewals — CSV of subscription
   * rows (default) or the separate renewals-soonest table. No secrets.
   * Subscriptions default matches the UI (hide idle zero-assignment); pass
   * `idle=1` to include spare-capacity seats. Optional `plane=` / `status=`
   * exact match (case-insensitive) and optional `q=` substring
   * (name/sku/plane/term/status) narrow subscriptions the same way as the
   * Licences filter strip. Renewals are unaffected by idle/plane/status/q.
   */
  router.get('/licenses/export', (req, res) => {
    const partRaw = queryString(req, 'part').toLowerCase();
    const normalized = partRaw === '' ? 'subscriptions' : partRaw;
    const part = (LICENSES_EXPORT_PARTS as readonly string[]).includes(normalized)
      ? (normalized as LicensesExportPart)
      : null;
    if (part === null) {
      res.status(400).json({ error: "part must be 'subscriptions' or 'renewals'" });
      return;
    }
    const body = licensesBody();
    if (part === 'renewals') {
      const rows = (body.renewals as Array<Record<string, unknown>>) ?? [];
      sendCsv(
        res,
        'licenses-renewals.csv',
        ['date', 'what', 'days'],
        rows.map((r) => [r.date, r.what, r.days]),
      );
      return;
    }
    let rows = (body.subscriptions as Array<Record<string, unknown>>) ?? [];
    if (!includeIdleCapacity(req)) {
      rows = rows.filter((r) => isOperationalSubscriptionRow(r));
    }
    rows = applyLicensePlaneFilter(req, rows);
    rows = applyLicenseStatusFilter(req, rows);
    rows = applyLicenseTextFilter(req, rows);
    sendCsv(
      res,
      'licenses.csv',
      ['name', 'sku', 'plane', 'term', 'qty', 'assigned', 'pct', 'expires', 'status'],
      rows.map((r) => [
        r.name,
        r.sku,
        r.plane,
        r.term,
        r.qty,
        r.assigned,
        r.pct,
        r.expires,
        r.status,
      ]),
    );
  });
}
