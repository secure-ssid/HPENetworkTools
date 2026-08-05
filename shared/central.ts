/**
 * shared/central.ts — the Central plane screen's payload composition.
 *
 * One GET /api/central answers what the Central plane itself manages: its
 * devices, sites, clients, alerts and WLAN inventory, all off the poller
 * cache (the DPI application table and the hardware trends stay ON-DEMAND
 * reads — they never ride a screen payload). The composers are pure and live
 * here because three callers must agree byte-for-byte: the route's demo
 * branch, its live branch, and the web client's offline demo fallback.
 *
 * Honesty rules the composers keep:
 *  - a dataset the plane did not report is `null` on the way in and named in
 *    the route's `notReported` on the way out — an absent roster is never an
 *    implied empty estate;
 *  - health percentages are shares of KNOWN-state devices only, null when
 *    nothing has a verifiable state — never a fabricated 0%;
 *  - the firmware section is the plane's own verdict (firmwareApproved /
 *    firmwareTarget / firmwareUpdate), not a comparison the portal invented.
 */

import {
  ALERTS,
  CLIENTS,
  DEVICES,
  SITES,
  SSIDS,
  SYSTEMS,
  siteDisplayName,
} from './fixtures';
import {
  SITE_IDS,
  type AlertRow,
  type CentralFirmwareRow,
  type CentralFleetSummary,
  type CentralPlaneStatus,
  type CentralSiteRow,
  type ClientRow,
  type DeviceRow,
  type SiteId,
  type SsidObject,
  type StatDef,
} from './types';
import { isAssertableState } from './expiry';

/**
 * The demo world's frozen clock for the plane status block — the same stamp
 * the demo DPI/trends sources carry (fixtures.ts DPI_DEMO_SOURCE_AT). A
 * moving 'now' would make the demo payload non-deterministic.
 */
export const CENTRAL_DEMO_LAST_SYNC = '2026-07-26T11:59:00.000Z';

/** Bookkeeping pseudo-sites (types.ts SITE_IDS) never become site rows. */
const BOOKKEEPING_SITE_IDS: readonly string[] = ['core-services', 'workspace', 'multiple'];

/** Fleet rollup: totals by device type and by verbatim state word. */
export function centralFleetSummary(devices: readonly DeviceRow[]): CentralFleetSummary {
  const byType: CentralFleetSummary['byType'] = {};
  const byState: Record<string, number> = {};
  for (const d of devices) {
    byType[d.type] = (byType[d.type] ?? 0) + 1;
    byState[d.state] = (byState[d.state] ?? 0) + 1;
  }
  return { total: devices.length, byType, byState };
}

/**
 * Per-site rollup of the plane's own rows. `siteIds` seeds the rows the
 * plane's site LIST names (in the plane's order); sites that only a device
 * or client row names follow in first-seen order. `clients: null` (roster
 * not reported) flows through as a null count, and `alerts: null` (feed not
 * reported) as a null open-alert count — the screen words them, the composer
 * does not zero them.
 */
export function centralSiteRows(input: {
  devices: readonly DeviceRow[] | null;
  clients: readonly ClientRow[] | null;
  alerts: readonly AlertRow[] | null;
  siteIds?: readonly SiteId[];
}): CentralSiteRow[] {
  const { clients, alerts } = input;
  // null is "the pull carried no device inventory", which the site rows must
  // not spend as an empty estate: sites and devices are separate reads and one
  // can arrive without the other.
  const devices = input.devices ?? [];
  const ids: SiteId[] = [];
  const note = (id: SiteId): void => {
    if (BOOKKEEPING_SITE_IDS.includes(id) || ids.includes(id)) return;
    ids.push(id);
  };
  for (const id of input.siteIds ?? []) note(id);
  for (const d of devices) note(d.siteId);
  for (const c of clients ?? []) note(c.siteId);

  return ids.map((siteId) => {
    const siteDevices = devices.filter((d) => d.siteId === siteId);
    const known = siteDevices.filter((d) => isAssertableState(d.state));
    const up = known.filter((d) => d.state === 'up').length;
    const siteName =
      siteDevices[0]?.siteName ??
      clients?.find((c) => c.siteId === siteId)?.siteName ??
      ((SITE_IDS as readonly string[]).includes(siteId) ? siteDisplayName(siteId) : siteId);
    return {
      siteId,
      siteName,
      devices: input.devices === null ? null : siteDevices.length,
      clients: clients === null ? null : clients.filter((c) => c.siteId === siteId).length,
      healthPct: known.length === 0 ? null : Math.round((up / known.length) * 100),
      openAlerts:
        alerts === null
          ? null
          : alerts.filter((a) => a.siteId === siteId && a.state === 'open').length,
    };
  });
}

/**
 * Devices behind their recommended train — the plane's approved-train flag
 * is the verdict, carried with the recommended train and the plane's own
 * upgrade state word when it reported them. Sorted by site then name so a
 * site with several behind reads as one place to go.
 */
