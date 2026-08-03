/**
 * server/src/services/configBackup.ts — versioned running-config backups.
 *
 * The Oxidized/rConfig pattern, scoped to what this portal can honestly
 * collect: a read-only snapshot of each reachable device's running-config,
 * stored under <data>/config-backups/<device>/v<N>.cfg with an index.json of
 * version metadata, capped at the last CONFIG_BACKUP_KEEP_VERSIONS per
 * device. An unchanged re-collection stores NOTHING — the version list is the
 * device's change history, and "drift" is exactly "the newest snapshot
 * differs from its predecessor" (never "differs from a golden baseline";
 * there is no golden baseline here).
 *
 * Collection channels:
 *   - Demo mode: deterministic per-device configs synthesized from the shared
 *     fixtures, source 'demo synthesis'. The first sweep seeds a backdated
 *     baseline for two devices (one per shell class) plus a drifted current
 *     config, so the feature opens WITH demonstrable drift; later sweeps are
 *     no-ops. Nothing about the synthesis is random, so the demo estate is
 *     stable across restarts.
 *   - Live mode: a headless run of `show running-config` over the SAME
 *     recorded-SSH channel the terminal bridge uses — the local-plane
 *     credentials, the same read-only allow-list (allowCommand is checked
 *     before the command is ever written), the same prompt/pager scraping.
 *     Nothing is ever written to a device beyond that one allow-listed show
 *     command. Devices with no management IP or no credentials fail their own
 *     collection honestly (status 'failed', reason named); devices whose
 *     class has no shell (APs, sensors) are 'no-source', never silently
 *     dropped from the estate list.
 *
 * Cadence: one sweep on start() plus an interval (default hourly,
 * HPE_CONFIG_BACKUP_INTERVAL_MS), with the poller's in-flight-lock
 * discipline: a sweep that is still running is never stacked by the next
 * tick. Devices are collected SEQUENTIALLY — each holds an SSH session and a
 * VTY slot on production gear, so a parallel fan-out would be the kind of
 * fix that hammers the plane.
 *
 * Every stored snapshot appends one line to the shared broker audit log
 * (appendBrokerLog) — event 'config-backup', never the config body.
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Duplex } from 'node:stream';
import { Client, type ClientChannel, type ConnectConfig } from 'ssh2';
import {
  CONFIG_BACKUP_KEEP_VERSIONS,
  DEVICES,
  deviceProfile,
  deviceTerminalKind,
  diffConfigLines,
  unifiedConfigDiffText,
  type ConfigBackupDeviceRow,
  type ConfigBackupDiff,
  type ConfigBackupSummary,
  type ConfigBackupVersionMeta,
  type DeviceType,
  type TerminalKind,
} from '@hpe/shared';
import { settings, type PlaneCredentials } from '../config/settings';
import { poller } from './poller';
import { ShellScraper, allowCommand, stripAnsi, type ScrapeEvent } from './terminal';
import { appendBrokerLog } from './writeBroker';

/** Errors that map straight onto HTTP statuses in the routes layer. */
export class ConfigBackupError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ConfigBackupError';
  }
}

// ---------------------------------------------------------------------------
// Inventory targets
// ---------------------------------------------------------------------------

/** One inventory row the service can consider backing up. */
export interface BackupInventoryRow {
  name: string;
  type?: DeviceType;
  ip?: string;
  plane?: string;
}

/** A row resolved to a shell class — the collector receives only these. */
export interface BackupTarget extends BackupInventoryRow {
  kind: Exclude<TerminalKind, 'none'>;
}

export interface SweepResult {
  /** True when a previous sweep was still running — the tick is skipped,
   *  never stacked (the poller's in-flight discipline). */
  skipped?: boolean;
  /** Eligible devices a collection was attempted (or synthesized) for. */
  swept: number;
  /** Devices whose sweep stored a NEW version. */
  stored: number;
  /** Devices whose collection failed this sweep. */
  failed: number;
}

// ---------------------------------------------------------------------------
// Demo synthesis — deterministic per-device configs with occasional drift
// ---------------------------------------------------------------------------

const DEMO_SOURCE = 'demo synthesis';
/** The seeded baseline sits this far behind the drifted latest snapshot. */
const DEMO_BASELINE_AGE_MS = 6 * 60 * 60 * 1000;

/** Small stable hash of a device name — picks deterministic per-device vlan /
 *  interface numbers so two demo switches do not carry byte-identical configs. */
