/**
 * Site detail + on-demand SLE drill + DPI applications routes.
 * Extracted from screens.ts so the god-route can shrink without contract drift.
 *
 * Registration order (caller must register list/export first via sitesScreen):
 *   GET /sites/export          — sitesScreen (static)
 *   GET /sites                 — sitesScreen (list)
 *   GET /sites/:siteId/applications/export  — optional CSV of DPI table
 *   GET /sites/:siteId/applications
 *   GET /sites/:siteId/sle/export           — polled SLE metric summary CSV
 *   GET /sites/:siteId/sle/:metric/export   — on-demand drill CSV
 *   GET /sites/:siteId/sle/:metric
 *   GET /sites/:siteId/rogues/export        — polled Mist rogue/neighbor BSSIDs
 *   GET /sites/:siteId
 *
 * Prefer this module over folding into sitesScreen.ts to reduce merge conflict
 * with concurrent devicesScreen extracts.
 */

import type { Request, Response, Router } from 'express';
import {
  CLIENTS,
  MIST_ROGUE_APS,
  MIST_SITE_MAPS,
  MIST_SLE_DRILLDOWN,
  SITE_APPLICATIONS_DEMO,
  SITE_PROFILES,
  SITES,
  SITE_SLE,
  deriveSiteProfile,
  detailState,
  isRealSiteId,
  siteIdFor,
  toSiteAlertRow,
  toSiteDeviceRow,
  type AlertRow,
  type ClientRow,
  type MistRogueApRow,
  type MistSiteMap,
  type MistSleDrillSection,
  type MistSleMetricDetail,
  type MistSleRow,
  type SilencedSiteAlertRow,
  type SiteAlertRow,
  type SiteApplicationsLive,
  type SiteDeviceRow,
  type SiteId,
  type SiteProfile,
  type SiteReachability,
  type SiteRow,
  type TrendWindow,
  formatCount,
  countOf,
} from '@hpe/shared';
import { settings } from '../../config/settings';
import { poller } from '../../services/poller';
import { alertQueueView } from '../../services/silences';
import { registry } from '../../planes/registry';
import { PLANE_LABEL, type ReconciledDeviceRow } from '../../services/reconcile';
import { sendCsv } from '../../lib/csv';
import {
  blendFor,
  dataSource,
  envelopeFor,
  isSiteId,
  sourceFor,
  withBlended,
} from './context';
import {
  DETAIL_TTL_MS,
  attemptDetail,
  cachedDetail,
  detailBudgetNote,
  liveSiteTopology,
  neverThrows,
  planeSiteKey,
  sectionMap,
  settle,
} from './detailCache';
import { canOpenShell } from './deviceAccess';
import { trendWindow } from './helpers';
import { liveMerged, liveMistSle } from './liveCore';
import { liveMistApStats, mistLldpTopology } from './mistApStats';
import { HEALTH_TONE, relSync } from './overviewModel';

/**
 * The two per-site sections README §7 puts either side of the flair divider —
 * "Devices at this site" and "Open here". Both are pure projections of the
 * merge the route already computed, so a live site page carries them exactly
 * like a demo one (the authored profiles embed the same two lists).
 *
 * "Open here" runs the same partition /api/alerts serves: the site's 'N open'
 * badge has counted the ACTIVE queue since mergeLiveSites read alertQueueView,
 * so a firing an active silence benched must leave this section too — into
 * `silencedAlerts` WITH the reason and expiry, the same moved-never-hidden
 * story the Alerts screen tells. Without it a site could read 'clear' while
 * the section still listed the hushed firing as if it needed someone.
 */
function liveSiteSections(
  live: { devices: ReconciledDeviceRow[]; alerts: AlertRow[] },
  site: SiteRow,
): { devices: SiteDeviceRow[]; alerts: SiteAlertRow[]; silencedAlerts: SilencedSiteAlertRow[] } {
  const open = live.alerts.filter((a) => a.siteId === site.id && a.state === 'open');
  const queue = alertQueueView(open);
  return {
    devices: live.devices.filter((d) => d.siteId === site.id).map(toSiteDeviceRow),
    alerts: queue.alerts.map(toSiteAlertRow),
    silencedAlerts: queue.silenced.map(({ group, silence }) => ({
      ...toSiteAlertRow(group.latest),
      reason: silence.reason,
      until: silence.until,
    })),
  };
}

