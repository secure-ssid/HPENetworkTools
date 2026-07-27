/**
 * server/src/services/ackAlert.ts — ticket-gated alert acknowledgement.
 *
 * Same broker rules as config writes and reboots (README §"Integration
 * model" rule 3): NO standing write access — every acknowledge needs a
 * ticket reference and is recorded in the append-only change log it shares
 * with the write broker. An ack is an immediate action: no 15-minute lease,
 * no rollback snapshot (the pre-ack state is "open").
 *
 * Push path (verified against the Central new notifications API):
 *   POST /network-notifications/v1/alerts/clear
 *   body { keys: [alertId], reason: <ticket>, notes: "acknowledged from the
 *          HPE Network Tools portal; ticket <ticket>" }
 *   success = HTTP 202 Accepted.
 * ONE conservative candidate — a non-202 is reported verbatim, never retried
 * against alternates and never claimed as success.
 *
 * Only Central-sourced alerts carrying the plane's own key (alertId, threaded
 * through by mapCentralNotification) can be addressed this way; everything
 * else gets an honest hand-off (UXI issues close in the UXI dashboard, Mist
 * alarms in the Mist console). Demo mode validates the request and audit-logs
 * it — and says plainly that nothing left the portal.
 */

import { CentralAdapter } from '../planes/central';
import { settings } from '../config/settings';
import { PlaneRegistry, registry as defaultRegistry } from '../planes/registry';
import { appendBrokerLog, brokerDataDir, type BrokerTransport } from './writeBroker';
import { knownTicketId } from './tickets';

export interface AckAlertTarget {
  plane: string; // display label, e.g. 'CENTRAL'
  alertId?: string; // the plane's own alert key
  title?: string; // for the message/readback only
  device?: string;
}

export interface AckAlertResult {
  ok: boolean;
  applied: boolean; // true ONLY on a 202 from the notifications API
  alert: string; // display string (title or key)
  ticket: string;
  httpCode?: number;
  message: string;
}

/** Errors that map straight onto HTTP statuses in the routes layer. */
export class AckAlertError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'AckAlertError';
  }
}

export interface AckAlertServiceOptions {
  registry?: PlaneRegistry; // default: the process-wide singleton
  transport?: BrokerTransport | null; // undefined → resolve the CentralAdapter from the registry
  demoMode?: () => boolean; // default: settings store
  knownTicket?: (id: string) => boolean; // default: the ticket store (+ fixture ids in demo mode)
  dataDir?: string; // default: HPE_DATA_DIR or <repo>/data
  nowMs?: () => number; // injected clock for tests
}

function requireTicket(raw: unknown): string {
  const ticket = typeof raw === 'string' ? raw.trim() : '';
  if (!ticket) throw new AckAlertError(400, 'ticket reference required — writes are brokered, never standing');
  return ticket;
}

function requireTarget(raw: unknown): AckAlertTarget {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new AckAlertError(400, 'alert target required — {plane, alertId} from the alert row');
  }
  const t = raw as Record<string, unknown>;
  const plane = typeof t.plane === 'string' ? t.plane.trim() : '';
  if (!plane) throw new AckAlertError(400, 'alert target requires its plane');
  return {
    plane,
    ...(typeof t.alertId === 'string' && t.alertId.trim() ? { alertId: t.alertId.trim() } : {}),
    ...(typeof t.title === 'string' && t.title.trim() ? { title: t.title.trim() } : {}),
    ...(typeof t.device === 'string' && t.device.trim() ? { device: t.device.trim() } : {}),
  };
}

export class AckAlertService {
  private readonly registry: PlaneRegistry;
  private readonly transportOverride: BrokerTransport | null | undefined;
  private readonly demoMode: () => boolean;
  private readonly knownTicket: (id: string) => boolean;
  private readonly dataDir: string;
  private readonly nowMs: () => number;