function nameHash(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i += 1) h = (h * 31 + name.charCodeAt(i)) % 9973;
  return h;
}

/** A plausible AOS-CX running-config for one demo device. Deterministic. */
function demoCxConfig(name: string): string {
  const h = nameHash(name);
  const vlan = 810 + (h % 8);
  const port = 10 + (h % 30);
  return [
    `hostname ${name}`,
    'ntp server 10.42.0.20 iburst',
    'snmp-server vrf mgmt',
    'logging 10.42.0.5',
    '!',
    'vlan 8',
    '    name mgmt',
    `vlan ${vlan}`,
    '    name clinical-devices',
    '!',
    `interface 1/1/${port}`,
    '    description uplink-core',
    '    no shutdown',
    `    vlan trunk allowed 8,${vlan}`,
    `interface 1/1/${port + 4}`,
    '    description ap-uplink',
    '    no shutdown',
    `    vlan access ${vlan}`,
    '!',
    'aaa group server radius clearpass',
    '    server 10.42.0.30',
  ].join('\n');
}

/** A plausible AOS-8 / gateway running-config for one demo device. */
function demoAosConfig(name: string, firmware: string): string {
  return [
    `version ${firmware || '8.10.0.10'}`,
    `hostname ${name}`,
    '!',
    'wlan ssid-profile "meridian-clinical"',
    '    essid "meridian-clinical"',
    '    wpa2-aes',
    '!',
    'wlan tunnel-group',
    '    mtu 1400',
    '!',
    'ntp server 10.42.0.20',
    'logging level warnings',
  ].join('\n');
}

/** The demo estate's current config for a device, before any drift. */
export function demoBaselineConfig(row: BackupInventoryRow, kind: Exclude<TerminalKind, 'none'>): string {
  return kind === 'aos'
    ? demoAosConfig(row.name, DEVICES.find((d) => d.name === row.name)?.firmware ?? '')
    : demoCxConfig(row.name);
}

/**
 * A plausible operator edit, per shell class. The AOS form re-enacts the demo
 * estate's authored tunnel-MTU story (fixtures.ts: 'mtu drift, baseline
 * 1400'); the CX form moves NTP to the collector that replaced it and adds
 * the quarantine VLAN.
 */
export function applyDemoDrift(config: string, kind: Exclude<TerminalKind, 'none'>): string {
  if (kind === 'aos') return config.replace('    mtu 1400', '    mtu 1500');
  return `${config.replace('ntp server 10.42.0.20 iburst', 'ntp server 10.42.0.21 iburst')}\nvlan 99\n    name quarantine`;
}

/**
 * Which demo devices carry drift — the first sorted name of EACH shell
 * class, so both drift shapes are exercised. Deterministic: the demo opens
 * with exactly these two devices drifting on every fresh data dir.
 */
export function demoDriftDevices(targets: BackupTarget[]): Set<string> {
  const picked = new Set<string>();
  for (const kind of ['sw', 'aos'] as const) {
    const first = targets
      .filter((t) => t.kind === kind)
      .map((t) => t.name)
      .sort()[0];
    if (first) picked.add(first);
  }
  return picked;
}

// ---------------------------------------------------------------------------
// Live collection — headless `show running-config` over the recorded-SSH
// channel's own machinery (local-plane creds, allow-list, shell scraping)
// ---------------------------------------------------------------------------

/** The local-plane SSH credential record, same shape terminal.ts reads. */
export interface BackupSshCreds {
  username: string;
  password?: string;
  privateKey?: string;
  passphrase?: string;
  jumpHost: string | null;
  jumpPort: number;
}

/** Read + validate the local-plane credential record (terminal.ts's rule:
 *  username required, plus a password or a private key). */
export function readBackupSshCreds(raw: PlaneCredentials | null): BackupSshCreds | null {
  if (!raw || typeof raw.username !== 'string' || raw.username.trim() === '') return null;
  if (!raw.password && !raw.privateKey) return null;
  return {
    username: raw.username.trim(),
    password: raw.password || undefined,
    privateKey: raw.privateKey || undefined,
    passphrase: raw.passphrase || undefined,
    jumpHost: raw.host?.trim() ? raw.host.trim() : null,
    jumpPort: raw.port && /^\d+$/.test(raw.port) ? Number(raw.port) : 22,
  };
}

/** The one command collection runs. It must pass the terminal bridge's
 *  read-only lease — collection never holds a wider privilege than an
 *  operator's recorded session does. */
export const COLLECTION_COMMAND = 'show running-config';