/**
 * README §7's "Local reachability" panel for a live site — the third section
 * the live branch had to leave as a fixed NOT REPORTED paragraph because the
 * payload carried nothing to fill it with.
 *
 * Every value is read off the local collector's registry state plus the
 * LOCAL-claimed share of this site's reconciled devices. Two honesty gates:
 * an unlinked collector asserts nothing at all, and an unknown share sends
 * `null` (rendered '—') rather than 0%, which would read as "no device here
 * answers" — a much stronger claim than "we never asked".
 */
function liveSiteReachability(devices: ReconciledDeviceRow[], site: SiteRow): SiteReachability {
  const state = registry.state('local');
  const label = PLANE_LABEL.local;
  if (!state.linked) {
    return {
      collector: 'not linked',
      collectorTone: HEALTH_TONE.unlinked,
      reachValue: null,
      collectorNote: `No ${label} collector credentials are stored, so no device at this site has been probed directly.`,
      core: null,
    };
  }
  const siteDevices = devices.filter((d) => d.siteId === site.id);
  const claimed = siteDevices.filter((d) => (d.claimedBy ?? []).includes(label) || d.plane === label);
  const reachValue =
    siteDevices.length > 0 ? Math.round((claimed.length / siteDevices.length) * 100) : null;
  const sync = state.lastSync ? `last sync ${relSync(state.lastSync)}` : 'never synced';
  return {
    collector: state.health,
    collectorTone: HEALTH_TONE[state.health],
    reachValue,
    collectorNote:
      reachValue === null
        ? `${label} collector is linked, but no device at this site is in the merged inventory yet · ${sync}`
        : `${formatCount(claimed.length)} of ${countOf(siteDevices.length, 'device')} at this site are claimed by the ${label} collector · ${sync}`,
    // Only a device the collector both claims AND can shell into is offered as
    // a terminal target; pointing the button at a cloud-claimed row would open
    // a session the bridge refuses. Same three-fact gate the device page's own
    // shell block uses, so the button cannot land on a page that then says
    // there is no shell here.
    core: claimed.find(canOpenShell)?.name ?? null,
  };
}

/**
 * A demo device the operator pruned on /devices must not reappear as an
 * inventory row on its site page — the site table is the site's slice of the
 * same inventory, not an independent authored list. The headline device count
 * moves with it (it is the same estate), while the rest of the authored
 * profile is untouched.
 *
 * `core` is the reachability panel's terminal target, so it follows the same
 * rule: a pruned core is no longer a device this portal knows, and offering a
 * shell on it would dial a row the operator removed. SiteProfile.core is a
 * plain string whose documented empty value means "no shell-capable core is
 * known here" — the renderers then offer no terminal button at all.
 */
function withoutHiddenDemoDevices(profile: SiteProfile | null): SiteProfile | null {
  if (profile === null) return null;
  const hidden = new Set(settings.get().hiddenDemoDevices ?? []);
  if (hidden.size === 0) return profile;
  const devices = profile.devices.filter((d) => !hidden.has(d.name));
  const removed = profile.devices.length - devices.length;
  const coreHidden = profile.core !== '' && hidden.has(profile.core);
  if (removed === 0 && !coreHidden) return profile;
  const total = Number(profile.deviceCount.replace(/,/g, ''));
  return {
    ...profile,
    devices,
    core: coreHidden ? '' : profile.core,
    deviceCount: Number.isFinite(total)
      ? formatCount(Math.max(0, total - removed))
      : profile.deviceCount,
  };
}

/**
 * The site's link graph, attached to a live site page.
 *
 * It is a NEW key, not a rewrite of `reachability`: SiteReachability is a
 * statement about the LOCAL collector — "how much of this site has this portal
 * probed directly" — and filling it from a cloud plane's topology would credit
 * the wrong plane for a claim it never made. The graph answers a different
 * question (what is wired to what, and which port), so it gets its own key and
 * leaves the collector panel alone.
 */
async function siteDetailKeys(site: SiteRow): Promise<Record<string, unknown>> {
  const topology = await liveSiteTopology(site);
  // Mist publishes no /topology graph for every site (a 404 there is an
  // honest null, not a failure) — but the AP stats walk carries every AP's
  // own LLDP uplink report, which IS a graph. Substitute it only when the
  // plane's read answered nothing (absent or empty): a FAILED read keeps its
  // failure on screen rather than being quietly swapped for prettier data.
  if (topology !== null && detailState(topology.source, 'nodes') !== 'empty') {
    return { topology };
  }
  return { topology: mistLldpTopology(site, liveMistApStats(), liveMerged().devices) ?? topology };
}

