/**
 * server/src/services/ssidDirectWrite.ts — the SSID direct-apply pipeline.
 *
 * SSIDs no longer go through the ticketed write broker's queue/push
 * (writeBroker.ts): New Central's real config surface is a WLAN profile
 * upsert plus separate configuration assignments (see CentralAdapter.
 * ssidCatalog()/applySsidProfile()), which do not fit the broker's
 * one-ticket-one-PUT model. This service is the thin route-facing layer over
 * those adapter methods — it resolves the linked CentralAdapter, requires an
 * explicit review confirmation instead of a ticket, validates the form
 * shape, and records ONE audit-log line per apply (no ticket, no payload
 * body, no passphrase) into the broker's own change-log.jsonl so the
 * Configure "Change history" drawer stays one place for every brokered AND
 * direct write.
 *
 * Demo mode never touches the registry: it answers with a canned catalog and
 * a canned successful apply, exactly like every other /api/configure demo
 * fixture, so "New SSID" keeps working end to end without a linked plane.
 */

import { randomUUID } from 'node:crypto';
import {
  SSID_CATALOG_DEMO,
  ssidDependencyRequirementsFor,
  SSID_BAND_OPTIONS,
  SSID_SECURITY_OPTIONS,
  type SsidApplyResult,
  type SsidCatalog,
  type SsidForm,
  type SsidSecurity,
} from '../../../shared';
import { CentralAdapter } from '../planes/central';
import { PlaneRegistry, registry as defaultRegistry } from '../planes/registry';
import { appendBrokerLog, brokerDataDir } from './writeBroker';
import { effectiveSectionSource, settings } from '../config/settings';

export class SsidDirectWriteError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'SsidDirectWriteError';
  }
}

/** The Central-adapter surface this service actually needs — structural, not
 *  `instanceof CentralAdapter`, so tests can inject a plain stub the same way
 *  writeBroker.ts's BrokerTransport lets tests inject a fake transport
 *  without constructing a real CentralAdapter (token auth, HTTP, the lot). */
export interface SsidWritePlane {
  ssidCatalog(): Promise<SsidCatalog>;
  applySsidProfile(form: SsidForm): Promise<SsidApplyResult>;
}

export interface SsidDirectWriteOptions {
  registry?: PlaneRegistry; // default: the process-wide singleton
  plane?: SsidWritePlane | null; // test override — undefined resolves the CentralAdapter from the registry
  dataDir?: string; // default: HPE_DATA_DIR or <repo>/data
  nowMs?: () => number;
  effectiveDemoMode?: () => boolean; // default: Configure section override, then global demoMode
  demoMode?: () => boolean; // backwards-compatible test override
}

const SECURITY_VALUES = new Set(SSID_SECURITY_OPTIONS.map((o) => o.value));
const BAND_VALUES = new Set(SSID_BAND_OPTIONS.map((o) => o.value));

/** Same VLAN-id rule the ticketed broker enforces (writeBroker.ts requireVlanId). */
function requireVlanId(value: unknown): string {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!/^\d{1,4}$/.test(trimmed) || Number(trimmed) < 1 || Number(trimmed) > 4094) {
    throw new SsidDirectWriteError(400, 'VLAN id must be a number between 1 and 4094');
  }
  return trimmed;
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new SsidDirectWriteError(400, `${field} is required`);
  }
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

/**
 * Validate an operator-submitted SsidForm for a direct apply. Distinct from
 * writeBroker's asForm(): this form carries scopeIds/defaultRole/
 * authServerGroupId/
 * captivePortalProfileId/passphrase, which the ticketed broker never learned
 * and must not need to.
 */
