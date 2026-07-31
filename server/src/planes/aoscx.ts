/**
 * server/src/planes/aoscx.ts — HPE Aruba AOS-CX switch adapter (read-only).
 *
 * On-prem switch plane. Talks to one AOS-CX switch's REST API at /rest/v10.12/.
 * Session-cookie auth: POST /rest/v10.12/login → session cookie, renewed when
 * the call log shows a 401 (one re-login retry, same as AOS-8).
 *
 * Verified surface (AOS-CX 10.x REST API):
 *   login      POST /rest/v10.12/login  body {username, password}
 *   logout     POST /rest/v10.12/logout (best-effort, before re-login)
 *   system     GET  /rest/v10.12/system
 *   interfaces GET  /rest/v10.12/system/interfaces?depth=2
 *   vlans      GET  /rest/v10.12/system/vlans?depth=2
 *   lldp       GET  /rest/v10.12/system/interfaces/{name}/lldp_neighbors?depth=2
 *
 * TLS: a switch's management interface serves a self-signed certificate out
 * of the box, so the default transport is a small node:https fetch with
 * rejectUnauthorized OFF (set creds.verifyTls = 'true' to enforce chain
 * verification) — the same choice AOS-8 makes and for the same reason.
 *
 * Mapping decisions:
 *   - The switch itself is the one DeviceRow this adapter publishes (type
 *     'switch'); AOS-CX's REST API describes a single box, not a fleet, so
 *     there is nothing else to enumerate here. Name is the switch's own
 *     hostname, model is platform_name, firmware is software_version — all
 *     three come straight off `system`, never guessed.
 *   - localShell: true. An on-prem CX switch is exactly what the terminal
 *     manager's recorded-SSH bridge is for (README: local switch collector,
 *     recorded shell).
 *   - state: 'up' once `system` answers at all — a switch that is reachable
 *     enough to authenticate and read its own system table is up; anything
 *     that keeps it from answering surfaces as a thrown pull() instead of a
 *     fabricated 'down' state this adapter cannot actually observe.
 *
 * Failure policy (mirrors aos8): login failing, or the `system` read failing,
 * → pull() throws — a switch this adapter cannot even identify is never
 * published as a healthy row. The interfaces and VLAN counts are additive
 * (they only refine the note on top of the switch row), so either failing is
 * non-fatal — but the gap is always named in the plane note and in
 * PlanePull.partial, never swallowed.
 */

import * as https from 'node:https';
import type { DeviceRow, Tone } from '@hpe/shared';
import { formatCount } from '@hpe/shared';
import type { PlaneCredentials } from '../config/settings';
import type { PlaneAdapter, PlaneCapabilities, PlanePull, PlaneState } from './types';
import { siteIdForName } from './format';
import {
  type FetchLike,
  type RecordCallFn,
  httpsBase,
} from './transport';

// Re-exported so tests can type an in-memory fake fetch against this adapter.
export type { FetchLike } from './transport';

const OUTBOUND_TIMEOUT_MS = 10_000;
const REST_ROOT = '/rest/v10.12';

// ---------------------------------------------------------------------------
// Default transport: node:https so per-connection TLS verification can be
// relaxed for a switch's factory self-signed cert (global fetch/undici offers
// no per-call switch without an undici Agent dependency) — identical to
// aos8.ts's copy, duplicated rather than shared because each adapter owns its
// own transport choice (see transport.ts's header on why retry policy is not
// hoisted; the same reasoning applies to this small a helper).
// ---------------------------------------------------------------------------