/** The dot fields a floor-plan client marker needs, and nothing else — the
 *  site page has no client table, so serving whole roster rows would publish
 *  session detail nobody renders. ClientRow sets x/y/mapId as a triple; a
 *  client missing any leg is not located and draws no dot. */
function mapClientDots(clients: ClientRow[], siteId: SiteId) {
  const dots: Array<{
    name: string;
    mac: string;
    x: number;
    y: number;
    mapId: string;
    health: string;
    healthTone: ClientRow['healthTone'];
  }> = [];
  for (const c of clients) {
    if (c.siteId !== siteId) continue;
    if (c.x === undefined || c.y === undefined || c.mapId === undefined) continue;
    dots.push({ name: c.name, mac: c.mac, x: c.x, y: c.y, mapId: c.mapId, health: c.health, healthTone: c.healthTone });
  }
  return dots;
}

/** Mist's floor plans across the estate, straight off the Mist contribution
 *  (only Mist publishes maps — the same single-plane pattern as liveMistSle).
 *  [] when no pull carried them: an honest no-map state, never a borrowed plan. */
function liveMistSiteMaps(): MistSiteMap[] {
  return poller.contributionsByPlane().get('mist')?.mistMaps ?? [];
}

/** Mist's rogue/neighbor report across the estate, same single-plane pattern
 *  as liveMistSiteMaps. [] when no pull carried it — honest, never borrowed. */
function liveMistRogues(): MistRogueApRow[] {
  return poller.contributionsByPlane().get('mist')?.mistRogues ?? [];
}

/** The Mist-published slices of a live/blend site page — floor plans, the SLE
 *  row, the rogue/neighbor report and the located-client dots. All four
 *  project pulls the poller already made, so attaching them to the detail
 *  payload costs no plane call; a plane that published nothing leaves honest
 *  empty states, never borrowed fixtures. */
function siteMistKeys(site: SiteRow): Record<string, unknown> {
  return {
    maps: liveMistSiteMaps().filter((m) => m.siteId === site.id),
    sle: liveMistSle()[site.id] ?? null,
    mapClients: mapClientDots(liveMerged().clients, site.id),
    rogues: liveMistRogues().filter((r) => r.siteId === site.id),
  };
}

async function serveSiteDetail(res: Response, param: string): Promise<void> {
  const id: SiteId | undefined = isSiteId(param) ? param : siteIdFor(param);

  if (sourceFor('sites') === 'demo') {
    // Blend: the sites section has swapped to live rows — a fixture profile
    // for a site the live inventory doesn't know would be fabrication, so
    // the detail follows the section: live row (matched like the live
    // branch, by id OR name) or honest 404.
    if (blendFor('sites')) {
      const live = liveMerged();
      if (live.sites.length > 0) {
        const site = live.sites.find((s) => s.id === id || s.name === param || String(s.id) === param) ?? null;
        if (!site) {
          res.status(404).json({ error: `site '${param}' not in the live inventory`, dataSource: 'demo', blended: ['sites'] });
          return;
        }
        res.json(
          withBlended(
            envelopeFor('sites', {
              site,
              profile: null,
              reachability: liveSiteReachability(live.devices, site),
              ...liveSiteSections(live, site),
              ...(await siteDetailKeys(site)),
              ...siteMistKeys(site),
            }),
            ['sites'],
            'sites',
          ),
        );
        return;
      }
    }
    // 'core-services', 'workspace' and 'multiple' are bookkeeping ids that
    // alert and device rows file under — they have no inventory row, so a
    // site page for them would be a fabricated profile, not a site.
    if (!id || !isRealSiteId(id)) {
      res.status(404).json({ error: `unknown site '${param}'`, dataSource: 'demo' });
      return;
    }
    // The authored deep profile when this site has one; otherwise a profile
    // derived from the portal's OWN inventory row for this site. The old
    // local-only fallback answered with Warehouse-DC1's authored numbers for
    // every other site, contradicting the SiteRow in the same response.
    res.json(
      envelopeFor('sites', {
        site: SITES.find((s) => s.id === id) ?? null,
        profile: withoutHiddenDemoDevices(SITE_PROFILES[id] ?? deriveSiteProfile(id)),
        // The Mist-published slices, demo edition: the authored floor plans,
        // SLE row, rogue/neighbor report and located-client dots. Sites Mist
        // does not manage get the empty forms, which render the honest
        // no-map / not-reported states.
        maps: MIST_SITE_MAPS.filter((m) => m.siteId === id),
        sle: SITE_SLE[id] ?? null,
        mapClients: mapClientDots(CLIENTS, id),
        rogues: MIST_ROGUE_APS.filter((r) => r.siteId === id),
      }),
    );
    return;
  }

  const live = liveMerged();
  const site = live.sites.find((s) => s.id === id || s.name === param || String(s.id) === param) ?? null;
  if (!site) {
    res.status(404).json({ error: `site '${param}' not in the live cache`, dataSource: 'live' });
    return;
  }
  res.json(
    envelopeFor('sites', {
      site,
      profile: null,
      reachability: liveSiteReachability(live.devices, site),
      ...liveSiteSections(live, site),
      ...(await siteDetailKeys(site)),
      ...siteMistKeys(site),
    }),
  );
}

