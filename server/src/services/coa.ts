/**
 * server/src/services/coa.ts — ticket-gated endpoint block via ClearPass CoA.
 *
 * Same broker rules as every write (README §"Integration model" rule 3): NO
 * standing write access — a ticket reference is required and the action is
 * recorded in the append-only change log it shares with the write broker.
 * Like a disconnect it is an immediate action: no lease, no snapshot.
 *
 * Push path (verified against the CPPM SessionAction API, 6.8.7+):
 *   POST /api/session-action/disconnect/mac/{mac}
 * ClearPass looks the MAC up in its active sessions and issues the CoA
 * Disconnect-Request to the NAD that owns the session — which is exactly why
 * this plane carries the block for wired clients (the Central troubleshooting
 * API cannot reach behind a switch) and for any client ClearPass brokers auth
 * for, whatever its inventory plane. A MAC with no active session comes back
 * as a ClearPass error and is reported verbatim — the portal never claims a
 * block the NAD did not confirm.
 *
 * Success = any 2xx from the session-action endpoint (CPPM versions differ on
 * 200 vs 202); the exact code is always reported. Demo mode validates and
 * audit-logs only — and says plainly that nothing left the portal.
 */

import { ClearPassAdapter, normalizeMac } from '../planes/clearpass';
import { settings } from '../config/settings';
import { PlaneRegistry, registry as defaultRegistry } from '../planes/registry';
import { appendBrokerLog, brokerDataDir } from './writeBroker';
import { knownTicketId } from './tickets';
import { poller } from './poller';
import { CLIENTS } from '../../../shared';

export interface CoaClient {
  mac: string;
  name: string;
  plane: string; // display label — recorded for the log, not gated on
}

export interface CoaResult {
  ok: boolean;
  applied: boolean; // true ONLY on a 2xx from the session-action endpoint
  mac: string;
  ticket: string;
  httpCode?: number;
  message: string;
}

/** Errors that map straight onto HTTP statuses in the routes layer. */
export class CoaError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'CoaError';
  }
}

export interface CoaServiceOptions {
  registry?: PlaneRegistry; // default: the process-wide singleton
  adapter?: ClearPassAdapter | null; // undefined → resolve from the registry
  demoMode?: () => boolean; // default: settings store
  lookupClient?: (mac: string) => CoaClient | null; // default: fixtures (demo) / poller cache (live)
  knownTicket?: (id: string) => boolean; // default: the ticket store (+ fixture ids in demo mode)
  dataDir?: string; // default: HPE_DATA_DIR or <repo>/data
  nowMs?: () => number; // injected clock for tests
}

function requireMac(raw: unknown): string {
  const mac = typeof raw === 'string' ? raw.trim() : '';
  if (!mac) throw new CoaError(400, 'client MAC is required');
  return mac;
}

function requireTicket(raw: unknown): string {
  const ticket = typeof raw === 'string' ? raw.trim() : '';
  if (!ticket) throw new CoaError(400, 'ticket reference required — writes are brokered, never standing');
  return ticket;
}

/** Default client lookup: fixtures in demo mode, the poller cache in live mode. */
function defaultLookupClient(mac: string): CoaClient | null {
  // Compare on the 12-hex normal form — planes report MACs in any separator/case.
  const norm = normalizeMac(mac);
  if (settings.get().demoMode) {
    const c = CLIENTS.find((x) => normalizeMac(x.mac) === norm);
    return c ? { mac: c.mac, name: c.name, plane: c.plane } : null;
  }
  const c = poller.getCache().clients.find((x) => normalizeMac(x.mac) === norm);
  return c ? { mac: c.mac, name: c.name, plane: c.plane } : null;
}

export class CoaService {
  private readonly registry: PlaneRegistry;
  private readonly adapterOverride: ClearPassAdapter | null | undefined;
  private readonly demoMode: () => boolean;
  private readonly lookupClient: (mac: string) => CoaClient | null;
  private readonly knownTicket: (id: string) => boolean;
  private readonly dataDir: string;
  private readonly nowMs: () => number;

  constructor(opts: CoaServiceOptions = {}) {
    this.registry = opts.registry ?? defaultRegistry;
    this.adapterOverride = opts.adapter;
    this.demoMode = opts.demoMode ?? (() => settings.get().demoMode);
    this.lookupClient = opts.lookupClient ?? defaultLookupClient;
    this.knownTicket = opts.knownTicket ?? ((id) => knownTicketId(id, this.demoMode()));
    this.dataDir = opts.dataDir ?? brokerDataDir();
    this.nowMs = opts.nowMs ?? (() => Date.now());
  }

  /**
   * Validate → gate → push. Throws CoaError for request/gating problems
   * (400/404/409); a plane answer that is not 2xx comes back as an honest
   * {ok:false} result at HTTP 200, mirroring disconnect/reboot.
   */
  async block(macRaw: unknown, ticketRaw: unknown): Promise<CoaResult> {
    const mac = requireMac(macRaw);
    const ticket = requireTicket(ticketRaw);
    if (!this.knownTicket(ticket)) {
      throw new CoaError(400, `unknown ticket '${ticket}' — writes reference a raised ticket (demo mode also accepts the fixture queue)`);
    }
    const client = this.lookupClient(mac);
    if (!client) throw new CoaError(404, `client '${mac}' not found in the session inventory`);
    const base = { mac: client.mac, ticket };

    if (this.demoMode()) {
      this.log(client.mac, ticket, 'validated — demo mode, nothing sent');
      return {
        ...base,
        ok: true,
        applied: false,
        message: 'demo mode — block validated and audit-logged; nothing was sent to ClearPass',
      };
    }

    const adapter = this.clearpassAdapter();
    if (!adapter) {
      throw new CoaError(409, 'clearpass is not linked — connect it under Systems and retry');
    }

    let res: { status: number; body: unknown };
    try {
      res = await adapter.coaDisconnect(client.mac);
    } catch (err) {
      this.log(client.mac, ticket, 'network-error');
      return { ...base, ok: false, applied: false, message: `CoA request failed — ${(err as Error).message}` };
    }

    if (res.status >= 200 && res.status < 300) {
      this.log(client.mac, ticket, 'coa-sent', res.status);
      return {
        ...base,
        ok: true,
        applied: true,
        httpCode: res.status,
        message: `CoA Disconnect-Request accepted by ClearPass (HTTP ${res.status}) — ${client.name}'s session is terminated at the NAD`,
      };
    }
    this.log(client.mac, ticket, 'rejected', res.status);
    return {
      ...base,
      ok: false,
      applied: false,
      httpCode: res.status,
      message: `ClearPass answered HTTP ${res.status} for the session-action disconnect — ${client.name} not blocked (no active session, or the NAD rejected the CoA)`,
    };
  }

  /** The ClearPass adapter; null when ClearPass can't write. */
  private clearpassAdapter(): ClearPassAdapter | null {
    if (this.adapterOverride !== undefined) return this.adapterOverride;
    const adapter = this.registry.get('clearpass');
    return adapter instanceof ClearPassAdapter ? adapter : null;
  }

  private log(mac: string, ticket: string, result: string, httpCode?: number): void {
    appendBrokerLog(this.dataDir, {
      ts: new Date(this.nowMs()).toISOString(),
      event: 'coa-disconnect',
      changeId: `coa-${mac}`,
      ticket,
      kind: 'client',
      result,
      ...(httpCode !== undefined ? { httpCode } : {}),
    });
  }
}

/** Process-wide singleton. */
export const coaService = new CoaService();
