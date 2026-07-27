/**
 * server/src/services/reboot.ts — ticket-gated device reboot.
 *
 * Same broker rules as config writes (README §"Integration model" rule 3):
 * NO standing write access — every reboot needs a ticket reference and is
 * recorded in the append-only change log it shares with the write broker.
 * Unlike a config change a reboot is an immediate action, not a queued
 * change: no 15-minute lease, and no rollback snapshot (there is nothing to
 * roll back — the pre-reboot state is "up").
 *
 * Push path (verified against pycentral's v2 troubleshooting module):
 *   POST /network-troubleshooting/v1/{aos-s|aps|cx|gateways}/{serial}/reboot
 *   success = HTTP 202 Accepted.
 * ONE conservative candidate — a non-202 is reported verbatim, never retried
 * against alternates and never claimed as success.
 *
 * Only Central-managed devices with a serial on record can be addressed this
 * way; everything else gets an honest hand-off (recorded SSH session for the
 * local collector, the Mist console for Mist). Demo mode validates the
 * request and audit-logs it — and says plainly that nothing left the portal.
 */

import { CentralAdapter } from '../planes/central';
import { settings } from '../config/settings';
import { PlaneRegistry, registry as defaultRegistry } from '../planes/registry';
import { appendBrokerLog, brokerDataDir, type BrokerTransport } from './writeBroker';
import { knownTicketId } from './tickets';
import { poller } from './poller';
import { DEVICES } from '../../../shared';

/** The troubleshooting API's device-type vocabulary (pycentral SUPPORTED_DEVICE_TYPES). */
const TROUBLESHOOTING_TYPE: Record<string, string> = {
  ap: 'aps',
  switch: 'cx',
  gateway: 'gateways',
};

export interface RebootDevice {
  name: string;
  type: string; // shared DeviceType vocabulary ('ap' | 'switch' | 'gateway' | …)
  plane: string; // display label, e.g. 'CENTRAL'
  serial?: string;
}

export interface RebootResult {
  ok: boolean;
  applied: boolean; // true ONLY on a 202 from the troubleshooting API
  device: string;
  ticket: string;
  httpCode?: number;
  message: string;
}

/** Errors that map straight onto HTTP statuses in the routes layer. */
export class RebootError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'RebootError';
  }
}

export interface RebootServiceOptions {
  registry?: PlaneRegistry; // default: the process-wide singleton
  transport?: BrokerTransport | null; // undefined → resolve the CentralAdapter from the registry
  demoMode?: () => boolean; // default: settings store
  lookupDevice?: (name: string) => RebootDevice | null; // default: fixtures (demo) / poller cache (live)
  knownTicket?: (id: string) => boolean; // default: the ticket store (+ fixture ids in demo mode)
  dataDir?: string; // default: HPE_DATA_DIR or <repo>/data
  nowMs?: () => number; // injected clock for tests
}

function requireName(raw: unknown): string {
  const name = typeof raw === 'string' ? raw.trim() : '';
  if (!name) throw new RebootError(400, 'device name is required');
  return name;
}

function requireTicket(raw: unknown): string {
  const ticket = typeof raw === 'string' ? raw.trim() : '';
  if (!ticket) throw new RebootError(400, 'ticket reference required — writes are brokered, never standing');
  return ticket;
}

/** Default inventory lookup: fixtures in demo mode, the poller cache in live mode. */
function defaultLookup(name: string): RebootDevice | null {
  if (settings.get().demoMode) {
    const d = DEVICES.find((x) => x.name === name);
    return d ? { name: d.name, type: d.type, plane: d.plane } : null;
  }
  const d = poller.getCache().devices.find((x) => x.name === name) as RebootDevice | undefined;
  return d ? { name: d.name, type: d.type, plane: d.plane, ...(d.serial ? { serial: d.serial } : {}) } : null;
}

export class RebootService {
  private readonly registry: PlaneRegistry;
  private readonly transportOverride: BrokerTransport | null | undefined;
  private readonly demoMode: () => boolean;
  private readonly lookupDevice: (name: string) => RebootDevice | null;
  private readonly knownTicket: (id: string) => boolean;
  private readonly dataDir: string;
  private readonly nowMs: () => number;

