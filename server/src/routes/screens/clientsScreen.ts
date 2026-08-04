/**
 * Clients list, MAC detail, and CSV export routes.
 * Extracted from screens.ts so the god-route can shrink without contract drift.
 *
 * Registration order matters:
 *   GET /clients/export  (static)
 *   GET /clients         (list / ?mac=)
 *   GET /clients/:mac    (path form of detail)
 * so Express never treats "export" as a MAC.
 */

import type { Request, Response, Router } from 'express';
import {
  CLIENT_STATS,
  CLIENTS,
  clientPlaneSections,
  demoClient360World,
  deriveRssiDbm,
  detailState,
  formatCount,
  matchServingRadio,
  type ClientDetailLive,
  type ClientRow,
  type ClientWiring,
  type DetailFetchState,
  type ServingRadio,
  type SiteTopologyLive,
  type StatDef,
} from '@hpe/shared';
import { normalizeMac } from '../../planes/clearpass';
import { type ReconciledDeviceRow } from '../../services/reconcile';
import { sendCsv } from '../../lib/csv';
import {
  blendFor,
  envelopeFor,
  reportedValue,
  sourceFor,
  withBlended,
} from './context';
import {
  liveClientDetail,
  liveDeviceDetail,
  liveSiteById,
  liveSiteTopology,
  settle,
} from './detailCache';
import { liveClient360World } from './client360';
import {
  authEventsByMac,
  liveClients,
  liveMerged,
  planesMissingDataset,
} from './liveCore';
import { applyListPaging, sendCachedJson } from './listQuery';
import { queryFlag, queryString } from '../../lib/query';

/** Shared list filter fields for GET /clients and /clients/export. */
export const CLIENT_LIST_FIELDS = [
  'name',
  'mac',
  'type',
  'model',
  'siteName',
  'group',
  'attach',
  'where',
  'os',
  'user',
  'plane',
  'ip',
] as const;

/**
 * Clients list filters (list + export):
 *   `?q=` substring across CLIENT_LIST_FIELDS
 *   `?plane=` case-insensitive plane label (also sources[].row.plane / sources[].plane)
 *   `?medium=` wired|wireless exact
 *   `?type=` exact client type
 *   `?site=` exact siteName (case-insensitive)
 *   `?group=` exact group (case-insensitive)
 *   `?health=` exact health word (case-insensitive; e.g. good / weak signal / unverified)
 *   `?problems=1|true|yes|on` → problem rows only
 *   `?problems=0|false|no|off` → clean rows only (Loop 149)
 * Unknown / empty values are no-ops (never invent an empty roster).
 */
