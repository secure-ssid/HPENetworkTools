/**
 * server/src/planes/aos8.ts — AOS-8 mobility master adapter (read-only).
 *
 * The on-prem controller plane (README integration table: cluster, APs,
 * clients; read-only — configuration stays on the MM, the portal never fakes
 * an edit form). There is no cloud in the path: the portal talks to the
 * mobility master's own HTTPS API on :4343.
 *
 * Verified surface (AOS-8 8.x API, the same calls the WebUI makes):
 *   login       POST /v1/api/login  form {username, password}
 *               → { _global_result: { status: "0", UIDARUBA: "…" } }
 *                 + `Set-Cookie: SESSION=…`
 *               Every /v1/configuration/* call needs BOTH halves — the SESSION
 *               cookie and the UIDARUBA parameter — exactly as the WebUI and
 *               the vendor curl examples (`-c`/`-b` cookie jar) send them.
 *               The session lives ~15 min — cached here and renewed at 14 min,
 *               or immediately when a call answers 401/403 or status != "0"
 *               (session expired), with ONE re-login retry.
 *   logout      POST /v1/api/logout?UIDARUBA=<uid> (+ SESSION cookie)
 *               Best-effort, fired before a rollover mints a new UID. The MM
 *               caps concurrent management sessions, so abandoning one every
 *               14 minutes eventually earns 'maximum number of sessions
 *               reached' — a failure that would surface here as a rejected
 *               login. A failing logout is logged and ignored, never fatal.
 *   showcommand GET /v1/configuration/showcommand?command=<cli>&UIDARUBA=<uid>
 *               → the CLI table parsed to JSON: named arrays of row objects
 *               (top level, or nested one level under a `_data`-style key).
 *               Pulled: `show ap database long` (APs), `show switches`
 *               (controllers) and `show global-user-table list` (clients).
 *
 * TLS: a factory MM serves a self-signed certificate, so the default
 * transport is a small node:https fetch with rejectUnauthorized OFF (set
 * creds.verifyTls = 'true' to enforce chain verification). The call log
 * records method + path + ms + status — the UID in the query string is
 * redacted, and the password only ever travels in the login POST body.
 *
 * Mapping decisions:
 *   - site: the AP database's `Group` and `show switches`' `Location` are the
 *     only place-of-installation columns AOS-8 publishes, so they resolve the
 *     site (siteIdForName mints an 'ext-*' id for a name the portal does not
 *     know). A row with neither still lands on the 'multiple' pseudo-site —
 *     that is what it is for.
 *   - localShell: TRUE for controllers, false for APs. The flag means "the
 *     portal will offer a recorded shell for this row" — an on-prem MM/MD is
 *     reachable through the terminal manager's jump host (README: AOS-8 gets
 *     recorded SSH, change window only), while an AP terminates on its
 *     controller and has no portal shell. It is not a claim that THIS adapter
 *     opens SSH; whether one device can be dialled is still the terminal
 *     manager's call (it needs a management IP, which the tables publish).
 *   - firmwareApproved: AOS-8 requires every managed device to run the mobility
 *     master's train, so the MM's own `show switches` version IS the approved
 *     train — an MD that differs is flagged rather than stamped approved. An
 *     operator-declared `approvedFirmware` map (the credential central already
 *     accepts) is honoured on top. Unknown firmware is never presented as
 *     off-train: we cannot know, and guessing would be noise.
 *
 * Failure policy (mirrors clearpass/mist): login failing, either inventory
 * showcommand section failing, or a section answering something that is not
 * JSON → pull() throws naming the section; an inventory nobody could parse is
 * never published as an empty-but-healthy one. The clients section is additive
 * (the inventory is what the plane is for), so its failure is non-fatal — but
 * the gap is always named in the plane note, never swallowed.
 */

