/**
 * server/src/services/clearpassDirectWrite.ts — the ClearPass direct-write
 * pipeline.
 *
 * ClearPass has no ticket queue of its own, and the two datasets the portal
 * operates on it — the endpoint repository and the local-user list — are not
 * configuration the ticketed write broker's one-ticket-one-PUT model fits
 * either. So they take the same direct-write path the SSID editor set
 * (services/ssidDirectWrite.ts): hardened mode requires an explicit review
 * confirmation, while lab mode applies immediately. The form is validated
 * against THAT plane's rules, the adapter
 * writes AND reads back, and ONE audit-log line per attempt lands in the
 * broker's own change-log.jsonl so the Configure "Change history" drawer
 * stays one place for every brokered AND direct write.
 *
 * The four writes — endpoint register, endpoint update, local-user create,
 * local-user update — are the whole surface. Policy itself is NEVER written
 * here: services, enforcement policies and roles are edited in ClearPass, and
 * this module grows nothing that touches them.
 *
 * Local-user passwords are WRITE-ONLY. One exists in this process for exactly
 * as long as it takes to build the outbound request body: it is never logged
 * (the audit line carries kind + outcome, no payload), never echoed in a
 * result message (those are fixed strings with an HTTP code at most), and
 * never read back (the adapter's verify whitelists rows the same way the
 * poller's read does).
 *
 * Demo mode never touches the registry: it validates against the fixture
 * role inventory and answers a canned successful apply, exactly like every
 * other /api demo fixture, so the ClearPass screen's drawers showcase end to
 * end without a linked CPPM — and says plainly that nothing left the portal.
 */

import { randomUUID } from 'node:crypto';
import {
  CLEARPASS_ENDPOINT_STATUSES,
  CLEARPASS_ROLES,
  normalizeMac,
  type ClearPassEndpointRegisterForm,
  type ClearPassEndpointStatus,
  type ClearPassEndpointUpdateForm,
  type ClearPassLocalUserCreateForm,
  type ClearPassLocalUserUpdateForm,
  type ClearPassWriteResult,
  type WriteCacheRefresh,
} from '@hpe/shared';
import { ClearPassAdapter } from '../planes/clearpass';
import { PlaneRegistry, registry as defaultRegistry } from '../planes/registry';
import { poller as defaultPoller, type Poller } from './poller';
import { appendBrokerLog, brokerDataDir } from './writeBroker';
import { settings } from '../config/settings';
import { allowsLabDirectWrites } from './labWritePolicy';
import { evaluateWriteAdmission, type AdmitWrite } from './writeAdmission';

export class ClearPassDirectWriteError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ClearPassDirectWriteError';
  }
}

/** The ClearPass-adapter surface this service actually needs — structural,
 *  not `instanceof ClearPassAdapter`, so tests inject a plain stub the same
 *  way ssidDirectWrite.ts's SsidWritePlane does. */
export interface ClearPassWritePlane {
  registerEndpoint(form: ClearPassEndpointRegisterForm): Promise<ClearPassWriteResult>;
  updateEndpoint(id: string, form: ClearPassEndpointUpdateForm): Promise<ClearPassWriteResult>;
  createLocalUser(form: ClearPassLocalUserCreateForm): Promise<ClearPassWriteResult>;
  updateLocalUser(id: string, form: ClearPassLocalUserUpdateForm): Promise<ClearPassWriteResult>;
}

export interface ClearPassDirectWriteOptions {
  registry?: PlaneRegistry; // default: the process-wide singleton
  pollerRef?: Poller; // default: the process-wide poller — re-read after a write
  plane?: ClearPassWritePlane | null; // test override — undefined resolves the ClearPassAdapter from the registry
  dataDir?: string; // default: HPE_DATA_DIR or <repo>/data
  nowMs?: () => number;
  demoMode?: () => boolean; // default: the settings store (coa.ts's own pattern)
  /** Test seam; production always reads the shared persisted lab policy. */
  allowsLabDirectWrites?: () => boolean;
  /** Test seam. Production always evaluates canonical settings + registry. */
  admitWrite?: AdmitWrite;
}

const STATUS_VALUES = new Set<string>(CLEARPASS_ENDPOINT_STATUSES);

/** The audit vocabulary — one event per write kind, kind labels that read
 *  cleanly next to the broker's own 'ssid'/'port'/'vlan' in the drawer. */
