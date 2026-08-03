/**
 * server/src/services/writeBroker.ts — the brokered-write pipeline.
 *
 * Hardened mode requires a REAL ticket for the queued workflow. Lab mode can
 * apply supported Central objects immediately, bypassing only ticket/review/
 * queue/lease/dry-run ceremony; exact ownership, stored-scope admission,
 * target locking, validation, verification, audit and redaction remain.
 * Hardened ready changes hold a 15-minute lease and a 24-hour snapshot.
 * Read-only planes (Mist per the shared CAPABILITY_MATRIX) get an honest
 * console hand-off — the broker renders the payload and never fakes a push.
 *
 * The renderers are the shared live-preview functions (configPreviewFor /
 * previewMetaFor / blastRadiusFor) — the same strings the operator watched in
 * the drawer are what the broker queues and pushes.
 *
 * Writes go through the CentralAdapter's auth'd request() (token manager,
 * call recording, 401 retry). Push paths are deliberately ONE conservative
 * candidate per object kind — a write must never spray candidate paths the
 * way the read side does. A 404 on the push path is reported honestly as
 * "push path unverified against this tenant — payload rendered, manual apply
 * advised"; success is only ever claimed on a 2xx answer.
 *
 * On-disk state (all mode 0600; the data dir is HPE_DATA_DIR or <repo>/data):
 *   change-queue.json       the queued changes
 *   change-log.jsonl        one JSON line per dry-run / queue / push / discard
 *   snapshots/<id>.json     pre-change read-back state, kept 24h (mtime check)
 *
 * The log records {ts, event, changeId, ticket, kind, result, httpCode?} —
 * never a payload body, so never a secret.
 */

import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  PORT_MODE_OPTIONS,
  DEVICES,
  SSID_BAND_OPTIONS,
  SSID_SECURITY_OPTIONS,
  VLAN_SCOPE_OPTIONS,
  blastRadiusFor,
  configPreviewFor,
  previewMetaFor,
  type BlastRadiusRow,
  type ConfigForm,
  type ConfigKind,
  type PortForm,
  type SsidForm,
  type VlanObject,
  type VlanForm,
  type Plane,
  vlanIdProblem,
  type WriteCacheRefresh,
} from '@hpe/shared';
import { readJsonlNewestFirst, rotateIfNeeded } from './logRotation';
import { CentralAdapter } from '../planes/central';
import { poller as defaultPoller, type Poller } from './poller';
import { PlaneRegistry, registry as defaultRegistry } from '../planes/registry';
import { settings } from '../config/settings';
import { allowsLabDirectWrites } from './labWritePolicy';
import { knownTicketId } from './tickets';
import { resolveDeviceIdentity, safeDeviceCandidates } from './deviceIdentity';
import { currentActor } from './auth';
import { evaluateWriteAdmission, type AdmitWrite } from './writeAdmission';

export const LEASE_MS = 15 * 60 * 1000;
export const SNAPSHOT_TTL_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** The auth'd transport the broker pushes through (CentralAdapter qualifies). */
export interface BrokerResponse {
  status: number;
  body: unknown;
  /** Sanitized Location response header, when the upstream returned one. */
  location?: string;
  /** Retry-After converted to a relative delay. */
  retryAfterMs?: number;
  /** X-RateLimit-Reset (or equivalent) converted to an absolute epoch. */
  rateLimitResetAtMs?: number;
}

export interface BrokerTransport {
  request(method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown): Promise<BrokerResponse>;
}

export type ChangeState = 'ready' | 'applying' | 'needs window' | 'console';

/** README ChangeRequest, extended with the broker's bookkeeping. */
export interface BrokeredChange {
  id: string;
  object: { kind: ConfigKind; form: ConfigForm };
  what: string; // display summary for the queue list
  ticket: string; // REQUIRED
  state: ChangeState;
  where: string;
  rendered: string; // plane-specific payload, from the shared preview renderers
  createdAt: string; // ISO
  expiresAt: string | null; // 15-min lease — only 'ready' changes carry one
  dryRunId: string | null; // a fresh dry-run snapshot for this change, when one is on file
}

export interface RenderedPayload {
  rendered: string;
  meta: string;
  blastRadius: BlastRadiusRow[];
}

export interface DryRunResult extends RenderedPayload {
  ok: boolean;
  kind: ConfigKind;
  ticket: string;
  target: 'central' | 'console';
  reachable: boolean | null; // null = no read-back attempted (unlinked / read-only plane)
  snapshot: boolean; // a rollback snapshot was stored
  httpCode?: number; // the read-back's HTTP code, when one was attempted
  note: string; // honest one-liner, e.g. "target reachable, current state snapshot taken"
}

export interface PushResult {
  ok: boolean;
  /**
   * The plane confirmed the change is in effect.
   *
   * NOT simply "the call returned 2xx". A 202 is the plane saying it has taken
   * the request and will act on it later, which is a different claim; that
   * comes back as `accepted` with `applied` false. The UI turns this field
   * into a green toast and the broker drops the change off the queue on it, so
   * anything less than a confirmed write must not set it.
   */
  applied?: boolean;
  /** The request may have reached Central; reconciliation is required before retry. */
  outcomeUnknown?: boolean;
  /**
   * The plane took the request but has not said it is done (HTTP 202).
   *
   * Deliberately distinct from both success and failure: there is nothing to
   * retry — a second PUT could duplicate the write — and nothing to celebrate.
   * The operator has to go and confirm it on the plane.
   */
  accepted?: boolean;
  changeId: string;
  ticket: string;
  kind: ConfigKind;
  httpCode?: number;
  snapshot: boolean; // a rollback snapshot is on file (kept 24h)
  message: string;
  /**
   * Set after an `applied` push, never by the transport. The Configure screen
   * lists SSIDs, VLANs and ports out of the poll cache, so without a forced
   * re-read the estate it shows after a successful push is the one from before
   * it — the same list the operator is looking at when they decide whether the
   * change worked.
   *
   * Absent means no refresh was tried: correct for `accepted` (a 202 has
   * changed nothing yet, so re-reading would only assert more confidently that
   * nothing had) and for every failure. That is NOT the same as a refresh that
   * was tried and did not land, and the screen must not conflate them.
   */
  cacheRefresh?: WriteCacheRefresh;
}

/** Result of a lab-direct Central apply. It intentionally has no ticket,
 * queue, lease, or dry-run fields: those belong to the hardened broker path. */
export interface ImmediateApplyResult {
  ok: boolean;
  applied?: boolean;
  /** The request may have reached Central; reconciliation is required before retry. */
  outcomeUnknown?: boolean;
  accepted?: boolean;
  changeId: string;
  kind: ConfigKind;
  httpCode?: number;
  message: string;
  cacheRefresh?: WriteCacheRefresh;
}

/** Errors that map straight onto HTTP statuses in the routes layer. */
export class BrokerError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'BrokerError';
  }
}