import * as https from 'node:https';
import type { ClientRow, ClientType, DeviceRow, DeviceType, Tone } from '@hpe/shared';
import { formatCount } from '@hpe/shared';
import type { PlaneCredentials } from '../config/settings';
import type { PlaneAdapter, PlaneCapabilities, PlanePull, PlaneState } from './types';
import {
  firmwareIsApproved,
  parseApprovedFirmware,
  siteIdForName,
  type ApprovedFirmwareMap,
} from './format';
import {
  type FetchLike,
  type RecordCallFn,
  httpsBase,
} from './transport';

// Re-exported so tests can type an in-memory fake fetch against this adapter.
export type { FetchLike } from './transport';

const OUTBOUND_TIMEOUT_MS = 10_000;
/** UIDARUBA sessions live ~15 min on the MM; renew a minute early. */
const SESSION_TTL_MS = 14 * 60 * 1000;

const CMD_AP_DATABASE = 'show ap database long';
const CMD_SWITCHES = 'show switches';
/** MM-wide client table; falls back to the per-controller form when the MM rejects it. */
const CMD_USERS = 'show global-user-table list';
const CMD_USERS_FALLBACK = 'show user-table';

// ---------------------------------------------------------------------------
// Default transport: node:https so per-connection TLS verification can be
// relaxed for the MM's factory self-signed cert (global fetch/undici offers
// no per-call switch without an undici Agent dependency).
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
            // pairwise keeps every `set-cookie` the login answer carries, which
            // is where the SESSION cookie showcommand needs lives.
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

/** First non-empty value among the column-name variants a table may use. */
function pick(r: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = str(r[k]);
    if (v !== null) return v;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Row mapping (pure, exported for tests)
// ---------------------------------------------------------------------------

/** AOS-8 Status column ("Up 5d:02:11:47" / "Down") → portal state vocabulary. */
function stateForStatus(raw: string | null): { state: string; stateTone: Tone } {
  const s = (raw ?? '').trim().toLowerCase();
  if (s.startsWith('up')) return { state: 'up', stateTone: 'success' };
  if (s.startsWith('down')) return { state: 'down', stateTone: 'danger' };
  return { state: s || 'unknown', stateTone: 'neutral' };
}

interface BaseRowInput {
  name: string;
  model: string | null;
  type: DeviceType;
  statusRaw: string | null;
  firmware: string | null;
  ip: string | null;
  /** Group (APs) / Location (controllers) — the plane's only place column. */
  siteName: string | null;
}

function baseRow(input: BaseRowInput): DeviceRow {
  const { state, stateTone } = stateForStatus(input.statusRaw);
  // A row with no Group/Location lands on the 'multiple' pseudo-site — its
  // documented purpose — rather than being filed somewhere it never claimed.
  const site = siteIdForName(input.siteName);
  return {
    name: input.name,
    model: input.model ?? 'unknown',
    type: input.type,
    siteId: site.siteId,
    siteName: site.siteName,
    plane: 'AOS-8',
    planeTone: 'accent',
    state,
    stateTone,
    firmware: input.firmware ?? 'unknown',
    // Provisional: pull() re-evaluates it against the MM's train and the
    // operator's approved-firmware map, which a pure row mapper cannot see.
    firmwareApproved: true,
    licence: 'unknown', // licences live on the MM (show license), not pulled
    reconciliationIssue: false, // the reconcile service computes this
    // The portal WILL offer a recorded shell for an on-prem controller (the
    // terminal manager dials it through the jump host); an AP terminates on
    // its controller and has none.
    localShell: input.type === 'controller',
    // Both tables publish the management address; the recorded-SSH terminal
    // dials it, so it must survive into the live inventory (never guessed).
    ...(input.ip ? { ip: input.ip } : {}),
  };
}

/** `show ap database long` row → DeviceRow (type 'ap'). */
export function mapAos8Ap(raw: unknown): DeviceRow | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const ip = pick(r, ['IP Address', 'IP', 'ip']);
  const name = pick(r, ['Name', 'name', 'AP Name', 'ap-name']) ?? ip;
  if (!name) return null;
  return baseRow({
    name,
    model: pick(r, ['AP Type', 'Type', 'Model', 'model']),
    type: 'ap',
    statusRaw: pick(r, ['Status', 'status', 'State']),
    firmware: pick(r, ['Version', 'Firmware', 'fw']),
    ip,
    // The AP database's Group is where an AOS-8 estate records the site.
    siteName: pick(r, ['Group', 'group', 'AP Group', 'ap-group']),
  });
}

