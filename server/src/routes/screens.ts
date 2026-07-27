/**
 * server/src/routes/screens.ts — read-only per-screen view-model endpoints.
 *
 * Every response is an envelope: { dataSource: 'demo'|'live', syncedAt, ...payload }.
 *
 * Demo mode (settings.demoMode, default on): payloads are assembled from the
 * shared fixtures, matching the per-screen view-model shapes in shared/types.ts.
 *
 * Live mode: device payloads are reconciled across planes (services/reconcile.ts
 * — one row per physical device, claimedBy, double-claim/unclaimed flags);
 * sites merge per-plane rows by SiteId (union of managed-by badges, counts and
 * health derived from the reconciled inventory); alerts merge sorted by
 * severity then age; licences and auth events compute their stats, renewals,
 * fail reasons and policy services from the GreenLake/ClearPass rows' metric
 * hints. Datasets no plane reports stay honestly empty.
 */

import { Router } from 'express';
import {
  ALERTS,
  AUTH_EVENTS,
  AUTH_FAIL_REASONS,
  AUTH_STATS,
  BASELINE_PROGRESS,
  CAPABILITY_MATRIX,
  CLIENT_STATS,
  CLIENTS,
  COMPLIANCE_DIFF,
  COMPLIANCE_STATS,
  CONFIG_PORTS,
  CONFIGURE_STATS,
  DEVICE_CLIENT_SETS,
  DEVICE_CONFIGS,
  DEVICES,
  FINDINGS,
  LANE_META,
  LICENSE_STATS,
  OVERVIEW_ALERTS,
  OVERVIEW_CHANGES,
  OVERVIEW_LAUNCHPAD,
  OVERVIEW_PLANES,
  OVERVIEW_SITES,
  OVERVIEW_STATS,
  PERMISSIONS,
  PLANE_MARK,
  PLANE_WRITE_MODE,
  POLICY_SERVICES,
  QUEUED_CHANGES,
  RENEWALS,
  SEARCH_INDEX,
  SITE_PROFILES,
  SITE_STATS,
  SITES,
  SITE_IDS,
  SSIDS,
  SUBSCRIPTIONS,
  SYNC_HISTORY,
  SYSTEMS,
  TICKETS,
  VLANS,
  deriveSiteProfile,
  deviceProfile,
  isRealSiteId,
  scopeForPlane,
  siteDisplayName,
  siteIdFor,
  terminalBanner,
  terminalQuickCommands,
  toSiteAlertRow,
  toSiteDeviceRow,
  ORPHANS,
  type AlertRow,
  type AuthEventRow,
  type CapabilityRow,
  type ChangeLogEntry,
  type ClientRow,
  type BaselineProgressRow,
  type DeviceClientSet,
  type DeviceRow,
  type DeviceType,
  type FailReasonRow,
  type FindingRow,
  type LaneMeta,
  type LaunchpadRow,
  type LiveStat,
  type OverviewAlert,
  type OverviewPlaneRow,
  type OverviewSiteRow,
  type Plane,
  type PlaneKey,
  type PolicyServiceRow,
  type QueuedChangeRow,
  type RenewalRow,
  type SearchIndexEntry,
  type ScreenSection,
  type Sev,
  type SsidObject,
  type SiteAlertRow,
  type SiteDeviceRow,
  type SiteId,
  type SitePlaneBadge,
  type SiteProfile,
  type SiteRow,
  type StatDef,
  type SubscriptionRow,
  type SyncHistoryRow,
  type SystemEvent,
  type SystemRow,
  type SystemSiteRow,
  type Tone,
  type PortObject,
  type VlanObject,
} from '../../../shared';
import { settings } from '../config/settings';
import { poller } from '../services/poller';
import { ticketStore } from '../services/tickets';
import { writeBroker } from '../services/writeBroker';
import { registry } from '../planes/registry';
import { PLANE_LABEL, reconcileDevices, type ReconciledDeviceRow } from '../services/reconcile';
import {
  PLANE_IDS,
  type PlaneHealth,
  type PlaneId,
  type PlanePull,
  type PlaneState,
} from '../planes/types';
import {
  EXPIRING_SOON_DAYS,
  expiryDisplay,
  type SubscriptionMetricHints,
} from '../planes/greenlake';
import { normalizeMac, type AuthEventTimeHint } from '../planes/clearpass';

export const screensRouter = Router();

type DataSource = 'demo' | 'live';

function dataSource(): DataSource {
  return settings.get().demoMode ? 'demo' : 'live';
}

/** Effective source for one screen section: its override, else portal demoMode. */
function sourceFor(section: ScreenSection): DataSource {
  return settings.get().sectionMode?.[section] ?? dataSource();
}

/**
 * Blend mode (blendLive on): a demo-sourced section swaps to real poller rows
 * as soon as any plane reports them; sections without live rows stay on
 * fixtures. Real and fixture rows never mix inside one section, and the
 * envelope's `blended` list names the swapped sections so the UI can badge
 * them honestly.
 */
function blending(): boolean {
  return settings.get().blendLive === true;
}

/**
 * Blend for one section: the global flag, unless the operator pinned that
 * section to demo explicitly — a 'demo' pin must win over the swap, or the
 * UI's "pinned to demo" toast would lie.
 */
function blendFor(section: ScreenSection): boolean {
  return blending() && settings.get().sectionMode?.[section] !== 'demo';
}

/** Pick live rows over fixtures when blending and the section has live data. */
function blendSection<T>(section: string, liveRows: readonly T[], fixture: T[], bag: string[]): T[] {
  if (liveRows.length > 0) {
    bag.push(section);
    return [...liveRows];
  }
  return fixture;
}

/**
 * Attach the blended-section list to an envelope payload (omit when empty).
 *
 * A blended envelope keeps `dataSource: 'demo'` — the screen is still a demo
 * screen — but its freshness stamp must be the POLL time of the rows it is
 * actually serving. envelopeFor() stamps `now` for a demo source, which is
 * true of fixtures and a lie about a live row last fetched hours ago (design
 * rule 1). Callers that know their section pass it so the stamp can be fixed.
 */
function withBlended(
  payload: Record<string, unknown>,
  blended: string[],
  section?: ScreenSection,
): Record<string, unknown> {
  if (blended.length === 0) return payload;
  const stamped = { ...payload, blended };
  return section === undefined ? stamped : { ...stamped, syncedAt: syncedAtFor(section) };
}

function syncedAt(): string | null {
  return dataSource() === 'demo' ? new Date().toISOString() : poller.lastSyncAny();
}

function syncedAtFor(section: ScreenSection): string | null {
  switch (section) {
    case 'overview':
      return poller.lastSyncFor('devices', 'sites', 'alerts');
    case 'alerts':
      return poller.lastSyncFor('alerts');
    case 'clients':
      return poller.lastSyncFor('clients');
    case 'authEvents':
      return poller.lastSyncFor('authEvents');
    case 'sites':
      return poller.lastSyncFor('sites', 'devices');
    case 'devices':
      return poller.lastSyncFor('devices');
    case 'licenses':
      return poller.lastSyncFor('subscriptions');
    case 'systems':
      return poller.lastSyncAny();
    // Both are derived from live rows (observed inventory / evidence
    // coverage), so they carry the freshness of the datasets they read.
    case 'configure':
      return poller.lastSyncFor('clients');
    case 'compliance':
      return poller.lastSyncFor('devices');
  }
}

function envelope(extra: Record<string, unknown>): Record<string, unknown> {
  return { dataSource: dataSource(), syncedAt: syncedAt(), ...extra };
}

/** Envelope stamped with a section's EFFECTIVE source (its override, if any). */
function envelopeFor(section: ScreenSection, extra: Record<string, unknown>): Record<string, unknown> {
  const source = sourceFor(section);
  return {
    dataSource: source,
    syncedAt: source === 'demo' ? new Date().toISOString() : syncedAtFor(section),
    ...extra,
  };
}

function isSiteId(value: string): value is SiteId {
  return (SITE_IDS as readonly string[]).includes(value);
}

// -- Live-mode merge -----------------------------------------------------------
// Reconciled across planes per the design rules: one row per physical device
// (rule 2), stale planes surface as 'unverified' state (rule 1), sites keep
// every claiming plane's badge. Demo mode never touches any of this.

/**
 * Planes serving last-good data — "stale" for reconcile. Reading
 * `health === 'degraded'` alone only ever caught a poll that THREW; the
 * registry's shared age-based flag (shared/logic.ts planeStaleness) also
 * covers the plane that quietly stopped updating ('aged-out') and the pull
 * that came back half-read ('partial'), both of which serve rows that must
 * render 'unverified' rather than 'up' (design rule 1).
 *
 * 'never-synced' is deliberately NOT stale here: a plane that has never
 * answered contributes no rows to mark, so the flag would only ever downgrade
 * rows that reached the cache by some other path.
 */
function stalePlanes(): Set<PlaneId> {
  const out = new Set<PlaneId>();
  for (const id of PLANE_IDS) {
    const s = registry.state(id);
    if (s.health === 'degraded' || (s.stale && s.reason !== 'never-synced')) out.add(id);
  }
  return out;
}

/** Display label → registry plane id (inverse of PLANE_LABEL). 'THIRD-PARTY'
 *  owns no registry plane, so it resolves to undefined and never claims a
 *  freshness stamp it cannot have. */
const PLANE_ID_FOR: Partial<Record<Plane, PlaneId>> = Object.fromEntries(
  PLANE_IDS.map((id) => [PLANE_LABEL[id], id]),
) as Partial<Record<Plane, PlaneId>>;

/** True when the plane behind this display label is currently serving stale
 *  data (design rule 1). Labels with no registry plane are never asserted. */
function planeIsStale(plane: Plane, stale: ReadonlySet<PlaneId>): boolean {
  const id = PLANE_ID_FOR[plane];
  return id !== undefined && stale.has(id);
}

/** Reconcile every plane's last good device list into one row per device. */
function liveDeviceData(): { devices: ReconciledDeviceRow[]; doubleClaimed: number; unclaimed: number } {
  const byPlane: Partial<Record<PlaneId, readonly DeviceRow[]>> = {};
  for (const [id, pull] of poller.contributionsByPlane()) {
    if (pull.devices) byPlane[id] = pull.devices;
  }
  return reconcileDevices(byPlane, stalePlanes());
}

function datasetReported(key: keyof PlanePull): boolean {
  for (const [, pull] of poller.contributionsByPlane()) {
    if (pull[key] !== undefined) return true;
  }
  return false;
}