interface SnapshotRecord {
  changeId: string;
  ticket: string;
  kind: ConfigKind;
  path: string; // read-back path this state came from
  takenAt: string; // ISO
  body: unknown; // the read-back GET body — current state before the change
}

// ---------------------------------------------------------------------------
// Kind/form validation + shared renderer dispatch (the overloads need narrowing)
// ---------------------------------------------------------------------------

const KINDS: readonly ConfigKind[] = ['ssid', 'port', 'vlan'];

function asConfigKind(value: unknown): ConfigKind {
  if (typeof value === 'string' && (KINDS as readonly string[]).includes(value)) return value as ConfigKind;
  throw new BrokerError(400, `kind must be one of ${KINDS.join(' | ')}`);
}

const FORM_FIELDS: Record<ConfigKind, { strings: string[]; booleans: string[] }> = {
  ssid: { strings: ['name', 'vlan', 'security', 'group', 'bands'], booleans: ['broadcast', 'isolate', 'noDfs'] },
  port: { strings: ['device', 'id', 'desc', 'mode', 'vlan'], booleans: ['poe', 'dot1x', 'mab', 'up'] },
  vlan: { strings: ['id', 'name', 'helpers', 'scope'], booleans: [] },
};

const REQUIRED_STRINGS: Record<ConfigKind, string[]> = {
  ssid: ['name', 'vlan', 'security', 'group', 'bands'],
  port: ['device', 'id', 'mode', 'vlan'],
  vlan: ['id', 'scope'],
};

function requireVlanId(value: string): void {
  const problem = vlanIdProblem(value);
  if (problem) throw new BrokerError(400, problem);
}

function asForm(kind: ConfigKind, value: unknown): ConfigForm {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new BrokerError(400, 'form must be an object');
  }
  const spec = FORM_FIELDS[kind];
  const rec = value as Record<string, unknown>;
  const missing = [
    ...spec.strings.filter((f) => typeof rec[f] !== 'string'),
    ...spec.booleans.filter((f) => typeof rec[f] !== 'boolean'),
  ];
  if (missing.length > 0) {
    throw new BrokerError(400, `form is missing or mistypes: ${missing.join(', ')}`);
  }
  const nonEmpty = REQUIRED_STRINGS[kind].filter((field) => !(rec[field] as string).trim());
  if (nonEmpty.length > 0) {
    throw new BrokerError(400, `form fields must not be empty: ${nonEmpty.join(', ')}`);
  }
  if (kind === 'ssid') {
    const security = new Set(SSID_SECURITY_OPTIONS.map((option) => option.value));
    const bands = new Set(SSID_BAND_OPTIONS.map((option) => option.value));
    if (!security.has(rec.security as string)) throw new BrokerError(400, 'unsupported SSID security value');
    if (!bands.has(rec.bands as string)) throw new BrokerError(400, 'unsupported SSID bands value');
    requireVlanId(rec.vlan as string);
  }
  if (kind === 'port') {
    const modes = new Set(PORT_MODE_OPTIONS.map((option) => option.value));
    if (!modes.has(rec.mode as string)) throw new BrokerError(400, 'unsupported port mode value');
    requireVlanId(rec.vlan as string);
  }
  if (kind === 'vlan') {
    const scopes = new Set(VLAN_SCOPE_OPTIONS.map((option) => option.value));
    requireVlanId(rec.id as string);
    if (!scopes.has(rec.scope as string)) throw new BrokerError(400, 'unsupported VLAN scope value');
  }
  return value as ConfigForm;
}

function previewFor(kind: ConfigKind, form: ConfigForm): string {
  if (kind === 'port') return configPreviewFor('port', form as PortForm);
  if (kind === 'vlan') return configPreviewFor('vlan', form as VlanForm);
  return configPreviewFor('ssid', form as SsidForm);
}

function metaFor(kind: ConfigKind, form: ConfigForm): string {
  if (kind === 'port') return previewMetaFor('port', form as PortForm);
  if (kind === 'vlan') return previewMetaFor('vlan', form as VlanForm);
  return previewMetaFor('ssid', form as SsidForm);
}

function blastFor(kind: ConfigKind, form: ConfigForm): BlastRadiusRow[] {
  if (kind === 'port') return blastRadiusFor('port', form as PortForm);
  if (kind === 'vlan') return blastRadiusFor('vlan', form as VlanForm);
  return blastRadiusFor('ssid', form as SsidForm);
}

function livePreviewFor(kind: ConfigKind, form: ConfigForm): string {
  const rendered = previewFor(kind, form);
  const body = rendered
    .split('\n')
    .filter((line) => !line.startsWith('#'))
    .map((line) => (kind === 'port' ? line.replace(/,820,816$/, '') : line))
    .join('\n')
    .trimEnd();
  const target =
    kind === 'ssid'
      ? (form as SsidForm).plane || 'CENTRAL'
      : kind === 'port'
        ? (form as PortForm).device
        : (form as VlanForm).scope;
  return `${body}\n# target → ${target}\n# exact endpoint and impact are resolved by the broker dry run`;
}

function liveMetaFor(kind: ConfigKind, form: ConfigForm): string {
  if (kind === 'ssid') return `${(form as SsidForm).plane || 'CENTRAL'} · TEMPLATE PREVIEW`;
  if (kind === 'port') return `${(form as PortForm).device.toUpperCase()} · TEMPLATE PREVIEW`;
  return `${(form as VlanForm).scope.toUpperCase()} · TEMPLATE PREVIEW`;
}

function liveBlastFor(kind: ConfigKind, form: ConfigForm): BlastRadiusRow[] {
  if (kind === 'ssid') {
    return [
      { what: 'Access points that reload the profile', count: 'requires dry run' },
      { what: 'Client sessions that will re-authenticate', count: 'requires dry run' },
      { what: 'Target plane', count: (form as SsidForm).plane || 'CENTRAL' },
    ];
  }
  if (kind === 'port') {
    return [
      { what: 'Interfaces changed', count: '1 requested' },
      { what: 'Clients on this port right now', count: 'requires live read-back' },
      { what: 'Rollback snapshot', count: 'requested during dry run' },
    ];
  }
  return [
    { what: 'Switches in scope', count: 'requires dry run' },
    { what: 'Clients on this VLAN', count: 'not reported by config inventory' },
    { what: 'Configuration drift resolved', count: 'not available' },
  ];
}

function requireTicket(raw: unknown): string {
  const ticket = typeof raw === 'string' ? raw.trim() : '';
  if (ticket) return ticket;
  // In a lab there is nothing to authorise against, so a write does not need a
  // ticket. Still stamp one so the change log stays readable.
  if (allowsLabDirectWrites()) return 'LAB';
  throw new BrokerError(400, 'ticket reference required — writes are brokered, never standing');
}

