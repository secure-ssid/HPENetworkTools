/** Configure screen: observed inventory, queued changes and their stats. */

import { type PlanePull } from '../../planes/types';
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
 * Demo stats: the authored strip, with the two tiles that describe the
 * PORTAL's own state (the queue, and what the broker really pushed today)
 * computed. Config objects and Drift open keep the fixture's values and
 * deltas — they describe the authored inventory demo mode is serving, and
 * re-deriving them printed 'live evidence coverage findings' over fixtures.
 */
export function demoConfigureStats(queue: QueuedChangeRow[]): StatDef[] {
  const computed = liveConfigureStats(queue, null, '', null);
  const pushedToday = Number(computed[1]!.value);
  return [computed[0]!, pushedToday > 0 ? computed[1]! : CONFIGURE_STATS[1]!, CONFIGURE_STATS[2]!, CONFIGURE_STATS[3]!];
}

export function liveConfigureStats(
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
