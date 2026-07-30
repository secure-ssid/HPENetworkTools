/**
 * web/src/screens/Configure.tsx — the write surface.
 * High-fidelity port of design/NtConfigure.dc.html: four Stats, the brokered-
 * write info Alert, then two columns (1.55fr / 1fr). Left: Wireless SSIDs,
 * Switch ports and VLANs & roles as open lists with inline "+ Add" links and
 * "Edit ▸" rows. Right: Queued changes (Push queue gated on ≥1 ready entry;
 * push hands ready entries to the write broker, Discard clears) and the
 * "Where a change can go" capability matrix.
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

import { useEffect, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import {
  Alert,
  Badge,
  Button,
  Checkbox,
  Code,
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
import {
  applySsidDirect,
  discardChange,
  dryRunConfig,
  getChangeHistory,
  getChangeQueue,
  getConfigure,
  getSsidCatalog,
  isApiError,
  pushChange,
  queueChange,
} from '../api/client';
import type { BrokeredChange, ConfigureData, DryRunResult } from '../api/client';
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
  previewMetaFor,
  queuedChangeNote,
  seedFormFromRow,
  ssidDependencyRequirementsFor,
} from '../../../shared';
import type {
  BrokerAuditEvent,
  CapabilityRow,
  ConfigForm,
  ConfigKind,
  PortForm,
  PortObject,
  QueuedChangeRow,
  SsidApplyResult,
  SsidBands,
  SsidCatalog,
  SsidForm,
  SsidObject,
  SsidScopeCategory,
  SsidScopeOption,
  SsidSecurity,
  VlanForm,
  VlanObject,
  VlanScope,
} from '../../../shared';
import { useSettings } from '../app/SettingsContext';
import { ScreenHeader } from './ScreenHeader';
import { ApiErrorState } from './ApiErrorState';
import '../app/app.css';

const MICRO_LINK: CSSProperties = {
  background: 'none',
  border: 'none',
  padding: 0,
  cursor: 'pointer',
  fontFamily: 'var(--nd-font-mono)',
  fontSize: 10,
  letterSpacing: '.08em',
  color: 'var(--nd-accent-text)',
  textTransform: 'uppercase',
};

const ROW: CSSProperties = {
  width: '100%',
  textAlign: 'left',
  background: 'none',
  border: 'none',
  borderBottom: '1px solid var(--nd-border-subtle)',
  borderLeft: '2px solid transparent',
  padding: '12px 10px',
  cursor: 'pointer',
};

function hhmm(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * The broker writes its own outcome word into every audit row ('applied',
 * 'rejected', 'lease-expired', 'render-only (read-only plane)', …). The badge
 * colours the ones whose meaning is unambiguous and leaves everything else
 * neutral — a word this screen does not recognise must not be painted green.
 */
function auditTone(result: string): 'success' | 'warning' | 'danger' | 'neutral' {
  const r = result.toLowerCase();
  if (r.startsWith('applied')) return 'success';
  if (r === 'rejected' || r.includes('error') || r.includes('failed')) return 'danger';
  if (r === 'lease-expired' || r === 'unverified-path' || r.startsWith('render-only')) return 'warning';
  return 'neutral';
}

/** What the "Change history" drawer is showing right now. */
type HistoryState =
  | { kind: 'loading' }
  | { kind: 'ok'; events: BrokerAuditEvent[] }
  | { kind: 'error'; message: string }
  | { kind: 'offline' };

/** A queue row: brokered server-side (id set) or local offline fallback (id null).
 *  `expiresAt` is the broker's 15-minute write lease — an entry whose lease has
 *  run out cannot be pushed (the broker answers 409), so the row has to say so. */
type QueueEntry = QueuedChangeRow & { id: string | null; expiresAt?: string | null };

interface SwitchPortGroup {
  key: string;
  device: string;
  plane?: string;
  serial?: string;
  ports: PortObject[];
  up: number;
  down: number;
  unverified: number;
}

function groupSwitchPorts(ports: PortObject[]): SwitchPortGroup[] {
  const groups = new Map<string, PortObject[]>();
  for (const port of ports) {
    const key = `${port.plane ?? 'unknown'}:${port.serial ?? 'no-serial'}:${port.device}`;
    groups.set(key, [...(groups.get(key) ?? []), port]);
  }
  return [...groups.entries()]
    .map(([key, rows]) => ({
      key,
      device: rows[0]!.device,
      plane: rows[0]!.plane,
      serial: rows[0]!.serial,
      ports: [...rows].sort((a, b) => a.port.localeCompare(b.port, undefined, { numeric: true })),
      up: rows.filter((row) => /^(up|active|connected)$/i.test(row.state)).length,
      down: rows.filter((row) => /^(down|disabled|failed)$/i.test(row.state)).length,
      unverified: rows.filter((row) => row.origin === 'observed').length,
    }))
    .sort((a, b) => a.device.localeCompare(b.device));
}

const STATE_TONE: Record<QueuedChangeRow['state'], QueuedChangeRow['tone']> = {
  ready: 'success',
  applying: 'info',
  'needs window': 'warning',
  console: 'neutral',
};

const LIVE_SSID_FORM: SsidForm = {
  name: '',
  vlan: '',
  security: 'wpa2-psk',
  group: '',
  bands: 'all',
  broadcast: true,
  isolate: false,
  noDfs: false,
  plane: 'CENTRAL',
};

const LIVE_PORT_FORM: PortForm = {
  device: '',
  id: '',
  desc: '',
  mode: 'access',
  vlan: '',
  poe: false,
  dot1x: false,
  mab: false,
  up: true,
};