const AUDIT = {
  'endpoint-register': { event: 'endpoint-register', kind: 'endpoint' },
  'endpoint-update': { event: 'endpoint-update', kind: 'endpoint' },
  'local-user-create': { event: 'local-user-create', kind: 'local-user' },
  'local-user-update': { event: 'local-user-update', kind: 'local-user' },
} as const;
type WriteKind = keyof typeof AUDIT;

function requireNonEmptyString(value: unknown, field: string, maxLen = 128): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ClearPassDirectWriteError(400, `${field} is required`);
  }
  const trimmed = value.trim();
  if (trimmed.length > maxLen) {
    throw new ClearPassDirectWriteError(400, `${field} must be ${maxLen} characters or fewer`);
  }
  return trimmed;
}

function optionalString(value: unknown, field: string, maxLen = 256): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new ClearPassDirectWriteError(400, `${field} must be a string`);
  const trimmed = value.trim();
  if (trimmed.length > maxLen) throw new ClearPassDirectWriteError(400, `${field} must be ${maxLen} characters or fewer`);
  return trimmed || undefined;
}

/**
 * A MAC the adapter will write, or a refusal. Validity is exactly what
 * shared normalizeMac() normalises — 12 hex digits after separators are
 * stripped — so the service and the adapter can never disagree about what
 * "the same endpoint" means.
 */
function requireMac(value: unknown): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) throw new ClearPassDirectWriteError(400, 'a MAC address is required');
  const hex = raw.replace(/[^0-9a-fA-F]/g, '');
  if (hex.length !== 12) {
    throw new ClearPassDirectWriteError(400, 'a valid MAC address is 12 hex digits (any separator) — e.g. 3c:22:fb:41:0a:19');
  }
  return normalizeMac(raw);
}

function optionalStatus(value: unknown): ClearPassEndpointStatus | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || !STATUS_VALUES.has(value)) {
    throw new ClearPassDirectWriteError(400, `status must be one of ${CLEARPASS_ENDPOINT_STATUSES.join(', ')}`);
  }
  return value as ClearPassEndpointStatus;
}

/** A flat string→string attribute map, or a refusal — CPPM's endpoint object
 *  nests exactly this, and anything richer is a form error, not a guess. */
function optionalAttributes(value: unknown): Record<string, string> | undefined {
  if (value === undefined || value === null) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ClearPassDirectWriteError(400, 'attributes must be an object of name → value strings');
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 20) throw new ClearPassDirectWriteError(400, 'at most 20 attributes');
  const out: Record<string, string> = {};
  for (const [key, v] of entries) {
    if (!key.trim() || key.trim().length > 64) {
      throw new ClearPassDirectWriteError(400, 'attribute names must be 1–64 characters');
    }
    if (typeof v !== 'string' || v.length > 256) {
      throw new ClearPassDirectWriteError(400, `attribute '${key.trim()}' must be a string of at most 256 characters`);
    }
    out[key.trim()] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * The password field, validated and passed through — and never anything else.
 * It is read off the form here and handed to the adapter verbatim; nothing in
 * this module stringifies a form, so it cannot leak into a log or an error.
 */
function requirePassword(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ClearPassDirectWriteError(400, 'a password is required for a new local user');
  }
  if (value.length > 256) throw new ClearPassDirectWriteError(400, 'the password must be 256 characters or fewer');
  return value;
}

function optionalPassword(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || value.length === 0) {
    throw new ClearPassDirectWriteError(400, 'password must be a non-empty string, or omitted to leave it unchanged');
  }
  if (value.length > 256) throw new ClearPassDirectWriteError(400, 'the password must be 256 characters or fewer');
  return value;
}

function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw new ClearPassDirectWriteError(400, `${field} must be true or false`);
  return value;
}

function asEndpointRegisterForm(raw: unknown): ClearPassEndpointRegisterForm {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ClearPassDirectWriteError(400, 'form must be an object');
  }
  const rec = raw as Record<string, unknown>;
  const description = optionalString(rec.description, 'description');
  const status = optionalStatus(rec.status);
  const attributes = optionalAttributes(rec.attributes);
  return {
    mac: requireMac(rec.mac),
    ...(description ? { description } : {}),
    ...(status ? { status } : {}),
    ...(attributes ? { attributes } : {}),
  };
}