/** The reference must name a REAL ticket — presence alone is not enough. */
function requireKnownTicket(raw: unknown, knownTicket: (id: string) => boolean): string {
  const ticket = requireTicket(raw);
  if (allowsLabDirectWrites()) return ticket;
  if (!knownTicket(ticket)) {
    throw new BrokerError(400, `unknown ticket '${ticket}' — writes reference a raised ticket (demo mode also accepts the fixture queue)`);
  }
  return ticket;
}

// ---------------------------------------------------------------------------
// Write target + push/read-back paths
// ---------------------------------------------------------------------------

type WriteTarget = 'central' | 'console';

/**
 * Where a change can go, per the shared capability matrix: an SSID whose
 * owning plane label is Mist-only is not writable THROUGH THIS BROKER — Mist
 * SSIDs write via the dedicated direct editor (ssidDirectWrite.ts), so the
 * ticketed queue hands off to the console. Everything else brokers through
 * Central in this build.
 */
function targetFor(kind: ConfigKind, form: ConfigForm): WriteTarget {
  if (kind === 'ssid') {
    const label = ((form as SsidForm).plane || 'CENTRAL').toUpperCase();
    if (label.includes('MIST') && !label.includes('CENTRAL')) return 'console';
  }
  return 'central';
}

const enc = encodeURIComponent;

/**
 * ONE conservative candidate path per kind — never a list. These are the
 * best-known new-Central config paths; a 404 is tolerated and reported as
 * "unverified against this tenant", never as success.
 *
 * SSID's case below is legacy/superseded: the real New Central write surface
 * is a WLAN profile upsert plus separate scope-map assignment (see
 * CentralAdapter.applySsidProfile()/ssidCatalog() and
 * services/ssidDirectWrite.ts), which this broker's one-ticket-one-PUT model
 * cannot express — a single PUT can neither create-vs-update correctly nor
 * assign scopes. Configure.tsx no longer calls queue()/dryRun()/push() for
 * kind 'ssid'; this branch remains only so the broker's generic ticket/lease/
 * snapshot/log mechanics stay exercised by kind-agnostic tests using 'ssid'
 * as their example kind, and so a change already queued under an older build
 * is still something push() can attempt rather than throw on unconditionally.
 */
function pushPathFor(kind: ConfigKind, form: ConfigForm): string {
  if (kind === 'ssid') return `/configuration/v2/wlan/${enc((form as SsidForm).group)}`;
  if (kind === 'vlan') {
    const f = form as VlanForm;
    return `/configuration/v2/vlan/${enc(f.scope)}/${enc(f.id)}`;
  }
  const f = form as PortForm;
  return `/configuration/v2/switch-port/${enc(f.serial ?? f.device)}/${enc(f.id)}`;
}

/** Read-back candidates for the rollback snapshot (GETs may safely try alternates). */
function readbackPathsFor(kind: ConfigKind, form: ConfigForm): string[] {
  const pushPath = pushPathFor(kind, form);
  if (kind === 'ssid') return [pushPath, '/configuration/v2/wlan'];
  if (kind === 'vlan') return [pushPath, `/configuration/v2/vlan/${enc((form as VlanForm).scope)}`];
  return [pushPath];
}

/** The structured body sent with the push PUT (the tenant's exact schema is unverified). */
function pushBodyFor(kind: ConfigKind, form: ConfigForm): Record<string, unknown> {
  if (kind === 'ssid') {
    const f = form as SsidForm;
    return {
      name: f.name,
      essid: f.name,
      vlan: f.vlan,
      security: f.security,
      group: f.group,
      bands: f.bands,
      broadcast: f.broadcast,
      isolate: f.isolate,
      excludeDfs: f.noDfs,
    };
  }
  if (kind === 'port') {
    const f = form as PortForm;
    return {
      device: f.serial ?? f.device,
      deviceName: f.device,
      ...(f.plane ? { plane: f.plane } : {}),
      ...(f.serial ? { serial: f.serial } : {}),
      interface: f.id,
      description: f.desc,
      mode: f.mode,
      vlan: f.vlan,
      poe: f.poe,
      dot1x: f.dot1x,
      mab: f.mab,
      adminUp: f.up,
    };
  }
  const f = form as VlanForm;
  return {
    id: f.id,
    name: f.name,
    dhcpHelpers: f.helpers
      .split(',')
      .map((h) => h.trim())
      .filter(Boolean),
    scope: f.scope,
  };
}

// ---------------------------------------------------------------------------
// Queue-row display strings (the broker is authoritative for what/where)
// ---------------------------------------------------------------------------

function whatFor(kind: ConfigKind, form: ConfigForm): string {
  if (kind === 'ssid') {
    const f = form as SsidForm;
    return `Update wireless SSID ${f.name || '(unnamed)'}`;
  }
  if (kind === 'port') {
    const f = form as PortForm;
    return `Port ${f.id} on ${f.device} — ${f.desc || 'no description'}`;
  }
  const f = form as VlanForm;
  return `VLAN ${f.id}${f.name ? ` ${f.name}` : ''}`;
}

function whereFor(kind: ConfigKind, form: ConfigForm, target: WriteTarget): string {
  if (target === 'console') return 'Mist · SSIDs write via the dedicated direct editor — this payload opens in console';
  if (kind === 'ssid') {
    const f = form as SsidForm;
    return `${f.plane || 'CENTRAL'} · target group ${f.group}`;
  }
  if (kind === 'port') {
    const f = form as PortForm;
    return `${f.device} · local collector, recorded session`;
  }
  const f = form as VlanForm;
  const scopeLabel = VLAN_SCOPE_OPTIONS.find((o) => o.value === f.scope)?.label ?? f.scope.toUpperCase();
  return `${scopeLabel} · local collector`;
}

function newChangeId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;
}

/** The broker data dir: HPE_DATA_DIR or <repo>/data. */
export function brokerDataDir(): string {
  if (process.env.HPE_DATA_DIR) return process.env.HPE_DATA_DIR;
  // server/src/services → repo root is three levels up.
  return path.resolve(__dirname, '..', '..', '..', 'data');
}

/** One audit-log line — no payload bodies, so no secrets. */
export interface BrokerLogEntry {
  ts: string;
  /**
   * Who made the change. Filled in from the request's authenticated principal
   * when it is omitted, which is every call site — see currentActor(). Reads
   * `operator` when the portal is running without an identity provider, which
   * is honest rather than absent.
   */
  who?: string;
  event: string;
  changeId: string;
  ticket: string;
  kind: string;
  result: string;
  httpCode?: number;
  /**
   * The PLANE's own handle for the change, when it issued one — distinct from
   * `changeId`, which is the portal's. A write the plane merely accepted for
   * asynchronous validation is settled somewhere the portal cannot see, so
   * this is the only thing that ties this row to whatever the plane
   * eventually did with it. Without it the audit trail records, permanently,
   * that something was submitted and offers no way to find out how it ended.
   */
  transactionId?: string | null;
  callbackValidatedAt?: string;
  device?: string;
  plane?: string;
  serial?: string | null;
}

