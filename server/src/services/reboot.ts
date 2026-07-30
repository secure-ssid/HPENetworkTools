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
import { DEVICES } from '@hpe/shared';
import type { Plane } from '@hpe/shared';
import {
  resolveDeviceIdentity,
  safeDeviceCandidates,
  type DeviceIdentity,
} from './deviceIdentity';

/** The troubleshooting API's device-type vocabulary (pycentral SUPPORTED_DEVICE_TYPES). */
const TROUBLESHOOTING_TYPE: Record<string, string> = {
  ap: 'aps',
  switch: 'cx',
  gateway: 'gateways',
};

export interface RebootDevice {
  name: string;
  type: string; // shared DeviceType vocabulary ('ap' | 'switch' | 'gateway' | …)
  plane: Plane | string; // display label, e.g. 'CENTRAL'
  serial?: string;
  claimedBy?: Plane[];
}

export interface RebootResult {
  ok: boolean;
  applied: boolean; // true ONLY on a 202 from the troubleshooting API
  device: string;
  plane: string;
  serial: string | null;
  ticket: string;
  httpCode?: number;
  message: string;
}

/** Errors that map straight onto HTTP statuses in the routes layer. */
export class RebootError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'RebootError';
  }
}

export interface RebootServiceOptions {
  registry?: PlaneRegistry; // default: the process-wide singleton
  transport?: BrokerTransport | null; // undefined → resolve the CentralAdapter from the registry
  demoMode?: () => boolean; // default: settings store
  listDevices?: () => RebootDevice[];
  /** @deprecated Test compatibility. Cannot represent duplicate names. */
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
function defaultDevices(): RebootDevice[] {
  if (settings.get().demoMode) {
    return DEVICES.map((device) => ({
      name: device.name,
      type: device.type,
      plane: device.plane,
      ...(device.serial ? { serial: device.serial } : {}),
      ...(device.claimedBy ? { claimedBy: device.claimedBy } : {}),
    }));
  }
  return poller.getCache().devices.map((device) => ({
    name: device.name,
    type: device.type,
    plane: device.plane,
    ...(device.serial ? { serial: device.serial } : {}),
    ...(device.claimedBy ? { claimedBy: device.claimedBy } : {}),
  }));
}

export class RebootService {
  private readonly registry: PlaneRegistry;
  private readonly transportOverride: BrokerTransport | null | undefined;
  private readonly demoMode: () => boolean;
  private readonly listDevices: (name: string) => RebootDevice[];
  private readonly knownTicket: (id: string) => boolean;
  private readonly dataDir: string;
  private readonly nowMs: () => number;

  constructor(opts: RebootServiceOptions = {}) {
    this.registry = opts.registry ?? defaultRegistry;
    this.transportOverride = opts.transport;
    this.demoMode = opts.demoMode ?? (() => settings.get().demoMode);
    this.listDevices = opts.listDevices
      ? () => opts.listDevices!()
      : opts.lookupDevice
        ? (name) => {
            const device = opts.lookupDevice!(name);
            return device ? [device] : [];
          }
        : () => defaultDevices();
    this.knownTicket = opts.knownTicket ?? ((id) => knownTicketId(id, this.demoMode()));
    this.dataDir = opts.dataDir ?? brokerDataDir();
    this.nowMs = opts.nowMs ?? (() => Date.now());
  }

  /**
   * Validate → gate → push. Throws RebootError for request/gating problems
   * (400/404/409); a plane answer that is not 202 comes back as an honest
   * {ok:false} result at HTTP 200, mirroring the write broker's push.
   */
  async reboot(
    nameRaw: unknown,
    ticketRaw: unknown,
    identity: DeviceIdentity = {},
  ): Promise<RebootResult> {
    const name = requireName(nameRaw);
    const ticket = requireTicket(ticketRaw);
    if (!this.knownTicket(ticket)) {
      throw new RebootError(400, `unknown ticket '${ticket}' — writes reference a raised ticket (demo mode also accepts the fixture queue)`);
    }
    const hasPlane = typeof identity.plane === 'string' && identity.plane.trim().length > 0;
    const hasSerial = typeof identity.serial === 'string' && identity.serial.trim().length > 0;
    if (hasPlane !== hasSerial) {
      throw new RebootError(400, 'plane and serial must be supplied together');
    }
    const resolution = resolveDeviceIdentity(this.listDevices(name), name, identity, {
      requireCompleteIdentity: true,
      requireNameMatch: true,
    });
    if (resolution.invalid) throw new RebootError(409, resolution.invalid);
    if (resolution.ambiguous) {
      throw new RebootError(
        409,
        `'${name}' names ${resolution.ambiguous.length} devices — pass plane and serial to pick one`,
        { candidates: safeDeviceCandidates(resolution.ambiguous) },
      );
    }
    const device = resolution.device;
    if (!device) throw new RebootError(404, `device '${name}' not found in inventory`);
    const base = {
      device: device.name,
      plane: device.plane,
      serial: device.serial ?? null,
      ticket,
    };

    if (this.demoMode()) {
      this.log(device, ticket, 'validated — demo mode, nothing sent');
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
      this.log(device, ticket, 'network-error');
      return {
        ...base,
        ok: false,
        applied: false,
        message: `reboot request failed — ${(err as Error).message}`,
      };
    }

    if (res.status === 202) {
      this.log(device, ticket, 'reboot-initiated', res.status);
      return {
        ...base,
        ok: true,
        applied: true,
        httpCode: res.status,
        message: `reboot accepted by Central (HTTP 202) — ${name} will drop and rejoin`,
      };
    }
    this.log(device, ticket, 'rejected', res.status);
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

  private log(device: RebootDevice, ticket: string, result: string, httpCode?: number): void {
    appendBrokerLog(this.dataDir, {
      ts: new Date(this.nowMs()).toISOString(),
      event: 'reboot',
      changeId: `reboot-${device.serial ?? device.name}`,
      ticket,
      kind: 'reboot',
      result,
      device: device.name,
      plane: device.plane,
      serial: device.serial ?? null,
      ...(httpCode !== undefined ? { httpCode } : {}),
    });
  }
}

/** Process-wide singleton. */
export const rebootService = new RebootService();
