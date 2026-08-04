/**
 * web/src/screens/Configure.tsx — the write surface.
 * High-fidelity port of design/NtConfigure.dc.html: four Stats, the brokered-
 * write info Alert, then two columns (1.55fr / 1fr). Left: Wireless SSIDs,
 * Switch ports and VLANs & roles as open lists with inline "+ Add" links and
 * "Edit ▸" rows. Right: Queued changes (Push queue gated on ≥1 ready entry;
 * push hands ready entries to the write broker, Discard clears) and the
 * "Where a change can go" capability matrix.
 * The queue is a nightdesk DataTable with the selection foundation wired: a
 * checkbox column, a select-all header checkbox, and the controlled
 * selectedKeys/onSelectionChange pair (x toggles the focused row, Esc
 * clears). A selection raises a contextual action bar — "N selected —
 * Approve / Reject" — that applies the EXISTING per-item push/discard flow
 * in sequence: every change still goes through its own brokered review,
 * lease and audit line, the bar only iterates, and the summary toast names
 * the per-item outcomes (applied / accepted / failed / skipped) with the
 * failures named.
 * The edit drawer (width="lg") renders a per-kind form whose "What gets
 * pushed" Code block recomputes LIVE on every keystroke/toggle through the
 * shared configPreviewFor/previewMetaFor/blastRadiusFor, with a required
 * ticket reference gating the primary button.
 * The header's "Change history" opens a second drawer over the write broker's
 * audit log (GET /api/configure/history): ts / event+kind / changeId / ticket /
 * result, and never the rendered payload body — the log records what happened
 * to a change, not what was in it.
 * Data: getConfigure() — live /api/configure when the server is up, fixtures
 * otherwise. Queue/dry-run/push/discard go through the write broker
 * (/api/configure/*) whenever the backend is reachable — the server queue is
 * then authoritative; the previous local-only behavior remains as the
 * offline fallback.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  PageSkeleton,
  Alert,
  Badge,
  Button,
  Checkbox,
  Code,
  DataTable,
  Drawer,
  EmptyState,
  FormField,
  Input,
  SectionHeader,
  Select,
  Spinner,
  Stat,
  Switch,
  useToast,
} from '../nightdesk';
import type { DataTableColumn } from '../nightdesk';
import { ConfigRecommendationsPanel } from '../components/ConfigRecommendationsPanel';
import { ConfigActionPanel } from '../components/ConfigActionPanel';
import { VisualReferencePanel } from '../components/VisualReferencePanel';
import {
  applyConfigDirect,
  applySsidDirect,
  discardChange,
  dryRunConfig,
  getChangeHistory,
  getChangeQueue,
  getConfigure,
  getPortalSettings,
  getSsidCatalog,
  isApiError,
  pushChange,
  queueChange,
} from '../api/client';
import type { ConfigureData, DryRunResult, ImmediateApplyResult } from '../api/client';
import {
  CONFIG_EDIT_DESCS,
  CONFIG_EDIT_TITLES,
  CONFIG_PUSH_NOTES,
  DEFAULT_PORT_FORM,
  DEFAULT_SSID_FORM,
  DEFAULT_VLAN_FORM,
  PORT_DEVICE_OPTIONS,
  PORT_MODE_OPTIONS,
  SSID_BAND_OPTIONS,
  SSID_SECURITY_OPTIONS,
  VLAN_SCOPE_OPTIONS,
  blastRadiusFor,
  configPreviewFor,
  mistSsidSecurityRefusal,
  previewMetaFor,
  queuedChangeNote,
  seedFormFromRow,
  ssidDependencyRequirementsFor,
  ssidNameProblem,
  vlanIdProblem,
  wpaPassphraseProblem,
  hhmmLocal as hhmm,
  countOf,
} from '@hpe/shared';
import type {
  ConfigForm,
  ConfigKind,
  PortForm,
  PortObject,
  SsidApplyResult,
  SsidBands,
  SsidProfileStepResult,
  SsidScopeAssignmentResult,
  SsidCatalog,
  SsidForm,
  SsidObject,
  SsidSecurity,
  VlanForm,
  VlanObject,
  VlanScope,
} from '@hpe/shared';
import { useSettings } from '../app/SettingsContext';
import { exportTableCsv } from '../lib/csv';
import { ScreenHeader } from './ScreenHeader';
import { ApiErrorState } from './ApiErrorState';
import {
  LIVE_CONFIG_DESCS,
  LAB_CONFIG_DESCS,
  LIVE_PORT_FORM,
  LIVE_PUSH_NOTES,
  LIVE_SSID_FORM,
  LIVE_VLAN_FORM,
  LIVE_VLAN_SCOPE_OPTIONS,
  SSID_SCOPE_CATEGORY_LABEL,
  formForPreview,
  groupScopesByCategory,
  ssidFormForSecurity,
  ssidPlaneOf,
  ssidSectionUnavailableNote,
  withPlaceholder,
} from './configure/forms';
import {
  groupSwitchPorts,
} from './configure/ports';
import {
  leaseNote,
  livePreview,
  liveRadius,
  writeSurfaceNote,
} from './configure/preview';
import {
  HistoryState,
  MICRO_LINK,
  QueueEntry,
  ROW,
  auditTone,
  queuedEntryFor,
  queueRowKey,
  rowForChange,
} from './configure/queue';
import { locateSsidDeepLink, parseSsidDeepLink } from './configure/deepLink';
import '../app/app.css';































/**
 * Three outcomes, not two.
 *
 * `verified === false` means Central took the assignment POST and the list
 * read back without it — an async apply still in flight, or a write that was
 * dropped. It is not the same as a rejected POST: one says wait and re-check,
 * the other says retry. Rendering both as ✗ under "an assignment failed" sends
 * the operator to the wrong action, and rendering the first as ✓ would claim
 * an SSID is live at a site where it may not be broadcasting at all.
 */
function assignmentMark(a: SsidScopeAssignmentResult): string {
  if (a.ok) return isUnconfirmed(a) ? '?' : '✓';
  return a.verified === false ? '⧗' : '✗';
}

/** Up to three change summaries, truncated, then "+N more" — the bulk bar's
 *  per-item honesty without a toast that scrolls. */
function nameList(whats: readonly string[]): string {
  const shown = whats.slice(0, 3).map((w) => w.slice(0, 48));
  return shown.join(', ') + (whats.length > 3 ? `, +${whats.length - 3} more` : '');
}

/**
 * Written, and never confirmed.
 *
 * `verified === undefined` on an assignment we actually wrote means the
 * confirming read did not come back — Central was asked for its assignment
 * list and would not give it. The write is still ok:true, because the POST
 * was answered; what is missing is any evidence it took effect. That is a
 * third state, and the shared type keeps it undefined rather than false for
 * exactly this reason: a list we could not fetch is not an empty one.
 *
 * `skipped` is excluded deliberately. A skipped assignment was found already
 * on file, which is a successful read of the very list in question — it is
 * confirmed by the same evidence that made it a no-op, and marking it
 * unconfirmed would train the operator to ignore the mark.
 */
function isUnconfirmed(a: SsidScopeAssignmentResult): boolean {
  return a.ok === true && a.skipped !== true && a.verified === undefined;
}

function unconfirmedCount(assignments: readonly SsidScopeAssignmentResult[]): number {
  return assignments.filter(isUnconfirmed).length;
}

/**
 * The profile half's version of the distinction the assignment half draws.
 *
 * `action` is only 'failed' when Central refused the write, or would not hand
 * back the existing profile to compare against. Any other action means Central
 * answered the write with a 2xx and it was the verifying read-back afterwards
 * that fell over — which the adapter reports by turning `ok` off while leaving
 * `action` alone.
 *
 * "Not applied" is then the opposite of what happened, in red, and it sends
 * the operator to apply an SSID that may already be on the tenant. Same reason
 * an assignment Central took but did not list is not marked ✗.
 */
function profileWrittenButUnconfirmed(profile: SsidProfileStepResult): boolean {
  return !profile.ok && !profile.verified && profile.action !== 'failed';
}

/**
 * The apply succeeded but the server could not re-read Central afterwards, so
 * the SSID list below is still the pre-change one. Silence here is what makes
 * a successful write look like a failed one: the operator is congratulated and
 * then shown a list without their SSID in it, and applies it again.
 *
 * Returns null when a refresh was never attempted — that is the correct state
 * for a write that changed nothing, and is not the same as one that failed.
 */
function cacheStaleNote(result: SsidApplyResult): string | null {
  const refresh = result.cacheRefresh;
  if (!refresh?.attempted || refresh.ok) return null;
  return ` The SSID list below could not be re-read (${
    refresh.message ?? 'reason not reported'
  }), so it does not show this change yet — do not apply it again.`;
}

function assignmentPartialTitle(assignments: readonly SsidScopeAssignmentResult[]): string {
  const unconfirmed = assignments.some((a) => a.verified === false);
  const failed = assignments.some((a) => !a.ok && a.verified !== false);
  if (unconfirmed && !failed) return 'Partial — profile applied, scope assignments not confirmed';
  if (unconfirmed) return 'Partial — profile applied, an assignment failed and another is unconfirmed';
  return 'Partial — profile applied, an assignment failed';
}

/** The headline for a result with no failures in it, which is not the same
 *  thing as a result we can vouch for. */
function assignmentAppliedTitle(assignments: readonly SsidScopeAssignmentResult[]): string {
  const n = unconfirmedCount(assignments);
  if (n === 0) return 'Applied';
  return n === assignments.length
    ? 'Applied — no scope assignment could be confirmed'
    : `Applied — ${n} scope ${n === 1 ? 'assignment was' : 'assignments were'} not confirmed`;
}