  constructor(opts: RebootServiceOptions = {}) {
    this.registry = opts.registry ?? defaultRegistry;
    this.transportOverride = opts.transport;
    this.demoMode = opts.demoMode ?? (() => settings.get().demoMode);
    this.lookupDevice = opts.lookupDevice ?? defaultLookup;
    this.knownTicket = opts.knownTicket ?? ((id) => knownTicketId(id, this.demoMode()));
    this.dataDir = opts.dataDir ?? brokerDataDir();
    this.nowMs = opts.nowMs ?? (() => Date.now());
  }

  /**
   * Validate → gate → push. Throws RebootError for request/gating problems
   * (400/404/409); a plane answer that is not 202 comes back as an honest
   * {ok:false} result at HTTP 200, mirroring the write broker's push.
   */
  async reboot(nameRaw: unknown, ticketRaw: unknown): Promise<RebootResult> {
    const name = requireName(nameRaw);
    const ticket = requireTicket(ticketRaw);
    if (!this.knownTicket(ticket)) {
      throw new RebootError(400, `unknown ticket '${ticket}' — writes reference a raised ticket (demo mode also accepts the fixture queue)`);
    }
    const device = this.lookupDevice(name);
    if (!device) throw new RebootError(404, `device '${name}' not found in inventory`);
    const base = { device: name, ticket };

    if (this.demoMode()) {
      this.log(name, ticket, 'validated — demo mode, nothing sent');
      return {
        ...base,
        ok: true,
        applied: false,
        message: 'demo mode — reboot validated and audit-logged; nothing was sent to a plane',
      };
    }

    if (device.plane !== 'CENTRAL') {
      const handoff =
        device.plane === 'LOCAL'
          ? 'reboot it from the recorded SSH session on this page (reload), so the session log stays the audit trail'
          : `reboot it from the ${device.plane.toLowerCase()} console — that plane is read-only from here`;
      throw new RebootError(409, `reboot via the troubleshooting API is Central-managed devices only — ${handoff}`);
    }

    const tbType = TROUBLESHOOTING_TYPE[device.type];
    if (!tbType) {
      throw new RebootError(409, `device type '${device.type}' is not rebootable through the troubleshooting API (aps | cx | gateways only)`);
    }
    if (!device.serial) {
      throw new RebootError(409, `no serial on record for '${name}' — cannot address the troubleshooting API`);
    }

    const transport = this.centralTransport();
    if (!transport) {
      throw new RebootError(409, 'central is not linked — connect it under Systems and retry');
    }

    const path = `/network-troubleshooting/v1/${tbType}/${encodeURIComponent(device.serial)}/reboot`;
    let res: { status: number; body: unknown };
    try {
      res = await transport.request('POST', path);
    } catch (err) {
      this.log(name, ticket, 'network-error');
      return {
        ...base,
        ok: false,
        applied: false,
        message: `reboot request failed — ${(err as Error).message}`,
      };
    }

    if (res.status === 202) {
      this.log(name, ticket, 'reboot-initiated', res.status);
      return {
        ...base,
        ok: true,
        applied: true,
        httpCode: res.status,
        message: `reboot accepted by Central (HTTP 202) — ${name} will drop and rejoin`,
      };
    }
    this.log(name, ticket, 'rejected', res.status);
    return {
      ...base,
      ok: false,
      applied: false,
      httpCode: res.status,
      message: `Central answered HTTP ${res.status} for ${path} — reboot not initiated`,
    };
  }

  /** The Central adapter as a push transport; null when Central can't write. */
  private centralTransport(): BrokerTransport | null {
    if (this.transportOverride !== undefined) return this.transportOverride;
    const adapter = this.registry.get('central');
    return adapter instanceof CentralAdapter ? adapter : null;
  }

  private log(device: string, ticket: string, result: string, httpCode?: number): void {
    appendBrokerLog(this.dataDir, {
      ts: new Date(this.nowMs()).toISOString(),
      event: 'reboot',
      changeId: `reboot-${device}`,
      ticket,
      kind: 'reboot',
      result,
      ...(httpCode !== undefined ? { httpCode } : {}),
    });
  }
}

/** Process-wide singleton. */
export const rebootService = new RebootService();