const SSH_READY_MS = 10_000;
/** Bound on the whole dial (jump-host dials do two handshakes + a tunnel). */
const CONNECT_MS = 45_000;
/** Bound on one `show running-config` — generous for a large config on a
 *  paged device, finite enough that a wedged shell ends by itself. */
const COMMAND_MS = 120_000;

/** ssh2 handshake config, including the legacy algorithms older CX/AOS-8
 *  firmware still negotiates (mirrors terminal.ts's set, for the same gear). */
function sshConfig(creds: BackupSshCreds): Omit<ConnectConfig, 'host' | 'port'> {
  return {
    username: creds.username,
    password: creds.password,
    privateKey: creds.privateKey,
    passphrase: creds.passphrase,
    readyTimeout: SSH_READY_MS,
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

/** Direct dial, or through the local record's jump host (the AOS-8 model). */
function connectSsh(target: string, creds: BackupSshCreds): Promise<Client> {
  const base = sshConfig(creds);
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
        client.on('close', () => jump.end());
        client.connect({ ...base, sock: stream as Duplex });
      });
    });
    jump.once('error', reject);
    jump.connect({ ...base, host: jumpHost, port: creds.jumpPort });
  });
}

/** Stop waiting after `ms`; a late-landing connection is closed, never leaked. */
function withConnectTimeout(work: Promise<Client>, ms: number): Promise<Client> {
  return new Promise<Client>((resolve, reject) => {
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      reject(new Error(`no response after ${Math.round(ms / 1000)}s`));
    }, ms);
    work.then(
      (client) => {
        clearTimeout(timer);
        if (timedOut) {
          try {
            client.end();
          } catch {
            /* already gone */
          }
          return;
        }
        resolve(client);
      },
      (err: unknown) => {
        clearTimeout(timer);
        if (!timedOut) reject(err as Error);
      },
    );
  });
}

/**
 * Run ONE command on an interactive shell and return its output. Waits for
 * the login prompt before writing (MOTD lines are not command output), drops
 * the command's own echo, auto-advances the device pager, and treats the next
 * bare prompt as end-of-output. Mirrors the terminal bridge's scraping; the
 * command itself is validated through the same allow-list before this runs.
 */
