/**
 * server/src/services/terminal.ts — recorded, read-only SSH shell bridge.
 *
 * Build-order item 6: "Terminal (recorded SSH proxy, session logging) —
 * security-sensitive; treat the design's recording/lease language as
 * requirements." This is the real backend for the device-detail "Local
 * terminal" pane (web/src/lib/wsTerminal.ts is the frontend transport).
 *
 * Model (README "Integration model", local switch collector row):
 *   - One WebSocket connection = one recorded SSH session to one device.
 *   - The portal never holds standing write access to a device: every session
 *     is opened on demand, every command passes a read-only allow-list, and
 *     every session is recorded to disk (rule 3 — "writes need a ticket
 *     reference, hold a short lease, are recorded"). There are no writes here
 *     at all; the allow-list is the lease.
 *
 * Target resolution and shell class:
 *   - Demo mode: the device IP and the shell class come from the shared device
 *     profile (deviceProfile(name)) — fixture IPs and the 'ap-'/'uxi-' name
 *     prefixes are fine there, that is the demo.
 *   - Live mode: the shell class comes from the inventory row's device TYPE
 *     (deviceTerminalKind), never from how the customer names their hardware.
 *   - Live mode: the IP comes from the live inventory (poller cache). A
 *     device the inventory does not know, or cannot name a management IP
 *     for, fails the open with an honest error — never dial a fixture IP
 *     while the recording claims the session is on the requested device.
 *   - A ?host= override on the WS URL is honoured ONLY when the local-plane
 *     credentials record sets allowHostOverride: 'true' — otherwise the
 *     override is silently ignored (the recorded target is always the one
 *     actually used).
 *   - Who provides the shell path is DISCLOSED, not guessed: when the plane
 *     claiming the device reports capabilities().localShell === false, the
 *     banner and the recording say so and name the local-plane credentials as
 *     the path actually used. That capability is a plane-level statement about
 *     the CLOUD plane ("Central cannot hand you a shell"), never a claim that
 *     no shell exists — the collector is a different plane — so it is not a
 *     veto: gating the bridge on it would close the terminal for every device
 *     in a Central-only tenant, which is the very "gate can never open" defect
 *     the audit filed. Reachability (type has a CLI, inventory names a
 *     management IP, local credentials exist) is this module's call and is
 *     exported as canShell() for the route layer.
 *
 * Credentials come from settings.planes.local (arbitrary string map, saved via
 * POST /api/systems/local/credentials):
 *   username    SSH username (required)
 *   password    password auth (or)
 *   privateKey  PEM private key auth (optional passphrase)
 *   passphrase  private-key passphrase
 *   host        OPTIONAL jump host (bastion/collector). When set we connect
 *               to host:port first (same credentials) and open the device
 *               session through ssh2 forwardOut — the design's "via jump
 *               host" model for AOS-8. When unset we connect directly to the
 *               device IP.
 *   port        jump-host SSH port (default 22; device port is always 22)
 *
 * The recording NEVER contains the password/key/passphrase — only username,
 * device, target and the shell transcript.
 *
 * WebSocket protocol (JSON frames), endpoint /api/terminal/:name:
 *   client → {type:'open'}            begin; server resolves device + creds,
 *                                     opens SSH, waits for the first prompt
 *   server → {type:'banner', lines}   portal policy lines, then the shell-path
 *                                     provenance note when there is one, then
 *                                     the device MOTD
 *   server → {type:'ready', prompt, user, target, via, note}
 *                                     shell is live; prompt as seen on device,
 *                                     plus the identity actually recorded (SSH
 *                                     user, resolved target, jump host or null)
 *                                     so the pane attributes the session to the
 *                                     real actor, and `note` — the same
 *                                     provenance line the banner carries, as a
 *                                     field, so a pane that styles banner lines
 *                                     by role does not have to string-match one
 *                                     out of the middle of `lines`. Never any
 *                                     secret.
 *   client → {type:'cmd', cmd}        run one command through the allow-list
 *   server → {type:'out', text}       one ANSI-stripped output line (streamed)
 *   server → {type:'warn', text}      policy refusal / notice line
 *   server → {type:'end', prompt}     prompt seen again — command finished
 *   client → {type:'close'}           hang up
 *   server → {type:'closed', reason}  session over (idle 15 min, logout, drop)
 *   server → {type:'error', message}  fatal (auth, connect, unknown device);
 *                                     the socket closes right after — the
 *                                     frontend then falls back to the canned
 *                                     transport.
 *
 * Shell scraping is line-oriented: one persistent interactive shell channel
 * per session, ANSI escapes stripped server-side, the echoed command line is
 * dropped, and a bare prompt line (looksLikePrompt) ends a command. Device
 * pager prompts (-- MORE --) are auto-advanced with a space so long read-only
 * output cannot wedge the session. Prompt detection is a heuristic — fine for
 * a home lab, documented here so nobody trusts it with more than show-output.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Server as HttpServer, IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { Client, type ClientChannel, type ConnectConfig } from 'ssh2';
import { WebSocketServer, WebSocket } from 'ws';
import { deviceProfile, deviceTerminalKind } from '../../../shared';
import type { DeviceType, Plane, TerminalKind } from '../../../shared';
import { settings, type PlaneCredentials } from '../config/settings';
import { registry } from '../planes/registry';
import type { PlaneCapabilities } from '../planes/types';
import { planeIdForLabel } from './reconcile';
import { poller } from './poller';
import { deviceIdentityKey, resolveDeviceIdentity, safeDeviceCandidates, type DeviceIdentity } from './deviceIdentity';

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/** Strip ANSI CSI/OSC escapes so the pane and the recording see plain text. */
export function stripAnsi(input: string): string {
  // CSI sequences (incl. private markers ? > !) and OSC ... (BEL|ST) terminated.
  return input
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b[@-_]/g, '');
}

