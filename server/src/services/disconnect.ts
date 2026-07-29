/**
 * server/src/services/disconnect.ts — ticket-gated client disconnect (CoA-style).
 *
 * Same broker rules as every write (README §"Integration model" rule 3): NO
 * standing write access — a ticket reference is required and the action is
 * recorded in the append-only change log it shares with the write broker.
 * Like a reboot it is an immediate action: no lease, no snapshot.
 *
 * Push paths (verified against pycentral's v2 troubleshooting module):
 *   POST /network-troubleshooting/v1/aps/{serial}/disconnectUserByMacAddress
 *     body {userMacAddress}        — wireless clients on an AP
 *   POST /network-troubleshooting/v1/gateways/{serial}/disconnectClientByMacAddress
 *     body {clientMacAddress}      — clients on a gateway
 *   success = HTTP 202 Accepted.
 * Wired clients behind a switch have no troubleshooting-API disconnect; they
 * get an honest hand-off (a ClearPass CoA is that plane's write).
 *
 * The client is resolved to its attachment device (client.attach) which must
 * have a serial on record. Demo mode validates and audit-logs only — and says
 * plainly that nothing left the portal.
 */

import { CentralAdapter } from '../planes/central';
import { normalizeMac } from '../planes/clearpass';
import { settings } from '../config/settings';
import { PlaneRegistry, registry as defaultRegistry } from '../planes/registry';
import { appendBrokerLog, brokerDataDir, type BrokerTransport } from './writeBroker';
import { knownTicketId } from './tickets';
import { poller } from './poller';
import { CLIENTS } from '../../../shared';
import type { Plane } from '../../../shared';
import { resolveDeviceIdentity, safeDeviceCandidates } from './deviceIdentity';

export interface DisconnectClient {
  mac: string;
  name: string;
  attach: string; // device name the client is associated with
  plane: string; // display label, e.g. 'CENTRAL'
}

export interface DisconnectDevice {
  name: string;
  type: string;
  plane: Plane | string;
  serial?: string;
  claimedBy?: Plane[];
}

export interface DisconnectResult {
  ok: boolean;
  applied: boolean; // true ONLY on a 202 from the troubleshooting API
  mac: string;
  ticket: string;
  httpCode?: number;
  message: string;
}

/** Errors that map straight onto HTTP statuses in the routes layer. */
export class DisconnectError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'DisconnectError';
  }
}

export interface DisconnectServiceOptions {
  registry?: PlaneRegistry; // default: the process-wide singleton
  transport?: BrokerTransport | null; // undefined → resolve the CentralAdapter from the registry
  demoMode?: () => boolean; // default: settings store
  lookupClient?: (mac: string) => DisconnectClient | null; // default: fixtures (demo) / poller cache (live)
  listDevices?: () => DisconnectDevice[];
  /** @deprecated Test compatibility. Cannot represent duplicate names. */
  lookupDevice?: (name: string) => Omit<DisconnectDevice, 'name'> | null;
  knownTicket?: (id: string) => boolean; // default: the ticket store (+ fixture ids in demo mode)
  dataDir?: string; // default: HPE_DATA_DIR or <repo>/data
  nowMs?: () => number; // injected clock for tests
}

function requireMac(raw: unknown): string {
  const mac = typeof raw === 'string' ? raw.trim() : '';
  if (!mac) throw new DisconnectError(400, 'client MAC is required');
  return mac;
}

function requireTicket(raw: unknown): string {
  const ticket = typeof raw === 'string' ? raw.trim() : '';
  if (!ticket) throw new DisconnectError(400, 'ticket reference required — writes are brokered, never standing');
  return ticket;
}

/** Default client lookup: fixtures in demo mode, the poller cache in live mode. */
function defaultLookupClient(mac: string): DisconnectClient | null {
  // Compare on the 12-hex normal form — planes report MACs in any separator/case.
  const norm = normalizeMac(mac);
  if (settings.get().demoMode) {
    const c = CLIENTS.find((x) => normalizeMac(x.mac) === norm);
    return c ? { mac: c.mac, name: c.name, attach: c.attach, plane: c.plane } : null;
  }
  const c = poller.getCache().clients.find((x) => normalizeMac(x.mac) === norm);
  return c ? { mac: c.mac, name: c.name, attach: c.attach, plane: c.plane } : null;
}

/** Default device lookup (poller cache; demo mode never reaches it). */
function defaultDevices(): DisconnectDevice[] {
  return poller.getCache().devices.map((device) => ({
    name: device.name,
    type: device.type,
    plane: device.plane,
    ...(device.serial ? { serial: device.serial } : {}),
    ...(device.claimedBy ? { claimedBy: device.claimedBy } : {}),
  }));
}

export class DisconnectService {
  private readonly registry: PlaneRegistry;
  private readonly transportOverride: BrokerTransport | null | undefined;
  private readonly demoMode: () => boolean;
  private readonly lookupClient: (mac: string) => DisconnectClient | null;
  private readonly listDevices: (name: string) => DisconnectDevice[];
  private readonly knownTicket: (id: string) => boolean;
  private readonly dataDir: string;
  private readonly nowMs: () => number;

