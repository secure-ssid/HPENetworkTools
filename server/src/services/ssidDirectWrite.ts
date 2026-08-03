/**
 * server/src/services/ssidDirectWrite.ts — the SSID direct-apply pipeline.
 *
 * SSIDs no longer go through the ticketed write broker's queue/push
 * (writeBroker.ts): New Central's real config surface is a WLAN profile
 * upsert plus separate configuration assignments (see CentralAdapter.
 * ssidCatalog()/applySsidProfile()), and Mist's is a site-scoped WLAN upsert
 * (see MistAdapter.ssidCatalog()/applySsidProfile()) — neither fits the
 * broker's one-ticket-one-PUT model. This service is the thin route-facing
 * layer over those adapter methods — it resolves the linked adapter for the
 * form's target plane, conditionally requires a hardened-mode review
 * confirmation instead of a ticket, validates the form shape (against THAT plane's dependency rules —
 * Central's role/server-group/portal catalogs are not Mist's), and records
 * ONE audit-log line per apply (no ticket, no payload body, no passphrase)
 * into the broker's own change-log.jsonl so the Configure "Change history"
 * drawer stays one place for every brokered AND direct write.
 *
 * Demo mode never touches the registry: it answers with a canned catalog per
 * plane and a canned successful apply, exactly like every other
 * /api/configure demo fixture, so "New SSID" keeps working end to end without
 * a linked plane.
 */

import { randomUUID } from 'node:crypto';
import {
  SSID_CATALOG_DEMO,
  SSID_CATALOG_DEMO_MIST,
  ssidDependencyRequirementsFor,
  SSID_BAND_OPTIONS,
  SSID_SECURITY_OPTIONS,
  planeKeyOf,
  type SsidApplyResult,
  type SsidCatalog,
  type SsidForm,
  type SsidSecurity,
  ssidNameProblem,
  vlanIdProblem,
  wpaPassphraseProblem,
  type WriteCacheRefresh,
} from '@hpe/shared';
import { CentralAdapter } from '../planes/central';
import { MistAdapter } from '../planes/mist';
import { PlaneRegistry, registry as defaultRegistry } from '../planes/registry';
import { poller as defaultPoller, type Poller } from './poller';
import { appendBrokerLog, brokerDataDir } from './writeBroker';
import { effectiveSectionSource, settings } from '../config/settings';
import { allowsLabDirectWrites } from './labWritePolicy';

export class SsidDirectWriteError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'SsidDirectWriteError';
  }
}

/** The planes with a direct SSID write path at all. */
type SsidWritePlaneKey = 'central' | 'mist';

/** Resolve the catalog query / form plane label to a writable plane key —
 *  anything else (a plane with no SSID write path, or a multi-plane display
 *  label like 'CENTRAL + MIST') is a refusal, never a silent default. */
function ssidWritePlaneKey(raw: unknown): SsidWritePlaneKey | null {
  if (raw === undefined || raw === null || raw === '') return 'central';
  if (typeof raw !== 'string') return null;
  const key = planeKeyOf(raw.trim() as Parameters<typeof planeKeyOf>[0]);
  return key === 'central' || key === 'mist' ? key : null;
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
  pollerRef?: Poller; // default: the process-wide poller — re-read after a write
  plane?: SsidWritePlane | null; // test override — undefined resolves the CentralAdapter from the registry
  dataDir?: string; // default: HPE_DATA_DIR or <repo>/data
  nowMs?: () => number;
  effectiveDemoMode?: () => boolean; // default: Configure section override, then global demoMode
  demoMode?: () => boolean; // backwards-compatible test override
  /** Test seam; production always reads the shared persisted lab policy. */
  allowsLabDirectWrites?: () => boolean;
}

const SECURITY_VALUES = new Set(SSID_SECURITY_OPTIONS.map((o) => o.value));
const BAND_VALUES = new Set(SSID_BAND_OPTIONS.map((o) => o.value));

/** Same VLAN-id rule the ticketed broker enforces — now literally the same
 *  function, in @hpe/shared, which the editor screens it too. */
