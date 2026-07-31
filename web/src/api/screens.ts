/** Per-screen read endpoints: the view models each screen renders. */

import {
  DEMO_SYNCED_AT,
  ScreenEnvelope,
  apiFailure,
  dropUnreadableBlocks,
  fetchDetail,
  fetchScreen,
  readDetail,
} from './core';
import {
  ALERTS,
  AUTH_EVENTS,
  AUTH_FAIL_REASONS,
  AUTH_STATS,
  BASELINE_PROGRESS,
  CAPABILITY_MATRIX,
  CLIENTS,
  CLIENT_STATS,
  COMPLIANCE_DIFF,
  COMPLIANCE_STATS,
  CONFIGURE_STATS,
  CONFIG_PORTS,
  DEVICES,
  DEVICE_CLIENT_SETS,
  DEVICE_CONFIGS,
  DEVICE_RECONCILIATION,
  FINDINGS,
  LANE_META,
  LICENSE_STATS,
  ORPHANS,
  OVERVIEW_ALERTS,
  OVERVIEW_CHANGES,
  OVERVIEW_LAUNCHPAD,
  OVERVIEW_PLANES,
  OVERVIEW_SITES,
  OVERVIEW_STATS,
  POLICY_SERVICES,
  QUEUED_CHANGES,
  RENEWALS,
  SEARCH_INDEX,
  SITES,
  SITE_IDS,
  SITE_PROFILES,
  SITE_STATS,
  SSIDS,
  SUBSCRIPTIONS,
  TICKETS,
  VLANS,
  deriveSiteProfile,
  deviceProfile,
  isRealSiteId,
  siteIdFor,
  terminalBanner,
  terminalQuickCommands,
  type AlertCorrelation,
  type AlertRow,
  type AuthEventRow,
  type BaselineProgressRow,
  type CapabilityRow,
  type ChangeLogEntry,
  type ClientDetailLive,
  type ClientRow,
  type DeviceCfg,
  type DeviceCheckRow,
  type DeviceClientSet,
  type DeviceDetailLive,
  type DeviceEvidence,
  type DeviceProfile,
  type DeviceRow,
  type FailReasonRow,
  type FindingRow,
  type LaneMeta,
  type LaunchpadRow,
  type OrphanRow,
  type OverviewAlert,
  type OverviewPlaneRow,
  type OverviewSiteRow,
  type Plane,
  type PolicyServiceRow,
  type PortObject,
  type QueuedChangeRow,
  type RenewalRow,
  type SearchIndexEntry,
  type SiteAlertRow,
  type SiteDeviceRow,
  type SiteId,
  type SiteProfile,
  type SiteReachability,
  type SiteRow,
  type SiteTopologyLive,
  type SsidObject,
  type StatDef,
  type SubscriptionRow,
  type TerminalLine,
  type TicketRow,
  type VlanObject,
} from '@hpe/shared';

export interface OverviewData extends ScreenEnvelope {
  stats: StatDef[];
  alerts: OverviewAlert[];
  sites: OverviewSiteRow[];
  planes: OverviewPlaneRow[];
  changes: ChangeLogEntry[];
  launchpad: LaunchpadRow[];
  syncedAt: string | null; // null in live mode before the first successful poll
  workspace?: string;
}

export interface AlertsData extends ScreenEnvelope {
  alerts: AlertRow[];
  syncedAt: string | null;
  /** The danger/warning banner over the queue, when the ROUTE correlates it —
   *  the server can cross the worst finding with plane freshness, which a
   *  client-side correlate() over already-pulled rows cannot see. Absent (or
   *  null) = no server correlation was sent and the screen's own correlate()
   *  stays the single source; `tone` absent inside it keeps the renderer's
   *  existing 'danger' default. */
  correlation?: AlertCorrelation | null;
}

export interface TicketsData extends ScreenEnvelope {
  tickets: TicketRow[];
}

export interface ClientsData extends ScreenEnvelope {
  stats: StatDef[];
  clients: ClientRow[];
  /** The three keys below appear ONLY when the request named one client
   *  (`/api/clients?mac=…`) — the route does no per-object read for a plain
   *  list poll, which is what keeps the 60s tick off the tenant's call budget.
   *  `null` on any of them is the route's honest "no plane could answer". */
  client?: ClientRow | null;
  detail?: ClientDetailLive | null;
  topology?: SiteTopologyLive | null;
}