export default function Configure() {
  const { showPlatformTags } = useSettings();
  const { toast } = useToast();
  const location = useLocation();
  const navigate = useNavigate();
  const [data, setData] = useState<ConfigureData | null>(null);
  const [queue, setQueue] = useState<QueueEntry[] | null>(null);
  const [queueSource, setQueueSource] = useState<'server' | 'local'>('local');
  // Until the settings endpoint answers, retain the hardened presentation.
  // Once it does, omitted configMode means the server's lab-direct default.
  const [labConfigMode, setLabConfigMode] = useState(false);
  /* Queue-table selection for the bulk action bar: the DataTable's controlled
   * selectedKeys pair (checkbox column + select-all header + the x/Esc
   * keyboard grid). `bulkBusy` serializes a bulk run — one at a time, never
   * stacked behind clicks. */
  const [queueSel, setQueueSel] = useState<string[]>([]);
  const [bulkBusy, setBulkBusy] = useState<'approve' | 'reject' | null>(null);

  const [kind, setKind] = useState<ConfigKind | null>(null);
  const [ssid, setSsid] = useState<SsidForm>(DEFAULT_SSID_FORM);
  const [port, setPort] = useState<PortForm>(DEFAULT_PORT_FORM);
  const [vlan, setVlan] = useState<VlanForm>(DEFAULT_VLAN_FORM);
  const [genericSource, setGenericSource] = useState<'configured' | 'observed' | 'new'>('new');
  const [configuredVlanIdentity, setConfiguredVlanIdentity] = useState<{ id: string; scope: VlanScope } | null>(null);
  const [ticket, setTicket] = useState('');
  const [queued, setQueued] = useState(false);
  const [showDormantTargets, setShowDormantTargets] = useState(false);
  const [dryRun, setDryRun] = useState<{ result?: DryRunResult; error?: string } | null>(null);
  const [dryRunning, setDryRunning] = useState(false);
  const [directApply, setDirectApply] = useState<{ result?: ImmediateApplyResult; error?: string } | null>(null);
  const [directApplying, setDirectApplying] = useState(false);
  const [pushing, setPushing] = useState(false);
  // Lease countdowns must not freeze at first paint — a 30s tick is enough
  // resolution for a fifteen-minute lease.
  const [now, setNow] = useState(() => Date.now());
  const [historyOpen, setHistoryOpen] = useState(false);
  const [history, setHistory] = useState<HistoryState>({ kind: 'loading' });
  const [portQuery, setPortQuery] = useState('');
  const [expandedSwitches, setExpandedSwitches] = useState<Set<string>>(new Set());
  const [visiblePorts, setVisiblePorts] = useState<Record<string, number>>({});
  // -- SSID direct apply (no ticket/queue — see server/src/services/ssidDirectWrite.ts) --
  const [ssidCatalog, setSsidCatalog] = useState<SsidCatalog | null>(null);
  const [ssidCatalogLoading, setSsidCatalogLoading] = useState(false);
  const [ssidCatalogError, setSsidCatalogError] = useState<string | null>(null);
  const [ssidReviewed, setSsidReviewed] = useState(false);
  const [ssidApplying, setSsidApplying] = useState(false);
  const [ssidApplyResult, setSsidApplyResult] = useState<{ result?: SsidApplyResult; error?: string } | null>(null);
  const [ssidDeepLinkWarning, setSsidDeepLinkWarning] = useState<string | null>(null);
  const handledSsidLocationKeyRef = useRef<string | null>(null);
  // Blend mode swaps this screen's inventory to observed live rows while the
  // envelope still reads 'demo' (README §blendLive), so every live-flavoured
  // affordance follows the section, not the envelope's overall dataSource.
  const liveMode =
    data?.dataSource === 'live' || (data?.blended?.includes('configure') ?? false);

  useEffect(() => {
    let live = true;
    void (async () => {
      // The settings response is the admission-mode boundary. Do not ask the
      // broker about a queue that confirmed lab mode will neither show nor use.
      const [d, portal] = await Promise.all([getConfigure(), getPortalSettings()]);
      if (!live) return;
      const lab = portal !== null && portal.configMode !== false;
      setLabConfigMode(lab);
      if (lab) {
        setData(d);
        setQueue([]);
        setQueueSource('local');
        return;
      }

      // A missing/unreachable settings response remains hardened. Only that
      // path reads the broker queue, so its existing failure semantics stay
      // exactly where they protect ticketed configuration.
      const serverQueue = await getChangeQueue();
      if (!live) return;
      if (isApiError(serverQueue)) {
        setData({ ...d, apiError: serverQueue.error });
        setQueue([]);
      } else {
        setData(d);
      }
      if (Array.isArray(serverQueue)) {
        // Backend reachable — the write broker's queue is authoritative.
        setQueue(serverQueue.map(rowForChange));
        setQueueSource('server');
      } else if (!isApiError(serverQueue)) {
        // The broker's own queue endpoint is unreachable, so the section
        // payload's rows are all there is. QueuedChangeRow now carries the
        // broker's `id` when the row came from the broker (null/absent on the
        // authored fixtures, which is what correctly makes those unpushable) —
        // honour it rather than flattening every row to a local, id-less one.
        setQueue(d.queued.map((q) => ({ ...q, id: q.id ?? null })));
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(t);
  }, []);

  // A dry-run result is stale the moment the form or ticket changes — drop it.
  // State adjusted during render (the React-docs pattern for a changed input):
  // an effect would commit the stale result for one frame first.
  const dryRunInputs = [kind, ssid, port, vlan, ticket] as const;
  const [prevDryRunInputs, setPrevDryRunInputs] = useState(dryRunInputs);
  if (prevDryRunInputs.some((v, i) => v !== dryRunInputs[i])) {
    setPrevDryRunInputs(dryRunInputs);
    setDryRun(null);
  }

  // The "Queued for push" alert clears on the next form edit (the prototype
  // resets `queued` in every form setter — but NOT on a ticket edit).
  const queuedInputs = [kind, ssid, port, vlan] as const;
  const [prevQueuedInputs, setPrevQueuedInputs] = useState(queuedInputs);
  if (prevQueuedInputs.some((v, i) => v !== queuedInputs[i])) {
    setPrevQueuedInputs(queuedInputs);
    setQueued(false);
  }

  // A stale review/apply result must not survive an edit to the form it
  // described — the operator is reviewing a DIFFERENT payload now.
  const [prevSsid, setPrevSsid] = useState(ssid);
  if (prevSsid !== ssid) {
    setPrevSsid(ssid);
    setSsidReviewed(false);
    setSsidApplyResult(null);
  }

  // Direct-apply evidence belongs to precisely the current port/VLAN form.
  // Editing either field creates a new write candidate, so never leave the
  // previous result beside it.
  const directApplyInputs = [kind, port, vlan] as const;
  const [prevDirectApplyInputs, setPrevDirectApplyInputs] = useState(directApplyInputs);
  if (prevDirectApplyInputs.some((v, i) => v !== directApplyInputs[i])) {
    setPrevDirectApplyInputs(directApplyInputs);
    setDirectApply(null);
  }

  // A selection that outlives its rows is a lie about what an Approve would
  // touch: prune keys whose rows left the queue (pushed, discarded, refreshed
  // away). Same render-time adjustment pattern as the stale-input resets above.
  const [prevQueue, setPrevQueue] = useState(queue);
  if (prevQueue !== queue) {
    setPrevQueue(queue);
    const keys = new Set((queue ?? []).map(queueRowKey));
    const pruned = queueSel.filter((k) => keys.has(k));
    if (pruned.length !== queueSel.length) setQueueSel(pruned);
  }

  // -- live preview: recomputed on every keystroke and toggle ---------------
  const mistSsid = kind === 'ssid' && ssidPlaneOf(ssid) === 'mist';
  const preview = useMemo(() => {
    // A Mist-targeted SSID renders its real site-scoped WLAN call even in
    // demo mode — the authored CLI template's "mist → read-only" annotation
    // predates the direct write path and would be a lie beside it.
    if (liveMode || mistSsid)
      return livePreview(
        kind ?? 'ssid',
        formForPreview(kind, ssid, port, vlan),
        data?.capabilities ?? [],
        labConfigMode,
      );
    if (kind === 'port') return configPreviewFor('port', port);
    if (kind === 'vlan') return configPreviewFor('vlan', vlan);
    return configPreviewFor('ssid', ssid);
  }, [data?.capabilities, kind, labConfigMode, liveMode, mistSsid, ssid, port, vlan]);
  const previewMeta = useMemo(() => {
    if (liveMode || mistSsid) {
      if (mistSsid) return `${ssid.plane || 'MIST'} · SITE-SCOPED WLAN`;
      if (kind === 'port') return `${port.device || 'DEVICE NOT ENTERED'} · TEMPLATE PREVIEW`;
      if (kind === 'vlan') return `${vlan.scope.toUpperCase()} · TEMPLATE PREVIEW`;
      return `${ssid.plane || 'CENTRAL'} · TEMPLATE PREVIEW`;
    }
    if (kind === 'port') return previewMetaFor('port', port);
    if (kind === 'vlan') return previewMetaFor('vlan', vlan);
    return previewMetaFor('ssid', ssid);
  }, [kind, liveMode, mistSsid, ssid, port, vlan]);
  const radius = useMemo(() => {
    if (liveMode || mistSsid) {
      return liveRadius(kind ?? 'ssid', formForPreview(kind, ssid, port, vlan), labConfigMode);
    }
    if (kind === 'port') return blastRadiusFor('port', port);
    if (kind === 'vlan') return blastRadiusFor('vlan', vlan);
    return blastRadiusFor('ssid', ssid);
  }, [kind, labConfigMode, liveMode, mistSsid, ssid, port, vlan]);

  // -- SSID direct-apply derived state ---------------------------------------
  /** The deployment reported a Mist direct-write path (capability matrix
   *  'direct' mode) — the drawer offers the plane choice only then, never
   *  from the form's own claim. */
  const centralCapability = (data?.capabilities ?? []).find((c) => c.planeId === 'central');
  const mistCapability = (data?.capabilities ?? []).find((c) => c.planeId === 'mist');
  const mistDirectAvailable = !liveMode
    ? mistCapability?.mode === 'direct'
    : mistCapability?.canDirectWrite === true;
  const ssidTargetCanWrite =
    !liveMode || (mistSsid ? mistCapability?.canDirectWrite === true : centralCapability?.canDirectWrite === true);
  const genericTargetCanWrite = centralCapability?.canBrokerWrite === true;
  /** What the form's security mode cannot express on Mist — the shared
   *  sentence the adapter refuses with, so drawer and plane never disagree. */
  const mistRefusal = mistSsid ? mistSsidSecurityRefusal(ssid.security) : null;
  const ssidRequirement = useMemo(
    () => ssidDependencyRequirementsFor(ssid.security, ssid.plane),
    [ssid.security, ssid.plane],
  );
  const ssidScopeGroups = useMemo(() => groupScopesByCategory(ssidCatalog?.scopes ?? []), [ssidCatalog]);
  const ssidMissingDependencies = useMemo(() => {
    if (!ssidCatalog) return [];
    const missing: string[] = [];
    if (ssidRequirement.role && ssidCatalog.unavailable.includes('roles')) missing.push('roles');
    if (ssidRequirement.authServerGroup && ssidCatalog.unavailable.includes('authServerGroups')) {
      missing.push('authentication server groups');
    }
    if (ssidRequirement.captivePortal && ssidCatalog.unavailable.includes('captivePortalProfiles')) missing.push('captive-portal profiles');
    return missing;
  }, [ssidCatalog, ssidRequirement]);
  /* The value rules the broker and the direct-apply validator have always
     enforced, applied where the value is typed instead of one round trip
     later. A VLAN of 4095 or a 40-character SSID could be filled in, reviewed,
     ticked as reviewed and submitted before anything said no — and when the
     broker was unreachable, `queueIt`'s offline fallback parked it in the
     local queue, where it sat listed as a change waiting to be pushed
     alongside changes that could actually be pushed.

     Only values the operator has actually entered are judged. An untouched
     field is incomplete, not wrong, and `formComplete` below already covers
     it; reporting "SSID name is required" on a form nobody has typed into
     teaches people to ignore the box. */
  const valueProblems = useMemo(() => {
    const problems: Array<string | null> = [];
    if (kind === 'ssid') {
      if (ssid.name.trim()) problems.push(ssidNameProblem(ssid.name));
      if (ssid.vlan.trim()) problems.push(vlanIdProblem(ssid.vlan));
      if (ssid.passphrase) problems.push(wpaPassphraseProblem(ssid.passphrase));
    } else if (kind === 'port') {
      if (port.vlan.trim()) problems.push(vlanIdProblem(port.vlan));
    } else if (kind === 'vlan') {
      if (vlan.id.trim()) problems.push(vlanIdProblem(vlan.id));
    }
    return problems.filter((p): p is string => p !== null);
  }, [kind, ssid, port, vlan]);

  const ssidFormComplete =
    ssid.name.trim().length > 0 &&
    ssid.vlan.trim().length > 0 &&
    (ssid.scopeIds?.length ?? 0) > 0 &&
    (!ssidRequirement.role || !!ssid.defaultRole) &&
    (!ssidRequirement.authServerGroup || !!ssid.authServerGroupId) &&
    (!ssidRequirement.captivePortal || !!ssid.captivePortalProfileId) &&
    (!ssidRequirement.passphrase || !!ssid.passphrase);
  const ssidApplyDisabled =
    !ssidTargetCanWrite ||
    !ssidFormComplete ||
    valueProblems.length > 0 ||
    ssidMissingDependencies.length > 0 ||
    mistRefusal !== null ||
    (!labConfigMode && !ssidReviewed) ||
    ssidApplying ||
    ssidCatalogLoading ||
    !ssidCatalog;
  const genericFormComplete =
    kind === 'port'
      ? port.device.trim().length > 0 && port.id.trim().length > 0 && port.vlan.trim().length > 0
      : kind === 'vlan'
        ? vlan.id.trim().length > 0 && vlan.helpers.trim().length > 0 && vlan.scope.trim().length > 0
        : false;
  const genericHasConfiguredProvenance = genericSource === 'configured';
  const genericHasExactIdentity =
    (kind === 'port'
      ? port.plane === 'CENTRAL' && (port.serial?.trim().length ?? 0) > 0
      : kind === 'vlan'
        ? vlan.plane === 'CENTRAL' &&
          configuredVlanIdentity !== null &&
          vlan.id === configuredVlanIdentity.id &&
          vlan.scope === configuredVlanIdentity.scope
        : false);
  const directReplayBlocked = Boolean(
    directApply?.result &&
      (directApply.result.outcomeUnknown || directApply.result.accepted || directApply.result.applied),
  );
  const directFormComplete =
    genericFormComplete &&
    genericHasConfiguredProvenance &&
    genericHasExactIdentity &&
    genericTargetCanWrite;

  const switchGroups = useMemo(() => groupSwitchPorts(data?.ports ?? []), [data?.ports]);
  const filteredSwitchGroups = useMemo(() => {
    const query = portQuery.trim().toLowerCase();
    if (!query) return switchGroups;
    return switchGroups
      .map((group) => ({
        ...group,
        ports: group.ports.filter((port) =>
          `${port.device} ${port.port} ${port.desc} ${port.summary} ${port.state} ${port.plane ?? ''} ${port.serial ?? ''}`
            .toLowerCase()
            .includes(query),
        ),
      }))
      .filter((group) => group.device.toLowerCase().includes(query) || group.ports.length > 0);
  }, [portQuery, switchGroups]);

  /** Load the editor's live scope/dependency catalog — called every time the
   *  SSID drawer opens (and every time its plane changes), never cached
   *  across opens (a stale catalog could offer a scope or profile id the
   *  plane no longer has). */
  const loadSsidCatalog = useCallback(async (plane: 'mist' | 'central') => {
    setSsidCatalogLoading(true);
    setSsidCatalogError(null);
    const r = await getSsidCatalog(plane);
    setSsidCatalogLoading(false);
    if (isApiError(r)) {
      setSsidCatalogError(r.error);
      setSsidCatalog(null);
      return;
    }
    if (r === null) {
      setSsidCatalogError('The portal backend did not answer — reconnect it, then reopen this drawer.');
      setSsidCatalog(null);
      return;
    }
    setSsidCatalog(r);
  }, []);

  // -- drawer openers: seed the form over its current state ------------------
  const openSsid = useCallback((row?: SsidObject) => {
    const seeded: SsidForm = {
      ...(liveMode ? LIVE_SSID_FORM : DEFAULT_SSID_FORM),
      ...(row
        ? seedFormFromRow('ssid', row)
        : liveMode
          ? {}
          : { name: 'MRDN-New', vlan: '830', security: 'wpa3-enterprise' as SsidSecurity }),
      // Never invent scope/dependency selections for an edited row — the
      // catalog read above is what the operator picks from, not a guess.
      scopeIds: [],
      defaultRole: undefined,
      authServerGroupId: undefined,
      captivePortalProfileId: undefined,
      passphrase: undefined,
    };
    setSsid(seeded);
    setKind('ssid');
    setSsidReviewed(false);
    setSsidApplyResult(null);
    void loadSsidCatalog(ssidPlaneOf(seeded));
  }, [liveMode, loadSsidCatalog]);

  const handleDeepLink = useCallback(
    (params: URLSearchParams) => {
      const identity = parseSsidDeepLink(params);
      const row = identity && data ? locateSsidDeepLink(data.ssids, identity) : null;
      if (row) {
        setSsidDeepLinkWarning(null);
        openSsid({ ...row, plane: identity!.plane });
      } else {
        setSsidDeepLinkWarning('The requested WLAN is no longer an exact loaded inventory row. Nothing was opened.');
      }
    },
    [data, openSsid],
  );

  /** A WLAN URL is a pointer to an already-loaded inventory row, never a form
   * payload. Resolve it once after data arrives; a stale or malformed pointer
   * gets an honest warning rather than query text becoming a writable SSID. */
  useEffect(() => {
    // `openSsid` also starts its catalog read, whose helper is initialized
    // only after the loading return below. Wait for the full screen payload.
    if (!data || !queue) return;
    const params = new URLSearchParams(location.search);
    if (!params.getAll('edit').includes('ssid') || handledSsidLocationKeyRef.current === location.key) return;

    handledSsidLocationKeyRef.current = location.key;
    handleDeepLink(params);

    for (const key of ['edit', 'plane', 'name', 'vlan', 'targets']) params.delete(key);
    const search = params.toString();
    navigate({ pathname: location.pathname, search: search ? `?${search}` : '', hash: location.hash }, { replace: true });
  }, [data, handleDeepLink, location, navigate, queue]);

  const toggleSwitch = (key: string) => {
    setExpandedSwitches((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  if (!data || !queue) {
    return <PageSkeleton variant="list" />;
  }
  if (data.apiError) return <ApiErrorState message={data.apiError} />;
  const observedInventory = data.inventoryMode === 'observed';

  /* A push target the portal can actually reach is worth a row of its own. The
     planes that hold no credentials say the same thing as each other, so they
     collapse behind one line rather than filling the rail. The split reads the
     explicit `linked` flag — matching on the note's prose would quietly break
     the moment that wording is reworded. */
  const dormantTargets = data.capabilities.filter((c) => !c.linked);
  const writableTargets = data.capabilities.filter((c) => c.linked);

  /* The queue table's columns. The first is the selection checkbox — its
     header is the select-all — and 'change' is non-hideable because it is the
     row's primary identifier (the same rule the Alerts queue gives its
     'alert' column). Selection itself lives in the controlled queueSel pair,
     so the bulk bar below the table reads exactly what the checkboxes show. */
  const allQueueSelected = queue.length > 0 && queueSel.length === queue.length;
  const queueColumns: Array<DataTableColumn<QueueEntry>> = [
    {
      key: 'select',
      title: 'Select',
      hideable: false,
      width: 40,
      header: (
        <Checkbox
          aria-label="Select all queued changes"
          checked={allQueueSelected}
          onChange={() => setQueueSel(allQueueSelected ? [] : queue.map(queueRowKey))}
        />
      ),
      render: (q) => {
        const key = queueRowKey(q);
        return (
          <Checkbox
            aria-label={`Select change: ${q.what}`}
            checked={queueSel.includes(key)}
            onChange={() =>
              setQueueSel((cur) => (cur.includes(key) ? cur.filter((k) => k !== key) : [...cur, key]))
            }
          />
        );
      },
    },
    {
      key: 'state',
      title: 'State',
      width: 110,
      render: (q) => <Badge tone={q.tone}>{q.state}</Badge>,
    },
    {
      key: 'change',
      title: 'Change',
      hideable: false,
      render: (q) => {
        const lease = leaseNote(q, now);
        const leaseGone = lease?.startsWith('lease expired') ?? false;
        return (
          <div className="nt-stack nt-gap-5">
            <span className="nt-configure-queue__what">{q.what}</span>
            <span
              className="nt-mono-label"
            >
              {q.where}
            </span>
            {lease ? (
              <span
                className="nt-hint-muted"
                style={{ color: leaseGone ? 'var(--nd-warning)' : 'var(--nd-text-muted)' }}
              >
                {lease}
              </span>
            ) : null}
          </div>
        );
      },
    },
    {
      key: 'ticket',
      title: 'Ticket',
      width: 110,
      render: (q) => (
        <span className="nt-mono-label">
          {q.ticket}
        </span>
      ),
    },
  ];

  /**
   * The drawer's plane choice (offered only when the deployment reported a
   * Mist direct-write path). Switching planes clears every plane-scoped
   * selection — a Central scope id or server group is not a Mist site — and
   * reloads the catalog from the plane that now owns the write.
   */
  const switchSsidPlane = (plane: 'CENTRAL' | 'MIST') => {
    const next: SsidForm = {
      ...ssid,
      plane,
      scopeIds: [],
      defaultRole: undefined,
      authServerGroupId: undefined,
      captivePortalProfileId: undefined,
      // `enabled` is a Mist WLAN field; Central's profile upsert always
      // writes enable:true, so the switch (and the field) exists for Mist
      // only. A new Mist WLAN starts enabled — the operator can say otherwise.
      enabled: plane === 'MIST' ? (ssid.enabled ?? true) : undefined,
    };
    setSsid(next);
    void loadSsidCatalog(ssidPlaneOf(next));
  };
  const openPort = (row?: PortObject) => {
    setPort({
      ...(liveMode ? LIVE_PORT_FORM : DEFAULT_PORT_FORM),
      ...(row ? seedFormFromRow('port', row, { live: liveMode }) : {}),
    });
    setConfiguredVlanIdentity(null);
    setGenericSource(row?.origin === 'configured' ? 'configured' : row ? 'observed' : 'new');
    setKind('port');
  };
  const openVlan = (row?: VlanObject) => {
    setVlan({
      ...(liveMode ? LIVE_VLAN_FORM : DEFAULT_VLAN_FORM),
      ...(row
        ? seedFormFromRow('vlan', row, { live: liveMode })
        : liveMode
          ? {}
          : { id: '', name: '', helpers: '10.42.0.20, 10.44.0.20' }),
    });
    setConfiguredVlanIdentity(
      row?.origin === 'configured' && row.plane === 'CENTRAL' && row.scope
        ? { id: row.id, scope: row.scope }
        : null,
    );
    setGenericSource(row?.origin === 'configured' ? 'configured' : row ? 'observed' : 'new');
    setKind('vlan');
  };

  // -- queue actions ----------------------------------------------------------
  const formFor = (k: ConfigKind): ConfigForm => (k === 'port' ? port : k === 'vlan' ? vlan : ssid);
  const readyCount = queue.filter((q) => q.state === 'ready').length;

  /**
   * Open the audit drawer and read the broker's log. Every open re-reads it —
   * the log grows with each push, and a cached list would be a stale claim
   * about what has been brokered.
   */
  const openHistory = async () => {
    setHistoryOpen(true);
    setHistory({ kind: 'loading' });
    const r = await getChangeHistory();
    if (isApiError(r)) setHistory({ kind: 'error', message: r.error });
    else if (r === null) setHistory({ kind: 'offline' });
    else setHistory({ kind: 'ok', events: r.events, unreadable: r.unreadable });
  };

  /** Re-read the broker's queue; false when the backend dropped out from under us. */
  const refreshServerQueue = async (preserveLocal = true): Promise<boolean> => {
    const serverQueue = await getChangeQueue();
    if (isApiError(serverQueue)) {
      toast(serverQueue.error, { tone: 'danger' });
      return false;
    }
    if (!serverQueue) return false;
    setQueue((current) => [
      ...serverQueue.map(rowForChange),
      ...(preserveLocal ? (current ?? []).filter((entry) => entry.id === null) : []),
    ]);
    setQueueSource('server');
    return true;
  };

  const pushQueue = async () => {
    if (readyCount === 0 || pushing) return;
    setPushing(true);
    let anyApplied = false;
    if (queueSource === 'server') {
      for (const entry of queue.filter((q) => q.state === 'ready' && q.id !== null)) {
        const r = await pushChange(entry.id as string);
        if (isApiError(r)) {
          toast(r.error, { description: entry.what, tone: 'danger' });
        } else if (r.outcomeUnknown) {
          toast('Outcome unknown — reconciliation required', {
            description: `${entry.what} — ${r.message}`,
            tone: 'warning',
          });
        } else if (r.applied) {
          anyApplied = true;
          // The lists below are this operator's evidence that the push worked.
          // When the server could not re-read Central they are still the
          // pre-change ones, and saying only "applied" over them invites the
          // change to be queued a second time.
          const stale = r.cacheRefresh?.attempted && !r.cacheRefresh.ok;
          toast(r.message, {
            description: stale
              ? `${entry.what} — the lists below could not be re-read (${
                  r.cacheRefresh?.message ?? 'reason not reported'
                }), so they do not show this yet. Do not queue it again.`
              : entry.what,
            tone: stale ? 'warning' : 'success',
          });
        } else if (r.accepted) {
          // Central took it and has not said it is done. A success tone here
          // would end the operator's involvement in a change that may never
          // land; a danger tone would send them chasing a failure that has not
          // happened. It is its own outcome and reads as one.
          toast('Accepted by Central, not yet confirmed', {
            description: `${entry.what} — ${r.message}`,
            tone: 'warning',
          });
        } else {
          // Rendered-but-unverified and rejected pushes are honest outcomes.
          toast(r.message, { description: entry.what, tone: 'warning' });
        }
      }
      await refreshServerQueue();
      // refreshServerQueue() re-reads the ticket queue, which is a different
      // thing from the estate. Without this the change left the queue and the
      // SSID/VLAN/port lists beside it carried on showing the state from
      // before it for up to a full poll interval.
      if (anyApplied) setData(await getConfigure());
    }
    // Entries queued while the broker was unreachable have no server id.
    // Keep them visible until they can be submitted to the authoritative
    // broker; never claim a push happened without a server acknowledgement.
    // When the broker's own queue never answered, NOTHING above was pushed —
    // an id-bearing row from the section payload is un-pushed too, and must
    // not fall silently between the two branches.
    const local = queue.filter(
      (q) => q.state === 'ready' && (queueSource !== 'server' || q.id === null),
    );
    if (local.length > 0) {
      toast(`${countOf(local.length, 'local change')} not pushed`, {
        description: 'Reconnect the portal backend, then queue the change again so the broker can assign an id.',
        tone: 'warning',
      });
    }
    setPushing(false);
  };

  const discardAll = async () => {
    if (queue.length === 0) return;
    if (queueSource === 'server') {
      for (const entry of queue.filter((q) => q.id !== null)) {
        const r = await discardChange(entry.id as string);
        if (isApiError(r)) toast(r.error, { description: entry.what, tone: 'danger' });
      }
      // A successful refresh is authoritative — local leftovers are gone too.
      if (await refreshServerQueue(false)) return;
    }
    // Offline (or the broker dropped mid-discard): drop the local entries;
    // anything with a server id stays listed, still on the broker.
    setQueue((q) => (q ?? []).filter((x) => x.id !== null));
  };

  /**
   * Bulk approve: the selected rows pushed one at a time through the EXISTING
   * per-item broker flow — the same pushChange call Push queue makes per
   * ready entry, so every change keeps its own review, lease and audit line;
   * the bar only iterates. The summary toast names the per-item outcomes:
   * applied, accepted (a 202 is neither success nor failure), unknown
   * (transport confirmation was lost), failed, and skipped (not ready, or a
   * local row with no broker id) — the failures named, never folded into a
   * green count, and unknown outcomes never presented as safe to retry.
   */
  const bulkApprove = async () => {
    if (bulkBusy) return;
    const targets = queue.filter((q) => queueSel.includes(queueRowKey(q)));
    if (targets.length === 0) return;
    setBulkBusy('approve');
    let applied = 0;
    let anyApplied = false;
    const accepted: string[] = [];
    const unknown: string[] = [];
    const failed: string[] = [];
    const skipped: string[] = [];
    if (queueSource === 'server') {
      for (const entry of targets) {
        if (entry.id === null || entry.state !== 'ready') {
          skipped.push(entry.what);
          continue;
        }
        const r = await pushChange(entry.id);
        if (isApiError(r)) failed.push(entry.what);
        else if (r.outcomeUnknown) unknown.push(entry.what);
        else if (r.applied) {
          applied++;
          anyApplied = true;
        } else if (r.accepted) accepted.push(entry.what);
        else failed.push(entry.what);
      }
      await refreshServerQueue();
      // Same rule as Push queue: an applied change re-reads the estate, or
      // the lists beside the queue argue for queueing it a second time.
      if (anyApplied) setData(await getConfigure());
    } else {
      // No broker answered: nothing here can be pushed — every selected row
      // is local, exactly like Push queue's offline branch.
      skipped.push(...targets.map((q) => q.what));
    }
    const parts: string[] = [];
    if (accepted.length > 0) parts.push(`accepted, not yet confirmed: ${nameList(accepted)}`);
    if (unknown.length > 0) parts.push(`outcome unknown — reconciliation required: ${nameList(unknown)}`);
    if (failed.length > 0) parts.push(`failed: ${nameList(failed)}`);
    if (skipped.length > 0) {
      parts.push(
        queueSource === 'server'
          ? `skipped (not ready or no broker id): ${nameList(skipped)}`
          : `not pushed — reconnect the portal backend, then queue the change again: ${nameList(skipped)}`,
      );
    }
    toast(`Bulk approve — ${applied} of ${targets.length} applied`, {
      description: parts.length > 0 ? parts.join(' · ') : undefined,
      tone:
        failed.length > 0
          ? applied + accepted.length + unknown.length > 0
            ? 'warning'
            : 'danger'
          : accepted.length + unknown.length + skipped.length > 0
            ? 'warning'
            : 'success',
    });
    setQueueSel([]);
    setBulkBusy(null);
  };

  /**
   * Bulk reject: the selected rows discarded one at a time through the same
   * per-item discardChange call Discard uses — nothing leaves the broker
   * without its own audit line. Selected local rows (no broker id) exist
   * nowhere but here, so dropping them IS their discard; an id-bearing row
   * the broker cannot answer for is named as failed, not silently kept.
   */
  const bulkReject = async () => {
    if (bulkBusy) return;
    const targets = queue.filter((q) => queueSel.includes(queueRowKey(q)));
    if (targets.length === 0) return;
    setBulkBusy('reject');
    let discarded = 0;
    const failed: string[] = [];
    if (queueSource === 'server') {
      for (const entry of targets) {
        if (entry.id === null) continue; // local rows are dropped below
        const r = await discardChange(entry.id);
        if (isApiError(r)) failed.push(entry.what);
        else discarded++;
      }
      const localKeys = new Set(targets.filter((q) => q.id === null).map(queueRowKey));
      if (localKeys.size > 0) {
        discarded += localKeys.size;
        setQueue((cur) => (cur ?? []).filter((q) => !localKeys.has(queueRowKey(q))));
      }
      await refreshServerQueue();
    } else {
      const dropKeys = new Set(targets.filter((q) => q.id === null).map(queueRowKey));
      for (const entry of targets) {
        if (entry.id === null) discarded++;
        else failed.push(entry.what);
      }
      if (dropKeys.size > 0) setQueue((cur) => (cur ?? []).filter((q) => !dropKeys.has(queueRowKey(q))));
    }
    toast(`Bulk reject — ${discarded} of ${targets.length} discarded`, {
      description: failed.length > 0 ? `failed: ${nameList(failed)}` : undefined,
      tone: failed.length > 0 ? (discarded > 0 ? 'warning' : 'danger') : 'success',
    });
    setQueueSel([]);
    setBulkBusy(null);
  };

  const queueIt = async () => {
    const t = ticket.trim();
    if (!kind || !t || !genericFormComplete) return;
    const r = await queueChange(kind, formFor(kind), t);
    if (isApiError(r)) {
      if (r.offline) {
        // Offline fallback: local-only queue, exactly as before the broker.
        setQueue((q) => [...(q ?? []), queuedEntryFor(kind, ssid, port, vlan, t)]);
        setQueued(true);
        return;
      }
      toast(r.error, { tone: 'danger' });
      return;
    }
    await refreshServerQueue();
    setQueued(true);
  };

  const doDryRun = async () => {
    if (!kind || dryRunning || !genericFormComplete) return;
    setDryRunning(true);
    const r = await dryRunConfig(kind, formFor(kind), ticket.trim());
    setDryRunning(false);
    if (isApiError(r)) {
      if (r.offline) {
        // Offline fallback: the render is computed shared-side anyway.
        toast('dry run: payload renders clean', { tone: 'info' });
        return;
      }
      setDryRun({ error: r.error });
      return;
    }
    setDryRun({ result: r });
  };

  /** Apply a supported Central port/VLAN immediately in lab mode. The result
   * stays in the drawer because a returned 202 or failed read-back is evidence
   * to act on, not a completed change. */
  const applyDirect = async () => {
    if (!labConfigMode || !kind || kind === 'ssid' || directApplying || !directFormComplete || directReplayBlocked) return;
    setDirectApplying(true);
    const r = await applyConfigDirect(kind, formFor(kind));
    setDirectApplying(false);
    if (isApiError(r)) {
      setDirectApply({ error: r.error });
      toast(r.error, { tone: 'danger' });
      return;
    }
    setDirectApply({ result: r });
    const stale = r.cacheRefresh?.attempted && !r.cacheRefresh.ok;
    if (r.outcomeUnknown) {
      toast('Outcome unknown — reconciliation required', { description: r.message, tone: 'warning' });
    } else if (r.applied) {
      toast(r.message, {
        description: stale
          ? `The lists below could not be re-read (${r.cacheRefresh?.message ?? 'reason not reported'}), so they do not show this yet. Do not apply it again.`
          : undefined,
        tone: stale ? 'warning' : 'success',
      });
      setData(await getConfigure());
    } else if (r.accepted) {
      toast('Accepted by Central, not yet confirmed', { description: r.message, tone: 'warning' });
    } else {
      toast(r.message, { tone: 'danger' });
    }
  };

  /**
   * Apply a reviewed SSID change directly (no ticket/queue). Whenever the
   * profile actually landed — clean, partial, or accepted-but-unconfirmed —
   * the underlying /api/configure inventory is re-fetched so the list reflects
   * it, and the toast says so outright when the server could not re-read
   * Central and the list is therefore still the pre-change one. On failure
   * every entered value stays exactly as typed so the operator can retry.
   */
  const applySsid = async () => {
    if (ssidApplyDisabled) return;
    const planeLabel = ssidPlaneOf(ssid) === 'mist' ? 'Mist' : 'Central';
    setSsidApplying(true);
    // A multi-plane display label ('CENTRAL + MIST') is not a write target:
    // the reviewed apply writes the ONE plane the drawer is showing, and the
    // server refuses anything it cannot place. The Mist copy of a dual-plane
    // SSID is a separate, site-scoped write the operator chooses explicitly.
    const wireForm = ssidFormForSecurity(ssid, ssid.security);
    const r = await applySsidDirect(
      { ...wireForm, plane: ssidPlaneOf(wireForm) === 'mist' ? 'MIST' : 'CENTRAL' },
      labConfigMode ? undefined : true,
    );
    setSsidApplying(false);
    if (isApiError(r)) {
      setSsidApplyResult({ error: r.error });
      toast(r.error, { tone: 'danger' });
      return;
    }
    setSsidApplyResult({ result: r });
    if (r.ok) {
      // Same rule as the panel: no failures is not the same as confirmed.
      const unconfirmed = unconfirmedCount(r.assignments);
      toast(
        unconfirmed > 0 ? `${ssid.name} applied — assignments not confirmed` : `${ssid.name} applied`,
        {
          description:
            (unconfirmed > 0
              ? ssidPlaneOf(ssid) === 'mist'
                ? `${planeLabel} answered the ${unconfirmed === 1 ? 'write' : 'writes'} but a site read-back could not confirm ${unconfirmed === 1 ? 'it' : 'them'}. Check the sites before treating this SSID as live there.`
                : `${planeLabel} answered the assignment ${unconfirmed === 1 ? 'write' : 'writes'} but its assignment list could not be read back. Check the scopes before treating this SSID as live at them.`
              : r.profile.message) + (cacheStaleNote(r) ?? ''),
          tone: unconfirmed > 0 || cacheStaleNote(r) !== null ? 'warning' : 'success',
        },
      );
      const refreshed = await getConfigure();
      setData(refreshed);
    } else if (r.partial) {
      const unconfirmed = r.assignments.some((a) => a.verified === false);
      toast(
        unconfirmed
          ? `${ssid.name}: profile applied, scope assignments not confirmed`
          : `${ssid.name}: profile applied, one or more scope assignments failed`,
        {
          description:
            (unconfirmed
              ? `${planeLabel} took the assignment but it is not in the list yet. Re-check before treating the SSID as live at those scopes — the profile was not rolled back.`
              : 'Review the assignment results below and retry — the profile was not rolled back.') +
            (cacheStaleNote(r) ?? ''),
          tone: 'warning',
        },
      );
      // A partial apply still wrote the profile — it is explicitly not rolled
      // back — so the list below is out of date for exactly the same reason it
      // is after a clean apply, and the operator is about to retry from it.
      const refreshedPartial = await getConfigure();
      setData(refreshedPartial);
    } else if (profileWrittenButUnconfirmed(r.profile)) {
      toast(`${ssid.name}: profile ${r.profile.action}, not confirmed`, {
        description:
          `${r.profile.message}. ${planeLabel} accepted the write — check the SSID in ${planeLabel} before applying it again.` +
          (cacheStaleNote(r) ?? ''),
        tone: 'warning',
      });
      // The list below is the only other evidence available, and leaving it
      // showing the pre-change estate argues for the wrong conclusion.
      const refreshed = await getConfigure();
      setData(refreshed);
    } else {
      toast(`${ssid.name} was not applied`, { description: r.profile.message, tone: 'danger' });
    }
  };

  return (
    <div className="nt-configure">
      <ScreenHeader
        overline="Configure / Changes"
        title="Configuration"
        subtitle="Edit the object, not the console — the portal renders it for whichever plane owns it."
        actions={
          <>
            <Button variant="ghost" size="sm" onClick={() => void openHistory()}>
              Change history
            </Button>
            {!labConfigMode || !liveMode ? (
              <Button variant="secondary" size="sm" onClick={() => openVlan()}>
                New VLAN
              </Button>
            ) : null}
            <Button variant="primary" size="sm" onClick={() => openSsid()}>
              New SSID
            </Button>
          </>
        }
      />

      <div className="nt-stat-grid nt-configure__stats">
        {data.stats.map((s) => (
          <Stat key={s.label} label={s.label} value={s.value} delta={s.delta} deltaTone={s.tone} />
        ))}
      </div>

      <Alert tone="info" title={labConfigMode ? 'Lab write workflow is enabled' : 'Writes are brokered, never standing'}>
        <span className="nt-body-sm">
          {labConfigMode
            ? genericTargetCanWrite
              ? 'Admitted Central port and VLAN writes apply immediately. SSIDs keep their dedicated scope-aware apply path.'
              : 'Only connector-admitted writes can apply. No generic Central port or VLAN write is currently admitted, so those forms remain preview-only. SSIDs keep their dedicated scope-aware path.'
            : writeSurfaceNote(data.capabilities)}
        </span>
      </Alert>

      <VisualReferencePanel target={{ kind: 'service', id: 'configure' }} />
      <ConfigRecommendationsPanel title="Config hygiene recommendations" limit={8} />
      <ConfigActionPanel target={{ kind: 'service', id: 'configure' }} targetKind="configure" />

      {ssidDeepLinkWarning ? (
        <Alert tone="warning" title="WLAN edit was not opened">
          {ssidDeepLinkWarning}
        </Alert>
      ) : null}

      {liveMode && data.inventoryMode === 'unavailable' ? (
        <Alert tone="warning" title="Live configuration inventory is not available">
          <span className="nt-body-sm">
            {labConfigMode
              ? 'The linked planes do not currently expose configured port or VLAN rows for immediate apply. SSIDs retain their scope-aware path when the target connector admits writes.'
              : 'The broker queue is live, but the linked planes do not currently expose SSID, port, or VLAN inventory through this API. New changes can still be rendered and queued explicitly.'}
          </span>
        </Alert>
      ) : null}
      {observedInventory ? (
        <Alert tone="info" title="Inventory observed from active client sessions">
          <span className="nt-body-sm">
            These SSIDs, ports, and VLANs were seen in live session telemetry. They are partial evidence, not an
            authoritative running configuration; selecting a row uses it only as a starting point for a new change.
          </span>
        </Alert>
      ) : null}

      <div className="nt-configure__layout">
        {/* ---------------- left: the three object lists ---------------- */}
        <div className="nt-configure__col">
          <div>
            <SectionHeader
              label="Wireless SSIDs"
              meta={
                <button type="button" style={MICRO_LINK} onClick={() => openSsid()}>
                  + Add SSID
                </button>
              }
            />
            {data.ssids.map((w) => (
              <button
                key={w.name}
                type="button"
                className="nt-rowlink nt-configure-row"
                style={ROW}
                onClick={() => openSsid(w)}
              >
                <div className="nt-configure-row__name">
                  <span className="nt-configure-row__name-primary">
                    {w.name}
                  </span>
                  <span className="nt-configure-row__name-meta">
                    {w.vlan}
                  </span>
                </div>
                <span
                  className="nt-configure-row__secondary"
                >
                  {w.security}
                </span>
                <span
                  className="nt-configure-row__summary"
                >
                  {w.targets}
                  {/* A fact with no column of its own — e.g. a Mist WLAN whose
                      payload carried the cleartext key says 'PSK set — redacted
                      by the portal'. The marker is rendered, never the secret. */}
                  {w.note ? <span className="nt-configure-row__note">{w.note}</span> : null}
                </span>
                <span className="nt-configure-row__actions">
                  {w.origin === 'observed' ? <Badge tone="info">Observed</Badge> : null}
                  {showPlatformTags ? <Badge plane>{w.plane}</Badge> : null}
                  <span className="nt-configure-row__action">
                    {w.origin === 'observed' ? 'Use ▸' : 'Edit ▸'}
                  </span>
                </span>
              </button>
            ))}
            {data.ssids.length === 0 ? (
              <EmptyState
                title="No SSIDs reported"
                description={
                  liveMode
                    ? labConfigMode
                      ? 'No linked plane reported wireless configuration. "+ Add SSID" still opens an explicit apply form.'
                      : 'No linked plane reported wireless configuration. "+ Add SSID" still renders and queues a new one.'
                    : 'This payload carries no SSID rows.'
                }
              />
            ) : null}
          </div>

          <div>
            <SectionHeader
              label="Switch ports"
              meta={
                !labConfigMode || !liveMode ? (
                  <button type="button" style={MICRO_LINK} onClick={() => openPort()}>
                    + Configure a port
                  </button>
                ) : undefined
              }
            />
            {data.ports.length > 0 ? (
              <div className="nt-switch-tree__toolbar">
                <Input
                  mono
                  value={portQuery}
                  onChange={(event) => setPortQuery(event.target.value)}
                  placeholder="Filter switch, port, description, VLAN, role, or state…"
                  aria-label="Filter switch ports"
                />
                <div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setExpandedSwitches(new Set(filteredSwitchGroups.map((group) => group.key)))}
                  >
                    Expand shown
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setExpandedSwitches(new Set())}>
                    Collapse all
                  </Button>
                </div>
              </div>
            ) : null}
            <div className="nt-switch-tree">
              {filteredSwitchGroups.map((group) => {
                const open = expandedSwitches.has(group.key) || portQuery.trim().length > 0;
                const pageSize = visiblePorts[group.key] ?? 25;
                const shownPorts = open ? group.ports.slice(0, pageSize) : [];
                return (
                  <div key={group.key} className="nt-switch-tree__group">
                    <button
                      type="button"
                      className="nt-switch-tree__switch"
                      aria-expanded={open}
                      onClick={() => toggleSwitch(group.key)}
                    >
                      <span className="nt-switch-tree__chevron">{open ? '−' : '+'}</span>
                      <span className="nt-switch-tree__identity">
                        <strong>{group.device}</strong>
                        <small>
                          {[group.plane, group.serial].filter(Boolean).join(' · ') || 'inventory identity unavailable'}
                        </small>
                      </span>
                      <span className="nt-switch-tree__counts">
                        <Badge tone="neutral">{group.ports.length} ports</Badge>
                        {group.up > 0 ? <Badge tone="success">{group.up} up</Badge> : null}
                        {group.down > 0 ? <Badge tone="danger">{group.down} down</Badge> : null}
                        {group.unverified > 0 ? <Badge tone="info">{group.unverified} observed</Badge> : null}
                      </span>
                    </button>
                    {shownPorts.map((p) => (
                      <button
                        key={`${group.key}-${p.port}`}
                        type="button"
                        className="nt-rowlink nt-configure-row nt-switch-tree__port"
                        style={ROW}
                        onClick={() => openPort(p)}
                      >
                        <div className="nt-configure-row__name">
                          <span>{p.port}</span>
                          <span>{p.device}</span>
                        </div>
                        <span className="nt-configure-row__secondary">{p.desc}</span>
                        <span className="nt-configure-row__summary">{p.summary}</span>
                        <span className="nt-configure-row__actions">
                          <Badge tone={p.tone} dot>
                            {p.state}
                          </Badge>
                          {p.origin === 'observed' ? <Badge tone="info">Observed</Badge> : null}
                          <span className="nt-configure-row__action">
                            {p.origin === 'observed' ? 'Use ▸' : 'Edit ▸'}
                          </span>
                        </span>
                      </button>
                    ))}
                    {open && group.ports.length > shownPorts.length ? (
                      <button
                        type="button"
                        className="nt-switch-tree__more"
                        onClick={() =>
                          setVisiblePorts((current) => ({
                            ...current,
                            [group.key]: pageSize + 25,
                          }))
                        }
                      >
                        Load 25 more ports
                      </button>
                    ) : null}
                  </div>
                );
              })}
            </div>
            {data.ports.length > 0 && filteredSwitchGroups.length === 0 ? (
              <EmptyState title="No switches match" description="Clear the port filter or search another identity." />
            ) : null}
            {data.ports.length === 0 ? (
              <EmptyState
                title="No switch ports reported"
                description={
                  liveMode
                    ? labConfigMode
                      ? 'No exact configured Central port row is available to apply. Link a writable Central connector and refresh its configuration inventory.'
                      : 'No linked plane reported port configuration. "+ Configure a port" still renders and queues a change.'
                    : 'This payload carries no port rows.'
                }
              />
            ) : null}
          </div>

          <div>
            <SectionHeader
              label="VLANs & roles"
              meta={
                !labConfigMode || !liveMode ? (
                  <button type="button" style={MICRO_LINK} onClick={() => openVlan()}>
                    + Add VLAN
                  </button>
                ) : undefined
              }
            />
            {data.vlans.map((v) => (
              <button
                key={v.id}
                type="button"
                className="nt-rowlink nt-configure-row nt-configure-row--vlan"
                style={ROW}
                onClick={() => openVlan(v)}
              >
                <span className="nt-configure-row__name">{v.id}</span>
                <span className="nt-configure-row__secondary">{v.name}</span>
                <span
                  className="nt-configure-row__summary"
                >
                  {v.detail}
                </span>
                <span className="nt-configure-row__actions">
                  <span className="nt-hint-muted">{v.role}</span>
                  {v.origin === 'observed' ? <Badge tone="info">Observed</Badge> : null}
                  <span className="nt-configure-row__action">
                    {v.origin === 'observed' ? 'Use ▸' : 'Edit ▸'}
                  </span>
                </span>
              </button>
            ))}
            {data.vlans.length === 0 ? (
              <EmptyState
                title="No VLANs reported"
                description={
                  liveMode
                    ? labConfigMode
                      ? 'No exact configured Central VLAN row is available to apply. Link a writable Central connector and refresh its configuration inventory.'
                      : 'No linked plane reported VLAN configuration. "+ Add VLAN" still renders and queues a new one.'
                    : 'This payload carries no VLAN rows.'
                }
              />
            ) : null}
          </div>
        </div>

        {/* ---------------- right: queue + capability matrix ---------------- */}
        <div className="nt-configure__col">
          {!labConfigMode ? (
            <div className="nt-configure__queue">
            <div className="nt-configure__queue-title">Brokered write ritual</div>
            <SectionHeader label="Queued changes" meta={String(queue.length)} />
            {queue.length > 0 ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  const n = exportTableCsv(
                    'configure-queue.csv',
                    ['id', 'state', 'what', 'where', 'ticket', 'expiresAt'],
                    queue.map((q) => [q.id ?? '', q.state, q.what, q.where, q.ticket, q.expiresAt ?? '']),
                  );
                  toast(`Exported ${n} queued change${n === 1 ? '' : 's'}`, {
                    description: 'configure-queue.csv — current broker queue snapshot.',
                  });
                }}
              >
                Export queue CSV
              </Button>
            ) : null}
            {queue.length > 0 ? (
              <DataTable
                ariaLabel="Queued changes"
                columns={queueColumns}
                rows={queue}
                rowKey={queueRowKey}
                selectedKeys={queueSel}
                onSelectionChange={setQueueSel}
              />
            ) : null}
            {queue.length === 0 ? (
              <EmptyState
                title="No changes queued"
                description="Edit an SSID, port or VLAN to render a payload and queue it against a ticket."
              />
            ) : null}
            {/* The bulk bar is contextual — it exists only while rows are
                selected, and it never opens a new path: Approve/Reject run
                the same per-item push/discard the buttons below run, one
                change at a time, with the per-item outcomes named. */}
            {queueSel.length > 0 ? (
              <div className="nt-configure-bulk-bar">
                <span className="nt-configure-bulk-bar__count">{`${queueSel.length} SELECTED`}</span>
                <span className="nt-configure-bulk-bar__hint">
                  each change still goes through its own brokered review — the bar just iterates
                </span>
                <span className="nt-configure-bulk-bar__actions">
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={bulkBusy !== null}
                    onClick={() => void bulkApprove()}
                  >
                    {bulkBusy === 'approve' ? 'Approving…' : 'Approve'}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={bulkBusy !== null}
                    onClick={() => void bulkReject()}
                  >
                    {bulkBusy === 'reject' ? 'Rejecting…' : 'Reject'}
                  </Button>
                  <Button variant="ghost" size="sm" disabled={bulkBusy !== null} onClick={() => setQueueSel([])}>
                    Clear
                  </Button>
                </span>
              </div>
            ) : null}
            <div className="nt-row nt-wrap-6 nt-gap-8" style={{ paddingTop: 12 }}>
              <Button
                variant="secondary"
                size="sm"
                disabled={readyCount === 0 || pushing}
                onClick={() => void pushQueue()}
              >
                Push queue
              </Button>
              <Button variant="ghost" size="sm" disabled={queue.length === 0} onClick={() => void discardAll()}>
                Discard
              </Button>
            </div>
            </div>
          ) : null}

          <div>
            <SectionHeader
              label="Where a change can go"
              meta={dormantTargets.length > 0 ? `${writableTargets.length} REACHABLE` : undefined}
            />
            {writableTargets.map((c) => (
              <div key={c.plane} className="nt-configure-capability">
                <span className="nt-configure-capability__plane">{c.plane}</span>
                <span className="nt-configure-capability__note">{c.note}</span>
                <Badge tone={c.tone}>{c.mode}</Badge>
              </div>
            ))}
            {/* Planes with no credentials all carry the same note. One line
                says it once instead of nine times. */}
            {dormantTargets.length > 0 ? (
              <button
                type="button"
                className="nt-configure-capability nt-configure-capability--more"
                aria-expanded={showDormantTargets}
                onClick={() => setShowDormantTargets((v) => !v)}
              >
                <span className="nt-configure-capability__plane">
                  <span aria-hidden="true">{showDormantTargets ? '−' : '+'}</span>{' '}
                  {`${countOf(dormantTargets.length, 'plane')} not linked`}
                </span>
                <span className="nt-configure-capability__note">no credentials stored</span>
              </button>
            ) : null}
            {showDormantTargets
              ? dormantTargets.map((c) => (
                  <div key={c.plane} className="nt-configure-capability">
                    <span className="nt-configure-capability__plane">{c.plane}</span>
                    <span className="nt-configure-capability__note">{c.note}</span>
                    <Badge tone={c.tone}>{c.mode}</Badge>
                  </div>
                ))
              : null}
          </div>
        </div>
      </div>

      {/* ---------------- edit drawer ---------------- */}
      <Drawer
        open={kind !== null}
        onOpenChange={(v) => {
          if (!v) setKind(null);
        }}
        width="lg"
        title={kind ? CONFIG_EDIT_TITLES[kind] : ''}
        description={
          kind
            ? labConfigMode
              ? LAB_CONFIG_DESCS[kind]
              : liveMode
                ? LIVE_CONFIG_DESCS[kind]
                : CONFIG_EDIT_DESCS[kind]
            : ''
        }
      >
        {kind ? (
          <div className="nt-drawer-stack">
            {kind === 'ssid' ? (
              <div className="nt-drawer-stack">
                {mistDirectAvailable ? (
                  <FormField
                    label="Plane"
                    help={
                      mistSsid
                        ? 'Mist WLANs are site-scoped — the write lands at each selected site.'
                        : 'Central writes a named WLAN profile, then assigns it to the selected scopes.'
                    }
                  >
                    <Select
                      options={[
                        { value: 'CENTRAL', label: 'HPE Aruba Central' },
                        { value: 'MIST', label: 'Mist' },
                      ]}
                      value={mistSsid ? 'MIST' : 'CENTRAL'}
                      onValueChange={(v) => switchSsidPlane(v as 'CENTRAL' | 'MIST')}
                    />
                  </FormField>
                ) : null}
                {!ssidTargetCanWrite ? (
                  <Alert tone="info" title={`${mistSsid ? 'Mist' : 'Central'} SSID writes are unavailable`}>
                    This target's connector grant is read-only. Catalog and inventory reads remain available, but Apply is disabled.
                  </Alert>
                ) : null}
                <div
                  className="nt-form-grid"
                >
                  <FormField label="SSID name">
                    <Input
                      mono
                      placeholder="Enter SSID name"
                      value={ssid.name}
                      onChange={(e) => setSsid({ ...ssid, name: e.target.value })}
                    />
                  </FormField>
                  <FormField label="VLAN">
                    <Input
                      mono
                      placeholder="1-4094"
                      value={ssid.vlan}
                      onChange={(e) => setSsid({ ...ssid, vlan: e.target.value })}
                    />
                  </FormField>
                </div>
                <div
                  className="nt-form-grid"
                >
                  <FormField
                    label="Security"
                    help={
                      mistSsid
                        ? 'Mist direct writes support WPA2-PSK and Open — enterprise and captive-portal WLANs need org RADIUS/portal configuration the form cannot express.'
                        : 'Direct apply loads the live role/AAA/captive-portal dependencies this mode needs below.'
                    }
                  >
                    <Select
                      options={SSID_SECURITY_OPTIONS}
                      value={ssid.security}
                      onValueChange={(v) => setSsid(ssidFormForSecurity(ssid, v as SsidSecurity))}
                    />
                  </FormField>
                  <FormField label="Bands">
                    <Select
                      options={SSID_BAND_OPTIONS}
                      value={ssid.bands}
                      onValueChange={(v) => setSsid({ ...ssid, bands: v as SsidBands })}
                    />
                  </FormField>
                </div>
                {mistRefusal ? (
                  <Alert tone="warning" title="Apply is disabled — Mist cannot express this security mode">
                    <span className="nt-body-sm">The write was refused before it was built: {mistRefusal}.</span>
                  </Alert>
                ) : null}

                {/* -- live security dependencies (role / auth server / captive portal / passphrase) --
                    Mist has no role/server-group/portal catalogs: those selects are Central-only,
                    and the section itself disappears when the Mist mode needs nothing (Open). */}
                {!mistSsid || ssidRequirement.passphrase ? (
                <div className="nt-stack nt-gap-12">
                  <SectionHeader label="Security dependencies" meta={ssidCatalogLoading ? 'loading…' : undefined} />
                  {/* FormField only clones an id onto a SINGLE child element for the
                      label's htmlFor — the "unavailable" note is a sibling below it,
                      never a second child, or the select loses its accessible name. */}
                  {!mistSsid ? (
                  <FormField label="Default role">
                    <Select
                      options={withPlaceholder(
                        (ssidCatalog?.roles ?? []).map((o) => ({ value: o.id, label: o.label })),
                        'Select a role…',
                      )}
                      value={ssid.defaultRole ?? ''}
                      onValueChange={(v) => setSsid({ ...ssid, defaultRole: v || undefined })}
                      disabled={ssidCatalogLoading || (ssidCatalog?.roles.length ?? 0) === 0}
                    />
                  </FormField>
                  ) : null}
                  {!mistSsid && ssidCatalog?.unavailable.includes('roles') ? (
                    <span className="nt-warn-sm">
                      {ssidSectionUnavailableNote('roles')}
                    </span>
                  ) : null}
                  {!mistSsid && ssidRequirement.authServerGroup ? (
                    <>
                      <FormField label="Authentication server group">
                        <Select
                          options={withPlaceholder(
                            (ssidCatalog?.authServerGroups ?? []).map((o) => ({ value: o.id, label: o.label })),
                            'Select an authentication server group…',
                          )}
                          value={ssid.authServerGroupId ?? ''}
                          onValueChange={(v) => setSsid({ ...ssid, authServerGroupId: v || undefined })}
                          disabled={ssidCatalogLoading || (ssidCatalog?.authServerGroups.length ?? 0) === 0}
                        />
                      </FormField>
                      {ssidCatalog?.unavailable.includes('authServerGroups') ? (
                        <span className="nt-warn-sm">
                          {ssidSectionUnavailableNote('authServerGroups')}
                        </span>
                      ) : null}
                    </>
                  ) : null}
                  {!mistSsid && ssidRequirement.captivePortal ? (
                    <>
                      <FormField label="Captive-portal profile">
                        <Select
                          options={withPlaceholder(
                            (ssidCatalog?.captivePortalProfiles ?? []).map((o) => ({ value: o.id, label: o.label })),
                            'Select a captive-portal profile…',
                          )}
                          value={ssid.captivePortalProfileId ?? ''}
                          onValueChange={(v) => setSsid({ ...ssid, captivePortalProfileId: v || undefined })}
                          disabled={ssidCatalogLoading || (ssidCatalog?.captivePortalProfiles.length ?? 0) === 0}
                        />
                      </FormField>
                      {ssidCatalog?.unavailable.includes('captivePortalProfiles') ? (
                        <span className="nt-warn-sm">
                          {ssidSectionUnavailableNote('captivePortalProfiles')}
                        </span>
                      ) : null}
                    </>
                  ) : null}
                  {ssidRequirement.passphrase ? (
                    <FormField label="Passphrase" help="Never displayed again after Apply — write-only.">
                      <Input
                        type="password"
                        mono
                        placeholder="Enter the PSK passphrase"
                        value={ssid.passphrase ?? ''}
                        onChange={(e) => setSsid({ ...ssid, passphrase: e.target.value })}
                      />
                    </FormField>
                  ) : null}
                </div>
                ) : null}

                {/* -- scope targets (immutable plane ids, grouped by category) -- */}
                <div className="nt-stack nt-gap-8">
                  <SectionHeader label="Scope" meta={`${ssid.scopeIds?.length ?? 0} selected`} />
                  {ssidCatalogLoading ? (
                    <div className="nt-center-pad">
                      <Spinner size="sm" />
                    </div>
                  ) : ssidCatalogError ? (
                    <Alert tone="danger" title="The scope catalog could not be read">
                      <span className="nt-body-sm">{ssidCatalogError}</span>
                    </Alert>
                  ) : ssidScopeGroups.length === 0 ? (
                    <EmptyState
                      title="No scope choices reported"
                      description="This plane did not report any sites, site collections, AP device groups, or APs to target."
                    />
                  ) : (
                    ssidScopeGroups.map((group) => (
                      <div key={group.category} className="nt-stack nt-gap-4">
                        <span
                          className="nt-mono-label"
                        >
                          {SSID_SCOPE_CATEGORY_LABEL[group.category]}
                        </span>
                        {group.options.map((option) => {
                          const checked = (ssid.scopeIds ?? []).includes(option.id);
                          return (
                            <Checkbox
                              key={option.id}
                              label={option.label}
                              checked={checked}
                              onChange={(e) => {
                                const current = ssid.scopeIds ?? [];
                                setSsid({
                                  ...ssid,
                                  scopeIds: e.target.checked
                                    ? [...current, option.id]
                                    : current.filter((id) => id !== option.id),
                                });
                              }}
                            />
                          );
                        })}
                      </div>
                    ))
                  )}
                </div>

                <div
                  className="nt-stack nt-configure-ritual-bar"
                >
                  {/* Mist WLANs carry `enabled`; Central's profile upsert always
                      writes enable:true, so the switch is Mist-only — offering it
                      for Central would be a control that silently does nothing. */}
                  {mistSsid ? (
                    <Switch
                      label="WLAN enabled"
                      checked={ssid.enabled ?? true}
                      onCheckedChange={(v) => setSsid({ ...ssid, enabled: v })}
                    />
                  ) : null}
                  <Switch
                    label="Broadcast the SSID"
                    checked={ssid.broadcast}
                    onCheckedChange={(v) => setSsid({ ...ssid, broadcast: v })}
                  />
                  <Switch
                    label="Client isolation"
                    checked={ssid.isolate}
                    onCheckedChange={(v) => setSsid({ ...ssid, isolate: v })}
                  />
                  {!liveMode ? (
                    <Switch
                      label="Exclude DFS channels (clinical floors)"
                      checked={ssid.noDfs}
                      onCheckedChange={(v) => setSsid({ ...ssid, noDfs: v })}
                    />
                  ) : null}
                </div>
              </div>
            ) : null}

            {kind === 'port' ? (
              <div className="nt-drawer-stack">
                <div
                  className="nt-form-grid"
                >
                  <FormField label="Switch">
                    {liveMode ? (
                      <Input
                        mono
                        placeholder="Enter live device name"
                        value={port.device}
                        onChange={(e) => setPort({
                          ...port,
                          device: e.target.value,
                          plane: undefined,
                          serial: undefined,
                        })}
                      />
                    ) : (
                      <Select
                        options={PORT_DEVICE_OPTIONS}
                        value={port.device}
                        onValueChange={(v) => setPort({
                          ...port,
                          device: v,
                          plane: undefined,
                          serial: undefined,
                        })}
                      />
                    )}
                  </FormField>
                  <FormField label="Interface">
                    <Input
                      mono
                      value={port.id}
                      onChange={(e) => setPort({ ...port, id: e.target.value })}
                    />
                  </FormField>
                </div>
                <FormField label="Description">
                  <Input
                    value={port.desc}
                    onChange={(e) => setPort({ ...port, desc: e.target.value })}
                  />
                </FormField>
                <div
                  className="nt-form-grid"
                >
                  <FormField label="Mode">
                    <Select
                      options={PORT_MODE_OPTIONS}
                      value={port.mode}
                      onValueChange={(v) => setPort({ ...port, mode: v as PortForm['mode'] })}
                    />
                  </FormField>
                  <FormField label="VLAN">
                    <Input
                      mono
                      value={port.vlan}
                      onChange={(e) => setPort({ ...port, vlan: e.target.value })}
                    />
                  </FormField>
                </div>
                <div
                  className="nt-stack nt-configure-ritual-bar"
                >
                  <Switch
                    label="Power over Ethernet"
                    checked={port.poe}
                    onCheckedChange={(v) => setPort({ ...port, poe: v })}
                  />
                  <Switch
                    label="802.1X port access (ClearPass)"
                    checked={port.dot1x}
                    onCheckedChange={(v) => setPort({ ...port, dot1x: v })}
                  />
                  <Switch
                    label="MAC authentication fallback"
                    checked={port.mab}
                    onCheckedChange={(v) => setPort({ ...port, mab: v })}
                  />
                  <Switch
                    label="Administratively up"
                    checked={port.up}
                    onCheckedChange={(v) => setPort({ ...port, up: v })}
                  />
                </div>
              </div>
            ) : null}

            {kind === 'vlan' ? (
              <div className="nt-drawer-stack">
                <div
                  className="nt-form-grid" style={{ gridTemplateColumns: "80px minmax(0, 1fr)", gap: 14 }}
                >
                  <FormField label="ID">
                    <Input
                      mono
                      value={vlan.id}
                      onChange={(e) => setVlan({ ...vlan, id: e.target.value })}
                    />
                  </FormField>
                  <FormField label="Name">
                    <Input
                      mono
                      value={vlan.name}
                      onChange={(e) => setVlan({ ...vlan, name: e.target.value })}
                    />
                  </FormField>
                </div>
                <FormField
                  label="DHCP helpers"
                  help={
                    liveMode
                      ? labConfigMode
                        ? 'Comma-separated helper addresses. The portal assumes no existing baseline; apply evidence reports the observed outcome.'
                        : 'Comma-separated helper addresses. The portal holds no baseline for this VLAN — the dry run reports what the plane currently has.'
                      : 'The CX baseline expects two helpers; the second one is the drift finding open on this VLAN.'
                  }
                >
                  <Input
                    mono
                    value={vlan.helpers}
                    onChange={(e) => setVlan({ ...vlan, helpers: e.target.value })}
                  />
                </FormField>
                <FormField label="Apply to">
                  <Select
                    options={liveMode ? LIVE_VLAN_SCOPE_OPTIONS : VLAN_SCOPE_OPTIONS}
                    value={vlan.scope}
                    onValueChange={(v) => setVlan({ ...vlan, scope: v as VlanScope })}
                  />
                </FormField>
              </div>
            ) : null}

            <div className="nt-stack nt-gap-10">
              <SectionHeader label={labConfigMode ? 'What will be applied' : 'What gets pushed'} meta={previewMeta} />
              <Code block>{preview}</Code>
            </div>

            <div className="nt-stack nt-gap-2">
              <SectionHeader label={liveMode ? 'Impact evidence' : 'Blast radius'} />
              {radius.map((r) => (
                <div
                  key={r.what}
                  className="nt-configure-drawer-row"
                >
                  <span className="nt-body-sec nt-flex-1">
                    {r.what}
                  </span>
                  <span
                    className="nt-hint-muted"
                  >
                    {r.count}
                  </span>
                </div>
              ))}
            </div>

            {kind === 'ssid' ? (
              <div className="nt-stack nt-gap-10">
                <SectionHeader label={labConfigMode ? 'Exact scope assignments' : 'Review — exact scope assignments'} />
                {(ssid.scopeIds ?? []).length === 0 ? (
                  <span className="nt-body-sm nt-hint-muted">
                    No scope selected yet — pick at least one above before applying.
                  </span>
                ) : (
                  (ssid.scopeIds ?? []).map((scopeId) => {
                    const option = ssidCatalog?.scopes.find((s) => s.id === scopeId);
                    return (
                      <div
                        key={scopeId}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 10,
                          padding: '6px 0',
                          borderBottom: '1px solid var(--nd-border-subtle)',
                        }}
                      >
                        <span className="nt-body-sec nt-flex-1">
                          {option?.label ?? scopeId}
                        </span>
                        <Badge tone="neutral">{option ? SSID_SCOPE_CATEGORY_LABEL[option.category] : 'unknown'}</Badge>
                      </div>
                    );
                  })
                )}
                <span className="nt-hint-muted">
                  {mistSsid
                    ? 'site-scoped WLAN write · POST/PUT /api/v1/sites/{site}/wlans — no secret value is ever shown here.'
                    : 'device-function CAMPUS_AP · assigned via /network-config/v1alpha1/config-assignments — no secret value is ever shown here.'}
                </span>

                {!labConfigMode ? (
                  <Checkbox
                    label="I have reviewed this profile and these scope assignments — apply directly, no ticket."
                    checked={ssidReviewed}
                    onChange={(e) => setSsidReviewed(e.target.checked)}
                  />
                ) : null}
                {valueProblems.length > 0 ? (
                  <Alert tone="warning" title={`Apply is disabled — ${mistSsid ? 'Mist' : 'Central'} would refuse this form`}>
                    <div className="nt-stack" style={{ gap: 4, fontSize: 13 }}>
                      {valueProblems.map((problem) => (
                        <span key={problem}>{problem}</span>
                      ))}
                    </div>
                  </Alert>
                ) : null}
                {ssidMissingDependencies.length > 0 ? (
                  <Alert tone="warning" title="Apply is disabled — a required live dependency is unavailable">
                    <span className="nt-body-sm">
                      This plane did not report: {ssidMissingDependencies.join(', ')}.
                    </span>
                  </Alert>
                ) : null}
                <div className="nt-filter-bar nt-gap-8">
                  <Button variant="primary" size="md" disabled={ssidApplyDisabled} onClick={() => void applySsid()}>
                    {ssidApplying ? 'Applying…' : labConfigMode ? 'Apply' : 'Apply directly'}
                  </Button>
                  <Button variant="ghost" size="md" onClick={() => setKind(null)}>
                    Cancel
                  </Button>
                </div>
                {ssidApplyResult ? (
                  ssidApplyResult.error ? (
                    <Alert tone="danger" title="Apply failed">
                      <span className="nt-body-sm">{ssidApplyResult.error}</span>
                    </Alert>
                  ) : ssidApplyResult.result ? (
                    <Alert
                      // Green is a claim. An apply whose assignments were
                      // written and never read back has nothing behind that
                      // claim except an answered POST, so it does not get one.
                      tone={
                        ssidApplyResult.result.ok
                          ? unconfirmedCount(ssidApplyResult.result.assignments) > 0
                            ? 'warning'
                            : 'success'
                          : ssidApplyResult.result.partial ||
                              profileWrittenButUnconfirmed(ssidApplyResult.result.profile)
                            ? 'warning'
                            : 'danger'
                      }
                      title={
                        ssidApplyResult.result.ok
                          ? assignmentAppliedTitle(ssidApplyResult.result.assignments)
                          : ssidApplyResult.result.partial
                            ? assignmentPartialTitle(ssidApplyResult.result.assignments)
                            : profileWrittenButUnconfirmed(ssidApplyResult.result.profile)
                              ? `Profile ${ssidApplyResult.result.profile.action}, not confirmed`
                              : 'Not applied'
                      }
                    >
                      <div className="nt-stack nt-gap-8">
                        <span className="nt-body-sm">
                          Profile ({ssidApplyResult.result.profile.action}): {ssidApplyResult.result.profile.message}
                        </span>
                        {ssidApplyResult.result.assignments.map((a) => (
                          <span
                            key={a.scopeId}
                            style={{
                              fontSize: 12.5,
                              color:
                                a.verified === false || isUnconfirmed(a)
                                  ? 'var(--nd-warning)'
                                  : 'var(--nd-text-secondary)',
                            }}
                          >
                            {assignmentMark(a)} {a.label} — {a.message}
                          </span>
                        ))}
                      </div>
                    </Alert>
                  ) : null
                ) : null}
                <span
                  className="nt-hint-muted nt-lh-16"
                >
                  {labConfigMode
                    ? 'Scope-aware direct apply. An audit event is recorded for every attempt.'
                    : 'Direct apply — no ticket, no queue. An audit event is still recorded for every attempt.'}
                </span>
              </div>
            ) : labConfigMode ? (
              <div className="nt-stack nt-gap-8">
                {!genericTargetCanWrite ? (
                  <Alert tone="info" title="Central configuration writes are unavailable">
                    {centralCapability
                      ? 'The linked Central connector does not currently admit this configuration write. Its configured grant or product capability is read-only.'
                      : 'No linked Central connector currently admits configuration writes. Apply remains disabled while the preview stays available.'}
                  </Alert>
                ) : null}
                {!genericHasConfiguredProvenance ? (
                  <Alert tone="info" title="Exact configured target required">
                    Immediate apply requires a configured Central inventory row; observed or newly entered rows are not a safe write baseline.
                  </Alert>
                ) : null}
                {genericHasConfiguredProvenance && !genericHasExactIdentity ? (
                  <Alert tone="info" title="Exact Central identity required">
                    {kind === 'vlan'
                      ? "This form must retain the configured row's exact Central ownership identity, including its immutable VLAN id and scope."
                      : "This row does not carry the complete Central device and serial identity required for an immediate port write."}
                  </Alert>
                ) : null}
                {valueProblems.length > 0 ? (
                  <Alert tone="warning" title="Apply is disabled — Central would refuse this form">
                    <div className="nt-stack" style={{ gap: 4, fontSize: 13 }}>
                      {valueProblems.map((problem) => (
                        <span key={problem}>{problem}</span>
                      ))}
                    </div>
                  </Alert>
                ) : null}
                <div className="nt-filter-bar nt-gap-8">
                  <Button
                    variant="primary"
                    size="md"
                    disabled={directApplying || directReplayBlocked || !directFormComplete || valueProblems.length > 0}
                    onClick={() => void applyDirect()}
                  >
                    {directApplying ? 'Applying…' : 'Apply'}
                  </Button>
                  <Button variant="ghost" size="md" onClick={() => setKind(null)}>
                    Cancel
                  </Button>
                </div>
                {directApply ? (
                  directApply.error ? (
                    <Alert tone="danger" title="Apply failed">
                      <span className="nt-body-sm">{directApply.error}</span>
                    </Alert>
                  ) : directApply.result ? (
                    <Alert
                      tone={
                        directApply.result.outcomeUnknown
                          ? 'warning'
                          : directApply.result.applied
                          ? directApply.result.cacheRefresh?.attempted && !directApply.result.cacheRefresh.ok
                            ? 'warning'
                            : 'success'
                          : directApply.result.accepted
                            ? 'warning'
                            : 'danger'
                      }
                      title={
                        directApply.result.outcomeUnknown
                          ? 'Outcome unknown'
                          : directApply.result.applied
                          ? 'Applied'
                          : directApply.result.accepted
                            ? 'Accepted — not yet confirmed'
                            : 'Not applied'
                      }
                    >
                      <div className="nt-stack-col nt-gap-6" style={{ fontSize: 13 }}>
                        <span>{directApply.result.message}</span>
                        {directApply.result.cacheRefresh?.attempted && !directApply.result.cacheRefresh.ok ? (
                          <span>
                            The inventory could not be re-read ({directApply.result.cacheRefresh.message ?? 'reason not reported'}),
                            so the list below does not show this change yet.
                          </span>
                        ) : null}
                      </div>
                    </Alert>
                  ) : null
                ) : null}
                <span
                  className="nt-hint-muted nt-lh-16"
                >
                  Immediate lab apply. Every attempt remains audited, and the result below is the write evidence.
                </span>
              </div>
            ) : (
              <div className="nt-stack nt-gap-8">
                <FormField label="Ticket reference (required for the write lease)">
                  <Input
                    mono
                    value={ticket}
                    placeholder="NET-4166"
                    onChange={(e) => setTicket(e.target.value)}
                  />
                </FormField>
                {queued ? (
                  <Alert tone="success" title="Queued for push">
                    <span className="nt-body-sm">{queuedChangeNote(ticket)}</span>
                  </Alert>
                ) : null}
                {valueProblems.length > 0 ? (
                  <Alert tone="warning" title="Queueing is disabled — the broker would refuse this form">
                    <div className="nt-stack" style={{ gap: 4, fontSize: 13 }}>
                      {valueProblems.map((problem) => (
                        <span key={problem}>{problem}</span>
                      ))}
                    </div>
                  </Alert>
                ) : null}
                <div className="nt-filter-bar nt-gap-8">
                  <Button
                    variant="primary"
                    size="md"
                    disabled={!ticket.trim() || !genericFormComplete || valueProblems.length > 0}
                    onClick={() => void queueIt()}
                  >
                    Queue the change
                  </Button>
                  <Button
                    variant="secondary"
                    size="md"
                    disabled={dryRunning || !genericFormComplete || valueProblems.length > 0}
                    onClick={() => void doDryRun()}
                  >
                    Dry run
                  </Button>
                  <Button variant="ghost" size="md" onClick={() => setKind(null)}>
                    Cancel
                  </Button>
                </div>
                {dryRun ? (
                  dryRun.error ? (
                    <Alert tone="danger" title="Dry run rejected">
                      <span className="nt-body-sm">{dryRun.error}</span>
                    </Alert>
                  ) : dryRun.result ? (
                    <Alert
                      tone={dryRun.result.ok ? (dryRun.result.snapshot ? 'success' : 'info') : 'warning'}
                      title="Dry run"
                    >
                      <div className="nt-stack nt-gap-10">
                        <span className="nt-body-sm">{dryRun.result.note}</span>
                        <Code block>{dryRun.result.rendered}</Code>
                        <span
                          className="nt-hint-muted"
                        >
                          {dryRun.result.snapshot
                            ? `rollback snapshot stored — kept 24h${dryRun.result.httpCode ? ` · read-back HTTP ${dryRun.result.httpCode}` : ''}`
                            : dryRun.result.httpCode
                              ? `no snapshot stored · read-back HTTP ${dryRun.result.httpCode}`
                              : 'no snapshot stored — no read-back attempted'}
                        </span>
                      </div>
                    </Alert>
                  ) : null
                ) : null}
                <span
                  className="nt-hint-muted nt-lh-16"
                >
                  {liveMode ? LIVE_PUSH_NOTES[kind] : CONFIG_PUSH_NOTES[kind]}
                </span>
              </div>
            )}
          </div>
        ) : null}
      </Drawer>


      {/* ---------------- change history (broker audit log) ----------------
          GET /api/configure/history, newest first. SECURITY: the row is
          {ts,event,changeId,ticket,kind,result} — what happened to a change,
          never what was in it. Rendered payload bodies are not on the wire
          (shared/types.ts BrokerAuditEvent) and must not be rendered here. */}
      <Drawer
        open={historyOpen}
        onOpenChange={(v) => {
          if (!v) setHistoryOpen(false);
        }}
        width="lg"
        title="Change history"
        description={
          labConfigMode
            ? 'The configuration audit log: every direct apply attempt and its confirmation outcome. Payload bodies are deliberately not recorded.'
            : "The write broker's audit log: what happened to every brokered change, with the ticket it was raised against. Payload bodies are deliberately not recorded."
        }
      >
        <div className="nt-stack nt-gap-2">
          <div className="nt-filter-bar nt-gap-8">
            <div className="nt-flex-1-wide" style={{ minWidth: 160 }}>
              <SectionHeader
                label={labConfigMode ? 'Direct applies' : 'Brokered changes'}
                // A bare count reads as "this is how many there are". When a
                // generation could not be read it is only how many we could see.
                meta={
                  history.kind === 'ok'
                    ? history.unreadable.length > 0
                      ? `${history.events.length} readable`
                      : String(history.events.length)
                    : undefined
                }
              />
            </div>
            <Button
              variant="ghost"
              size="sm"
              disabled={history.kind !== 'ok' || history.events.length === 0}
              onClick={() => {
                window.open('/api/configure/history/export?limit=200', '_blank', 'noopener,noreferrer');
              }}
            >
              Download CSV
            </Button>
          </div>
          {history.kind === 'loading' ? (
            <div className="nt-center-pad nt-center-pad" style={{ padding: 32 }}>
              <Spinner size="sm" />
            </div>
          ) : null}
          {history.kind === 'error' ? (
            <Alert tone="danger" title="The audit log could not be read">
              <span className="nt-body-sm">{history.message}</span>
            </Alert>
          ) : null}
          {history.kind === 'offline' ? (
            <EmptyState
              title="The portal backend did not answer"
              description={
                labConfigMode
                  ? 'The configuration audit log lives on the server; there is no local copy to show. Reconnect the backend and open this again.'
                  : "The audit log lives on the server with the write broker; there is no local copy to show. Reconnect the backend and open this again."
              }
            />
          ) : null}
          {/* The log came back short because part of it could not be read.
              Without this the drawer would show a plausible, continuous list
              and the operator would have no way to know a stretch of the audit
              trail is missing — the absence would read as "nothing happened". */}
          {history.kind === 'ok' && history.unreadable.length > 0 ? (
            <Alert tone="warning" title="Part of the audit log could not be read">
              <span className="nt-body-sm">
                {history.unreadable.length === 1
                  ? `The rotated log ${history.unreadable[0]} exists on the server but could not be opened.`
                  : `${history.unreadable.length} rotated logs (${history.unreadable.join(', ')}) exist on the server but could not be opened.`}{' '}
                What is listed below is real, but it is not the whole record — check file permissions
                and disk health in the portal's data directory before treating this list as complete.
              </span>
            </Alert>
          ) : null}
          {history.kind === 'ok'
            ? history.events.map((e, i) => (
                <div
                  key={`${e.ts}-${e.changeId}-${e.event}-${i}`}
                  className="nt-configure-drawer-row nt-configure-drawer-row--lg"
                >
                  <span
                    className="nt-hint-muted nt-w-44"
                  >
                    {hhmm(e.ts)}
                  </span>
                  <div className="nt-stack-col--flex nt-gap-3">
                    <span className="nt-text-pri-12" style={{ fontSize: 12.5 }}>
                      {e.event} {e.kind}
                    </span>
                    <span
                      className="nt-hint-muted"
                    >
                      {e.changeId}
                    </span>
                  </div>
                  <span
                    className="nt-hint-muted"
                  >
                    {e.ticket}
                  </span>
                  <Badge tone={auditTone(e.result)}>{e.result}</Badge>
                </div>
              ))
            : null}
          {history.kind === 'ok' && history.events.length === 0 ? (
            <EmptyState
              title={labConfigMode ? 'No direct applies recorded yet' : 'No brokered changes recorded yet'}
              description={
                labConfigMode
                  ? 'Every immediate configuration attempt and confirmation outcome is written to this audit log. Nothing has been applied on this install.'
                  : "Every dry run, queue, push and discard is written to the broker's audit log. Nothing has gone through it on this install."
              }
            />
          ) : null}
        </div>
      </Drawer>
    </div>
  );
}