export function applyClientListFilters(
  req: Request,
  body: Record<string, unknown>,
): Record<string, unknown> {
  const list = body.clients;
  if (!Array.isArray(list)) return body;

  const q = queryString(req, 'q').toLowerCase();
  const plane = queryString(req, 'plane').toLowerCase();
  const medium = queryString(req, 'medium').toLowerCase();
  const type = queryString(req, 'type').toLowerCase();
  const site = queryString(req, 'site').toLowerCase();
  const group = queryString(req, 'group').toLowerCase();
  const health = queryString(req, 'health').toLowerCase();
  const problemsFlag = queryFlag(req, 'problems');

  if (!q && !plane && !medium && !type && !site && !group && !health && problemsFlag === null) {
    return body;
  }

  const filtered = (list as Record<string, unknown>[]).filter((row) => {
    if (problemsFlag === true && !row.problem) return false;
    if (problemsFlag === false && row.problem) return false;
    if (medium && String(row.medium ?? '').toLowerCase() !== medium) return false;
    if (type && String(row.type ?? '').toLowerCase() !== type) return false;
    if (site && String(row.siteName ?? row.site ?? '').toLowerCase() !== site) return false;
    if (group && String(row.group ?? '').toLowerCase() !== group) return false;
    if (health && String(row.health ?? '').toLowerCase() !== health) return false;
    if (plane) {
      const p = String(row.plane ?? '').toLowerCase();
      const sourcePlanes: string[] = [];
      if (Array.isArray(row.sources)) {
        for (const s of row.sources as unknown[]) {
          if (!s || typeof s !== 'object') continue;
          const obs = s as { plane?: unknown; row?: { plane?: unknown } };
          if (typeof obs.plane === 'string') sourcePlanes.push(obs.plane.toLowerCase());
          if (obs.row && typeof obs.row.plane === 'string') {
            sourcePlanes.push(obs.row.plane.toLowerCase());
          }
        }
      }
      if (p !== plane && !sourcePlanes.includes(plane)) return false;
    }
    if (q) {
      const hay = CLIENT_LIST_FIELDS.map((f) => String(row[f] ?? '')).join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  return { ...body, clients: filtered };
}

function clientsListRows(): ClientRow[] {
  if (sourceFor('clients') === 'demo') {
    if (blendFor('clients')) {
      const blendClients = liveClients();
      if (blendClients.length > 0) return blendClients;
    }
    return CLIENTS;
  }
  return liveClients();
}

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
 *
 * `clientPlanes` is the Client 360 block: every registry plane's view of this
 * one MAC, correlated from rows the poller ALREADY pulled (sessions,
 * ClearPass auth events + endpoint repository, Mist site SLE). It issues no
 * per-plane call of its own — a JOIN, not a fan-out — so it is attached even
 * when the named MAC is not on the roster: "left the network, but ClearPass
 * accepted it ten minutes ago" is exactly the answer a drawer open is for.
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
  return {
    client,
    detail: withClientJoins(detail, client, ap, served, topology),
    topology,
    clientPlanes: clientPlaneSections(wanted, client?.siteId ?? null, liveClient360World()),
  };
}

/**
 * The clients screen, plus — when the request names ONE client — that client's
 * on-demand detail.
 *
 * The MAC arrives either as `?mac=` (the same param the drawer already keeps in
 * the screen URL) or as a path segment, and both land here so the detail read
 * has exactly one implementation.
 */
async function serveClients(req: Request, res: Response, macParam: string | null): Promise<void> {
  const wanted = macParam && macParam.trim() !== '' ? normalizeMac(macParam) : null;
  const pick = (rows: ClientRow[]): ClientRow | null =>
    wanted === null ? null : rows.find((c) => normalizeMac(c.mac) === wanted) ?? null;

  const respond = (body: Record<string, unknown>): void => {
    // Filter/page the roster only for list responses. A MAC detail request
    // keeps the full clients[] so stats and pick stay honest for that session.
    if (wanted !== null) {
      res.json(body);
      return;
    }
    const filtered = applyClientListFilters(req, body);
    const paged = applyListPaging(req, filtered, 'clients');
    if ('error' in paged) {
      res.status(400).json({ error: paged.error, code: 'PAGINATION_VALIDATION' });
      return;
    }
    sendCachedJson(req, res, paged.body);
  };

  if (sourceFor('clients') === 'demo') {
    if (blendFor('clients')) {
      const blended: string[] = [];
      const blendClients = liveClients();
      if (blendClients.length > 0) {
        blended.push('clients');
        respond(
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
    // nothing — the per-object detail read stays off in demo, exactly as it
    // always was. The Client 360 block is different: it is a JOIN over the
    // fixtures themselves (no plane call — the fixtures ARE the estate), so a
    // named client gets it in demo too, and the drawer demonstrates fully.
    respond(
      envelopeFor('clients', {
        stats: CLIENT_STATS,
        clients: CLIENTS,
        ...(wanted === null
          ? {}
          : {
              client: pick(CLIENTS),
              clientPlanes: clientPlaneSections(
                wanted,
                pick(CLIENTS)?.siteId ?? null,
                demoClient360World(),
              ),
            }),
      }),
    );
    return;
  }
  const clients = liveClients();
  respond(
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

export function registerClientsRoutes(router: Router): void {
  /**
   * GET /api/clients/export — CSV of client sessions
   * (optional q/plane/medium/type/site/group/problems).
   * Registered before /clients/:mac so "export" is not treated as a MAC.
   */
  router.get('/clients/export', (req, res) => {
    const clients = clientsListRows();
    const filtered = applyClientListFilters(req, { clients });
    const rows = (filtered.clients as ClientRow[]) ?? [];
    sendCsv(
      res,
      'clients-sessions.csv',
      [
        'client',
        'mac',
        'type',
        'model',
        'site',
        'group',
        'attached',
        'where',
        'plane',
        'auth',
        'authBy',
        'role',
        'vlan',
        'health',
        'session',
      ],
      rows.map((c) => [
        c.name,
        c.mac,
        c.type,
        c.model,
        c.siteName,
        c.group,
        c.attach,
        c.where,
        c.plane,
        c.auth,
        c.authBy,
        c.role,
        c.vlan,
        c.health,
        c.session,
      ]),
    );
  });

  router.get('/clients', (req, res) => {
    settle(res, serveClients(req, res, typeof req.query.mac === 'string' ? req.query.mac : null));
  });

  /**
   * Same handler as `/clients?mac=` — a caller that prefers the path form gets
   * the identical envelope rather than a second, drifting implementation.
   *
   * A MAC that is not in the roster is NOT a 404 here (unlike /devices/:name and
   * /sites/:siteId, which are whole pages). The response is still the clients
   * screen, with `client: null` — which is the honest answer to "show me this
   * session": the roster is current and this MAC is not on it.
   *
   * Registered after /clients/export so "export" is never captured as a MAC.
   */
  router.get('/clients/:mac', (req, res) => {
    settle(res, serveClients(req, res, req.params.mac));
  });
}