function asEndpointUpdateForm(raw: unknown): ClearPassEndpointUpdateForm {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ClearPassDirectWriteError(400, 'form must be an object');
  }
  const rec = raw as Record<string, unknown>;
  const status = optionalStatus(rec.status);
  // Present-and-empty clears the operator note; absent leaves it alone — so
  // unlike every other string here, description is NOT trimmed to undefined.
  let description: string | undefined;
  if (rec.description !== undefined && rec.description !== null) {
    if (typeof rec.description !== 'string') throw new ClearPassDirectWriteError(400, 'description must be a string');
    if (rec.description.length > 256) throw new ClearPassDirectWriteError(400, 'description must be 256 characters or fewer');
    description = rec.description;
  }
  if (status === undefined && description === undefined) {
    throw new ClearPassDirectWriteError(400, 'nothing to update — send a status, a description, or both');
  }
  return { ...(status ? { status } : {}), ...(description !== undefined ? { description } : {}) };
}

function asLocalUserCreateForm(raw: unknown): ClearPassLocalUserCreateForm {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ClearPassDirectWriteError(400, 'form must be an object');
  }
  const rec = raw as Record<string, unknown>;
  const username = optionalString(rec.username, 'display name');
  return {
    userId: requireNonEmptyString(rec.userId, 'user id'),
    ...(username ? { username } : {}),
    roleName: requireNonEmptyString(rec.roleName, 'role'),
    enabled: requireBoolean(rec.enabled, 'enabled'),
    password: requirePassword(rec.password),
  };
}

function asLocalUserUpdateForm(raw: unknown): ClearPassLocalUserUpdateForm {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ClearPassDirectWriteError(400, 'form must be an object');
  }
  const rec = raw as Record<string, unknown>;
  const username = optionalString(rec.username, 'display name');
  const roleName = optionalString(rec.roleName, 'role');
  const enabled = rec.enabled === undefined || rec.enabled === null ? undefined : requireBoolean(rec.enabled, 'enabled');
  const password = optionalPassword(rec.password);
  if (username === undefined && roleName === undefined && enabled === undefined && password === undefined) {
    throw new ClearPassDirectWriteError(400, 'nothing to update — send a display name, role, enabled state, or password');
  }
  return {
    ...(username ? { username } : {}),
    ...(roleName ? { roleName } : {}),
    ...(enabled !== undefined ? { enabled } : {}),
    ...(password !== undefined ? { password } : {}),
  };
}

export class ClearPassDirectWriteService {
  private readonly registry: PlaneRegistry;
  private readonly pollerRef: Poller;
  private readonly planeOverride: ClearPassWritePlane | null | undefined;
  private readonly dataDir: string;
  private readonly nowMs: () => number;
  private readonly demoMode: () => boolean;
  private readonly allowsLabDirectWrites: () => boolean;
  private readonly admitWrite: AdmitWrite;

  constructor(opts: ClearPassDirectWriteOptions = {}) {
    this.registry = opts.registry ?? defaultRegistry;
    this.pollerRef = opts.pollerRef ?? defaultPoller;
    this.planeOverride = opts.plane;
    this.dataDir = opts.dataDir ?? brokerDataDir();
    this.nowMs = opts.nowMs ?? (() => Date.now());
    this.demoMode = opts.demoMode ?? (() => settings.get().demoMode);
    this.allowsLabDirectWrites = opts.allowsLabDirectWrites ?? allowsLabDirectWrites;
    this.admitWrite =
      opts.admitWrite ??
      (opts.plane !== undefined
        ? (request) => ({ ok: true, plane: request.plane, adapter: {} as never })
        : (request) => evaluateWriteAdmission(request, { registry: this.registry }));
  }

  private adapter(): ClearPassWritePlane | null {
    if (this.planeOverride !== undefined) return this.planeOverride;
    const a = this.registry.get('clearpass');
    return a instanceof ClearPassAdapter ? a : null;
  }

  /**
   * The role names a local-user write may pick, when the portal can prove
   * them: the fixture inventory in demo, the poller cache's last reported
   * roles live. null = the roles were never reported, so membership cannot be
   * checked here and the plane's own answer stands (a bogus role comes back
   * as an honest refused write, HTTP code and all).
   */
  private knownRoleNames(): string[] | null {
    if (this.demoMode()) return CLEARPASS_ROLES.map((r) => r.name);
    const roles = this.pollerRef.contributionsByPlane().get('clearpass')?.roles;
    return roles === undefined ? null : roles.map((r) => r.name);
  }

