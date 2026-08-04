/**
 * Devices list, bulk lookup, detail, trends, and CSV export routes.
 * Extracted from screens.ts so the god-route can shrink without contract drift.
 *
 * Registration order matters:
 *   GET /devices/export
 *   GET /devices/bulk
 *   GET /devices
 *   GET /devices/:name/clients/export
 *   GET /devices/:name/ports/export
 *   GET /devices/:name
 *   GET /devices/:name/trends/export
 *   GET /devices/:name/trends/hardware
 *   GET /devices/:name/trends/interfaces
 *   GET /devices/:name/trends/ap/:metric
 * so Express never treats "export" or "bulk" as a device name.
 */

import type { Request, Response, Router } from 'express';
import {
  AP_TREND_METRICS,
  AP_TRENDS_DEMO,
  DEVICE_CLIENT_SETS,
  DEVICE_CONFIGS,
  DEVICE_RECONCILIATION,
  DEVICE_TRENDS_EXPORT_PARTS,
  DEVICES,
  LANE_META,
  MIST_AP_STATS,
  SWITCH_HARDWARE_TRENDS_DEMO,
  SWITCH_INTERFACE_TRENDS_DEMO,
  deviceProfile,
  terminalBanner,
  terminalQuickCommands,
  type ApTrendMetric,
  type ApTrendsLive,
  type DeviceCfg,
  type DeviceClientSet,
  type DeviceEvidence,
  type DevicePort,
  type DevicePortRow,
  type DeviceRow,
  type DeviceTrendsExportPart,
  type Plane,
  type SwitchHardwareTrendsLive,
  type SwitchInterfaceTrendsLive,
  type TrendSeries,
  type TrendWindow,
} from '@hpe/shared';
import { settings } from '../../config/settings';
import { sendCsv } from '../../lib/csv';
import { configBackups } from '../../services/configBackup';
import {
  resolveDeviceIdentity,
  safeDeviceCandidates,
  type DeviceIdentity,
} from '../../services/deviceIdentity';
import { type ReconciledDeviceRow } from '../../services/reconcile';
import { registry } from '../../planes/registry';
import { type PlaneAdapter, type PlaneId } from '../../planes/types';
import {
  blendFor,
  dataSource,
  envelopeFor,
  reportedValue,
  sourceFor,
  withBlended,
  type DataSource,
} from './context';
import {
  DETAIL_TTL_MS,
  attemptDetail,
  cachedDetail,
  detailBudgetNote,
  detailPlaneFor,
  liveDeviceDetail,
  liveSiteById,
  liveSiteTopology,
  neverThrows,
  settle,
} from './detailCache';
import {
  liveDeviceClients,
  liveDeviceEvidence,
  liveTerminalPayload,
} from './deviceAccess';
import {
  liveDeviceData,
  planesMissingDevices,
} from './liveCore';
import { applyListPaging, sendCachedJson } from './listQuery';
import { liveMistApStats, mistApStatsFor } from './mistApStats';
import { liveLaneMeta } from './overviewModel';
import { trendWindow } from './helpers';
import { queryFlag, queryString, queryTokens } from '../../lib/query';

/** Shared list filter fields for GET /devices and /devices/export. */
export const DEVICE_LIST_FIELDS = [
  'name',
  'model',
  'siteName',
  'serial',
  'ip',
  'type',
  'state',
  'plane',
  'firmware',
  'mac',
] as const;

/**
 * Devices list filters (list + export):
 *   `?q=` substring across DEVICE_LIST_FIELDS
 *   `?plane=` comma-separated OR (plane label or claimedBy) via shared queryTokens
 *   `?type=` exact device type (case-insensitive)
 *   `?site=` comma-separated OR against siteId or siteName
 *   `?state=` comma-separated OR against row state
 *   `?issues=1|true|yes|on` → reconciliationIssue only (shared queryFlag)
 *   `?issues=0|false|no|off` → clean rows only (no reconciliationIssue)
 * Unknown / empty tokens are no-ops (never invent an empty estate).
 */
