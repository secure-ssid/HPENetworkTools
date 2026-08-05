/** Configure screen: observed inventory, queued changes and their stats. */

import { type PlanePull } from '../../planes/types';
import { PLANE_LABEL } from '../../services/reconcile';
import { poller } from '../../services/poller';
import { writeBroker } from '../../services/writeBroker';
import {
  datasetReported,
  displayParts,
  reportedValue,
} from './context';
import {
  dedupeClients,
  liveClients,
  liveDeviceData,
} from './liveCore';
import {
  CONFIGURE_STATS,
  QUEUED_CHANGES,
  type ClientRow,
  type PortObject,
  type QueuedChangeRow,
  type SsidObject,
  type StatDef,
  type Tone,
  type VlanObject,
  localDayKey,
  countOf,
} from '@hpe/shared';

export interface ObservedConfigureInventory {
  ssids: SsidObject[];
  ports: PortObject[];
  vlans: VlanObject[];
}

export function portDeviceIdentities(ports: readonly PortObject[]): PortObject[] {
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

export function observedConfigureInventory(clients: ClientRow[]): ObservedConfigureInventory {
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
      targets: `${countOf(rows.length, 'active client')} · ${countOf(sites, 'site')}`,
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
      desc: countOf(rows.length, 'active client'),
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
      ...(planes.length === 1 ? { plane: planes[0] } : {}),
      id: first.vlan.replace(/^vlan\s+/i, ''),
      name: 'Observed active VLAN',
      detail: `${countOf(rows.length, 'active client')} · ${planes.join(' + ')}`,
      role: roles.length > 0 ? roles.join(', ') : 'Role not reported',
    };
  });

  return { ssids, ports, vlans };
}

export interface LiveConfigureInventory extends ObservedConfigureInventory {
  mode: 'configured' | 'observed' | 'unavailable';
  detail: string;
}

/** Merge configuration reads per section. A configured section wins even when
 * it is empty; sections no plane could read retain the observed-session
 * fallback instead of hiding useful live evidence. */