function httpsFetch(verifyTls: boolean): FetchLike {
  return (url, init) =>
    new Promise<Response>((resolve, reject) => {
      const u = new URL(url);
      const req = https.request(
        {
          hostname: u.hostname,
          port: u.port || 443,
          path: u.pathname + u.search,
          method: init?.method ?? 'GET',
          headers: init?.headers as Record<string, string> | undefined,
          rejectUnauthorized: verifyTls,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            const code = res.statusCode ?? 502;
            const status = code >= 200 && code <= 599 ? code : 502;
            // rawHeaders is a flat [name, value, name, value…] list — appending
            // pairwise keeps every `set-cookie` the login answer carries,
            // which is where the session cookie lives.
            const headers = new Headers();
            for (let i = 0; i + 1 < res.rawHeaders.length; i += 2) {
              try {
                headers.append(res.rawHeaders[i], res.rawHeaders[i + 1]);
              } catch {
                /* a header this runtime refuses is dropped, never fatal */
              }
            }
            resolve(new Response(Buffer.concat(chunks), { status, headers }));
          });
        },
      );
      req.on('error', reject);
      const signal = init?.signal ?? null;
      if (signal) {
        if (signal.aborted) {
          req.destroy(new Error('request aborted'));
          return;
        }
        signal.addEventListener('abort', () => req.destroy(new Error('request aborted')));
      }
      if (typeof init?.body === 'string') req.write(init.body);
      req.end();
    });
}

// ---------------------------------------------------------------------------
// Defensive field readers — unknown/extra fields ignored, missing → null
// ---------------------------------------------------------------------------

function str(v: unknown): string | null {
  if (typeof v === 'string' && v.trim().length > 0) return v.trim();
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return null;
}

function obj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** `management_interface.ip_address` ("10.0.0.1/24" or bare) → the address alone. */
function managementIp(system: Record<string, unknown>): string | null {
  const mgmt = obj(system.management_interface);
  const raw = str(mgmt?.ip_address) ?? str(mgmt?.ip4_address);
  if (!raw) return null;
  return raw.split('/')[0];
}

// ---------------------------------------------------------------------------
// Row mapping (pure, exported for tests)
// ---------------------------------------------------------------------------