function requireVlanId(value: unknown): string {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  const problem = vlanIdProblem(trimmed);
  if (problem) throw new SsidDirectWriteError(400, problem);
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
 *
 * The dependency rules are the TARGET PLANE's, computed from the form's plane
 * label (ssidDependencyRequirementsFor): a Mist-targeted form has no role/
 * server-group/portal catalog to satisfy (those modes are refused by the
 * adapter with the reason stated), so only the write-only passphrase remains.
 */
function asSsidForm(raw: unknown): SsidForm {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new SsidDirectWriteError(400, 'form must be an object');
  }
  const rec = raw as Record<string, unknown>;
  const name = requireNonEmptyString(rec.name, 'SSID name');
  const nameProblem = ssidNameProblem(name);
  if (nameProblem) throw new SsidDirectWriteError(400, nameProblem);
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
  const plane = optionalString(rec.plane) ?? 'CENTRAL';
  const requirement = ssidDependencyRequirementsFor(security, plane);
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
  const passphraseProblem = passphrase ? wpaPassphraseProblem(passphrase) : null;
  if (passphraseProblem) throw new SsidDirectWriteError(400, passphraseProblem);
  const enabled = typeof rec.enabled === 'boolean' ? rec.enabled : undefined;
  return {
    name,
    vlan,
    security,
    bands,
    group: optionalString(rec.group) ?? name,
    broadcast: rec.broadcast !== false,
    isolate: rec.isolate === true,
    noDfs: rec.noDfs === true,
    plane,
    scopeIds,
    ...(defaultRole ? { defaultRole } : {}),
    ...(authServerGroupId ? { authServerGroupId } : {}),
    ...(captivePortalProfileId ? { captivePortalProfileId } : {}),
    ...(passphrase ? { passphrase } : {}),
    ...(enabled !== undefined ? { enabled } : {}),
  };
}

export class SsidDirectWriteService {
  private readonly registry: PlaneRegistry;
  private readonly pollerRef: Poller;
  private readonly planeOverride: SsidWritePlane | null | undefined;
  private readonly dataDir: string;
  private readonly nowMs: () => number;
  private readonly effectiveDemoMode: () => boolean;
  private readonly allowsLabDirectWrites: () => boolean;

  constructor(opts: SsidDirectWriteOptions = {}) {
    this.registry = opts.registry ?? defaultRegistry;
    this.pollerRef = opts.pollerRef ?? defaultPoller;
    this.planeOverride = opts.plane;
    this.dataDir = opts.dataDir ?? brokerDataDir();
    this.nowMs = opts.nowMs ?? (() => Date.now());
    this.effectiveDemoMode =
      opts.effectiveDemoMode ??
      opts.demoMode ??
      (() => effectiveSectionSource(settings.get(), 'configure') === 'demo');
    this.allowsLabDirectWrites = opts.allowsLabDirectWrites ?? allowsLabDirectWrites;
  }

  private adapterFor(planeKey: SsidWritePlaneKey): SsidWritePlane | null {
    if (this.planeOverride !== undefined) return this.planeOverride;
    const a = this.registry.get(planeKey);
    return planeKey === 'mist' ? (a instanceof MistAdapter ? a : null) : a instanceof CentralAdapter ? a : null;
  }