function asSsidForm(raw: unknown): SsidForm {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new SsidDirectWriteError(400, 'form must be an object');
  }
  const rec = raw as Record<string, unknown>;
  const name = requireNonEmptyString(rec.name, 'SSID name');
  if (name.length > 32) throw new SsidDirectWriteError(400, 'SSID name must be 32 characters or fewer');
  const vlan = requireVlanId(rec.vlan);
  const security = rec.security as SsidSecurity;
  if (!SECURITY_VALUES.has(security)) throw new SsidDirectWriteError(400, 'unsupported SSID security value');
  if (typeof rec.bands !== 'string' || !BAND_VALUES.has(rec.bands)) {
    throw new SsidDirectWriteError(400, 'unsupported SSID band selection');
  }
  const bands = rec.bands as SsidForm['bands'];
  const submittedScopeIds = Array.isArray(rec.scopeIds)
    ? rec.scopeIds
        .filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
        .map((s) => s.trim())
    : [];
  const scopeIds = [...new Set(submittedScopeIds)];
  if (scopeIds.length === 0) {
    throw new SsidDirectWriteError(400, 'select at least one scope (site, site collection, AP device group, or AP) before applying');
  }
  if (scopeIds.length !== submittedScopeIds.length) {
    throw new SsidDirectWriteError(400, 'each Central scope may be selected only once');
  }
  const requirement = ssidDependencyRequirementsFor(security);
  const defaultRole = optionalString(rec.defaultRole);
  if (requirement.role && !defaultRole) throw new SsidDirectWriteError(400, 'a default role is required for this security mode');
  const authServerGroupId = requirement.authServerGroup ? optionalString(rec.authServerGroupId) : undefined;
  if (requirement.authServerGroup && !authServerGroupId) {
    throw new SsidDirectWriteError(400, 'an authentication server group is required for enterprise security modes');
  }
  const captivePortalProfileId = requirement.captivePortal ? optionalString(rec.captivePortalProfileId) : undefined;
  if (requirement.captivePortal && !captivePortalProfileId) {
    throw new SsidDirectWriteError(400, 'a captive-portal profile is required for PSK + captive portal');
  }
  const passphrase = requirement.passphrase ? optionalString(rec.passphrase) : undefined;
  if (requirement.passphrase && !passphrase) {
    throw new SsidDirectWriteError(400, 'a passphrase is required for this security mode');
  }
  if (
    passphrase &&
    !(
      (passphrase.length >= 8 && passphrase.length <= 63) ||
      (passphrase.length === 64 && /^[0-9a-f]+$/i.test(passphrase))
    )
  ) {
    throw new SsidDirectWriteError(400, 'passphrase must be 8-63 characters, or exactly 64 hexadecimal characters');
  }
  return {
    name,
    vlan,
    security,
    bands,
    group: optionalString(rec.group) ?? name,
    broadcast: rec.broadcast !== false,
    isolate: rec.isolate === true,
    noDfs: rec.noDfs === true,
    plane: optionalString(rec.plane) ?? 'CENTRAL',
    scopeIds,
    ...(defaultRole ? { defaultRole } : {}),
    ...(authServerGroupId ? { authServerGroupId } : {}),
    ...(captivePortalProfileId ? { captivePortalProfileId } : {}),
    ...(passphrase ? { passphrase } : {}),
  };
}

export class SsidDirectWriteService {
  private readonly registry: PlaneRegistry;
  private readonly planeOverride: SsidWritePlane | null | undefined;
  private readonly dataDir: string;
  private readonly nowMs: () => number;
  private readonly effectiveDemoMode: () => boolean;

  constructor(opts: SsidDirectWriteOptions = {}) {
    this.registry = opts.registry ?? defaultRegistry;
    this.planeOverride = opts.plane;
    this.dataDir = opts.dataDir ?? brokerDataDir();
    this.nowMs = opts.nowMs ?? (() => Date.now());
    this.effectiveDemoMode =
      opts.effectiveDemoMode ??
      opts.demoMode ??
      (() => effectiveSectionSource(settings.get(), 'configure') === 'demo');
  }

  private adapter(): SsidWritePlane | null {
    if (this.planeOverride !== undefined) return this.planeOverride;
    const a = this.registry.get('central');
    return a instanceof CentralAdapter ? a : null;
  }

  /** GET the editor's live catalog — demo mode never touches the registry. */
  async catalog(): Promise<SsidCatalog> {
    if (this.effectiveDemoMode()) return SSID_CATALOG_DEMO;
    const adapter = this.adapter();
    if (!adapter) {
      return {
        scopes: [],
        roles: [],
        authServerGroups: [],
        captivePortalProfiles: [],
        unavailable: [
          'sites',
          'site-collections',
          'ap-groups',
          'aps',
          'roles',
          'authServerGroups',
          'captivePortalProfiles',
        ],
        source: 'Central is not linked',
      };
    }
    return adapter.ssidCatalog();
  }

  /**
   * Apply a reviewed SSID change directly. `reviewConfirmed` must be exactly
   * `true` — this is the direct-write path's review gate, standing in for
   * the ticketed broker's ticket reference. Every attempt (success, partial,
   * failure) is written to the shared change-log, never with a payload body
   * or a passphrase.
   */
  async apply(formRaw: unknown, reviewConfirmedRaw: unknown): Promise<SsidApplyResult> {
    if (reviewConfirmedRaw !== true) {
      throw new SsidDirectWriteError(400, 'direct SSID writes require an explicit review confirmation');
    }
    const form = asSsidForm(formRaw);

    if (this.effectiveDemoMode()) {
      const result = this.demoApplyResult(form);
      this.log(form.name, result);
      return result;
    }

    const adapter = this.adapter();
    if (!adapter) {
      throw new SsidDirectWriteError(409, 'central is not linked — cannot apply');
    }
    if (form.noDfs) {
      throw new SsidDirectWriteError(
        400,
        'DFS exclusion is an RF-profile change and is not supported by the direct SSID endpoint',
      );
    }
    const catalog = await adapter.ssidCatalog();
    this.validateCatalogSelection(form, catalog);
    let result: SsidApplyResult;
    try {
      result = await adapter.applySsidProfile(form);
    } catch {
      // adapter.applySsidProfile() threw instead of answering with a
      // structured SsidApplyResult — a timeout, transport failure, or any
      // other unhandled fault. Whether Central actually applied the write is
      // unknown, so this is audited distinctly from a structured 'failed'
      // outcome (never fabricated as one) and the error propagates instead
      // of being swallowed into a success/failure result the caller could
      // mistake for a definitive answer.
      this.logTransportFailure();
      // Fixed, secret-free message — the caught error's own message could
      // carry a URL, token-adjacent context, or other sensitive detail, and
      // this propagates all the way to the generic error middleware's
      // console.error(err.message); never interpolate it, even server-side.
      throw new SsidDirectWriteError(502, 'central did not answer the SSID write; the outcome is unknown');
    }
    const labels = new Map(catalog.scopes.map((scope) => [scope.id, scope.label]));
    for (const assignment of result.assignments) {
      assignment.label = labels.get(assignment.scopeId) ?? assignment.scopeId;
    }
    this.log(form.name, result);
    return result;
  }