  private checkRole(roleName: string | undefined): void {
    if (roleName === undefined) return;
    const known = this.knownRoleNames();
    if (known !== null && !known.includes(roleName)) {
      throw new ClearPassDirectWriteError(
        409,
        `role '${roleName}' is not in the ClearPass role inventory this portal has — pick a reported role, or resync if it was just created in CPPM`,
      );
    }
  }

  /** Register one endpoint — gate → validate → apply → verify → audit. */
  async registerEndpoint(formRaw: unknown, reviewConfirmedRaw: unknown): Promise<ClearPassWriteResult> {
    this.requireReview(reviewConfirmedRaw);
    const form = asEndpointRegisterForm(formRaw);
    if (this.demoMode()) {
      const result = this.demoResult('created', `demo endpoint ${form.mac} registered — no live CPPM was written`);
      this.log('endpoint-register', result);
      return result;
    }
    const adapter = this.requireAdapter(); // 409 BEFORE the transport-failure net below
    return this.applyLive('endpoint-register', () => adapter.registerEndpoint(form), 'endpoints');
  }

  /** Update one endpoint's status/note — gate → validate → apply → verify → audit. */
  async updateEndpoint(idRaw: unknown, formRaw: unknown, reviewConfirmedRaw: unknown): Promise<ClearPassWriteResult> {
    this.requireReview(reviewConfirmedRaw);
    const id = requireNonEmptyString(idRaw, 'endpoint id');
    const form = asEndpointUpdateForm(formRaw);
    if (this.demoMode()) {
      const result = this.demoResult('updated', `demo endpoint updated — no live CPPM was written`);
      this.log('endpoint-update', result);
      return result;
    }
    const adapter = this.requireAdapter(); // 409 BEFORE the transport-failure net below
    return this.applyLive('endpoint-update', () => adapter.updateEndpoint(id, form), 'endpoints');
  }

  /** Create one local user — review → validate → apply → verify → audit. The
   *  form's password is validated and handed to the adapter; it appears in
   *  nothing this method logs, returns verbatim, or throws. */
  async createLocalUser(formRaw: unknown, reviewConfirmedRaw: unknown): Promise<ClearPassWriteResult> {
    this.requireReview(reviewConfirmedRaw);
    const form = asLocalUserCreateForm(formRaw);
    this.checkRole(form.roleName);
    if (this.demoMode()) {
      const result = this.demoResult('created', `demo local user '${form.userId}' created — no live CPPM was written`);
      this.log('local-user-create', result);
      return result;
    }
    const adapter = this.requireAdapter(); // 409 BEFORE the transport-failure net below
    return this.applyLive('local-user-create', () => adapter.createLocalUser(form), 'localUsers');
  }

  /** Update one local user — review → validate → apply → verify → audit. */
  async updateLocalUser(idRaw: unknown, formRaw: unknown, reviewConfirmedRaw: unknown): Promise<ClearPassWriteResult> {
    this.requireReview(reviewConfirmedRaw);
    const id = requireNonEmptyString(idRaw, 'local-user id');
    const form = asLocalUserUpdateForm(formRaw);
    this.checkRole(form.roleName);
    if (this.demoMode()) {
      const result = this.demoResult('updated', `demo local user updated — no live CPPM was written`);
      this.log('local-user-update', result);
      return result;
    }
    const adapter = this.requireAdapter(); // 409 BEFORE the transport-failure net below
    return this.applyLive('local-user-update', () => adapter.updateLocalUser(id, form), 'localUsers');
  }

  private requireReview(reviewConfirmedRaw: unknown): void {
    if (!this.allowsLabDirectWrites() && reviewConfirmedRaw !== true) {
      throw new ClearPassDirectWriteError(400, 'direct ClearPass writes require an explicit review confirmation');
    }
  }

  private requireAdapter(): ClearPassWritePlane {
    const admission = this.admitWrite({ operation: 'clearpass-object', plane: 'clearpass' });
    if (!admission.ok) throw new ClearPassDirectWriteError(admission.status, admission.message);
    const candidate = this.planeOverride !== undefined ? this.planeOverride : admission.adapter;
    if (!candidate) {
      throw new ClearPassDirectWriteError(409, 'clearpass is not linked — connect it under Systems and retry');
    }
    if (
      typeof (candidate as Partial<ClearPassWritePlane>).registerEndpoint !== 'function' ||
      typeof (candidate as Partial<ClearPassWritePlane>).updateEndpoint !== 'function' ||
      typeof (candidate as Partial<ClearPassWritePlane>).createLocalUser !== 'function' ||
      typeof (candidate as Partial<ClearPassWritePlane>).updateLocalUser !== 'function'
    ) {
      throw new ClearPassDirectWriteError(409, 'clearpass is linked but its adapter cannot perform direct object writes');
    }
    return candidate as ClearPassWritePlane;
  }