/**
 * Append-only audit trail shared by the config broker and the reboot action:
 * one JSON line per event in change-log.jsonl (mode 0600). A log failure must
 * not fail the pipeline; it is shouted to the server console instead.
 */
export function appendBrokerLog(dataDir: string, entry: BrokerLogEntry): void {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    const file = path.join(dataDir, 'change-log.jsonl');
    // Checked on write rather than on a timer: no scheduler to own, and no
    // behaviour that depends on the process having been up long enough.
    rotateIfNeeded(file);
    // Attribution is applied here, once, rather than at each of the ~18 call
    // sites: a missed call site would write an anonymous line, and an audit
    // trail with holes in it is worse than one with none because it looks
    // complete.
    const line: BrokerLogEntry = { ...entry, who: entry.who ?? currentActor() };
    fs.appendFileSync(file, JSON.stringify(line) + '\n', { mode: 0o600 });
    fs.chmodSync(file, 0o600); // in case it pre-existed with a looser mode
  } catch (err) {
    console.error(`write broker: change-log write failed: ${(err as Error).message}`);
  }
}

export interface WriteBrokerOptions {
  registry?: PlaneRegistry; // default: the process-wide singleton
  pollerRef?: Poller; // default: the process-wide poller — re-read after a push
  transport?: BrokerTransport | null; // undefined → resolve the CentralAdapter from the registry
  dataDir?: string; // default: HPE_DATA_DIR or <repo>/data
  nowMs?: () => number; // injected clock for tests (lease/snapshot timing)
  knownTicket?: (id: string) => boolean; // default: the ticket store (+ fixture ids in demo mode)
  listDevices?: () => Array<{
    name: string;
    plane: Plane | string;
    serial?: string;
    claimedBy?: Plane[];
  }>;
  /** Canonical VLAN identities available to the Central broker. */
  listVlans?: () => ReadonlyArray<Pick<VlanObject, 'id' | 'scope' | 'plane' | 'origin'>>;
  /** Process-side test seam. Production always evaluates canonical settings. */
  admitWrite?: AdmitWrite;
}

// ---------------------------------------------------------------------------
// The broker
// ---------------------------------------------------------------------------

/** One line of the brokered-write audit log: what happened to a change, never
 *  what was in it. Rendered configuration bodies are deliberately absent. */
export interface BrokerEventRow {
  ts: string;
  event: string;
  changeId: string;
  ticket: string;
  kind: string;
  result: string;
}

export class WriteBroker {
  private readonly registry: PlaneRegistry;
  private readonly pollerRef: Poller;
  private readonly transportOverride: BrokerTransport | null | undefined;
  private readonly dataDir: string;
  private readonly nowMs: () => number;
  private readonly knownTicket: (id: string) => boolean;
  private readonly listDevices: NonNullable<WriteBrokerOptions['listDevices']>;
  private readonly listVlans: NonNullable<WriteBrokerOptions['listVlans']>;
  private readonly admitWrite: AdmitWrite;
  private changes: BrokeredChange[] | null = null; // lazy-loaded from disk
  private readonly pushing = new Set<string>(); // change ids with a push in flight (double-apply guard)
  /** One lock domain for every path that can mutate an exact Central target. */
  private readonly mutatingTargets = new Set<string>();

  constructor(opts: WriteBrokerOptions = {}) {
    this.registry = opts.registry ?? defaultRegistry;
    this.pollerRef = opts.pollerRef ?? defaultPoller;
    this.transportOverride = opts.transport;
    this.dataDir = opts.dataDir ?? brokerDataDir();
    this.nowMs = opts.nowMs ?? (() => Date.now());
    this.knownTicket = opts.knownTicket ?? ((id) => knownTicketId(id, settings.get().demoMode));
    const hasTransportTestSeam = Object.prototype.hasOwnProperty.call(opts, 'transport');
    this.listDevices = opts.listDevices ?? (() => {
      const devices = settings.get().demoMode ? DEVICES : defaultPoller.getCache().devices;
      return devices.map((device) => ({
        name: device.name,
        plane: device.plane,
        ...(device.serial ? { serial: device.serial } : {}),
        ...(device.claimedBy ? { claimedBy: device.claimedBy } : {}),
      }));
    });
    this.listVlans = opts.listVlans ?? (hasTransportTestSeam
      ? (() => [{ id: '812', scope: 'cx-campus-01', plane: 'CENTRAL', origin: 'configured' }])
      : (() => {
          const config = this.pollerRef.contributionsByPlane().get('central')?.config;
          if (config?.mode !== 'configured') return [];
          return (config.vlans ?? []).map((vlan) => ({
            id: vlan.id,
            ...(vlan.scope ? { scope: vlan.scope } : {}),
            plane: 'CENTRAL' as const,
            origin: vlan.origin ?? 'configured',
          }));
        }));
    this.admitWrite = opts.admitWrite ?? (hasTransportTestSeam
      ? ((request) => ({ ok: true, plane: request.plane, adapter: this.registry.get(request.plane) }))
      : ((request) => evaluateWriteAdmission(request, { registry: this.registry })));
  }

  private actionForm(kind: ConfigKind, form: ConfigForm): ConfigForm {
    if (kind === 'vlan') {
      const vlan = form as VlanForm;
      if (vlan.plane !== 'CENTRAL') {
        throw new BrokerError(
          409,
          vlan.plane
            ? `generic VLAN writes require a Central-owned target; received ${vlan.plane}`
            : 'generic VLAN writes require proven Central ownership; target plane was not reported',
        );
      }
      const target = this.listVlans().find(
        (candidate) =>
          candidate.origin === 'configured' &&
          candidate.plane === 'CENTRAL' &&
          candidate.id === vlan.id &&
          candidate.scope === vlan.scope,
      );
      if (!target?.scope) {
        throw new BrokerError(
          404,
          `VLAN ${vlan.id} in scope '${vlan.scope}' was not found in configured Central VLAN inventory`,
        );
      }
      return { ...vlan, id: target.id, scope: target.scope, plane: 'CENTRAL' };
    }
    if (kind !== 'port') return form;
    const port = form as PortForm;
    const hasPlane = typeof port.plane === 'string' && port.plane.trim().length > 0;
    const hasSerial = typeof port.serial === 'string' && port.serial.trim().length > 0;
    if (hasPlane !== hasSerial) {
      throw new BrokerError(400, 'port device plane and serial must be supplied together');
    }
    const resolution = resolveDeviceIdentity(
      this.listDevices(),
      port.device,
      { plane: port.plane, serial: port.serial },
      { requireCompleteIdentity: true, requireNameMatch: true },
    );
    if (resolution.invalid) throw new BrokerError(409, resolution.invalid);
    if (resolution.ambiguous) {
      throw new BrokerError(
        409,
        `'${port.device}' names ${resolution.ambiguous.length} devices — pass plane and serial (${safeDeviceCandidates(resolution.ambiguous)
          .map((candidate) => `${candidate.plane}/${candidate.serial ?? 'no-serial'}`)
          .join(', ')})`,
      );
    }
    if (!resolution.device) {
      throw new BrokerError(404, `device '${port.device}' not found in inventory`);
    }
    if (resolution.device.plane !== 'CENTRAL') {
      throw new BrokerError(
        409,
        `generic port writes require a Central-owned target; '${port.device}' belongs to ${resolution.device.plane}`,
      );
    }
    const { plane: _plane, serial: _serial, ...rest } = port;
    return resolution.device.serial && resolution.device.plane
      ? {
          ...rest,
          device: resolution.device.name,
          plane: resolution.device.plane as Plane,
          serial: resolution.device.serial,
        }
      : { ...rest, device: resolution.device.name };
  }