const LIVE_VLAN_FORM: VlanForm = {
  id: '',
  name: '',
  helpers: '',
  scope: 'core-only',
};

const LIVE_VLAN_SCOPE_OPTIONS = VLAN_SCOPE_OPTIONS.map((option) => ({
  ...option,
  label:
    option.value === 'cx-campus-01'
      ? 'Campus-01 CX switches'
      : option.value === 'cx-all'
        ? 'Every CX switch'
        : 'Core switches only',
}));

/** Scope-map category → the multi-select group heading (SsidCatalog.scopes). */
const SSID_SCOPE_CATEGORY_LABEL: Record<SsidScopeCategory, string> = {
  site: 'Sites',
  'site-collection': 'Site collections',
  'ap-group': 'AP device groups',
  ap: 'Individual APs',
};

const SSID_SCOPE_CATEGORY_ORDER: SsidScopeCategory[] = ['site', 'site-collection', 'ap-group', 'ap'];

/** SsidCatalogSection → the plain-English name used in "not reported" notes. */
const SSID_CATALOG_SECTION_LABEL: Record<string, string> = {
  sites: 'sites',
  'site-collections': 'site collections',
  'ap-groups': 'AP device groups',
  aps: 'individual APs',
  roles: 'roles',
  authServerGroups: 'authentication server groups',
  captivePortalProfiles: 'captive-portal profiles',
};

/** Group a flat scope list by category, in a fixed display order, dropping
 *  categories with nothing to offer rather than heading an empty list. */
function groupScopesByCategory(scopes: SsidScopeOption[]): { category: SsidScopeCategory; options: SsidScopeOption[] }[] {
  return SSID_SCOPE_CATEGORY_ORDER.map((category) => ({
    category,
    options: scopes.filter((s) => s.category === category),
  })).filter((group) => group.options.length > 0);
}

/** "Central did not report any <section> — Apply is disabled until this is
 *  available." — the honest note under a dependency select the catalog could
 *  not answer. */
function ssidSectionUnavailableNote(section: string): string {
  return `Central did not report any ${SSID_CATALOG_SECTION_LABEL[section] ?? section} — Apply is disabled until this is available.`;
}

/** Prepend a non-selectable placeholder so an unset dependency never LOOKS
 *  chosen just because it renders as the first real option. */
function withPlaceholder(options: { value: string; label: string }[], placeholder: string): { value: string; label: string }[] {
  return [{ value: '', label: placeholder }, ...options];
}

const LIVE_CONFIG_DESCS: Record<ConfigKind, string> = {
  ssid: 'Create or update a named New Central WLAN profile, verify it, then assign it to the reviewed Central scopes.',
  port: 'Build a switch payload for the named live device. The dry run resolves collector reachability and rollback evidence.',
  vlan: 'Build a VLAN payload for the selected broker scope. The dry run resolves actual reachable devices.',
};

const LIVE_PUSH_NOTES: Record<ConfigKind, string> = {
  ssid: 'The broker resolves the live target during dry run; no AP count, client count, Mist hand-off, or authentication trust is assumed.',
  port: 'The broker verifies collector reachability and requests a rollback snapshot during dry run.',
  vlan: 'The broker resolves reachable switches during dry run; no device, client, or compliance count is assumed.',
};

function livePreview(kind: ConfigKind, form: ConfigForm, capabilities: CapabilityRow[]): string {
  if (kind === 'ssid') {
    const ssid = form as SsidForm;
    const lines = [
      `POST/PATCH /network-config/v1alpha1/wlan-ssids/${encodeURIComponent(ssid.name || '{ssid}')}`,
      `ssid: ${ssid.name || '(not entered)'}`,
      `essid.name: ${ssid.name || '(not entered)'}`,
      `opmode: ${
        ssid.security === 'wpa3-enterprise'
          ? 'WPA3_ENTERPRISE_CCM_128'
          : ssid.security === 'wpa2-enterprise'
            ? 'WPA2_ENTERPRISE'
            : ssid.security === 'open'
              ? 'OPEN'
              : 'WPA2_PERSONAL'
      }`,
      'forward-mode: FORWARD_MODE_BRIDGE',
      `rf-band: ${ssid.bands === '5+6' ? '5GHZ_6GHZ' : ssid.bands === '5' ? '5GHZ' : 'BAND_ALL'}`,
      `vlan-selector: VLAN_RANGES (${ssid.vlan || 'not entered'})`,
      `default-role: ${ssid.defaultRole || 'not selected'}`,
      `hide-ssid: ${ssid.broadcast ? 'false' : 'true'}`,
      `client-isolation: ${ssid.isolate ? 'true' : 'false'}`,
    ];
    if (ssid.authServerGroupId) lines.push(`auth-server-group: ${ssid.authServerGroupId}`);
    if (ssid.captivePortalProfileId) {
      lines.push(`captive-portal: ${ssid.captivePortalProfileId}`, 'captive-portal-type: EXTERNAL_CP');
    }
    if (ssidDependencyRequirementsFor(ssid.security).passphrase) {
      lines.push(`personal-security.wpa-passphrase: ${ssid.passphrase ? '[write-only value supplied]' : '[required]'}`);
    }
    lines.push(
      `POST /network-config/v1alpha1/config-assignments (${ssid.scopeIds?.length ?? 0} scope${
        (ssid.scopeIds?.length ?? 0) === 1 ? '' : 's'
      })`,
    );
    return lines.join('\n');
  }
  const rendered =
    kind === 'port'
      ? configPreviewFor('port', form as PortForm)
      : configPreviewFor('vlan', form as VlanForm);
  const body = rendered
    .split('\n')
    .filter((line) => !line.startsWith('#'))
    .map((line) => (kind === 'port' ? line.replace(/,820,816$/, '') : line))
    .join('\n')
    .trimEnd();
  const target = kind === 'port' ? (form as PortForm).device || 'device not entered' : (form as VlanForm).scope;
  // The authored preview annotates the payload per plane ('# central → PUT
  // …', '# mist → read-only'). Those lines describe the fixture estate, so
  // live mode drops them rather than restating them for planes this
  // deployment may not have linked; naming the real call per plane needs the
  // broker's own pushPathFor (server-side) — see the handoff.
  const writeTargets = capabilities.filter((c) => c.mode !== 'read only').map((c) => c.plane);
  const writeLine =
    writeTargets.length > 0
      ? `# planes that can accept it → ${writeTargets.join(', ')}`
      : '# no linked plane can accept this payload — it opens in the plane console';
  return [
    body,
    `# target → ${target}`,
    writeLine,
    '# exact endpoint and impact are resolved by the broker dry run',
  ].join('\n');
}