  private validateCatalogSelection(form: SsidForm, catalog: SsidCatalog): void {
    const scopeIds = new Set(catalog.scopes.map((scope) => scope.id));
    const invalidScopes = (form.scopeIds ?? []).filter((scopeId) => !scopeIds.has(scopeId));
    if (invalidScopes.length > 0) {
      throw new SsidDirectWriteError(409, 'one or more selected Central scopes are no longer available; reload the catalog');
    }

    const roleIds = new Set(catalog.roles.map((option) => option.id));
    if (form.defaultRole && !roleIds.has(form.defaultRole)) {
      throw new SsidDirectWriteError(409, 'the selected Central role is no longer available; reload the catalog');
    }

    const requirement = ssidDependencyRequirementsFor(form.security);
    if (requirement.authServerGroup) {
      if (catalog.unavailable.includes('authServerGroups')) {
        throw new SsidDirectWriteError(409, 'Central did not provide authentication server groups for this write');
      }
      const groupIds = new Set(catalog.authServerGroups.map((option) => option.id));
      if (!form.authServerGroupId || !groupIds.has(form.authServerGroupId)) {
        throw new SsidDirectWriteError(
          409,
          'the selected Central authentication server group is no longer available; reload the catalog',
        );
      }
    }

    if (requirement.captivePortal) {
      if (catalog.unavailable.includes('captivePortalProfiles')) {
        throw new SsidDirectWriteError(409, 'Central did not provide captive-portal profiles for this write');
      }
      const portalIds = new Set(catalog.captivePortalProfiles.map((option) => option.id));
      if (!form.captivePortalProfileId || !portalIds.has(form.captivePortalProfileId)) {
        throw new SsidDirectWriteError(
          409,
          'the selected Central captive-portal profile is no longer available; reload the catalog',
        );
      }
    }
  }

  /** Demo mode's canned outcome — every profile write and assignment succeeds. */
  private demoApplyResult(form: SsidForm): SsidApplyResult {
    return {
      ok: true,
      partial: false,
      profile: {
        ok: true,
        action: 'created',
        verified: true,
        httpCode: 200,
        message: `demo profile "${form.name}" created — no live tenant was written`,
      },
      assignments: (form.scopeIds ?? []).map((scopeId) => ({
        scopeId,
        label: scopeId,
        ok: true,
        httpCode: 200,
        message: 'assigned (demo)',
      })),
    };
  }

  /** adapter.applySsidProfile() threw — no SsidApplyResult exists to log, so
   *  this writes the one audit line on the transport-failure path instead.
   *  Deliberately carries no error message/URL/form data: only that a
   *  direct SSID apply's outcome on Central is unknown. */
  private logTransportFailure(): void {
    appendBrokerLog(this.dataDir, {
      ts: new Date(this.nowMs()).toISOString(),
      event: 'ssid-apply',
      changeId: `direct-ssid-${randomUUID()}`,
      ticket: '(none — direct apply, review-confirmed)',
      kind: 'ssid',
      result: 'error (transport failure — outcome unknown)',
    });
  }

  private log(name: string, result: SsidApplyResult): void {
    const outcome = result.ok ? 'applied' : result.partial ? 'partial' : 'failed';
    appendBrokerLog(this.dataDir, {
      ts: new Date(this.nowMs()).toISOString(),
      event: 'ssid-apply',
      changeId: `direct-ssid-${randomUUID()}`,
      ticket: '(none — direct apply, review-confirmed)',
      kind: 'ssid',
      result: outcome,
      ...(result.profile.httpCode !== undefined ? { httpCode: result.profile.httpCode } : {}),
    });
  }
}

/** Process-wide singleton, matching writeBroker's own pattern. */
export const ssidDirectWrite = new SsidDirectWriteService();