/** `show switches` row → DeviceRow (type 'controller'). */
export function mapAos8Switch(raw: unknown): DeviceRow | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const ip = pick(r, ['IP Address', 'IP', 'Switch IP', 'ip']);
  const name = pick(r, ['Name', 'name', 'Hostname']) ?? ip;
  if (!name) return null;
  const model = pick(r, ['Model', 'Type', 'model']);
  return baseRow({
    name,
    model,
    type: 'controller',
    statusRaw: pick(r, ['Status', 'status', 'State']),
    firmware: pick(r, ['Version', 'Firmware', 'fw']),
    ip,
    siteName: pick(r, ['Location', 'location', 'Site', 'site']),
  });
}

/**
 * The mobility master's own version out of `show switches` — the train every
 * managed device is required to run, and the only approved-train statement an
 * AOS-8 deployment actually publishes. null when no row identifies itself as
 * the master (a standalone controller, or a Type column we do not recognise):
 * then nothing is off-train, because nothing declared what on-train means.
 */
export function aos8MasterVersion(rows: unknown[]): string | null {
  for (const raw of rows) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const role = pick(r, ['Type', 'type', 'Role', 'role', 'Switch Type']) ?? '';
    if (/master|conductor|^mm$/i.test(role)) return pick(r, ['Version', 'Firmware', 'fw']);
  }
  return null;
}

/**
 * Is this device on the approved train? An operator-declared map wins (same
 * credential and helper Central uses); on top of it, AOS-8's own rule: an MD
 * whose version differs from the master's is off-train. Unknown firmware is
 * never flagged — we cannot know, and flagging everything is noise.
 */
export function aos8FirmwareApproved(
  device: DeviceRow,
  masterVersion: string | null,
  approved: ApprovedFirmwareMap,
): boolean {
  if (!firmwareIsApproved(device.type, device.model, device.firmware, approved)) return false;
  if (masterVersion === null || device.firmware === 'unknown') return true;
  if (device.type !== 'controller') return true; // APs run the image their controller pushes
  return device.firmware === masterVersion;
}

/** AOS-8 user-table "Type"/"Host Name" → the shared ClientType vocabulary. */
function clientTypeFor(hint: string | null): ClientType {
  const s = (hint ?? '').toLowerCase();
  if (/ipad|tablet/.test(s)) return 'tablet';
  if (/iphone|android|phone/.test(s)) return 'phone';
  if (/win|mac ?os|osx|linux|ubuntu|chrome/.test(s)) return 'laptop';
  if (/print/.test(s)) return 'printer';
  if (/voip|voice|spectralink/.test(s)) return 'voip';
  if (/camera|imaging|x-?ray/.test(s)) return 'imaging';
  if (/medical|infusion|clinical/.test(s)) return 'medical';
  if (/sensor|thermostat|lighting|iot/.test(s)) return 'building';
  return 'unknown';
}

/**
 * `show global-user-table list` / `show user-table` row → ClientRow. The table
 * is flat CLI columns; every field the MM does not publish stays '—' rather
 * than being invented (no health score, no RF detail, no closet).
 */