  // -- render -----------------------------------------------------------------

  /** Pure render through the shared preview functions — no ticket needed. */
  renderPayload(kind: unknown, form: unknown): RenderedPayload {
    const k = asConfigKind(kind);
    const f = asForm(k, form);
    if (!settings.get().demoMode) {
      return { rendered: livePreviewFor(k, f), meta: liveMetaFor(k, f), blastRadius: liveBlastFor(k, f) };
    }
    return { rendered: previewFor(k, f), meta: metaFor(k, f), blastRadius: blastFor(k, f) };
  }

  // -- immediate lab apply ----------------------------------------------------

  /**
   * Apply one supported generic Central object immediately in lab mode. This
   * bypasses only the ticket/queue/lease/dry-run ceremony: validation, target
   * selection, Central transport, post-write refresh, and audit logging stay
   * on the same paths as the hardened broker workflow.
   */
  async apply(kind: unknown, form: unknown): Promise<ImmediateApplyResult> {
    if (!allowsLabDirectWrites()) {
      throw new BrokerError(409, 'immediate apply is disabled — use the ticketed dry-run, queue, and push workflow');
    }
    const k = asConfigKind(kind);
    if (k === 'ssid') {
      throw new BrokerError(400, 'SSID writes use the dedicated scoped profile apply service');
    }
    const f = this.actionForm(k, asForm(k, form));
    if (targetFor(k, f) !== 'central') {
      throw new BrokerError(409, 'read-only plane — open the Mist console with the rendered payload; the portal cannot apply it');
    }
    const transport = this.centralWriteTransport();

    const path = pushPathFor(k, f);
    const targetKey = `${k}:${path}`;
    if (this.mutatingTargets.has(targetKey)) {
      throw new BrokerError(409, `a write is already in flight for this ${k} target — wait for it to finish`);
    }

    const changeId = newChangeId('apply');
    const audit = { changeId, ticket: 'LAB', kind: k };
    this.mutatingTargets.add(targetKey);
    try {
      let res: BrokerResponse;
      try {
        res = await transport.request('PUT', path, pushBodyFor(k, f));
      } catch {
        this.log({ event: 'apply', ...audit, result: 'outcome-unknown (reconciliation required)' });
        return {
          changeId,
          kind: k,
          ok: false,
          outcomeUnknown: true,
          message:
            'outcome unknown — the Central request lost transport confirmation and may have been applied; reconcile the target before any retry',
        };
      }

      if (res.status >= 200 && res.status < 300) {
        const accepted = res.status === 202;
        this.log({
          event: 'apply',
          ...audit,
          result: accepted ? 'accepted (unconfirmed)' : 'applied',
          httpCode: res.status,
        });
        const cacheRefresh = await this.refreshCache(k, accepted);
        return {
          changeId,
          kind: k,
          ok: true,
          applied: !accepted,
          accepted,
          httpCode: res.status,
          cacheRefresh,
          message: accepted
            ? 'accepted for later action by Central — HTTP 202; Central has NOT confirmed the change is in effect, so verify it on the plane before relying on it'
            : `accepted by Central — HTTP ${res.status}`,
        };
      }

      const unverified = res.status === 404;
      this.log({
        event: 'apply',
        ...audit,
        result: unverified ? 'unverified-path' : 'rejected',
        httpCode: res.status,
      });
      return {
        changeId,
        kind: k,
        ok: false,
        applied: false,
        httpCode: res.status,
        message: unverified
          ? 'apply path unverified against this tenant — payload rendered, manual apply advised'
          : `apply failed — Central answered HTTP ${res.status}`,
      };
    } finally {
      this.mutatingTargets.delete(targetKey);
    }
  }

  // -- dry run ------------------------------------------------------------------

  /**
   * Ticket-gated rehearsal. Renders, and when the target is a linked Central
   * does a read-back GET of the affected object (candidate paths, 404
   * tolerated) stored as the rollback snapshot. Unlinked or read-only targets
   * get an honest render-only result.
   */
  async dryRun(kind: unknown, form: unknown, ticketRaw: unknown): Promise<DryRunResult> {
    const k = asConfigKind(kind);
    const f = this.actionForm(k, asForm(k, form));
    const ticket = requireKnownTicket(ticketRaw, this.knownTicket);
    const rendered = this.renderPayload(k, f);
    const base = { kind: k, ticket, ...rendered };
    const target = targetFor(k, f);
    const changeId = newChangeId('dry');

    if (target === 'console') {
      this.log({ event: 'dry-run', changeId, ticket, kind: k, result: 'render-only (read-only plane)' });
      return {
        ...base,
        ok: true,
        target: 'console',
        reachable: null,
        snapshot: false,
        note: 'Mist is read-only from here — render-only dry run; the change opens in the Mist console with this payload pre-filled',
      };
    }

    const transport = this.centralTransport();
    if (!transport) {
      this.log({ event: 'dry-run', changeId, ticket, kind: k, result: 'render-only (central not linked)' });
      return {
        ...base,
        ok: true,
        target: 'central',
        reachable: null,
        snapshot: false,
        note: 'central not linked — render-only dry run, no read-back attempted',
      };
    }

    try {
      for (const p of readbackPathsFor(k, f)) {
        const res = await transport.request('GET', p);
        if (res.status === 404) continue;
        if (res.status >= 200 && res.status < 300) {
          this.saveSnapshot(changeId, {
            changeId,
            ticket,
            kind: k,
            path: p,
            takenAt: new Date(this.nowMs()).toISOString(),
            body: res.body,
          });
          this.log({ event: 'dry-run', changeId, ticket, kind: k, result: 'snapshot-taken', httpCode: res.status });
          return {
            ...base,
            ok: true,
            target: 'central',
            reachable: true,
            snapshot: true,
            httpCode: res.status,
            note: 'target reachable, current state snapshot taken',
          };
        }
        this.log({ event: 'dry-run', changeId, ticket, kind: k, result: 'read-back failed', httpCode: res.status });
        return {
          ...base,
          ok: false,
          target: 'central',
          reachable: false,
          snapshot: false,
          httpCode: res.status,
          note: `read-back failed — HTTP ${res.status} from the gateway; render-only`,
        };
      }
      this.log({ event: 'dry-run', changeId, ticket, kind: k, result: 'no existing object', httpCode: 404 });
      return {
        ...base,
        ok: true,
        target: 'central',
        reachable: true,
        snapshot: false,
        httpCode: 404,
        note: 'target reachable — no existing object at the read-back path (404); nothing to snapshot',
      };
    } catch (err) {
      this.log({ event: 'dry-run', changeId, ticket, kind: k, result: 'read-back error' });
      return {
        ...base,
        ok: false,
        target: 'central',
        reachable: false,
        snapshot: false,
        note: `read-back failed — ${(err as Error).message}; render-only`,
      };
    }
  }

