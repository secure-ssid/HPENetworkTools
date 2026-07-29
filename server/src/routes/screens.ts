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

import { Router, type Response } from 'express';
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
  CONNECT_ENDPOINT_KEY,
  DEVICE_CLIENT_SETS,
  DEVICE_CONFIGS,
  DEVICE_RECONCILIATION,
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
  deriveRssiDbm,
  deriveSiteProfile,
  detailState,
  deviceProfile,
  deviceTerminalKind,
  isRealSiteId,
  matchServingRadio,
  scopeForPlane,
  siteDisplayName,
  siteIdFor,
  terminalBanner,
  terminalQuickCommands,
  toSiteAlertRow,
  toSiteDeviceRow,
  ORPHANS,
  type AlertCorrelation,
  type AlertRow,
  type AuthEventRow,
  type CapabilityRow,
  type ChangeLogEntry,
  type ClientDetailLive,
  type ClientDetailSection,
  type ClientRow,
  type ClientWiring,
  type BaselineProgressRow,
  type DetailFetchState,
  type DetailSource,
  type DeviceCheckRow,
  type DeviceClientSet,
  type DeviceDetailKind,
  type DeviceDetailLive,
  type DeviceDetailSection,
  type DeviceEvidence,
  type DeviceRow,
  type DeviceType,
  type FailReasonRow,
  type FindingRow,
  type LaneMeta,
  type LaunchpadRow,
  type LiveStat,
  type OrphanRow,
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
  type ServingRadio,
  type Sev,
  type SsidObject,
  type SiteAlertRow,
  type SiteDeviceRow,
  type SiteId,
  type SitePlaneBadge,
  type SiteProfile,
  type SiteReachability,
  type SiteRow,
  type SiteTopologyLive,
  type SiteTopologySection,
  type StatDef,
  type SubscriptionAssignment,
  type SubscriptionRow,
  type SyncHistoryRow,
  type SystemEvent,
  type SystemRow,
  type SystemSiteRow,
  type TerminalLine,
  type Tone,
  type PortObject,
  type VlanObject,
} from '../../../shared';
import { effectiveSectionSource, settings } from '../config/settings';
import { poller } from '../services/poller';
import { ticketStore } from '../services/tickets';
import { resolveDeviceIdentity, safeDeviceCandidates, type DeviceIdentity } from '../services/deviceIdentity';
import { terminalManager } from '../services/terminal';
import { writeBroker } from '../services/writeBroker';
import { registry } from '../planes/registry';
import { PLANE_LABEL, planeIdForLabel, reconcileDevices, type ReconciledDeviceRow } from '../services/reconcile';
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
  return effectiveSectionSource(settings.get(), section);
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

/** True when the plane behind this display label is currently serving stale
 *  data (design rule 1). Labels with no registry plane are never asserted —
 *  planeIdForLabel() resolves 'THIRD-PARTY' to undefined, so such a label
 *  never claims a freshness stamp it cannot have. */
