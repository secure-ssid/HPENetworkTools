/**
 * Mist plane screen routes: dashboard envelope, CSV export, org audit log.
 * Extracted from screens.ts so the god-route can shrink without contract drift.
 *
 * Static paths (`/mist/export`) register before `/mist` (and any future
 * `/mist/:param`) so Express never treats `export` as a param segment.
 *
 * Honesty: live mode serves a dataset key ONLY when the Mist pull carried it —
 * absent means not reported this cycle, distinct from present-and-empty.
 * Export columns are operator-visible device facts only — no secrets.
 */

import type { Request, Response, Router } from 'express';
import {
  DEVICES,
  MIST_AP_STATS,
  MIST_AUDIT_LOG,
  MIST_EXPORT_PARTS,
  MIST_LICENSE_USAGES,
  MIST_PLANE_STATUS,
  MIST_ROGUE_APS,
  SITE_SLE,
  SSIDS,
  type MistApStatsRow,
  type MistAuditLogLive,
  type MistExportPart,
  type MistLicenseUsageRow,
  type MistPlaneStatus,
  type MistRogueApRow,
  type MistSleRow,
  type SsidObject,
} from '@hpe/shared';
import { sendCsv } from '../../lib/csv';
import { queryFlag, queryString } from '../../lib/query';
import { registry } from '../../planes/registry';
import { poller } from '../../services/poller';
import type { ReconciledDeviceRow } from '../../services/reconcile';
import {
  dataSource,
  envelopeFor,
  sourceFor,
} from './context';
import {
  DETAIL_TTL_MS,
  attemptDetail,
  cachedDetail,
  detailBudgetNote,
  neverThrows,
  settle,
} from './detailCache';
import { devicesBody } from './devicesScreen';
import { liveDeviceData, liveMistSle } from './liveCore';

const PLANE_DEVICE_CSV_HEADER = [
  'name',
  'type',
  'model',
  'site',
  'state',
  'firmware',
  'serial',
] as const;

/** The adapter surface the audit-log route needs — structural (the
 *  PlaneAdapter contract does not declare it), so an adapter without the
 *  read is the honest 'not reported', never a crash. */
type MistAuditLogReader = { mistAuditLog(limit?: number): Promise<MistAuditLogLive> };

/**
 * The Mist plane's own status block for the screen header. Live mode passes
 * the registry's facts through untouched — the health word, the last-sync
 * stamp (null when the plane never completed a pull), the claimed device
 * count and the pull note are the plane's own, never recomputed here. The
 * client count is the pull's own client rows — labelled as what it is,
 * since Mist publishes no org-wide client total on the poll.
 */
function liveMistPlaneStatus(clientCount: number | null): MistPlaneStatus {
  const state = registry.state('mist');
  return {
    linked: state.linked,
    health: state.health,
    lastSync: state.lastSync,
    deviceCount: state.deviceCount,
    clientCount,
    note: state.note,
  };
}

/** Devices any MIST badge claims, for the firmware section. Reconciled rows
 *  carry the full claimant list; a row without it (the authored fixtures)
 *  falls back to its display plane. */
function mistClaimedDevices(devices: ReconciledDeviceRow[]): ReconciledDeviceRow[] {
  return devices.filter((d) => (d.claimedBy ? d.claimedBy.includes('MIST') : d.plane === 'MIST'));
}

/**
 * Mist's per-site licence consumption for the Mist screen payload.
 * Licences screen has its own copy in licensesScreen.ts.
 */
function liveMistLicenseUsages(): MistLicenseUsageRow[] | null {
  return poller.contributionsByPlane().get('mist')?.mistLicenseUsages ?? null;
}

/**
 * GET /api/mist payload — one envelope for the plane's operational dashboard.
 * Demo serves authored fixtures; live projects the poller contribution.
 */
export function mistBody(): Record<string, unknown> {
  if (dataSource() === 'demo') {
    return {
      dataSource: 'demo',
      syncedAt: new Date().toISOString(),
      plane: MIST_PLANE_STATUS,
      sleBySiteId: SITE_SLE,
      rogues: MIST_ROGUE_APS,
      apStats: MIST_AP_STATS,
      licenseUsages: MIST_LICENSE_USAGES,
      wlans: SSIDS.filter((s) => s.plane.includes('MIST')),
      devices: DEVICES.filter((d) => d.plane === 'MIST'),
    };
  }
  const pull = poller.contributionsByPlane().get('mist');
  return {
    dataSource: 'live',
    // The payload is single-plane, so its stamp is the Mist registry's own —
    // lastSyncAny() would date these rows with another plane's pull.
    syncedAt: registry.state('mist').lastSync,
    plane: liveMistPlaneStatus(pull?.clients !== undefined ? pull.clients.length : null),
    ...(pull?.mistSle !== undefined ? { sleBySiteId: liveMistSle() } : {}),
    ...(pull?.mistRogues !== undefined ? { rogues: pull.mistRogues } : {}),
    ...(pull?.mistApStats !== undefined ? { apStats: pull.mistApStats } : {}),
    licenseUsages: liveMistLicenseUsages(),
    wlans: pull?.config?.ssids ?? null,
    devices: mistClaimedDevices(liveDeviceData().devices),
  };
}