// -- Mist SLE drill-down (on-demand) -------------------------------------------

const SLE_DRILL_SECTIONS: readonly MistSleDrillSection[] = [
  'classifiers',
  'impactedClients',
  'impactedAps',
  'trend',
];

/** A drill payload that carries no data and says why — the same contract as
 *  clientDetailStub/deviceDetailStub: sections {} reads 'not-fetched' (we
 *  chose not to ask, e.g. the call budget is spent), all 'failed' means we
 *  asked and it broke. */
function sleDetailStub(
  site: SiteRow,
  metric: string,
  note: string,
  attempted: boolean,
): MistSleMetricDetail {
  return {
    siteId: site.id,
    siteName: site.name,
    metric,
    source: {
      plane: 'mist',
      at: new Date().toISOString(),
      sections: attempted ? sectionMap(SLE_DRILL_SECTIONS, 'failed') : {},
      note,
    },
  };
}

type SleDetailLoad =
  | { kind: 'ok'; detail: MistSleMetricDetail }
  | { kind: 'null'; detail: null }
  | { kind: 'error'; status: number; body: Record<string, unknown> };

/**
 * Load one SLE drill payload without writing the response — shared by the
 * JSON drill route and the CSV export so both stay honest about 404 / null.
 */
async function loadSleMetricDetail(param: string, metric: string): Promise<SleDetailLoad> {
  const id: SiteId | undefined = isSiteId(param) ? param : siteIdFor(param);
  const m = metric.trim();

  if (sourceFor('sites') === 'demo') {
    if (blendFor('sites') && liveMerged().sites.length > 0) {
      return loadLiveSleMetricDetail(param, m);
    }
    if (!id || !isRealSiteId(id)) {
      return { kind: 'error', status: 404, body: { error: `unknown site '${param}'`, dataSource: 'demo' } };
    }
    const detail = MIST_SLE_DRILLDOWN[`${id}|${m}`] ?? null;
    if (detail === null) {
      return {
        kind: 'error',
        status: 404,
        body: {
          error: `no SLE drill-down recorded for '${m}' at '${id}'`,
          dataSource: 'demo',
        },
      };
    }
    return { kind: 'ok', detail };
  }

  return loadLiveSleMetricDetail(param, m);
}

/** Live/blend half of the drill load: site must be in the merged inventory. */
async function loadLiveSleMetricDetail(param: string, metric: string): Promise<SleDetailLoad> {
  const id: SiteId | undefined = isSiteId(param) ? param : siteIdFor(param);
  const site =
    liveMerged().sites.find((s) => s.id === id || s.name === param || String(s.id) === param) ??
    null;
  if (!site) {
    return {
      kind: 'error',
      status: 404,
      body: { error: `site '${param}' not in the live inventory`, dataSource: dataSource() },
    };
  }
  const adapter = registry.get('mist');
  const read = adapter.mistSleMetricDetail;
  if (typeof read !== 'function' || !metric) {
    return { kind: 'null', detail: null };
  }
  const budget = detailBudgetNote('mist');
  if (budget) {
    return { kind: 'ok', detail: sleDetailStub(site, metric, budget, false) };
  }
  const detail = await neverThrows(
    cachedDetail(`sle:mist:${site.id}:${metric}`, DETAIL_TTL_MS, () =>
      attemptDetail(
        () => read.call(adapter, site.id, metric),
        (note) => sleDetailStub(site, metric, note, true),
      ),
    ),
  );
  return detail ? { kind: 'ok', detail } : { kind: 'null', detail: null };
}