  constructor(opts: DisconnectServiceOptions = {}) {
    this.registry = opts.registry ?? defaultRegistry;
    this.transportOverride = opts.transport;
    this.demoMode = opts.demoMode ?? (() => settings.get().demoMode);
    this.lookupClient = opts.lookupClient ?? defaultLookupClient;
    this.listDevices = opts.listDevices
      ? () => opts.listDevices!()
      : opts.lookupDevice
        ? (name) => {
            const device = opts.lookupDevice!(name);
            return device ? [{ name, ...device }] : [];
          }
        : () => defaultDevices();
    this.knownTicket = opts.knownTicket ?? ((id) => knownTicketId(id, this.demoMode()));
    this.dataDir = opts.dataDir ?? brokerDataDir();
    this.nowMs = opts.nowMs ?? (() => Date.now());
  }

  /**
   * Validate → gate → push. Throws DisconnectError for request/gating
   * problems (400/404/409); a plane answer that is not 202 comes back as an
   * honest {ok:false} result at HTTP 200, mirroring the write broker's push.
   */
  async disconnect(macRaw: unknown, ticketRaw: unknown): Promise<DisconnectResult> {
    const mac = requireMac(macRaw);
    const ticket = requireTicket(ticketRaw);
    if (!this.knownTicket(ticket)) {
      throw new DisconnectError(400, `unknown ticket '${ticket}' — writes reference a raised ticket (demo mode also accepts the fixture queue)`);
    }
    const client = this.lookupClient(mac);
    if (!client) throw new DisconnectError(404, `client '${mac}' not found in the session inventory`);
    const base = { mac: client.mac, ticket };

    if (this.demoMode()) {
      this.log(client.mac, ticket, 'validated — demo mode, nothing sent');
      return {
        ...base,
        ok: true,
        applied: false,
        message: 'demo mode — disconnect validated and audit-logged; nothing was sent to a plane',
      };
    }

    if (client.plane !== 'CENTRAL') {
      throw new DisconnectError(
        409,
        `disconnect via the troubleshooting API is Central-managed clients only — ${client.name} is on ${client.plane}; use that plane's console (a ClearPass CoA is the ClearPass write)`,
      );
    }

    const resolution = resolveDeviceIdentity(this.listDevices(client.attach), client.attach, {});
    if (resolution.ambiguous) {
      const candidates = safeDeviceCandidates(resolution.ambiguous);
      throw new DisconnectError(
        409,
        `attachment '${client.attach}' names ${resolution.ambiguous.length} devices — disconnect refused; candidates ${candidates
          .map((candidate) => `${candidate.plane}/${candidate.serial ?? 'no-serial'}`)
          .join(', ')}`,
        { candidates },
      );
    }
    const device = resolution.device;
    if (!device) {
      throw new DisconnectError(409, `attachment device '${client.attach}' is not in the device cache — wait for the next poll`);
    }
    if (!device.serial) {
      throw new DisconnectError(409, `no serial on record for '${client.attach}' — cannot address the troubleshooting API`);
    }

    let path: string;
    let body: Record<string, string>;
    if (device.type === 'ap') {
      path = `/network-troubleshooting/v1/aps/${encodeURIComponent(device.serial)}/disconnectUserByMacAddress`;
      body = { userMacAddress: client.mac };
    } else if (device.type === 'gateway') {
      path = `/network-troubleshooting/v1/gateways/${encodeURIComponent(device.serial)}/disconnectClientByMacAddress`;
      body = { clientMacAddress: client.mac };
    } else {
      throw new DisconnectError(
        409,
        `'${client.attach}' is a ${device.type} — the troubleshooting API disconnects clients on APs and gateways only; a wired client takes a ClearPass CoA`,
      );
    }

    const transport = this.centralTransport();
    if (!transport) {
      throw new DisconnectError(409, 'central is not linked — connect it under Systems and retry');
    }

    let res: { status: number; body: unknown };
    try {
      res = await transport.request('POST', path, body);
    } catch (err) {
      this.log(client.mac, ticket, 'network-error', undefined, device);
      return {
        ...base,
        ok: false,
        applied: false,
        message: `disconnect request failed — ${(err as Error).message}`,
      };
    }

    if (res.status === 202) {
      this.log(client.mac, ticket, 'disconnect-initiated', res.status, device);
      return {
        ...base,
        ok: true,
        applied: true,
        httpCode: res.status,
        message: `disconnect accepted by Central (HTTP 202) — ${client.name} will reauthenticate on rejoin`,
      };
    }
    this.log(client.mac, ticket, 'rejected', res.status, device);
    return {
      ...base,
      ok: false,
      applied: false,
      httpCode: res.status,
      message: `Central answered HTTP ${res.status} for ${path} — disconnect not initiated`,
    };
  }

  /** The Central adapter as a push transport; null when Central can't write. */
  private centralTransport(): BrokerTransport | null {
    if (this.transportOverride !== undefined) return this.transportOverride;
    const adapter = this.registry.get('central');
    return adapter instanceof CentralAdapter ? adapter : null;
  }

  private log(
    mac: string,
    ticket: string,
    result: string,
    httpCode?: number,
    device?: DisconnectDevice,
  ): void {
    appendBrokerLog(this.dataDir, {
      ts: new Date(this.nowMs()).toISOString(),
      event: 'disconnect',
      changeId: `disconnect-${mac}`,
      ticket,
      kind: 'client',
      result,
      ...(device
        ? { device: device.name, plane: device.plane, serial: device.serial ?? null }
        : {}),
      ...(httpCode !== undefined ? { httpCode } : {}),
    });
  }
}

/** Process-wide singleton. */
export const disconnectService = new DisconnectService();