/** Rows for CSV export — same claim rule as the Mist screen devices list. */
function mistClaimedFromInventory(): Array<Record<string, unknown>> {
  const body = devicesBody();
  const devices = (body.devices as Array<Record<string, unknown>>) ?? [];
  return devices.filter((d) => {
    const claimed = Array.isArray(d.claimedBy)
      ? (d.claimedBy as unknown[]).map((p) => String(p).toUpperCase())
      : null;
    if (claimed) return claimed.includes('MIST');
    return String(d.plane ?? '').toUpperCase() === 'MIST';
  });
}

function deviceCsvRows(rows: Array<Record<string, unknown>>): unknown[][] {
  return rows.map((d) => [
    d.name,
    d.type,
    d.model,
    d.siteName ?? d.site,
    d.state,
    d.firmware,
    d.serial ?? '',
  ]);
}

function mistRoguesFromBody(): MistRogueApRow[] {
  const body = mistBody();
  const rogues = body.rogues;
  return Array.isArray(rogues) ? (rogues as MistRogueApRow[]) : [];
}

function mistApStatsFromBody(): MistApStatsRow[] {
  const body = mistBody();
  const stats = body.apStats;
  return Array.isArray(stats) ? (stats as MistApStatsRow[]) : [];
}

/** Per-site SLE headlines from the Mist dashboard body (poll-time only). */
function mistSleFromBody(): MistSleRow[] {
  const body = mistBody();
  const bySite = body.sleBySiteId;
  if (!bySite || typeof bySite !== 'object') return [];
  return Object.values(bySite as Record<string, MistSleRow | undefined>).filter(
    (row): row is MistSleRow => row != null && typeof row === 'object',
  );
}

/** Mist WLAN inventory from the dashboard body — null means not reported. */
function mistWlansFromBody(): SsidObject[] {
  const body = mistBody();
  const wlans = body.wlans;
  return Array.isArray(wlans) ? (wlans as SsidObject[]) : [];
}

/**
 * Mist WLAN export filters (Loop 115): `q` substring over name/vlan/security/
 * targets/plane/note; `enabled` via queryFlag (1/true/yes/on | 0/false/no/off).
 * Unknown/empty → no-op. Rows with undefined enabled never match an enabled= filter
 * (same honesty as ClearPass services — never invent on/off).
 */