async function serveSleMetricDetail(res: Response, param: string, metric: string): Promise<void> {
  const loaded = await loadSleMetricDetail(param, metric);
  if (loaded.kind === 'error') {
    res.status(loaded.status).json(loaded.body);
    return;
  }
  if (loaded.kind === 'null') {
    res.json(envelopeFor('sites', { sleDetail: null }));
    return;
  }
  res.json(envelopeFor('sites', { sleDetail: loaded.detail }));
}

/** Polled SLE headline for one site (same source as the site detail `sle` key). */
function resolveSiteSleRow(
  param: string,
): { kind: 'ok'; sle: MistSleRow | null; siteKey: string } | { kind: 'error'; status: number; body: Record<string, unknown> } {
  const id: SiteId | undefined = isSiteId(param) ? param : siteIdFor(param);

  if (sourceFor('sites') === 'demo') {
    if (blendFor('sites') && liveMerged().sites.length > 0) {
      const site =
        liveMerged().sites.find((s) => s.id === id || s.name === param || String(s.id) === param) ??
        null;
      if (!site) {
        return {
          kind: 'error',
          status: 404,
          body: { error: `site '${param}' not in the live inventory`, dataSource: 'demo', blended: ['sites'] },
        };
      }
      return { kind: 'ok', sle: liveMistSle()[site.id] ?? null, siteKey: String(site.id) };
    }
    if (!id || !isRealSiteId(id)) {
      return { kind: 'error', status: 404, body: { error: `unknown site '${param}'`, dataSource: 'demo' } };
    }
    return { kind: 'ok', sle: SITE_SLE[id] ?? null, siteKey: String(id) };
  }

  const site =
    liveMerged().sites.find((s) => s.id === id || s.name === param || String(s.id) === param) ?? null;
  if (!site) {
    return {
      kind: 'error',
      status: 404,
      body: { error: `site '${param}' not in the live cache`, dataSource: 'live' },
    };
  }
  return { kind: 'ok', sle: liveMistSle()[site.id] ?? null, siteKey: String(site.id) };
}

const SLE_METRIC_CSV_HEADER = [
  'metric',
  'success',
  'samples',
  'degraded',
  'impactUsers',
  'impactTotalUsers',
  'impactAps',
  'impactTotalAps',
] as const;

function sleMetricCsvRows(sle: MistSleRow): unknown[][] {
  if (sle.metrics && sle.metrics.length > 0) {
    return sle.metrics.map((m) => [
      m.name,
      m.success ?? '',
      m.samples ?? '',
      m.degraded ?? '',
      m.impact?.numUsers ?? '',
      m.impact?.totalUsers ?? '',
      m.impact?.numAps ?? '',
      m.impact?.totalAps ?? '',
    ]);
  }
  return [
    ['coverage', sle.coverage ?? '', '', '', '', '', '', ''],
    ['capacity', sle.capacity ?? '', '', '', '', '', '', ''],
    ['roaming', sle.roaming ?? '', '', '', '', '', '', ''],
    ['ap-health', sle.apHealth ?? '', '', '', '', '', '', ''],
    ['wan', sle.wan ?? '', '', '', '', '', '', ''],
  ];
}

const SLE_DRILL_CSV_HEADER = ['section', 'name', 'mac', 'samples', 'degraded', 'durationSec'] as const;

function sleDrillCsvRows(detail: MistSleMetricDetail): unknown[][] {
  const rows: unknown[][] = [];
  for (const c of detail.classifiers ?? []) {
    rows.push(['classifier', c.name, '', c.samples ?? '', c.degraded ?? '', c.durationSec ?? '']);
  }
  for (const c of detail.impactedClients ?? []) {
    rows.push(['impacted-client', c.name ?? '', c.mac, '', c.degraded ?? '', '']);
  }
  for (const ap of detail.impactedAps ?? []) {
    rows.push(['impacted-ap', ap.name ?? '', ap.mac, '', ap.degraded ?? '', '']);
  }
  return rows;
}

function serveSiteSleExport(res: Response, param: string): void {
  const resolved = resolveSiteSleRow(param);
  if (resolved.kind === 'error') {
    res.status(resolved.status).json(resolved.body);
    return;
  }
  if (resolved.sle === null) {
    res.status(404).json({
      error: `no SLE scores available for '${param}'`,
      dataSource: dataSource(),
    });
    return;
  }
  const safe = resolved.siteKey.replace(/[^a-zA-Z0-9._-]+/g, '_');
  sendCsv(res, `site-sle-${safe}.csv`, [...SLE_METRIC_CSV_HEADER], sleMetricCsvRows(resolved.sle));
}