  // -- queue ------------------------------------------------------------------

  /**
   * Ticket-gated enqueue. State: 'console' when the target plane is read-only
   * (Mist per the capability matrix), 'ready' when Central is writable
   * (linked real adapter), else 'needs window'. Ready changes carry the
   * 15-minute write lease.
   */
  queue(kind: unknown, form: unknown, ticketRaw: unknown): BrokeredChange {
    const k = asConfigKind(kind);
    const f = this.actionForm(k, asForm(k, form));
    const ticket = requireKnownTicket(ticketRaw, this.knownTicket);
    const target = targetFor(k, f);
    const writable = target === 'central' && this.canWriteCentral();
    const state: ChangeState = target === 'console' ? 'console' : writable ? 'ready' : 'needs window';
    const now = this.nowMs();
    const change: BrokeredChange = {
      id: newChangeId('chg'),
      object: { kind: k, form: f },
      what: whatFor(k, f),
      ticket,
      state,
      where: whereFor(k, f, target),
      rendered: previewFor(k, f),
      createdAt: new Date(now).toISOString(),
      expiresAt: state === 'ready' ? new Date(now + LEASE_MS).toISOString() : null,
      dryRunId: state === 'ready' ? this.freshDryRunId(k, f, ticket) : null,
    };
    this.saveQueue([...this.loadQueue(), change]);
    this.log({ event: 'queue', changeId: change.id, ticket, kind: k, result: state });
    return { ...change };
  }

  list(): BrokeredChange[] {
    return this.loadQueue().map((c) => ({ ...c }));
  }

  /**
   * Tail of the brokered-write audit log, newest first — feeds the Overview
   * change log in live mode. Corrupt lines are skipped, never fatal.
   */
  recentEvents(limit = 4): BrokerEventRow[] {
    return this.readRecentEvents(limit).events;
  }

  /**
   * The same read, plus what it did not see.
   *
   * Callers that render the audit log to an operator must use this one. An
   * unreadable generation makes the log come back short — and a short audit
   * log is indistinguishable from a quiet one unless something says otherwise.
   * "Nothing was brokered here" and "part of the record is unreachable" are
   * opposite claims and the drawer must never substitute the first for the
   * second.
   *
   * `truncated` is the same claim about the other cause of a short read: the
   * limit was reached and there were more events behind it. A caller taking a
   * WINDOW (the four most recent) expects that and should ignore it. A caller
   * COUNTING (how many pushes today) must not — its total is then a floor,
   * not a total.
   */
  readRecentEvents(limit = 4): { events: BrokerEventRow[]; unreadable: string[]; truncated: boolean } {
    // Reads across rotated generations. Without that, the first rotation would
    // make the Change history drawer look as though everything before it never
    // happened — the entries are still on disk.
    const isEvent = (v: unknown): v is BrokerEventRow =>
      typeof v === 'object' && v !== null && typeof (v as { ts?: unknown }).ts === 'string';
    const read = readJsonlNewestFirst<BrokerEventRow>(this.logFile, limit, isEvent);
    return { events: read.entries, unreadable: read.unreadable, truncated: read.truncated };
  }

  // -- push -------------------------------------------------------------------

  /**
   * Execute a queued change. Only 'ready' changes push; the ticket is
   * required again and the 15-minute lease must still be open (409 "lease
   * expired — re-queue"). A rollback snapshot is taken from a read-back GET
   * before the PUT when none is on file yet. Success is claimed ONLY on a
   * 2xx; a 404 means the path is unverified against this tenant (payload
   * rendered, manual apply advised) and any other failure keeps the change
   * queued — all reported honestly.
   *
   * A second push for a change already being pushed answers 409 "push
   * already in flight": the state/lease checks all pass before any network
   * I/O, so without the guard two concurrent pushes would both apply it.
   */
  async push(changeIdRaw: unknown): Promise<PushResult> {
    const id = asChangeId(changeIdRaw);
    if (this.pushing.has(id)) {
      throw new BrokerError(409, `push already in flight for change '${id}' — wait for it to finish`);
    }
    const change = this.getChange(id);
    const form = this.actionForm(change.object.kind, change.object.form);
    const targetKey = `${change.object.kind}:${pushPathFor(change.object.kind, form)}`;
    if (this.mutatingTargets.has(targetKey)) {
      throw new BrokerError(409, `a write is already in flight for this ${change.object.kind} target — wait for it to finish`);
    }
    this.pushing.add(id);
    this.mutatingTargets.add(targetKey);
    try {
      return await this.executePush(id, form);
    } finally {
      this.pushing.delete(id);
      this.mutatingTargets.delete(targetKey);
    }
  }

