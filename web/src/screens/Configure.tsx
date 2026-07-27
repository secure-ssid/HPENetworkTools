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
  discardChange,
  dryRunConfig,
  getChangeHistory,
  getChangeQueue,
  getConfigure,
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
  SSID_GROUP_OPTIONS,
  SSID_SECURITY_OPTIONS,
  VLAN_SCOPE_OPTIONS,
  blastRadiusFor,
  configPreviewFor,
  previewMetaFor,
  queuedChangeNote,
  seedFormFromRow,
} from '../../../shared';
import type {
  BrokerAuditEvent,
  CapabilityRow,
  ConfigForm,
  ConfigKind,
  PortForm,
  PortObject,
  QueuedChangeRow,
  SsidBands,
  SsidForm,
  SsidObject,
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
  display: 'flex',
  alignItems: 'center',
  gap: 16,
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

const LIVE_CONFIG_DESCS: Record<ConfigKind, string> = {
  ssid: 'Build a payload from operator-entered values. The dry run resolves the real Central target and reachability.',
  port: 'Build a switch payload for the named live device. The dry run resolves collector reachability and rollback evidence.',
  vlan: 'Build a VLAN payload for the selected broker scope. The dry run resolves actual reachable devices.',
};

const LIVE_PUSH_NOTES: Record<ConfigKind, string> = {
  ssid: 'The broker resolves the live target during dry run; no AP count, client count, Mist hand-off, or authentication trust is assumed.',
  port: 'The broker verifies collector reachability and requests a rollback snapshot during dry run.',
  vlan: 'The broker resolves reachable switches during dry run; no device, client, or compliance count is assumed.',
};

function livePreview(kind: ConfigKind, form: ConfigForm, capabilities: CapabilityRow[]): string {
  const rendered =
    kind === 'port'
      ? configPreviewFor('port', form as PortForm)
      : kind === 'vlan'
        ? configPreviewFor('vlan', form as VlanForm)
        : configPreviewFor('ssid', form as SsidForm);
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
        ? (form as PortForm).device || 'device not entered'
        : (form as VlanForm).scope;
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
      { what: 'Access points that reload the profile', count: 'requires dry run' },
      { what: 'Client sessions that will re-authenticate', count: 'requires dry run' },
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
    });
    setKind('ssid');
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

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
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

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
          gap: 18,
          maxWidth: 860,
        }}
      >
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

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 1.55fr) minmax(0, 1fr)',
          gap: 34,
          alignItems: 'start',
        }}
      >
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
                className="nt-rowlink"
                style={ROW}
                onClick={() => openSsid(w)}
              >
                <div
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
                <span style={{ width: 160, flex: '0 0 160px', fontSize: 12, color: 'var(--nd-text-secondary)' }}>
                  {w.security}
                </span>
                <span
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
                {w.origin === 'observed' ? <Badge tone="info">Observed</Badge> : null}
                {showPlatformTags ? <Badge tone={w.tone}>{w.plane}</Badge> : null}
                <span
                  style={{
                    fontFamily: 'var(--nd-font-mono)',
                    fontSize: 11,
                    color: 'var(--nd-accent-text)',
                    width: 44,
                    textAlign: 'right',
                  }}
                >
                  {w.origin === 'observed' ? 'Use ▸' : 'Edit ▸'}
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
            {data.ports.map((p) => (
              <button
                key={`${p.device}-${p.port}`}
                type="button"
                className="nt-rowlink"
                style={ROW}
                onClick={() => openPort(p)}
              >
                <div
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
                    {p.device}
                  </span>
                  <span
                    style={{
                      fontFamily: 'var(--nd-font-mono)',
                      fontSize: 10,
                      color: 'var(--nd-text-muted)',
                    }}
                  >
                    port {p.port}
                  </span>
                </div>
                <span style={{ width: 160, flex: '0 0 160px', fontSize: 12, color: 'var(--nd-text-secondary)' }}>
                  {p.desc}
                </span>
                <span
                  style={{
                    flex: 1,
                    minWidth: 0,
                    fontFamily: 'var(--nd-font-mono)',
                    fontSize: 10.5,
                    color: 'var(--nd-text-muted)',
                  }}
                >
                  {p.summary}
                </span>
                <Badge tone={p.tone} dot>
                  {p.state}
                </Badge>
                {p.origin === 'observed' ? <Badge tone="info">Observed</Badge> : null}
                <span
                  style={{
                    fontFamily: 'var(--nd-font-mono)',
                    fontSize: 11,
                    color: 'var(--nd-accent-text)',
                    width: 44,
                    textAlign: 'right',
                  }}
                >
                  {p.origin === 'observed' ? 'Use ▸' : 'Edit ▸'}
                </span>
              </button>
            ))}
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
                className="nt-rowlink"
                style={ROW}
                onClick={() => openVlan(v)}
              >
                <span
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
                <span style={{ width: 150, flex: '0 0 150px', fontSize: 12.5, color: 'var(--nd-text-secondary)' }}>
                  {v.name}
                </span>
                <span
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
                <span
                  style={{
                    fontFamily: 'var(--nd-font-mono)',
                    fontSize: 10.5,
                    color: 'var(--nd-text-muted)',
                    width: 90,
                    textAlign: 'right',
                  }}
                >
                  {v.role}
                </span>
                {v.origin === 'observed' ? <Badge tone="info">Observed</Badge> : null}
                <span
                  style={{
                    fontFamily: 'var(--nd-font-mono)',
                    fontSize: 11,
                    color: 'var(--nd-accent-text)',
                    width: 44,
                    textAlign: 'right',
                  }}
                >
                  {v.origin === 'observed' ? 'Use ▸' : 'Edit ▸'}
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
            <div style={{ display: 'flex', gap: 8, paddingTop: 12 }}>
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
                <FormField
                  label="Security"
                  help={
                    liveMode
                      ? 'Select the security template expected by the target plane. Authentication dependencies are verified outside this inventory-only preview.'
                      : 'Enterprise modes authenticate against ClearPass over RadSec; PSK and portal modes stay local to the plane.'
                  }
                >
                  <Select
                    options={SSID_SECURITY_OPTIONS}
                    value={ssid.security}
                    onValueChange={(v) => setSsid({ ...ssid, security: v as SsidSecurity })}
                  />
                </FormField>
                <div
                  style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 14 }}
                >
                  <FormField label="Target group">
                    {liveMode ? (
                      <Input
                        mono
                        placeholder="Enter Central group"
                        value={ssid.group}
                        onChange={(e) => setSsid({ ...ssid, group: e.target.value })}
                      />
                    ) : (
                      <Select
                        options={SSID_GROUP_OPTIONS}
                        value={ssid.group}
                        onValueChange={(v) => setSsid({ ...ssid, group: v })}
                      />
                    )}
                  </FormField>
                  <FormField label="Bands">
                    <Select
                      options={SSID_BAND_OPTIONS}
                      value={ssid.bands}
                      onValueChange={(v) => setSsid({ ...ssid, bands: v as SsidBands })}
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
                    label="Broadcast the SSID"
                    checked={ssid.broadcast}
                    onCheckedChange={(v) => setSsid({ ...ssid, broadcast: v })}
                  />
                  <Switch
                    label="Client isolation"
                    checked={ssid.isolate}
                    onCheckedChange={(v) => setSsid({ ...ssid, isolate: v })}
                  />
                  <Switch
                    label="Exclude DFS channels (clinical floors)"
                    checked={ssid.noDfs}
                    onCheckedChange={(v) => setSsid({ ...ssid, noDfs: v })}
                  />
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
                        onChange={(e) => setPort({ ...port, device: e.target.value })}
                      />
                    ) : (
                      <Select
                        options={PORT_DEVICE_OPTIONS}
                        value={port.device}
                        onValueChange={(v) => setPort({ ...port, device: v })}
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
