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
  DEVICE_CLIENT_SETS,
  DEVICE_CONFIGS,
  DEVICE_RECONCILIATION,
  DEVICES,
  FINDINGS,
  LANE_META,
  LICENSE_STATS,
  MAX_NOTE_CHARS,
  OVERVIEW_ALERTS,
  OVERVIEW_CHANGES,
  OVERVIEW_LAUNCHPAD,
  OVERVIEW_PLANES,
  OVERVIEW_SITES,
  OVERVIEW_STATS,
  PERMISSIONS,
  POLICY_SERVICES,
  RENEWALS,
  SEARCH_INDEX,
  SITE_PROFILES,
  SITE_STATS,
  SITES,
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
  isRealSiteId,
  matchServingRadio,
  scopeForPlane,
  siteIdFor,
  terminalBanner,
  terminalQuickCommands,
  toSiteAlertRow,
  toSiteDeviceRow,
  ORPHANS,
  type AlertRow,
  type CapabilityRow,
  type ClientDetailLive,
  type ClientRow,
  type ClientWiring,
  type DetailFetchState,
  type DeviceEvidence,
  type DeviceRow,
  type Plane,
  type PlaneKey,
  type SearchIndexEntry,
  type ScreenSection,
  type ServingRadio,
  type SiteAlertRow,
  type SiteDeviceRow,
  type SiteId,
  type SiteProfile,
  type SiteReachability,
  type SiteRow,
  type SiteTopologyLive,
  type StatDef,
  formatCount,
  countOf,
} from '@hpe/shared';
import { settings } from '../config/settings';
import { poller } from '../services/poller';
import { ticketStore } from '../services/tickets';
import { resolveDeviceIdentity, safeDeviceCandidates, type DeviceIdentity } from '../services/deviceIdentity';
import { registry } from '../planes/registry';
import { PLANE_LABEL, type ReconciledDeviceRow } from '../services/reconcile';
import {
  PLANE_IDS,
} from '../planes/types';
import { normalizeMac } from '../planes/clearpass';

import {
  liveAuthStats,
  liveFailReasons,
  livePolicyServices,
} from './screens/authEventsModel';
import {
  liveComplianceData,
} from './screens/complianceModel';
import {
  demoConfigureQueue,
  demoConfigureStats,
  liveConfigureInventory,
  liveConfigureQueue,
  liveConfigureStats,
} from './screens/configureModel';
import {
  DataSource,
  blendFor,
  blendSection,
  dataSource,
  datasetReported,
  envelope,
  envelopeFor,
  isSiteId,
  reportedValue,
  sourceFor,
  syncedAt,
  withBlended,
} from './screens/context';
import {
  liveClientDetail,
  liveDeviceDetail,
  liveSiteById,
  liveSiteTopology,
  settle,
} from './screens/detailCache';
import {
  canOpenShell,
  liveDeviceClients,
  liveDeviceEvidence,
  liveTerminalPayload,
} from './screens/deviceAccess';
import {
  liveAssignments,
  liveLicenseStats,
  liveOrphans,
  liveRenewals,
} from './screens/licenseModel';
import {
  LiveAuthEvent,
  LiveSubscription,
  authEventsByMac,
  liveAlerts,
  liveClients,
  liveCorrelation,
  liveDeviceData,
  planesMissingDataset,
  planesMissingDevices,
  liveMerged,
  liveSiteStats,
  sortLiveAlerts,
} from './screens/liveCore';
import {
  HEALTH_TONE,
  liveLaneMeta,
  liveLaunchpad,
  liveOverviewChanges,
  liveOverviewPlanes,
  liveOverviewSite,
  liveOverviewStats,
  needsYouNowAlerts,
  relSync,
} from './screens/overviewModel';
import {
  SYSTEM_DISPLAY,
  liveSyncHistory,
  liveSystemRows,
  effectiveScope,
} from './screens/systemsModel';

// Re-exported: resetDetailCache belongs to the detail cache, but tests reach
// for it through this module because that is the router they mount.
export { resetDetailCache } from './screens/detailCache';

export const screensRouter = Router();













// -- Live-mode merge -----------------------------------------------------------
// Reconciled across planes per the design rules: one row per physical device
// (rule 2), stale planes surface as 'unverified' state (rule 1), sites keep
// every claiming plane's badge. Demo mode never touches any of this.











