const ROGUE_CSV_HEADER = [
  'site',
  'siteId',
  'bssid',
  'ssid',
  'channel',
  'avgRssi',
  'numAps',
  'seenOnLan',
] as const;

/**
 * Resolve the site id/name the same way GET /sites/:siteId does, then project
 * the Mist rogue/neighbor rows already on the detail envelope (poll-time only;
 * never invents BSSIDs). Empty array is a real "nothing heard" answer.
 */
function resolveSiteRogues(param: string):
  | { kind: 'error'; status: number; body: Record<string, unknown> }
  | { kind: 'ok'; siteKey: string; rogues: MistRogueApRow[] } {
  const id: SiteId | undefined = isSiteId(param) ? param : siteIdFor(param);

  if (sourceFor('sites') === 'demo') {
    if (blendFor('sites')) {
      const live = liveMerged();
      if (live.sites.length > 0) {
        const site =
          live.sites.find((s) => s.id === id || s.name === param || String(s.id) === param) ?? null;
        if (!site) {
          return {
            kind: 'error',
            status: 404,
            body: {
              error: `site '${param}' not in the live inventory`,
              dataSource: 'demo',
              blended: ['sites'],
            },
          };
        }
        return {
          kind: 'ok',
          siteKey: String(site.id),
          rogues: liveMistRogues().filter((r) => r.siteId === site.id),
        };
      }
    }
    if (!id || !isRealSiteId(id)) {
      return {
        kind: 'error',
        status: 404,
        body: { error: `unknown site '${param}'`, dataSource: 'demo' },
      };
    }
    return {
      kind: 'ok',
      siteKey: String(id),
      rogues: MIST_ROGUE_APS.filter((r) => r.siteId === id),
    };
  }

  const live = liveMerged();
  const site = live.sites.find((s) => s.id === id || s.name === param || String(s.id) === param) ?? null;
  if (!site) {
    return {
      kind: 'error',
      status: 404,
      body: { error: `site '${param}' not in the live cache`, dataSource: 'live' },
    };
  }
  return {
    kind: 'ok',
    siteKey: String(site.id),
    rogues: liveMistRogues().filter((r) => r.siteId === site.id),
  };
}