export function liveConfigureInventory(): LiveConfigureInventory {
  const observedAvailable = datasetReported('clients');
  const observed = observedConfigureInventory(liveClients());
  const configs = [...poller.contributionsByPlane().entries()]
    .map(([plane, pull]) => ({ plane, config: pull.config }))
    .filter(
      (entry): entry is { plane: keyof typeof PLANE_LABEL; config: NonNullable<PlanePull['config']> } =>
        entry.config !== undefined,
    );

  const ssidsReported = configs.some(({ config }) => config.ssids !== undefined);
  const portsReported = configs.some(({ config }) => config.ports !== undefined);
  const vlansReported = configs.some(({ config }) => config.vlans !== undefined);
  const configured = ssidsReported || portsReported || vlansReported;

  const dedupe = <T>(rows: T[], key: (row: T) => string): T[] =>
    [...new Map(rows.map((row) => [key(row), row])).values()];
  const configuredSsids = dedupe(
    configs.flatMap(({ config }) => config.ssids ?? []),
    (row) => `${row.plane}|${row.name}`.toLowerCase(),
  );
  const configuredPorts = dedupe(
    configs.flatMap(({ config }) => config.ports ?? []),
    (row) => `${row.device}|${row.port}`.toLowerCase(),
  );
  const configuredVlans = dedupe(
    configs.flatMap(({ plane, config }) =>
      (config.vlans ?? []).map((row) => ({ ...row, plane: PLANE_LABEL[plane] })),
    ),
    (row) => `${row.plane}|${row.id}`.toLowerCase(),
  );

  const sections = [
    ssidsReported ? 'configured SSIDs' : observedAvailable ? 'observed SSIDs' : null,
    portsReported ? 'configured ports' : observedAvailable ? 'observed ports' : null,
    vlansReported ? 'configured VLANs' : observedAvailable ? 'observed VLANs' : null,
  ].filter((section): section is string => section !== null);
  const sources = [
    ...new Set(configs.map(({ config }) => config.source).filter((source): source is string => !!source)),
  ];

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

export const QUEUE_TONE: Record<QueuedChangeRow['state'], Tone> = {
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
export function liveConfigureQueue(): QueuedChangeRow[] {
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
export function demoConfigureQueue(): QueuedChangeRow[] {
  const brokered = liveConfigureQueue();
  const tickets = new Set(brokered.map((change) => change.ticket));
  return [...brokered, ...QUEUED_CHANGES.filter((change) => !tickets.has(change.ticket))];
}

/**
 * Today's pushes from the broker audit log, split by what actually became of
 * them. The Configure tile used to count only `applied` and report nothing
 * else, so a day on which every push was rejected read exactly like a day on
 * which nobody pushed at all — "0 · from the broker audit log".
 *
 * The three buckets stay separate on purpose. `applied` is the only one that
 * means the change is on the device. `accepted` is a 202: the plane took the
 * request and has not confirmed it, which the broker records distinctly and
 * this must not spend by rounding it into either neighbour. Everything else
 * (rejected, network-error, lease-expired, unverified-path) is work the
 * operator attempted and did not get.
 *
 * Read through readRecentEvents rather than recentEvents, per that method's
 * own instruction: a rotated generation that cannot be opened makes the log
 * come back short, and a count taken over a short log is a smaller number
 * reported with full confidence. `unreadable` carries that out to the tile
 * so it can decline to be certain.
 *
 * `truncated` is the second way this count goes short, and the likelier one.
 * The read takes the newest EVENTS_READ of every kind — queue, discard, push
 * — and only then keeps today's pushes, so a day busy enough to fill the
 * window loses its earliest pushes to it. Newest-first means the ones that
 * fall off are the start of the day, which is precisely the stretch an
 * operator counting today's work would not notice missing. It rides out
 * beside `unreadable` because the tile's answer is the same either way: this
 * is a floor, not a total.
 *
 * But the broker's own `truncated` answers a different question than this
 * tile asks. It means "older broker events exist beyond the window", which
 * becomes permanently true the day the log passes EVENTS_READ entries and
 * stays true forever after. Forwarded as-is, the tile hung "count may be
 * short" on every exact count it would ever produce — a caveat that is
 * always on says nothing, and the operator stops reading it before the day
 * it is finally true.
 *
 * The window is read newest-first, so its last row is the furthest back it
 * reached. If that row predates today, the read spans the whole of today and
 * no push from today can be behind the cap: the count is exact and earns no
 * caveat. Only when the window itself ends inside today can a push have been
 * cut off. Same rule the reader below it already keeps — claim a gap on
 * evidence of a gap, never on a read that merely ended at its limit.
 */
const EVENTS_READ = 1000;

export function pushOutcomesToday(): {
  applied: number;
  accepted: number;
  unknown: number;
  failed: number;
  total: number;
  unreadable: number;
  truncated: boolean;
} {
  // The operator's day, not Greenwich's. A UTC slice compared against a UTC
  // stamp looks self-consistent and is: it is just consistently about the
  // wrong day. Seven hours west, this tile emptied itself at 17:00 local and
  // reported the afternoon's pushes as none at all — while the call counter
  // beside it, which has always rolled at local midnight, still showed the
  // day's work. Two counters, one portal, two midnights.
  const today = localDayKey();
  const read = writeBroker.readRecentEvents(EVENTS_READ);
  const pushes = read.events.filter((event) => localDayKey(event.ts) === today && event.event === 'push');
  const oldestRead = read.events[read.events.length - 1];
  const windowEndedInsideToday = oldestRead === undefined || localDayKey(oldestRead.ts) === today;
  const applied = pushes.filter((event) => event.result.startsWith('applied')).length;
  const accepted = pushes.filter((event) => event.result.startsWith('accepted')).length;
  // A push whose transport confirmation was lost is the one outcome the broker
  // refuses to decide: it keeps the change `applying`, warns that a retry needs
  // reconciliation first, and says in as many words that the PUT may have
  // reached Central. Counting it by subtraction made it a failure — the count
  // of things that definitely did not happen, holding one that might have.
  const unknown = pushes.filter((event) => event.result.startsWith('outcome-unknown')).length;
  return {
    applied,
    accepted,
    unknown,
    failed: pushes.length - applied - accepted - unknown,
    total: pushes.length,
    unreadable: read.unreadable.length,
    truncated: read.truncated && windowEndedInsideToday,
  };
}

/**
 * Demo stats: the authored strip, with the two tiles that describe the
 * PORTAL's own state (the queue, and what the broker really pushed today)
 * computed. Config objects and Drift open keep the fixture's values and
 * deltas — they describe the authored inventory demo mode is serving, and
 * re-deriving them printed 'live evidence coverage findings' over fixtures.
 */
export function demoConfigureStats(queue: QueuedChangeRow[]): StatDef[] {
  const computed = liveConfigureStats(queue, null, '', null);
  // Any real push today displaces the authored tile, not just a successful
  // one. Gating on the applied count alone meant a day of nothing but
  // rejections fell back to the fixture's cheerful number, which is the one
  // case where the operator most needs the real one.
  const pushed = pushOutcomesToday().total > 0;
  return [computed[0]!, pushed ? computed[1]! : CONFIGURE_STATS[1]!, CONFIGURE_STATS[2]!, CONFIGURE_STATS[3]!];
}

export function liveConfigureStats(
  queue: QueuedChangeRow[],
  configObjects: number | null,
  configDetail: string,
  driftOpen: number | null,
  driftMissing: readonly string[] = [],
): StatDef[] {
  const ready = queue.filter((change) => change.state === 'ready').length;
  const applying = queue.filter((change) => change.state === 'applying').length;
  const needsWindow = queue.filter((change) => change.state === 'needs window').length;
  const consoleOnly = queue.filter((change) => change.state === 'console').length;
  const {
    applied: pushedToday,
    accepted: acceptedToday,
    unknown: unknownToday,
    failed: failedToday,
    unreadable: unreadableLogs,
    truncated: logTruncated,
  } = pushOutcomesToday();
  const pushDetail =
    [
      failedToday > 0 ? `▲ ${failedToday} failed` : null,
      // Named before the merely-unconfirmed: this one is not waiting on a
      // plane to finish, it is waiting on a person to go and find out.
      unknownToday > 0 ? `${unknownToday} outcome unknown — may have landed, needs reconciliation` : null,
      acceptedToday > 0 ? `${acceptedToday} accepted, unconfirmed` : null,
      unreadableLogs > 0
        ? `${countOf(unreadableLogs, 'log generation')} unreadable — count may be short`
        : null,
      // Said only when the other caveat is absent: both mean "at least this
      // many", and one sentence to that effect is the honest amount. Two is
      // a tile arguing with itself.
      logTruncated && unreadableLogs === 0
        ? `read stopped at the newest ${EVENTS_READ} broker events — count may be short`
        : null,
    ]
      .filter((part): part is string => part !== null)
      .join(' · ') || 'from the broker audit log';
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
    {
      label: 'Pushed today',
      // The headline stays the count of changes that genuinely landed. It is
      // not inflated with attempts, and green is withheld the moment one of
      // them failed — a push that worked does not cancel out one that didn't.
      value: String(pushedToday),
      delta: pushDetail,
      // Green is a claim that today's pushes all landed. A failure withdraws
      // it outright; an acceptance nobody has confirmed withdraws it too,
      // because the change may not be on the device; and a hole in the record
      // withdraws the confidence to make the claim at all.
      // A lost outcome holds the tile at negative alongside a real failure. Not
      // because the push is known to have failed — the whole point is that
      // nobody knows — but because a change is stranded mid-apply and only an
      // operator can settle it. Neutral is for uncertainty that resolves
      // itself; this does not.
      tone:
        failedToday > 0 || unknownToday > 0
          ? 'negative'
          : pushedToday > 0 && acceptedToday === 0 && unreadableLogs === 0 && !logTruncated
            ? 'positive'
            : 'neutral',
    },
    {
      label: 'Config objects',
      value: configObjects === null ? '—' : String(configObjects),
      delta: configDetail,
      tone: 'neutral',
    },
    {
      label: 'Drift open',
      value: driftOpen === null ? '—' : String(driftOpen),
      // Same shortfall the Overview tile names, in the same words: a plane
      // that reported no inventory was never scanned, so a zero here is zero
      // findings over part of the estate.
      delta:
        driftOpen === null
          ? 'no live inventory evidence'
          : driftMissing.length > 0
            ? `${driftMissing.join(', ')} not scanned`
            : 'live evidence coverage findings',
      tone: driftOpen !== null && driftOpen > 0 ? 'negative' : 'neutral',
    },
  ];
}