export interface AuthEventsData extends ScreenEnvelope {
  stats: StatDef[];
  events: AuthEventRow[];
  failReasons: FailReasonRow[];
  policyServices: PolicyServiceRow[];
}

export interface SitesData extends ScreenEnvelope {
  stats: StatDef[];
  sites: SiteRow[];
}

export interface SiteDetailData extends ScreenEnvelope {
  site: SiteRow | null; // null = the API does not know this site at all (404)
  profile: SiteProfile | null; // null = live/blend row only — no authored profile exists
  /** README §7's two per-site sections, sent alongside a null profile in
   *  live/blend mode. In demo mode they live inside `profile` instead. */
  devices?: SiteDeviceRow[];
  alerts?: SiteAlertRow[];
  /** README §7's "Local reachability" panel in live/blend mode, where there is
   *  no authored profile to read it from: the route derives it from the local
   *  collector plane's registry state plus the LOCAL-claimed share of this
   *  site's devices. `reachValue: null` means the portal does not know the
   *  answering share — render '—', never 0%. Absent = the route sent nothing
   *  and the panel keeps its honest NOT REPORTED state. In demo mode the same
   *  four values live on `profile` instead. */
  reachability?: SiteReachability;
  /** The claiming plane's LINK topology for this site — the device graph and
   *  the port-to-port links behind it — read ON THE DETAIL REQUEST PATH for
   *  this one site, never on the 60s poll. See the three-state rule below:
   *  absent envelope = the route attached nothing, absent `nodes`/`links` =
   *  that section was not fetched, present-and-empty = the plane answered with
   *  no graph. This client never fills either in. */
  topology?: SiteTopologyLive;
}

export interface DevicesData extends ScreenEnvelope {
  devices: DeviceRow[];
  lanes: Partial<Record<Plane, LaneMeta>>;
  reconciliation?: { doubleClaimed: number; unclaimed: number };
  /** Linked planes with no device inventory in `devices` — the list is short
   *  by however much they manage. Absent means the route did not say (an
   *  older server, or demo fixtures); an empty array means it looked and every
   *  linked plane reported. The two are deliberately distinguishable. */
  missingInventories?: Plane[];
  /** Demo mode only: fixture names the operator hid, for the restore affordance. */
  hiddenDevices?: string[];
}

export interface DeviceDetailData extends ScreenEnvelope {
  device: DeviceRow | null; // null = live mode, device not in the poller cache
  profile: DeviceProfile | null; // null in live mode — the authored profile is demo data
  config: DeviceCfg | null;
  clients: DeviceClientSet | null;
  /** Shell banner + quick-command chips as the ROUTE computes them. The demo
   *  branch (and this client's offline demo fallback) sends it; the screen may prefer it over
   *  re-deriving the pair from the fixture profile, so the server stays the
   *  authority once the live branch serves a platform-correct command set.
   *  Absent = no payload sent; fall back to the shared helpers. */
  terminal?: { banner: TerminalLine[]; quickCommands: string[] };
  /** Per-device evidence for the Compliance panel. `mode` is what keeps an
   *  EMPTY list from reading as "everything passes": 'unavailable' means no
   *  plane supplied evidence and the panel must say so. Absent = the route
   *  sent nothing at all; in demo mode the authored `profile.checks` is the
   *  source instead. Normalized by getDeviceDetail(), so the screen only ever
   *  sees this one shape. */
  evidence?: DeviceEvidence;
  /** Per-device live subresources — radios + WLANs for an AP, ports for a
   *  switch — read ON THE DETAIL REQUEST PATH for this one device, never on
   *  the 60s poll. Same three states as `SiteDetailData.topology`: absent
   *  envelope = the route attached nothing, absent array = that section was
   *  not fetched (an AP is not asked for ports), present-and-empty = the plane
   *  answered with nothing. Consult `detail.source.sections` before writing
   *  any "nothing here" sentence. */
  detail?: DeviceDetailLive;
  /** The site graph this device sits in, when the route attaches one — it is
   *  what names the far end of an uplink. Same three states as `detail`. */
  topology?: SiteTopologyLive;
}

export interface LicensesData extends ScreenEnvelope {
  stats: StatDef[];
  subscriptions: SubscriptionRow[];
  renewals: RenewalRow[];
  orphans: OrphanRow[];
}

export interface ConfigureData extends ScreenEnvelope {
  stats: StatDef[];
  ssids: SsidObject[];
  ports: PortObject[];
  vlans: VlanObject[];
  inventoryMode: 'configured' | 'observed' | 'unavailable';
  queued: QueuedChangeRow[];
  capabilities: CapabilityRow[];
}