  /** GET the editor's live catalog — demo mode never touches the registry.
   *  `planeRaw` selects the target plane ('mist' for the site-scoped WLAN
   *  walk); absent is Central, exactly as before. */
  async catalog(planeRaw?: unknown): Promise<SsidCatalog> {
    const planeKey = ssidWritePlaneKey(Array.isArray(planeRaw) ? planeRaw[0] : planeRaw);
    if (planeKey === null) {
      throw new SsidDirectWriteError(400, 'plane must be central or mist — no other plane has a direct SSID write path');
    }
    if (this.effectiveDemoMode()) return planeKey === 'mist' ? SSID_CATALOG_DEMO_MIST : SSID_CATALOG_DEMO;
    const adapter = this.adapterFor(planeKey);
    if (!adapter) {
      if (planeKey === 'mist') {
        return {
          scopes: [],
          roles: [],
          authServerGroups: [],
          captivePortalProfiles: [],
          unavailable: ['sites'],
          source: 'Mist is not linked',
        };
      }
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
   * Apply an SSID change directly. Hardened mode requires `reviewConfirmed`
   * exactly `true`; lab-direct mode has no review gate. Every attempt (success, partial,
   * failure) is written to the shared change-log, never with a payload body
   * or a passphrase.
   */
  async apply(formRaw: unknown, reviewConfirmedRaw: unknown): Promise<SsidApplyResult> {
    if (!this.allowsLabDirectWrites() && reviewConfirmedRaw !== true) {
      throw new SsidDirectWriteError(400, 'direct SSID writes require an explicit review confirmation');
    }
    // The plane decides which dependency rules even apply — refuse a target
    // with no write path BEFORE validating another plane's rules against it.
    const rawPlane =
      formRaw && typeof formRaw === 'object' && !Array.isArray(formRaw)
        ? (formRaw as Record<string, unknown>).plane
        : undefined;
    const planeKey = ssidWritePlaneKey(rawPlane);
    if (planeKey === null) {
      throw new SsidDirectWriteError(
        400,
        `plane '${typeof rawPlane === 'string' ? rawPlane : ''}' has no direct SSID write path — target one plane (central or mist) per apply`,
      );
    }
    const form = asSsidForm(formRaw);

    if (this.effectiveDemoMode()) {
      const result = this.demoApplyResult(form, planeKey);
      this.log(form.name, result, planeKey);
      return result;
    }

    const adapter = this.adapterFor(planeKey);
    if (!adapter) {
      throw new SsidDirectWriteError(409, `${planeKey} is not linked — cannot apply`);
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
      // other unhandled fault. Whether the plane actually applied the write is
      // unknown, so this is audited distinctly from a structured 'failed'
      // outcome (never fabricated as one) and the error propagates instead
      // of being swallowed into a success/failure result the caller could
      // mistake for a definitive answer.
      this.logTransportFailure(planeKey);
      // Fixed, secret-free message — the caught error's own message could
      // carry a URL, token-adjacent context, or other sensitive detail, and
      // this propagates all the way to the generic error middleware's
      // console.error(err.message); never interpolate it, even server-side.
      throw new SsidDirectWriteError(
        502,
        `${planeKey === 'mist' ? 'Mist' : 'central'} did not answer the SSID write; the outcome is unknown`,
      );
    }
    const labels = new Map(catalog.scopes.map((scope) => [scope.id, scope.label]));
    for (const assignment of result.assignments) {
      assignment.label = labels.get(assignment.scopeId) ?? assignment.scopeId;
    }
    result.cacheRefresh = await this.refreshCache(result, planeKey);
    this.log(form.name, result, planeKey);
    return result;
  }

  /**
   * Force one fresh Central pull so the Configure inventory reflects the SSID
   * that was just written.
   *
   * The list on that screen is served from the poll cache
   * (routes/screens/configureModel.ts reads poller.contributionsByPlane()),
   * and the screen re-fetches it the moment an apply succeeds. Without this,
   * that re-fetch returns the pre-change snapshot: the operator is told the
   * SSID was created and is then shown a list that does not contain it, for
   * up to a full poll interval. The natural reading of that is that the write
   * failed, and the natural response is to apply it again.
   *
   * A refresh failure never fails the write — the SSID is already on the
   * estate. Only the operator's view of it is behind, and that is what gets
   * reported rather than assumed.
   */
  private async refreshCache(result: SsidApplyResult, planeKey: SsidWritePlaneKey): Promise<WriteCacheRefresh> {
    const planeLabel = planeKey === 'mist' ? 'Mist' : 'Central';
    const profileWritten = result.profile.action === 'created' || result.profile.action === 'updated';
    const assignmentWritten = result.assignments.some(
      (assignment) => assignment.ok && !assignment.skipped,
    );
    // 'unchanged' and 'failed' both leave the plane exactly as the cache already
    // has it, so there is nothing for a re-read to correct.
    if (!profileWritten && !assignmentWritten) return { attempted: false, ok: false };
    try {
      const tick = await this.pollerRef.syncNowFor(planeKey);
      if (tick !== 'ok') {
        return { attempted: true, ok: false, message: `${planeLabel} could not be re-read (poll ${tick})` };
      }
      // A pull that completed but brought back no SSID list leaves the cache
      // exactly as stale as a failed one. Planes omit sections they could not
      // read rather than sending them empty, so an absent `ssids` here is a
      // section that was not read — not a plane with no SSIDs.
      const pull = this.pollerRef.contributionsByPlane().get(planeKey);
      if (!pull?.config?.ssids) {
        return {
          attempted: true,
          ok: false,
          message: `${planeLabel} was re-read but returned no SSID list`,
        };
      }
      return { attempted: true, ok: true };
    } catch (err) {
      // Secret-free: the poller's error can carry a URL or vendor body.
      console.error(`${planeKey} cache refresh failed: ${(err as Error).message}`);
      return { attempted: true, ok: false, message: `${planeLabel} could not be re-read` };
    }
  }

  private validateCatalogSelection(form: SsidForm, catalog: SsidCatalog): void {
    const scopeIds = new Set(catalog.scopes.map((scope) => scope.id));
    const invalidScopes = (form.scopeIds ?? []).filter((scopeId) => !scopeIds.has(scopeId));
    if (invalidScopes.length > 0) {
      throw new SsidDirectWriteError(409, 'one or more selected scopes are no longer available; reload the catalog');
    }

    const roleIds = new Set(catalog.roles.map((option) => option.id));
    if (form.defaultRole && !roleIds.has(form.defaultRole)) {
      throw new SsidDirectWriteError(409, 'the selected Central role is no longer available; reload the catalog');
    }

    const requirement = ssidDependencyRequirementsFor(form.security, form.plane);
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
  private demoApplyResult(form: SsidForm, planeKey: SsidWritePlaneKey): SsidApplyResult {
    return {
      ok: true,
      partial: false,
      profile: {
        ok: true,
        action: 'created',
        verified: true,
        httpCode: 200,
        message:
          planeKey === 'mist'
            ? `demo WLAN "${form.name}" created — no live org was written`
            : `demo profile "${form.name}" created — no live tenant was written`,
      },
      assignments: (form.scopeIds ?? []).map((scopeId) => ({
        scopeId,
        label: scopeId,
        ok: true,
        // Demo asserts the write landed, so it must also assert the read-back
        // that proves it. Leaving this undefined would mean "written, never
        // confirmed" — an honest state for a live tenant that would not open
        // its assignment list, and a meaningless one for a canned outcome.
        verified: true,
        httpCode: 200,
        message: planeKey === 'mist' ? 'written (demo)' : 'assigned (demo)',
      })),
    };
  }

  /** adapter.applySsidProfile() threw — no SsidApplyResult exists to log, so
   *  this writes the one audit line on the transport-failure path instead.
   *  Deliberately carries no error message/URL/form data: only that a
   *  direct SSID apply's outcome on the plane is unknown. */
  private logTransportFailure(planeKey: SsidWritePlaneKey): void {
    appendBrokerLog(this.dataDir, {
      ts: new Date(this.nowMs()).toISOString(),
      event: 'ssid-apply',
      changeId: planeKey === 'mist' ? `direct-ssid-mist-${randomUUID()}` : `direct-ssid-${randomUUID()}`,
      ticket: '(none — direct apply)',
      kind: 'ssid',
      result: 'error (transport failure — outcome unknown)',
    });
  }

  private log(name: string, result: SsidApplyResult, planeKey: SsidWritePlaneKey): void {
    const outcome = result.ok ? 'applied' : result.partial ? 'partial' : 'failed';
    appendBrokerLog(this.dataDir, {
      ts: new Date(this.nowMs()).toISOString(),
      event: 'ssid-apply',
      changeId: planeKey === 'mist' ? `direct-ssid-mist-${randomUUID()}` : `direct-ssid-${randomUUID()}`,
      ticket: '(none — direct apply)',
      kind: 'ssid',
      result: outcome,
      ...(result.profile.httpCode !== undefined ? { httpCode: result.profile.httpCode } : {}),
    });
  }
}

/** Process-wide singleton, matching writeBroker's own pattern. */
export const ssidDirectWrite = new SsidDirectWriteService();