// -- Live overview ---------------------------------------------------------------
// Stats, planes and the change log are computed from the registry + reconciled
// cache; the launchpad is portal navigation structure, honest in both modes.














// -- Live licences / auth events ---------------------------------------------
// GreenLake subscriptions and ClearPass auth events arrive with optional
// metric hints (expiry instant, numeric quantities, event timestamp) that the
// display rows themselves flatten away. The computed stats below use the
// hints when present and degrade honestly when they are not — the keys of
// every payload stay identical to the demo fixtures' shapes.




















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
      const liveChanges = liveOverviewChanges();
      res.json(
        withBlended(
          envelopeFor('overview', {
            workspace: settings.get().workspaceName,
            stats,
            alerts: blendSection('alerts', needsYouNowAlerts(live.alerts), OVERVIEW_ALERTS, blended),
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
  const liveChanges = liveOverviewChanges();
  res.json(
    envelopeFor('overview', {
      workspace: settings.get().workspaceName,
      stats: liveOverviewStats(live),
      alerts: needsYouNowAlerts(live.alerts),
      sites: live.sites.map(liveOverviewSite),
      planes: liveOverviewPlanes(),
      changes: liveChanges.changes,
      // A blank change log is a fact until the record cannot be read; then it
      // is a failure wearing the same panel.
      changesUnreadable: liveChanges.unreadable,
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
      // Same gate as the correlation: the authored rows are complete by
      // construction, so naming an unread plane against them would be a
      // warning about a queue those planes were never asked to fill.
      const swapped = blended.includes('alerts');
      res.json(
        withBlended(
          envelopeFor('alerts', {
            alerts,
            ...(correlation === undefined ? {} : { correlation }),
            ...(swapped ? { missingSources: planesMissingDataset('alerts') } : {}),
          }),
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
  res.json(
    envelopeFor('alerts', {
      alerts,
      correlation: liveCorrelation(alerts),
      // A queue missing a plane's alerts is not a quiet estate. Without this
      // an unread plane and a plane with nothing open look the same, and the
      // empty state reads as all-clear (see liveCore.ts planesMissingDataset).
      missingSources: planesMissingDataset('alerts'),
    }),
  );
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
  if (text.length > MAX_NOTE_CHARS) {
    res.status(400).json({
      error:
        `note is ${text.length} characters — the limit is ${MAX_NOTE_CHARS}. ` +
        'Nothing was logged; shorten it and send again, or attach the detail to the change record. ' +
        'The portal refuses an over-length note rather than filing a truncated one.',
    });
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
 *
 * Every matching link is walked, not just the first, and every port at the
 * switch end is carried, not just `[0]`. Both plurals are real: TopologyLink's
 * own type says "a LAG has several", and an AP can be drawn with more than one
 * uplink. This row exists so somebody can walk to a switch and act on a port,
 * and both singular readings turn that action into a no-op — shutting one
 * member of a bundle drops nothing, and shutting the only uplink you were told
 * about drops nothing when there is a second.
 */
function wiringForAp(
  topology: SiteTopologyLive | null,
  ap: ReconciledDeviceRow,
): ClientWiring | null {
  const links = topology?.links;
  if (!links || links.length === 0) return null;
  const serial = ap.serial!;
  const nodes = new Map((topology?.nodes ?? []).map((node) => [node.serial, node]));
  let described: ClientWiring | null = null;
  let uplinks = 0;
  for (const link of links) {
    const apIsFrom = link.from === serial;
    if (!apIsFrom && link.to !== serial) continue;
    const far = nodes.get(apIsFrom ? link.to : link.from);
    if (!far || !/switch/i.test(far.type)) continue;
    // Counted before the port check: a link whose switch-end port the plane did
    // not name is still a cable. Dropping it here would let the count agree
    // with the description by leaving out what it cannot describe.
    uplinks += 1;
    if (described) continue;
    const farPorts = (apIsFrom ? link.toPorts : link.fromPorts) ?? [];
    const names = [...new Set(farPorts.map((p) => p.name).filter((n) => reportedValue(n)))];
    if (names.length === 0) continue;
    const lag = farPorts.find((p) => reportedValue(p.lag))?.lag;
    described = {
      apName: ap.name,
      apSerial: serial,
      switchName: far.name,
      switchSerial: far.serial,
      port: names[0]!,
      ...(names.length > 1 ? { ports: names } : {}),
      ...(reportedValue(lag) ? { lag } : {}),
      speedBps: link.speedBps,
      linkHealth: link.health,
      linkHealthReason: link.healthReason,
    };
  }
  if (!described) return null;
  return uplinks > 1 ? { ...described, otherUplinks: uplinks - 1 } : described;
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
              missingSources: planesMissingDataset('clients'),
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
      // Which linked planes contributed no session list. A roster short by a
      // plane's whole estate must not read as "these are the sessions".
      missingSources: planesMissingDataset('clients'),
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
    { label: 'Clients now', value: formatCount(clients.length), delta: 'from live poll', tone: 'neutral' },
    { label: 'Wireless', value: formatCount(wireless), delta: `${pct}% of sessions`, tone: 'neutral' },
    { label: 'Wired', value: formatCount(wired), delta: 'from live poll', tone: 'neutral' },
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
        const missing = planesMissingDevices();
        res.json(
          withBlended(
            envelopeFor('sites', {
              stats: liveSiteStats(live.sites, live.devices, live.clients, live.alerts, missing),
              sites: live.sites,
              missingSources: missing,
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
  // Sites are derived from the merged inventory, so a plane that contributed
  // no devices contributes no sites either — its locations are absent from
  // the table entirely rather than shown empty. Without this the screen
  // reports a count for a smaller estate than the operator is asking about.
  const missing = planesMissingDevices();
  res.json(
    envelopeFor('sites', {
      stats: liveSiteStats(live.sites, live.devices, live.clients, live.alerts, missing),
      sites: live.sites,
      missingSources: missing,
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
            envelopeFor('devices', {
              devices,
              lanes: liveLaneMeta(),
              reconciliation: { doubleClaimed, unclaimed },
              missingInventories: planesMissingDevices(),
            }),
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
  res.json(
    envelopeFor('devices', {
      devices,
      lanes: liveLaneMeta(),
      reconciliation: { doubleClaimed, unclaimed },
      // Which linked planes are NOT represented in the list above. Without
      // this the reconciled inventory is shorter than the estate and says
      // nothing about why (see liveCore.ts planesMissingDevices).
      missingInventories: planesMissingDevices(),
    }),
  );
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
              orphans: liveOrphans(blendDevices, subs, blendAssignments, planesMissingDevices()),
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
      orphans: liveOrphans(devices, subs, assignments, planesMissingDevices()),
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
      linked,
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
      const blendDriftMissing = planesMissingDevices();
      const blendCompliance = datasetReported('devices')
        ? liveComplianceData(liveDeviceData().devices, blendDriftMissing)
        : null;
      res.json(
        withBlended(
          envelopeFor('configure', {
            stats: liveConfigureStats(
              blendQueue,
              inventory.ssids.length + inventory.ports.length + inventory.vlans.length,
              inventory.detail,
              blendCompliance ? blendCompliance.findings.length : null,
              blendDriftMissing,
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
  const driftMissing = planesMissingDevices();
  const compliance = datasetReported('devices')
    ? liveComplianceData(liveDeviceData().devices, driftMissing)
    : null;
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
        driftMissing,
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
      const blendMissing = planesMissingDataset('devices');
      const blendCompliance = liveComplianceData(liveDeviceData().devices, blendMissing);
      res.json(
        withBlended(
          envelopeFor('compliance', {
            ...blendCompliance,
            missingInventories: blendMissing,
            evidenceMode: 'coverage',
          }),
          ['compliance'],
          'compliance',
        ),
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
  // datasetReported is true as soon as ONE plane answers. Naming the planes
  // that did not keeps a coverage run over a fraction of the estate from
  // reading as a verdict on all of it.
  const missingInventories = planesMissingDataset('devices');
  const compliance = devicesReported
    ? liveComplianceData(liveDeviceData().devices, missingInventories)
    : { stats: [], findings: [], baselines: [], diff: '' };
  res.json(
    envelopeFor('compliance', {
      ...compliance,
      missingInventories,
      evidenceMode: devicesReported ? 'coverage' : 'unavailable',
    }),
  );
});

// -- Connected systems (screen view model; live state is /api/systems/state) --














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