export interface ComplianceData extends ScreenEnvelope {
  stats: StatDef[];
  findings: FindingRow[];
  baselines: BaselineProgressRow[];
  diff: string;
  evidenceMode: 'baseline' | 'coverage' | 'unavailable';
}

export interface SearchIndexData extends ScreenEnvelope {
  entries: SearchIndexEntry[];
}

// ---------------------------------------------------------------------------
// Screen endpoints
// ---------------------------------------------------------------------------

export async function getOverview(): Promise<OverviewData> {
  const result = await fetchScreen<OverviewData>('/api/overview');
  if (result.kind === 'ok') return result.data;
  if (result.kind === 'http-error') {
    return apiFailure<OverviewData>(result.message, {
      stats: [],
      alerts: [],
      sites: [],
      planes: [],
      changes: [],
      launchpad: [],
    });
  }
  return {
    stats: OVERVIEW_STATS,
    alerts: OVERVIEW_ALERTS,
    sites: OVERVIEW_SITES,
    planes: OVERVIEW_PLANES,
    changes: OVERVIEW_CHANGES,
    launchpad: OVERVIEW_LAUNCHPAD,
    syncedAt: DEMO_SYNCED_AT,
    dataSource: 'demo',
  };
}

export async function getAlerts(): Promise<AlertsData> {
  const result = await fetchScreen<AlertsData>('/api/alerts');
  if (result.kind === 'ok') return result.data;
  if (result.kind === 'http-error') return apiFailure<AlertsData>(result.message, { alerts: [] });
  return { alerts: ALERTS, syncedAt: DEMO_SYNCED_AT, dataSource: 'demo' };
}

export async function getTickets(): Promise<TicketsData> {
  const result = await fetchScreen<TicketsData>('/api/tickets');
  if (result.kind === 'ok') return result.data;
  if (result.kind === 'http-error') return apiFailure<TicketsData>(result.message, { tickets: [] });
  return { tickets: TICKETS, dataSource: 'demo' };
}

/**
 * The clients screen. Pass `mac` ONLY from a drawer open, never from the poll:
 * naming a client makes the route issue that client's per-object detail read,
 * and doing that on a 60s timer across a whole list is what the tenant's daily
 * call budget cannot survive.
 */
export async function getClients(mac?: string): Promise<ClientsData> {
  const result = await fetchScreen<ClientsData>(
    mac ? `/api/clients?mac=${encodeURIComponent(mac)}` : '/api/clients',
  );
  if (result.kind === 'ok') return dropUnreadableBlocks(result.data, 'detail', 'topology');
  if (result.kind === 'http-error') {
    return apiFailure<ClientsData>(result.message, { stats: [], clients: [] });
  }
  return { stats: CLIENT_STATS, clients: CLIENTS, dataSource: 'demo' };
}

/**
 * The client's own detail — signal, throughput, roam count, session timeline —
 * for the ONE client whose drawer is open.
 *
 * It rides `/api/clients?mac=`: the route does the per-object read only when a
 * request names a client, so the plain list poll stays exactly as cheap as it
 * was. Never call this from the polling loop.
 */
export async function getClientDetail(mac: string): Promise<ClientDetailLive | null> {
  return readDetail<ClientDetailLive>(`/api/clients?mac=${encodeURIComponent(mac)}`, 'detail');
}

/**
 * The plane's link topology for one site — the device graph and the
 * port-to-port links behind it, which is what makes a client's wiring and
 * path-to-the-internet rows real rather than guessed.
 *
 * It rides `/api/sites/:siteId`, where the route already attaches it, and the
 * server caches the read, so opening several drawers in one site costs one
 * call rather than one per drawer.
 */
export async function getSiteTopology(siteId: string): Promise<SiteTopologyLive | null> {
  return readDetail<SiteTopologyLive>(`/api/sites/${encodeURIComponent(siteId)}`, 'topology');
}

export async function getAuthEvents(): Promise<AuthEventsData> {
  const result = await fetchScreen<AuthEventsData>('/api/auth-events');
  if (result.kind === 'ok') return result.data;
  if (result.kind === 'http-error') {
    return apiFailure<AuthEventsData>(result.message, {
      stats: [],
      events: [],
      failReasons: [],
      policyServices: [],
    });
  }
  return {
    stats: AUTH_STATS,
    events: AUTH_EVENTS,
    failReasons: AUTH_FAIL_REASONS,
    policyServices: POLICY_SERVICES,
    dataSource: 'demo',
  };
}