export function mapAos8Client(raw: unknown): ClientRow | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const mac = pick(r, ['MAC', 'mac', 'MAC Address', 'macaddr']);
  if (!mac) return null; // a client row without a MAC is junk
  const site = siteIdForName(null); // the user table carries no site concept — honest 'multiple'
  const essid = pick(r, ['Essid/Bssid/Phy', 'Essid', 'ESSID', 'essid']);
  const kind = pick(r, ['Device Type', 'Type', 'User Type']);
  return {
    name: pick(r, ['Name', 'User Name', 'name', 'Host Name', 'hostname']) ?? mac,
    model: kind ?? 'unknown',
    type: clientTypeFor(kind ?? pick(r, ['Host Name'])),
    mac,
    ip: pick(r, ['IP', 'IP Address', 'ip']) ?? 'pending',
    // An MM user with no ESSID/BSSID terminated on a wired port, not a radio.
    medium: essid ? 'wireless' : 'wired',
    siteId: site.siteId,
    siteName: site.siteName,
    group: pick(r, ['Profile', 'AAA Profile', 'profile']) ?? '—',
    attach: pick(r, ['AP name', 'AP Name', 'ap-name', 'Switch IP']) ?? '—',
    where: essid ?? pick(r, ['Port', 'port']) ?? '—',
    plane: 'AOS-8',
    planeTone: 'accent',
    healthTone: 'neutral',
    auth: pick(r, ['Auth', 'auth', 'Authentication']) ?? '—',
    authBy: '—', // the user table does not name the authenticator; ClearPass rows will
    role: pick(r, ['Role', 'role']) ?? '—',
    vlan: pick(r, ['VLAN', 'vlan', 'Vlan']) ?? '—',
    health: '—', // the MM publishes no client health score — nothing to assert
    session: pick(r, ['Age(d:h:m)', 'Age', 'age']) ?? '—',
    problem: false,
    link: '—',
    rssi: '—',
    snr: '—',
    retries: '—',
    tput: '—',
    roams: '—',
    quality: null,
    zone: '—',
    closet: '—',
  };
}

// ---------------------------------------------------------------------------
// Response-shape helpers
// ---------------------------------------------------------------------------

/** `_global_result.status` — "0" means success; anything else is a session/CLI error. */
function globalStatus(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const g = (body as Record<string, unknown>)._global_result;
  if (!g || typeof g !== 'object') return null;
  return str((g as Record<string, unknown>).status);
}

/** UIDARUBA out of a login body (`_global_result.UIDARUBA`, with flat variants). */
function uidFrom(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  const g = b._global_result;
  if (g && typeof g === 'object') {
    const uid = str((g as Record<string, unknown>).UIDARUBA);
    if (uid) return uid;
  }
  return str(b.UIDARUBA) ?? str(b.uidaruba);
}

/**
 * All table rows in a showcommand body: arrays of plain objects at the top
 * level or one level deep, excluding `_`-prefixed metadata keys. Command
 * tables appear under their CLI title ("AP Database", "Switches", …), which
 * varies by version — walking the shape beats hardcoding titles.
 */
function extractTables(body: unknown): unknown[] {
  const out: unknown[] = [];
  const walk = (v: unknown, depth: number): void => {
    if (depth > 2 || !v || typeof v !== 'object') return;
    if (Array.isArray(v)) {
      for (const item of v) if (item && typeof item === 'object' && !Array.isArray(item)) out.push(item);
      return;
    }
    for (const [k, child] of Object.entries(v as Record<string, unknown>)) {
      // `_data` is where the MM nests tables; other `_` keys are metadata.
      if (k.startsWith('_') && k !== '_data') continue;
      walk(child, depth + 1);
    }
  };
  walk(body, 0);
  return out;
}

/**
 * The `SESSION=…` pair out of a login answer's Set-Cookie headers. AOS-8 8.x
 * mints `SESSION=<uid>`, so a master that answers without a readable cookie
 * (or a transport that cannot expose one) still authenticates off the UID.
 */