export function runShellCommand(client: Client, command: string, timeoutMs: number = COMMAND_MS): Promise<string> {
  return new Promise((resolve, reject) => {
    const scraper = new ShellScraper();
    let shell: ClientChannel | null = null;
    let state: 'banner' | 'cmd' = 'banner';
    let echoPending: string | null = null;
    let settled = false;
    const lines: string[] = [];

    const finish = (err: Error | null, out?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        shell?.close();
      } catch {
        /* already gone */
      }
      if (err) reject(err);
      else resolve(out ?? '');
    };
    const timer = setTimeout(() => {
      finish(new Error(`no response after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);

    const onEvent = (ev: ScrapeEvent): void => {
      if (ev.kind === 'page') {
        shell?.write(' '); // auto-advance the pager so a long config cannot wedge
        return;
      }
      if (ev.kind === 'prompt') {
        if (state === 'banner') {
          state = 'cmd';
          scraper.clearTail();
          echoPending = command;
          shell?.write(command + '\n');
          return;
        }
        finish(null, lines.join('\n').replace(/\s+$/g, ''));
        return;
      }
      if (state !== 'cmd') return; // MOTD/banner line — not command output
      if (echoPending !== null) {
        const echo = ev.text.trim();
        if (echo === '') return;
        if (echoPending.startsWith(echo) || echo.startsWith(echoPending)) {
          echoPending = null;
          return;
        }
        echoPending = null; // device did not echo — treat as real output
      }
      lines.push(ev.text);
    };

    client.shell({ term: 'vt100', cols: 200, rows: 50 }, (err, channel) => {
      if (err) {
        finish(err);
        return;
      }
      shell = channel;
      channel.on('data', (chunk: Buffer) => {
        for (const ev of scraper.feed(stripAnsi(chunk.toString('utf8')))) onEvent(ev);
      });
      channel.on('close', () => {
        finish(new Error('shell closed before the command completed'));
      });
    });
  });
}

export type ConfigCollector = (target: BackupTarget) => Promise<string>;

/** The default live collector: `show running-config` over SSH, read-only. */
async function sshCollector(target: BackupTarget, creds: BackupSshCreds | null): Promise<string> {
  if (!creds) {
    throw new Error('no local-plane credentials — save username + password/privateKey on Connected systems first');
  }
  if (!target.ip || target.ip === 'pending') {
    throw new Error('no management IP reported by the inventory');
  }
  const verdict = allowCommand(target.kind, COLLECTION_COMMAND);
  if (!verdict.ok) {
    throw new Error(`collection refused by the read-only lease: ${verdict.reason}`);
  }
  const client = await withConnectTimeout(connectSsh(target.ip, creds), CONNECT_MS);
  try {
    return await runShellCommand(client, COLLECTION_COMMAND);
  } finally {
    try {
      client.end();
    } catch {
      /* already gone */
    }
  }
}

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

export interface ConfigBackupServiceOptions {
  /** Data root; backups live under <dataDir>/config-backups. Default:
   *  HPE_DATA_DIR or <repo>/data (the broker's rule). */
  dataDir?: string;
  keepVersions?: number;
  demoMode?: () => boolean;
  inventory?: () => BackupInventoryRow[];
  collector?: ConfigCollector; // live mode only; demo always synthesizes
  creds?: () => BackupSshCreds | null;
  nowMs?: () => number;
  /** start() sweep cadence; HPE_CONFIG_BACKUP_INTERVAL_MS or 1h. */
  intervalMs?: number;
}

interface DeviceIndex {
  device: string;
  versions: ConfigBackupVersionMeta[];
}

function defaultIntervalMs(): number {
  const raw = Number(process.env.HPE_CONFIG_BACKUP_INTERVAL_MS);
  return Number.isFinite(raw) && raw >= 60_000 ? raw : 60 * 60 * 1000;
}

export class ConfigBackupService {
  private readonly dataDir: string;
  private readonly keepVersions: number;
  private readonly demoMode: () => boolean;
  private readonly inventory: () => BackupInventoryRow[];
  private readonly collector: ConfigCollector;
  private readonly nowMs: () => number;
  private readonly intervalMs: number;
  private sweeping = false;
  private timer: NodeJS.Timeout | null = null;
  /** device → why its last live collection failed (cleared on success). */
  private readonly lastErrors = new Map<string, string>();

  constructor(opts: ConfigBackupServiceOptions = {}) {
    this.dataDir =
      opts.dataDir ??
      (process.env.HPE_DATA_DIR || path.resolve(__dirname, '..', '..', '..', 'data'));
    this.keepVersions = opts.keepVersions ?? CONFIG_BACKUP_KEEP_VERSIONS;
    this.demoMode = opts.demoMode ?? (() => settings.get().demoMode);
    this.nowMs = opts.nowMs ?? (() => Date.now());
    this.intervalMs = opts.intervalMs ?? defaultIntervalMs();
    this.inventory =
      opts.inventory ??
      (() => {
        const rows = this.demoMode() ? DEVICES : poller.getCache().devices;
        return rows.map((row) => ({
          name: row.name,
          type: row.type,
          // Demo fixture rows carry no IP; the authored profile's address is
          // the demo estate's answer, and the demo collector never dials it.
          ip: row.ip ?? (this.demoMode() ? deviceProfile(row.name).ip : undefined),
          plane: row.plane,
        }));
      });
    const creds = opts.creds ?? (() => readBackupSshCreds(settings.get().planes.local));
    this.collector = opts.collector ?? ((target) => sshCollector(target, creds()));
  }

  // -- storage ---------------------------------------------------------------

  private backupsDir(): string {
    return path.join(this.dataDir, 'config-backups');
  }

  /** The on-disk key is a sanitized form of the display name (the terminal
   *  recorder's own rule) — a name is never trusted as a path segment. */
  private deviceDir(device: string): string {
    return path.join(this.backupsDir(), device.replace(/[^A-Za-z0-9_.-]/g, '_'));
  }

  private readIndex(device: string): DeviceIndex {
    const file = path.join(this.deviceDir(device), 'index.json');
    let raw: string;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { device, versions: [] };
      throw err;
    }
    try {
      const parsed = JSON.parse(raw) as DeviceIndex;
      if (!Array.isArray(parsed.versions)) return { device, versions: [] };
      return { device, versions: parsed.versions };
    } catch (err) {
      // A corrupt index must not fail the feature, but it is never quiet.
      console.error(`config backup: index for '${device}' unreadable: ${(err as Error).message}`);
      return { device, versions: [] };
    }
  }

  /** Atomic write: tmp file + rename, mode 0600 (the settings store's rule). */
  private writeIndex(device: string, index: DeviceIndex): void {
    const dir = this.deviceDir(device);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'index.json');
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(index, null, 2) + '\n', { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, file);
  }

  private versionPath(device: string, version: number): string {
    return path.join(this.deviceDir(device), `v${version}.cfg`);
  }

  /**
   * Store one snapshot. An unchanged re-collection (same sha as the latest)
   * stores nothing and reports stored: false — the version list stays a
   * change history, not a poll log. A stored snapshot beyond the first is by
   * definition drift from its predecessor, and is audit-logged as such.
   */
  recordSnapshot(
    device: string,
    content: string,
    source: string,
    takenAt?: string,
  ): { stored: boolean; meta: ConfigBackupVersionMeta } {
    const normalized = content.replace(/\r\n?/g, '\n').trim();
    if (!normalized) throw new ConfigBackupError(400, 'empty config body — nothing to store');
    const index = this.readIndex(device);
    const sha256 = createHash('sha256').update(normalized).digest('hex');
    const latest = index.versions[index.versions.length - 1];
    if (latest && latest.sha256 === sha256) return { stored: false, meta: latest };

    const version = (latest?.version ?? 0) + 1;
    const meta: ConfigBackupVersionMeta = {
      version,
      takenAt: takenAt ?? new Date(this.nowMs()).toISOString(),
      source,
      lines: normalized.split('\n').length,
      sha256,
      driftFromPrevious: latest !== undefined,
    };
    const dir = this.deviceDir(device);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this.versionPath(device, version), normalized + '\n', { mode: 0o600 });
    index.versions.push(meta);
    while (index.versions.length > this.keepVersions) {
      const pruned = index.versions.shift()!;
      try {
        fs.unlinkSync(this.versionPath(device, pruned.version));
      } catch {
        /* already gone */
      }
    }
    this.writeIndex(device, index);
    appendBrokerLog(this.dataDir, {
      ts: new Date(this.nowMs()).toISOString(),
      event: 'config-backup',
      changeId: `cfgbak-${device}-v${version}`,
      ticket: '—',
      kind: 'config-snapshot',
      result: meta.driftFromPrevious ? 'snapshot+drift' : 'snapshot',
      device,
      plane: this.inventory().find((row) => row.name === device)?.plane,
    });
    return { stored: true, meta };
  }

  // -- reads -----------------------------------------------------------------

  /** Version metadata for one device, newest first. */
  listVersions(device: string): ConfigBackupVersionMeta[] {
    return [...this.readIndex(device).versions].reverse();
  }

  /** The stored body of one version, or null when it is not on disk. */
  readVersionContent(device: string, version: number): string | null {
    try {
      return fs.readFileSync(this.versionPath(device, version), 'utf8').replace(/\n+$/g, '');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  /** Does this device name anything the portal knows — inventory or disk? */
  knownDevice(device: string): boolean {
    return (
      this.inventory().some((row) => row.name === device) ||
      this.readIndex(device).versions.length > 0
    );
  }

  /** A computed unified diff between two stored versions of one device. */
  diffVersions(device: string, fromRaw: unknown, toRaw: unknown): ConfigBackupDiff {
    const from = Number(fromRaw);
    const to = Number(toRaw);
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < 1) {
      throw new ConfigBackupError(400, 'from and to must be positive integer version numbers');
    }
    if (from >= to) {
      throw new ConfigBackupError(400, 'from must be an earlier version than to');
    }
    const metas = this.readIndex(device).versions;
    const fromMeta = metas.find((m) => m.version === from);
    const toMeta = metas.find((m) => m.version === to);
    if (!fromMeta || !toMeta) {
      throw new ConfigBackupError(404, `unknown version for '${device}' (have ${metas.map((m) => m.version).join(', ') || 'none'})`);
    }
    const before = this.readVersionContent(device, from);
    const after = this.readVersionContent(device, to);
    if (before === null || after === null) {
      throw new ConfigBackupError(404, `version body missing on disk for '${device}'`);
    }
    const lines = diffConfigLines(before, after);
    return {
      device,
      fromVersion: from,
      toVersion: to,
      fromTakenAt: fromMeta.takenAt,
      toTakenAt: toMeta.takenAt,
      added: lines.filter((l) => l.kind === 'add').length,
      removed: lines.filter((l) => l.kind === 'del').length,
      lines,
      text: unifiedConfigDiffText(lines),
    };
  }

  /** One device's shell class under the mode's own rule: the demo prefix
   *  convention in demo mode, the inventory TYPE in live mode (terminal.ts's
   *  rule — a real tenant's names do not follow the demo convention). */
  private kindFor(row: BackupInventoryRow): TerminalKind {
    return this.demoMode()
      ? deviceTerminalKind(null, row.name)
      : deviceTerminalKind(row.type ? { type: row.type } : null, row.name);
  }

  /** Inventory devices that have a read-only config channel at all. */
  private eligibleTargets(): BackupTarget[] {
    const out: BackupTarget[] = [];
    for (const row of this.inventory()) {
      const kind = this.kindFor(row);
      if (kind !== 'none') out.push({ ...row, kind });
    }
    return out;
  }

  /** The estate-wide view the list route and the Compliance summary read. */
  listDeviceRows(): ConfigBackupDeviceRow[] {
    return this.inventory().map((row) => {
      const kind = this.kindFor(row);
      const base = { device: row.name, plane: row.plane ?? null, ip: row.ip ?? null };
      if (kind === 'none') {
        return {
          ...base,
          status: 'no-source' as const,
          note: 'cloud-claimed device class — the portal has no read-only config channel for it',
          versions: 0,
          latest: null,
          drift: false,
        };
      }
      const versions = this.readIndex(row.name).versions;
      const latest = versions[versions.length - 1] ?? null;
      const lastError = this.lastErrors.get(row.name);
      return {
        ...base,
        status: latest ? ('ok' as const) : lastError ? ('failed' as const) : ('pending' as const),
        ...(lastError ? { note: `last collection failed: ${lastError}` } : {}),
        versions: versions.length,
        latest,
        drift: latest?.driftFromPrevious ?? false,
      };
    });
  }

  /** The rollup the Compliance 'Config drift' stat card reads. */
  summary(): ConfigBackupSummary {
    const rows = this.listDeviceRows();
    return {
      total: rows.length,
      eligible: rows.filter((r) => r.status !== 'no-source').length,
      backedUp: rows.filter((r) => r.versions > 0).length,
      drift: rows.filter((r) => r.drift).length,
      failed: rows.filter((r) => r.status === 'failed').length,
    };
  }

  // -- collection ------------------------------------------------------------

  /**
   * One collection pass over every eligible device. Never stacked: a sweep
   * already in flight makes the next call a skip. Devices are collected one
   * at a time — each collection holds a device VTY session.
   */
  async sweep(): Promise<SweepResult> {
    if (this.sweeping) return { skipped: true, swept: 0, stored: 0, failed: 0 };
    this.sweeping = true;
    try {
      const targets = this.eligibleTargets();
      if (this.demoMode()) return this.sweepDemo(targets);
      let stored = 0;
      let failed = 0;
      for (const target of targets) {
        try {
          const content = await this.collector(target);
          const result = this.recordSnapshot(target.name, content, `ssh ${COLLECTION_COMMAND}`);
          if (result.stored) stored += 1;
          this.lastErrors.delete(target.name);
        } catch (err) {
          failed += 1;
          this.lastErrors.set(target.name, (err as Error).message);
        }
      }
      return { swept: targets.length, stored, failed };
    } finally {
      this.sweeping = false;
    }
  }

  /**
   * Demo collection: synthesize, never dial. The first sweep seeds the two
   * drift devices with a backdated pre-drift baseline so the demo opens with
   * drift already on file; every later sweep re-derives the same content and
   * stores nothing (recordSnapshot's unchanged-content rule).
   */
  private sweepDemo(targets: BackupTarget[]): SweepResult {
    const drift = demoDriftDevices(targets);
    let stored = 0;
    for (const target of targets) {
      const baseline = demoBaselineConfig(target, target.kind);
      const current = drift.has(target.name) ? applyDemoDrift(baseline, target.kind) : baseline;
      if (drift.has(target.name) && this.readIndex(target.name).versions.length === 0) {
        const seeded = this.recordSnapshot(
          target.name,
          baseline,
          DEMO_SOURCE,
          new Date(this.nowMs() - DEMO_BASELINE_AGE_MS).toISOString(),
        );
        if (seeded.stored) stored += 1;
      }
      const result = this.recordSnapshot(target.name, current, DEMO_SOURCE);
      if (result.stored) stored += 1;
    }
    return { swept: targets.length, stored, failed: 0 };
  }

  /** One sweep now plus one per interval. The timer never keeps the process
   *  alive (the poller's own rule). */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.sweep();
    }, this.intervalMs);
    this.timer.unref();
    void this.sweep();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

/** Process-wide singleton. */
export const configBackups = new ConfigBackupService();