export async function getSites(): Promise<SitesData> {
  const result = await fetchScreen<SitesData>('/api/sites');
  if (result.kind === 'ok') return result.data;
  if (result.kind === 'http-error') return apiFailure<SitesData>(result.message, { stats: [], sites: [] });
  return { stats: SITE_STATS, sites: SITES, dataSource: 'demo' };
}

export async function getSiteDetail(param: string): Promise<SiteDetailData> {
  const r = await fetchDetail<SiteDetailData>(
    `/api/sites/${encodeURIComponent(param)}`,
  );
  if (r.kind === 'ok') return dropUnreadableBlocks(r.data, 'topology');
  if (r.kind === 'answered') {
    if (r.status !== 404) {
      return apiFailure<SiteDetailData>(r.message, { site: null, profile: null });
    }
    // The backend answered (unknown site, or live/blend mode with the site
    // not in the live inventory) — an honest not-found, never the authored
    // local-only fallback profile.
    return {
      site: null,
      profile: null,
      dataSource: r.dataSource ?? 'live',
      ...(r.blended ? { blended: r.blended } : {}),
    };
  }
  // Backend absent: mirror the server's own demo branch (screens.ts:1493-1507)
  // rather than the prototype's fallback(). 'core-services', 'workspace' and
  // 'multiple' are bookkeeping ids that alert/device rows file under — they
  // have no inventory row, so a page for them would be a fabricated site. And
  // a real site with no authored profile gets one derived from the portal's
  // OWN inventory row, never Warehouse-DC1's authored numbers.
  const id = (SITE_IDS as readonly string[]).includes(param) ? (param as SiteId) : siteIdFor(param);
  if (!id || !isRealSiteId(id)) return { site: null, profile: null, dataSource: 'demo' };
  return {
    site: SITES.find((s) => s.id === id) ?? null,
    profile: SITE_PROFILES[id] ?? deriveSiteProfile(id),
    dataSource: 'demo',
  };
}

export async function getDevices(): Promise<DevicesData> {
  const result = await fetchScreen<DevicesData>('/api/devices');
  if (result.kind === 'ok') return result.data;
  if (result.kind === 'http-error') return apiFailure<DevicesData>(result.message, { devices: [], lanes: {} });
  // Offline demo: carry the authored estate truth in the envelope so the
  // reconciliation banner reads from the payload rather than the screen
  // re-importing the fixture on its own.
  return {
    devices: DEVICES,
    lanes: LANE_META,
    reconciliation: DEVICE_RECONCILIATION,
    dataSource: 'demo',
  };
}

/**
 * The device-detail evidence block, normalized to one shape.
 *
 * The route may serve the four per-device checks either as the full
 * `evidence: DeviceEvidence` block or as a bare `checks: DeviceCheckRow[]`.
 * Collapsing both here means the screen has a single contract to render and
 * never has to guess what an empty list means: a bare list that came back
 * empty is 'unavailable' (no plane supplied evidence), NOT a clean scorecard.
 */
export function normalizeEvidence(data: DeviceDetailData & { checks?: DeviceCheckRow[] }): DeviceDetailData {
  const { checks, ...rest } = data;
  if (rest.evidence || !checks) return rest;
  return {
    ...rest,
    evidence: {
      checks,
      mode: checks.length === 0 ? 'unavailable' : rest.dataSource === 'demo' ? 'demo' : 'live',
      ...(checks.length === 0 ? { note: 'No plane reported evidence for this device.' } : {}),
    },
  };
}

/** Identity carried alongside `name` on GET /api/devices/:name — the same
 *  plane+serial pair the server needs to pick one row when reconciliation has
 *  left two rows sharing a display name (see server/src/routes/screens.ts
 *  resolveDeviceIdentity). Both optional: search hits and other screens'
 *  name-only fields still work as long as the name stays unique. */
export interface DeviceDetailIdentity {
  plane?: string;
  serial?: string;
}

