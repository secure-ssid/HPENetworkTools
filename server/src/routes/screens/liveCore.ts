/**
 * Live view-model builders shared by more than one screen.
 *
 * Reconciled devices, merged sites, deduped alerts and clients: the Overview,
 * Devices, Sites, Clients, Configure and Compliance screens all read some of
 * these, so they cannot live with any one of them. Everything here answers
 * from the poller's last pull and reports an unread dataset as unread rather
 * than as empty.
 */

import {
  normalizeMac,
  type AuthEventTimeHint,
} from '../../planes/clearpass';
import { type SubscriptionMetricHints } from '../../planes/greenlake';
import { registry } from '../../planes/registry';
import { type PlaneId } from '../../planes/types';
import { poller } from '../../services/poller';
import {
  planeIdForLabel,
  reconcileDevices,
  type ReconciledDeviceRow,
} from '../../services/reconcile';
import { mixString } from './complianceModel';
import {
  datasetReported,
  isSiteId,
  planeIsStale,
  reportedValue,
  stalePlanes,
} from './context';
import { withLiveShellGate } from './deviceAccess';
import { relSync } from './overviewModel';
import {
  siteDisplayName,
  type AlertCorrelation,
  type AlertRow,
  type AuthEventRow,
  type ClientRow,
  type DeviceRow,
  type Plane,
  type Sev,
  type SiteId,
  type SitePlaneBadge,
  type SiteRow,
  type StatDef,
  type SubscriptionRow,
} from '@hpe/shared';

/**
 * Reconcile every plane's last good device list into one row per device.
 *
 * The `localShell` on the rows that leave here is the LIVE gate, not the
 * claiming planes' row claim. reconcile.ts can only union what the planes
 * asserted — it is a pure module with no registry and no credential store, and
 * terminal.ts imports from it, so it cannot import back — which makes this the
 * first place that knows the other two facts (the claiming planes'
 * capabilities() and whether the collector credentials that ARE the shell path
 * exist). Correcting it once, here, is what stops one consumer offering a shell
 * another would refuse: the Launchpad SSH row, the site reachability core, the
 * device-detail flag and its terminal block all read the same corrected field.
 */
export function liveDeviceData(): { devices: ReconciledDeviceRow[]; doubleClaimed: number; unclaimed: number } {
  const byPlane: Partial<Record<PlaneId, readonly DeviceRow[]>> = {};
  for (const [id, pull] of poller.contributionsByPlane()) {
    if (pull.devices) byPlane[id] = pull.devices;
  }
  const { devices, doubleClaimed, unclaimed } = reconcileDevices(byPlane, stalePlanes());
  return { devices: devices.map(withLiveShellGate), doubleClaimed, unclaimed };
}

/** Parse the fixtures'/adapters' age strings ('45s', '12m', '6h', '2d') → minutes. */
export function ageMinutes(age: string): number {
  const m = age.trim().match(/^(\d+)\s*([smhd])$/);
  if (!m) return 0;
  const n = Number(m[1]);
  switch (m[2]) {
    case 's':
      return n / 60;
    case 'h':
      return n * 60;
    case 'd':
      return n * 60 * 24;
    default:
      return n; // 'm'
  }
}

export const SEV_RANK: Record<Sev, number> = { P1: 0, P2: 1, P3: 2 };

/** Merged alert queue: P1 first; within a severity, oldest unresolved first. */
export function sortLiveAlerts(alerts: AlertRow[]): AlertRow[] {
  return [...alerts].sort((a, b) => SEV_RANK[a.sev] - SEV_RANK[b.sev] || ageMinutes(b.age) - ageMinutes(a.age));
}

/**
 * One row per endpoint across planes: a session reported by both a cloud
 * plane and ClearPass is the same client. Keyed on the normalised 12-hex
 * MAC; rows without a real MAC ('—') cannot be matched and all stay.
 */