  /** The push pipeline itself — re-entry is guarded by push(). */
  private async executePush(changeIdRaw: unknown, resolvedForm?: ConfigForm): Promise<PushResult> {
    const change = this.getChange(changeIdRaw);
    const { kind } = change.object;
    const form = resolvedForm ?? this.actionForm(kind, change.object.form);
    const base = { changeId: change.id, ticket: change.ticket, kind };

    if (!change.ticket.trim()) throw new BrokerError(400, 'change has no ticket reference — discard and re-queue with a ticket');
    if (change.state === 'console') {
      throw new BrokerError(409, 'read-only plane — open the Mist console with the rendered payload; the portal cannot push it');
    }
    if (change.state !== 'ready') {
      throw new BrokerError(409, `change is '${change.state}' — only ready changes can be pushed`);
    }
    if (change.expiresAt !== null && this.nowMs() > Date.parse(change.expiresAt)) {
      this.log({ event: 'push', ...base, result: 'lease-expired' });
      throw new BrokerError(409, 'lease expired — re-queue');
    }
    // Re-evaluated for every push: revoking the stored grant after queueing
    // immediately closes the live mutation boundary.
    const transport = this.centralWriteTransport();

    // Persist an in-progress state before external I/O. If the process dies
    // after Central applies the change, restart will not present it as ready
    // for replay.
    this.saveQueue(
      this.loadQueue().map((queued) =>
        queued.id === change.id ? { ...queued, state: 'applying', expiresAt: null } : queued,
      ),
    );

    // Rollback snapshot: reuse the dry-run's if still fresh, else read back now.
    let snapshot = false;
    if (change.dryRunId) {
      const drySnap = this.readSnapshot(change.dryRunId);
      if (drySnap) {
        // Re-file it under the queued change's id — rollback lookup is by change id.
        this.saveSnapshot(change.id, { ...drySnap, changeId: change.id });
        snapshot = true;
      }
    }
    if (!snapshot) {
      try {
        for (const p of readbackPathsFor(kind, form)) {
          const res = await transport.request('GET', p);
          if (res.status >= 200 && res.status < 300) {
            this.saveSnapshot(change.id, {
              changeId: change.id,
              ticket: change.ticket,
              kind,
              path: p,
              takenAt: new Date(this.nowMs()).toISOString(),
              body: res.body,
            });
            snapshot = true;
            break;
          }
          if (res.status !== 404) break; // a real error — stop trying alternates
        }
      } catch {
        // Best-effort: a missing snapshot never blocks the push, but the
        // result says plainly when none could be taken.
      }
    }

    let res: { status: number; body: unknown };
    try {
      res = await transport.request('PUT', pushPathFor(kind, form), pushBodyFor(kind, form));
    } catch {
      // Do not restore `ready`: the request may have reached Central. Keeping
      // the durable `applying` marker prevents an unsafe replay after restart.
      this.log({ event: 'push', ...base, result: 'outcome-unknown (reconciliation required)' });
      return {
        ...base,
        ok: false,
        outcomeUnknown: true,
        snapshot,
        message:
          'outcome unknown — Central transport confirmation was lost; the change remains applying and requires reconciliation before any retry',
      };
    }

    if (res.status >= 200 && res.status < 300) {
      // A 202 is not a completed write. Central answers it for work it will
      // carry out afterwards, and the tenant's exact behaviour here is
      // unverified (see pushBodyFor), so this cannot be assumed away. It gets
      // its own outcome rather than being flattened into either side:
      //
      //  - not `applied`, because the UI renders that as a green "done" toast
      //    and nothing would ever tell the operator it had not landed;
      //  - not a failure either, because the plane has the request. Re-queueing
      //    it would invite a second PUT and a duplicate write.
      //
      // So the change comes off the queue exactly as a success does — there is
      // nothing left to push — but the operator is told to go and confirm it.
      const accepted = res.status === 202;
      const queue = [...this.loadQueue()];
      const idx = queue.findIndex((c) => c.id === change.id);
      let cleanupFailed = false;
      if (idx >= 0) {
        queue.splice(idx, 1);
        try {
          this.saveQueue(queue);
        } catch {
          cleanupFailed = true;
        }
        this.log({
          event: 'push',
          ...base,
          result: accepted ? 'accepted (unconfirmed)' : 'applied',
          httpCode: res.status,
        });
      } else {
        // Discarded while the PUT was in flight: applied on the plane, already
        // off the queue — never splice(-1) an unrelated change out from under it.
        this.log({
          event: 'push',
          ...base,
          result: accepted ? 'accepted (unconfirmed, discarded mid-push)' : 'applied (discarded mid-push)',
          httpCode: res.status,
        });
      }
      // The queue is settled; now make the screen's next read of the estate
      // include what was just pushed.
      const cacheRefresh = await this.refreshCache(kind, accepted);
      if (cleanupFailed) {
        return {
          ...base,
          ok: true,
          applied: !accepted,
          accepted,
          httpCode: res.status,
          snapshot,
          cacheRefresh,
          message:
            `${accepted ? 'accepted for later action by Central' : 'accepted by Central'} — HTTP ${res.status}; queue cleanup failed, so the change remains marked applying and cannot replay automatically`,
        };
      }
      return {
        ...base,
        ok: true,
        applied: !accepted,
        accepted,
        httpCode: res.status,
        snapshot,
        cacheRefresh,
        message:
          (accepted
            ? `accepted for later action by Central — HTTP 202; Central has NOT confirmed the change is in effect, so verify it on the plane before relying on it. `
            : `accepted by Central — HTTP ${res.status}; `) +
          (snapshot ? 'rollback snapshot on file, kept 24h' : 'no pre-existing object to snapshot') +
          (idx < 0 ? '; note: the change was discarded while the push was in flight' : ''),
      };
    }
    if (res.status === 404) {
      this.restoreQueuedChange(change);
      this.log({ event: 'push', ...base, result: 'unverified-path', httpCode: res.status });
      return {
        ...base,
        ok: false,
        applied: false,
        httpCode: res.status,
        snapshot,
        message: 'push path unverified against this tenant — payload rendered, manual apply advised; the change stays queued',
      };
    }
    this.restoreQueuedChange(change);
    this.log({ event: 'push', ...base, result: 'rejected', httpCode: res.status });
    return {
      ...base,
      ok: false,
      applied: false,
      httpCode: res.status,
      snapshot,
      message: `push failed — Central answered HTTP ${res.status}; the change stays queued`,
    };
  }

  // -- discard ------------------------------------------------------------------

  discard(changeIdRaw: unknown): { ok: true; changeId: string } {
    const id = asChangeId(changeIdRaw);
    const queue = [...this.loadQueue()];
    const idx = queue.findIndex((c) => c.id === id);
    if (idx < 0) throw new BrokerError(404, `change '${id}' not in the queue`);
    const [change] = queue.splice(idx, 1);
    this.saveQueue(queue);
    fs.rmSync(this.snapshotPath(id), { force: true }); // never pushed — nothing to roll back
    this.log({ event: 'discard', changeId: id, ticket: change.ticket, kind: change.object.kind, result: 'discarded' });
    return { ok: true, changeId: id };
  }

  // -- internals ----------------------------------------------------------------

  /** The Central adapter as a push transport; null when Central can't write. */
  /**
   * Force one Central pull after a push so the Configure lists reflect it.
   *
   * Those lists — SSIDs, VLANs, switch ports — are served from the poll cache,
   * and they are the evidence the operator uses to decide whether a push
   * worked. Leaving them showing the pre-change estate under a green "applied"
   * toast argues for the wrong conclusion, and the natural response to it is
   * to queue the change again.
   *
   * A 202 gets no refresh: Central has taken the request and not acted on it,
   * so a re-read would only assert more confidently that nothing has changed.
   * A refresh failure never fails the push — the change is already on the
   * plane; only the view of it is behind, and that is reported rather than
   * assumed.
   */
  private async refreshCache(kind: ConfigKind, accepted: boolean): Promise<WriteCacheRefresh> {
    if (accepted) return { attempted: false, ok: false };
    try {
      const tick = await this.pollerRef.syncNowFor('central');
      if (tick !== 'ok') {
        return { attempted: true, ok: false, message: `Central could not be re-read (poll ${tick})` };
      }
      // Check the section that would actually show this change. Central omits
      // sections it could not read rather than sending them empty, so an
      // absent one means unread — a pull that completed without it leaves the
      // list exactly as stale as a failed pull would.
      const config = this.pollerRef.contributionsByPlane().get('central')?.config;
      const section = kind === 'ssid' ? config?.ssids : kind === 'vlan' ? config?.vlans : config?.ports;
      if (!section) {
        return { attempted: true, ok: false, message: `Central was re-read but returned no ${kind} list` };
      }
      return { attempted: true, ok: true };
    } catch (err) {
      // Secret-free: the poller's own message can carry a URL or vendor body.
      console.error(`central cache refresh failed: ${(err as Error).message}`);
      return { attempted: true, ok: false, message: 'Central could not be re-read' };
    }
  }