export async function getDeviceDetail(
  name: string,
  identity: DeviceDetailIdentity = {},
): Promise<DeviceDetailData> {
  const params = new URLSearchParams();
  if (identity.plane) params.set('plane', identity.plane);
  if (identity.serial) params.set('serial', identity.serial);
  const qs = params.toString();
  const r = await fetchDetail<DeviceDetailData & { checks?: DeviceCheckRow[] }>(
    `/api/devices/${encodeURIComponent(name)}${qs ? `?${qs}` : ''}`,
  );
  if (r.kind === 'ok') return dropUnreadableBlocks(normalizeEvidence(r.data), 'detail', 'topology');
  if (r.kind === 'answered') {
    if (r.status !== 404) {
      return apiFailure<DeviceDetailData>(r.message, {
        device: null,
        profile: null,
        config: null,
        clients: null,
      });
    }
    // The backend answered (live mode, device not in the poller cache) — an
    // honest not-found, never the authored fixture profile.
    return {
      device: null,
      profile: null,
      config: null,
      clients: null,
      dataSource: r.dataSource ?? 'live',
      ...(r.blended ? { blended: r.blended } : {}),
    };
  }
  // Offline demo fallback: the authored fixtures never carry a duplicate
  // name, but resolve by serial first anyway so this path matches the
  // server's own identity order rather than a name-only shortcut.
  const device =
    (identity.serial ? DEVICES.find((row) => row.serial === identity.serial) : undefined) ??
    DEVICES.find((row) => row.name === name) ??
    null;
  if (!device) {
    return { device: null, profile: null, config: null, clients: null, dataSource: 'demo' };
  }
  const profile = deviceProfile(device.name);
  return {
    device,
    profile,
    // Mirror the server's own demo branch (screens.ts `terminal:` block) rather
    // than a thinner offline shape: with no backend the screen must still get
    // the same envelope it gets from the demo route, or the terminal panel
    // silently changes behaviour depending on whether the server is running.
    terminal: {
      banner: terminalBanner(profile.kind),
      quickCommands: terminalQuickCommands(profile.kind),
    },
    // Same reason, for the Compliance panel: the authored profile's checks ARE
    // the demo evidence, so serve them under the one `evidence` key both modes
    // read. Without this the offline demo page would be the only place with a
    // profile but no evidence block, and a screen that reads `evidence`
    // uniformly would lose the panel exactly when there is no backend to blame.
    evidence: { checks: profile.checks, mode: 'demo' },
    config: DEVICE_CONFIGS[profile.kind],
    clients: DEVICE_CLIENT_SETS[profile.kind],
    dataSource: 'demo',
  };
}

export async function getLicenses(): Promise<LicensesData> {
  const result = await fetchScreen<LicensesData>('/api/licenses');
  if (result.kind === 'ok') return result.data;
  if (result.kind === 'http-error') {
    return apiFailure<LicensesData>(result.message, {
      stats: [],
      subscriptions: [],
      renewals: [],
      orphans: [],
    });
  }
  return {
    stats: LICENSE_STATS,
    subscriptions: SUBSCRIPTIONS,
    renewals: RENEWALS,
    orphans: ORPHANS,
    dataSource: 'demo',
  };
}

export async function getConfigure(): Promise<ConfigureData> {
  const result = await fetchScreen<ConfigureData>('/api/configure');
  if (result.kind === 'ok') return result.data;
  if (result.kind === 'http-error') {
    return apiFailure<ConfigureData>(result.message, {
      stats: [],
      ssids: [],
      ports: [],
      vlans: [],
      inventoryMode: 'unavailable',
      queued: [],
      capabilities: [],
    });
  }
  return {
    stats: CONFIGURE_STATS,
    ssids: SSIDS,
    ports: CONFIG_PORTS,
    vlans: VLANS,
    inventoryMode: 'configured',
    queued: QUEUED_CHANGES,
    capabilities: CAPABILITY_MATRIX,
    dataSource: 'demo',
  };
}

export async function getCompliance(): Promise<ComplianceData> {
  const result = await fetchScreen<ComplianceData>('/api/compliance');
  if (result.kind === 'ok') return result.data;
  if (result.kind === 'http-error') {
    return apiFailure<ComplianceData>(result.message, {
      stats: [],
      findings: [],
      baselines: [],
      diff: '',
      evidenceMode: 'unavailable',
    });
  }
  return {
    stats: COMPLIANCE_STATS,
    findings: FINDINGS,
    baselines: BASELINE_PROGRESS,
    diff: COMPLIANCE_DIFF,
    evidenceMode: 'baseline',
    dataSource: 'demo',
  };
}

export async function getSearchIndex(): Promise<SearchIndexData> {
  const result = await fetchScreen<SearchIndexData>('/api/search-index');
  if (result.kind === 'ok') return result.data;
  if (result.kind === 'http-error') return apiFailure<SearchIndexData>(result.message, { entries: [] });
  return { entries: SEARCH_INDEX, dataSource: 'demo' };
}