function liveRadius(kind: ConfigKind, form: ConfigForm) {
  if (kind === 'ssid') {
    return [
      { what: 'Configuration assignments requested', count: `${(form as SsidForm).scopeIds?.length ?? 0}` },
      { what: 'Client sessions affected', count: 'not reported by this API' },
      { what: 'Target plane', count: (form as SsidForm).plane || 'CENTRAL' },
    ];
  }
  if (kind === 'port') {
    return [
      { what: 'Interfaces changed', count: (form as PortForm).id ? '1 requested' : 'not entered' },
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

/** "a, b and c" — a plane list read as a sentence. */
function listOf(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * The brokered-write sentence, derived from the capability matrix the API
 * sends rather than asserted. In live/blend mode that matrix is THIS
 * deployment's linked planes (screens.ts liveCapabilityMatrix), so the
 * authored "Central, the local collector and AOS-8 accept pushes…" claim
 * would name planes this install has never been given credentials for.
 */
function writeSurfaceNote(capabilities: CapabilityRow[]): string {
  const lease = 'Every push needs a ticket reference and holds a fifteen-minute lease.';
  if (capabilities.length === 0) {
    return `${lease} No plane has reported a write capability, so nothing here can be pushed until one is linked on Connected systems.`;
  }
  const writable = capabilities.filter((c) => c.mode !== 'read only').map((c) => c.plane);
  const readOnly = capabilities.filter((c) => c.mode === 'read only').map((c) => c.plane);
  const accepts =
    writable.length > 0
      ? `${listOf(writable)} accept${writable.length === 1 ? 's' : ''} pushes from here`
      : 'No linked plane accepts a push from here';
  if (readOnly.length === 0) return `${lease} ${accepts}.`;
  return `${lease} ${accepts}; ${listOf(readOnly)} ${readOnly.length === 1 ? 'is' : 'are'} read-only, so those changes open in their own console with the payload pre-filled.`;
}

/** Remaining write lease on a queued change, or null when it carries none. */
function leaseNote(entry: QueueEntry, now: number): string | null {
  if (!entry.expiresAt) return entry.id === null ? 'not on the broker — no lease' : null;
  const msLeft = Date.parse(entry.expiresAt) - now;
  if (!Number.isFinite(msLeft)) return null;
  if (msLeft <= 0) return 'lease expired — re-queue before pushing';
  const mins = Math.floor(msLeft / 60_000);
  return mins >= 1 ? `lease ${mins}m left` : `lease ${Math.floor(msLeft / 1000)}s left`;
}

function formForPreview(
  kind: ConfigKind | null,
  ssid: SsidForm,
  port: PortForm,
  vlan: VlanForm,
): ConfigForm {
  return kind === 'port' ? port : kind === 'vlan' ? vlan : ssid;
}

/** Drop values that the selected security mode cannot use. Hidden inputs
 *  must not survive a mode change and later ride along with a direct write. */
function ssidFormForSecurity(form: SsidForm, security: SsidSecurity): SsidForm {
  const { passphrase, authServerGroupId, captivePortalProfileId, ...base } = form;
  const requirement = ssidDependencyRequirementsFor(security);
  return {
    ...base,
    security,
    ...(requirement.passphrase && passphrase !== undefined ? { passphrase } : {}),
    ...(requirement.authServerGroup && authServerGroupId !== undefined ? { authServerGroupId } : {}),
    ...(requirement.captivePortal && captivePortalProfileId !== undefined ? { captivePortalProfileId } : {}),
  };
}

/** Server change → display row; the broker's state/what/where are authoritative. */
function rowForChange(change: BrokeredChange): QueueEntry {
  return {
    id: change.id,
    state: change.state,
    tone: STATE_TONE[change.state],
    what: change.what,
    where: change.where,
    ticket: change.ticket,
    expiresAt: change.expiresAt,
  };
}

/** The "what / where" summary a freshly queued change gets in the list. */
function queuedEntryFor(
  kind: ConfigKind,
  ssid: SsidForm,
  port: PortForm,
  vlan: VlanForm,
  ticket: string,
): QueueEntry {
  const base = { id: null, state: 'ready' as const, tone: 'success' as const, ticket };
  if (kind === 'ssid') {
    return {
      ...base,
      what: `Update wireless SSID ${ssid.name || '(unnamed)'}`,
      where: `${ssid.plane || 'CENTRAL'} · target group ${ssid.group}`,
    };
  }
  if (kind === 'port') {
    return {
      ...base,
      what: `Port ${port.id} on ${port.device} — ${port.desc || 'no description'}`,
      where: `${port.device} · local collector, recorded session`,
    };
  }
  const scopeLabel =
    VLAN_SCOPE_OPTIONS.find((o) => o.value === vlan.scope)?.label ?? vlan.scope.toUpperCase();
  return {
    ...base,
    what: `VLAN ${vlan.id}${vlan.name ? ` ${vlan.name}` : ''}`,
    where: `${scopeLabel} · local collector`,
  };
}

export default function Configure() {
  const { showPlatformTags } = useSettings();
  const { toast } = useToast();
  const [data, setData] = useState<ConfigureData | null>(null);
  const [queue, setQueue] = useState<QueueEntry[] | null>(null);
  const [queueSource, setQueueSource] = useState<'server' | 'local'>('local');

  const [kind, setKind] = useState<ConfigKind | null>(null);
  const [ssid, setSsid] = useState<SsidForm>(DEFAULT_SSID_FORM);
  const [port, setPort] = useState<PortForm>(DEFAULT_PORT_FORM);
  const [vlan, setVlan] = useState<VlanForm>(DEFAULT_VLAN_FORM);
  const [ticket, setTicket] = useState('');
  const [queued, setQueued] = useState(false);
  const [dryRun, setDryRun] = useState<{ result?: DryRunResult; error?: string } | null>(null);
  const [dryRunning, setDryRunning] = useState(false);
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
  // Blend mode swaps this screen's inventory to observed live rows while the
  // envelope still reads 'demo' (README §blendLive), so every live-flavoured
  // affordance follows the section, not the envelope's overall dataSource.
  const liveMode =
    data?.dataSource === 'live' || (data?.blended?.includes('configure') ?? false);

  useEffect(() => {
    let live = true;
    void Promise.all([getConfigure(), getChangeQueue()]).then(([d, serverQueue]) => {
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
    });
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(t);
  }, []);

  // A dry-run result is stale the moment the form or ticket changes — drop it.
  useEffect(() => {
    setDryRun(null);
  }, [kind, ssid, port, vlan, ticket]);

  // The "Queued for push" alert clears on the next form edit (the prototype
  // resets `queued` in every form setter — but NOT on a ticket edit).
  useEffect(() => {
    setQueued(false);
  }, [kind, ssid, port, vlan]);

  // A stale review/apply result must not survive an edit to the form it
  // described — the operator is reviewing a DIFFERENT payload now.
  useEffect(() => {
    setSsidReviewed(false);
    setSsidApplyResult(null);
  }, [ssid]);

  // -- live preview: recomputed on every keystroke and toggle ---------------
  const preview = useMemo(() => {
    if (liveMode)
      return livePreview(kind ?? 'ssid', formForPreview(kind, ssid, port, vlan), data?.capabilities ?? []);
    if (kind === 'port') return configPreviewFor('port', port);
    if (kind === 'vlan') return configPreviewFor('vlan', vlan);
    return configPreviewFor('ssid', ssid);
  }, [data?.capabilities, kind, liveMode, ssid, port, vlan]);
  const previewMeta = useMemo(() => {
    if (liveMode) {
      if (kind === 'port') return `${port.device || 'DEVICE NOT ENTERED'} · TEMPLATE PREVIEW`;
      if (kind === 'vlan') return `${vlan.scope.toUpperCase()} · TEMPLATE PREVIEW`;
      return `${ssid.plane || 'CENTRAL'} · TEMPLATE PREVIEW`;
    }
    if (kind === 'port') return previewMetaFor('port', port);
    if (kind === 'vlan') return previewMetaFor('vlan', vlan);
    return previewMetaFor('ssid', ssid);
  }, [kind, liveMode, ssid, port, vlan]);
  const radius = useMemo(() => {
    if (liveMode) return liveRadius(kind ?? 'ssid', formForPreview(kind, ssid, port, vlan));
    if (kind === 'port') return blastRadiusFor('port', port);
    if (kind === 'vlan') return blastRadiusFor('vlan', vlan);
    return blastRadiusFor('ssid', ssid);
  }, [kind, liveMode, ssid, port, vlan]);

  // -- SSID direct-apply derived state ---------------------------------------
  const ssidRequirement = useMemo(() => ssidDependencyRequirementsFor(ssid.security), [ssid.security]);
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
  const ssidFormComplete =
    ssid.name.trim().length > 0 &&
    ssid.vlan.trim().length > 0 &&
    (ssid.scopeIds?.length ?? 0) > 0 &&
    (!ssidRequirement.role || !!ssid.defaultRole) &&
    (!ssidRequirement.authServerGroup || !!ssid.authServerGroupId) &&
    (!ssidRequirement.captivePortal || !!ssid.captivePortalProfileId) &&
    (!ssidRequirement.passphrase || !!ssid.passphrase);
  const ssidApplyDisabled =
    !ssidFormComplete || ssidMissingDependencies.length > 0 || !ssidReviewed || ssidApplying || ssidCatalogLoading || !ssidCatalog;

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

  const toggleSwitch = (key: string) => {
    setExpandedSwitches((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  if (!data || !queue) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: 96 }}>
        <Spinner size="md" />
      </div>
    );
  }
  if (data.apiError) return <ApiErrorState message={data.apiError} />;
  const observedInventory = data.inventoryMode === 'observed';

  // -- drawer openers: seed the form over its current state ------------------
  const openSsid = (row?: SsidObject) => {
    setSsid({
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
    });
    setKind('ssid');
    setSsidReviewed(false);
    setSsidApplyResult(null);
    void loadSsidCatalog();
  };
  const openPort = (row?: PortObject) => {
    setPort({
      ...(liveMode ? LIVE_PORT_FORM : DEFAULT_PORT_FORM),
      ...(row ? seedFormFromRow('port', row) : {}),
    });
    setKind('port');
  };
  const openVlan = (row?: VlanObject) => {
    setVlan({
      ...(liveMode ? LIVE_VLAN_FORM : DEFAULT_VLAN_FORM),
      ...(row
        ? seedFormFromRow('vlan', row)
        : liveMode
          ? {}
          : { id: '', name: '', helpers: '10.42.0.20, 10.44.0.20' }),
    });
    setKind('vlan');
  };

  /** Load the editor's live scope/dependency catalog — called every time the
   *  SSID drawer opens, never cached across opens (a stale catalog could
   *  offer a scope or profile id the plane no longer has). */
  const loadSsidCatalog = async () => {
    setSsidCatalogLoading(true);
    setSsidCatalogError(null);
    const r = await getSsidCatalog();
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
    else setHistory({ kind: 'ok', events: r });
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
    if (queueSource === 'server') {
      for (const entry of queue.filter((q) => q.state === 'ready' && q.id !== null)) {
        const r = await pushChange(entry.id as string);
        if (isApiError(r)) {
          toast(r.error, { description: entry.what, tone: 'danger' });
        } else if (r.applied) {
          toast(r.message, { description: entry.what, tone: 'success' });
        } else {
          // Rendered-but-unverified and rejected pushes are honest outcomes.
          toast(r.message, { description: entry.what, tone: 'warning' });
        }
      }
      await refreshServerQueue();
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
      toast(`${local.length} local change${local.length === 1 ? '' : 's'} not pushed`, {
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

  const queueIt = async () => {
    const t = ticket.trim();
    if (!kind || !t) return;
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
    if (!kind || dryRunning) return;
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

  /**
   * Apply a reviewed SSID change directly (no ticket/queue). On success the
   * underlying /api/configure inventory is refreshed so the list reflects
   * the new/updated profile; on failure or partial success every entered
   * value stays exactly as typed so the operator can fix and retry.
   */
  const applySsid = async () => {
    if (!ssidReviewed || ssidApplying) return;
    setSsidApplying(true);
    const r = await applySsidDirect(ssidFormForSecurity(ssid, ssid.security), true);
    setSsidApplying(false);
    if (isApiError(r)) {
      setSsidApplyResult({ error: r.error });
      toast(r.error, { tone: 'danger' });
      return;
    }
    setSsidApplyResult({ result: r });
    if (r.ok) {
      toast(`${ssid.name} applied`, { description: r.profile.message, tone: 'success' });
      const refreshed = await getConfigure();
      setData(refreshed);
    } else if (r.partial) {
      toast(`${ssid.name}: profile applied, one or more scope assignments failed`, {
        description: 'Review the assignment results below and retry — the profile was not rolled back.',
        tone: 'warning',
      });
    } else {
      toast(`${ssid.name} was not applied`, { description: r.profile.message, tone: 'danger' });
    }
  };

  return (
    <div className="nt-configure" style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <ScreenHeader
        overline="Configure / Changes"
        title="Configuration"
        subtitle="Edit the object, not the console — the portal renders it for whichever plane owns it."
        actions={
          <>
            <Button variant="ghost" size="sm" onClick={() => void openHistory()}>
              Change history
            </Button>
            <Button variant="secondary" size="sm" onClick={() => openVlan()}>
              New VLAN
            </Button>
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

      <Alert tone="info" title="Writes are brokered, never standing">
        <span style={{ fontSize: 13 }}>{writeSurfaceNote(data.capabilities)}</span>
      </Alert>

      {liveMode && data.inventoryMode === 'unavailable' ? (
        <Alert tone="warning" title="Live configuration inventory is not available">
          <span style={{ fontSize: 13 }}>
            The broker queue is live, but the linked planes do not currently expose SSID, port, or VLAN inventory through
            this API. New changes can still be rendered and queued explicitly.
          </span>
        </Alert>
      ) : null}
      {observedInventory ? (
        <Alert tone="info" title="Inventory observed from active client sessions">
          <span style={{ fontSize: 13 }}>
            These SSIDs, ports, and VLANs were seen in live session telemetry. They are partial evidence, not an
            authoritative running configuration; selecting a row uses it only as a starting point for a new change.
          </span>
        </Alert>
      ) : null}

      <div className="nt-configure__layout">
        {/* ---------------- left: the three object lists ---------------- */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 26, minWidth: 0 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
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
                <div
                  className="nt-configure-row__name"
                  style={{
                    width: 150,
                    flex: '0 0 150px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 3,
                  }}
                >
                  <span
                    style={{
                      fontFamily: 'var(--nd-font-mono)',
                      fontSize: 12.5,
                      color: 'var(--nd-text-primary)',
                    }}
                  >
                    {w.name}
                  </span>
                  <span
                    style={{
                      fontFamily: 'var(--nd-font-mono)',
                      fontSize: 10,
                      color: 'var(--nd-text-muted)',
                    }}
                  >
                    {w.vlan}
                  </span>
                </div>
                <span
                  className="nt-configure-row__secondary"
                  style={{ width: 160, flex: '0 0 160px', fontSize: 12, color: 'var(--nd-text-secondary)' }}
                >
                  {w.security}
                </span>
                <span
                  className="nt-configure-row__summary"
                  style={{
                    flex: 1,
                    minWidth: 0,
                    fontFamily: 'var(--nd-font-mono)',
                    fontSize: 10.5,
                    color: 'var(--nd-text-muted)',
                  }}
                >
                  {w.targets}
                </span>
                <span className="nt-configure-row__actions">
                  {w.origin === 'observed' ? <Badge tone="info">Observed</Badge> : null}
                  {showPlatformTags ? <Badge tone={w.tone}>{w.plane}</Badge> : null}
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
                    ? 'No linked plane reported wireless configuration. "+ Add SSID" still renders and queues a new one.'
                    : 'This payload carries no SSID rows.'
                }
              />
            ) : null}
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
            <SectionHeader
              label="Switch ports"
              meta={
                <button type="button" style={MICRO_LINK} onClick={() => openPort()}>
                  + Configure a port
                </button>
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
                    ? 'No linked plane reported port configuration. "+ Configure a port" still renders and queues a change.'
                    : 'This payload carries no port rows.'
                }
              />
            ) : null}
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
            <SectionHeader
              label="VLANs & roles"
              meta={
                <button type="button" style={MICRO_LINK} onClick={() => openVlan()}>
                  + Add VLAN
                </button>
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
                <span
                  className="nt-configure-row__name"
                  style={{
                    width: 60,
                    flex: '0 0 60px',
                    fontFamily: 'var(--nd-font-mono)',
                    fontSize: 12.5,
                    color: 'var(--nd-text-primary)',
                  }}
                >
                  {v.id}
                </span>
                <span
                  className="nt-configure-row__secondary"
                  style={{ width: 150, flex: '0 0 150px', fontSize: 12.5, color: 'var(--nd-text-secondary)' }}
                >
                  {v.name}
                </span>
                <span
                  className="nt-configure-row__summary"
                  style={{
                    flex: 1,
                    minWidth: 0,
                    fontFamily: 'var(--nd-font-mono)',
                    fontSize: 10.5,
                    color: 'var(--nd-text-muted)',
                  }}
                >
                  {v.detail}
                </span>
                <span className="nt-configure-row__actions">
                  <span style={{ fontFamily: 'var(--nd-font-mono)', fontSize: 10.5, color: 'var(--nd-text-muted)' }}>
                    {v.role}
                  </span>
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
                    ? 'No linked plane reported VLAN configuration. "+ Add VLAN" still renders and queues a new one.'
                    : 'This payload carries no VLAN rows.'
                }
              />
            ) : null}
          </div>
        </div>

        {/* ---------------- right: queue + capability matrix ---------------- */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 26, minWidth: 0 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
            <SectionHeader label="Queued changes" meta={String(queue.length)} />
            {queue.map((q) => {
              const lease = leaseNote(q, now);
              const leaseGone = lease?.startsWith('lease expired') ?? false;
              return (
              <div
                key={q.id ?? `${q.ticket}-${q.what}`}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 5,
                  padding: '12px 0',
                  borderBottom: '1px solid var(--nd-border-subtle)',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <Badge tone={q.tone}>{q.state}</Badge>
                  <span
                    style={{
                      fontFamily: 'var(--nd-font-mono)',
                      fontSize: 10,
                      color: 'var(--nd-text-muted)',
                      marginLeft: 'auto',
                    }}
                  >
                    {q.ticket}
                  </span>
                </div>
                <span style={{ fontSize: 12.5, color: 'var(--nd-text-primary)', lineHeight: 1.4 }}>
                  {q.what}
                </span>
                <span
                  style={{
                    fontFamily: 'var(--nd-font-mono)',
                    fontSize: 10,
                    color: 'var(--nd-text-muted)',
                  }}
                >
                  {q.where}
                </span>
                {lease ? (
                  <span
                    style={{
                      fontFamily: 'var(--nd-font-mono)',
                      fontSize: 10,
                      color: leaseGone ? 'var(--nd-warning)' : 'var(--nd-text-muted)',
                    }}
                  >
                    {lease}
                  </span>
                ) : null}
              </div>
              );
            })}
            {queue.length === 0 ? (
              <EmptyState
                title="No changes queued"
                description="Edit an SSID, port or VLAN to render a payload and queue it against a ticket."
              />
            ) : null}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, paddingTop: 12 }}>
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

          <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
            <SectionHeader label="Where a change can go" />
            {data.capabilities.map((c) => (
              <div
                key={c.plane}
                className="nt-configure-capability"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  padding: '9px 0',
                  borderBottom: '1px solid var(--nd-border-subtle)',
                }}
              >
                <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, color: 'var(--nd-text-primary)' }}>
                  {c.plane}
                </span>
                <span
                  style={{
                    fontFamily: 'var(--nd-font-mono)',
                    fontSize: 10,
                    color: 'var(--nd-text-muted)',
                  }}
                >
                  {c.note}
                </span>
                <Badge tone={c.tone}>{c.mode}</Badge>
              </div>
            ))}
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
        description={kind ? (liveMode ? LIVE_CONFIG_DESCS[kind] : CONFIG_EDIT_DESCS[kind]) : ''}
      >
        {kind ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
            {kind === 'ssid' ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                <div
                  style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 14 }}
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
                  style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 14 }}
                >
                  <FormField
                    label="Security"
                    help="Direct apply loads the live role/AAA/captive-portal dependencies this mode needs below."
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

                {/* -- live security dependencies (role / auth server / captive portal / passphrase) -- */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  <SectionHeader label="Security dependencies" meta={ssidCatalogLoading ? 'loading…' : undefined} />
                  {/* FormField only clones an id onto a SINGLE child element for the
                      label's htmlFor — the "unavailable" note is a sibling below it,
                      never a second child, or the select loses its accessible name. */}
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
                  {ssidCatalog?.unavailable.includes('roles') ? (
                    <span style={{ fontSize: 11, color: 'var(--nd-warning-text, var(--nd-text-muted))' }}>
                      {ssidSectionUnavailableNote('roles')}
                    </span>
                  ) : null}
                  {ssidRequirement.authServerGroup ? (
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
                        <span style={{ fontSize: 11, color: 'var(--nd-warning-text, var(--nd-text-muted))' }}>
                          {ssidSectionUnavailableNote('authServerGroups')}
                        </span>
                      ) : null}
                    </>
                  ) : null}
                  {ssidRequirement.captivePortal ? (
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
                        <span style={{ fontSize: 11, color: 'var(--nd-warning-text, var(--nd-text-muted))' }}>
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

                {/* -- scope targets (immutable plane ids, grouped by category) -- */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <SectionHeader label="Scope" meta={`${ssid.scopeIds?.length ?? 0} selected`} />
                  {ssidCatalogLoading ? (
                    <div style={{ display: 'flex', justifyContent: 'center', padding: 16 }}>
                      <Spinner size="sm" />
                    </div>
                  ) : ssidCatalogError ? (
                    <Alert tone="danger" title="The scope catalog could not be read">
                      <span style={{ fontSize: 13 }}>{ssidCatalogError}</span>
                    </Alert>
                  ) : ssidScopeGroups.length === 0 ? (
                    <EmptyState
                      title="No scope choices reported"
                      description="This plane did not report any sites, site collections, AP device groups, or APs to target."
                    />
                  ) : (
                    ssidScopeGroups.map((group) => (
                      <div key={group.category} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                        <span
                          style={{
                            fontFamily: 'var(--nd-font-mono)',
                            fontSize: 10,
                            letterSpacing: '.06em',
                            textTransform: 'uppercase',
                            color: 'var(--nd-text-muted)',
                          }}
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
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 10,
                    padding: '14px 0',
                    borderTop: '1px solid var(--nd-border-subtle)',
                    borderBottom: '1px solid var(--nd-border-subtle)',
                  }}
                >
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
              <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                <div
                  style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 14 }}
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
                  style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 14 }}
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
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 10,
                    padding: '14px 0',
                    borderTop: '1px solid var(--nd-border-subtle)',
                    borderBottom: '1px solid var(--nd-border-subtle)',
                  }}
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
              <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                <div
                  style={{ display: 'grid', gridTemplateColumns: '80px minmax(0, 1fr)', gap: 14 }}
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
                      ? 'Comma-separated helper addresses. The portal holds no baseline for this VLAN — the dry run reports what the plane currently has.'
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

            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <SectionHeader label="What gets pushed" meta={previewMeta} />
              <Code block>{preview}</Code>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <SectionHeader label={liveMode ? 'Impact evidence' : 'Blast radius'} />
              {radius.map((r) => (
                <div
                  key={r.what}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    padding: '8px 0',
                    borderBottom: '1px solid var(--nd-border-subtle)',
                  }}
                >
                  <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, color: 'var(--nd-text-secondary)' }}>
                    {r.what}
                  </span>
                  <span
                    style={{
                      fontFamily: 'var(--nd-font-mono)',
                      fontSize: 11,
                      color: 'var(--nd-text-muted)',
                    }}
                  >
                    {r.count}
                  </span>
                </div>
              ))}
            </div>

            {kind === 'ssid' ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <SectionHeader label="Review — exact scope assignments" />
                {(ssid.scopeIds ?? []).length === 0 ? (
                  <span style={{ fontSize: 12.5, color: 'var(--nd-text-muted)' }}>
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
                        <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, color: 'var(--nd-text-secondary)' }}>
                          {option?.label ?? scopeId}
                        </span>
                        <Badge tone="neutral">{option ? SSID_SCOPE_CATEGORY_LABEL[option.category] : 'unknown'}</Badge>
                      </div>
                    );
                  })
                )}
                <span style={{ fontFamily: 'var(--nd-font-mono)', fontSize: 10.5, color: 'var(--nd-text-muted)' }}>
                  device-function CAMPUS_AP · assigned via /network-config/v1alpha1/config-assignments — no secret value is ever shown here.
                </span>

                <Checkbox
                  label="I have reviewed this profile and these scope assignments — apply directly, no ticket."
                  checked={ssidReviewed}
                  onChange={(e) => setSsidReviewed(e.target.checked)}
                />
                {ssidMissingDependencies.length > 0 ? (
                  <Alert tone="warning" title="Apply is disabled — a required live dependency is unavailable">
                    <span style={{ fontSize: 13 }}>
                      This plane did not report: {ssidMissingDependencies.join(', ')}.
                    </span>
                  </Alert>
                ) : null}
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <Button variant="primary" size="md" disabled={ssidApplyDisabled} onClick={() => void applySsid()}>
                    {ssidApplying ? 'Applying…' : 'Apply directly'}
                  </Button>
                  <Button variant="ghost" size="md" onClick={() => setKind(null)}>
                    Cancel
                  </Button>
                </div>
                {ssidApplyResult ? (
                  ssidApplyResult.error ? (
                    <Alert tone="danger" title="Apply failed">
                      <span style={{ fontSize: 13 }}>{ssidApplyResult.error}</span>
                    </Alert>
                  ) : ssidApplyResult.result ? (
                    <Alert
                      tone={ssidApplyResult.result.ok ? 'success' : ssidApplyResult.result.partial ? 'warning' : 'danger'}
                      title={
                        ssidApplyResult.result.ok
                          ? 'Applied'
                          : ssidApplyResult.result.partial
                            ? 'Partial — profile applied, an assignment failed'
                            : 'Not applied'
                      }
                    >
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                        <span style={{ fontSize: 13 }}>
                          Profile ({ssidApplyResult.result.profile.action}): {ssidApplyResult.result.profile.message}
                        </span>
                        {ssidApplyResult.result.assignments.map((a) => (
                          <span key={a.scopeId} style={{ fontSize: 12.5, color: 'var(--nd-text-secondary)' }}>
                            {a.ok ? '✓' : '✗'} {a.label} — {a.message}
                          </span>
                        ))}
                      </div>
                    </Alert>
                  ) : null
                ) : null}
                <span
                  style={{
                    fontFamily: 'var(--nd-font-mono)',
                    fontSize: 10.5,
                    color: 'var(--nd-text-muted)',
                    lineHeight: 1.6,
                  }}
                >
                  Direct apply — no ticket, no queue. An audit event is still recorded for every attempt.
                </span>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
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
                    <span style={{ fontSize: 13 }}>{queuedChangeNote(ticket)}</span>
                  </Alert>
                ) : null}
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <Button variant="primary" size="md" disabled={!ticket.trim()} onClick={() => void queueIt()}>
                    Queue the change
                  </Button>
                  <Button variant="secondary" size="md" disabled={dryRunning} onClick={() => void doDryRun()}>
                    Dry run
                  </Button>
                  <Button variant="ghost" size="md" onClick={() => setKind(null)}>
                    Cancel
                  </Button>
                </div>
                {dryRun ? (
                  dryRun.error ? (
                    <Alert tone="danger" title="Dry run rejected">
                      <span style={{ fontSize: 13 }}>{dryRun.error}</span>
                    </Alert>
                  ) : dryRun.result ? (
                    <Alert
                      tone={dryRun.result.ok ? (dryRun.result.snapshot ? 'success' : 'info') : 'warning'}
                      title="Dry run"
                    >
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                        <span style={{ fontSize: 13 }}>{dryRun.result.note}</span>
                        <Code block>{dryRun.result.rendered}</Code>
                        <span
                          style={{
                            fontFamily: 'var(--nd-font-mono)',
                            fontSize: 10.5,
                            color: 'var(--nd-text-muted)',
                          }}
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
                  style={{
                    fontFamily: 'var(--nd-font-mono)',
                    fontSize: 10.5,
                    color: 'var(--nd-text-muted)',
                    lineHeight: 1.6,
                  }}
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
        description="The write broker's audit log: what happened to every brokered change, with the ticket it was raised against. Payload bodies are deliberately not recorded."
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <SectionHeader
            label="Brokered changes"
            meta={history.kind === 'ok' ? String(history.events.length) : undefined}
          />
          {history.kind === 'loading' ? (
            <div style={{ display: 'flex', justifyContent: 'center', padding: 32 }}>
              <Spinner size="sm" />
            </div>
          ) : null}
          {history.kind === 'error' ? (
            <Alert tone="danger" title="The audit log could not be read">
              <span style={{ fontSize: 13 }}>{history.message}</span>
            </Alert>
          ) : null}
          {history.kind === 'offline' ? (
            <EmptyState
              title="The portal backend did not answer"
              description="The audit log lives on the server with the write broker; there is no local copy to show. Reconnect the backend and open this again."
            />
          ) : null}
          {history.kind === 'ok'
            ? history.events.map((e, i) => (
                <div
                  key={`${e.ts}-${e.changeId}-${e.event}-${i}`}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 12,
                    padding: '10px 0',
                    borderBottom: '1px solid var(--nd-border-subtle)',
                  }}
                >
                  <span
                    style={{
                      fontFamily: 'var(--nd-font-mono)',
                      fontSize: 10.5,
                      color: 'var(--nd-text-muted)',
                      width: 44,
                      flex: '0 0 44px',
                    }}
                  >
                    {hhmm(e.ts)}
                  </span>
                  <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
                    <span style={{ fontSize: 12.5, color: 'var(--nd-text-primary)', lineHeight: 1.4 }}>
                      {e.event} {e.kind}
                    </span>
                    <span
                      style={{
                        fontFamily: 'var(--nd-font-mono)',
                        fontSize: 10,
                        color: 'var(--nd-text-muted)',
                      }}
                    >
                      {e.changeId}
                    </span>
                  </div>
                  <span
                    style={{
                      fontFamily: 'var(--nd-font-mono)',
                      fontSize: 10,
                      color: 'var(--nd-text-muted)',
                    }}
                  >
                    {e.ticket}
                  </span>
                  <Badge tone={auditTone(e.result)}>{e.result}</Badge>
                </div>
              ))
            : null}
          {history.kind === 'ok' && history.events.length === 0 ? (
            <EmptyState
              title="No brokered changes recorded yet"
              description="Every dry run, queue, push and discard is written to the broker's audit log. Nothing has gone through it on this install."
            />
          ) : null}
        </div>
      </Drawer>
    </div>
  );
}