export function applyDeviceListFilters(
  req: Request,
  body: Record<string, unknown>,
): Record<string, unknown> {
  const list = body.devices;
  if (!Array.isArray(list)) return body;

  const q = queryString(req, 'q').toLowerCase();
  // Dedupe so plane=central,CENTRAL still matches once.
  const planes = [...new Set(queryTokens(req, 'plane'))];
  const type = queryString(req, 'type').toLowerCase();
  const sites = [...new Set(queryTokens(req, 'site'))];
  const states = [...new Set(queryTokens(req, 'state'))];
  const issuesFlag = queryFlag(req, 'issues');

  if (
    !q &&
    planes.length === 0 &&
    !type &&
    sites.length === 0 &&
    states.length === 0 &&
    issuesFlag === null
  ) {
    return body;
  }

  const filtered = (list as Record<string, unknown>[]).filter((row) => {
    if (issuesFlag === true && !row.reconciliationIssue) return false;
    if (issuesFlag === false && row.reconciliationIssue) return false;
    if (type && String(row.type ?? '').toLowerCase() !== type) return false;
    if (states.length > 0) {
      const st = String(row.state ?? '').toLowerCase();
      if (!states.includes(st)) return false;
    }
    if (planes.length > 0) {
      const p = String(row.plane ?? '').toLowerCase();
      const claimed = Array.isArray(row.claimedBy)
        ? (row.claimedBy as unknown[]).map((x) => String(x).toLowerCase())
        : [];
      if (!planes.includes(p) && !claimed.some((c) => planes.includes(c))) return false;
    }
    if (sites.length > 0) {
      const siteId = String(row.siteId ?? '').toLowerCase();
      const siteName = String(row.siteName ?? row.site ?? '').toLowerCase();
      if (!sites.includes(siteId) && !sites.includes(siteName)) return false;
    }
    if (q) {
      const hay = DEVICE_LIST_FIELDS.map((f) => String(row[f] ?? '')).join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  return { ...body, devices: filtered };
}

export function devicesBody(): Record<string, unknown> {
  if (sourceFor('devices') === 'demo') {
    if (blendFor('devices')) {
      const { devices, doubleClaimed, unclaimed } = liveDeviceData();
      if (devices.length > 0) {
        return withBlended(
          envelopeFor('devices', {
            devices,
            lanes: liveLaneMeta(),
            reconciliation: { doubleClaimed, unclaimed },
            missingInventories: planesMissingDevices(),
          }),
          ['devices'],
          'devices',
        );
      }
    }
    // Operator-pruned fixtures stay hidden from the demo inventory; the list
    // rides along so the UI can offer restore.
    const hidden = settings.get().hiddenDemoDevices ?? [];
    const hiddenSet = new Set(hidden);
    return envelopeFor('devices', {
      devices: DEVICES.filter((d) => !hiddenSet.has(d.name)),
      lanes: LANE_META,
      // The demo estate's authored reconciliation counts. Sent from the
      // route like every other mode's counts, so the screen reads ONE key
      // instead of keeping its own demo-mode fallback beside the payload.
      reconciliation: DEVICE_RECONCILIATION,
      hiddenDevices: hidden,
    });
  }
  const { devices, doubleClaimed, unclaimed } = liveDeviceData();
  return envelopeFor('devices', {
    devices,
    lanes: liveLaneMeta(),
    reconciliation: { doubleClaimed, unclaimed },
    // Which linked planes are NOT represented in the list above. Without
    // this the reconciled inventory is shorter than the estate and says
    // nothing about why (see liveCore.ts planesMissingDevices).
    missingInventories: planesMissingDevices(),
  });
}

/**
 * The config-backup join for /devices/:name.
 *
 * When the backup service has snapshots on disk for THIS device, the detail
 * payload's `config` block is built from them instead of the branch's own
 * answer: Running is the newest snapshot body, Drift the unified diff of the
 * two newest versions ('' before a second version exists — never a fabricated
 * comparison), History the real version list with its pruning gaps. The
 * `provenance` block names the collection channel so the screen can label a
 * real snapshot as one — and can never pass the authored fixture config off
 * as collected, or a collected one as authored.
 *
 * No snapshots (unknown device, no collection source, the sweep has not run)
 * → null, and the caller keeps exactly the config it serves today: the
 * fixture block in the demo branch, null in the live/blend branches.
 */
function snapshotDeviceConfig(device: string): DeviceCfg | null {
  const versions = configBackups.listVersions(device); // newest first
  const latest = versions[0];
  if (!latest) return null;
  const running = configBackups.readVersionContent(device, latest.version);
  // An index naming a version whose body is gone is corrupt on disk — fall
  // back to the branch's own config rather than serve a half-real block.
  if (running === null) return null;
  const previous = versions[1];
  let diff = '';
  if (previous) {
    try {
      diff = configBackups.diffVersions(device, previous.version, latest.version).text;
    } catch {
      diff = ''; // a body pruned between the index read and the diff read
    }
  }
  return {
    meta: `SNAPSHOT v${latest.version} · ${versions.length} VERSION${versions.length === 1 ? '' : 'S'} ON FILE`,
    running,
    diff,
    history: versions.map((v) => ({
      // ISO, not pre-formatted text: the browser stamps it in the reader's own
      // clock (the overview change rows' rule — displayTime in overviewModel).
      when: v.takenAt,
      what: `Snapshot v${v.version} — ${v.lines} lines`,
      who: v.source,
      tag: v.driftFromPrevious ? 'drift' : 'snapshot',
      tone: v.driftFromPrevious ? 'warning' : 'neutral',
    })),
    provenance: {
      version: latest.version,
      versions: versions.length,
      source: latest.source,
      takenAt: latest.takenAt,
    },
  };
}

/**
 * Keys a live device page adds from the per-object read path.
 *
 * `detail` is this ONE device's subresources — radios + WLANs for an AP, ports
 * for a switch or gateway — which no flat list carries. `topology` is the
 * site's link graph, so an AP page can say which switch port it hangs off (the
 * AP has no port list of its own) and a switch page can corroborate its
 * neighbours. Both are cached; the graph is shared with the site page and the
 * client drawer, so opening several pages at one site costs one graph read.
 *
 * `mistAp` is different: the Mist AP rich-stats row (RF, env, power, LLDP) is
 * a POLL dataset, so joining it here costs no per-object call. null when this
 * device is not a Mist AP the stats walk carried — the panel stays away.
 */
async function deviceDetailKeys(
  device: ReconciledDeviceRow,
): Promise<Record<string, unknown>> {
  const [detail, topology] = await Promise.all([
    liveDeviceDetail(device),
    liveSiteTopology(liveSiteById(device.siteId)),
  ]);
  return { detail, topology, mistAp: mistApStatsFor(device, liveMistApStats()) };
}

/** Identity a /devices/:name request can carry on the query string, straight
 *  off the row that linked here (Devices.tsx, the Devices platform-lanes
 *  view, SiteDetail's device table). */
type DeviceIdentityQuery = DeviceIdentity;

function deviceIdentityQuery(req: { query: Record<string, unknown> }): DeviceIdentityQuery {
  const { plane, serial } = req.query;
  return {
    plane: typeof plane === 'string' && plane.length > 0 ? plane : undefined,
    serial: typeof serial === 'string' && serial.length > 0 ? serial : undefined,
  };
}

/** Honest 409 for a name that resolves to more than one physical device —
 *  never picked-first, never a 404 (the name IS known, just not to one row). */
function ambiguousDeviceResponse(
  res: Response,
  name: string,
  dataSourceLabel: DataSource,
  matches: ReadonlyArray<{ plane: Plane; serial?: string; claimedBy?: Plane[] }>,
  extra: Record<string, unknown> = {},
): void {
  res.status(409).json({
    error: `'${name}' names ${matches.length} devices — pass plane and serial to pick one`,
    dataSource: dataSourceLabel,
    candidates: safeDeviceCandidates(matches),
    ...extra,
  });
}

async function serveDeviceDetail(res: Response, name: string, identity: DeviceIdentityQuery): Promise<void> {
  if (sourceFor('devices') === 'demo') {
    // Blend: the devices section has swapped to live rows — a fixture detail
    // (config, clients) for a name the live inventory doesn't know would be
    // fabrication, so the detail follows the section: live row or honest 404.
    if (blendFor('devices')) {
      const liveDevices = liveDeviceData().devices;
      if (liveDevices.length > 0) {
        // Rows arrive shell-gated from liveDeviceData(); nothing to correct here.
        const { device, ambiguous, invalid } = resolveDeviceIdentity(liveDevices, name, identity);
        if (invalid) {
          res.status(400).json({ error: invalid, dataSource: 'demo', blended: ['devices'] });
          return;
        }
        if (ambiguous) {
          ambiguousDeviceResponse(res, name, 'demo', ambiguous, { blended: ['devices'] });
          return;
        }
        if (!device) {
          res.status(404).json({ error: `device '${name}' not in the live inventory`, dataSource: 'demo', blended: ['devices'] });
          return;
        }
        res.json(
          withBlended(
            envelopeFor('devices', {
              device,
              profile: null,
              config: snapshotDeviceConfig(device.name),
              clients: liveDeviceClients(device.name),
              evidence: liveDeviceEvidence(device),
              ...liveTerminalPayload(device),
              ...(await deviceDetailKeys(device)),
            }),
            ['devices'],
            'devices',
          ),
        );
        return;
      }
    }
    const { device: fixtureDevice, ambiguous, invalid } = resolveDeviceIdentity(DEVICES, name, identity);
    if (invalid) {
      res.status(400).json({ error: invalid, dataSource: 'demo' });
      return;
    }
    if (ambiguous) {
      ambiguousDeviceResponse(res, name, 'demo', ambiguous);
      return;
    }
    if (!fixtureDevice) {
      res.status(404).json({ error: `unknown device '${name}'`, dataSource: 'demo' });
      return;
    }
    const profile = deviceProfile(fixtureDevice.name);
    res.json(
      envelopeFor('devices', {
        device: fixtureDevice,
        profile,
        terminal: {
          banner: terminalBanner(profile.kind),
          quickCommands: terminalQuickCommands(profile.kind),
        },
        // Same key as the live branch, so the panel reads one shape in both
        // modes; `mode` says which estate the verdicts describe.
        evidence: { checks: profile.checks, mode: 'demo' } satisfies DeviceEvidence,
        // Real snapshots on file for this fixture win over the authored
        // block — provenance travels with them so the screen labels which
        // of the two it is showing.
        config: snapshotDeviceConfig(fixtureDevice.name) ?? DEVICE_CONFIGS[profile.kind],
        clients: DEVICE_CLIENT_SETS[profile.kind],
        // The demo world's Mist AP rich-stats row for this fixture (null for
        // every non-Mist device) — same key the live branches serve off the
        // Mist poll, so the RF/health panel reads one shape in every mode.
        mistAp: mistApStatsFor(fixtureDevice, MIST_AP_STATS),
      }),
    );
    return;
  }

  // liveDeviceData() has already replaced `localShell` with the live gate, so
  // the served row and the terminal block below cannot disagree.
  const { device, ambiguous, invalid } = resolveDeviceIdentity(liveDeviceData().devices, name, identity);
  if (invalid) {
    res.status(400).json({ error: invalid, dataSource: 'live' });
    return;
  }
  if (ambiguous) {
    ambiguousDeviceResponse(res, name, 'live', ambiguous);
    return;
  }
  if (!device) {
    res.status(404).json({ error: `device '${name}' not in the live cache`, dataSource: 'live' });
    return;
  }
  res.json(
    envelopeFor('devices', {
      device,
      profile: null,
      // The config-backup store is the live branch's running-config source:
      // snapshots on file for this device, or the honest null the screen
      // already renders as "not available in live mode".
      config: snapshotDeviceConfig(device.name),
      clients: liveDeviceClients(device.name),
      // The two facts the live pane was missing next to the reconciled row:
      // this device's own evidence verdicts, and the shell block when the
      // portal can really open one.
      evidence: liveDeviceEvidence(device),
      ...liveTerminalPayload(device),
      ...(await deviceDetailKeys(device)),
    }),
  );
}

// -- Device hardware/telemetry trends (on-demand) ------------------------------
//
// The Central trend reads behind the device page's 'Hardware trends' panel:
// a switch's hardware gauges and interface error counters, and an AP's
// cpu/memory/throughput series. Every read is on-demand (one per open device
// page, per window), TTL-cached, single-flighted and budget-gated — never
// poller work, same contract as the detail reads and the applications route.
// Trend window bounds: shared helper (screens/helpers.ts).

/** A trends payload that carries no data and says why — the same contract as
 *  deviceDetailStub: sections {} reads 'not-fetched' (we chose not to ask,
 *  e.g. the call budget is spent), 'failed' means we asked and it broke. */
function hardwareTrendsStub(
  serial: string,
  window: TrendWindow,
  plane: PlaneId,
  note: string,
  attempted: boolean,
): SwitchHardwareTrendsLive {
  return {
    serial,
    window,
    source: {
      plane,
      at: new Date().toISOString(),
      sections: attempted ? { hardware: 'failed' } : {},
      note,
    },
  };
}

function interfaceTrendsStub(
  serial: string,
  window: TrendWindow,
  plane: PlaneId,
  note: string,
  attempted: boolean,
): SwitchInterfaceTrendsLive {
  return {
    serial,
    window,
    source: {
      plane,
      at: new Date().toISOString(),
      sections: attempted ? { interfaces: 'failed' } : {},
      note,
    },
  };
}

function apTrendsStub(
  serial: string,
  metric: ApTrendMetric,
  window: TrendWindow,
  plane: PlaneId,
  note: string,
  attempted: boolean,
): ApTrendsLive {
  return {
    serial,
    metric,
    window,
    source: {
      plane,
      at: new Date().toISOString(),
      sections: attempted ? { trends: 'failed' } : {},
      note,
    },
  };
}

/**
 * The claimant walk for the per-device trend reads: the first claiming plane
 * whose adapter has the capability wins (the same rule liveSiteTopology
 * applies to a site's badges) — a double-claimed row is asked of the plane
 * that can answer, never assumed to be Central.
 */
function trendClaimant<M extends 'switchHardwareTrends' | 'apTrends' | 'switchInterfaceTrends'>(
  device: ReconciledDeviceRow,
  method: M,
): { planeId: PlaneId; adapter: PlaneAdapter; read: NonNullable<PlaneAdapter[M]> } | null {
  for (const claimant of [device.plane, ...(device.claimedBy ?? [])]) {
    const planeId = detailPlaneFor(claimant);
    if (!planeId) continue;
    const adapter = registry.get(planeId);
    const read = adapter[method];
    if (typeof read === 'function') {
      return { planeId, adapter, read: read as NonNullable<PlaneAdapter[M]> };
    }
  }
  return null;
}

/**
 * The device a trends route serves, resolved with exactly the page route's
 * rules (blend follows the section; serial beats name; ambiguity is a 409,
 * never a picked-first). Returns null once `res` has been answered.
 */
function resolveTrendDevice(
  res: Response,
  name: string,
  identity: DeviceIdentityQuery,
): { device: ReconciledDeviceRow; live: true } | { device: DeviceRow; live: false } | null {
  if (sourceFor('devices') === 'demo') {
    if (blendFor('devices')) {
      const liveDevices = liveDeviceData().devices;
      if (liveDevices.length > 0) {
        const { device, ambiguous, invalid } = resolveDeviceIdentity(liveDevices, name, identity);
        if (invalid) {
          res.status(400).json({ error: invalid, dataSource: 'demo', blended: ['devices'] });
          return null;
        }
        if (ambiguous) {
          ambiguousDeviceResponse(res, name, 'demo', ambiguous, { blended: ['devices'] });
          return null;
        }
        if (!device) {
          res.status(404).json({ error: `device '${name}' not in the live inventory`, dataSource: 'demo', blended: ['devices'] });
          return null;
        }
        return { device, live: true };
      }
    }
    const { device: fixtureDevice, ambiguous, invalid } = resolveDeviceIdentity(DEVICES, name, identity);
    if (invalid) {
      res.status(400).json({ error: invalid, dataSource: 'demo' });
      return null;
    }
    if (ambiguous) {
      ambiguousDeviceResponse(res, name, 'demo', ambiguous);
      return null;
    }
    if (!fixtureDevice) {
      res.status(404).json({ error: `unknown device '${name}'`, dataSource: 'demo' });
      return null;
    }
    return { device: fixtureDevice, live: false };
  }

  const { device, ambiguous, invalid } = resolveDeviceIdentity(liveDeviceData().devices, name, identity);
  if (invalid) {
    res.status(400).json({ error: invalid, dataSource: 'live' });
    return null;
  }
  if (ambiguous) {
    ambiguousDeviceResponse(res, name, 'live', ambiguous);
    return null;
  }
  if (!device) {
    res.status(404).json({ error: `device '${name}' not in the live cache`, dataSource: 'live' });
    return null;
  }
  return { device, live: true };
}

async function serveDeviceHardwareTrends(
  res: Response,
  name: string,
  identity: DeviceIdentityQuery,
  query: { start?: unknown; end?: unknown },
): Promise<void> {
  const resolved = resolveTrendDevice(res, name, identity);
  if (resolved === null) return;
  if (!resolved.live) {
    const hardwareTrends = SWITCH_HARDWARE_TRENDS_DEMO[resolved.device.name] ?? null;
    if (hardwareTrends === null) {
      res.status(404).json({ error: `no hardware-trend read recorded for '${resolved.device.name}'`, dataSource: 'demo' });
      return;
    }
    res.json(envelopeFor('devices', { hardwareTrends }));
    return;
  }
  const device = resolved.device;
  if (device.type !== 'switch') {
    res.status(404).json({
      error: `'${device.name}' is a ${device.type}, not a switch — hardware trends are a Central switch read`,
      dataSource: dataSource(),
    });
    return;
  }
  const window = trendWindow(query);
  res.json(envelopeFor('devices', { hardwareTrends: await liveSwitchHardwareTrends(device, window) }));
}

function liveSwitchHardwareTrends(
  device: ReconciledDeviceRow,
  window: TrendWindow,
): Promise<SwitchHardwareTrendsLive | null> {
  if (!reportedValue(device.serial)) return Promise.resolve(null);
  const claimant = trendClaimant(device, 'switchHardwareTrends');
  if (!claimant) return Promise.resolve(null);
  const serial = device.serial!;
  const budget = detailBudgetNote(claimant.planeId);
  if (budget) return Promise.resolve(hardwareTrendsStub(serial, window, claimant.planeId, budget, false));
  return neverThrows(
    cachedDetail(`hwtrends:${claimant.planeId}:${serial}:${window.start}:${window.end}`, DETAIL_TTL_MS, () =>
      attemptDetail(
        () => claimant.read.call(claimant.adapter, serial, window),
        (note) => hardwareTrendsStub(serial, window, claimant.planeId, note, true),
      ),
    ),
  );
}

async function serveDeviceInterfaceTrends(
  res: Response,
  name: string,
  identity: DeviceIdentityQuery,
  query: { start?: unknown; end?: unknown },
): Promise<void> {
  const resolved = resolveTrendDevice(res, name, identity);
  if (resolved === null) return;
  if (!resolved.live) {
    const interfaceTrends = SWITCH_INTERFACE_TRENDS_DEMO[resolved.device.name] ?? null;
    if (interfaceTrends === null) {
      res.status(404).json({ error: `no interface-trend read recorded for '${resolved.device.name}'`, dataSource: 'demo' });
      return;
    }
    res.json(envelopeFor('devices', { interfaceTrends }));
    return;
  }
  const device = resolved.device;
  if (device.type !== 'switch') {
    res.status(404).json({
      error: `'${device.name}' is a ${device.type}, not a switch — interface trends are a Central switch read`,
      dataSource: dataSource(),
    });
    return;
  }
  const window = trendWindow(query);
  res.json(envelopeFor('devices', { interfaceTrends: await liveSwitchInterfaceTrends(device, window) }));
}

function liveSwitchInterfaceTrends(
  device: ReconciledDeviceRow,
  window: TrendWindow,
): Promise<SwitchInterfaceTrendsLive | null> {
  if (!reportedValue(device.serial)) return Promise.resolve(null);
  const claimant = trendClaimant(device, 'switchInterfaceTrends');
  if (!claimant) return Promise.resolve(null);
  const serial = device.serial!;
  const budget = detailBudgetNote(claimant.planeId);
  if (budget) return Promise.resolve(interfaceTrendsStub(serial, window, claimant.planeId, budget, false));
  return neverThrows(
    cachedDetail(`iftrends:${claimant.planeId}:${serial}:${window.start}:${window.end}`, DETAIL_TTL_MS, () =>
      attemptDetail(
        () => claimant.read.call(claimant.adapter, serial, window),
        (note) => interfaceTrendsStub(serial, window, claimant.planeId, note, true),
      ),
    ),
  );
}

async function serveDeviceApTrends(
  res: Response,
  name: string,
  metricParam: string,
  identity: DeviceIdentityQuery,
  query: { start?: unknown; end?: unknown },
): Promise<void> {
  const metric = metricParam.trim();
  if (!(AP_TREND_METRICS as readonly string[]).includes(metric)) {
    res.status(404).json({
      error: `unknown AP trend metric '${metricParam}' — expected one of ${AP_TREND_METRICS.join(', ')}`,
      dataSource: dataSource(),
    });
    return;
  }
  const resolved = resolveTrendDevice(res, name, identity);
  if (resolved === null) return;
  if (!resolved.live) {
    const apTrends = AP_TRENDS_DEMO[`${resolved.device.name}|${metric}`] ?? null;
    if (apTrends === null) {
      res.status(404).json({
        error: `no AP trend read recorded for '${resolved.device.name}' (${metric})`,
        dataSource: 'demo',
      });
      return;
    }
    res.json(envelopeFor('devices', { apTrends }));
    return;
  }
  const device = resolved.device;
  if (device.type !== 'ap') {
    res.status(404).json({
      error: `'${device.name}' is a ${device.type}, not an AP — ${metric} trends are a Central AP read`,
      dataSource: dataSource(),
    });
    return;
  }
  const window = trendWindow(query);
  res.json(envelopeFor('devices', { apTrends: await liveApTrends(device, metric as ApTrendMetric, window) }));
}

function liveApTrends(
  device: ReconciledDeviceRow,
  metric: ApTrendMetric,
  window: TrendWindow,
): Promise<ApTrendsLive | null> {
  if (!reportedValue(device.serial)) return Promise.resolve(null);
  const claimant = trendClaimant(device, 'apTrends');
  if (!claimant) return Promise.resolve(null);
  const serial = device.serial!;
  const budget = detailBudgetNote(claimant.planeId);
  if (budget) return Promise.resolve(apTrendsStub(serial, metric, window, claimant.planeId, budget, false));
  return neverThrows(
    cachedDetail(`aptrends:${claimant.planeId}:${serial}:${metric}:${window.start}:${window.end}`, DETAIL_TTL_MS, () =>
      attemptDetail(
        () => claimant.read.call(claimant.adapter, serial, metric, window),
        (note) => apTrendsStub(serial, metric, window, claimant.planeId, note, true),
      ),
    ),
  );
}

/** Drop secret-looking metric keys — same spirit as the client trends export. */
function isSecretTrendKey(key: string): boolean {
  const k = key.toLowerCase().replace(/[\s_-]+/g, '');
  return /password|passwd|secret|token|apikey|claimcode|runningconfig|credential|privatekey/.test(k);
}

/** Flatten trend series to CSV rows: metric key / timestamp / numeric sample. */
function trendSeriesExportRows(seriesList: readonly TrendSeries[]): unknown[][] {
  const rows: unknown[][] = [];
  for (const s of seriesList) {
    if (isSecretTrendKey(s.key)) continue;
    for (const p of s.points ?? []) {
      if (p == null || p.v == null) continue;
      rows.push([s.key, p.t, p.v]);
    }
  }
  return rows;
}

function parseTrendsExportPart(raw: unknown): DeviceTrendsExportPart | null {
  const partRaw = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (partRaw === '') return null;
  return (DEVICE_TRENDS_EXPORT_PARTS as readonly string[]).includes(partRaw)
    ? (partRaw as DeviceTrendsExportPart)
    : null;
}

/**
 * GET /api/devices/:name/trends/export?part=hardware|interfaces|ap
 * Optional metric= (required for part=ap), start/end window, plane/serial.
 * Summary samples only — never secrets or raw vendor bodies.
 */
async function serveDeviceTrendsExport(
  res: Response,
  name: string,
  identity: DeviceIdentityQuery,
  query: { part?: unknown; metric?: unknown; start?: unknown; end?: unknown },
): Promise<void> {
  const resolved = resolveTrendDevice(res, name, identity);
  if (resolved === null) return;

  let part = parseTrendsExportPart(query.part);
  if (query.part != null && String(query.part).trim() !== '' && part === null) {
    res.status(400).json({
      error: "part must be 'hardware', 'interfaces', or 'ap'",
      dataSource: dataSource(),
    });
    return;
  }

  const deviceType = resolved.device.type;
  if (part === null) {
    part = deviceType === 'ap' ? 'ap' : 'hardware';
  }

  if (part === 'ap' && deviceType !== 'ap') {
    res.status(404).json({
      error: `'${resolved.device.name}' is a ${deviceType}, not an AP — AP trends export refused`,
      dataSource: dataSource(),
    });
    return;
  }
  if ((part === 'hardware' || part === 'interfaces') && deviceType !== 'switch') {
    res.status(404).json({
      error: `'${resolved.device.name}' is a ${deviceType}, not a switch — ${part} trends export refused`,
      dataSource: dataSource(),
    });
    return;
  }

  let series: TrendSeries[] = [];
  /** Filename discriminator — may be `ap-<metric>` beyond the part enum. */
  let filePart: string = part;
  const window = trendWindow(query);
  const safeName = String(resolved.device.name).replace(/[^\w.-]+/g, '_').slice(0, 80) || 'device';

  if (part === 'hardware') {
    let live: SwitchHardwareTrendsLive | null = null;
    if (!resolved.live) {
      live = SWITCH_HARDWARE_TRENDS_DEMO[resolved.device.name] ?? null;
      if (live === null) {
        res.status(404).json({
          error: `no hardware-trend read recorded for '${resolved.device.name}'`,
          dataSource: 'demo',
        });
        return;
      }
    } else {
      live = await liveSwitchHardwareTrends(resolved.device, window);
      if (live === null) {
        res.status(404).json({
          error: `no hardware trends available for '${resolved.device.name}'`,
          dataSource: dataSource(),
        });
        return;
      }
    }
    series = live.trends?.ok ? live.trends.series : [];
  } else if (part === 'interfaces') {
    let live: SwitchInterfaceTrendsLive | null = null;
    if (!resolved.live) {
      live = SWITCH_INTERFACE_TRENDS_DEMO[resolved.device.name] ?? null;
      if (live === null) {
        res.status(404).json({
          error: `no interface-trend read recorded for '${resolved.device.name}'`,
          dataSource: 'demo',
        });
        return;
      }
    } else {
      live = await liveSwitchInterfaceTrends(resolved.device, window);
      if (live === null) {
        res.status(404).json({
          error: `no interface trends available for '${resolved.device.name}'`,
          dataSource: dataSource(),
        });
        return;
      }
    }
    series = live.trends?.ok ? live.trends.series : [];
  } else {
    const metricRaw = typeof query.metric === 'string' ? query.metric.trim() : '';
    const metric = metricRaw || 'cpu';
    if (!(AP_TREND_METRICS as readonly string[]).includes(metric)) {
      res.status(404).json({
        error: `unknown AP trend metric '${metric}' — expected one of ${AP_TREND_METRICS.join(', ')}`,
        dataSource: dataSource(),
      });
      return;
    }
    filePart = `ap-${metric}`;
    let live: ApTrendsLive | null = null;
    if (!resolved.live) {
      live = AP_TRENDS_DEMO[`${resolved.device.name}|${metric}`] ?? null;
      if (live === null) {
        res.status(404).json({
          error: `no AP trend read recorded for '${resolved.device.name}' (${metric})`,
          dataSource: 'demo',
        });
        return;
      }
    } else {
      live = await liveApTrends(resolved.device, metric as ApTrendMetric, window);
      if (live === null) {
        res.status(404).json({
          error: `no AP trends available for '${resolved.device.name}' (${metric})`,
          dataSource: dataSource(),
        });
        return;
      }
    }
    series = live.trends?.ok ? live.trends.series : [];
  }

  sendCsv(
    res,
    `device-trends-${safeName}-${filePart}.csv`,
    ['metric', 't', 'v'],
    trendSeriesExportRows(series),
  );
}

/**
 * Resolve the clients slice for one device (same identity rules as detail).
 * Returns null only when the HTTP response was already written (4xx).
 */
function resolveDeviceClientsForExport(
  res: Response,
  name: string,
  identity: DeviceIdentityQuery,
): DeviceClientSet | null {
  if (sourceFor('devices') === 'demo') {
    if (blendFor('devices')) {
      const liveDevices = liveDeviceData().devices;
      if (liveDevices.length > 0) {
        const { device, ambiguous, invalid } = resolveDeviceIdentity(liveDevices, name, identity);
        if (invalid) {
          res.status(400).json({ error: invalid, dataSource: 'demo', blended: ['devices'] });
          return null;
        }
        if (ambiguous) {
          ambiguousDeviceResponse(res, name, 'demo', ambiguous, { blended: ['devices'] });
          return null;
        }
        if (!device) {
          res.status(404).json({
            error: `device '${name}' not in the live inventory`,
            dataSource: 'demo',
            blended: ['devices'],
          });
          return null;
        }
        return liveDeviceClients(device.name) ?? { meta: 'No active sessions reported', rows: [] };
      }
    }
    const { device: fixtureDevice, ambiguous, invalid } = resolveDeviceIdentity(DEVICES, name, identity);
    if (invalid) {
      res.status(400).json({ error: invalid, dataSource: 'demo' });
      return null;
    }
    if (ambiguous) {
      ambiguousDeviceResponse(res, name, 'demo', ambiguous);
      return null;
    }
    if (!fixtureDevice) {
      res.status(404).json({ error: `unknown device '${name}'`, dataSource: 'demo' });
      return null;
    }
    const profile = deviceProfile(fixtureDevice.name);
    return DEVICE_CLIENT_SETS[profile.kind] ?? { meta: 'No active sessions reported', rows: [] };
  }

  const { device, ambiguous, invalid } = resolveDeviceIdentity(liveDeviceData().devices, name, identity);
  if (invalid) {
    res.status(400).json({ error: invalid, dataSource: 'live' });
    return null;
  }
  if (ambiguous) {
    ambiguousDeviceResponse(res, name, 'live', ambiguous);
    return null;
  }
  if (!device) {
    res.status(404).json({ error: `device '${name}' not in the live cache`, dataSource: 'live' });
    return null;
  }
  return liveDeviceClients(device.name) ?? { meta: 'No active sessions reported', rows: [] };
}

/** CSV row shape shared by demo profile ports and live DevicePort rows. */
type PortExportRow = {
  port: string;
  what: string;
  state: string;
  neighbour: string;
  neighbourPort: string;
  admin: string;
  oper: string;
  speedBps: string;
};

function profilePortsToExport(ports: readonly DevicePortRow[]): PortExportRow[] {
  return ports.map((p) => ({
    port: p.id,
    what: p.what,
    state: p.state,
    neighbour: '',
    neighbourPort: '',
    admin: '',
    oper: '',
    speedBps: '',
  }));
}

function livePortsToExport(ports: readonly DevicePort[]): PortExportRow[] {
  return ports.map((p) => ({
    port: p.name,
    what: p.status || p.operStatus || '',
    state: p.operStatus || p.status || '',
    neighbour: p.neighbour ?? '',
    neighbourPort: p.neighbourPort ?? '',
    admin: p.adminStatus ?? '',
    oper: p.operStatus ?? '',
    speedBps: p.speedBps == null ? '' : String(p.speedBps),
  }));
}

/**
 * Resolve ports for one device (same identity rules as detail/clients export).
 * Returns null only when the HTTP response was already written (4xx).
 * Empty array = device known but no ports reported (headers-only CSV).
 */
async function resolveDevicePortsForExport(
  res: Response,
  name: string,
  identity: DeviceIdentityQuery,
): Promise<PortExportRow[] | null> {
  if (sourceFor('devices') === 'demo') {
    if (blendFor('devices')) {
      const liveDevices = liveDeviceData().devices;
      if (liveDevices.length > 0) {
        const { device, ambiguous, invalid } = resolveDeviceIdentity(liveDevices, name, identity);
        if (invalid) {
          res.status(400).json({ error: invalid, dataSource: 'demo', blended: ['devices'] });
          return null;
        }
        if (ambiguous) {
          ambiguousDeviceResponse(res, name, 'demo', ambiguous, { blended: ['devices'] });
          return null;
        }
        if (!device) {
          res.status(404).json({
            error: `device '${name}' not in the live inventory`,
            dataSource: 'demo',
            blended: ['devices'],
          });
          return null;
        }
        const detail = await liveDeviceDetail(device);
        return livePortsToExport(detail?.ports ?? []);
      }
    }
    const { device: fixtureDevice, ambiguous, invalid } = resolveDeviceIdentity(DEVICES, name, identity);
    if (invalid) {
      res.status(400).json({ error: invalid, dataSource: 'demo' });
      return null;
    }
    if (ambiguous) {
      ambiguousDeviceResponse(res, name, 'demo', ambiguous);
      return null;
    }
    if (!fixtureDevice) {
      res.status(404).json({ error: `unknown device '${name}'`, dataSource: 'demo' });
      return null;
    }
    const profile = deviceProfile(fixtureDevice.name);
    return profilePortsToExport(profile.ports);
  }

  const { device, ambiguous, invalid } = resolveDeviceIdentity(liveDeviceData().devices, name, identity);
  if (invalid) {
    res.status(400).json({ error: invalid, dataSource: 'live' });
    return null;
  }
  if (ambiguous) {
    ambiguousDeviceResponse(res, name, 'live', ambiguous);
    return null;
  }
  if (!device) {
    res.status(404).json({ error: `device '${name}' not in the live cache`, dataSource: 'live' });
    return null;
  }
  const detail = await liveDeviceDetail(device);
  return livePortsToExport(detail?.ports ?? []);
}

export function registerDevicesRoutes(router: Router): void {
  /**
   * GET /api/devices/export — CSV of device inventory
   * (optional q/plane/type/site/state/issues).
   * Must stay ahead of /devices/:name so "export" is never a param.
   */
  router.get('/devices/export', (req, res) => {
    const body = devicesBody();
    const filtered = applyDeviceListFilters(req, body);
    const rows = (filtered.devices as Array<Record<string, unknown>>) ?? [];
    sendCsv(
      res,
      'devices.csv',
      ['name', 'type', 'model', 'site', 'plane', 'state', 'firmware', 'serial', 'mac', 'ip', 'licence'],
      rows.map((d) => [
        d.name,
        d.type,
        d.model,
        d.siteName ?? d.site,
        d.plane,
        d.state,
        d.firmware,
        d.serial ?? '',
        d.mac ?? '',
        d.ip ?? '',
        d.licence,
      ]),
    );
  });

  /**
   * GET /api/devices/bulk?serials=a,b&planes=mist,central
   * Lookup by serial (max 50). Before /devices/:name so "bulk" is not a name.
   */
  router.get('/devices/bulk', (req, res) => {
    const raw =
      typeof req.query.serials === 'string'
        ? req.query.serials
        : Array.isArray(req.query.serials)
          ? req.query.serials.filter((v): v is string => typeof v === 'string').join(',')
          : '';
    const serials = [
      ...new Set(
        raw
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s.length > 0),
      ),
    ].slice(0, 50);
    if (serials.length === 0) {
      res.status(400).json({ error: 'serials query required (comma-separated)', code: 'BULK_SERIALS_REQUIRED' });
      return;
    }
    const planeFilterRaw =
      typeof req.query.planes === 'string'
        ? req.query.planes
            .split(',')
            .map((s) => s.trim().toLowerCase())
            .filter(Boolean)
        : [];
    const planeSet = planeFilterRaw.length > 0 ? new Set(planeFilterRaw) : null;

    const body = devicesBody();
    const all = (body.devices as Array<Record<string, unknown>>) ?? [];
    const wanted = new Set(serials.map((s) => s.toLowerCase()));
    const devices = all.filter((d) => {
      const serial = String(d.serial ?? '').trim();
      if (!serial || !wanted.has(serial.toLowerCase())) return false;
      if (!planeSet) return true;
      const plane = String(d.plane ?? '').toLowerCase();
      const claimed = Array.isArray(d.claimedBy)
        ? (d.claimedBy as unknown[]).map((p) => String(p).toLowerCase())
        : [];
      return planeSet.has(plane) || claimed.some((p) => planeSet.has(p));
    });
    const found = new Set(
      devices.map((d) => String(d.serial ?? '').trim().toLowerCase()).filter(Boolean),
    );
    const missing = serials.filter((s) => !found.has(s.toLowerCase()));
    sendCachedJson(
      req,
      res,
      envelopeFor('devices', {
        devices,
        missing,
        requested: serials.length,
      }) as Record<string, unknown>,
    );
  });

  router.get('/devices', (req, res) => {
    const body = devicesBody();
    const paged = applyListPaging(req, applyDeviceListFilters(req, body), 'devices');
    if ('error' in paged) {
      res.status(400).json({ error: paged.error, code: 'PAGINATION_VALIDATION' });
      return;
    }
    sendCachedJson(req, res, paged.body);
  });

  /**
   * GET /api/devices/:name/clients/export — CSV of sessions attached to one
   * device (optional plane/serial identity). Empty CSV (headers only) when the
   * device exists but no sessions were reported. 4xx when identity fails.
   */
  router.get('/devices/:name/clients/export', (req, res) => {
    const clients = resolveDeviceClientsForExport(res, req.params.name, deviceIdentityQuery(req));
    if (!clients) return;
    const safe = String(req.params.name).replace(/[^\w.-]+/g, '_').slice(0, 80) || 'device';
    sendCsv(
      res,
      `device-clients-${safe}.csv`,
      ['client', 'model', 'mac', 'ip', 'where', 'state', 'detail'],
      clients.rows.map((c) => [
        c.name,
        c.model ?? '',
        c.mac ?? '',
        c.ip ?? '',
        c.where ?? '',
        c.state,
        c.detail,
      ]),
    );
  });

  /**
   * GET /api/devices/:name/ports/export — CSV of port / interface rows for one
   * device (optional plane/serial identity). Demo uses authored profile ports;
   * live uses the on-demand detail ports slice. Empty CSV (headers only) when
   * the device exists but no ports were reported. 4xx when identity fails.
   */
  router.get('/devices/:name/ports/export', (req, res) => {
    settle(res, (async () => {
      const ports = await resolveDevicePortsForExport(res, req.params.name, deviceIdentityQuery(req));
      if (!ports) return;
      const safe = String(req.params.name).replace(/[^\w.-]+/g, '_').slice(0, 80) || 'device';
      sendCsv(
        res,
        `device-ports-${safe}.csv`,
        ['port', 'what', 'state', 'neighbour', 'neighbourPort', 'admin', 'oper', 'speedBps'],
        ports.map((p) => [
          p.port,
          p.what,
          p.state,
          p.neighbour,
          p.neighbourPort,
          p.admin,
          p.oper,
          p.speedBps,
        ]),
      );
    })());
  });

  router.get('/devices/:name', (req, res) => {
    settle(res, serveDeviceDetail(res, req.params.name, deviceIdentityQuery(req)));
  });

  /**
   * GET /api/devices/:name/trends/export — CSV of trend samples
   * (`part=hardware|interfaces|ap`, optional `metric=` for AP, optional window).
   * Static `export` segment ahead of hardware/interfaces/ap so Express never
   * treats "export" as a trend kind. Metric key / timestamp / value only.
   */
  router.get('/devices/:name/trends/export', (req, res) => {
    settle(
      res,
      serveDeviceTrendsExport(res, req.params.name, deviceIdentityQuery(req), req.query),
    );
  });

  /**
   * GET /api/devices/:name/trends/hardware — a switch's hardware gauges
   * (cpu/memory/temperature/PoE/power) for ONE window (default the last 24h).
   *
   * 404 when the device is unknown, when it is not a switch (asking one costs
   * a guaranteed-404 call against a metered plane — refused before spending
   * it), or when demo mode holds no authored read for it. `hardwareTrends:
   * null` when no claiming plane can answer; a stub payload with `source.note`
   * when the read was attempted and failed.
   */
  router.get('/devices/:name/trends/hardware', (req, res) => {
    settle(res, serveDeviceHardwareTrends(res, req.params.name, deviceIdentityQuery(req), req.query));
  });

  /**
   * GET /api/devices/:name/trends/interfaces — a switch's interface byte/error
   * counter trends for ONE window. Same resolution and refusal rules as the
   * hardware read above.
   */
  router.get('/devices/:name/trends/interfaces', (req, res) => {
    settle(res, serveDeviceInterfaceTrends(res, req.params.name, deviceIdentityQuery(req), req.query));
  });

  /**
   * GET /api/devices/:name/trends/ap/:metric — ONE AP metric trend
   * (cpu | memory | throughput; the throughput series arrives bytes-per-bucket
   * and is normalized to bit/s) for ONE window. A metric outside the endpoint
   * vocabulary is a caller mistake, answered in words before anything is
   * resolved or called.
   */
  router.get('/devices/:name/trends/ap/:metric', (req, res) => {
    settle(res, serveDeviceApTrends(res, req.params.name, req.params.metric, deviceIdentityQuery(req), req.query));
  });
}