export function filterMistWlanRows(
  list: SsidObject[],
  filters: { q?: string; enabled?: boolean | null },
): SsidObject[] {
  const q = (filters.q ?? '').trim().toLowerCase();
  const enabledWant = filters.enabled ?? null;
  if (!q && enabledWant === null) return list;
  return list.filter((row) => {
    if (enabledWant !== null) {
      if (row.enabled !== true && row.enabled !== false) return false;
      if (row.enabled !== enabledWant) return false;
    }
    if (q) {
      const hay = [row.name, row.vlan, row.security, row.targets, row.plane, row.note]
        .map((v) => String(v ?? ''))
        .join(' ')
        .toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

/** Parse Mist WLAN list/export filters from the request query bag. */
export function mistWlanFilterQuery(req: { query: Request['query'] }): {
  q: string;
  enabled: boolean | null;
} {
  return {
    q: queryString(req, 'q'),
    enabled: queryFlag(req, 'enabled'),
  };
}

/**
 * Per-site licence usage tallies. null on the body means "not reported" —
 * export an empty file (honest absence) rather than inventing zeros.
 */
function mistLicensesFromBody(): MistLicenseUsageRow[] {
  const body = mistBody();
  const usages = body.licenseUsages;
  return Array.isArray(usages) ? (usages as MistLicenseUsageRow[]) : [];
}

/** Flatten usage/demand maps to stable `svc=used/demand` tokens (no secrets). */
function licenseServiceSummary(row: MistLicenseUsageRow): string {
  if (row.usages === null && row.fullyLoaded === null) return '';
  const usages = row.usages ?? {};
  const demand = row.fullyLoaded ?? {};
  const keys = [...new Set([...Object.keys(usages), ...Object.keys(demand)])].sort();
  return keys
    .map((k) => {
      const used = usages[k];
      const full = demand[k];
      const usedText = typeof used === 'number' ? String(used) : '—';
      return typeof full === 'number' ? `${k}=${usedText}/${full}` : `${k}=${usedText}`;
    })
    .join('|');
}

function parseMistExportPart(raw: unknown): MistExportPart | null {
  const partRaw = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  const normalized = partRaw === '' ? 'devices' : partRaw;
  return (MIST_EXPORT_PARTS as readonly string[]).includes(normalized)
    ? (normalized as MistExportPart)
    : null;
}

function parseAuditLimit(limitRaw: unknown): number {
  const limitParsed = typeof limitRaw === 'string' ? Number(limitRaw) : Number.NaN;
  return Number.isSafeInteger(limitParsed) && limitParsed > 0 ? Math.min(limitParsed, 100) : 25;
}

/** Shared read for JSON + CSV audit-log routes. null = no linked plane. */
async function loadMistAuditLog(limit: number): Promise<MistAuditLogLive | null> {
  if (sourceFor('systems') === 'demo') {
    return {
      entries: MIST_AUDIT_LOG.slice(0, limit),
      // The demo world stamps a FIXED clock (the MIST_SLE_DRILLDOWN
      // convention) — a moving 'now' would make the payload
      // non-deterministic under a demo fixture.
      source: {
        plane: 'mist',
        at: '2026-07-26T11:59:00.000Z',
        sections: { logs: MIST_AUDIT_LOG.length > 0 ? 'ok' : 'empty' },
      },
    } satisfies MistAuditLogLive;
  }

  const adapter = registry.get('mist');
  const read = (adapter as unknown as Partial<MistAuditLogReader>).mistAuditLog;
  if (typeof read !== 'function') {
    return null;
  }
  const budget = detailBudgetNote('mist');
  if (budget) {
    return {
      source: { plane: 'mist', at: new Date().toISOString(), sections: {}, note: budget },
    } satisfies MistAuditLogLive;
  }
  return neverThrows(
    cachedDetail(`auditlog:mist:${limit}`, DETAIL_TTL_MS, () =>
      attemptDetail(
        () => read.call(adapter, limit),
        (note): MistAuditLogLive => ({
          source: { plane: 'mist', at: new Date().toISOString(), sections: { logs: 'failed' }, note },
        }),
      ),
    ),
  );
}

async function serveMistAuditLog(res: Response, limitRaw: unknown): Promise<void> {
  const detail = await loadMistAuditLog(parseAuditLimit(limitRaw));
  res.json(envelopeFor('systems', { auditLog: detail }));
}

const AUDIT_CSV_HEADER = [
  'id',
  'at',
  'admin',
  'message',
  'siteId',
  'siteName',
  'before',
  'after',
] as const;

async function serveMistAuditLogCsv(res: Response, limitRaw: unknown): Promise<void> {
  const detail = await loadMistAuditLog(parseAuditLimit(limitRaw));
  const entries = detail?.entries ?? [];
  sendCsv(
    res,
    'mist-audit-log.csv',
    [...AUDIT_CSV_HEADER],
    entries.map((e) => [
      e.id ?? '',
      e.at ?? '',
      e.admin ?? '',
      e.message,
      e.siteId ?? '',
      e.siteName ?? '',
      e.before ?? '',
      e.after ?? '',
    ]),
  );
}

export function registerMistRoutes(router: Router): void {
  /**
   * GET /api/mist/export?part=devices|rogues|ap-stats|sle|wlans|licenses — CSV
   * slice of the Mist dashboard (no secrets/PSKs). Default part=devices. Must
   * stay ahead of any /mist/:param route.
   */
  router.get('/mist/export', (req, res) => {
    const part = parseMistExportPart(req.query.part);
    if (part === null) {
      res.status(400).json({
        error:
          "part must be 'devices', 'rogues', 'ap-stats', 'sle', 'wlans', or 'licenses'",
      });
      return;
    }
    if (part === 'rogues') {
      const rows = mistRoguesFromBody();
      sendCsv(
        res,
        'mist-rogues.csv',
        ['site', 'siteId', 'bssid', 'ssid', 'channel', 'avgRssi', 'numAps', 'seenOnLan'],
        rows.map((r) => [
          r.siteName,
          r.siteId,
          r.bssid,
          r.ssid ?? '',
          r.channel ?? '',
          r.avgRssi ?? '',
          r.numAps ?? '',
          r.seenOnLan === true ? 'yes' : r.seenOnLan === false ? 'no' : '',
        ]),
      );
      return;
    }
    if (part === 'ap-stats') {
      const rows = mistApStatsFromBody();
      sendCsv(
        res,
        'mist-ap-health.csv',
        ['device', 'site', 'siteId', 'mac', 'serial', 'clients', 'cpuPct', 'extIp'],
        rows.map((a) => [
          a.deviceName,
          a.siteName,
          a.siteId,
          a.mac ?? '',
          a.serial ?? '',
          a.numClients ?? '',
          a.cpuUtilPct ?? '',
          a.extIp ?? '',
        ]),
      );
      return;
    }
    if (part === 'sle') {
      const rows = mistSleFromBody();
      sendCsv(
        res,
        'mist-sle.csv',
        [
          'site',
          'siteId',
          'overall',
          'coverage',
          'capacity',
          'roaming',
          'apHealth',
          'wan',
        ],
        rows.map((s) => [
          s.siteName,
          s.siteId,
          s.overall ?? '',
          s.coverage ?? '',
          s.capacity ?? '',
          s.roaming ?? '',
          s.apHealth ?? '',
          s.wan ?? '',
        ]),
      );
      return;
    }
    if (part === 'wlans') {
      const filters = mistWlanFilterQuery(req);
      const rows = filterMistWlanRows(mistWlansFromBody(), filters);
      sendCsv(
        res,
        'mist-wlans.csv',
        ['name', 'vlan', 'security', 'targets', 'plane', 'enabled', 'note'],
        rows.map((w) => [
          w.name,
          w.vlan,
          w.security,
          w.targets,
          w.plane,
          w.enabled === undefined ? '' : w.enabled ? 'yes' : 'no',
          // note may say "PSK set — redacted"; never a cleartext secret.
          w.note ?? '',
        ]),
      );
      return;
    }
    if (part === 'licenses') {
      const rows = mistLicensesFromBody();
      sendCsv(
        res,
        'mist-licenses.csv',
        ['site', 'siteId', 'numDevices', 'numAps', 'services'],
        rows.map((row) => [
          row.siteName,
          row.siteId,
          row.numDevices ?? '',
          row.numAps ?? '',
          licenseServiceSummary(row),
        ]),
      );
      return;
    }
    sendCsv(res, 'mist-devices.csv', [...PLANE_DEVICE_CSV_HEADER], deviceCsvRows(mistClaimedFromInventory()));
  });

  /**
   * GET /api/mist/audit-log/export — CSV of org admin changes (no secrets;
   * before/after already portal-redacted). Static path ahead of /mist.
   */
  router.get('/mist/audit-log/export', (req, res) => {
    settle(res, serveMistAuditLogCsv(res, req.query.limit));
  });

  /**
   * GET /api/mist — one payload for the plane's operational dashboard: the
   * per-site SLE rows, the rogue/neighbor report, the AP rich-stats walk, the
   * licence usages, the WLAN inventory and the Mist-claimed devices, every one
   * a projection of reads the poller ALREADY made — composing them here costs
   * no plane call. (The org audit log stays on-demand behind
   * /api/systems/mist/audit-log: a paged org search is not poll-cheap.)
   *
   * Honesty contract, the ClearPass pattern: demo serves the authored fixtures
   * (MIST_PLANE_STATUS, SITE_SLE, MIST_ROGUE_APS, MIST_AP_STATS,
   * MIST_LICENSE_USAGES, the MIST-badged SSIDS and DEVICES rows). Live serves a
   * dataset key ONLY when the Mist pull carried it — an absent key means the
   * plane did not report that walk this cycle (a failed read, or a build that
   * does not expose it), which the screen words differently from a
   * present-but-empty real answer. `licenseUsages`/`wlans` go further and send
   * an explicit null, the Licenses screen's own "Mist reported nothing"
   * contract, because both have an unavailable-vs-empty story to tell apart
   * from "the key never rode the envelope".
   */
  router.get('/mist', (_req, res) => {
    res.json(mistBody());
  });

  /**
   * GET /api/systems/mist/audit-log?limit=N — the org's latest admin changes.
   * On-demand like the SLE drill route: the read costs a paged org search on
   * the Mist plane, so it runs only when the drawer asks — behind the shared
   * TTL cache and call-budget gate. Demo mode serves the authored MIST_AUDIT_LOG
   * fixtures; live mode answers `auditLog: null` when no linked plane can read
   * it (unlinked, or an adapter without the capability) and a stub-shaped
   * payload whose source.note says why when the read was attempted and failed.
   */
  router.get('/systems/mist/audit-log', (req, res) => {
    settle(res, serveMistAuditLog(res, req.query.limit));
  });
}