/** Heuristic device prompt: short line of prompt-ish chars ending in # or >. */
export function looksLikePrompt(line: string): boolean {
  const t = line.replace(/\s+$/, '');
  if (t.length === 0 || t.length > 64) return false;
  return /^[A-Za-z0-9_\-.,@:()[\] ]+[#>]$/.test(t);
}

/** Device pager waiting for a keypress at the current tail (no newline yet). */
function looksLikePager(line: string): boolean {
  return /--\s*\(?more\(?\s*--|\(more\)/i.test(line);
}

export interface AllowResult {
  ok: boolean;
  reason?: string;
}

/**
 * The read-only lease. Per platform kind ('sw' CX / 'aos' AOS-8) the same
 * policy today, kept per-kind so the lists can diverge (e.g. AOS-8-only
 * diagnostics) without touching the session code:
 *   allowed: show …, display …, ping …, traceroute …,
 *            no page / no paging, terminal length 0, ?, help, exit/logout/quit
 *   blocked: everything else — with configure/config/enable called out as
 *            mode-entry / escalation attempts rather than generic refusals.
 * Matching is case-insensitive on whitespace-normalised input.
 */
export function allowCommand(kind: TerminalKind, cmd: string): AllowResult {
  // Defence in depth (parseClientFrame rejects CR/LF already): the raw string
  // is what gets written to the shell, so a multi-line payload must never be
  // normalised into a pass — '\n' would start a new, unchecked command line.
  if (/[\r\n]/.test(cmd)) return { ok: false, reason: 'multi-line input is not permitted' };
  const c = cmd.trim().replace(/\s+/g, ' ').toLowerCase();
  if (!c) return { ok: false, reason: 'empty command' };

  if (/^(configure|config|conf)\b/.test(c)) {
    return { ok: false, reason: `config-mode entry is not permitted on a read-only lease (${kind})` };
  }
  if (/^enable\b/.test(c)) {
    return { ok: false, reason: 'privilege escalation is not permitted on a read-only lease' };
  }

  if (
    /^show\b/.test(c) ||
    /^display\b/.test(c) ||
    /^ping\b/.test(c) ||
    /^traceroute\b/.test(c) ||
    /^no pag(e|ing)$/.test(c) ||
    /^terminal length 0$/.test(c) ||
    /^(\?|help)$/.test(c) ||
    /^(exit|logout|quit)$/.test(c)
  ) {
    return { ok: true };
  }

  return { ok: false, reason: `'${c.split(' ')[0]}' is not on the read-only allow-list` };
}

/** What the pane shows when the allow-list refuses a command. */
export const BLOCKED_LINE = '% blocked by portal policy — read-only lease';

// -- client frame parsing ----------------------------------------------------

export type ClientFrame = { type: 'open' } | { type: 'cmd'; cmd: string } | { type: 'close' };

/** Validate one inbound JSON frame; null = malformed, close the socket. */
export function parseClientFrame(raw: string): ClientFrame | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const f = parsed as Record<string, unknown>;
  if (f.type === 'open' || f.type === 'close') return { type: f.type };
  if (f.type === 'cmd' && typeof f.cmd === 'string') {
    // The shell write path appends '\n' to the raw string — an embedded
    // CR/LF would smuggle extra command lines past the allow-list.
    if (/[\r\n]/.test(f.cmd)) return null;
    return { type: 'cmd', cmd: f.cmd };
  }
  return null;
}

// -- line-oriented shell scraping --------------------------------------------

export type ScrapeEvent =
  | { kind: 'line'; text: string } // a completed output line
  | { kind: 'prompt'; text: string } // bare prompt sitting at the tail
  | { kind: 'page' }; // pager prompt at the tail — caller should send a space

/**
 * Incremental splitter over an interactive shell stream. Complete lines come
 * out as 'line' events; the tail (text after the last newline, where a device
 * prompt or pager prompt sits without a trailing newline) is inspected on
 * every feed. After a 'prompt' event the tail is left in place — call
 * clearTail() when dispatching the next command so the prompt does not get
 * glued to the command echo.
 */
export class ShellScraper {
  private tail = '';

  feed(chunk: string): ScrapeEvent[] {
    this.tail += chunk;
    const parts = this.tail.split(/\r\n|\r|\n/);
    this.tail = parts.pop() ?? '';
    const events: ScrapeEvent[] = parts.map((text) => ({ kind: 'line' as const, text }));
    if (looksLikePrompt(this.tail)) {
      events.push({ kind: 'prompt', text: this.tail.replace(/\s+$/, '') });
    } else if (looksLikePager(this.tail)) {
      events.push({ kind: 'page' });
      this.tail = '';
    }
    return events;
  }

  /** Drop the held tail (a rendered prompt) before writing the next command. */
  clearTail(): void {
    this.tail = '';
  }
}

// ---------------------------------------------------------------------------
// Session recording — JSONL, one file per session, mode 0600
// ---------------------------------------------------------------------------

export interface SessionRecordEvent {
  type: 'open' | 'in' | 'out' | 'blocked' | 'close';
  at: string; // ISO
  text?: string;
  reason?: string;
}

export interface SessionInfo {
  file: string;
  device: string;
  user: string;
  target: string;
  openedAt: string;
  /** Plane+serial the recording was opened against, when the caller supplied
   *  a complete identity pair at connect time — undefined for a recording
   *  written before this field existed, or one opened with a name only.
   *  Never derived from the display name: see TerminalManager.listSessionsForDevice. */
  plane?: string;
  serial?: string;
  /** Literal key written at open time (see deviceIdentityKey) — undefined
   *  exactly when plane/serial are undefined. */
  identityKey?: string;
}

export interface SessionTranscript {
  file: string;
  events: SessionRecordEvent[];
  truncated: boolean; // true when the cap cut the read short — never silently
}

/** Result of listSessionsForDevice — see its doc comment for the identity rule. */
export interface SessionQueryResult {
  sessions: SessionInfo[];
  /** true = the name (with the supplied identity, if any) still names more
   *  than one physical device; `sessions` is always [] in that case. */
  ambiguous: boolean;
  /** Set only when plane/serial were supplied as a half pair. */
  invalid: string | null;
}

/** Result of readSessionForDevice — mirrors SessionQueryResult's honesty
 *  rule: a miss (transcript null, not ambiguous, not invalid) means the file
 *  is either unknown or belongs to a different physical device — the two
 *  are indistinguishable from the outside on purpose. */
export interface SessionTranscriptQueryResult {
  transcript: SessionTranscript | null;
  ambiguous: boolean;
  invalid: string | null;
}

/** Safety bound on one transcript read (recordings are operator-driven, small). */
export const MAX_TRANSCRIPT_EVENTS = 10_000;

/** Append-only JSONL recorder. Secrets never enter this class — callers only
 *  pass usernames, targets and transcript lines. */
class SessionRecorder {
  private readonly filePath: string;
  private fd: number | null = null;

  constructor(
    logDir: string,
    private readonly device: string,
    private readonly user: string,
    private readonly target: string,
    private readonly jumpHost: string | null,
    /** Plane+serial this session was actually opened against, when the
     *  caller supplied a complete pair — persisted so a later listing binds
     *  to the exact device instead of guessing from `device` (a display name
     *  two physically distinct devices can share). Written right after
     *  `target=`, ahead of `via=`/`note=`, which stay last — see below. */
    identity: DeviceIdentity = {},
    /** Provenance of the shell path (see TerminalManager.shellPathNote) —
     *  appended last so the `device= user= target=` prefix a transcript
     *  listing parses stays exactly where it was. */
    note: string | null = null,
    now: Date = new Date(),
  ) {
    fs.mkdirSync(logDir, { recursive: true });
    const stamp = now.toISOString().replace(/[:.]/g, '-');
    const safeDevice = device.replace(/[^A-Za-z0-9_.-]/g, '_');
    // O_EXCL so a name collision can never clobber an earlier recording — and
    // a collision is possible: two panes opened on the same device inside the
    // same millisecond share the stamp. Take the next free suffix instead of
    // failing the session (recording is mandatory, so an EEXIST here would
    // refuse a legitimate second session).
    let fd: number | null = null;
    let filePath = '';
    for (let attempt = 0; attempt < 20 && fd === null; attempt += 1) {
      filePath = path.join(logDir, `${safeDevice}-${stamp}${attempt === 0 ? '' : `-${attempt + 1}`}.jsonl`);
      try {
        fd = fs.openSync(filePath, 'wx', 0o600);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      }
    }
    if (fd === null) throw new Error(`could not open a recording for ${device} — 20 name collisions`);
    this.filePath = filePath;
    this.fd = fd;
    // identity= is only ever both-or-neither: a half pair would be worse than
    // no identity at all (a false promise that the recording is bound to one
    // exact device), and deviceIdentityKey() already enforces that.
    const key = deviceIdentityKey(identity.plane, identity.serial);
    const identityText = key ? ` plane=${identity.plane} serial=${identity.serial} identity=${key}` : '';
    this.event({
      type: 'open',
      at: now.toISOString(),
      text: `device=${device} user=${user} target=${target}${identityText}${jumpHost ? ` via=${jumpHost}` : ''}${note ? ` note=${note}` : ''}`,
    });
  }

  event(e: SessionRecordEvent): void {
    if (this.fd === null) return;
    fs.writeSync(this.fd, JSON.stringify(e) + '\n');
  }

  close(reason: string): void {
    this.event({ type: 'close', at: new Date().toISOString(), reason });
    if (this.fd !== null) {
      fs.closeSync(this.fd);
      this.fd = null;
    }
  }

  get path(): string {
    return this.filePath;
  }
}

// ---------------------------------------------------------------------------
// TerminalManager
// ---------------------------------------------------------------------------

interface LocalCreds {
  username: string;
  password?: string;
  privateKey?: string;
  passphrase?: string;
  jumpHost: string | null;
  jumpPort: number;
  allowHostOverride: boolean;
}

const IDLE_MS = 15 * 60 * 1000; // design: idle session is closed (titlebar counts idle)
const OPEN_FRAME_WAIT_MS = 10_000; // client must send {type:'open'} promptly
const SSH_READY_MS = 10_000;

/**
 * What the session needs from the live inventory: the device name, its
 * management IP when a plane reported one, and its type — the type decides
 * shell class (deviceTerminalKind), because the name-prefix rules in
 * deviceProfile() are a DEMO naming convention and a real tenant's 'AP-Floor3'
 * or 'ap-closet-sw' would be classified backwards by them.
 */
export interface LiveDeviceRef {
  name: string;
  ip?: string;
  type?: DeviceType;
  serial?: string;
  /** Display label of the plane that claimed the row, when the caller knows
   *  it. Used only to disclose who provides the shell path — see
   *  shellPathNote(). Absent means "unattributed", never "no shell". */
  plane?: Plane;
  claimedBy?: Plane[];
}

export class TerminalManager {
  private readonly demoMode: () => boolean;
  private readonly liveDevices: () => LiveDeviceRef[];
  private readonly credsProvider: () => LocalCreds | null;
  private readonly connect: (target: string, creds: LocalCreds) => Promise<Client>;
  private readonly planeCapabilities: (plane: Plane) => PlaneCapabilities | undefined;

  constructor(
    private readonly opts: {
      logDir?: string;
      idleMs?: number;
      sshReadyMs?: number;
      demoMode?: () => boolean; // default: settings store
      liveDevices?: () => LiveDeviceRef[]; // default: poller cache (live mode only)
      creds?: () => LocalCreds | null; // default: local-plane settings record
      connect?: (target: string, creds: LocalCreds) => Promise<Client>; // default: connectSsh
      planeCapabilities?: (plane: Plane) => PlaneCapabilities | undefined; // default: registry
    } = {},
  ) {
    this.demoMode = opts.demoMode ?? (() => settings.get().demoMode);
    this.liveDevices = opts.liveDevices ?? (() => poller.getCache().devices);
    this.credsProvider = opts.creds ?? (() => this.readCreds());
    this.connect = opts.connect ?? ((target, creds) => this.connectSsh(target, creds));
    this.planeCapabilities =
      opts.planeCapabilities ??
      ((plane) => {
        // The label → plane id map lives in reconcile.ts, which is where the
        // labels on a row come from in the first place.
        const id = planeIdForLabel(plane);
        return id === undefined ? undefined : registry.state(id).capabilities;
      });
  }

  /**
   * Could the portal open a recorded shell to this device right now? The rule
   * the route layer needs for DeviceRow.localShell on a LIVE row, kept here so
   * it exists once (screens.ts asked for it rather than duplicating it):
   *
   *   - the device TYPE has a CLI worth proxying (deviceTerminalKind — an AP or
   *     a UXI sensor never does),
   *   - the inventory names a management IP that can actually be dialled, and
   *   - local-plane credentials exist, because that record IS the shell path.
   *
   * The claiming plane's capabilities().localShell is deliberately NOT part of
   * this: it states what the CLOUD plane can do, and the shell runs over the
   * collector credentials instead. A caller that wants the plane's own claim as
   * well reads it from the registry and ANDs the two — see shellPathNote() for
   * how a session discloses which of the two is providing the path.
   */
  canShell(row: LiveDeviceRef): boolean {
    if (deviceTerminalKind(row.type ? { type: row.type } : null, row.name) === 'none') return false;
    if (!row.ip || row.ip === 'pending') return false;
    return this.credsProvider() !== null;
  }

  /**
   * One banner/recording line naming who provides the shell path, or null when
   * there is nothing to disclose (demo mode, an unattributed row, a plane that
   * claims the path itself). Honesty rule: the pane's own banner says the
   * session was "opened via the portal", and for a cloud-claimed device that
   * is only true because the operator's collector credentials made it so.
   */
  private shellPathNote(row: LiveDeviceRef | null): string | null {
    if (!row?.plane) return null;
    const caps = this.planeCapabilities(row.plane);
    if (caps?.localShell !== false) return null; // claimed, or never stated — nothing to correct
    return `${row.plane} reports no portal shell path for the devices it claims — this session is dialled through the local-plane credentials`;
  }

  private logDir(): string {
    if (this.opts.logDir) return this.opts.logDir;
    if (process.env.HPE_SHELL_LOG_DIR) return process.env.HPE_SHELL_LOG_DIR;
    return path.resolve(__dirname, '..', '..', '..', 'data', 'shell-logs');
  }

  /** List recorded sessions (newest first) for a future sessions UI. */
  listSessions(): SessionInfo[] {
    const dir = this.logDir();
    let files: string[];
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    const out: SessionInfo[] = [];
    for (const file of files) {
      try {
        const first = fs.readFileSync(path.join(dir, file), 'utf8').split('\n', 1)[0];
        const e = JSON.parse(first) as SessionRecordEvent;
        const text = e.text ?? '';
        const m = /^device=(\S+) user=(\S+) target=(\S+)/.exec(text);
        if (m) {
          // plane=/serial= are additive fields (see SessionRecorder) — absent
          // on a recording written before this field existed, or one opened
          // without a complete identity. Never guessed back from `device`.
          const plane = /(?:^| )plane=(\S+)/.exec(text)?.[1];
          const serial = /(?:^| )serial=(\S+)/.exec(text)?.[1];
          out.push({
            file,
            device: m[1],
            user: m[2],
            target: m[3],
            openedAt: e.at,
            plane,
            serial,
            identityKey: deviceIdentityKey(plane, serial),
          });
        }
      } catch {
        // unreadable/corrupt file — skip, never fail the listing
      }
    }
    return out.sort((a, b) => b.openedAt.localeCompare(a.openedAt));
  }

  /**
   * Recorded sessions for ONE physical device — never guessed across a
   * shared display name. See resolveDeviceIdentity/deviceIdentity.ts for the
   * same rule applied to opening a session in the first place.
   *
   *   - plane+serial supplied → only recordings written with that EXACT
   *     identity match. A legacy recording under the same name (no identity
   *     on file — written before this field existed) joins in ONLY when the
   *     name is provably unique: no OTHER identity was ever recorded under
   *     it, and the live inventory does not currently claim two devices
   *     under it either. Otherwise the legacy recording is omitted — never
   *     guessed onto the wrong device.
   *   - no identity supplied → every recording under the name, but only
   *     under the same proven-unique rule; otherwise `ambiguous: true` and
   *     no sessions, so the caller must supply plane+serial to see any of
   *     them (never a guessed first match).
   */
  listSessionsForDevice(deviceName: string, identity: DeviceIdentity = {}): SessionQueryResult {
    const plane = identity.plane?.trim() || undefined;
    const serial = identity.serial?.trim() || undefined;
    if ((plane && !serial) || (serial && !plane)) {
      return { sessions: [], ambiguous: false, invalid: 'plane and serial must be supplied together' };
    }

    const named = this.listSessions().filter((s) => s.device === deviceName);
    if (named.length === 0) return { sessions: [], ambiguous: false, invalid: null };

    const identified = named.filter((s) => s.identityKey);
    const legacy = named.filter((s) => !s.identityKey);
    const distinctKeys = new Set(identified.map((s) => s.identityKey));
    // The live inventory is the OTHER source of truth for "this name is
    // shared" — a name can be unique across every recording ever made yet be
    // actively shared right now (a second device just showed up under it),
    // and a legacy recording must not be attributed to the wrong one from here on.
    const inventoryAmbiguous = this.nameIsAmbiguousInInventory(deviceName);
    const nameProvenUnique = distinctKeys.size <= 1 && !inventoryAmbiguous;

    if (plane && serial) {
      const key = deviceIdentityKey(plane, serial);
      const exact = identified.filter((s) => s.identityKey === key);
      const sessions = nameProvenUnique ? [...exact, ...legacy].sort((a, b) => b.openedAt.localeCompare(a.openedAt)) : exact;
      return { sessions, ambiguous: false, invalid: null };
    }

    if (distinctKeys.size > 1 || inventoryAmbiguous) {
      return { sessions: [], ambiguous: true, invalid: null };
    }
    return { sessions: named, ambiguous: false, invalid: null };
  }

  /** Does the live inventory currently claim more than one device under this
   *  display name? Demo mode has no duplicate-name fixtures, so it never is. */
  private nameIsAmbiguousInInventory(name: string): boolean {
    if (this.demoMode()) return false;
    return resolveDeviceIdentity(this.liveDevices(), name, {}).ambiguous !== null;
  }

  /**
   * One transcript, gated by the SAME identity rule as listSessionsForDevice
   * — the file name alone is never enough to read a recording back, or a
   * caller that merely knows another device's file name (same display name,
   * different physical device) could read its content. */
  readSessionForDevice(file: string, deviceName: string, identity: DeviceIdentity = {}): SessionTranscriptQueryResult {
    const query = this.listSessionsForDevice(deviceName, identity);
    if (query.invalid) return { transcript: null, ambiguous: false, invalid: query.invalid };
    if (query.ambiguous) return { transcript: null, ambiguous: true, invalid: null };
    if (!query.sessions.some((s) => s.file === file)) return { transcript: null, ambiguous: false, invalid: null };
    return { transcript: this.readSession(file), ambiguous: false, invalid: null };
  }

  /**
   * Read one recorded transcript by file name. The name must be a bare
   * recorder-generated .jsonl file (no separators — traversal is rejected by
   * the pattern, not by path arithmetic). Corrupt lines are skipped, the cap
   * keeps a pathological recording from wedging the request.
   */
  readSession(file: string): SessionTranscript | null {
    if (!/^[A-Za-z0-9_.-]+\.jsonl$/.test(file)) return null;
    let raw: string;
    try {
      raw = fs.readFileSync(path.join(this.logDir(), file), 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
    const events: SessionRecordEvent[] = [];
    let truncated = false;
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line) as SessionRecordEvent;
        if (events.length >= MAX_TRANSCRIPT_EVENTS) {
          truncated = true;
          break;
        }
        events.push(event);
      } catch {
        // corrupt line — skip it, keep the rest of the transcript
      }
    }
    return { file, events, truncated };
  }

  /** Read + validate the local-plane credential record. */
  private readCreds(): LocalCreds | null {
    const raw: PlaneCredentials | null = settings.get().planes.local;
    if (!raw || typeof raw.username !== 'string' || raw.username.trim() === '') return null;
    if (!raw.password && !raw.privateKey) return null;
    return {
      username: raw.username.trim(),
      password: raw.password || undefined,
      privateKey: raw.privateKey || undefined,
      passphrase: raw.passphrase || undefined,
      jumpHost: raw.host?.trim() ? raw.host.trim() : null,
      jumpPort: raw.port && /^\d+$/.test(raw.port) ? Number(raw.port) : 22,
      allowHostOverride: raw.allowHostOverride === 'true',
    };
  }

  private sshConfig(creds: LocalCreds): Omit<ConnectConfig, 'host' | 'port'> {
    return {
      username: creds.username,
      password: creds.password,
      privateKey: creds.privateKey,
      passphrase: creds.passphrase,
      readyTimeout: this.opts.sshReadyMs ?? SSH_READY_MS,
      // Older CX/AOS-8 firmware predates the modern default set — offer the
      // legacy algorithms too so the lab gear actually negotiates.
      algorithms: {
        kex: [
          'ecdh-sha2-nistp256',
          'ecdh-sha2-nistp384',
          'ecdh-sha2-nistp521',
          'diffie-hellman-group-exchange-sha256',
          'diffie-hellman-group14-sha256',
          'diffie-hellman-group14-sha1',
        ],
        serverHostKey: ['ssh-ed25519', 'ecdsa-sha2-nistp256', 'rsa-sha2-256', 'rsa-sha2-512', 'ssh-rsa'],
        cipher: ['aes128-gcm', 'aes128-gcm@openssh.com', 'aes256-gcm', 'aes256-gcm@openssh.com', 'aes128-ctr', 'aes192-ctr', 'aes256-ctr'],
        hmac: ['hmac-sha2-256-etm@openssh.com', 'hmac-sha2-512-etm@openssh.com', 'hmac-sha2-256', 'hmac-sha2-512', 'hmac-sha1'],
      },
    };
  }

  /**
   * Open the SSH connection. Direct to the device by default; when the local
   * plane record has `host` set, that host is the jump box: connect there
   * first (same credentials) and pipe the device connection through
   * forwardOut. Both hops authenticate with the local-plane credentials.
   */
  private connectSsh(target: string, creds: LocalCreds): Promise<Client> {
    const base = this.sshConfig(creds);
    const jumpHost = creds.jumpHost;
    if (!jumpHost) {
      return new Promise((resolve, reject) => {
        const client = new Client();
        client.once('ready', () => resolve(client));
        client.once('error', reject);
        client.connect({ ...base, host: target, port: 22 });
      });
    }
    return new Promise((resolve, reject) => {
      const jump = new Client();
      jump.once('ready', () => {
        jump.forwardOut('127.0.0.1', 0, target, 22, (err, stream) => {
          if (err) {
            jump.end();
            reject(err);
            return;
          }
          const client = new Client();
          client.once('ready', () => resolve(client));
          client.once('error', (e) => {
            jump.end();
            reject(e);
          });
          client.on('close', () => jump.end()); // keep the hop alive exactly as long as the session
          client.connect({ ...base, sock: stream as Duplex });
        });
      });
      jump.once('error', reject);
      jump.connect({ ...base, host: jumpHost, port: creds.jumpPort });
    });
  }

  /**
   * Where to dial for a device. Demo mode keeps the fixture profile IPs —
   * that is the demo. Live mode must never dial one: the target comes from
   * the live inventory (poller cache), and when the inventory does not know
   * the device or cannot name a management IP for it, the open fails
   * honestly instead of silently using the canned address — the recording
   * claims the requested device, so the session must actually land on it.
   */
  /** The live inventory row for a device, or null in demo mode / when the
   *  inventory does not know it. */
  private liveRow(
    deviceName: string,
    identity: DeviceIdentity,
  ): { row: LiveDeviceRef | null; error: string | null } {
    if (this.demoMode()) return { row: null, error: null };
    const hasPlane = typeof identity.plane === 'string' && identity.plane.trim().length > 0;
    const hasSerial = typeof identity.serial === 'string' && identity.serial.trim().length > 0;
    if (hasPlane !== hasSerial) {
      return { row: null, error: 'plane and serial must be supplied together' };
    }
    const resolution = resolveDeviceIdentity(this.liveDevices(), deviceName, identity, {
      requireCompleteIdentity: true,
      requireNameMatch: true,
    });
    if (resolution.invalid) return { row: null, error: resolution.invalid };
    if (resolution.ambiguous) {
      const candidates = safeDeviceCandidates(resolution.ambiguous)
        .map((candidate) => `${candidate.plane}/${candidate.serial ?? 'no-serial'}`)
        .join(', ');
      return {
        row: null,
        error: `'${deviceName}' names ${resolution.ambiguous.length} devices — pass plane and serial (${candidates})`,
      };
    }
    return {
      row: resolution.device,
      error: resolution.device
        ? null
        : `device '${deviceName}' is not in the live inventory — refusing to dial a fixture address`,
    };
  }

  private resolveTarget(
    deviceName: string,
    profileIp: string,
    row: LiveDeviceRef | null,
  ): { target: string } | { error: string } {
    if (this.demoMode()) return { target: profileIp };
    if (!row) {
      return { error: `device '${deviceName}' is not in the live inventory — refusing to dial a fixture address` };
    }
    if (!row.ip || row.ip === 'pending') {
      return { error: `no management IP for '${deviceName}' in the live inventory — refusing to dial a fixture address` };
    }
    return { target: row.ip };
  }

  // -- one WebSocket = one session -------------------------------------------

  handleConnection(
    ws: WebSocket,
    deviceName: string,
    hostOverride: string | null,
    identity: DeviceIdentity = {},
  ): void {
    const send = (frame: Record<string, unknown>): void => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
    };

    type State = 'await-open' | 'connecting' | 'banner' | 'ready' | 'cmd' | 'done';
    let state: State = 'await-open';
    let kind: TerminalKind = deviceProfile(deviceName).kind;
    let client: Client | null = null;
    let shell: ClientChannel | null = null;
    let recorder: SessionRecorder | null = null;
    const scraper = new ShellScraper();
    let motd: string[] = [];
    let echoPending: string | null = null;
    let openedUser = '';
    let openedTarget = '';
    let openedVia: string | null = null;
    let pathNote: string | null = null; // who actually provides the shell path
    let closed = false;

    const idleMs = this.opts.idleMs ?? IDLE_MS;
    let idle: ReturnType<typeof setTimeout>;

    const teardown = (reason: string): void => {
      if (closed) return;
      closed = true;
      state = 'done';
      clearTimeout(idle);
      recorder?.close(reason);
      recorder = null;
      try {
        shell?.close();
      } catch {
        /* already gone */
      }
      try {
        client?.end();
      } catch {
        /* already gone */
      }
      if (ws.readyState === WebSocket.OPEN) ws.close();
    };

    const fail = (message: string): void => {
      send({ type: 'error', message });
      teardown(`error: ${message}`);
    };

    const onIdle = (): void => {
      send({ type: 'warn', text: `% idle timeout — session closed after ${Math.round(idleMs / 60000)}m without input` });
      send({ type: 'closed', reason: 'idle timeout' });
      teardown('idle timeout');
    };

    const bumpIdle = (): void => {
      clearTimeout(idle);
      idle = setTimeout(onIdle, idleMs);
    };
    idle = setTimeout(onIdle, idleMs);

    const recordOut = (text: string): void => {
      recorder?.event({ type: 'out', at: new Date().toISOString(), text });
    };

    /** One scraped event from the shell stream, dispatched by session state. */
    const onScrape = (ev: ScrapeEvent): void => {
      if (state === 'banner') {
        if (ev.kind === 'line') {
          motd.push(ev.text);
          recordOut(ev.text);
          return;
        }
        if (ev.kind === 'prompt') {
          // First prompt: the session is live. Banner = portal policy lines
          // plus whatever the device printed on login.
          const banner = [
            `SSH session opened by ${openedUser} via the portal — session recorded`,
            `target ${deviceName} — read-only lease: show / display / diagnostics only`,
            ...(pathNote ? [pathNote] : []),
            ...motd,
            '',
          ];
          send({ type: 'banner', lines: banner });
          // The identity of the session that is actually recorded, so the
          // pane's titlebar can attribute it to the real SSH user and the
          // real target instead of a fixture operator/IP. `note` repeats the
          // provenance line already inside `lines` as a field, so the pane can
          // treat it as a notice instead of parsing it back out of the banner.
          // Additive fields — a client that only reads `prompt` is unaffected.
          // NEVER carries the password/key: username, resolved target, jump
          // host and the disclosure line only.
          send({
            type: 'ready',
            prompt: ev.text,
            user: openedUser,
            target: openedTarget,
            via: openedVia,
            note: pathNote,
          });
          motd = [];
          state = 'ready';
        }
        // 'page' during login is unlikely; ignore — the open timeout covers a wedge.
        return;
      }
      if (state !== 'cmd') return; // ready/done: no command in flight, nothing should arrive

      if (ev.kind === 'line') {
        if (echoPending !== null) {
          // First line back is normally the terminal echo of what we wrote.
          const echo = ev.text.trim();
          if (echo === '') return;
          if (echoPending.startsWith(echo) || echo.startsWith(echoPending)) {
            echoPending = null;
            return;
          }
          echoPending = null; // device did not echo — treat as real output
        }
        recordOut(ev.text);
        send({ type: 'out', text: ev.text });
        return;
      }
      if (ev.kind === 'prompt') {
        send({ type: 'end', prompt: ev.text });
        state = 'ready';
        return;
      }
      // pager prompt: auto-advance with a space, keep the session flowing.
      recordOut('-- more -- (auto-advanced)');
      shell?.write(' ');
    };

    const openSsh = async (): Promise<void> => {
      const profile = deviceProfile(deviceName);
      // Shell class comes from the INVENTORY ROW when the portal holds one:
      // deviceProfile()'s 'ap-'/'uxi-' prefixes are the demo estate's naming
      // convention, and against a real tenant they classify a Mist AP called
      // 'AP-Floor3' as a CX switch (and then try to log into a radio) while
      // refusing a real switch called 'ap-closet-sw'. Demo mode keeps the
      // prefix rules — that is the demo.
      //
      // The gate is the device TYPE, not DeviceRow.localShell and not the
      // claiming plane's capabilities().localShell: both describe the CLOUD
      // plane rather than the collector, so gating on either would close the
      // terminal for every live device in (say) a Central-only tenant. What
      // the plane's claim IS good for is telling the operator whose path this
      // session is riding — that is disclosed in the banner and the recording.
      // Whether this device can actually be dialled is resolveTarget()'s call,
      // a few lines down.
      const resolved = this.liveRow(deviceName, identity);
      if (resolved.error) {
        fail(resolved.error);
        return;
      }
      const row = resolved.row;
      const known = this.demoMode() || row !== null;
      kind = deviceTerminalKind(row?.type ? { type: row.type } : null, deviceName);
      pathNote = this.shellPathNote(row);
      if (known && kind === 'none') {
        fail(`device '${deviceName}' is cloud-claimed — no local shell (request a remote shell instead)`);
        return;
      }
      const creds = this.credsProvider();
      if (!creds) {
        fail('no local-plane credentials — save username + password/privateKey on Connected systems first');
        return;
      }
      openedUser = creds.username;
      let target: string;
      if (hostOverride && creds.allowHostOverride) {
        target = hostOverride;
      } else {
        const targetResolution = this.resolveTarget(deviceName, profile.ip, row);
        if ('error' in targetResolution) {
          fail(targetResolution.error);
          return;
        }
        target = targetResolution.target;
      }
      if (!/^[A-Za-z0-9_.:-]+$/.test(target)) {
        fail(`refusing to dial unsafe target '${target}'`);
        return;
      }
      openedTarget = target;
      openedVia = creds.jumpHost;

      let conn: Client;
      try {
        conn = await this.connect(target, creds);
      } catch (err) {
        if (closed) return;
        fail(`ssh to ${target}${creds.jumpHost ? ` via ${creds.jumpHost}` : ''} failed: ${(err as Error).message}`);
        return;
      }
      if (closed) {
        try {
          conn.end();
        } catch {
          /* already gone */
        }
        return;
      }
      client = conn;
      conn.on('close', () => {
        if (!closed) {
          send({ type: 'closed', reason: 'device closed the connection' });
          teardown('device closed the connection');
        }
      });
      conn.on('error', () => {
        if (!closed) {
          send({ type: 'closed', reason: 'connection error' });
          teardown('connection error');
        }
      });

      try {
        recorder = new SessionRecorder(this.logDir(), deviceName, creds.username, target, creds.jumpHost, identity, pathNote);
      } catch (err) {
        // Recording is mandatory — no recording, no session. Fail through the
        // normal path (error frame + teardown of the live connection); letting
        // this escape would be an unhandled rejection — openSsh runs
        // fire-and-forget — and would leak the SSH client.
        fail(`session recording unavailable: ${(err as Error).message}`);
        return;
      }

      conn.shell({ term: 'vt100', cols: 200, rows: 50 }, (err, channel) => {
        if (closed) {
          try {
            channel?.close();
          } catch {
            /* already gone */
          }
          try {
            conn.end();
          } catch {
            /* already gone */
          }
          return;
        }
        if (err) {
          fail(`shell channel refused: ${err.message}`);
          return;
        }
        shell = channel;
        state = 'banner';
        channel.on('data', (chunk: Buffer) => {
          const text = stripAnsi(chunk.toString('utf8'));
          for (const ev of scraper.feed(text)) onScrape(ev);
        });
        channel.stderr.on('data', (chunk: Buffer) => {
          const text = stripAnsi(chunk.toString('utf8')).trim();
          if (text) {
            recordOut(text);
            send({ type: 'warn', text });
          }
        });
        channel.on('close', () => {
          if (!closed) {
            send({ type: 'closed', reason: 'shell closed' });
            teardown('shell closed');
          }
        });
      });
    };

    const openWait = setTimeout(() => {
      if (state === 'await-open') fail("protocol violation — expected {type:'open'}");
    }, OPEN_FRAME_WAIT_MS);

    ws.on('message', (data: Buffer) => {
      bumpIdle();
      const frame = parseClientFrame(data.toString('utf8'));
      if (!frame) {
        fail('malformed frame');
        return;
      }
      if (frame.type === 'close') {
        teardown('client closed');
        return;
      }
      if (frame.type === 'open') {
        if (state !== 'await-open') return; // duplicate open — ignore
        clearTimeout(openWait);
        state = 'connecting';
        void openSsh();
        return;
      }
      // {type:'cmd'}
      if (frame.cmd.length > 500) {
        send({ type: 'warn', text: '% command too long — maximum input is 500 characters' });
        send({ type: 'end' });
        return;
      }
      if (state !== 'ready' || !shell) {
        send({
          type: 'warn',
          text: state === 'cmd' ? '% previous command still running' : '% session not ready',
        });
        send({ type: 'end' });
        return;
      }
      const cmd = frame.cmd.trim();
      if (!cmd) {
        send({ type: 'end' });
        return;
      }
      const verdict = allowCommand(kind, cmd);
      if (!verdict.ok) {
        recorder?.event({ type: 'blocked', at: new Date().toISOString(), text: cmd, reason: verdict.reason });
        send({ type: 'warn', text: BLOCKED_LINE });
        send({ type: 'end' });
        return;
      }
      recorder?.event({ type: 'in', at: new Date().toISOString(), text: cmd });
      scraper.clearTail(); // drop the rendered prompt so it cannot glue to the echo
      echoPending = cmd;
      state = 'cmd';
      shell.write(cmd + '\n');
    });

    ws.on('close', () => teardown('websocket closed'));
    ws.on('error', () => teardown('websocket error'));
  }
}

/**
 * Attach the terminal WebSocket endpoint to the existing HTTP server.
 * Handles the upgrade itself so nothing but /api/terminal/:name is accepted.
 */
/** Process-wide manager — shared by the WS bridge and the sessions API. */
export const terminalManager = new TerminalManager();

export function attachTerminalWs(server: HttpServer, manager: TerminalManager = terminalManager): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const m = /^\/api\/terminal\/([^/]+)$/.exec(url.pathname);
    if (!m) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const host = url.searchParams.get('host');
      manager.handleConnection(ws, decodeURIComponent(m[1]), host, {
        plane: url.searchParams.get('plane') ?? undefined,
        serial: url.searchParams.get('serial') ?? undefined,
      });
    });
  });
  return wss;
}