/** Parse the fixtures'/adapters' age strings ('45s', '12m', '6h', '2d') → minutes. */
function ageMinutes(age: string): number {
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

const SEV_RANK: Record<Sev, number> = { P1: 0, P2: 1, P3: 2 };

/** Merged alert queue: P1 first; within a severity, oldest unresolved first. */
function sortLiveAlerts(alerts: AlertRow[]): AlertRow[] {
  return [...alerts].sort((a, b) => SEV_RANK[a.sev] - SEV_RANK[b.sev] || ageMinutes(b.age) - ageMinutes(a.age));
}

/**
 * One row per endpoint across planes: a session reported by both a cloud
 * plane and ClearPass is the same client. Keyed on the normalised 12-hex
 * MAC; rows without a real MAC ('—') cannot be matched and all stay.
 */
function dedupeClients(clients: ClientRow[]): ClientRow[] {
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
function dedupeAlerts(alerts: AlertRow[]): AlertRow[] {
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
function liveAlerts(): AlertRow[] {
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
 * Live client sessions with the same honesty rule the device path applies:
 * a session last reported by a plane that is now degraded cannot be asserted
 * as a healthy current session. Fresh planes' rows are deduped first so a
 * fresh row always outranks a stale one for the same endpoint.
 */
function liveClients(): ClientRow[] {
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
function authEventsByMac(): Map<string, LiveAuthEvent> {
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
function enrichClientsWithAuth(clients: ClientRow[]): ClientRow[] {
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

function reportedValue(value: string | null | undefined): boolean {
  if (!value) return false;
  const normal = value.trim().toLowerCase();
  return normal !== '—' && normal !== 'unknown' && normal !== 'not reported';
}

function displayParts(parts: Array<string | null | undefined>): string {
  const values = parts.filter((part): part is string => reportedValue(part));
  return values.length > 0 ? values.join(' · ') : 'Not reported';
}

function liveDeviceClients(deviceName: string): DeviceClientSet | null {
  if (!datasetReported('clients')) return null;
  const key = deviceName.trim().toLowerCase();
  const clients = liveClients()
    .filter((client) => client.attach.trim().toLowerCase() === key)
    .map((client) => ({
      name: client.name,
      detail: displayParts([client.model, client.mac, String(client.ip), client.where]),
      state: client.health,
      tone: client.healthTone,
    }));
  return {
    meta: clients.length === 0 ? 'No active sessions reported' : `${clients.length} active session${clients.length === 1 ? '' : 's'}`,
    rows: clients,
  };
}

interface ObservedConfigureInventory {
  ssids: SsidObject[];
  ports: PortObject[];
  vlans: VlanObject[];
}

function observedConfigureInventory(clients: ClientRow[]): ObservedConfigureInventory {
  const ssidGroups = new Map<string, ClientRow[]>();
  const portGroups = new Map<string, ClientRow[]>();
  const vlanGroups = new Map<string, ClientRow[]>();

  for (const client of dedupeClients(clients)) {
    if (client.medium === 'wireless' && reportedValue(client.where)) {
      const key = client.where.trim().toLowerCase();
      ssidGroups.set(key, [...(ssidGroups.get(key) ?? []), client]);
    }
    if (client.medium === 'wired' && reportedValue(client.attach) && reportedValue(client.where)) {
      const key = `${client.attach.trim().toLowerCase()}|${client.where.trim().toLowerCase()}`;
      portGroups.set(key, [...(portGroups.get(key) ?? []), client]);
    }
    if (reportedValue(client.vlan)) {
      const key = client.vlan.trim().toLowerCase();
      vlanGroups.set(key, [...(vlanGroups.get(key) ?? []), client]);
    }
  }

  const ssids: SsidObject[] = [...ssidGroups.values()].map((rows) => {
    const first = rows[0]!;
    const planes = [...new Set(rows.map((row) => row.plane))].join(' + ');
    const sites = new Set(rows.map((row) => row.siteId)).size;
    return {
      kind: 'ssid',
      origin: 'observed',
      name: first.where,
      vlan: reportedValue(first.vlan) ? first.vlan : 'VLAN not reported',
      security: reportedValue(first.auth) ? `Auth observed: ${first.auth}` : 'Authentication not reported',
      targets: `${rows.length} active client${rows.length === 1 ? '' : 's'} · ${sites} site${sites === 1 ? '' : 's'}`,
      plane: planes,
      tone: 'neutral',
    };
  });

  // An observed port row is INFERRED from a client session, never read back
  // from the switch: the portal has not seen the interface's admin/oper state.
  // Painting the client's health score into the port-state badge (green dot,
  // '82'/'good') asserted a link state nothing verified — the same lie design
  // rule 1 forbids for devices. The health that IS known moves into the
  // summary, labelled as what it is.
  const ports: PortObject[] = [...portGroups.values()].map((rows) => {
    const first = rows[0]!;
    return {
      kind: 'port',
      origin: 'observed',
      device: first.attach,
      port: first.where.replace(/^port\s+/i, ''),
      desc: `${rows.length} active client${rows.length === 1 ? '' : 's'}`,
      summary: displayParts([
        first.vlan,
        first.auth,
        String(first.ip),
        reportedValue(first.health) ? `client health ${first.health}` : null,
      ]),
      state: 'unverified',
      tone: 'neutral',
    };
  });

  const vlans: VlanObject[] = [...vlanGroups.values()].map((rows) => {
    const first = rows[0]!;
    const roles = [...new Set(rows.map((row) => row.role).filter(reportedValue))];
    const planes = [...new Set(rows.map((row) => row.plane))];
    return {
      kind: 'vlan',
      origin: 'observed',
      id: first.vlan.replace(/^vlan\s+/i, ''),
      name: 'Observed active VLAN',
      detail: `${rows.length} active client${rows.length === 1 ? '' : 's'} · ${planes.join(' + ')}`,
      role: roles.length > 0 ? roles.join(', ') : 'Role not reported',
    };
  });

  return { ssids, ports, vlans };
}

/** Findings read in severity order, like the alert queue reads in P-order. */
const FINDING_SEV_RANK: Record<FindingRow['sev'], number> = { high: 0, med: 1, low: 2 };

interface LiveComplianceData {
  stats: StatDef[];
  findings: FindingRow[];
  baselines: BaselineProgressRow[];
  diff: string;
}

function liveComplianceData(devices: ReconciledDeviceRow[]): LiveComplianceData {
  if (devices.length === 0) return { stats: [], findings: [], baselines: [], diff: '' };

  const checks = [
    {
      label: 'Identity evidence',
      rule: 'scan.coverage.identity',
      missing: (device: ReconciledDeviceRow) => !reportedValue(device.model),
    },
    {
      // A device the reconcile step downgraded to 'unverified' is a DIFFERENT
      // fact from a plane that never supplied a state: the plane did answer,
      // the portal declined to trust it because that plane is behind (design
      // rule 1). Folding the two together told the operator a field was
      // missing and never that a plane was stale.
      label: 'Plane freshness',
      rule: 'scan.coverage.freshness',
      missing: (device: ReconciledDeviceRow) => device.state === 'unverified',
    },
    {
      label: 'Reachability evidence',
      rule: 'scan.coverage.reachability',
      missing: (device: ReconciledDeviceRow) =>
        device.state !== 'up' && device.state !== 'down' && device.state !== 'unverified',
    },
    {
      label: 'Firmware evidence',
      rule: 'scan.coverage.firmware',
      missing: (device: ReconciledDeviceRow) => !reportedValue(device.firmware),
    },
    {
      // Only a CROSS-PLANE claim is a defect. `reconciliationIssue` also
      // covers "claimed by the local collector alone", which README rule 2
      // calls a first-class device, not drift — flagging those made every
      // legitimately local-only switch a permanent, unfixable finding.
      label: 'Ownership reconciliation',
      rule: 'inventory.reconciliation',
      missing: (device: ReconciledDeviceRow) => (device.claimedBy?.length ?? 0) > 1,
    },
  ];

  const findings: FindingRow[] = [];
  const baselines: BaselineProgressRow[] = [];
  for (const check of checks) {
    const missing = devices.filter(check.missing);
    const pass = devices.length - missing.length;
    const value = Math.round((pass / devices.length) * 100);
    baselines.push({
      label: check.label,
      value,
      note: `${pass} of ${devices.length} devices have usable live evidence`,
    });
    const byPlane = new Map<Plane, ReconciledDeviceRow[]>();
    for (const device of missing) {
      const rows = byPlane.get(device.plane);
      if (rows) rows.push(device);
      else byPlane.set(device.plane, [device]);
    }
    for (const [plane, rows] of byPlane) {
      const reconciliation = check.rule === 'inventory.reconciliation';
      const freshness = check.rule === 'scan.coverage.freshness';
      findings.push({
        sev: reconciliation || freshness ? 'med' : 'low',
        tone: reconciliation ? 'warning' : freshness ? 'warning' : 'info',
        title: reconciliation
          ? 'Device ownership needs reconciliation'
          : freshness
            ? 'Device state unverified — plane is stale'
            : `${check.label} not reported`,
        detail: reconciliation
          ? 'Two planes claim this device identity'
          : freshness
            ? `${rows.length} device${rows.length === 1 ? '' : 's'} cannot be verified while ${plane} is behind`
            : 'The linked plane did not supply this field in its current inventory response',
        rule: check.rule,
        plane,
        count: String(rows.length),
        fix: reconciliation ? 'manual' : 'ssh scan',
        fixColor: reconciliation || freshness ? 'var(--nd-warning)' : 'var(--nd-text-muted)',
        device: rows[0]!.name,
        baseline: 'Live evidence coverage',
      });
    }
  }
  // The table leads with the Sev column, so it is the read order (the design
  // lists high → med → low). Emitting in check order buried every med-severity
  // row under the low-severity coverage ones.
  findings.sort((a, b) => FINDING_SEV_RANK[a.sev] - FINDING_SEV_RANK[b.sev] || a.rule.localeCompare(b.rule));

  const sites = new Set(devices.map((device) => device.siteId));
  const affectedSites = new Set(
    devices
      .filter((device) => checks.some((check) => check.missing(device)))
      .map((device) => device.siteId),
  );
  const cleanSites = sites.size - affectedSites.size;
  const totalChecks = devices.length * checks.length;
  const failedChecks = checks.reduce((sum, check) => sum + devices.filter(check.missing).length, 0);

  return {
    stats: [
      { label: 'Evidence checks', value: String(totalChecks), delta: 'current poller snapshot', tone: 'neutral' },
      { label: 'Devices in scope', value: String(devices.length), delta: 'from live inventory', tone: 'neutral' },
      { label: 'Coverage findings', value: String(failedChecks), delta: `${findings.length} grouped finding${findings.length === 1 ? '' : 's'}`, tone: failedChecks > 0 ? 'negative' : 'positive' },
      { label: 'Sites complete', value: `${cleanSites} / ${sites.size}`, delta: 'for available evidence fields', tone: cleanSites === sites.size ? 'positive' : 'neutral' },
      { label: 'Config drift', value: '—', delta: 'no running-config baseline source', tone: 'neutral' },
    ],
    findings,
    baselines,
    diff: [
      'Live evidence coverage',
      ...baselines.map((baseline) => `${baseline.value === 100 ? '+' : '-'} ${baseline.label}: ${baseline.note}`),
      '- Running configuration drift cannot be evaluated from inventory-only plane responses',
    ].join('\n'),
  };
}

const MIX_ABBR: Record<DeviceType, string> = {
  ap: 'ap',
  switch: 'sw',
  gateway: 'gw',
  controller: 'mc',
  sensor: 'uxi',
  policy: 'cppm',
};

/** '96 ap · 42 sw · 6 gw' — derived from the reconciled inventory, never authored. */
function mixString(devices: ReconciledDeviceRow[]): string {
  const counts = new Map<DeviceType, number>();
  for (const d of devices) counts.set(d.type, (counts.get(d.type) ?? 0) + 1);
  if (counts.size === 0) return '—';
  return [...counts.entries()].map(([t, n]) => `${n} ${MIX_ABBR[t]}`).join(' · ');
}

function skeletonSite(id: SiteId, name: string): SiteRow {
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

/**
 * "Last sync" for a merged site row: the OLDEST last-sync across the planes
 * that claim it, because staleness is the point of the column (README §"State
 * management": a plane 6h behind must say so). Planes that never synced, and
 * labels with no registry plane, contribute nothing rather than a false '—'.
 */
function siteSyncFor(badges: Iterable<Plane>): string {
  let oldest: string | null = null;
  let anyClaim = false;
  for (const label of badges) {
    const id = PLANE_ID_FOR[label];
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
 * Devices/clients at a site no plane reported a row for still get a row.
 */
function mergeLiveSites(
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
  for (const d of devices) if (!byId.has(d.siteId)) note(d.siteId, skeletonSite(d.siteId, d.siteName));
  for (const c of clients) if (!byId.has(c.siteId)) note(c.siteId, skeletonSite(c.siteId, c.siteName));

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
function liveSiteStats(
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
function liveMerged(): {
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

// -- Live overview ---------------------------------------------------------------
// Stats, planes and the change log are computed from the registry + reconciled
// cache; the launchpad is portal navigation structure, honest in both modes.

const HEALTH_TONE: Record<PlaneHealth, Tone> = {
  healthy: 'success',
  warning: 'warning',
  degraded: 'danger',
  unlinked: 'neutral',
};

/** Compact duration ('40s', '6h', '3d') — the fixtures' own vocabulary. */
function relDuration(ms: number): string {
  if (ms < 60_000) return `${Math.max(1, Math.floor(ms / 1000))}s`;
  const min = Math.floor(ms / 60_000);
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

/** Compact relative age for the plane rows ('40s', '6h', '—' when never). */
function relSync(iso: string | null): string {
  if (!iso) return '—';
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '—';
  return relDuration(ms);
}

/**
 * "Management planes" — the WHOLE roster, linked first. The tile beside this
 * panel counts "Planes linked N / 9"; omitting the unlinked ones made that
 * fraction unreconcilable and hid the reason a plane is dark. The kicker is a
 * coverage fact where the registry has one (what the plane actually claims),
 * falling back to its status note — the note alone just repeated the state
 * Badge next to it while deviceCount was thrown away.
 */
function liveOverviewPlanes(): OverviewPlaneRow[] {
  const rows: OverviewPlaneRow[] = [];
  const unlinked: OverviewPlaneRow[] = [];
  for (const id of PLANE_IDS) {
    const s = registry.state(id);
    const coverage =
      s.deviceCount === null
        ? null
        : `${s.deviceCount.toLocaleString('en-US')} device${s.deviceCount === 1 ? '' : 's'} · ${s.callsToday} call${s.callsToday === 1 ? '' : 's'} today`;
    const row: OverviewPlaneRow = {
      name: PLANE_LABEL[id],
      scope: s.linked ? (coverage ?? s.note ?? `${s.callsToday} calls today`) : (s.note ?? 'no credentials configured'),
      state: s.linked ? s.health : 'not linked',
      tone: HEALTH_TONE[s.linked ? s.health : 'unlinked'],
      sync: relSync(s.lastSync),
    };
    (s.linked ? rows : unlinked).push(row);
  }
  return [...rows, ...unlinked];
}

/**
 * Platform-lane headers from the registry: one entry per linked plane, with
 * its real freshness stamp and health tone. Unlinked planes are omitted so a
 * lane that appears only because a device claims it falls through to the
 * client's non-asserting fallback rather than claiming to be "linked".
 * `mark` comes from the shared PLANE_MARK so live and demo lanes agree.
 */
function liveLaneMeta(): Partial<Record<Plane, LaneMeta>> {
  const out: Partial<Record<Plane, LaneMeta>> = {};
  for (const id of PLANE_IDS) {
    const s = registry.state(id);
    if (!s.linked) continue;
    const label = PLANE_LABEL[id];
    out[label] = {
      tone: HEALTH_TONE[s.health],
      sync: s.lastSync ? `synced ${relSync(s.lastSync)}` : 'never synced',
      note: s.note ?? '',
      mark: PLANE_MARK[label],
    };
  }
  return out;
}

/**
 * Live Launchpad — portal navigation the live estate can actually honour: a
 * console hand-off per LINKED plane, an SSH row only when a live device
 * really exposes a local shell, and the two portal reports. The authored
 * rows (Mist org, Campus-01, sw-core-a) belong to the demo estate and would
 * 404 against a real one.
 */
function liveLaunchpad(devices: ReconciledDeviceRow[]): LaunchpadRow[] {
  const rows: LaunchpadRow[] = [];
  for (const id of PLANE_IDS) {
    const s = registry.state(id);
    if (!s.linked) continue;
    const name = settings.get().planes[id]?.displayName ?? PLANE_LABEL[id];
    rows.push({ label: `Open ${name}`, hint: 'console ↗', target: { type: 'view', view: 'systems' } });
  }
  const shell = devices.find((d) => d.localShell);
  if (shell) rows.push({ label: `SSH to ${shell.name}`, hint: 'terminal', target: { type: 'device', device: shell.name } });
  rows.push({ label: 'Run compliance scan', hint: 'all sites', target: { type: 'view', view: 'compliance' } });
  if (registry.state('greenlake').linked) {
    rows.push({ label: 'Reconcile licences with GreenLake', hint: 'report', target: { type: 'view', view: 'licenses' } });
  }
  return rows;
}

function liveOverviewStats(live: { devices: ReconciledDeviceRow[]; alerts: AlertRow[] }): StatDef[] {
  const up = live.devices.filter((d) => d.state === 'up').length;
  const unverified = live.devices.filter((d) => d.state === 'unverified').length;
  // Down devices name themselves first — "8 / 9 · all verified" must never
  // hide the one that is down.
  const down = live.devices.filter((d) => d.state !== 'up' && d.state !== 'unverified').length;
  const open = live.alerts.filter((a) => a.state === 'open');
  const p1 = open.filter((a) => a.sev === 'P1').length;
  const subs = poller.getCache().subscriptions as LiveSubscription[];
  const expiring = subs.filter(
    (s) => s.daysLeft !== undefined && s.daysLeft >= 0 && s.daysLeft <= LICENCE_HORIZON_DAYS,
  ).length;
  const states = registry.states();
  const linked = PLANE_IDS.filter((id) => states[id].linked).length;
  const unhealthy = PLANE_IDS.map((id) => states[id]).find((s) => s.linked && s.health !== 'healthy');
  // Config drift: the same live evidence-coverage engine Configure and
  // Compliance already run, so the three screens cannot disagree. '—' only
  // when no inventory has been reported at all.
  const drift = live.devices.length > 0 ? liveComplianceData(live.devices).findings.length : null;
  return [
    {
      label: 'Devices reachable',
      value: `${up} / ${live.devices.length}`,
      // Both halves of the gap between `up` and the total are named. The old
      // exclusive ternary dropped the unverified count the moment one device
      // was down — hiding the stale-plane signal exactly when the estate is
      // in trouble. Down still leads: it is the harder fact.
      delta:
        [down > 0 ? `▼ ${down} down` : null, unverified > 0 ? `${unverified} unverified` : null]
          .filter((part): part is string => part !== null)
          .join(' · ') || 'all verified',
      tone: down > 0 || unverified > 0 ? 'negative' : 'neutral',
    },
    {
      label: 'Open alerts',
      value: String(open.length),
      delta: p1 > 0 ? `▲ ${p1} critical` : 'none critical',
      tone: open.length > 0 ? 'negative' : 'neutral',
    },
    {
      label: 'Config drift',
      value: drift === null ? '—' : String(drift),
      delta: drift === null ? 'no live inventory evidence' : 'live evidence coverage findings',
      tone: drift !== null && drift > 0 ? 'negative' : 'neutral',
    },
    {
      label: `Licences ≤${LICENCE_HORIZON_DAYS}d`,
      value: String(expiring),
      delta: expiring > 0 ? '▲ renewals due' : 'none due',
      tone: 'neutral',
    },
    {
      label: 'Planes linked',
      value: `${linked} / ${PLANE_IDS.length}`,
      delta: linked === 0 ? 'none configured' : unhealthy ? `${PLANE_LABEL[unhealthy.id]} ${unhealthy.health}` : 'all healthy',
      tone: unhealthy ? 'negative' : 'neutral',
    },
  ];
}

/** Local hh:mm for an ISO instant — the screen's own clock, not UTC. */
function localHhmm(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * Change log = tail of the write broker's audit log; empty until the first
 * change. The audit entry carries only the change ID and its object kind, so
 * the row is joined back to the queued change for the WHAT and WHERE the
 * spec asks for ("vlan 812 added to sw-acc-3f-2"); an applied change that has
 * left the queue falls back to the raw event line. Times are the operator's
 * local clock — the header stamp on the same screen is local, and a UTC slice
 * next to it reads as a change that happened hours from now.
 */
function liveOverviewChanges(): ChangeLogEntry[] {
  const queued = new Map(writeBroker.list().map((change) => [change.id, change]));
  return writeBroker.recentEvents(4).map((e) => {
    const change = queued.get(e.changeId);
    return {
      time: localHhmm(e.ts),
      text: change ? `${change.what} — ${change.where}` : `${e.event} ${e.kind} — ${e.result}`,
      who: `${e.ticket} · write broker`,
    };
  });
}

/**
 * Live alert → the "Needs you now" view model. The row has no Site column
 * (README §1), so `meta` is the only place the site can appear — the fixtures
 * lead with it for exactly that reason. A detail that already names the site
 * is left alone rather than doubled up.
 */
function liveOverviewAlert(a: AlertRow): OverviewAlert {
  const site = reportedValue(a.siteName) ? a.siteName : null;
  const leads = site !== null && a.detail.trim().toLowerCase().startsWith(site.trim().toLowerCase());
  const meta = site === null || leads ? a.detail : [site, a.detail].filter((part) => part.trim()).join(' · ');
  return { sev: a.sev, tone: a.tone, title: a.title, meta, plane: a.plane, age: a.age, device: a.device };
}

/** Live site row → the Overview Sites-table view model (badges → a prose plane label). */
function liveOverviewSite(s: SiteRow): OverviewSiteRow {
  return {
    name: s.name,
    siteId: s.id,
    plane: s.planes.map((b) => b.name).join(' · ') || '—',
    devices: s.devices,
    clients: s.clients,
    health: s.health,
    healthPct: s.healthPct,
    tone: s.tone,
    alerts: s.alerts,
    alertTone: s.alertTone,
  };
}

// -- Live licences / auth events ---------------------------------------------
// GreenLake subscriptions and ClearPass auth events arrive with optional
// metric hints (expiry instant, numeric quantities, event timestamp) that the
// display rows themselves flatten away. The computed stats below use the
// hints when present and degrade honestly when they are not — the keys of
// every payload stay identical to the demo fixtures' shapes.

type LiveSubscription = SubscriptionRow & SubscriptionMetricHints;
type LiveAuthEvent = AuthEventRow & AuthEventTimeHint;

/**
 * The portal's ONE licence-expiry horizon, in days. Overview's "Licences
 * ≤60d" tile and the Licences screen's "Expiring ≤60d" tile answer the same
 * question and must never disagree (design/NtLicenses.dc.html:26 and the
 * OVERVIEW/LICENSE_STATS fixtures both say ≤60d). greenlake's
 * EXPIRING_SOON_DAYS (90) stays what it is — the per-subscription BADGE
 * threshold, a different judgement made by the adapter.
 */
const LICENCE_HORIZON_DAYS = 60;

/** How far ahead the "Renewals, soonest first" panel claims to look. */
const RENEWAL_WINDOW_DAYS = 180;

/** Renewal urgency colours, matching the fixtures' thresholds. */
function renewalColor(daysLeft: number): string {
  if (daysLeft < 30) return 'var(--nd-danger)';
  if (daysLeft < EXPIRING_SOON_DAYS) return 'var(--nd-warning)';
  return 'var(--nd-text-muted)';
}

/**
 * The Licences screen's five Stats (README §10 — the grid is five columns
 * wide, so a four-tile row leaves a hole). The fifth, "Devices unlicensed",
 * counts reconciled devices whose plane reports no entitlement; when no plane
 * reports a licence at all it reads '—' rather than claiming a clean estate.
 */
function liveUnlicensedStat(devices: ReconciledDeviceRow[]): StatDef {
  const known = devices.filter((d) => reportedValue(d.licence));
  if (devices.length === 0 || known.length === 0) {
    return { label: 'Devices unlicensed', value: '—', delta: 'no plane reports entitlements', tone: 'neutral' };
  }
  const unlicensed = devices.length - known.length;
  return {
    label: 'Devices unlicensed',
    value: String(unlicensed),
    delta: `${known.length} of ${devices.length} devices carry an entitlement`,
    tone: unlicensed > 0 ? 'negative' : 'positive',
  };
}

function liveLicenseStats(subs: LiveSubscription[], devices: ReconciledDeviceRow[]): StatDef[] {
  const totalQty = subs.reduce((n, s) => n + (s.qtyValue ?? 0), 0);
  const totalAssigned = subs.reduce((n, s) => n + (s.assignedValue ?? 0), 0);
  const unassigned = Math.max(0, totalQty - totalAssigned);
  const expiring = subs.filter((s) => s.daysLeft !== undefined && s.daysLeft >= 0 && s.daysLeft <= LICENCE_HORIZON_DAYS);
  const idle = subs.filter((s) => s.assignedValue === 0);
  const soonest = expiring.reduce<LiveSubscription | null>(
    (a, s) => (a === null || (s.daysLeft ?? 0) < (a.daysLeft ?? 0) ? s : a),
    null,
  );
  const pct = totalQty > 0 ? Math.round((totalAssigned / totalQty) * 100) : null;
  return [
    { label: 'Subscriptions', value: String(subs.length), delta: `${totalQty.toLocaleString('en-US')} seats`, tone: 'neutral' },
    {
      label: 'Assigned',
      value: totalAssigned.toLocaleString('en-US'),
      delta: pct === null ? 'utilisation unknown' : `${pct}% utilised`,
      tone: pct !== null && pct >= 80 ? 'positive' : 'neutral',
    },
    {
      label: 'Unassigned',
      value: unassigned.toLocaleString('en-US'),
      delta: idle.length > 0 ? `${idle.length} subscription${idle.length === 1 ? '' : 's'} with none assigned` : 'all subscriptions in use',
      tone: unassigned > 0 ? 'negative' : 'neutral',
    },
    {
      label: `Expiring ≤${LICENCE_HORIZON_DAYS}d`,
      value: String(expiring.length),
      delta: soonest?.expiresAtMs !== undefined ? `next ${expiryDisplay(soonest.expiresAtMs)}` : 'none on the horizon',
      tone: expiring.length > 0 ? 'negative' : 'positive',
    },
    liveUnlicensedStat(devices),
  ];
}

/**
 * Renewals, soonest first — only rows that carry an expiry hint can be ranked.
 * The panel's header states a window ("NEXT 180 DAYS", design/NtLicenses),
 * so the window is enforced here rather than left as a caption over an
 * unbounded dump of every dated key in the workspace. Already-overdue rows
 * (negative daysLeft) stay: they are the most urgent thing on the screen.
 */
function liveRenewals(subs: LiveSubscription[]): RenewalRow[] {
  return subs
    .filter((s): s is LiveSubscription & { expiresAtMs: number; daysLeft: number } =>
      s.expiresAtMs !== undefined && s.daysLeft !== undefined && s.daysLeft <= RENEWAL_WINDOW_DAYS,
    )
    .sort((a, b) => a.expiresAtMs - b.expiresAtMs)
    .map((s) => ({
      date: expiryDisplay(s.expiresAtMs),
      what: `${s.name} ×${s.qty}`,
      days: s.daysLeft < 0 ? 'overdue' : `${s.daysLeft}d`,
      color: renewalColor(s.daysLeft),
    }));
}

/** Window covered by the event feed (0 when timestamps are absent/identical). */
function eventWindowMs(events: LiveAuthEvent[]): number {
  const stamps = events.map((e) => e.tsMs).filter((t): t is number => t !== undefined);
  return stamps.length > 1 ? Math.max(...stamps) - Math.min(...stamps) : 0;
}

/**
 * The five auth Stats. Two honesty rules run through them:
 *  - No feed at all is not a quiet network. An empty event list means no
 *    policy plane answered for this window, so every tile reads '—' rather
 *    than a green zero-reject scorecard.
 *  - A rate needs a measured window. When no row carries a parseable
 *    timestamp the span is unknown, and dividing by a floor of one minute
 *    invents a per-minute rate the portal never observed.
 */
function liveAuthStats(events: LiveAuthEvent[]): StatDef[] {
  const total = events.length;
  if (total === 0) {
    return [
      { label: 'Auths / min', value: '—', delta: 'no auth feed in this window', tone: 'neutral' },
      { label: 'Accept rate', value: '—', delta: 'no auth feed in this window', tone: 'neutral' },
      { label: 'Rejects / hour', value: '—', delta: 'no auth feed in this window', tone: 'neutral' },
      { label: 'MAB fallbacks', value: '—', delta: 'no auth feed in this window', tone: 'neutral' },
      { label: 'Known endpoints', value: '—', delta: 'no auth feed in this window', tone: 'neutral' },
    ];
  }
  const accepts = events.filter((e) => e.result === 'accept').length;
  const rejects = events.filter((e) => e.result === 'reject').length;
  const mab = events.filter((e) => e.method === 'MAB').length;
  const endpoints = new Set(events.map((e) => e.mac).filter((m) => m !== '—')).size;
  const spanMs = eventWindowMs(events);
  const spanKnown = spanMs > 0;
  const spanMin = Math.max(spanMs / 60_000, 1);
  const acceptRate = total > 0 ? (accepts / total) * 100 : null;
  return [
    {
      label: 'Auths / min',
      value: spanKnown ? String(Math.round(total / spanMin)) : '—',
      delta: spanKnown ? `${total} events in a ${Math.round(spanMin)} min window` : `${total} events · feed carries no timestamps`,
      tone: 'neutral',
    },
    {
      label: 'Accept rate',
      value: acceptRate === null ? '—' : `${acceptRate.toFixed(1)}%`,
      delta: `${accepts} of ${total} accepted`,
      tone: acceptRate === null ? 'neutral' : acceptRate >= 95 ? 'positive' : acceptRate >= 85 ? 'neutral' : 'negative',
    },
    {
      label: 'Rejects / hour',
      value: spanKnown ? String(Math.round(rejects / Math.max(spanMs / 3_600_000, 1 / 60))) : '—',
      delta: spanKnown ? `${rejects} rejects in window` : `${rejects} rejects · feed carries no timestamps`,
      tone: rejects > 0 ? 'negative' : spanKnown ? 'positive' : 'neutral',
    },
    {
      label: 'MAB fallbacks',
      value: String(mab),
      delta: total > 0 ? `${Math.round((mab / total) * 100)}% of auths` : 'no events',
      tone: 'neutral',
    },
    { label: 'Known endpoints', value: endpoints.toLocaleString('en-US'), delta: 'distinct MACs in window', tone: 'neutral' },
  ];
}

/** "Why authentications failed" — top reject reasons, top 5 like the fixtures. */
function liveFailReasons(events: LiveAuthEvent[]): FailReasonRow[] {
  const byReason = new Map<string, { count: number; macs: Set<string> }>();
  for (const e of events) {
    if (e.result !== 'reject') continue;
    const label = e.reason && e.reason !== '—' ? e.reason : 'No reason given';
    const entry = byReason.get(label) ?? { count: 0, macs: new Set<string>() };
    entry.count += 1;
    if (e.mac !== '—') entry.macs.add(e.mac);
    byReason.set(label, entry);
  }
  return [...byReason.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 5)
    .map(([label, { count, macs }]) => ({
      label,
      value: count,
      note: `${count} event${count === 1 ? '' : 's'} · ${macs.size} endpoint${macs.size === 1 ? '' : 's'}`,
    }));
}

/**
 * "Policy services" — per-service auth counts from the feed. State cannot be
 * asserted from logs alone, so a service is 'ok' unless rejects dominate the
 * window, in which case it is honestly 'noisy'.
 */
function livePolicyServices(events: LiveAuthEvent[]): PolicyServiceRow[] {
  const spanHr = Math.max(eventWindowMs(events) / 3_600_000, 1 / 60);
  const byService = new Map<string, { count: number; rejects: number; methods: Set<string> }>();
  for (const e of events) {
    const name = e.service && e.service !== '—' ? e.service : 'Unknown service';
    const entry = byService.get(name) ?? { count: 0, rejects: 0, methods: new Set<string>() };
    entry.count += 1;
    if (e.result === 'reject') entry.rejects += 1;
    if (e.method !== '—') entry.methods.add(e.method);
    byService.set(name, entry);
  }

  return [...byService.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .map(([name, { count, rejects, methods }]) => {
      const noisy = count > 0 && rejects / count > 0.25;
      return {
        name,
        detail: [...methods].join(' · ') || '—',
        rate: Math.round(count / spanHr).toLocaleString('en-US'),
        state: noisy ? 'noisy' : 'ok',
        tone: noisy ? ('warning' as const) : ('success' as const),
      };
    });
}

const QUEUE_TONE: Record<QueuedChangeRow['state'], Tone> = {
  ready: 'success',
  applying: 'info',
  'needs window': 'warning',
  console: 'neutral',
};

function liveConfigureQueue(): QueuedChangeRow[] {
  return writeBroker.list().map((change) => ({
    state: change.state,
    tone: QUEUE_TONE[change.state],
    what: change.what,
    where: change.where,
    ticket: change.ticket,
  }));
}

/**
 * The demo change queue: real brokered changes lead (they are user data, and
 * the operator queued them in this portal), then the design's authored rows —
 * a fixture row whose ticket a real change already carries drops out, exactly
 * like the tickets queue promotes a noted fixture. Without this the demo
 * screen renders the queue section as a bare '0' header while the fixtures
 * the design specifies sit unused.
 */
function demoConfigureQueue(): QueuedChangeRow[] {
  const brokered = liveConfigureQueue();
  const tickets = new Set(brokered.map((change) => change.ticket));
  return [...brokered, ...QUEUED_CHANGES.filter((change) => !tickets.has(change.ticket))];
}

/**
 * Demo stats: the authored strip, with the two tiles that describe the
 * PORTAL's own state (the queue, and what the broker really pushed today)
 * computed. Config objects and Drift open keep the fixture's values and
 * deltas — they describe the authored inventory demo mode is serving, and
 * re-deriving them printed 'live evidence coverage findings' over fixtures.
 */
function demoConfigureStats(queue: QueuedChangeRow[]): StatDef[] {
  const computed = liveConfigureStats(queue, null, '', null);
  const pushedToday = Number(computed[1]!.value);
  return [computed[0]!, pushedToday > 0 ? computed[1]! : CONFIGURE_STATS[1]!, CONFIGURE_STATS[2]!, CONFIGURE_STATS[3]!];
}

function liveConfigureStats(
  queue: QueuedChangeRow[],
  configObjects: number | null,
  configDetail: string,
  driftOpen: number | null,
): StatDef[] {
  const ready = queue.filter((change) => change.state === 'ready').length;
  const applying = queue.filter((change) => change.state === 'applying').length;
  const needsWindow = queue.filter((change) => change.state === 'needs window').length;
  const consoleOnly = queue.filter((change) => change.state === 'console').length;
  const today = new Date().toISOString().slice(0, 10);
  const pushedToday = writeBroker
    .recentEvents(1000)
    .filter((event) => event.ts.startsWith(today) && event.event === 'push' && event.result.startsWith('applied')).length;
  const queueDetail = [
    `${ready} ready`,
    applying > 0 ? `${applying} applying` : null,
    needsWindow > 0 ? `${needsWindow} need a window` : null,
    consoleOnly > 0 ? `${consoleOnly} console-only` : null,
  ]
    .filter((part): part is string => part !== null)
    .join(' · ');
  return [
    { label: 'Queued changes', value: String(queue.length), delta: queueDetail, tone: 'neutral' },
    { label: 'Pushed today', value: String(pushedToday), delta: 'from the broker audit log', tone: pushedToday > 0 ? 'positive' : 'neutral' },
    {
      label: 'Config objects',
      value: configObjects === null ? '—' : String(configObjects),
      delta: configDetail,
      tone: 'neutral',
    },
    {
      label: 'Drift open',
      value: driftOpen === null ? '—' : String(driftOpen),
      delta: driftOpen === null ? 'no live inventory evidence' : 'live evidence coverage findings',
      tone: driftOpen !== null && driftOpen > 0 ? 'negative' : 'neutral',
    },
  ];
}

// -- Overview ----------------------------------------------------------------

screensRouter.get('/overview', (_req, res) => {
  if (sourceFor('overview') === 'demo') {
    if (blendFor('overview')) {
      const live = liveMerged();
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
      const stats = statsLive ? liveOverviewStats(live) : OVERVIEW_STATS;
      if (statsLive) blended.push('stats');
      res.json(
        withBlended(
          envelopeFor('overview', {
            workspace: settings.get().workspaceName,
            stats,
            alerts: blendSection('alerts', live.alerts.map(liveOverviewAlert), OVERVIEW_ALERTS, blended),
            sites: blendSection('sites', live.sites.map(liveOverviewSite), OVERVIEW_SITES, blended),
            planes: blendSection('planes', livePlanes, OVERVIEW_PLANES, blended),
            changes: blendSection('changes', liveOverviewChanges(), OVERVIEW_CHANGES, blended),
            // Once a plane is linked the authored rows would offer consoles
            // and an SSH target this estate does not have — and the device
            // row would 404 against the swapped device section.
            launchpad: blendSection('launchpad', livePlanes.length > 0 ? liveLaunchpad(live.devices) : [], OVERVIEW_LAUNCHPAD, blended),
          }),
          blended,
          'overview',
        ),
      );
      return;
    }
    res.json(
      envelopeFor('overview', {
        workspace: settings.get().workspaceName,
        stats: OVERVIEW_STATS,
        alerts: OVERVIEW_ALERTS,
        sites: OVERVIEW_SITES,
        planes: OVERVIEW_PLANES,
        changes: OVERVIEW_CHANGES,
        launchpad: OVERVIEW_LAUNCHPAD,
      }),
    );
    return;
  }
  const live = liveMerged();
  res.json(
    envelopeFor('overview', {
      workspace: settings.get().workspaceName,
      stats: liveOverviewStats(live),
      alerts: live.alerts.map(liveOverviewAlert),
      sites: live.sites.map(liveOverviewSite),
      planes: liveOverviewPlanes(),
      changes: liveOverviewChanges(),
      launchpad: liveLaunchpad(live.devices),
    }),
  );
});

// -- Alerts / tickets ---------------------------------------------------------

screensRouter.get('/alerts', (_req, res) => {
  if (sourceFor('alerts') === 'demo') {
    if (blendFor('alerts')) {
      const blended: string[] = [];
      const alerts = blendSection('alerts', sortLiveAlerts(liveAlerts()), ALERTS, blended);
      res.json(withBlended(envelopeFor('alerts', { alerts }), blended, 'alerts'));
      return;
    }
    res.json(envelopeFor('alerts', { alerts: ALERTS }));
    return;
  }
  res.json(envelopeFor('alerts', { alerts: sortLiveAlerts(liveAlerts()) }));
});

screensRouter.get('/tickets', (_req, res) => {
  // Raised tickets are real user data — they lead the queue in both modes.
  // A fixture ticket noted by an operator is promoted into the store, so the
  // fixture copy with that id drops out of the merged queue (no duplicates).
  const raised = ticketStore.list();
  const base = dataSource() === 'demo' ? TICKETS.filter((t) => !raised.some((r) => r.id === t.id)) : [];
  res.json(envelope({ tickets: [...raised, ...base] }));
});

/**
 * Raise a ticket from an alert row {alert: AlertRow} — idempotent per
 * title+device.
 *
 * `detail` and `device` are OPTIONAL: real plane payloads legitimately leave
 * them blank (a WAN/tenant/subscription alert names no device, and several
 * feeds carry no summary line), and those are exactly the P1s an operator
 * most wants ticketed. They default to '' / '—' rather than 400-ing.
 */
screensRouter.post('/tickets/raise', (req, res) => {
  const alert = (req.body ?? {}) as Record<string, unknown>;
  const required = ['title', 'sev', 'siteName', 'plane', 'age', 'state'] as const;
  if (
    required.some((field) => typeof alert[field] !== 'string' || !(alert[field] as string).trim()) ||
    (alert.sev !== 'P1' && alert.sev !== 'P2' && alert.sev !== 'P3')
  ) {
    res.status(400).json({
      error: 'non-empty alert fields required: title, sev (P1|P2|P3), siteName, plane, age, state',
    });
    return;
  }
  const detail = typeof alert.detail === 'string' && alert.detail.trim() ? alert.detail : '';
  const device = typeof alert.device === 'string' && alert.device.trim() ? alert.device : '—';
  res.json({ ticket: ticketStore.raiseFromAlert({ ...alert, detail, device } as unknown as AlertRow) });
});

/**
 * POST /api/tickets/:id/notes {text, kind?} — persist an operator note or a
 * requested next action to the ticket's log. 400 on empty text or a bad
 * kind, 404 on a ticket id the merged queue does not know.
 */
screensRouter.post('/tickets/:id/notes', (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (!text) {
    res.status(400).json({ error: 'text required — an empty note is not logged' });
    return;
  }
  if (body.kind !== undefined && body.kind !== 'note' && body.kind !== 'action') {
    res.status(400).json({ error: "kind must be 'note' or 'action'" });
    return;
  }
  if (dataSource() === 'live' && !ticketStore.list().some((ticket) => ticket.id === req.params.id)) {
    res.status(404).json({ error: `unknown ticket '${req.params.id}'` });
    return;
  }
  const ticket = ticketStore.addNote(req.params.id, text, body.kind === 'action' ? 'action' : 'note');
  if (!ticket) {
    res.status(404).json({ error: `unknown ticket '${req.params.id}'` });
    return;
  }
  res.json({ ticket });
});

/**
 * POST /api/tickets/:id/resolve — close a ticket: state 'resolved' plus an
 * action note in its operator log. Idempotent (an already-resolved ticket
 * comes back unchanged); 404 on an id the merged queue does not know.
 */
screensRouter.post('/tickets/:id/resolve', (req, res) => {
  if (dataSource() === 'live' && !ticketStore.list().some((ticket) => ticket.id === req.params.id)) {
    res.status(404).json({ error: `unknown ticket '${req.params.id}'` });
    return;
  }
  const ticket = ticketStore.resolve(req.params.id);
  if (!ticket) {
    res.status(404).json({ error: `unknown ticket '${req.params.id}'` });
    return;
  }
  res.json({ ticket });
});

// -- Clients / auth events ----------------------------------------------------

screensRouter.get('/clients', (_req, res) => {
  if (sourceFor('clients') === 'demo') {
    if (blendFor('clients')) {
      const blended: string[] = [];
      const blendClients = liveClients();
      if (blendClients.length > 0) {
        blended.push('clients');
        res.json(
          withBlended(envelopeFor('clients', { stats: liveClientStats(blendClients), clients: blendClients }), blended, 'clients'),
        );
        return;
      }
    }
    res.json(envelopeFor('clients', { stats: CLIENT_STATS, clients: CLIENTS }));
    return;
  }
  const clients = liveClients();
  res.json(envelopeFor('clients', { stats: liveClientStats(clients), clients }));
});

/** Live client stats — same five StatDefs as the fixtures, computed per poll. */
function liveClientStats(clients: ClientRow[]): StatDef[] {
  const wireless = clients.filter((c) => c.medium === 'wireless').length;
  const wired = clients.length - wireless;
  // A session whose plane is behind reads 'unverified' (see liveClients) — it
  // must not be counted as failing or poor, because nothing current says so.
  const asserted = clients.filter((c) => c.health !== 'unverified');
  // "Failing auth" cannot be read off a cloud plane's health string — Central
  // never puts 'auth' in it. The policy plane's own decision for that endpoint
  // is the fact, so a client whose newest ClearPass event is a reject counts,
  // and the health-string heuristic stays for planes that do say so.
  const rejected = authEventsByMac();
  const failing = asserted.filter(
    (c) =>
      /auth/i.test(c.health) ||
      (c.mac !== '—' && rejected.get(normalizeMac(c.mac))?.result === 'reject'),
  ).length;
  const poor = asserted.filter(
    (c) => /poor|fair/i.test(c.health) || (c.quality !== null && c.quality < 50),
  ).length;
  const pct = clients.length > 0 ? Math.round((wireless / clients.length) * 100) : 0;
  return [
    { label: 'Clients now', value: clients.length.toLocaleString('en-US'), delta: 'from live poll', tone: 'neutral' },
    { label: 'Wireless', value: wireless.toLocaleString('en-US'), delta: `${pct}% of sessions`, tone: 'neutral' },
    { label: 'Wired', value: wired.toLocaleString('en-US'), delta: 'from live poll', tone: 'neutral' },
    { label: 'Failing auth', value: String(failing), delta: failing > 0 ? 'needs attention' : 'none failing', tone: failing > 0 ? 'negative' : 'neutral' },
    { label: 'Poor experience', value: String(poor), delta: poor > 0 ? 'below quality target' : 'none below target', tone: poor > 0 ? 'negative' : 'neutral' },
  ];
}

screensRouter.get('/auth-events', (_req, res) => {
  if (sourceFor('authEvents') === 'demo') {
    if (blendFor('authEvents')) {
      const events = poller.getCache().authEvents as LiveAuthEvent[];
      if (events.length > 0) {
        res.json(
          withBlended(
            envelopeFor('authEvents', {
              stats: liveAuthStats(events),
              events,
              failReasons: liveFailReasons(events),
              policyServices: livePolicyServices(events),
            }),
            ['authEvents'],
            'authEvents',
          ),
        );
        return;
      }
    }
    res.json(
      envelopeFor('authEvents', {
        stats: AUTH_STATS,
        events: AUTH_EVENTS,
        failReasons: AUTH_FAIL_REASONS,
        policyServices: POLICY_SERVICES,
      }),
    );
    return;
  }
  const events = poller.getCache().authEvents as LiveAuthEvent[];
  res.json(
    envelopeFor('authEvents', {
      stats: liveAuthStats(events),
      events,
      failReasons: liveFailReasons(events),
      policyServices: livePolicyServices(events),
    }),
  );
});

// -- Sites --------------------------------------------------------------------

screensRouter.get('/sites', (_req, res) => {
  if (sourceFor('sites') === 'demo') {
    if (blendFor('sites')) {
      const blended: string[] = [];
      const live = liveMerged();
      if (live.sites.length > 0) {
        blended.push('sites');
        res.json(
          withBlended(
            envelopeFor('sites', {
              stats: liveSiteStats(live.sites, live.devices, live.clients, live.alerts),
              sites: live.sites,
            }),
            blended,
            'sites',
          ),
        );
        return;
      }
    }
    res.json(envelopeFor('sites', { stats: SITE_STATS, sites: SITES }));
    return;
  }
  const live = liveMerged();
  res.json(
    envelopeFor('sites', {
      stats: liveSiteStats(live.sites, live.devices, live.clients, live.alerts),
      sites: live.sites,
    }),
  );
});

/**
 * The two per-site sections README §7 puts either side of the flair divider —
 * "Devices at this site" and "Open here". Both are pure projections of the
 * merge the route already computed, so a live site page carries them exactly
 * like a demo one (the authored profiles embed the same two lists).
 */
function liveSiteSections(
  live: { devices: ReconciledDeviceRow[]; alerts: AlertRow[] },
  site: SiteRow,
): { devices: SiteDeviceRow[]; alerts: SiteAlertRow[] } {
  return {
    devices: live.devices.filter((d) => d.siteId === site.id).map(toSiteDeviceRow),
    alerts: live.alerts.filter((a) => a.siteId === site.id && a.state === 'open').map(toSiteAlertRow),
  };
}

/**
 * A demo device the operator pruned on /devices must not reappear as an
 * inventory row on its site page — the site table is the site's slice of the
 * same inventory, not an independent authored list. The headline device count
 * moves with it (it is the same estate), while the rest of the authored
 * profile is untouched.
 */
function withoutHiddenDemoDevices(profile: SiteProfile | null): SiteProfile | null {
  if (profile === null) return null;
  const hidden = new Set(settings.get().hiddenDemoDevices ?? []);
  if (hidden.size === 0) return profile;
  const devices = profile.devices.filter((d) => !hidden.has(d.name));
  const removed = profile.devices.length - devices.length;
  if (removed === 0) return profile;
  const total = Number(profile.deviceCount.replace(/,/g, ''));
  return {
    ...profile,
    devices,
    deviceCount: Number.isFinite(total)
      ? Math.max(0, total - removed).toLocaleString('en-US')
      : profile.deviceCount,
  };
}

screensRouter.get('/sites/:siteId', (req, res) => {
  const param = req.params.siteId;
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
          withBlended(envelopeFor('sites', { site, profile: null, ...liveSiteSections(live, site) }), ['sites'], 'sites'),
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
  res.json(envelopeFor('sites', { site, profile: null, ...liveSiteSections(live, site) }));
});

// -- Devices ------------------------------------------------------------------

screensRouter.get('/devices', (_req, res) => {
  if (sourceFor('devices') === 'demo') {
    if (blendFor('devices')) {
      const { devices, doubleClaimed, unclaimed } = liveDeviceData();
      if (devices.length > 0) {
        res.json(
          withBlended(
            envelopeFor('devices', { devices, lanes: liveLaneMeta(), reconciliation: { doubleClaimed, unclaimed } }),
            ['devices'],
            'devices',
          ),
        );
        return;
      }
    }
    // Operator-pruned fixtures stay hidden from the demo inventory; the list
    // rides along so the UI can offer restore.
    const hidden = settings.get().hiddenDemoDevices ?? [];
    const hiddenSet = new Set(hidden);
    res.json(
      envelopeFor('devices', {
        devices: DEVICES.filter((d) => !hiddenSet.has(d.name)),
        lanes: LANE_META,
        hiddenDevices: hidden,
      }),
    );
    return;
  }
  const { devices, doubleClaimed, unclaimed } = liveDeviceData();
  res.json(envelopeFor('devices', { devices, lanes: liveLaneMeta(), reconciliation: { doubleClaimed, unclaimed } }));
});

screensRouter.get('/devices/:name', (req, res) => {
  const name = req.params.name;

  if (sourceFor('devices') === 'demo') {
    // Blend: the devices section has swapped to live rows — a fixture detail
    // (config, clients) for a name the live inventory doesn't know would be
    // fabrication, so the detail follows the section: live row or honest 404.
    if (blendFor('devices')) {
      const liveDevices = liveDeviceData().devices;
      if (liveDevices.length > 0) {
        const device = liveDevices.find((d) => d.name === name) ?? null;
        if (!device) {
          res.status(404).json({ error: `device '${name}' not in the live inventory`, dataSource: 'demo', blended: ['devices'] });
          return;
        }
        res.json(
          withBlended(
            envelopeFor('devices', { device, profile: null, config: null, clients: liveDeviceClients(name) }),
            ['devices'],
            'devices',
          ),
        );
        return;
      }
    }
    const fixtureDevice = DEVICES.find((d) => d.name === name) ?? null;
    if (!fixtureDevice) {
      res.status(404).json({ error: `unknown device '${name}'`, dataSource: 'demo' });
      return;
    }
    const profile = deviceProfile(name);
    res.json(
      envelopeFor('devices', {
        device: fixtureDevice,
        profile,
        terminal: {
          banner: terminalBanner(profile.kind),
          quickCommands: terminalQuickCommands(profile.kind),
        },
        config: DEVICE_CONFIGS[profile.kind],
        clients: DEVICE_CLIENT_SETS[profile.kind],
      }),
    );
    return;
  }

  const device = liveDeviceData().devices.find((d) => d.name === name) ?? null;
  if (!device) {
    res.status(404).json({ error: `device '${name}' not in the live cache`, dataSource: 'live' });
    return;
  }
  res.json(envelopeFor('devices', { device, profile: null, config: null, clients: liveDeviceClients(name) }));
});

// -- Licences / configure / compliance ---------------------------------------

screensRouter.get('/licenses', (_req, res) => {
  if (sourceFor('licenses') === 'demo') {
    if (blendFor('licenses')) {
      const subs = poller.getCache().subscriptions as LiveSubscription[];
      if (subs.length > 0) {
        res.json(
          withBlended(
            envelopeFor('licenses', {
              stats: liveLicenseStats(subs, liveDeviceData().devices),
              subscriptions: subs,
              renewals: liveRenewals(subs),
              orphans: [],
            }),
            ['licenses'],
            'licenses',
          ),
        );
        return;
      }
    }
    res.json(
      envelopeFor('licenses', { stats: LICENSE_STATS, subscriptions: SUBSCRIPTIONS, renewals: RENEWALS, orphans: ORPHANS }),
    );
    return;
  }
  // GreenLake subscriptions from the poller cache, with stats + renewals
  // computed from the rows' metric hints. Orphans stay honestly empty: the
  // subscriptions feed carries no device identities to reconcile against.
  const subs = poller.getCache().subscriptions as LiveSubscription[];
  res.json(
    envelopeFor('licenses', {
      stats: liveLicenseStats(subs, liveDeviceData().devices),
      subscriptions: subs,
      renewals: liveRenewals(subs),
      orphans: [],
    }),
  );
});

/**
 * "Where a change can go" for the real deployment: one row per registry
 * plane, its mode taken from the SAME scopeForPlane() the Systems scope badge
 * reads, so the two screens can never disagree. An unlinked plane cannot
 * accept a change, and says so, instead of advertising the fixture estate's
 * brokered collector and AOS-8 master.
 */
function liveCapabilityMatrix(): CapabilityRow[] {
  const states = registry.states();
  const stored = settings.get().planes;
  return PLANE_IDS.filter((id) => SYSTEM_DISPLAY[id]).map((id) => {
    const linked = states[id].linked;
    const scope = scopeForPlane(id as PlaneKey, { linked, scopes: stored[id]?.scopes ?? null });
    const mode: CapabilityRow['mode'] =
      scope === 'read + broker' ? 'brokered' : scope === 'read + ssh' ? 'ssh' : 'read only';
    const note = !linked
      ? 'not linked — no credentials stored'
      : states[id].health === 'degraded'
        ? 'linked, but the plane is not answering'
        : mode === 'brokered'
          ? 'brokered write, ticket required'
          : mode === 'ssh'
            ? 'recorded shell, window only'
            : 'payload pre-filled in the plane console';
    return {
      plane: stored[id]?.displayName ?? SYSTEM_DISPLAY[id]!,
      note,
      mode,
      tone: mode === 'read only' ? 'neutral' : 'accent',
    };
  });
}

screensRouter.get('/configure', (_req, res) => {
  // Key names follow the web client's ConfigureData contract (queued /
  // capabilities). The broker queue is authoritative in every source mode;
  // demo fixtures only supply the read-only inventory examples.
  if (sourceFor('configure') === 'demo') {
    // Blend: once a plane reports client sessions the authored SSID/port/VLAN
    // examples describe an estate that is not there — swap the whole section
    // to the observed inventory, the same rule every other screen follows.
    if (blendFor('configure') && datasetReported('clients')) {
      const blendQueue = liveConfigureQueue();
      const observed = observedConfigureInventory(liveClients());
      const blendCompliance = datasetReported('devices') ? liveComplianceData(liveDeviceData().devices) : null;
      res.json(
        withBlended(
          envelopeFor('configure', {
            stats: liveConfigureStats(
              blendQueue,
              observed.ssids.length + observed.ports.length + observed.vlans.length,
              'observed from active client sessions',
              blendCompliance ? blendCompliance.findings.length : null,
            ),
            ssids: observed.ssids,
            ports: observed.ports,
            vlans: observed.vlans,
            inventoryMode: 'observed',
            queued: blendQueue,
            capabilities: liveCapabilityMatrix(),
          }),
          ['configure'],
          'configure',
        ),
      );
      return;
    }
    const queued = demoConfigureQueue();
    res.json(
      envelopeFor('configure', {
        stats: demoConfigureStats(queued),
        ssids: SSIDS,
        ports: CONFIG_PORTS,
        vlans: VLANS,
        inventoryMode: 'configured',
        queued,
        capabilities: CAPABILITY_MATRIX,
      }),
    );
    return;
  }
  const queued = liveConfigureQueue();
  const clientsReported = datasetReported('clients');
  const inventory = observedConfigureInventory(liveClients());
  const configObjects = inventory.ssids.length + inventory.ports.length + inventory.vlans.length;
  const compliance = datasetReported('devices') ? liveComplianceData(liveDeviceData().devices) : null;
  res.json(
    // The capability matrix describes the portal's own write model — in live
    // mode that means what THIS deployment's linked planes can accept, not
    // the fixture estate's.
    envelopeFor('configure', {
      stats: liveConfigureStats(
        queued,
        clientsReported ? configObjects : null,
        clientsReported ? 'observed from active client sessions' : 'no live config inventory source',
        compliance ? compliance.findings.length : null,
      ),
      ssids: inventory.ssids,
      ports: inventory.ports,
      vlans: inventory.vlans,
      inventoryMode: clientsReported ? 'observed' : 'unavailable',
      queued,
      capabilities: liveCapabilityMatrix(),
    }),
  );
});

screensRouter.get('/compliance', (_req, res) => {
  if (sourceFor('compliance') === 'demo') {
    // Blend: the authored findings describe the demo estate's drift. Once a
    // plane reports inventory, serve the live evidence-coverage run instead —
    // Compliance was the last screen still pinned to fixtures under a blend.
    if (blendFor('compliance') && datasetReported('devices')) {
      const blendCompliance = liveComplianceData(liveDeviceData().devices);
      res.json(
        withBlended(envelopeFor('compliance', { ...blendCompliance, evidenceMode: 'coverage' }), ['compliance'], 'compliance'),
      );
      return;
    }
    res.json(
      envelopeFor('compliance', {
        stats: COMPLIANCE_STATS,
        findings: FINDINGS,
        baselines: BASELINE_PROGRESS,
        diff: COMPLIANCE_DIFF,
        evidenceMode: 'baseline',
      }),
    );
    return;
  }
  const devicesReported = datasetReported('devices');
  const compliance = devicesReported
    ? liveComplianceData(liveDeviceData().devices)
    : { stats: [], findings: [], baselines: [], diff: '' };
  res.json(
    envelopeFor('compliance', {
      ...compliance,
      evidenceMode: devicesReported ? 'coverage' : 'unavailable',
    }),
  );
});

// -- Connected systems (screen view model; live state is /api/systems/state) --

/**
 * Display names the Systems screen merges its live state on — the same
 * strings the fixture SYSTEMS rows use. AOS-10 is represented explicitly as
 * a registry plane even though its data path is brokered through Central.
 */
const SYSTEM_DISPLAY: Partial<Record<PlaneId, string>> = {
  central: 'HPE Aruba Central',
  classic: 'Central Classic',
  mist: 'Mist',
  greenlake: 'GreenLake',
  aos8: 'AOS-8 mobility master',
  aos10: 'AOS-10 (via Central)',
  local: 'Local switch collector',
  clearpass: 'ClearPass',
  uxi: 'UXI',
};

const SYSTEM_HEALTH_TONE: Record<PlaneHealth, Tone> = {
  healthy: 'success',
  warning: 'warning',
  degraded: 'danger',
  unlinked: 'neutral',
};

const SCOPE_TONE: Record<ReturnType<typeof scopeForPlane>, Tone> = {
  'read only': 'neutral',
  'read + broker': 'accent',
  'read + ssh': 'accent',
};

/** "Sites on this plane" — what THIS plane actually reported, never the merge. */
function planeSites(pull: PlanePull | undefined): SystemSiteRow[] {
  if (!pull) return [];
  const byId = new Map<SiteId, { name: string; devices: number; clients: number }>();
  const note = (siteId: SiteId, name: string): { name: string; devices: number; clients: number } => {
    const seen = byId.get(siteId);
    if (seen) return seen;
    const fresh = { name, devices: 0, clients: 0 };
    byId.set(siteId, fresh);
    return fresh;
  };
  for (const row of pull.sites ?? []) note(row.id, row.name);
  for (const row of pull.devices ?? []) note(row.siteId, row.siteName).devices += 1;
  for (const row of pull.clients ?? []) note(row.siteId, row.siteName).clients += 1;
  return [...byId.entries()].map(([siteId, s]) => ({
    siteId,
    name: s.name,
    detail: `${s.devices} device${s.devices === 1 ? '' : 's'} · ${s.clients} client${s.clients === 1 ? '' : 's'}`,
  }));
}

/** "Live on this plane" — one counter per dataset this plane contributes. */
function planeLiveStats(pull: PlanePull | undefined): LiveStat[] {
  if (!pull) return [];
  const rows: LiveStat[] = [];
  if (pull.devices) rows.push({ value: String(pull.devices.length), label: 'devices claimed' });
  if (pull.clients) rows.push({ value: String(pull.clients.length), label: 'client sessions' });
  if (pull.alerts) rows.push({ value: String(pull.alerts.filter((a) => a.state === 'open').length), label: 'open alerts' });
  if (pull.subscriptions) rows.push({ value: String(pull.subscriptions.length), label: 'subscriptions' });
  if (pull.authEvents) rows.push({ value: String(pull.authEvents.length), label: 'auth events' });
  return rows;
}

/**
 * "Recent events" — the plane's own event log (credential changes, poll
 * failures, backoff, recovery: registry.recentEvents) merged with its entries
 * in the poller's sync log, newest first. The registry log is the one that
 * carries the events an operator opens this drawer for; the sync log alone
 * only ever showed polls. Times are the operator's local clock, like every
 * other stamp on the screen.
 */
function planeEvents(id: PlaneId): SystemEvent[] {
  const fromRegistry = registry.recentEvents(id).map((e) => ({ time: e.time, what: e.what, who: e.who }));
  const fromPoller = poller
    .history()
    .filter((e) => e.plane === id)
    .map((e) => ({ time: e.time, what: e.what, who: `poller · ${e.result}` }));
  return [...fromRegistry, ...fromPoller]
    .sort((a, b) => (a.time === b.time ? 0 : a.time < b.time ? 1 : -1))
    .slice(0, 6)
    .map((e) => ({ time: localHhmm(e.time), what: e.what, who: e.who }));
}

/**
 * The drawer's fourth fact: credential freshness — how the plane is
 * authenticated and when that credential runs out. Never the secret, and
 * never a claim: a plane that publishes no expiry says so.
 */
function tokenFact(s: PlaneState): string {
  if (!s.linked) return 'no credentials stored';
  const token = s.token;
  if (!token) return 'not reported';
  if (token.expiresAt === null) return `${token.source} · no expiry published`;
  const ms = new Date(token.expiresAt).getTime() - Date.now();
  if (!Number.isFinite(ms)) return token.source;
  return ms <= 0 ? `${token.source} · expired` : `${token.source} · expires in ${relDuration(ms)}`;
}

/**
 * One registry plane as a SystemRow. Everything comes from what the portal
 * actually holds: the registry's link/health/freshness, the plane's own last
 * good pull (its sites, its dataset counts), its entries in the sync log, and
 * the MASKED credential record from settings. The call log is still overlaid
 * client-side from /api/systems/state.
 */
function liveSystemRow(id: PlaneId, s: PlaneState, pull: PlanePull | undefined): SystemRow {
  // The operator's stored displayName (set in the connect drawer) wins over
  // the registry default — a rename must survive onto the screen.
  const stored = settings.get().planes[id];
  const masked = settings.maskedView().planes[id];
  const scope = scopeForPlane(id as PlaneKey, { linked: s.linked, scopes: stored?.scopes ?? null });
  return {
    name: stored?.displayName ?? SYSTEM_DISPLAY[id]!,
    planeId: id,
    kind: s.linked ? 'live plane registry' : 'not linked',
    state: s.health === 'unlinked' ? 'warning' : s.health,
    tone: SYSTEM_HEALTH_TONE[s.health],
    // Derived from what the write broker can really do for this plane and
    // what the operator granted — the same helper the capability matrix
    // reads, so the two screens cannot contradict each other.
    scope,
    scopeTone: SCOPE_TONE[scope],
    scopeNote: !s.linked
      ? 'no credentials stored'
      : scope === 'read only'
        ? 'no write path from the portal to this plane'
        : scope === 'read + ssh'
          ? 'recorded shell, change window only'
          : 'brokered writes, ticket required',
    facts: [
      { k: 'Last sync', v: s.lastSync ? relSync(s.lastSync) : 'never' },
      { k: 'Devices', v: s.deviceCount === null ? '—' : String(s.deviceCount) },
      // The budget is the denominator that makes "Calls today" mean anything
      // (Mist allows 20k/day); a plane whose tier the portal does not know
      // renders the bare count rather than inventing a limit.
      {
        k: 'Calls today',
        v:
          s.callBudget === undefined || s.callBudget === null
            ? String(s.callsToday)
            : `${s.callsToday.toLocaleString('en-US')} / ${s.callBudget.toLocaleString('en-US')}`,
      },
      { k: 'Token', v: tokenFact(s) },
    ],
    sites: planeSites(pull),
    live: planeLiveStats(pull),
    calls: [],
    events: planeEvents(id),
    pulls: [{ what: 'poll()', every: `every ${settings.get().pollIntervalSec}s`, mode: 'read', tone: 'neutral' }],
    configText: [
      `plane: ${id}`,
      `linked: ${s.linked}`,
      `health: ${s.health}`,
      `last_sync: ${s.lastSync ?? 'never'}`,
      s.deviceCount === null ? null : `devices: ${s.deviceCount}`,
      `calls_today: ${s.callsToday}`,
      s.note ? `note: ${s.note}` : null,
      // The stored credential record, exactly as maskedView() renders it —
      // endpoint, client id, workspace and scopes are the record the
      // Configuration tab exists to show; secrets stay masked.
      ...Object.entries(masked ?? {})
        .filter(([key]) => key !== 'displayName')
        .map(([key, value]) => `${key}: ${value}`),
      `scope: ${scope}`,
      `poll_interval: ${settings.get().pollIntervalSec}s`,
    ]
      .filter((line): line is string => line !== null)
      .join('\n'),
  };
}

/** Poller sync log → the SyncHistoryRow shape the screen contract declares. */
function liveSyncHistory(): SyncHistoryRow[] {
  return poller.history().map((e) => ({
    time: e.time,
    system: e.plane,
    what: e.what,
    result: e.result,
    tone: e.result === 'ok' ? 'success' : 'danger',
  }));
}

/** The registry as SystemRows — the live half of the /api/systems payload. */
function liveSystemRows(states: Record<PlaneId, PlaneState>): SystemRow[] {
  const pulls = poller.contributionsByPlane();
  return PLANE_IDS.filter((id) => SYSTEM_DISPLAY[id]).map((id) => liveSystemRow(id, states[id], pulls.get(id)));
}

screensRouter.get('/systems', (_req, res) => {
  const states = registry.states();
  // Blend mode: once any plane is actually linked, the fixture systems list
  // would LIE (it shows a healthy demo Central with 164 devices) — swap the
  // whole section to the live registry rows, same rule as every other
  // section. A 'demo' pin defeats the swap (blendFor); a 'live' pin serves
  // the registry rows even with nothing linked.
  if (sourceFor('systems') === 'demo') {
    if (blendFor('systems') && PLANE_IDS.some((id) => states[id].linked)) {
      const payload = { systems: liveSystemRows(states), syncHistory: liveSyncHistory(), permissions: PERMISSIONS };
      res.json(withBlended(envelopeFor('systems', payload), ['systems'], 'systems'));
      return;
    }
    res.json(envelopeFor('systems', { systems: SYSTEMS, syncHistory: SYNC_HISTORY, permissions: PERMISSIONS }));
    return;
  }
  res.json(envelopeFor('systems', { systems: liveSystemRows(states), syncHistory: liveSyncHistory(), permissions: PERMISSIONS }));
});

// -- Search index --------------------------------------------------------------

/** Raised tickets as search entries — real user data, so searchable in both
 *  modes (arg carries the id so the hit deep-links to /tickets?sel=<id>). */
function ticketSearchEntries(): SearchIndexEntry[] {
  return ticketStore.list().map((t) => ({
    kind: 'ticket',
    label: `${t.id} — ${t.title}`,
    meta: `${t.pri} · ${t.state}`,
    view: 'tickets',
    arg: t.id,
  }));
}

/** Fixture search entries that belong to a source-selectable screen. */
function searchSection(entry: SearchIndexEntry): ScreenSection | null {
  if (entry.kind === 'site') return 'sites';
  if (entry.kind === 'device' || entry.kind === 'mac' || entry.kind === 'ip') return 'devices';
  if (entry.kind === 'client') return entry.view === 'auth' ? 'authEvents' : 'clients';
  if (entry.kind === 'config') return 'configure';
  return null;
}

/** Live-derived index rows, grouped so each section can follow sourceFor(). */
function liveSearchSections(): {
  sites: SearchIndexEntry[];
  devices: SearchIndexEntry[];
  clients: SearchIndexEntry[];
} {
  const live = liveMerged();
  return {
    sites: live.sites.map<SearchIndexEntry>((s) => ({
      kind: 'site',
      label: s.name,
      meta: `${s.devices} devices`,
      view: 'site',
      arg: s.name,
    })),
    devices: live.devices.map<SearchIndexEntry>((d) => ({
      kind: 'device',
      label: d.name,
      meta: `${d.model} · ${d.siteName}`,
      view: 'device',
      arg: d.name,
    })),
    clients: liveClients().map<SearchIndexEntry>((c) => ({
      kind: 'client',
      label: c.name,
      meta: `${c.mac} · ${c.siteName}`,
      view: 'clients',
      arg: c.mac,
    })),
  };
}

screensRouter.get('/search-index', (_req, res) => {
  const raised = ticketSearchEntries();
  const live = liveSearchSections();
  const liveRows = {
    sites: live.sites.length > 0,
    devices: live.devices.length > 0,
    clients: live.clients.length > 0,
  };
  const useLive = new Set<ScreenSection>();
  const blended: ScreenSection[] = [];
  for (const section of ['sites', 'devices', 'clients'] as const) {
    if (sourceFor(section) === 'live') {
      useLive.add(section);
    } else if (blendFor(section) && liveRows[section]) {
      useLive.add(section);
      blended.push(section);
    }
  }
  // Sections with no live search-row projection still must lose fixture hits
  // when pinned live; otherwise search can navigate into a live screen using
  // demo-only objects. Auth events also support blend mode.
  if (sourceFor('authEvents') === 'live') {
    useLive.add('authEvents');
  } else if (blendFor('authEvents') && poller.getCache().authEvents.length > 0) {
    useLive.add('authEvents');
    blended.push('authEvents');
  }
  if (sourceFor('configure') === 'live') useLive.add('configure');

  const raisedIds = new Set(raised.map((entry) => entry.arg));
  const fixtures = SEARCH_INDEX.filter((entry) => {
    if (entry.kind === 'ticket' && entry.arg !== null && raisedIds.has(entry.arg)) return false;
    const section = searchSection(entry);
    if (section === null) return dataSource() === 'demo';
    return sourceFor(section) === 'demo' && !useLive.has(section);
  });
  const entries = [
    ...raised,
    ...(useLive.has('sites') ? live.sites : []),
    ...(useLive.has('devices') ? live.devices : []),
    ...(useLive.has('clients') ? live.clients : []),
    ...fixtures,
  ];
  // The envelope must describe what was actually served, not the portal-wide
  // default: an index whose every entry came from the poller is a live index,
  // and its freshness is the poll time — stamping `now` from the global
  // demoMode would label live hits as demo furniture.
  const liveContributed = useLive.size > 0 && (live.sites.length > 0 || live.devices.length > 0 || live.clients.length > 0);
  const payload = {
    dataSource: liveContributed && fixtures.length === 0 ? 'live' : dataSource(),
    syncedAt: liveContributed ? poller.lastSyncFor('devices', 'sites', 'clients') : syncedAt(),
    entries,
  };
  res.json(blended.length > 0 ? withBlended(payload, blended) : payload);
});