export function dedupeClients(clients: ClientRow[]): ClientRow[] {
  const seen = new Set<string>();
  return clients.filter((c) => {
    if (!c.mac || c.mac === '—') return true;
    const key = normalizeMac(c.mac);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * One row per alert identity: the plane's own alertId when it reports one,
 * else plane+title+device. The plane stays in the key — two planes flagging
 * the same symptom are two sources, not one duplicate.
 */
export function dedupeAlerts(alerts: AlertRow[]): AlertRow[] {
  const seen = new Set<string>();
  return alerts.filter((a) => {
    const key = a.alertId ? `${a.plane}|${a.alertId}` : `${a.plane}|${a.title}|${a.device}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Live alert queue: every row carries whether the plane that reported it is
 * currently behind. Design rule 1 — a degraded plane's last-good alert is
 * unverified, not current, and its `age` was frozen at pull time; the row
 * stays (an operator still needs to see it) but says so.
 */
export function liveAlerts(): AlertRow[] {
  const stale = stalePlanes();
  const rows: AlertRow[] = [];
  for (const [id, pull] of poller.contributionsByPlane()) {
    if (!pull.alerts) continue;
    const behind = stale.has(id);
    for (const alert of pull.alerts) rows.push(behind ? { ...alert, stale: true } : alert);
  }
  return dedupeAlerts(rows);
}

/**
 * The banner over the live alert queue (README §5): the worst open row,
 * crossed with the worst OTHER open row whose plane is behind. Both halves are
 * read off the rows — nothing is asserted about a site the portal never
 * fetched — and the tone says which of the two facts is doing the talking: a
 * P1 estate is 'danger', a queue whose second finding is only "we cannot see
 * that plane" is 'warning'. Null when nothing is open, so no banner renders.
 */
export function liveCorrelation(alerts: AlertRow[]): AlertCorrelation | null {
  const open = alerts.filter((a) => a.state === 'open');
  const worst = open.find((a) => a.sev === 'P1') ?? open.find((a) => a.sev === 'P2') ?? open[0];
  if (!worst) return null;
  const behind = open.filter((a) => a !== worst && a.stale);
  const partner = behind.find((a) => a.siteId === worst.siteId) ?? behind[0];
  const lead = `${worst.detail} · ${worst.siteName} · ${worst.plane} · ${worst.age}.`;
  return {
    tone: worst.sev === 'P1' ? 'danger' : 'warning',
    title: partner ? `${worst.title} — and ${partner.plane} is stale` : worst.title,
    body: partner
      ? `${lead} Second finding: ${partner.title} — ${partner.plane} is behind, so that row's age was frozen at pull time and its state is unverified, not current.`
      : lead,
  };
}

/**
 * Live client sessions with the same honesty rule the device path applies:
 * a session last reported by a plane that is now degraded cannot be asserted
 * as a healthy current session. Fresh planes' rows are deduped first so a
 * fresh row always outranks a stale one for the same endpoint.
 */
export function liveClients(): ClientRow[] {
  const stale = stalePlanes();
  const fresh: ClientRow[] = [];
  const behind: ClientRow[] = [];
  for (const [id, pull] of poller.contributionsByPlane()) {
    if (!pull.clients) continue;
    if (stale.has(id)) {
      for (const client of pull.clients) {
        behind.push({ ...client, health: 'unverified', healthTone: 'neutral', problem: false });
      }
    } else {
      fresh.push(...pull.clients);
    }
  }
  return enrichClientsWithAuth(dedupeClients([...fresh, ...behind]));
}

/**
 * Newest auth decision per endpoint, keyed on the normalised MAC — the same
 * key the client dedupe uses, so the two feeds join on one identity. Rows
 * without a timestamp keep their feed order (first wins), which is how every
 * adapter returns them: newest first.
 */
export function authEventsByMac(): Map<string, LiveAuthEvent> {
  const out = new Map<string, LiveAuthEvent>();
  for (const event of poller.getCache().authEvents as LiveAuthEvent[]) {
    if (!event.mac || event.mac === '—') continue;
    const key = normalizeMac(event.mac);
    const seen = out.get(key);
    if (!seen) {
      out.set(key, event);
      continue;
    }
    if (event.tsMs !== undefined && (seen.tsMs === undefined || event.tsMs > seen.tsMs)) out.set(key, event);
  }
  return out;
}

/**
 * The cross-plane stitch the Clients screen exists for: a cloud plane knows
 * the session, the policy plane knows who authorised it. Central's mapper
 * leaves `authBy` at '—' precisely because "ClearPass rows will" supply it —
 * and nothing ever did. Only genuinely unreported fields are filled, so a
 * plane that DOES name the authenticator always wins, and an endpoint with no
 * matching decision keeps its '—' rather than being given an invented one.
 */
export function enrichClientsWithAuth(clients: ClientRow[]): ClientRow[] {
  const byMac = authEventsByMac();
  if (byMac.size === 0) return clients;
  return clients.map((client) => {
    if (!client.mac || client.mac === '—') return client;
    const event = byMac.get(normalizeMac(client.mac));
    if (!event) return client;
    const authBy = reportedValue(event.nas) ? event.nas : event.plane;
    return {
      ...client,
      auth: reportedValue(client.auth) ? client.auth : reportedValue(event.method) ? event.method : client.auth,
      authBy: reportedValue(client.authBy) ? client.authBy : authBy,
      role: reportedValue(client.role) ? client.role : reportedValue(event.role) ? event.role : client.role,
    };
  });
}

export function skeletonSite(id: SiteId, name: string): SiteRow {
  return {
    id,
    name,
    subnet: '—',
    planes: [],
    mix: '—',
    devices: 0,
    clients: '0',
    health: null,
    healthPct: '—',
    tone: 'stale',
    alerts: '—',
    alertTone: 'neutral',
    sync: '—',
  };
}

export function isBookkeepingSiteId(id: SiteId): boolean {
  return id === 'core-services' || id === 'workspace' || id === 'multiple';
}

/**
 * "Last sync" for a merged site row: the OLDEST last-sync across the planes
 * that claim it, because staleness is the point of the column (README §"State
 * management": a plane 6h behind must say so). Planes that never synced, and
 * labels with no registry plane, contribute nothing rather than a false '—'.
 */
export function siteSyncFor(badges: Iterable<Plane>): string {
  let oldest: string | null = null;
  let anyClaim = false;
  for (const label of badges) {
    const id = planeIdForLabel(label);
    if (!id) continue;
    anyClaim = true;
    const last = registry.state(id).lastSync;
    if (!last) return 'never'; // a claimant that has never answered decides
    if (oldest === null || last < oldest) oldest = last;
  }
  if (!anyClaim) return '—';
  return oldest === null ? '—' : relSync(oldest);
}

/**
 * Merge per-plane site rows by SiteId: the managed-by badges union across
 * planes (a site can answer to two planes — the design's point), while
 * device/client counts, the mix and the health bar are derived from the
 * reconciled inventory + live alerts rather than any single plane's say-so.
 * Devices/clients at a physical site no plane reported a row for still get a
 * row. Bookkeeping ids such as `multiple` never become fake Sites entries.
 */
export function mergeLiveSites(
  rows: SiteRow[],
  devices: ReconciledDeviceRow[],
  clients: ClientRow[],
  alerts: AlertRow[],
): SiteRow[] {
  const clientsReported = datasetReported('clients');
  const alertsReported = datasetReported('alerts');
  const stale = stalePlanes();
  const ids: SiteId[] = [];
  const byId = new Map<SiteId, SiteRow[]>();
  const note = (id: SiteId, row: SiteRow): void => {
    const list = byId.get(id);
    if (list) list.push(row);
    else {
      byId.set(id, [row]);
      ids.push(id);
    }
  };
  for (const row of rows) note(row.id, row);
  for (const d of devices) {
    if (!isBookkeepingSiteId(d.siteId) && !byId.has(d.siteId)) note(d.siteId, skeletonSite(d.siteId, d.siteName));
  }
  for (const c of clients) {
    if (!isBookkeepingSiteId(c.siteId) && !byId.has(c.siteId)) note(c.siteId, skeletonSite(c.siteId, c.siteName));
  }

  const merged: SiteRow[] = [];
  for (const id of ids) {
    const siteRows = byId.get(id)!;
    const devs = devices.filter((d) => d.siteId === id);
    const cls = clients.filter((c) => c.siteId === id);
    const open = alerts.filter((a) => a.siteId === id && a.state === 'open');
    const badges = new Map<Plane, SitePlaneBadge>();
    for (const r of siteRows) {
      for (const b of r.planes) if (!badges.has(b.name)) badges.set(b.name, b);
    }
    // The adapter site rows only ever name the planes that PUBLISH sites
    // (Central, Mist today). Every claim on a device at this site is also a
    // claim on the site — AOS-8 controllers, UXI sensors, the local collector
    // and ClearPass must badge here too, or "Managed by" drops the exact fact
    // it exists to show. Adapter badges stay first so their tone wins.
    for (const d of devs) {
      for (const name of d.claimedBy && d.claimedBy.length > 0 ? d.claimedBy : [d.plane]) {
        if (!badges.has(name)) badges.set(name, { name, tone: name === d.plane ? d.planeTone : 'neutral' });
      }
    }
    const knownStateDevices = devs.filter((d) => d.state === 'up' || d.state === 'down');
    const up = knownStateDevices.filter((d) => d.state === 'up').length;
    const healthPct =
      knownStateDevices.length > 0 ? Math.round((up / knownStateDevices.length) * 100) : null;
    // This site's alert picture cannot be asserted when a plane that claims it
    // is behind, or when nothing here has a verifiable state: the feed the
    // 'clear' badge would be read off is last-good, not current. The fixture
    // encodes the intended row for exactly this case (Riverside: alerts
    // 'stale', neutral). Real open rows still win — a stale plane must never
    // HIDE an alert, only stop the portal from claiming there are none.
    const siteStale =
      [...badges.keys()].some((name) => planeIsStale(name, stale)) ||
      (devs.length > 0 && knownStateDevices.length === 0);
    merged.push({
      id,
      name: isSiteId(id) ? siteDisplayName(id) : siteRows[0].name,
      subnet: siteRows.map((r) => r.subnet).find((s) => s && s !== '—') ?? '—',
      planes: [...badges.values()],
      mix: mixString(devs),
      devices: devs.length,
      clients: clientsReported ? cls.length.toLocaleString('en-US') : '—',
      health: healthPct === null ? null : `${healthPct}%`,
      healthPct: healthPct === null ? '—' : `${healthPct}%`,
      tone: healthPct === null ? 'stale' : healthPct >= 90 ? 'ok' : healthPct >= 70 ? 'warn' : 'bad',
      alerts: alertsReported ? (open.length > 0 ? `${open.length} open` : siteStale ? 'stale' : 'clear') : '—',
      alertTone: alertsReported ? (open.length > 0 ? 'warning' : siteStale ? 'neutral' : 'success') : 'neutral',
      // An adapter that genuinely stamps a per-site sync wins; otherwise the
      // claiming planes' registry freshness fills the column (no plane adapter
      // reports per-site sync today, so without this the column is dead).
      sync: siteRows.map((r) => r.sync).find((s) => s && s !== '—') ?? siteSyncFor(badges.keys()),
    });
  }
  return merged;
}

/**
 * The Sites screen's four headline Stats (README §6: Sites / Devices /
 * Clients / Sites with alerts), computed from the same merge that feeds the
 * table. Datasets no plane reported read '—' rather than a false zero, and
 * unverified devices are named in the delta (design rule 1).
 */
export function liveSiteStats(
  sites: SiteRow[],
  devices: ReconciledDeviceRow[],
  clients: ClientRow[],
  alerts: AlertRow[],
): StatDef[] {
  const clientsReported = datasetReported('clients');
  const alertsReported = datasetReported('alerts');
  const unverified = devices.filter((d) => d.state === 'unverified').length;
  const stale = sites.filter((s) => s.tone === 'stale').length;
  const withAlerts = new Set(alerts.filter((a) => a.state === 'open').map((a) => a.siteId)).size;
  return [
    {
      label: 'Sites',
      value: String(sites.length),
      delta: stale > 0 ? `${stale} without verified health` : 'from the merged inventory',
      tone: stale > 0 ? 'negative' : 'neutral',
    },
    {
      label: 'Devices',
      value: devices.length.toLocaleString('en-US'),
      delta: unverified > 0 ? `▼ ${unverified} unverified` : 'all claims verified',
      tone: unverified > 0 ? 'negative' : 'neutral',
    },
    {
      label: 'Clients',
      value: clientsReported ? clients.length.toLocaleString('en-US') : '—',
      delta: clientsReported ? 'active sessions reported' : 'no client roster reported',
      tone: 'neutral',
    },
    {
      label: 'Sites with alerts',
      value: alertsReported ? String(withAlerts) : '—',
      delta: alertsReported ? (withAlerts > 0 ? 'open now' : 'none open') : 'no alert feed reported',
      tone: alertsReported && withAlerts > 0 ? 'negative' : 'neutral',
    },
  ];
}

/** Sites + devices as the live merge presents them (shared by several routes). */
export function liveMerged(): {
  devices: ReconciledDeviceRow[];
  doubleClaimed: number;
  unclaimed: number;
  sites: SiteRow[];
  clients: ClientRow[];
  alerts: AlertRow[];
} {
  const cache = poller.getCache();
  const { devices, doubleClaimed, unclaimed } = liveDeviceData();
  const clients = liveClients();
  const alerts = liveAlerts();
  return {
    devices,
    doubleClaimed,
    unclaimed,
    sites: mergeLiveSites(cache.sites, devices, clients, alerts),
    clients,
    alerts: sortLiveAlerts(alerts),
  };
}

export type LiveSubscription = SubscriptionRow & SubscriptionMetricHints;

export type LiveAuthEvent = AuthEventRow & AuthEventTimeHint;