  /**
   * The live half shared by all four writes: run the adapter's write +
   * read-back, force the cache refresh that keeps the screen's next fetch
   * from showing the pre-write snapshot, and audit the outcome. A THROWN
   * adapter call (timeout, transport fault) leaves the write's outcome
   * unknown — audited distinctly from a structured 'failed' answer, never
   * fabricated into one, and surfaced as a fixed secret-free 502.
   */
  private async applyLive(
    kind: WriteKind,
    write: () => Promise<ClearPassWriteResult>,
    cacheKey: 'endpoints' | 'localUsers',
  ): Promise<ClearPassWriteResult> {
    let result: ClearPassWriteResult;
    try {
      result = await write();
    } catch {
      this.logTransportFailure(kind);
      throw new ClearPassDirectWriteError(502, 'ClearPass did not answer the write; the outcome is unknown');
    }
    result.cacheRefresh = await this.refreshCache(result, cacheKey);
    this.log(kind, result);
    return result;
  }

  /**
   * Force one fresh ClearPass pull so the screen's endpoint/local-user list
   * reflects the write it was just told about (the list is served from the
   * poll cache — see ssidDirectWrite.ts's refreshCache for the full argument;
   * the adapter's write methods have already dropped their own read caches so
   * this pull actually re-reads). A refresh failure never fails the write —
   * the change is already on the box — it is reported instead of assumed.
   */
  private async refreshCache(result: ClearPassWriteResult, cacheKey: 'endpoints' | 'localUsers'): Promise<WriteCacheRefresh> {
    if (!result.ok) return { attempted: false, ok: false };
    try {
      const tick = await this.pollerRef.syncNowFor('clearpass');
      if (tick !== 'ok') {
        return { attempted: true, ok: false, message: `ClearPass could not be re-read (poll ${tick})` };
      }
      // A pull that completed but omitted this section leaves the cache
      // exactly as stale as a failed one — planes omit sections they could
      // not read rather than sending them empty.
      const pull = this.pollerRef.contributionsByPlane().get('clearpass');
      if (!pull?.[cacheKey]) {
        return { attempted: true, ok: false, message: 'ClearPass was re-read but returned no updated list' };
      }
      return { attempted: true, ok: true };
    } catch (err) {
      // Secret-free: the poller's error can carry a URL or vendor body.
      console.error(`clearpass cache refresh failed: ${(err as Error).message}`);
      return { attempted: true, ok: false, message: 'ClearPass could not be re-read' };
    }
  }

  /** Demo mode's canned outcome — the write validates and showcases; nothing
   *  leaves the portal, which the message says outright. */
  private demoResult(action: 'created' | 'updated', message: string): ClearPassWriteResult {
    return { ok: true, action, verified: true, httpCode: 200, message };
  }

  /** The adapter threw — no ClearPassWriteResult exists to log, so this writes
   *  the one audit line on the transport-failure path. Deliberately carries no
   *  error message, URL, or form data: only that the outcome on the plane is
   *  unknown. */
  private logTransportFailure(kind: WriteKind): void {
    appendBrokerLog(this.dataDir, {
      ts: new Date(this.nowMs()).toISOString(),
      event: AUDIT[kind].event,
      changeId: `direct-cppm-${randomUUID()}`,
      ticket: '(none — direct apply)',
      kind: AUDIT[kind].kind,
      result: 'error (transport failure — outcome unknown)',
    });
  }

  /** One audit line per attempt — kind and outcome, an HTTP code at most.
   *  Never a form field, and so never a password. */
  private log(kind: WriteKind, result: ClearPassWriteResult): void {
    appendBrokerLog(this.dataDir, {
      ts: new Date(this.nowMs()).toISOString(),
      event: AUDIT[kind].event,
      changeId: `direct-cppm-${randomUUID()}`,
      ticket: '(none — direct apply)',
      kind: AUDIT[kind].kind,
      result: result.ok ? 'applied' : 'failed',
      ...(result.httpCode !== undefined ? { httpCode: result.httpCode } : {}),
    });
  }
}

/** Process-wide singleton, matching writeBroker's / ssidDirectWrite's pattern. */
export const clearpassDirectWrite = new ClearPassDirectWriteService();