function planeIsStale(plane: Plane, stale: ReadonlySet<PlaneId>): boolean {
  const id = planeIdForLabel(plane);
  return id !== undefined && stale.has(id);
}

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
function liveDeviceData(): { devices: ReconciledDeviceRow[]; doubleClaimed: number; unclaimed: number } {
  const byPlane: Partial<Record<PlaneId, readonly DeviceRow[]>> = {};
  for (const [id, pull] of poller.contributionsByPlane()) {
    if (pull.devices) byPlane[id] = pull.devices;
  }
  const { devices, doubleClaimed, unclaimed } = reconcileDevices(byPlane, stalePlanes());
  return { devices: devices.map(withLiveShellGate), doubleClaimed, unclaimed };
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
 * The banner over the live alert queue (README §5): the worst open row,
 * crossed with the worst OTHER open row whose plane is behind. Both halves are
 * read off the rows — nothing is asserted about a site the portal never
 * fetched — and the tone says which of the two facts is doing the talking: a
 * P1 estate is 'danger', a queue whose second finding is only "we cannot see
 * that plane" is 'warning'. Null when nothing is open, so no banner renders.
 */
function liveCorrelation(alerts: AlertRow[]): AlertCorrelation | null {
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

/**
 * Can the portal really open a recorded shell on this device?
 *
 * Three facts have to agree, and the weakest wins (README honesty rule — the
 * shell block must never advertise a session the bridge cannot open):
 *   - the device CLASS has a shell at all (deviceTerminalKind, from the live
 *     row's `type`, never the demo name-prefix rules);
 *   - the inventory row says the collector reaches it (`localShell`);
 *   - no claiming plane's adapter says otherwise (PlaneCapabilities.localShell
 *     false — a cloud plane describes hardware it cannot give a shell to).
 * A plane that makes no capability claim is not treated as a refusal.
 */
function planeAllowsShell(device: ReconciledDeviceRow): boolean {
  const labels = device.claimedBy && device.claimedBy.length > 0 ? device.claimedBy : [device.plane];
  const claims = labels
    .map((label) => planeIdForLabel(label))
    .filter((id): id is PlaneId => id !== undefined)
    .map((id) => registry.state(id).capabilities?.localShell);
  if (claims.length === 0) return true; // no registry plane behind the label — the row decides
  if (claims.some((claim) => claim === true)) return true;
  return !claims.every((claim) => claim === false);
}

/**
 * Can the portal open a recorded shell to this row RIGHT NOW? Three facts,
 * weakest wins:
 *   - the plane's own row claim (`localShell`, a union across claimants),
 *   - no claiming plane's adapter vetoing it (planeAllowsShell), and
 *   - terminalManager.canShell(): the device class has a CLI, the inventory
 *     names a dialable management IP, and local-plane credentials — the shell
 *     path itself — are stored.
 *
 * This is THE shell gate for live rows. liveDeviceData() applies it to every
 * row as it leaves the merge, so `device.localShell` on anything this router
 * serves already means "the portal can open a session", and calling the gate
 * again later (the terminal block, the site core pick, the Launchpad SSH row)
 * is idempotent — it re-states the rule at the point a control is offered
 * rather than trusting a field that arrived from somewhere else.
 *
 * DeviceDetail drives its WS attempt and all three honest shell notes off that
 * one field, so a row that says `true` while the bridge would refuse renders a
 * terminal that can never open (finding
 * devicedetail-live-terminal-gate-can-never-open).
 */
function canOpenShell(device: ReconciledDeviceRow): boolean {
  return (
    device.localShell &&
    planeAllowsShell(device) &&
    terminalManager.canShell({ name: device.name, ip: device.ip, type: device.type, plane: device.plane })
  );
}

/** One reconciled row with `localShell` replaced by the live gate. Same object
 *  back when the merge already agreed, so the common case allocates nothing. */
function withLiveShellGate(device: ReconciledDeviceRow): ReconciledDeviceRow {
  const localShell = canOpenShell(device);
  return localShell === device.localShell ? device : { ...device, localShell };
}

/**
 * The shell block /api/devices/:name serves next to a live device — the same
 * `{banner, quickCommands}` pair the demo branch has always sent, so the two
 * branches and the screen name ONE source (contract drift closed). The kind
 * comes from the inventory row's device type via the shared helper the client
 * also uses, so the two sides cannot disagree; a device with no shell gets no
 * block at all rather than a banner promising a session.
 */
function liveTerminalPayload(
  device: ReconciledDeviceRow,
): { terminal: { banner: TerminalLine[]; quickCommands: string[] } } | Record<string, never> {
  const kind = deviceTerminalKind(device, device.name);
  if (kind === 'none' || !canOpenShell(device)) return {};
  return { terminal: { banner: terminalBanner(kind), quickCommands: terminalQuickCommands(kind) } };
}

/**
 * The device-detail Compliance panel's evidence block. `mode` is what stops an
 * empty list reading as a clean scorecard: a live row always yields five
 * verdicts, so 'live' is honest here, while a name the merge does not hold
 * never reaches this function at all.
 */
function liveDeviceEvidence(device: ReconciledDeviceRow): DeviceEvidence {
  return { checks: evidenceChecksFor(device), mode: 'live' };
}

interface ObservedConfigureInventory {
  ssids: SsidObject[];
  ports: PortObject[];
  vlans: VlanObject[];
}

function portDeviceIdentities(ports: readonly PortObject[]): PortObject[] {
  const devices = liveDeviceData().devices;
  return ports.map((port) => {
    if (port.plane && port.serial) return port;
    const matches = devices.filter((device) => device.name === port.device);
    const device = matches.length === 1 ? matches[0] : null;
    return device?.serial
      ? { ...port, plane: device.plane, serial: device.serial }
      : port;
  });
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

interface LiveConfigureInventory extends ObservedConfigureInventory {
  mode: 'configured' | 'observed' | 'unavailable';
  detail: string;
}

/** Merge configuration reads per section. A configured section wins even when
 * it is empty; sections no plane could read retain the observed-session
 * fallback instead of hiding useful live evidence. */
function liveConfigureInventory(): LiveConfigureInventory {
  const observedAvailable = datasetReported('clients');
  const observed = observedConfigureInventory(liveClients());
  const configs = [...poller.contributionsByPlane().values()]
    .map((pull) => pull.config)
    .filter((config): config is NonNullable<PlanePull['config']> => config !== undefined);

  const ssidsReported = configs.some((config) => config.ssids !== undefined);
  const portsReported = configs.some((config) => config.ports !== undefined);
  const vlansReported = configs.some((config) => config.vlans !== undefined);
  const configured = ssidsReported || portsReported || vlansReported;

  const dedupe = <T>(rows: T[], key: (row: T) => string): T[] =>
    [...new Map(rows.map((row) => [key(row), row])).values()];
  const configuredSsids = dedupe(
    configs.flatMap((config) => config.ssids ?? []),
    (row) => `${row.plane}|${row.name}`.toLowerCase(),
  );
  const configuredPorts = dedupe(
    configs.flatMap((config) => config.ports ?? []),
    (row) => `${row.device}|${row.port}`.toLowerCase(),
  );
  const configuredVlans = dedupe(
    configs.flatMap((config) => config.vlans ?? []),
    (row) => row.id.toLowerCase(),
  );

  const sections = [
    ssidsReported ? 'configured SSIDs' : observedAvailable ? 'observed SSIDs' : null,
    portsReported ? 'configured ports' : observedAvailable ? 'observed ports' : null,
    vlansReported ? 'configured VLANs' : observedAvailable ? 'observed VLANs' : null,
  ].filter((section): section is string => section !== null);
  const sources = [...new Set(configs.map((config) => config.source).filter((source): source is string => !!source))];

  return {
    ssids: ssidsReported ? configuredSsids : observedAvailable ? observed.ssids : [],
    ports: portDeviceIdentities(portsReported ? configuredPorts : observedAvailable ? observed.ports : []),
    vlans: vlansReported ? configuredVlans : observedAvailable ? observed.vlans : [],
    mode: configured ? 'configured' : observedAvailable ? 'observed' : 'unavailable',
    detail:
      sections.length === 0
        ? 'no live config inventory source'
        : `${sections.join(' · ')}${sources.length > 0 ? ` · ${sources.join(' + ')}` : ''}`,
  };
}

/** Findings read in severity order, like the alert queue reads in P-order. */
const FINDING_SEV_RANK: Record<FindingRow['sev'], number> = { high: 0, med: 1, low: 2 };

interface LiveComplianceData {
  stats: StatDef[];
  findings: FindingRow[];
  baselines: BaselineProgressRow[];
  diff: string;
}

/**
 * One live-evidence predicate. `label` names the check on the estate-wide
 * Compliance screen; `pass`/`fail` are the per-DEVICE verdict lines the
 * device-detail evidence panel renders, so a single device never has to be
 * described with an estate-level sentence ("N of M devices …").
 */
interface EvidenceCheck {
  label: string;
  rule: string;
  missing: (device: ReconciledDeviceRow) => boolean;
  pass: (device: ReconciledDeviceRow) => string;
  fail: (device: ReconciledDeviceRow) => string;
}

/**
 * The live evidence rules — ONE definition, read by /api/compliance (grouped
 * into findings and baselines) and by /api/devices/:name (one device's own
 * verdicts). Two screens evaluating the same device under differently-worded
 * copies of these predicates is the drift this list exists to prevent.
 */
const EVIDENCE_CHECKS: EvidenceCheck[] = [
  {
    label: 'Identity evidence',
    rule: 'scan.coverage.identity',
    missing: (device: ReconciledDeviceRow) => !reportedValue(device.model),
    pass: (device) => `Identity reported by ${device.plane} — ${device.model}`,
    fail: (device) => `${device.plane} reported no model for this device`,
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
    pass: (device) => `${device.plane} is current — this row is verified`,
    fail: (device) => `${device.plane} is behind — this row is unverified, not current`,
  },
  {
    label: 'Reachability evidence',
    rule: 'scan.coverage.reachability',
    missing: (device: ReconciledDeviceRow) =>
      device.state !== 'up' && device.state !== 'down' && device.state !== 'unverified',
    pass: (device) => `Reachability reported — state '${device.state}'`,
    fail: (device) => `No usable reachability state ('${device.state || 'not reported'}')`,
  },
  {
    label: 'Firmware evidence',
    rule: 'scan.coverage.firmware',
    missing: (device: ReconciledDeviceRow) => !reportedValue(device.firmware),
    pass: (device) => `Firmware reported — ${device.firmware}`,
    fail: (device) => `${device.plane} reported no firmware version`,
  },
  {
    // Only a CROSS-PLANE claim is a defect. `reconciliationIssue` also
    // covers "claimed by the local collector alone", which README rule 2
    // calls a first-class device, not drift — flagging those made every
    // legitimately local-only switch a permanent, unfixable finding.
    label: 'Ownership reconciliation',
    rule: 'inventory.reconciliation',
    missing: (device: ReconciledDeviceRow) => (device.claimedBy?.length ?? 0) > 1,
    pass: () => 'One plane claims this device',
    fail: (device) => `Claimed by ${(device.claimedBy ?? [device.plane]).join(' + ')} — needs reconciliation`,
  },
];

/** Fail tone per rule: a contested claim or a stale plane is a warning; an
 *  unreported field is information, not a defect the operator can fix. */
const EVIDENCE_FAIL_TONE: Record<string, Tone> = {
  'inventory.reconciliation': 'warning',
  'scan.coverage.freshness': 'warning',
};

/**
 * One device's own evidence verdicts — the per-device half of the same engine
 * /api/compliance runs across the estate. Read-only: liveComplianceData's
 * output is untouched, so the Compliance stats the smoke script and the web
 * Compliance tests assert cannot move.
 */
function evidenceChecksFor(device: ReconciledDeviceRow): DeviceCheckRow[] {
  return EVIDENCE_CHECKS.map((check) => {
    const failed = check.missing(device);
    return {
      mark: failed ? 'fail' : 'pass',
      tone: failed ? (EVIDENCE_FAIL_TONE[check.rule] ?? 'info') : 'success',
      label: failed ? check.fail(device) : check.pass(device),
      rule: check.rule,
    };
  });
}

function liveComplianceData(devices: ReconciledDeviceRow[]): LiveComplianceData {
  if (devices.length === 0) return { stats: [], findings: [], baselines: [], diff: '' };

  const checks = EVIDENCE_CHECKS;

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

function isBookkeepingSiteId(id: SiteId): boolean {
  return id === 'core-services' || id === 'workspace' || id === 'multiple';
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
 * panel counts "Planes linked N / 10" (PLANE_IDS.length) — omitting the
 * unlinked ones made that fraction unreconcilable and hid the reason a plane
 * is dark. The kicker is a coverage fact where the registry has one (what the
 * plane actually claims), falling back to its status note — the note alone
 * just repeated the state Badge next to it while deviceCount was thrown away.
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
  // Same gate the device page and the site reachability core use — a row that
  // merely CLAIMS a shell would put an SSH row on the Launchpad whose terminal
  // then refuses to open.
  const shell = devices.find(canOpenShell);
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
 * (README §1), so `meta` is where the site appears in prose — the fixtures
 * lead with it for exactly that reason, and a detail that already names the
 * site is left alone rather than doubled up.
 *
 * `siteName`/`siteId` ride along as FIELDS as well: a live mapper holds the
 * site as data and would otherwise reduce it to a prose fragment the renderer
 * has to parse to link anywhere. The prose stays until the screen renders the
 * field as its own element (handed off) — sending the field and dropping the
 * prefix in the same edit would delete the site from today's row.
 */
function liveOverviewAlert(a: AlertRow): OverviewAlert {
  const site = reportedValue(a.siteName) ? a.siteName : null;
  const leads = site !== null && a.detail.trim().toLowerCase().startsWith(site.trim().toLowerCase());
  const meta = site === null || leads ? a.detail : [site, a.detail].filter((part) => part.trim()).join(' · ');
  return {
    sev: a.sev,
    tone: a.tone,
    title: a.title,
    meta,
    plane: a.plane,
    age: a.age,
    device: a.device,
    // Omitted, never blank: an unreported site must read as "not reported",
    // and `siteId` is only sent when it is a real site (the bookkeeping ids
    // alerts file under have no site page to link to).
    ...(site === null ? {} : { siteName: site }),
    ...(isRealSiteId(a.siteId) ? { siteId: a.siteId } : {}),
  };
}

/** Unacknowledged rows lead their severity — nobody is on them yet. */
const ALERT_STATE_RANK: Record<AlertRow['state'], number> = { open: 0, acked: 1, cleared: 2 };

/**
 * The "Needs you now" projection: the alert queue minus the rows that no
 * longer need anyone. A row the plane itself considers resolved is not work,
 * and listing it under that heading overstates the workload (README §2) —
 * the same rule the Alerts screen applies when 'show cleared' is off, applied
 * here at the source so the panel, the stat tile and the site column agree.
 *
 * Order: severity first (as the merged queue already sorts), then unacked
 * before acked, then oldest first — a P1 nobody has touched is what the panel
 * should lead with, not a P2 that already has an owner.
 */
function needsYouNowAlerts(alerts: AlertRow[]): OverviewAlert[] {
  return alerts
    .filter((a) => a.state !== 'cleared')
    .sort(
      (a, b) =>
        SEV_RANK[a.sev] - SEV_RANK[b.sev] ||
        ALERT_STATE_RANK[a.state] - ALERT_STATE_RANK[b.state] ||
        ageMinutes(b.age) - ageMinutes(a.age),
    )
    .map(liveOverviewAlert);
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
function liveUnlicensedStat(
  devices: ReconciledDeviceRow[],
  assignments: SubscriptionAssignment[] | null,
): StatDef {
  // The entitlement plane's own device→subscription join answers this tile
  // directly, so it wins over the per-row `licence` hint. `assigned` is
  // TRI-STATE: undefined means the plane never said, and must not be counted
  // as unlicensed — only an explicit false is a device without entitlement.
  if (assignments !== null && assignments.length > 0) {
    const stated = assignments.filter((a) => a.assigned !== undefined);
    const unlicensed = assignments.filter((a) => a.assigned === false).length;
    if (stated.length === 0) {
      return {
        label: 'Devices unlicensed',
        value: '—',
        delta: `${assignments.length} assignment${assignments.length === 1 ? '' : 's'} · none states an assignment`,
        tone: 'neutral',
      };
    }
    return {
      label: 'Devices unlicensed',
      value: String(unlicensed),
      delta: `${stated.length} of ${assignments.length} assignment${assignments.length === 1 ? '' : 's'} state an entitlement`,
      tone: unlicensed > 0 ? 'negative' : 'positive',
    };
  }
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

/**
 * The entitlement plane's device→subscription join, when it read one. A pull
 * that could NOT read the feed declares it in `partial` and carries no
 * `assignments` key at all, so absent stays absent here — never an empty array
 * standing in for "nothing is unlicensed".
 */
function liveAssignments(): SubscriptionAssignment[] | null {
  return poller.contributionsByPlane().get('greenlake')?.assignments ?? null;
}

/** '4 shown · +12 more' style sample line for a grouped reclaim row. */
function assignmentSample(rows: SubscriptionAssignment[]): string {
  const names = rows.slice(0, 4).map((a) => a.deviceName ?? a.serial);
  const rest = rows.length - names.length;
  return rest > 0 ? `${names.join(' · ')} · +${rest} more` : names.join(' · ');
}

/**
 * "Orphans & gaps" — the reclaim list, derived from the entitlement join
 * rather than authored. Three tags, exactly as the design uses them:
 *   orphan — an assignment whose serial is in no plane's inventory (paying for
 *            hardware the estate no longer has);
 *   gap    — a device the plane says is unassigned, or holds no subscription;
 *   idle   — a subscription with none of its seats assigned.
 *
 * Orphan detection is gated on the merged inventory actually carrying serials:
 * against a plane that publishes none, every assignment would "match nothing"
 * and the panel would invent a estate-wide reclaim list out of a missing field.
 */
function liveOrphans(
  devices: ReconciledDeviceRow[],
  subs: LiveSubscription[],
  assignments: SubscriptionAssignment[] | null,
): OrphanRow[] {
  const rows: OrphanRow[] = [];
  if (assignments !== null && assignments.length > 0) {
    const serials = new Set(
      devices.map((d) => d.serial?.trim().toUpperCase()).filter((s): s is string => !!s),
    );
    const orphaned =
      serials.size > 0 ? assignments.filter((a) => a.serial && !serials.has(a.serial.trim().toUpperCase())) : [];
    const orphanSerials = new Set(orphaned.map((a) => a.serial));
    const gaps = assignments.filter(
      (a) => !orphanSerials.has(a.serial) && (a.assigned === false || a.subscriptionKey === null),
    );
    if (orphaned.length > 0) {
      rows.push({
        tag: 'orphan',
        tone: 'warning',
        what: `${orphaned.length} entitlement${orphaned.length === 1 ? '' : 's'} on device${orphaned.length === 1 ? '' : 's'} no plane reports`,
        detail: `${assignmentSample(orphaned)} · not in the merged inventory · reclaim before renewal`,
      });
    }
    if (gaps.length > 0) {
      rows.push({
        tag: 'gap',
        tone: 'info',
        what: `${gaps.length} device${gaps.length === 1 ? '' : 's'} with no active subscription`,
        detail: `${assignmentSample(gaps)} · reported unassigned by the entitlement plane`,
      });
    }
  }
  const idle = subs.filter((s) => s.assignedValue === 0);
  for (const sub of idle.slice(0, 4)) {
    rows.push({
      tag: 'idle',
      tone: 'neutral',
      what: `${sub.name} — none of ${sub.qty} assigned`,
      detail: `${sub.sku} · ${sub.expires}`,
    });
  }
  if (idle.length > 4) {
    rows.push({
      tag: 'idle',
      tone: 'neutral',
      what: `+${idle.length - 4} more subscriptions with none assigned`,
      detail: 'open the subscriptions table for the full list',
    });
  }
  return rows;
}

function liveLicenseStats(
  subs: LiveSubscription[],
  devices: ReconciledDeviceRow[],
  assignments: SubscriptionAssignment[] | null,
): StatDef[] {
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
    liveUnlicensedStat(devices, assignments),
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

/**
 * The broker queue as display rows. `id` and `expiresAt` ride along because
 * they are the only things that make a SERVER-listed change actionable: the
 * screen can only push a change it can name, so without the id every change
 * queued before a reload became permanently unpushable ("N local changes not
 * pushed"), and without the lease it would offer a push the broker will
 * reject. The authored fixture rows carry neither — which is exactly what
 * makes them correctly non-pushable.
 */
function liveConfigureQueue(): QueuedChangeRow[] {
  return writeBroker.list().map((change) => ({
    state: change.state,
    tone: QUEUE_TONE[change.state],
    what: change.what,
    where: change.where,
    ticket: change.ticket,
    id: change.id,
    expiresAt: change.expiresAt,
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
            alerts: blendSection('alerts', needsYouNowAlerts(live.alerts), OVERVIEW_ALERTS, blended),
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
      alerts: needsYouNowAlerts(live.alerts),
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
      // Only a swapped (real) queue gets a derived banner; the authored rows
      // keep the authored one the design wrote for them.
      const correlation = blended.includes('alerts') ? liveCorrelation(alerts) : undefined;
      res.json(
        withBlended(
          envelopeFor('alerts', correlation === undefined ? { alerts } : { alerts, correlation }),
          blended,
          'alerts',
        ),
      );
      return;
    }
    res.json(envelopeFor('alerts', { alerts: ALERTS }));
    return;
  }
  const alerts = sortLiveAlerts(liveAlerts());
  res.json(envelopeFor('alerts', { alerts, correlation: liveCorrelation(alerts) }));
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

// -- On-demand plane detail reads ---------------------------------------------
//
// A control plane models one client across ~8 endpoints and one device across
// many /{id}/subresource endpoints. The poller reads a handful of FLAT LISTS
// (/clients, /aps, /switches, /sites) on a 60s timer, so everything those
// lists do not carry — signal, roam trail, per-radio RF, per-port wiring, link
// topology — is only obtainable with a PER-OBJECT read.
//
// Those reads happen HERE, on the DETAIL REQUEST PATH, for the ONE object a
// page or drawer is opening, and nowhere else. They are never added to the
// poll loop: 9 devices x N subresources x 1440 polls/day would exhaust the
// tenant's daily call budget, and a fix that hammers the plane is a
// regression, not a fix. Three guards keep it cheap:
//
//   1. TTL cache keyed by plane + object, SHARED across routes — a reopened
//      drawer, a second screen asking about the same site, and the clients
//      screen's own 60s refresh with a drawer open all cost nothing.
//   2. Single-flight — concurrent requests for one key await the one call.
//   3. Budget gate — a plane already at its stored daily call budget is not
//      called at all, and the payload SAYS that instead of implying the plane
//      had nothing to say.
//
// Every outcome maps onto DetailSource's three states instead of collapsing
// into one empty:
//   null                      — this plane cannot answer (unlinked, no such
//                               capability, no serial/MAC to ask about). The
//                               screen keeps the empty state it already had.
//   sections {} + note        — we deliberately did not ask (budget spent).
//   sections all 'failed'     — we asked and the call broke or timed out.
//   whatever the adapter says — including 'empty', which is a REAL answer: a
//                               stationary client with no roams is "no roaming
//                               in the last 24h", never "no source".

/** Detail freshness. Longer than the 60s poll on purpose: these are per-object
 *  calls against a metered plane, and a drawer left open through a refresh
 *  must not turn into one call per poll. */
const DETAIL_TTL_MS = 90_000;
/** Physical wiring changes on the timescale of a maintenance window, not a
 *  poll, so the site graph is cached far longer than RF numbers. */
const TOPOLOGY_TTL_MS = 300_000;
/** Backstop only — adapters carry their own HTTP timeouts. This exists so a
 *  hung socket cannot hold a screen request open forever. */
const DETAIL_TIMEOUT_MS = 10_000;
/** Bounded so a long-lived server cannot accumulate one entry per MAC seen. */
const DETAIL_CACHE_MAX = 256;

const detailCache = new Map<string, { at: number; value: unknown }>();
const detailInflight = new Map<string, Promise<unknown>>();

/** Test seam: forget every cached detail read. Never called by a route. */
export function resetDetailCache(): void {
  detailCache.clear();
  detailInflight.clear();
}

function trimDetailCache(): void {
  while (detailCache.size > DETAIL_CACHE_MAX) {
    const oldest = detailCache.keys().next();
    if (oldest.done) return;
    detailCache.delete(oldest.value);
  }
}

/** Re-stamp a cached payload as cached WITHOUT mutating the cached object —
 *  it is handed to every subsequent reader. */
function asCached<T extends { source: DetailSource<string> }>(value: T | null): T | null {
  if (value === null) return null;
  return { ...value, source: { ...value.source, cached: true } };
}

/**
 * TTL + single-flight around one per-object read.
 *
 * A cached `null` is cached too: "this plane cannot answer" is an answer, and
 * re-asking every request would defeat the point of the gate.
 */
function cachedDetail<T extends { source: DetailSource<string> }>(
  key: string,
  ttlMs: number,
  run: () => Promise<T | null>,
): Promise<T | null> {
  const hit = detailCache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return Promise.resolve(asCached(hit.value as T | null));
  const flying = detailInflight.get(key) as Promise<T | null> | undefined;
  if (flying) return flying;
  const call = run()
    .then((value) => {
      detailCache.set(key, { at: Date.now(), value });
      trimDetailCache();
      return value;
    })
    .finally(() => detailInflight.delete(key));
  detailInflight.set(key, call as Promise<unknown>);
  return call;
}

const DETAIL_DEADLINE = { ok: false as const };

/**
 * Run one adapter call so it can only ever resolve. A throw or a hang becomes
 * an explicit 'failed' payload — NOT a null, because null means "never asked"
 * and the two must not read the same on screen.
 */
async function attemptDetail<T>(
  call: () => Promise<T | null>,
  onFailure: (note: string) => T,
): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const deadline = new Promise<typeof DETAIL_DEADLINE>((resolve) => {
      timer = setTimeout(() => resolve(DETAIL_DEADLINE), DETAIL_TIMEOUT_MS);
      if (typeof timer.unref === 'function') timer.unref();
    });
    const settled = await Promise.race([
      call().then((value) => ({ ok: true as const, value })),
      deadline,
    ]);
    if (!settled.ok) {
      return onFailure(`the detail read did not answer within ${Math.round(DETAIL_TIMEOUT_MS / 1000)}s`);
    }
    return settled.value;
  } catch (err) {
    return onFailure(detailErrorText(err));
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** The adapter's own words, trimmed. Adapters never put credentials in an
 *  error message; the length cap keeps a stack trace out of the payload. */
function detailErrorText(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  const one = text.split('\n')[0]!.trim();
  return one.length > 200 ? `${one.slice(0, 197)}…` : one || 'the detail read failed';
}

/**
 * Is this plane out of calls for today?
 *
 * A plane with no stored budget asserts no limit, so it is never gated. When
 * there IS a budget and it is spent, the honest move is to not call and say
 * why — a detail payload with no sections attempted plus that sentence.
 */
function detailBudgetNote(id: PlaneId): string | null {
  const state = registry.state(id);
  const budget = state.callBudget;
  if (budget === null || budget === undefined) return null;
  if (state.callsToday < budget) return null;
  return `${PLANE_LABEL[id]} has spent its stored daily call budget (${state.callsToday}/${budget}) — no per-object detail read was issued`;
}

/** The registry plane behind a display label, or null for a label the portal
 *  adapts nothing for ('THIRD-PARTY'). */
function detailPlaneFor(label: Plane | null | undefined): PlaneId | null {
  return label ? planeIdForLabel(label) ?? null : null;
}

/** Last-resort guard: a detail read is an enhancement, never a reason for a
 *  screen request to fail. */
function neverThrows<T>(p: Promise<T | null>): Promise<T | null> {
  return p.catch(() => null);
}

const CLIENT_DETAIL_SECTIONS: readonly ClientDetailSection[] = [
  'rssi',
  'tput',
  'roams',
  'timeline',
  'usageSeries',
];

function sectionMap<S extends string>(
  sections: readonly S[],
  state: DetailFetchState,
): Partial<Record<S, DetailFetchState>> {
  const out: Partial<Record<S, DetailFetchState>> = {};
  for (const s of sections) out[s] = state;
  return out;
}

/**
 * A detail payload that carries no data and says why.
 *
 * `attempted: false` leaves `sections` empty, which the contract defines as
 * 'not-fetched' for every section — the shape for "we chose not to ask".
 * `attempted: true` marks them 'failed' — "we asked and it broke".
 */
function clientDetailStub(
  mac: string,
  plane: PlaneId,
  note: string,
  attempted: boolean,
): ClientDetailLive {
  return {
    mac,
    source: {
      plane,
      at: new Date().toISOString(),
      sections: attempted ? sectionMap(CLIENT_DETAIL_SECTIONS, 'failed') : {},
      note,
    },
  };
}

/** An AP has radios and WLANs; a switch or gateway has ports. Asking a switch
 *  for radios spends a call on a guaranteed 404. */
function deviceDetailSections(kind: DeviceDetailKind): readonly DeviceDetailSection[] {
  return kind === 'ap' ? (['radios', 'wlans'] as const) : (['ports'] as const);
}

function deviceDetailStub(
  serial: string,
  kind: DeviceDetailKind,
  plane: PlaneId,
  note: string,
  attempted: boolean,
): DeviceDetailLive {
  return {
    serial,
    kind,
    source: {
      plane,
      at: new Date().toISOString(),
      sections: attempted ? sectionMap(deviceDetailSections(kind), 'failed') : {},
      note,
    },
  };
}

const TOPOLOGY_SECTIONS: readonly SiteTopologySection[] = ['nodes', 'links'];

function topologyStub(
  siteKey: string,
  plane: PlaneId,
  note: string,
  attempted: boolean,
): SiteTopologyLive {
  return {
    siteId: siteKey,
    source: {
      plane,
      at: new Date().toISOString(),
      sections: attempted ? sectionMap(TOPOLOGY_SECTIONS, 'failed') : {},
      note,
    },
  };
}

/** Only these three device families have per-object subresources worth a call;
 *  a controller/sensor/policy row asks for nothing. */
const DEVICE_DETAIL_KIND: Partial<Record<DeviceType, DeviceDetailKind>> = {
  ap: 'ap',
  switch: 'switch',
  gateway: 'gateway',
};

/**
 * Per-client detail for the ONE client whose drawer is opening.
 *
 * Gates, in order: a client with no MAC cannot be asked about; a label with no
 * registry plane behind it has no adapter; an adapter without the capability
 * claims nothing; a plane out of budget is told about rather than called.
 */
function liveClientDetail(client: ClientRow | null | undefined): Promise<ClientDetailLive | null> {
  if (!client || !reportedValue(client.mac)) return Promise.resolve(null);
  const planeId = detailPlaneFor(client.plane);
  if (!planeId) return Promise.resolve(null);
  const adapter = registry.get(planeId);
  const read = adapter.clientDetail;
  if (typeof read !== 'function') return Promise.resolve(null);
  const mac = client.mac;
  const budget = detailBudgetNote(planeId);
  if (budget) return Promise.resolve(clientDetailStub(mac, planeId, budget, false));
  return neverThrows(
    cachedDetail(`client:${planeId}:${normalizeMac(mac)}:${client.medium}`, DETAIL_TTL_MS, () =>
      attemptDetail(
        () => read.call(adapter, mac, client.medium),
        (note) => clientDetailStub(mac, planeId, note, true),
      ),
    ),
  );
}

/** Per-device detail for the ONE device whose page is opening. */
function liveDeviceDetail(device: ReconciledDeviceRow | null): Promise<DeviceDetailLive | null> {
  if (!device || !reportedValue(device.serial)) return Promise.resolve(null);
  const kind = DEVICE_DETAIL_KIND[device.type];
  if (!kind) return Promise.resolve(null);
  const planeId = detailPlaneFor(device.plane);
  if (!planeId) return Promise.resolve(null);
  const adapter = registry.get(planeId);
  const read = adapter.deviceDetail;
  if (typeof read !== 'function') return Promise.resolve(null);
  const serial = device.serial!;
  const budget = detailBudgetNote(planeId);
  if (budget) return Promise.resolve(deviceDetailStub(serial, kind, planeId, budget, false));
  return neverThrows(
    cachedDetail(`device:${planeId}:${serial}:${kind}`, DETAIL_TTL_MS, () =>
      attemptDetail(
        () => read.call(adapter, serial, kind),
        (note) => deviceDetailStub(serial, kind, planeId, note, true),
      ),
    ),
  );
}

/**
 * The key a plane can join its own site records on.
 *
 * The portal's SiteId is the PORTAL's: central.ts mints 'ext-<slug>' from the
 * plane's site NAME (siteIdForName) and keeps no plane id, so this route has
 * no numeric id to pass. A portal id that is already all digits came from a
 * plane and is passed through unchanged; otherwise the site NAME is the only
 * key both sides hold, and the adapter owns the name -> id join because the
 * adapter is the side that made it.
 */
function planeSiteKey(site: SiteRow): string {
  const id = String(site.id);
  return /^\d+$/.test(id) ? id : site.name;
}

/**
 * The plane's link topology for ONE site.
 *
 * A site can be claimed by several planes; the first badge whose adapter can
 * actually answer wins, rather than assuming Central. The result is cached per
 * plane+site, so the site page, a device page and a client drawer at the same
 * site share one read.
 */
function liveSiteTopology(site: SiteRow | null): Promise<SiteTopologyLive | null> {
  if (!site) return Promise.resolve(null);
  const siteKey = planeSiteKey(site);
  if (!reportedValue(siteKey)) return Promise.resolve(null);
  for (const badge of site.planes) {
    const planeId = detailPlaneFor(badge.name);
    if (!planeId) continue;
    const adapter = registry.get(planeId);
    const read = adapter.siteTopology;
    if (typeof read !== 'function') continue;
    const budget = detailBudgetNote(planeId);
    if (budget) return Promise.resolve(topologyStub(siteKey, planeId, budget, false));
    return neverThrows(
      cachedDetail(`topology:${planeId}:${siteKey}`, TOPOLOGY_TTL_MS, () =>
        attemptDetail(
          () => read.call(adapter, siteKey),
          (note) => topologyStub(siteKey, planeId, note, true),
        ),
      ),
    );
  }
  return Promise.resolve(null);
}

/** The site row a live object belongs to, for the topology read. */
function liveSiteById(id: SiteId | null | undefined): SiteRow | null {
  if (!id) return null;
  return liveMerged().sites.find((s) => s.id === id) ?? null;
}

/** Answer an async screen request without letting a rejection hang the socket. */
function settle(res: Response, work: Promise<void>): void {
  void work.catch((err) => {
    if (!res.headersSent) res.status(500).json({ error: detailErrorText(err) });
  });
}

// -- Clients / auth events ----------------------------------------------------

// The drawer's SIGNAL, RETRIES and WIRING rows are JOINS, not field mappings.
//
// Central's Client schema carries neither rssi nor retries. `retries` exists
// only on RadioListResponseV1 — PER AP RADIO — and the one per-client rssi in
// the whole Monitoring spec is MobilityDetails.rssi, a ROAM EVENT row a
// stationary client never produces. The physical uplink is modelled on the SITE
// GRAPH, not on the client. So each row is filled by joining a second object:
//
//   RETRIES -> the SERVING radio of the AP the client is associated to, matched
//              by band+channel against /aps/{serial}/radios. It is THE RADIO'S
//              retry percentage across all its clients, and must be labelled as
//              such.
//   SIGNAL  -> snr + that radio's noise floor (deriveRssiDbm). Arithmetic, not a
//              plane reading. A reported rssi ALWAYS wins over it.
//   WIRING  -> the topology link whose far end is that AP: the switch, and the
//              port the AP is patched into.
//
// All three are best-effort. No serving radio, no link, no snr — no value. The
// blank row stays blank rather than being filled with a guess.

/** The AP a WIRELESS client is associated to. The client row names it
 *  (`attach`) but carries no serial, so the reconciled roster is the join —
 *  keyed by the same name the topology graph uses. */
function liveApForClient(client: ClientRow | null | undefined): ReconciledDeviceRow | null {
  if (!client || client.medium !== 'wireless' || !reportedValue(client.attach)) return null;
  return (
    liveMerged().devices.find(
      (d) => d.type === 'ap' && d.name === client.attach && reportedValue(d.serial),
    ) ?? null
  );
}

/** Band and channel back out of the composed link cell ('2.4 GHz · 6 (20 MHz)').
 *  central.ts joins the plane's two radio fields for display and keeps neither
 *  raw, so this is where the pair is recovered for the radio match. */
function clientRadioKeys(client: ClientRow): { band: string | null; channel: string | null } {
  const parts = client.link.split('·').map((part) => part.trim());
  return { band: parts[0] ?? null, channel: parts[1] ?? null };
}

/** The number in front of a display value ('48 dB' -> 48, '—' -> null). */
function leadingNumber(text: string | null | undefined): number | null {
  const match = /^-?\d+(?:\.\d+)?/.exec((text ?? '').trim());
  if (!match) return null;
  const value = Number(match[0]);
  return Number.isFinite(value) ? value : null;
}

/**
 * The AP radio this client is actually on, and what happened to the read.
 *
 * One extra per-object call per drawer open, through the SAME TTL cache the
 * device page uses: several clients on one AP cost one call, and an AP page
 * already opened inside the TTL costs none. 'empty' means the radio list came
 * back and no radio could be matched — matchServingRadio returns null rather
 * than guess, because another radio's retries and noise floor on this client's
 * drawer is worse than the blank row it would replace.
 */
async function liveServingRadio(
  client: ClientRow,
  ap: ReconciledDeviceRow,
): Promise<{ radio: ServingRadio | null; state: DetailFetchState }> {
  const detail = await liveDeviceDetail(ap);
  const radios = detail?.radios;
  if (!radios) {
    return { radio: null, state: detail ? detailState(detail.source, 'radios') : 'not-fetched' };
  }
  const { band, channel } = clientRadioKeys(client);
  const match = matchServingRadio(radios, band, channel);
  if (!match) return { radio: null, state: 'empty' };
  return {
    radio: {
      serial: ap.serial!,
      apName: ap.name,
      radioNumber: match.number ?? null,
      band: match.band,
      channel: match.channel,
      noiseFloorDbm: match.noiseFloorDbm ?? null,
      retries: match.retries ?? null,
      channelQuality: match.channelQuality ?? null,
      channelUtilPct: match.channelUtilPct ?? null,
      clients: match.clients ?? null,
    },
    state: 'ok',
  };
}

/**
 * The switch port an AP is patched into, off the site graph.
 *
 * Central draws the link FROM the switch, so the AP is normally the `to` end —
 * both ends are checked, and the port always comes from the SWITCH end. Reading
 * the AP's own 'eth0' into the WIRING row would name the wrong end of the
 * cable. A far end that is not a switch (or not on the graph at all) is not
 * reported as one.
 */
function wiringForAp(
  topology: SiteTopologyLive | null,
  ap: ReconciledDeviceRow,
): ClientWiring | null {
  const links = topology?.links;
  if (!links || links.length === 0) return null;
  const serial = ap.serial!;
  const nodes = new Map((topology?.nodes ?? []).map((node) => [node.serial, node]));
  for (const link of links) {
    const apIsFrom = link.from === serial;
    if (!apIsFrom && link.to !== serial) continue;
    const far = nodes.get(apIsFrom ? link.to : link.from);
    if (!far || !/switch/i.test(far.type)) continue;
    const port = (apIsFrom ? link.toPorts : link.fromPorts)?.[0]?.name;
    if (!reportedValue(port)) continue;
    return {
      apName: ap.name,
      apSerial: serial,
      switchName: far.name,
      switchSerial: far.serial,
      port: port!,
      speedBps: link.speedBps,
      linkHealth: link.health,
    };
  }
  return null;
}

/**
 * Fold the serving radio, the derived signal and the wiring into the payload.
 *
 * Pure — the reads already happened. The detail object is never mutated: on a
 * cache MISS it IS the object held in the TTL cache and handed to every later
 * reader.
 *
 * SIGNAL is only derived when the plane reported no rssi of its own; a real
 * reading from the mobility trail is never overwritten with arithmetic. The
 * renderer tells the two apart by `sections.rssi`: 'ok' is the plane's number,
 * and a number present while the section says 'empty' is the derived one, which
 * must be labelled as derived from SNR + noise floor.
 */
function withClientJoins(
  detail: ClientDetailLive | null,
  client: ClientRow | null,
  ap: ReconciledDeviceRow | null,
  served: { radio: ServingRadio | null; state: DetailFetchState } | null,
  topology: SiteTopologyLive | null,
): ClientDetailLive | null {
  if (!detail || !client || !ap) return detail;
  const radio = served?.radio ?? null;
  const wiring = wiringForAp(topology, ap);
  const sections = { ...detail.source.sections };
  if (served && served.state !== 'not-fetched') sections.servingRadio = served.state;
  // Only an actual graph can be 'empty' about this AP; a topology we never read
  // says nothing at all about its wiring.
  if (topology?.links) sections.wiring = wiring ? 'ok' : 'empty';
  const joined: ClientDetailLive = {
    ...detail,
    ...(radio ? { servingRadio: radio } : {}),
    ...(wiring ? { wiring } : {}),
    source: { ...detail.source, sections },
  };
  if (joined.rssi === null || joined.rssi === undefined) {
    const derived = deriveRssiDbm(leadingNumber(client.snr), radio?.noiseFloorDbm);
    if (derived !== null) joined.rssi = derived;
  }
  return joined;
}

/**
 * Keys a client-detail request adds to the clients envelope.
 *
 * A request that named NO client adds nothing at all, so the screen's own 60s
 * refresh of /api/clients is byte-for-byte what it always was and issues zero
 * per-object calls. Only naming one client opens the detail path.
 *
 * `topology` rides along because the drawer's "Wiring" and "Path to the
 * internet" rows are answerable from nothing else: the client row says which
 * AP it is attached to, and the site's link graph says which switch port that
 * AP hangs off (AP765-FrontOutSide -> CX6300-CORE 1/1/12). All three reads are
 * issued together and all three are cached, and the site graph is shared with
 * the site and device pages — so a drawer open costs one client call, one AP
 * call per AP per TTL, and one site call per TTL.
 */
async function clientDetailKeys(
  client: ClientRow | null,
  wanted: string | null,
): Promise<Record<string, unknown>> {
  if (wanted === null) return {};
  const ap = liveApForClient(client);
  const [detail, topology, served] = await Promise.all([
    liveClientDetail(client),
    liveSiteTopology(liveSiteById(client?.siteId)),
    ap && client ? liveServingRadio(client, ap) : Promise.resolve(null),
  ]);
  return { client, detail: withClientJoins(detail, client, ap, served, topology), topology };
}

/**
 * The clients screen, plus — when the request names ONE client — that client's
 * on-demand detail.
 *
 * The MAC arrives either as `?mac=` (the same param the drawer already keeps in
 * the screen URL) or as a path segment, and both land here so the detail read
 * has exactly one implementation.
 */
async function serveClients(res: Response, macParam: string | null): Promise<void> {
  const wanted = macParam && macParam.trim() !== '' ? normalizeMac(macParam) : null;
  const pick = (rows: ClientRow[]): ClientRow | null =>
    wanted === null ? null : rows.find((c) => normalizeMac(c.mac) === wanted) ?? null;

  if (sourceFor('clients') === 'demo') {
    if (blendFor('clients')) {
      const blended: string[] = [];
      const blendClients = liveClients();
      if (blendClients.length > 0) {
        blended.push('clients');
        res.json(
          withBlended(
            envelopeFor('clients', {
              stats: liveClientStats(blendClients),
              clients: blendClients,
              ...(await clientDetailKeys(pick(blendClients), wanted)),
            }),
            blended,
            'clients',
          ),
        );
        return;
      }
    }
    // Demo rows are authored and complete. There is no live object behind a
    // fixture MAC, so asking a plane about one would spend a call to learn
    // nothing — and the payload stays exactly as demo mode has always served it.
    res.json(envelopeFor('clients', { stats: CLIENT_STATS, clients: CLIENTS }));
    return;
  }
  const clients = liveClients();
  res.json(
    envelopeFor('clients', {
      stats: liveClientStats(clients),
      clients,
      ...(await clientDetailKeys(pick(clients), wanted)),
    }),
  );
}

screensRouter.get('/clients', (req, res) => {
  settle(res, serveClients(res, typeof req.query.mac === 'string' ? req.query.mac : null));
});

/**
 * Same handler as `/clients?mac=` — a caller that prefers the path form gets
 * the identical envelope rather than a second, drifting implementation.
 *
 * A MAC that is not in the roster is NOT a 404 here (unlike /devices/:name and
 * /sites/:siteId, which are whole pages). The response is still the clients
 * screen, with `client: null` — which is the honest answer to "show me this
 * session": the roster is current and this MAC is not on it.
 */
screensRouter.get('/clients/:mac', (req, res) => {
  settle(res, serveClients(res, req.params.mac));
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

/**
 * The Plane column on a live auth row always read CLEARPASS, because the
 * policy plane is the only feed that produces auth events and it truthfully
 * names itself — so the column carried no information at all. The event's
 * `nas` names the switch/controller that asked, and the merged inventory knows
 * which plane owns that device: on a UNIQUE match the row is re-badged with
 * the owning plane, otherwise it keeps the reporter's own label rather than
 * guessing between two devices with the same name.
 *
 * Rows are mapped into new objects — the poller's cached rows are shared by
 * reference with every other reader.
 */
function withOwningPlane(events: LiveAuthEvent[]): LiveAuthEvent[] {
  const devices = poller.getCache().devices;
  if (devices.length === 0 || events.length === 0) return events;
  const byKey = new Map<string, DeviceRow[]>();
  const note = (key: string | undefined, row: DeviceRow): void => {
    if (!reportedValue(key)) return;
    const k = key!.trim().toLowerCase();
    const rows = byKey.get(k);
    if (rows) rows.push(row);
    else byKey.set(k, [row]);
  };
  for (const row of devices) {
    note(row.name, row);
    note(row.ip, row);
  }
  return events.map((event) => {
    if (!reportedValue(event.nas)) return event;
    const matches = byKey.get(event.nas.trim().toLowerCase());
    if (!matches || matches.length !== 1) return event;
    const owner = matches[0]!;
    return owner.plane === event.plane ? event : { ...event, plane: owner.plane };
  });
}

screensRouter.get('/auth-events', (_req, res) => {
  if (sourceFor('authEvents') === 'demo') {
    if (blendFor('authEvents')) {
      const events = withOwningPlane(poller.getCache().authEvents as LiveAuthEvent[]);
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
  const events = withOwningPlane(poller.getCache().authEvents as LiveAuthEvent[]);
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
        : `${claimed.length} of ${siteDevices.length} device${siteDevices.length === 1 ? '' : 's'} at this site are claimed by the ${label} collector · ${sync}`,
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
      ? Math.max(0, total - removed).toLocaleString('en-US')
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
  return { topology: await liveSiteTopology(site) };
}

screensRouter.get('/sites/:siteId', (req, res) => {
  settle(res, serveSiteDetail(res, req.params.siteId));
});

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
    }),
  );
}

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
        // The demo estate's authored reconciliation counts. Sent from the
        // route like every other mode's counts, so the screen reads ONE key
        // instead of keeping its own demo-mode fallback beside the payload.
        reconciliation: DEVICE_RECONCILIATION,
        hiddenDevices: hidden,
      }),
    );
    return;
  }
  const { devices, doubleClaimed, unclaimed } = liveDeviceData();
  res.json(envelopeFor('devices', { devices, lanes: liveLaneMeta(), reconciliation: { doubleClaimed, unclaimed } }));
});

/**
 * Keys a live device page adds from the per-object read path.
 *
 * `detail` is this ONE device's subresources — radios + WLANs for an AP, ports
 * for a switch or gateway — which no flat list carries. `topology` is the
 * site's link graph, so an AP page can say which switch port it hangs off (the
 * AP has no port list of its own) and a switch page can corroborate its
 * neighbours. Both are cached; the graph is shared with the site page and the
 * client drawer, so opening several pages at one site costs one graph read.
 */
async function deviceDetailKeys(
  device: ReconciledDeviceRow,
): Promise<Record<string, unknown>> {
  const [detail, topology] = await Promise.all([
    liveDeviceDetail(device),
    liveSiteTopology(liveSiteById(device.siteId)),
  ]);
  return { detail, topology };
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

/**
 * Resolve ONE row for /api/devices/:name — plane+serial is the only identity
 * that survives reconciliation (services/reconcile.ts identityKey): two rows
 * can carry the same display name after two planes each claim a physically
 * distinct device under it (different serial), and `.find` on name alone
 * would silently serve whichever happened to sort first — the exact bug this
 * resolver exists to close.
 *
 *   - `serial` given → resolved by serial ONLY (the one key every plane
 *     agrees on); a name mismatch is not consulted, so a stale name in an old
 *     deep link never blocks a resolution its serial still answers.
 *   - no serial, name matches exactly one row → that row (legacy links —
 *     search hits, other screens' name-only fields — keep working for as
 *     long as the name stays unique).
 *   - no serial, name matches more than one row → `plane` narrows it when
 *     that alone is unambiguous; otherwise every match comes back so the
 *     caller can report the ambiguity honestly instead of guessing.
 */
/** Honest 409 for a name that resolves to more than one physical device —
 *  never picked-first, never a 404 (the name IS known, just not to one row). */
function ambiguousDeviceResponse(
  res: Response,
  name: string,
  dataSource: DataSource,
  matches: ReadonlyArray<{ plane: Plane; serial?: string; claimedBy?: Plane[] }>,
  extra: Record<string, unknown> = {},
): void {
  res.status(409).json({
    error: `'${name}' names ${matches.length} devices — pass plane and serial to pick one`,
    dataSource,
    candidates: safeDeviceCandidates(matches),
    ...extra,
  });
}

screensRouter.get('/devices/:name', (req, res) => {
  settle(res, serveDeviceDetail(res, req.params.name, deviceIdentityQuery(req)));
});

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
              config: null,
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
        config: DEVICE_CONFIGS[profile.kind],
        clients: DEVICE_CLIENT_SETS[profile.kind],
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
      config: null,
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

// -- Licences / configure / compliance ---------------------------------------

screensRouter.get('/licenses', (_req, res) => {
  if (sourceFor('licenses') === 'demo') {
    if (blendFor('licenses')) {
      const subs = poller.getCache().subscriptions as LiveSubscription[];
      if (subs.length > 0) {
        const blendDevices = liveDeviceData().devices;
        const blendAssignments = liveAssignments();
        res.json(
          withBlended(
            envelopeFor('licenses', {
              stats: liveLicenseStats(subs, blendDevices, blendAssignments),
              subscriptions: subs,
              renewals: liveRenewals(subs),
              orphans: liveOrphans(blendDevices, subs, blendAssignments),
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
  // computed from the rows' metric hints, and the reclaim list derived from
  // the plane's device→subscription join when it read one. A plane that did
  // not publish assignments contributes no orphan/gap rows at all — the
  // screen's own empty state then says why, instead of a confident '0'.
  const subs = poller.getCache().subscriptions as LiveSubscription[];
  const devices = liveDeviceData().devices;
  const assignments = liveAssignments();
  res.json(
    envelopeFor('licenses', {
      stats: liveLicenseStats(subs, devices, assignments),
      subscriptions: subs,
      renewals: liveRenewals(subs),
      orphans: liveOrphans(devices, subs, assignments),
    }),
  );
});

/**
 * What the portal can ACTUALLY do with a plane: the scope the operator
 * granted, crossed with the adapter's own capability claim.
 *
 * A credential scoped `write:brokered` against a plane whose adapter reports
 * `brokeredWrite: false` still cannot take a change — the grant describes the
 * token, the capability describes the code path. Only an EXPLICIT false
 * downgrades; a plane that makes no claim is trusted with what it was granted
 * (most adapters do not implement capabilities() at all).
 */
function effectiveScope(
  state: PlaneState,
  granted: ReturnType<typeof scopeForPlane>,
): ReturnType<typeof scopeForPlane> {
  const caps = state.capabilities;
  if (!caps) return granted;
  // SSE has no ticketed broker at all — PLANE_WRITE_MODE.sse is 'read only'
  // (accurate for the Configure screen's port/SSID/VLAN capability matrix,
  // which SSE never participates in), so scopeForPlane('sse', …) can never
  // itself answer 'read + broker'. Its real write capability is reported
  // through capabilities().directWrite instead (the Systems Configuration
  // tab's object CRUD), which this helper is not asked to upgrade a scope
  // for — there is nothing to downgrade here for a plane that was never
  // granted 'read + broker' in the first place.
  if (granted === 'read + broker' && caps.brokeredWrite === false) return 'read only';
  if (granted === 'read + ssh' && caps.localShell === false) return 'read only';
  return granted;
}

/**
 * "Where a change can go" for the real deployment: one row per registry
 * plane, its mode taken from the SAME scope helper the Systems scope badge
 * reads, so the two screens can never disagree. An unlinked plane cannot
 * accept a change, and says so, instead of advertising the fixture estate's
 * brokered collector and AOS-8 master.
 */
function liveCapabilityMatrix(): CapabilityRow[] {
  const states = registry.states();
  const stored = settings.get().planes;
  return PLANE_IDS.filter((id) => SYSTEM_DISPLAY[id]).map((id) => {
    const state = states[id];
    const linked = state.linked;
    const granted = scopeForPlane(id as PlaneKey, { linked, scopes: stored[id]?.scopes ?? null });
    const scope = effectiveScope(state, granted);
    const mode: CapabilityRow['mode'] =
      scope === 'read + broker' ? 'brokered' : scope === 'read + ssh' ? 'ssh' : 'read only';
    const note = !linked
      ? 'not linked — no credentials stored'
      : state.health === 'degraded'
        ? 'linked, but the plane is not answering'
        : mode === 'brokered'
          ? 'brokered write, ticket required'
          : mode === 'ssh'
            ? 'recorded shell, window only'
            : granted === scope
              ? 'payload pre-filled in the plane console'
              : // The credential grants a write scope this plane's adapter says
                // it cannot carry out — the honest row is the capability, not
                // the grant, or Configure offers a push that cannot happen.
                'this plane reports no write path — payload pre-filled in its console';
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
    // Blend: configured API reads or live client evidence replace the authored
    // SSID/port/VLAN examples as one coherent live section.
    const inventory = liveConfigureInventory();
    if (blendFor('configure') && inventory.mode !== 'unavailable') {
      const blendQueue = liveConfigureQueue();
      const blendCompliance = datasetReported('devices') ? liveComplianceData(liveDeviceData().devices) : null;
      res.json(
        withBlended(
          envelopeFor('configure', {
            stats: liveConfigureStats(
              blendQueue,
              inventory.ssids.length + inventory.ports.length + inventory.vlans.length,
              inventory.detail,
              blendCompliance ? blendCompliance.findings.length : null,
            ),
            ssids: inventory.ssids,
            ports: inventory.ports,
            vlans: inventory.vlans,
            inventoryMode: inventory.mode,
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
  const inventory = liveConfigureInventory();
  const configObjects = inventory.ssids.length + inventory.ports.length + inventory.vlans.length;
  const compliance = datasetReported('devices') ? liveComplianceData(liveDeviceData().devices) : null;
  res.json(
    // The capability matrix describes the portal's own write model — in live
    // mode that means what THIS deployment's linked planes can accept, not
    // the fixture estate's.
    envelopeFor('configure', {
      stats: liveConfigureStats(
        queued,
        inventory.mode === 'unavailable' ? null : configObjects,
        inventory.detail,
        compliance ? compliance.findings.length : null,
      ),
      ssids: inventory.ssids,
      ports: inventory.ports,
      vlans: inventory.vlans,
      inventoryMode: inventory.mode,
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
  sse: 'HPE Aruba Networking SSE',
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
  if (pull.sse) {
    const kinds = Object.values(pull.sse.kinds);
    const totalObjects = kinds.reduce((sum, k) => sum + (k?.rows.length ?? 0), 0);
    rows.push({ value: String(totalObjects), label: `SSE objects across ${kinds.length} kind${kinds.length === 1 ? '' : 's'}` });
    if (pull.sse.unavailable.length > 0) {
      rows.push({ value: String(pull.sse.unavailable.length), label: 'SSE kinds unavailable (scope or limited release)' });
    }
  }
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
 * Planes whose STORED endpoint credential is the administration surface
 * itself — the host an operator logs into: an AOS-8 mobility master (its own
 * HTTPS UI), a ClearPass publisher, a classic-Central region URL.
 *
 * The other five deliberately publish no console, so "Open console" stays
 * inert for them and says so (SystemRow.consoleUrl's contract) rather than
 * opening a page that is not a console:
 *   central   — stores an API GATEWAY (apigw-…); the console is a different
 *               hostname (app-…) the portal does not hold and must not guess.
 *   mist      — same: api.mist.com is stored, manage.mist.com is the console.
 *   greenlake — stores a workspace UUID, which is not a host at all.
 *   local     — an SSH jump box; the collector has no web console (SYSTEMS
 *               records none for it either).
 *   sse       — stores the Admin API host (admin-api.axissecurity.com); the
 *               operator console is a different hostname the portal does not
 *               hold and must not guess, same reasoning as central/mist.
 */
const CONSOLE_ENDPOINT_PLANES = ['classic', 'aos8', 'clearpass'] as const;
type ConsoleEndpointPlane = (typeof CONSOLE_ENDPOINT_PLANES)[number];

function isConsoleEndpointPlane(id: PlaneId): id is ConsoleEndpointPlane {
  return (CONSOLE_ENDPOINT_PLANES as readonly PlaneId[]).includes(id);
}

/**
 * The console URL for a live plane, read off the credential the operator
 * actually stored (the same key the connect drawer writes, CONNECT_ENDPOINT_KEY
 * — ClearPass's drawer writes `publisher`, so its aliases are accepted too).
 *
 * Only the ORIGIN is served: a stored API path is not a console, and an origin
 * also drops any userinfo a pasted URL carried, so nothing credential-shaped
 * can ride out on this field. Anything that does not parse as a host at all
 * (GreenLake's workspace UUID, a typo) yields undefined — an absent key, which
 * the screen must render as "no console URL recorded".
 */
function planeConsoleUrl(id: PlaneId): string | undefined {
  if (!isConsoleEndpointPlane(id)) return undefined;
  const creds = settings.get().planes[id];
  if (!creds) return undefined;
  const raw = [CONNECT_ENDPOINT_KEY[id], 'publisher', 'baseUrl', 'host']
    .map((key) => creds[key])
    .find((value) => typeof value === 'string' && value.trim() !== '')
    ?.trim();
  if (!raw) return undefined;
  try {
    const parsed = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    return parsed.hostname === '' ? undefined : parsed.origin;
  } catch {
    return undefined;
  }
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
  // The granted scope, crossed with what this plane's adapter says it can
  // carry out — the same helper /api/configure's capability matrix reads.
  const scope = effectiveScope(s, scopeForPlane(id as PlaneKey, { linked: s.linked, scopes: stored?.scopes ?? null }));
  const consoleUrl = planeConsoleUrl(id);
  return {
    name: stored?.displayName ?? SYSTEM_DISPLAY[id]!,
    planeId: id,
    // Only when the portal really holds one — an absent key is what makes
    // "Open console" inert instead of a hand-off it cannot make.
    ...(consoleUrl === undefined ? {} : { consoleUrl }),
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
      // The denominator behind the "Calls today" fact, when the portal knows
      // the plane's tier — an absent budget prints no line rather than a
      // guessed quota (README:316).
      s.callBudget === undefined || s.callBudget === null ? null : `rate_limit: ${s.callBudget}/day`,
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