  constructor(opts: AckAlertServiceOptions = {}) {
    this.registry = opts.registry ?? defaultRegistry;
    this.transportOverride = opts.transport;
    this.demoMode = opts.demoMode ?? (() => settings.get().demoMode);
    this.knownTicket = opts.knownTicket ?? ((id) => knownTicketId(id, this.demoMode()));
    this.dataDir = opts.dataDir ?? brokerDataDir();
    this.nowMs = opts.nowMs ?? (() => Date.now());
  }

  /**
   * Validate → gate → push. Throws AckAlertError for request/gating problems
   * (400/409); a plane answer that is not 202 comes back as an honest
   * {ok:false} result at HTTP 200, mirroring reboot/disconnect.
   */
  async acknowledge(targetRaw: unknown, ticketRaw: unknown): Promise<AckAlertResult> {
    const ticket = requireTicket(ticketRaw);
    if (!this.knownTicket(ticket)) {
      throw new AckAlertError(400, `unknown ticket '${ticket}' — writes reference a raised ticket (demo mode also accepts the fixture queue)`);
    }
    const target = requireTarget(targetRaw);
    const label = target.title ?? target.alertId ?? 'alert';
    const base = { alert: label, ticket };

    if (this.demoMode()) {
      this.log(target, ticket, 'validated — demo mode, nothing sent');
      return {
        ...base,
        ok: true,
        applied: false,
        message: 'demo mode — acknowledge validated and audit-logged; nothing was sent to a plane',
      };
    }

    if (target.plane !== 'CENTRAL') {
      const handoff =
        target.plane === 'UXI'
          ? 'close it in the UXI dashboard — the sensor API is read-only from here'
          : `acknowledge it in the ${target.plane.toLowerCase()} console — that plane is read-only from here`;
      throw new AckAlertError(409, `acknowledge via the notifications API is Central-sourced alerts only — ${handoff}`);
    }

    if (!target.alertId) {
      throw new AckAlertError(
        409,
        `no plane key on record for '${label}' — the alert predates key threading or came from a row without one; acknowledge it in Central`,
      );
    }

    const transport = this.centralTransport();
    if (!transport) {
      throw new AckAlertError(409, 'central is not linked — connect it under Systems and retry');
    }

    const path = '/network-notifications/v1/alerts/clear';
    let res: { status: number; body: unknown };
    try {
      res = await transport.request('POST', path, {
        keys: [target.alertId],
        reason: ticket,
        notes: `acknowledged from the HPE Network Tools portal; ticket ${ticket}`,
      });
    } catch (err) {
      this.log(target, ticket, 'network-error');
      return { ...base, ok: false, applied: false, message: `acknowledge request failed — ${(err as Error).message}` };
    }

    if (res.status === 202) {
      this.log(target, ticket, 'acknowledged', res.status);
      return {
        ...base,
        ok: true,
        applied: true,
        httpCode: res.status,
        message: `acknowledge accepted by Central (HTTP 202) — ${label}`,
      };
    }
    this.log(target, ticket, 'rejected', res.status);
    return {
      ...base,
      ok: false,
      applied: false,
      httpCode: res.status,
      message: `Central answered HTTP ${res.status} for ${path} — alert not acknowledged`,
    };
  }

  /** The Central adapter as a push transport; null when Central can't write. */
  private centralTransport(): BrokerTransport | null {
    if (this.transportOverride !== undefined) return this.transportOverride;
    const adapter = this.registry.get('central');
    return adapter instanceof CentralAdapter ? adapter : null;
  }

  private log(target: AckAlertTarget, ticket: string, result: string, httpCode?: number): void {
    appendBrokerLog(this.dataDir, {
      ts: new Date(this.nowMs()).toISOString(),
      event: 'alert-ack',
      changeId: `alert-ack-${target.alertId ?? target.title ?? 'unknown'}`,
      ticket,
      kind: 'alert',
      result,
      ...(httpCode !== undefined ? { httpCode } : {}),
    });
  }
}

/** Process-wide singleton. */
export const ackAlertService = new AckAlertService();