function sessionCookieFrom(res: Response, uid: string): string {
  const raw =
    typeof res.headers.getSetCookie === 'function'
      ? res.headers.getSetCookie()
      : [res.headers.get('set-cookie') ?? ''];
  for (const line of raw) {
    const m = /(?:^|[,;]\s*)(SESSION=[^;,\s]+)/i.exec(line ?? '');
    if (m) return m[1];
  }
  return `SESSION=${uid}`;
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export class Aos8Adapter implements PlaneAdapter {
  readonly id = 'aos8' as const;

  private readonly baseUrl: string;
  private readonly username: string;
  private readonly password: string;
  private readonly approved: ApprovedFirmwareMap;
  private session: { uid: string; cookie: string; expiresAt: number } | null = null;

  constructor(
    creds: PlaneCredentials,
    private readonly stateRef: PlaneState,
    private readonly recordCall: RecordCallFn,
    private readonly fetchImpl: FetchLike = httpsFetch(creds.verifyTls === 'true'),
  ) {
    if (!Aos8Adapter.isComplete(creds)) {
      throw new Error("aos8 requires master plus username/password (or clientId/clientSecret)");
    }
    this.baseUrl = httpsBase(creds.master, 'the login carries the password').replace(/\/+$/, '');
    this.username = (creds.username ?? creds.clientId).trim();
    this.password = creds.password ?? creds.clientSecret;
    this.approved = parseApprovedFirmware(creds.approvedFirmware);
  }

  static isComplete(creds: PlaneCredentials | null): boolean {
    if (!creds) return false;
    const user = creds.username ?? creds.clientId;
    const pass = creds.password ?? creds.clientSecret;
    return [creds.master, user, pass].every((v) => typeof v === 'string' && v.trim().length > 0);
  }

  state(): PlaneState {
    return this.stateRef;
  }

  /**
   * The on-prem plane the portal CAN give a shell to: AOS-8 devices are
   * reached over recorded SSH through the terminal manager's jump host
   * (README integration table: 'recorded SSH, change window only'). The write
   * broker does not push configuration here — configuration stays on the MM —
   * and this adapter reads no SSID/VLAN/port inventory.
   */
  capabilities(): PlaneCapabilities {
    return { localShell: true, brokeredWrite: false, configRead: false };
  }

  /**
   * Hand the MM its session back before this adapter is dropped (credentials
   * re-saved, plane unlinked). The rollover path inside login() already logs
   * out, but a replaced adapter never rolls over again: without this the UID
   * stays checked out against the controller's capped pool of concurrent
   * management sessions until its idle timer reaps it.
   *
   * Never throws — logout() swallows its own errors — so a re-link is never
   * blocked or failed by the controller being unreachable.
   */
  async dispose(): Promise<void> {
    const session = this.session;
    this.session = null;
    if (session) await this.logout(session);
  }

  async pull(): Promise<PlanePull> {
    let apRows: unknown[];
    let switchRows: unknown[];
    try {
      apRows = await this.showcommand(CMD_AP_DATABASE);
    } catch (err) {
      throw new Error(`aos8 pull: section '${CMD_AP_DATABASE}' failed — ${(err as Error).message}`);
    }
    try {
      switchRows = await this.showcommand(CMD_SWITCHES);
    } catch (err) {
      throw new Error(`aos8 pull: section '${CMD_SWITCHES}' failed — ${(err as Error).message}`);
    }

    // AOS-8's approved train is the master's own version: evaluate every row
    // against it (plus any operator-declared map) instead of stamping the
    // whole plane 'approved' and making version skew unrenderable.
    const train = aos8MasterVersion(switchRows);
    const approve = (d: DeviceRow): DeviceRow => ({
      ...d,
      firmwareApproved: aos8FirmwareApproved(d, train, this.approved),
    });
    const aps = apRows.map(mapAos8Ap).filter((d): d is DeviceRow => d !== null).map(approve);
    const switches = switchRows.map(mapAos8Switch).filter((d): d is DeviceRow => d !== null).map(approve);
    const devices = [...aps, ...switches];
    if (devices.length === 0) {
      // A live MM always answers `show switches` with at least itself. Zero
      // rows across both sections means the answer was not the one we asked
      // for — publishing it would stamp an empty inventory as a good sync.
      throw new Error(
        `aos8 pull: sections '${CMD_AP_DATABASE}' and '${CMD_SWITCHES}' both returned no rows — refusing to publish an empty inventory as current`,
      );
    }

    /* Clients are additive (README: cluster, APs, clients): a failing client
       table must not lose the inventory, but the gap is named in the note —
       AND in the pull's partial[], which is what actually holds the plane off
       'healthy'. The note is prose on one screen; partial[] is the contract
       every other plane uses to say 'half read', and without it a controller
       whose client table has been refusing for hours carried a green badge
       and a fresh sync stamp. greenlake.ts puts it plainly at the top of the
       file: the plane reads 'half read' rather than green. */
    let clients: ClientRow[] | null = null;
    let clientsError: string | null = null;
    try {
      clients = (await this.clientRows()).map(mapAos8Client).filter((c): c is ClientRow => c !== null);
    } catch (err) {
      clientsError = (err as Error).message;
    }

    const down = devices.filter((d) => d.state === 'down').length;
    const offTrain = devices.filter((d) => !d.firmwareApproved).length;
    this.stateRef.note =
      `${formatCount(aps.length)} APs · ${formatCount(switches.length)} controllers via showcommand` +
      (down > 0 ? ` · ${formatCount(down)} down` : '') +
      (offTrain > 0 ? ` · ${formatCount(offTrain)} off the ${train ?? 'approved'} train` : '') +
      (clients !== null
        ? ` · ${formatCount(clients.length)} clients`
        : ` · client table unavailable (${clientsError})`);
    if (this.stateRef.health === 'warning') this.stateRef.health = 'healthy'; // first sync done

    return clients !== null ? { devices, clients } : { devices, partial: ['clients'] };
  }

  // -- internals -------------------------------------------------------------

  /**
   * The client table: the MM-wide form first, falling back to the
   * per-controller one when the master rejects the global command (older
   * images, or a standalone controller answering on the same API).
   */
  private async clientRows(): Promise<unknown[]> {
    try {
      return await this.showcommand(CMD_USERS);
    } catch (err) {
      try {
        return await this.showcommand(CMD_USERS_FALLBACK);
      } catch {
        throw new Error(`section '${CMD_USERS}' failed — ${(err as Error).message}`);
      }
    }
  }

  /**
   * One CLI command through the showcommand API. A 401/403, or a 2xx carrying
   * status != "0", means the session died (or the CLI errored) — drop the
   * cached session, re-login once, retry once. A body that is not JSON is a
   * failure, never an empty table: an unauthenticated MM answers the WebUI
   * login HTML with a 200.
   */
  private async showcommand(command: string): Promise<unknown[]> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const session = await this.login();
      const path = `/v1/configuration/showcommand?command=${encodeURIComponent(command)}&UIDARUBA=${encodeURIComponent(session.uid)}`;
      const res = await this.get(
        path,
        `GET /v1/configuration/showcommand?command=${command}&UIDARUBA=…`,
        session.cookie,
      );
      // 401/403 is the MM saying the session is gone (reboot, aaa change, an
      // admin clearing management sessions) — that is expiry, not fatal.
      if (res.status === 401 || res.status === 403) {
        await this.dropSession(false);
        if (attempt === 0) continue;
        throw new Error(`HTTP ${res.status} from showcommand '${command}' after re-login`);
      }
      if (res.status < 200 || res.status >= 300) {
        throw new Error(`HTTP ${res.status} from showcommand '${command}'`);
      }
      if (res.parseError) {
        throw new Error(`non-JSON body from showcommand '${command}' (HTTP ${res.status}, ${res.parseError})`);
      }
      const status = globalStatus(res.body);
      if (status !== null && status !== '0') {
        // Still alive: the MM answered 2xx on this very session, so hand it
        // back before asking for another one.
        await this.dropSession(true);
        if (attempt === 0) continue;
        throw new Error(`MM answered status ${status} for '${command}' after re-login`);
      }
      return extractTables(res.body);
    }
    throw new Error(`unreachable retry state for '${command}'`);
  }

  /**
   * Forget the cached session, handing the UID back first when it is still
   * one the MM would honour.
   *
   * `alive` is the whole point of this existing. A 401/403 says the UID is
   * already gone, and logging out against it is a wasted call the MM answers
   * 401 to. A 2xx carrying a CLI error status says the opposite: the session
   * just worked, the *command* did not. Clearing the field on that path
   * without logging out throws away the only handle to a live session —
   * login()'s rollover then finds nothing stale to release and leaks a seat
   * in the MM's capped pool of concurrent management sessions.
   *
   * Never throws: logout() swallows its own errors, and a command retry must
   * not fail because the release call did.
   */
  private async dropSession(alive: boolean): Promise<void> {
    const session = this.session;
    this.session = null;
    if (alive && session) await this.logout(session);
  }

  /**
   * Cached login; renews at 14 min or when the cache was dropped. Returns both
   * halves of the MM's auth material — the UIDARUBA parameter and the SESSION
   * cookie — because /v1/configuration/* wants both.
   */
  private async login(): Promise<{ uid: string; cookie: string }> {
    if (this.session && this.session.expiresAt > Date.now()) return this.session;

    // Hand the old UID back before asking for a new one: the MM caps
    // concurrent management sessions, and a rollover every 14 minutes would
    // otherwise leak one until its idle timer reaps it.
    const stale = this.session;
    this.session = null;
    if (stale) await this.logout(stale);

    const started = Date.now();
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/v1/api/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams({ username: this.username, password: this.password }).toString(),
        signal: AbortSignal.timeout(OUTBOUND_TIMEOUT_MS),
      });
    } catch (err) {
      this.recordCall({ path: 'POST /v1/api/login', ms: Date.now() - started, code: 'network-error' });
      throw new Error(`login failed: ${(err as Error).message}`);
    }
    this.recordCall({ path: 'POST /v1/api/login', ms: Date.now() - started, code: String(res.status) });
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`login failed: HTTP ${res.status} — credentials rejected or wrong master`);
    }
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      /* handled below */
    }
    const uid = uidFrom(body);
    if (!uid) throw new Error('login failed: no UIDARUBA in the response body');
    // The clock starts when the MM answered, not when we asked — a slow login
    // must not eat into the window the cached session is trusted for.
    this.session = { uid, cookie: sessionCookieFrom(res, uid), expiresAt: Date.now() + SESSION_TTL_MS };
    return this.session;
  }

  /**
   * Best-effort session release. The MM's documented lifecycle is
   * login → work → logout; a failed logout is never fatal (the session then
   * simply ages out as it did before), so this never throws into pull().
   */
  private async logout(session: { uid: string; cookie: string }): Promise<void> {
    const started = Date.now();
    const logPath = 'POST /v1/api/logout?UIDARUBA=…';
    try {
      const res = await this.fetchImpl(
        `${this.baseUrl}/v1/api/logout?UIDARUBA=${encodeURIComponent(session.uid)}`,
        {
          method: 'POST',
          headers: { accept: 'application/json', cookie: session.cookie },
          signal: AbortSignal.timeout(OUTBOUND_TIMEOUT_MS),
        },
      );
      this.recordCall({ path: logPath, ms: Date.now() - started, code: String(res.status) });
    } catch {
      this.recordCall({ path: logPath, ms: Date.now() - started, code: 'network-error' });
    }
  }

  /**
   * Timed outbound GET recorded in the plane's call log (path pre-redacted).
   * `parseError` distinguishes "the MM sent no JSON" from "the MM sent an
   * empty table" — the caller must not read the second as the first.
   */
  private async get(
    path: string,
    logPath: string,
    cookie: string,
  ): Promise<{ status: number; body: unknown; parseError: string | null }> {
    const started = Date.now();
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
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