  private centralTransport(): BrokerTransport | null {
    if (this.transportOverride !== undefined) return this.transportOverride;
    const adapter = this.registry.get('central');
    return adapter instanceof CentralAdapter ? adapter : null;
  }

  /** Admission and transport resolution are one operation at the write edge. */
  private centralWriteTransport(): BrokerTransport {
    const admission = this.admitWrite({ operation: 'central-broker', plane: 'central' });
    if (!admission.ok) throw new BrokerError(admission.status, admission.message);
    if (this.transportOverride !== undefined) {
      if (this.transportOverride) return this.transportOverride;
      throw new BrokerError(409, 'central is not linked — no admitted write transport is available');
    }
    const adapter = admission.adapter as unknown as Partial<BrokerTransport>;
    if (typeof adapter.request !== 'function') {
      throw new BrokerError(409, 'central adapter does not expose the admitted broker transport');
    }
    return adapter as BrokerTransport;
  }

  private canWriteCentral(): boolean {
    try {
      this.centralWriteTransport();
      return true;
    } catch {
      return false;
    }
  }

  private getChange(raw: unknown): BrokeredChange {
    const id = asChangeId(raw);
    const change = this.loadQueue().find((c) => c.id === id);
    if (!change) throw new BrokerError(404, `change '${id}' not in the queue`);
    return change;
  }

  private restoreQueuedChange(change: BrokeredChange): void {
    const queue = [...this.loadQueue()];
    const idx = queue.findIndex((queued) => queued.id === change.id);
    if (idx >= 0 && queue[idx].state === 'applying') {
      queue[idx] = change;
      this.saveQueue(queue);
    }
  }

  private get queueFile(): string {
    return path.join(this.dataDir, 'change-queue.json');
  }

  private get logFile(): string {
    return path.join(this.dataDir, 'change-log.jsonl');
  }

  private get snapshotsDir(): string {
    return path.join(this.dataDir, 'snapshots');
  }

  private loadQueue(): BrokeredChange[] {
    if (this.changes !== null) return this.changes;
    this.changes = [];
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(this.queueFile, 'utf8'));
      if (Array.isArray(parsed)) this.changes = parsed as BrokeredChange[];
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error(
          `write broker: could not read ${this.queueFile} — starting with an empty queue: ${(err as Error).message}`,
        );
      }
    }
    return this.changes;
  }

  /** Atomic write: tmp file + rename, mode 0600 throughout. */
  private saveQueue(next: BrokeredChange[]): void {
    fs.mkdirSync(this.dataDir, { recursive: true });
    const tmp = `${this.queueFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, this.queueFile);
    this.changes = next;
  }

  /**
   * Append-only audit trail: {ts, event, changeId, ticket, kind, result,
   * httpCode?} — no payload bodies, so no secrets. A log failure must not
   * fail the pipeline; it is shouted to the server console instead.
   */
  private log(entry: {
    event: 'apply' | 'dry-run' | 'queue' | 'push' | 'discard';
    changeId: string;
    ticket: string;
    kind: ConfigKind;
    result: string;
    httpCode?: number;
  }): void {
    appendBrokerLog(this.dataDir, { ts: new Date(this.nowMs()).toISOString(), ...entry });
  }

  /** Change ids are broker-generated; sanitize before touching the filesystem. */
  private snapshotPath(changeId: string): string {
    return path.join(this.snapshotsDir, `${changeId.replace(/[^A-Za-z0-9_-]/g, '')}.json`);
  }

  private saveSnapshot(changeId: string, record: SnapshotRecord): void {
    fs.mkdirSync(this.snapshotsDir, { recursive: true });
    const file = this.snapshotPath(changeId);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(record, null, 2) + '\n', { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, file);
    this.sweepSnapshots();
  }

  /**
   * Drop snapshot files past the TTL. The per-id mtime check in readSnapshot
   * only ever sees ids that are read — dry-*.json files never are — so the
   * sweep runs on every save to keep data/snapshots bounded. Best-effort.
   */
  private sweepSnapshots(): void {
    try {
      for (const name of fs.readdirSync(this.snapshotsDir)) {
        if (!name.endsWith('.json')) continue;
        const file = path.join(this.snapshotsDir, name);
        try {
          if (this.nowMs() - fs.statSync(file).mtimeMs > SNAPSHOT_TTL_MS) fs.rmSync(file, { force: true });
        } catch {
          /* one unreadable file must not stop the sweep */
        }
      }
    } catch {
      /* snapshots dir unreadable — nothing to sweep */
    }
  }

  /**
   * The freshest unexpired dry-run snapshot for this kind/form/ticket, when one
   * is on file — queued changes carry its id so push() can reuse it instead of
   * a second read-back. Best-effort: a corrupt file is skipped, never fatal.
   */
  private freshDryRunId(kind: ConfigKind, form: ConfigForm, ticket: string): string | null {
    const paths = readbackPathsFor(kind, form);
    let best: { id: string; mtimeMs: number } | null = null;
    try {
      for (const name of fs.readdirSync(this.snapshotsDir)) {
        if (!name.startsWith('dry-') || !name.endsWith('.json')) continue;
        const file = path.join(this.snapshotsDir, name);
        try {
          const stat = fs.statSync(file);
          if (this.nowMs() - stat.mtimeMs > SNAPSHOT_TTL_MS) continue;
          const rec = JSON.parse(fs.readFileSync(file, 'utf8')) as SnapshotRecord;
          if (rec.ticket !== ticket || rec.kind !== kind || !paths.includes(rec.path)) continue;
          if (!best || stat.mtimeMs > best.mtimeMs) best = { id: rec.changeId, mtimeMs: stat.mtimeMs };
        } catch {
          /* skip unreadable/corrupt snapshot */
        }
      }
    } catch {
      /* no snapshots dir yet */
    }
    return best ? best.id : null;
  }

  /** Rollback snapshots live 24h — enforced by an mtime check on read. */
  readSnapshot(changeId: string): SnapshotRecord | null {
    const file = this.snapshotPath(changeId);
    try {
      const stat = fs.statSync(file);
      if (this.nowMs() - stat.mtimeMs > SNAPSHOT_TTL_MS) {
        fs.rmSync(file, { force: true });
        return null;
      }
      return JSON.parse(fs.readFileSync(file, 'utf8')) as SnapshotRecord;
    } catch {
      return null;
    }
  }
}

function asChangeId(raw: unknown): string {
  const id = typeof raw === 'string' ? raw.trim() : '';
  if (!id) throw new BrokerError(400, 'changeId is required');
  return id;
}

/** Process-wide singleton. */
export const writeBroker = new WriteBroker();