export function centralFirmwareRows(devices: readonly DeviceRow[]): CentralFirmwareRow[] {
  return devices
    .filter((d) => !d.firmwareApproved)
    .map((d) => ({
      name: d.name,
      model: d.model,
      type: d.type,
      siteId: d.siteId,
      siteName: d.siteName,
      ...(d.serial !== undefined ? { serial: d.serial } : {}),
      firmware: d.firmware,
      target: d.firmwareTarget ?? null,
      update: d.firmwareUpdate ?? null,
    }))
    .sort((a, b) => a.siteName.localeCompare(b.siteName) || a.name.localeCompare(b.name));
}

/**
 * The header tiles. null counts are unread datasets, not zeros — the same
 * wording the Sites screen's stats use ('no client roster reported').
 */
export function centralStats(input: {
  fleet: CentralFleetSummary;
  clients: number | null;
  openAlerts: number | null;
  sites: number;
}): StatDef[] {
  const { fleet } = input;
  const up = fleet.byState.up ?? 0;
  const down = fleet.byState.down ?? 0;
  const other = fleet.total - up - down;
  return [
    {
      label: 'Devices',
      value: String(fleet.total),
      delta:
        fleet.total === 0
          ? 'none in this plane’s inventory'
          : `${up} up · ${down} down${other > 0 ? ` · ${other} other` : ''}`,
      tone: down > 0 ? 'negative' : 'neutral',
    },
    {
      label: 'Clients',
      value: input.clients === null ? '—' : String(input.clients),
      delta: input.clients === null ? 'no client roster reported' : 'active sessions reported',
      tone: 'neutral',
    },
    {
      label: 'Open alerts',
      value: input.openAlerts === null ? '—' : String(input.openAlerts),
      delta:
        input.openAlerts === null
          ? 'no alert feed reported'
          : input.openAlerts > 0
            ? 'sourced from this plane'
            : 'none open',
      tone: input.openAlerts !== null && input.openAlerts > 0 ? 'negative' : 'neutral',
    },
    {
      label: 'Sites',
      value: String(input.sites),
      delta: 'managed by this plane',
      tone: 'neutral',
    },
  ];
}

/** The payload sections, composed from whatever rows the caller has. null
 *  inputs are unread datasets: their sections compose to empty lists and the
 *  caller names them in `notReported` so the screen words the difference. */
export interface CentralSections {
  plane: CentralPlaneStatus;
  stats: StatDef[];
  fleet: CentralFleetSummary;
  sites: CentralSiteRow[];
  firmware: CentralFirmwareRow[];
  wlans: SsidObject[];
  alerts: AlertRow[];
}

export function centralSections(input: {
  plane: CentralPlaneStatus;
  devices: readonly DeviceRow[] | null;
  clients: readonly ClientRow[] | null;
  alerts: readonly AlertRow[] | null;
  wlans: readonly SsidObject[] | null;
  siteIds?: readonly SiteId[];
}): CentralSections {
  const fleet = centralFleetSummary(input.devices ?? []);
  const sites = centralSiteRows({
    devices: input.devices,
    clients: input.clients,
    alerts: input.alerts,
    siteIds: input.siteIds,
  });
  return {
    plane: input.plane,
    stats: centralStats({
      fleet,
      clients: input.clients === null ? null : input.clients.length,
      openAlerts:
        input.alerts === null ? null : input.alerts.filter((a) => a.state === 'open').length,
      sites: sites.length,
    }),
    fleet,
    sites,
    firmware: centralFirmwareRows(input.devices ?? []),
    wlans: [...(input.wlans ?? [])],
    alerts: [...(input.alerts ?? [])],
  };
}

/** The demo estate's Central plane status, read off the authored SYSTEMS row
 *  so the screen and Connected systems never tell two stories about the demo
 *  plane's health. */
export function demoCentralPlaneStatus(): CentralPlaneStatus {
  const row = SYSTEMS.find((s) => s.name === 'HPE Aruba Central');
  return {
    linked: true,
    health: row?.state ?? 'healthy',
    tone: row?.tone ?? 'success',
    lastSync: CENTRAL_DEMO_LAST_SYNC,
    note: null,
  };
}

/**
 * The demo composition: the authored estate's CENTRAL slice. The route's
 * demo branch and the web client's offline fallback both serve exactly this,
 * so the screen cannot change shape depending on whether the server is up.
 *
 * `alerts` lets the route substitute the queue it already processed (silence
 * partition, webhook deliveries) for the raw fixture filter — every other
 * section stays on the one derivation either way.
 */
export function demoCentralSections(alerts?: readonly AlertRow[]): CentralSections {
  return centralSections({
    plane: demoCentralPlaneStatus(),
    devices: DEVICES.filter((d) => d.plane === 'CENTRAL'),
    clients: CLIENTS.filter((c) => c.plane === 'CENTRAL'),
    alerts: alerts !== undefined ? [...alerts] : ALERTS.filter((a) => a.plane === 'CENTRAL'),
    // The plane label is a ' + '-joined list ('CENTRAL + MIST') — split,
    // never substring-match, so a lookalike label could never leak in.
    wlans: SSIDS.filter((s) => s.plane.split('+').map((p) => p.trim()).includes('CENTRAL')),
    siteIds: SITES.filter((s) => s.planes.some((p) => p.name === 'CENTRAL')).map((s) => s.id),
  });
}