function serveSiteRoguesExport(res: Response, param: string): void {
  const resolved = resolveSiteRogues(param);
  if (resolved.kind === 'error') {
    res.status(resolved.status).json(resolved.body);
    return;
  }
  const safe = resolved.siteKey.replace(/[^a-zA-Z0-9._-]+/g, '_');
  // Sort matches the SiteRogueAps UI: on-LAN first, then strongest signal.
  const rows = [...resolved.rogues].sort((a, b) => {
    const aLan = a.seenOnLan === true ? 0 : 1;
    const bLan = b.seenOnLan === true ? 0 : 1;
    if (aLan !== bLan) return aLan - bLan;
    const aRssi = typeof a.avgRssi === 'number' ? a.avgRssi : -999;
    const bRssi = typeof b.avgRssi === 'number' ? b.avgRssi : -999;
    return bRssi - aRssi;
  });
  sendCsv(
    res,
    `site-rogues-${safe}.csv`,
    [...ROGUE_CSV_HEADER],
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
}

async function serveSiteSleDrillExport(res: Response, param: string, metric: string): Promise<void> {
  const loaded = await loadSleMetricDetail(param, metric);
  if (loaded.kind === 'error') {
    res.status(loaded.status).json(loaded.body);
    return;
  }
  if (loaded.kind === 'null' || !loaded.detail) {
    res.status(404).json({
      error: `no SLE drill-down available for '${metric}' at '${param}'`,
      dataSource: dataSource(),
    });
    return;
  }
  const detail = loaded.detail;
  const safeSite = String(detail.siteId || param).replace(/[^a-zA-Z0-9._-]+/g, '_');
  const safeMetric = String(detail.metric || metric).replace(/[^a-zA-Z0-9._-]+/g, '_');
  sendCsv(
    res,
    `site-sle-${safeSite}-${safeMetric}.csv`,
    [...SLE_DRILL_CSV_HEADER],
    sleDrillCsvRows(detail),
  );
}

// -- Central DPI application visibility (on-demand) ----------------------------

/** An applications payload that carries no data and says why — the same
 *  contract as sleDetailStub: sections {} reads 'not-fetched' (we chose not
 *  to ask, e.g. the call budget is spent), 'failed' means we asked and it
 *  broke. */
function siteApplicationsStub(
  site: SiteRow,
  window: TrendWindow,
  note: string,
  attempted: boolean,
): SiteApplicationsLive {
  return {
    siteId: planeSiteKey(site),
    window,
    source: {
      plane: 'central',
      at: new Date().toISOString(),
      sections: attempted ? { apps: 'failed' } : {},
      note,
    },
  };
}

type AppsLoadResult =
  | { kind: 'ok'; applications: SiteApplicationsLive }
  | { kind: 'null' }
  | { kind: 'error'; status: number; body: Record<string, unknown> };

/** Shared loader for JSON + CSV applications routes. */
async function loadSiteApplications(
  param: string,
  query: { start?: unknown; end?: unknown },
): Promise<AppsLoadResult> {
  const id: SiteId | undefined = isSiteId(param) ? param : siteIdFor(param);

  if (sourceFor('sites') === 'demo') {
    if (blendFor('sites') && liveMerged().sites.length > 0) {
      return loadLiveSiteApplications(param, query);
    }
    if (!id || !isRealSiteId(id)) {
      return { kind: 'error', status: 404, body: { error: `unknown site '${param}'`, dataSource: 'demo' } };
    }
    const applications = SITE_APPLICATIONS_DEMO[id] ?? null;
    if (applications === null) {
      return {
        kind: 'error',
        status: 404,
        body: {
          error: `no application visibility recorded for '${id}'`,
          dataSource: 'demo',
        },
      };
    }
    return { kind: 'ok', applications };
  }

  return loadLiveSiteApplications(param, query);
}

/** Live/blend half of the applications route: the site must be in the merged
 *  inventory, and only the Central adapter can answer (no other plane runs
 *  DPI), so there is no badge walk — an adapter without the capability is
 *  the honest 'not reported'. The site-key join is the topology one: the
 *  adapter owns the native site-id resolution. */
async function loadLiveSiteApplications(
  param: string,
  query: { start?: unknown; end?: unknown },
): Promise<AppsLoadResult> {
  const id: SiteId | undefined = isSiteId(param) ? param : siteIdFor(param);
  const site =
    liveMerged().sites.find((s) => s.id === id || s.name === param || String(s.id) === param) ??
    null;
  if (!site) {
    return {
      kind: 'error',
      status: 404,
      body: { error: `site '${param}' not in the live inventory`, dataSource: dataSource() },
    };
  }
  const window = trendWindow(query);
  const adapter = registry.get('central');
  const read = adapter.siteApplications;
  if (typeof read !== 'function') {
    return { kind: 'null' };
  }
  const budget = detailBudgetNote('central');
  if (budget) {
    return { kind: 'ok', applications: siteApplicationsStub(site, window, budget, false) };
  }
  const applications = await neverThrows(
    cachedDetail(`apps:central:${site.id}:${window.start}:${window.end}`, DETAIL_TTL_MS, () =>
      attemptDetail(
        () => read.call(adapter, planeSiteKey(site), window),
        (note) => siteApplicationsStub(site, window, note, true),
      ),
    ),
  );
  if (applications === null) return { kind: 'null' };
  return { kind: 'ok', applications };
}

async function serveSiteApplications(
  res: Response,
  param: string,
  query: { start?: unknown; end?: unknown },
): Promise<void> {
  const loaded = await loadSiteApplications(param, query);
  if (loaded.kind === 'error') {
    res.status(loaded.status).json(loaded.body);
    return;
  }
  if (loaded.kind === 'null') {
    res.json(envelopeFor('sites', { applications: null }));
    return;
  }
  res.json(envelopeFor('sites', { applications: loaded.applications }));
}

async function serveSiteApplicationsExport(
  res: Response,
  param: string,
  query: { start?: unknown; end?: unknown },
): Promise<void> {
  const loaded = await loadSiteApplications(param, query);
  if (loaded.kind === 'error') {
    res.status(loaded.status).json(loaded.body);
    return;
  }
  if (loaded.kind === 'null') {
    res.status(404).json({
      error: `no application visibility available for '${param}'`,
      dataSource: dataSource(),
    });
    return;
  }
  const apps = loaded.applications.apps ?? [];
  const safeId = String(loaded.applications.siteId || param).replace(/[^a-zA-Z0-9._-]+/g, '_');
  sendCsv(
    res,
    `site-applications-${safeId}.csv`,
    [
      'name',
      'id',
      'risk',
      'riskRaw',
      'state',
      'rxBytes',
      'txBytes',
      'totalBytes',
      'categories',
      'applicationHostType',
      'destLocation',
      'experience',
      'lastUsedAt',
      'tlsVersion',
      'certificateExpiryAt',
    ],
    apps.map((a) => [
      a.name,
      a.id,
      a.risk,
      a.riskRaw,
      a.state,
      a.rxBytes ?? '',
      a.txBytes ?? '',
      a.totalBytes ?? '',
      a.categories.join('|'),
      a.applicationHostType ?? '',
      a.destLocation.join('|'),
      a.experience ?? '',
      a.lastUsedAt ?? '',
      a.tlsVersion ?? '',
      a.certificateExpiryAt ?? '',
    ]),
  );
}

export function registerSiteDetailRoutes(router: Router): void {
  /**
   * GET /api/sites/:siteId/applications/export — CSV of DPI app rows for one
   * site/window. Nested static segment before the JSON applications route is
   * not required by Express path matching, but keeps the pair co-located.
   */
  router.get('/sites/:siteId/applications/export', (req: Request, res: Response) => {
    settle(res, serveSiteApplicationsExport(res, req.params.siteId, req.query));
  });

  /**
   * GET /api/sites/:siteId/applications — the DPI application table for ONE
   * site over ONE window (default the last 24h; the endpoint refuses anything
   * wider than 7 days).
   *
   * On-demand on purpose: the table pages at 200 rows a call against a metered
   * plane, so it runs only when an operator opens the site's applications
   * section — behind the shared TTL cache, single-flight and call-budget gate,
   * exactly like the SLE drill above. 404 when the site itself is unknown;
   * `applications: null` when no linked plane can answer (DPI is Central-only);
   * a stub payload with `source.note` when the read was attempted and failed.
   * Demo mode serves the authored SITE_APPLICATIONS_DEMO fixture and 404s a
   * site the demo world did not author one for — the same honest 'not
   * reported' the live adapter stamps 'empty', never a fabricated table.
   */
  router.get('/sites/:siteId/applications', (req: Request, res: Response) => {
    settle(res, serveSiteApplications(res, req.params.siteId, req.query));
  });

  /**
   * GET /api/sites/:siteId/sle/export — CSV of polled SLE metric scores for one
   * site (summary columns only; never secrets). Static `export` segment ahead
   * of `/:metric` so Express never treats "export" as a metric name.
   */
  router.get('/sites/:siteId/sle/export', (req: Request, res: Response) => {
    serveSiteSleExport(res, req.params.siteId);
  });

  /**
   * GET /api/sites/:siteId/sle/:metric/export — CSV of one metric's drill
   * (classifiers + impacted clients/APs only; no vendor raw bodies).
   */
  router.get('/sites/:siteId/sle/:metric/export', (req: Request, res: Response) => {
    settle(res, serveSiteSleDrillExport(res, req.params.siteId, req.params.metric.trim()));
  });

  /**
   * GET /api/sites/:siteId/sle/:metric — the drill-down behind ONE SLE metric at
   * ONE site: classifiers, impacted clients/APs and the summary trend.
   *
   * On-demand on purpose: the headline MistSleRow rides the poll, but this read
   * costs four more endpoints per metric, so it runs only when an operator opens
   * the metric — behind the shared TTL cache, single-flight and call-budget
   * gate, exactly like the device/client detail reads. 404 when the site itself
   * is unknown; `sleDetail: null` when no linked plane can answer (SLE is
   * Mist-only); a stub payload with `source.note` when the read was attempted
   * and failed. Demo mode serves the authored MIST_SLE_DRILLDOWN fixtures and
   * 404s a drill the demo world did not author — the same honest 'not reported'
   * the live adapter stamps 'empty', never a fabricated drill.
   */
  router.get('/sites/:siteId/sle/:metric', (req: Request, res: Response) => {
    settle(res, serveSleMetricDetail(res, req.params.siteId, req.params.metric.trim()));
  });

  /**
   * GET /api/sites/:siteId/rogues/export — CSV of Mist rogue/neighbor BSSIDs
   * heard at one site (poll-time only; no secrets). Empty file is a real
   * "nothing heard" answer when the site resolves. Static `export` segment.
   */
  router.get('/sites/:siteId/rogues/export', (req: Request, res: Response) => {
    serveSiteRoguesExport(res, req.params.siteId);
  });

  router.get('/sites/:siteId', (req: Request, res: Response) => {
    settle(res, serveSiteDetail(res, req.params.siteId));
  });
}