/** `GET /rest/v10.12/system` body → the one DeviceRow this adapter publishes. */
export function mapAosCxSwitch(raw: unknown, siteName: string | null): DeviceRow | null {
  const system = obj(raw);
  if (!system) return null;
  const name = str(system.hostname);
  if (!name) return null;
  const site = siteIdForName(siteName);
  const stateTone: Tone = 'success';
  const serial = str(system.serial_number);
  const ip = managementIp(system);
  return {
    name,
    model: str(system.platform_name) ?? 'unknown',
    type: 'switch',
    siteId: site.siteId,
    siteName: site.siteName,
    plane: 'LOCAL',
    planeTone: 'neutral',
    // Reaching this point means login + `system` both answered — the switch
    // is up. A read that fails surfaces as a thrown pull(), never a guessed
    // 'down' this adapter has no basis to assert.
    state: 'up',
    stateTone,
    firmware: str(system.software_version) ?? 'unknown',
    firmwareApproved: true, // AOS-CX publishes no fleet-wide 'approved train' of its own
    licence: 'n/a — local',
    reconciliationIssue: false, // the reconcile service computes this
    // The terminal manager's recorded-SSH bridge reaches on-prem CX switches
    // directly — this is exactly the plane README:'local switch collector' names.
    localShell: true,
    ...(ip ? { ip } : {}),
    ...(serial ? { serial } : {}),
  };
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export class AosCxAdapter implements PlaneAdapter {
  readonly id = 'local' as const;

  private readonly baseUrl: string;
  private readonly username: string;
  private readonly password: string;
  private session: { cookie: string } | null = null;

  constructor(
    id: 'local',
    private readonly stateRef: PlaneState,
    creds: PlaneCredentials,
    private readonly recordCall: RecordCallFn,
    private readonly fetchImpl: FetchLike = httpsFetch(creds.verifyTls === 'true'),
  ) {
    if (!AosCxAdapter.isComplete(creds)) {
      throw new Error('aoscx requires baseUrl plus username/password');
    }
    this.baseUrl = httpsBase(creds.baseUrl, 'the login carries the password').replace(/\/+$/, '');
    this.username = creds.username.trim();
    this.password = creds.password;
  }

  static isComplete(creds: PlaneCredentials | null): boolean {
    if (!creds) return false;
    return [creds.baseUrl, creds.username, creds.password].every(
      (v) => typeof v === 'string' && v.trim().length > 0,
    );
  }

  state(): PlaneState {
    return this.stateRef;
  }

  /**
   * The on-prem plane the portal CAN give a shell to: a CX switch is reached
   * over recorded SSH through the terminal manager (README: 'local switch
   * collector' row). This adapter itself only reads the REST API — it does
   * not open the shell — but the capability is a plane-level statement, same
   * as AOS-8's.
   */
  capabilities(): PlaneCapabilities {
    return { localShell: true, brokeredWrite: false, configRead: false, alertFeed: false };
  }

  /**
   * Hand the switch its session back before this adapter is dropped
   * (credentials re-saved, plane unlinked). Never throws — logout() swallows
   * its own errors — so a re-link is never blocked by the switch being
   * unreachable.
   */
  async dispose(): Promise<void> {
    const session = this.session;
    this.session = null;
    if (session) await this.logout(session);
  }

  async pull(): Promise<PlanePull> {
    let system: Record<string, unknown>;
    try {
      system = await this.getJson('/system', 'GET /system');
    } catch (err) {
      throw new Error(`aoscx pull: 'system' failed — ${(err as Error).message}`);
    }
    const device = mapAosCxSwitch(system, null);
    if (!device) {
      throw new Error("aoscx pull: 'system' answered without a hostname — refusing to publish an unnamed switch");
    }

    let interfaceCount: number | null = null;
    let interfacesError: string | null = null;
    try {
      const interfaces = await this.getJson('/system/interfaces?depth=2', 'GET /system/interfaces?depth=2');
      interfaceCount = Object.keys(interfaces).length;
    } catch (err) {
      interfacesError = (err as Error).message;
    }

    let vlanCount: number | null = null;
    let vlansError: string | null = null;
    try {
      const vlans = await this.getJson('/system/vlans?depth=2', 'GET /system/vlans?depth=2');
      vlanCount = Object.keys(vlans).length;
    } catch (err) {
      vlansError = (err as Error).message;
    }

    this.stateRef.note =
      '1 switch' +
      (interfaceCount !== null
        ? ` · ${formatCount(interfaceCount)} interfaces`
        : ` · interfaces unavailable (${interfacesError})`) +
      (vlanCount !== null ? ` · ${formatCount(vlanCount)} VLANs` : ` · VLANs unavailable (${vlansError})`);
    // Interfaces/VLANs are additive detail on top of the one device row this
    // plane ever publishes — a failed read there degrades the plane to
    // 'warning' (the gap is real and named above) without pretending the
    // device row itself is incomplete.
    this.stateRef.health = interfaceCount !== null && vlanCount !== null ? 'healthy' : 'warning';

    // Unlike a paged section, there is no separate 'interfaces'/'vlans'
    // PlanePull dataset to mark partial — this plane publishes exactly one
    // device row, and that row is always complete (its identity comes whole
    // off `system`). A failed interfaces/VLANs read only shrinks the note
    // above; it never turns the one device we DID fully read into a partial
    // 'devices' dataset (registry.ts / inventory.ts read that flag as "the
    // search ran over a prefix of the estate", which would misstate this).
    return { devices: [device] };
  }

  // -- internals -------------------------------------------------------------

  /**
   * One GET through the REST API. A 401 means the session died (reboot, aaa
   * change, an admin clearing management sessions) — drop the cached session,
   * re-login once, retry once. A body that is not JSON is a failure, never an
   * empty table.
   */
  private async getJson(path: string, logPath: string): Promise<Record<string, unknown>> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const session = await this.login();
      const res = await this.get(path, logPath, session.cookie);
      if (res.status === 401) {
        this.session = null;
        if (attempt === 0) continue;
        throw new Error(`HTTP 401 from ${logPath} after re-login`);
      }
      if (res.status < 200 || res.status >= 300) {
        throw new Error(`HTTP ${res.status} from ${logPath}`);
      }
      if (res.parseError) {
        throw new Error(`non-JSON body from ${logPath} (HTTP ${res.status}, ${res.parseError})`);
      }
      const body = obj(res.body);
      if (!body) throw new Error(`unexpected (non-object) body from ${logPath}`);
      return body;
    }
    throw new Error(`unreachable retry state for ${logPath}`);
  }

  /** Cached session cookie; a dropped cache re-authenticates on next use. */
  private async login(): Promise<{ cookie: string }> {
    if (this.session) return this.session;

    const started = Date.now();
    const logPath = `POST ${REST_ROOT}/login`;
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${REST_ROOT}/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams({ username: this.username, password: this.password }).toString(),
        signal: AbortSignal.timeout(OUTBOUND_TIMEOUT_MS),
      });
    } catch (err) {
      this.recordCall({ path: logPath, ms: Date.now() - started, code: 'network-error' });
      throw new Error(`login failed: ${(err as Error).message}`);
    }
    this.recordCall({ path: logPath, ms: Date.now() - started, code: String(res.status) });
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`login failed: HTTP ${res.status} — credentials rejected or wrong switch address`);
    }
    const cookie = sessionCookieFrom(res);
    if (!cookie) throw new Error('login failed: no session cookie in the response');
    this.session = { cookie };
    return this.session;
  }

  /**
   * Best-effort session release. A failed logout is never fatal (the session
   * then simply ages out as it did before), so this never throws into pull().
   */
  private async logout(session: { cookie: string }): Promise<void> {
    const started = Date.now();
    const logPath = `POST ${REST_ROOT}/logout`;
    try {
      const res = await this.fetchImpl(`${this.baseUrl}${REST_ROOT}/logout`, {
        method: 'POST',
        headers: { accept: 'application/json', cookie: session.cookie },
        signal: AbortSignal.timeout(OUTBOUND_TIMEOUT_MS),
      });
      this.recordCall({ path: logPath, ms: Date.now() - started, code: String(res.status) });
    } catch {
      this.recordCall({ path: logPath, ms: Date.now() - started, code: 'network-error' });
    }
  }

  /**
   * Timed outbound GET recorded in the plane's call log.
   * `parseError` distinguishes "the switch sent no JSON" from "the switch
   * sent an empty table" — the caller must not read the second as the first.
   */
  private async get(
    path: string,
    logPath: string,
    cookie: string,
  ): Promise<{ status: number; body: unknown; parseError: string | null }> {
    const started = Date.now();
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${REST_ROOT}${path}`, {
        method: 'GET',
        headers: { accept: 'application/json', cookie },
        signal: AbortSignal.timeout(OUTBOUND_TIMEOUT_MS),
      });
    } catch (err) {
      this.recordCall({ path: logPath, ms: Date.now() - started, code: 'network-error' });
      throw new Error(`GET ${logPath} failed: ${(err as Error).message}`);
    }
    this.recordCall({ path: logPath, ms: Date.now() - started, code: String(res.status) });
    let body: unknown = null;
    let parseError: string | null = null;
    try {
      body = await res.json();
    } catch (err) {
      parseError = `${res.headers.get('content-type') ?? 'no content-type'}: ${(err as Error).message}`;
    }
    return { status: res.status, body, parseError };
  }
}

/**
 * The `session_id=…` cookie out of a login answer's Set-Cookie headers.
 * AOS-CX mints a `session_id` (or `session=` on some versions) cookie — the
 * cookie value the switch actually issued is what every later call must send
 * back verbatim, never reconstructed from the login body.
 */
function sessionCookieFrom(res: Response): string | null {
  const raw =
    typeof res.headers.getSetCookie === 'function'
      ? res.headers.getSetCookie()
      : [res.headers.get('set-cookie') ?? ''];
  for (const line of raw) {
    const m = /(?:^|[,;]\s*)((?:session_id|session)=[^;,\s]+)/i.exec(line ?? '');
    if (m) return m[1];
  }
  return null;
}
