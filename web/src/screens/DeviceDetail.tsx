/**
 * web/src/screens/DeviceDetail.tsx — terminal, configuration, clients and
 * compliance for one device. High-fidelity port of design/NtDeviceDetail.dc.html:
 * header (Heading = device name, state + plane Badges, mono model · site · IP,
 * actions ← Inventory / Open in <plane> / Save config / Reboot), five
 * class-specific Stats, then flair → two
 * columns (1.55fr / 1fr). Compliance renders the route's served per-device
 * evidence block in BOTH modes (the authored profile.checks are only the
 * fallback for a payload that carried none), and an `unavailable` or empty
 * block renders a named empty state rather than a clean scorecard.
 * Left: the Local terminal (web/src/lib/TerminalPane —
 * shell-capable devices first try the recorded-SSH WebSocket transport from
 * web/src/lib/wsTerminal.ts, falling back to the canned demo transport when
 * the bridge is unreachable; cloud-claimed devices get read-only telemetry,
 * no input/chips; the banner and the quick-command chips come from the
 * envelope's `terminal` block when the route sent one, and from the shared
 * helpers otherwise; the titlebar names the session from the bridge's own
 * 'ready' frame — user, dialled target and jump host — falling back to the
 * recorded-transcript match only for a bridge that names none)
 * and Configuration (SegmentedControl
 * Running | Drift vs. baseline | History; drift rendered via DiffCode with
 * danger/success line colouring; Snapshot stores a local history row, Download
 * saves the running config as a file). Right: Identity facts, the class block
 * (Ports of interest / Cluster members / Radios & SSIDs / Tunnels / Services),
 * Clients on this device, Compliance.
 * Data: getDeviceDetail(name) — live /api/devices/:name when the server is up,
 * the shared deviceProfile() fixtures otherwise. The route ships the reconciled
 * inventory row alongside the authored profile, and that row is authoritative
 * for identity in both modes, so the header can never contradict the Devices
 * table it was opened from; a row the reconciler flagged carries a warning
 * Alert naming its claiming planes. Live mode carries only the
 * reconciled inventory row: the authored profile/config/clients are demo
 * data, so the live view renders the real row (header + console hand-off,
 * five Stats derived only from fields the poller returned, Identity stamped
 * with the envelope's syncedAt and carrying the firmware-vs-approved
 * verdict), its recorded shell sessions, plus honest "not available in
 * live mode" sections (a live 404 renders an EmptyState, never fixtures; an
 * OFFLINE 404 says the portal is on fixtures rather than blaming a plane).
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Alert,
  Badge,
  Button,
  Code,
  Divider,
  Drawer,
  EmptyState,
  FormField,
  Heading,
  SectionHeader,
  SegmentedControl,
  Select,
  Spinner,
  Stat,
  useToast,
} from '../nightdesk';
import { getDeviceDetail, getTerminalSession, getTerminalSessions, getTickets, rebootDevice } from '../api/client';
import type { TerminalSession, TerminalSessionEvent } from '../api/client';
import type { DeviceDetailData } from '../api/client';
import { deviceTerminalKind, terminalQuickCommands } from '../../../shared';
import type { CfgHistoryRow, DeviceEvidence, Fact, Plane, TicketRow } from '../../../shared';
import { useSettings } from '../app/SettingsContext';
import { TerminalPane, createCannedTransport } from '../lib/TerminalPane';
import { createWsTransport } from '../lib/wsTerminal';
import type { AsyncTerminalTransport, TerminalSessionIdentity } from '../lib/wsTerminal';
import { DiffCode } from '../lib/DiffCode';
import { ApiErrorState } from './ApiErrorState';

type CfgTab = 'running' | 'diff' | 'history';

const CFG_TABS = [
  { value: 'running', label: 'Running' },
  { value: 'diff', label: 'Drift vs. baseline' },
  { value: 'history', label: 'History' },
];

/** Envelope freshness stamp, same format the other live screens use. */
function hhmm(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** An Identity fact plus an optional colour override — a fact that carries a
 *  judgement (firmware off the approved train) has to look like one. */
type LiveFact = Fact & { tone?: string };

/** Honest "no live feed" note under a section header — mono, muted, never a fixture stand-in. */
function LiveGapNote({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        fontFamily: 'var(--nd-font-mono)',
        fontSize: 'var(--nd-text-10)',
        color: 'var(--nd-text-muted)',
        padding: '8px 0',
        lineHeight: 1.6,
      }}
    >
      {children}
    </div>
  );
}

/**
 * The "Compliance" panel, rendered from the ONE evidence block the route
 * serves in every mode (`data.evidence`; getDeviceDetail() normalizes a bare
 * `checks` list into the same shape, so this is the only contract the screen
 * reads). The block exists precisely so an EMPTY verdict list cannot be
 * mistaken for a clean scorecard: `mode: 'unavailable'` — and an absent block,
 * which says even less — renders a named empty state carrying the server's own
 * reason, never a silent pass.
 */
function CompliancePanel({
  evidence,
  gapNote,
  children,
}: {
  evidence: DeviceEvidence | null;
  /** What the verdicts do NOT cover, printed under a populated list only. */
  gapNote?: ReactNode;
  children?: ReactNode;
}) {
  const scored = evidence !== null && evidence.mode !== 'unavailable' && evidence.checks.length > 0;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <SectionHeader label="Compliance" />
      {scored ? (
        <>
          {evidence.checks.map((c) => (
            <div key={c.rule ?? c.label} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <Badge tone={c.tone}>{c.mark}</Badge>
              <span
                style={{
                  flex: 1,
                  minWidth: 0,
                  fontSize: 'var(--nd-text-12)',
                  color: 'var(--nd-text-secondary)',
                }}
              >
                {c.label}
              </span>
            </div>
          ))}
          {gapNote ? <LiveGapNote>{gapNote}</LiveGapNote> : null}
        </>
      ) : (
        <EmptyState
          title="No evidence for this device"
          description={
            evidence?.note ??
            (evidence
              ? 'The evidence block came back with no verdicts in it. An empty list is not a pass — nothing here has been checked.'
              : 'No plane supplied evidence alongside this device, so there is nothing to score. An empty list is not a pass.')
          }
        />
      )}
      {children}
    </div>
  );
}

/** Recorded shell transcripts on file for this device. Shared by the authored
 *  profile view and the live view — every recorded session belongs to the
 *  device it was opened against, whichever mode is rendering it. */
function RecordedSessions({
  sessions,
  sessionsError,
  expanded,
  toggleTranscript,
}: {
  sessions: TerminalSession[];
  sessionsError: string | null;
  expanded: { file: string; events: TerminalSessionEvent[]; truncated: boolean } | null;
  toggleTranscript: (file: string) => void;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2, paddingTop: 10 }}>
      <SectionHeader label="Recorded sessions" meta={sessions.length > 0 ? `${sessions.length} ON FILE` : undefined} />
      {sessionsError ? (
        <div
          role="alert"
          style={{
            fontFamily: 'var(--nd-font-mono)',
            fontSize: 'var(--nd-text-10)',
            color: 'var(--nd-danger)',
            padding: '8px 0',
          }}
        >
          {sessionsError}
        </div>
      ) : sessions.length === 0 ? (
        <div
          style={{
            fontFamily: 'var(--nd-font-mono)',
            fontSize: 'var(--nd-text-10)',
            color: 'var(--nd-text-muted)',
            padding: '8px 0',
          }}
        >
          No recorded sessions for this device — every session opened above is recorded to the portal.
        </div>
      ) : (
        sessions.map((s) => (
          <div key={s.file} style={{ borderBottom: '1px solid var(--nd-border-subtle)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0' }}>
              <span
                style={{
                  fontFamily: 'var(--nd-font-mono)',
                  fontSize: 'var(--nd-text-10)',
                  color: 'var(--nd-text-muted)',
                }}
              >
                {new Date(s.openedAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
              </span>
              <span
                style={{
                  fontFamily: 'var(--nd-font-mono)',
                  fontSize: 'var(--nd-text-11)',
                  color: 'var(--nd-text-secondary)',
                }}
              >
                {s.user}@{s.target}
              </span>
              <Button variant="ghost" size="sm" style={{ marginLeft: 'auto' }} onClick={() => toggleTranscript(s.file)}>
                {expanded?.file === s.file ? 'Hide transcript' : 'View transcript'}
              </Button>
            </div>
            {expanded?.file === s.file ? (
              <div
                style={{
                  maxHeight: 260,
                  overflowY: 'auto',
                  margin: '0 0 10px',
                  padding: '10px 12px',
                  border: '1px solid var(--nd-border-default)',
                  background: 'var(--nd-bg-raised)',
                  fontFamily: 'var(--nd-font-mono)',
                  fontSize: 'var(--nd-text-10)',
                  lineHeight: 1.6,
                  whiteSpace: 'pre-wrap',
                  overflowWrap: 'anywhere',
                }}
              >
                {expanded.events.map((e, i) => (
                  <div
                    key={i}
                    style={{
                      color:
                        e.type === 'in'
                          ? 'var(--nd-accent-text)'
                          : e.type === 'blocked'
                            ? 'var(--nd-warning)'
                            : e.type === 'open' || e.type === 'close'
                              ? 'var(--nd-text-muted)'
                              : 'var(--nd-text-secondary)',
                    }}
                  >
                    {e.type === 'in'
                      ? `$ ${e.text ?? ''}`
                      : e.type === 'blocked'
                        ? `% blocked — ${e.text ?? ''} (${e.reason ?? 'policy'})`
                        : e.type === 'open'
                          ? `— session opened · ${e.text ?? ''}`
                          : e.type === 'close'
                            ? `— session closed · ${e.reason ?? ''}`
                            : (e.text ?? '')}
                  </div>
                ))}
                {expanded.truncated ? (
                  <div style={{ color: 'var(--nd-warning)' }}>— transcript truncated at the read cap —</div>
                ) : null}
              </div>
            ) : null}
          </div>
        ))
      )}
    </div>
  );
}

export default function DeviceDetail() {
  const { name = '' } = useParams();
  const navigate = useNavigate();
  const { showPlatformTags } = useSettings();
  const { toast } = useToast();
  const [data, setData] = useState<DeviceDetailData | null>(null);
  const [cfgTab, setCfgTab] = useState<CfgTab>('running');
  const [extraHistory, setExtraHistory] = useState<CfgHistoryRow[]>([]);

  useEffect(() => {
    let live = true;
    void getDeviceDetail(name).then((d) => {
      if (live) setData(d);
    });
    return () => {
      live = false;
    };
  }, [name]);

  // Config tab and locally-snapshotted rows are per-device state.
  useEffect(() => {
    setCfgTab('running');
    setExtraHistory([]);
  }, [name]);

  const kind = data?.profile?.kind ?? 'sw';
  // The route computes the shell banner and the quick-command chips for the
  // class it actually served (`terminal` on the envelope), so prefer that pair
  // over re-deriving it here — the server stays the single authority and the
  // two sides cannot disagree. The demo branch sends it today and the live
  // branch does not, so both readers keep the shared-helper fallback (which is
  // also the path the offline fixture fallback takes, where no route ran).
  const servedBanner = data?.terminal?.banner;
  const servedQuickCommands = data?.terminal?.quickCommands;
  const cannedTransport = useMemo(() => {
    const canned = createCannedTransport({ kind });
    return servedBanner ? { ...canned, banner: () => servedBanner } : canned;
  }, [kind, servedBanner]);
  const [liveTransport, setLiveTransport] = useState<AsyncTerminalTransport | null>(null);
  const [livePrompt, setLivePrompt] = useState<string | null>(null);
  const [terminalAttempt, setTerminalAttempt] = useState(0);
  const [terminalState, setTerminalState] = useState<'idle' | 'connecting' | 'live' | 'disconnected'>('idle');
  // When this pane's own session went live. Used to tell the recording the
  // portal just opened from someone else's older transcript — only the former
  // may be named as "who is connected".
  const [liveSince, setLiveSince] = useState<string | null>(null);
  // Who the BRIDGE says this session is, straight off its 'ready' frame. It
  // cannot lag the socket and cannot belong to another operator, so it outranks
  // the transcript-matching heuristic below; a bridge that names no session
  // (an older one) leaves it null and the heuristic still stands in.
  const [liveSession, setLiveSession] = useState<TerminalSessionIdentity | null>(null);

  // Recorded shell sessions on file for this device (empty when backend absent);
  // the expanded transcript loads on demand.
  const [sessions, setSessions] = useState<TerminalSession[]>([]);
  const [sessionsError, setSessionsError] = useState<string | null>(null);
  const [sessionsRefresh, setSessionsRefresh] = useState(0);
  const [expanded, setExpanded] = useState<{ file: string; events: TerminalSessionEvent[]; truncated: boolean } | null>(null);
  // Latest requested transcript — stale resolutions (clicked A then B) are ignored.
  const transcriptReq = useRef<string | null>(null);
  useEffect(() => {
    let live = true;
    setExpanded(null);
    setSessions([]);
    setSessionsError(null);
    transcriptReq.current = null;
    void getTerminalSessions(name)
      .then((s) => {
        if (live) setSessions(s);
      })
      .catch((err: Error) => {
        if (live) setSessionsError(`Recorded sessions could not be loaded: ${err.message}`);
      });
    return () => {
      live = false;
    };
  }, [name, sessionsRefresh]);

  // Shell-capable devices get a shot at the real recorded-SSH bridge
  // (web/src/lib/wsTerminal.ts → /api/terminal/:name). On any failure the
  // canned transport below renders exactly as before — the fallback is the
  // demo path, untouched.
  useEffect(() => {
    setLiveTransport(null);
    setLivePrompt(null);
    setLiveSince(null);
    setLiveSession(null);
    if (!data) {
      setTerminalState('idle');
      return;
    }
    // Live mode: only devices the collector can shell into get the WS
    // attempt; the canned demo transport never stands in for a live device.
    const shellWorthy = data.profile ? kind !== 'none' : (data.device?.localShell ?? false);
    if (!shellWorthy) {
      setTerminalState('idle');
      return;
    }
    let live = true;
    setTerminalState('connecting');
    const session = createWsTransport(name, {
      onPrompt: (prompt) => {
        if (live) setLivePrompt(prompt);
      },
      onSession: (identity) => {
        if (live) setLiveSession(identity);
      },
      onDisconnect: () => {
        if (!live) return;
        setLiveTransport(null);
        setTerminalState('disconnected');
        setSessionsRefresh((n) => n + 1);
      },
    });
    void session.connect().then((ok) => {
      if (!live) return;
      if (ok) {
        setLiveTransport(session.transport);
        setTerminalState('live');
        setLiveSince(new Date().toISOString());
        // The bridge opens a recording as it connects — pull it in so the pane
        // can name the account and target the session actually ran under.
        setSessionsRefresh((n) => n + 1);
      } else {
        setTerminalState('disconnected');
      }
    });
    return () => {
      live = false;
      session.close();
    };
  }, [name, data, kind, terminalAttempt]);

  const transport = liveTransport ?? cannedTransport;
  const liveSsh = liveTransport !== null;

  const toggleTranscript = (file: string) => {
    if (expanded?.file === file) {
      transcriptReq.current = null;
      setExpanded(null);
      return;
    }
    transcriptReq.current = file;
    setSessionsError(null);
    void getTerminalSession(file)
      .then((t) => {
        if (t && transcriptReq.current === file) setExpanded(t);
      })
      .catch((err: Error) => {
        if (transcriptReq.current === file) {
          setSessionsError(`Transcript could not be loaded: ${err.message}`);
        }
      });
  };

  // Reboot drawer state lives above the !data early return — hooks must run
  // on every render, or React throws once the async detail resolves.
  const [rebootOpen, setRebootOpen] = useState(false);
  const [rebootTickets, setRebootTickets] = useState<TicketRow[]>([]);
  const [rebootTicket, setRebootTicket] = useState('');
  const [rebooting, setRebooting] = useState(false);

  // Ticket options load when the drawer opens; open tickets first.
  useEffect(() => {
    if (!rebootOpen) return;
    let live = true;
    void getTickets().then((d) => {
      if (!live) return;
      const open = d.tickets.filter((t) => !/resolved|closed/i.test(t.state));
      const rest = d.tickets.filter((t) => /resolved|closed/i.test(t.state));
      const sorted = [...open, ...rest];
      setRebootTickets(sorted);
      setRebootTicket((cur) => cur || (sorted[0]?.id ?? ''));
    });
    return () => {
      live = false;
    };
  }, [rebootOpen]);

  if (!data) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: 96 }}>
        <Spinner size="md" />
      </div>
    );
  }
  if (data.apiError) return <ApiErrorState message={data.apiError} />;

  const { device, profile, config: cfg, clients } = data;
  // Which source this screen is actually rendering (README §"Live/error
  // behavior"): the offline fixture fallback answers `demo` too, so an unknown
  // name means something different in each mode.
  const isDemo = data.dataSource === 'demo' && !(data.blended?.includes('devices') ?? false);
  // The recording THIS pane's session opened, if the store has caught up: the
  // newest transcript that started at (or just before) the moment the bridge
  // went live. Ordering is not part of the API contract, so sort. An older
  // transcript belongs to another operator and is never presented as the
  // current connection — in that case the pane names nobody.
  const currentSession = liveSince
    ? [...sessions]
        .filter((s) => Date.parse(s.openedAt) >= Date.parse(liveSince) - 60_000)
        .sort((a, b) => b.openedAt.localeCompare(a.openedAt))[0]
    : undefined;
  // Who the pane may name as connected: the bridge's own claim first — it
  // arrives with the socket, so it neither lags the session store nor can be
  // another operator's transcript — then the heuristic above. Null when
  // neither knows, and then nobody is named.
  const attributed: { user: string; target: string; via: string | null } | null =
    liveSession ??
    (currentSession ? { user: currentSession.user, target: currentSession.target, via: null } : null);
  // The jump host the bridge reported, when it reported one. A direct dial is
  // still "via collector" — the portal's collector is what opened it.
  const attributedVia = attributed?.via ? `via ${attributed.via}` : 'via collector';

  const saveConfig = () =>
    toast('Config snapshot not available yet', {
      description:
        'No linked plane exposes a config-snapshot API through this portal, and nothing was queued. Use Download config for the running configuration shown here.',
      tone: 'info',
    });

  const confirmReboot = async () => {
    if (!rebootTicket) {
      toast('Pick the ticket that authorises this reboot — writes are brokered, never standing', {
        tone: 'danger',
      });
      return;
    }
    setRebooting(true);
    const res = await rebootDevice(name, rebootTicket);
    setRebooting(false);
    if (!res.ok) {
      toast(res.message, { tone: 'danger' });
      return;
    }
    toast(res.applied ? `Reboot accepted — ${name}` : 'Reboot logged, not sent', {
      description: res.message,
      tone: res.applied ? 'success' : 'warning',
    });
    setRebootOpen(false);
  };

  // Ticket-gated reboot drawer — shared by the full profile view and the
  // live-cache view (a reboot is a real brokered write in both modes).
  const rebootDrawer = (
    <Drawer
      open={rebootOpen}
      onOpenChange={setRebootOpen}
      width="md"
      title={`Reboot ${name}`}
      description="A reboot drops every client on this device. It is a brokered write: ticket-stamped, audit-logged, and only ever claimed when the plane accepts it."
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div style={{ fontSize: 13, color: 'var(--nd-text-secondary)', lineHeight: 1.6 }}>
          Central-managed devices reboot through the troubleshooting API (
          <Code>POST …/reboot</Code>, accepted on HTTP 202). Local switches get an honest
          hand-off to the recorded SSH session instead — the portal never fakes a push.
        </div>
        <FormField
          label="Authorising ticket"
          help="Required. The reboot is recorded against this ticket in the change log."
        >
          <Select
            options={rebootTickets.map((t) => ({ value: t.id, label: `${t.id} · ${t.title}` }))}
            value={rebootTicket}
            onValueChange={setRebootTicket}
            aria-label="Authorising ticket"
          />
        </FormField>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Button
            variant="primary"
            size="sm"
            disabled={rebooting || !rebootTicket}
            onClick={() => void confirmReboot()}
            style={{ background: 'var(--nd-danger)' }}
          >
            {rebooting ? 'Rebooting…' : `Reboot ${name}`}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setRebootOpen(false)}>
            Cancel
          </Button>
        </div>
      </div>
    </Drawer>
  );

  // Reconciliation flag (design rule 2: one row, flagged — never duplicated).
  // Live rows carry every claiming plane in `claimedBy`; the authored fixtures
  // encode the double claim in `state` and carry no claimant list.
  const claimants: Plane[] = device ? (device.claimedBy?.length ? device.claimedBy : [device.plane]) : [];
  const doubleClaimed = claimants.length > 1 || device?.state === 'double-claimed';
  const reconciliationAlert = device?.reconciliationIssue ? (
    <Alert
      tone="warning"
      title={
        doubleClaimed
          ? 'Double-claimed — more than one inventory reports this device'
          : 'In no cloud plane — this row comes from the local collector only'
      }
    >
      <span style={{ fontSize: 13 }}>
        {doubleClaimed
          ? `Claimed by ${
              claimants.length > 1
                ? claimants.join(' + ')
                : `${claimants[0]} and at least one other inventory`
            }. The portal keeps one row and shows the highest-priority claimant, so firmware and state can disagree between the planes.`
          : `No cloud plane reports ${device.name}. It stays a first-class row built from the local collector, which is why its licence and cloud telemetry read '—'.`}
      </span>
    </Alert>
  ) : null;

  // Live mode carries the reconciled inventory row only — the authored
  // profile, config and client sets are demo data and are never substituted.
  if (!profile || !cfg || !clients) {
    if (!device) {
      // Answered 404: the device is not in any linked plane's cache.
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          <div>
            <Button variant="ghost" size="sm" onClick={() => navigate('/devices')}>
              ← Inventory
            </Button>
          </div>
          <EmptyState
            title={isDemo ? 'Device not in the demo inventory' : 'Device not in the live cache'}
            description={
              isDemo
                ? `The portal is running on fixtures and '${name}' is not one of them. Nothing was asked of a plane, so this says nothing about your estate.`
                : `No linked plane has reported '${name}'. It may be unmanaged, or the plane that owns it is not linked.`
            }
          >
            <div style={{ marginTop: 16 }}>
              <Button variant="primary" size="sm" onClick={() => navigate('/systems')}>
                Connected systems
              </Button>
            </div>
          </EmptyState>
        </div>
      );
    }

    const reported = (value: string) =>
      value && value !== '—' && value.toLowerCase() !== 'unknown' ? value : 'Not reported';
    // Header meta is model · site · IP (README §8); the plane's management IP
    // is on the row when the plane publishes one, and is what the recorded-SSH
    // bridge dials, so it is never dropped.
    const liveIdentity =
      [device.model, device.siteName, device.ip ?? '']
        .filter((value) => reported(value) !== 'Not reported')
        .join(' · ') || 'Inventory details partial';
    // Firmware carries a judgement the inventory table already paints amber
    // (Devices.tsx colours an unapproved train) — the detail page has to agree.
    // A plane that reported no firmware string gets no verdict at all.
    const liveFirmware = reported(device.firmware);
    const firmwareKnown = liveFirmware !== 'Not reported';
    const liveFacts: LiveFact[] = [
      { k: 'Model', v: reported(device.model) },
      { k: 'Type', v: reported(device.type) },
      { k: 'Site', v: reported(device.siteName) },
      { k: 'Mgmt IP', v: reported(device.ip ?? '') },
      { k: 'Managed by', v: claimants.join(' + ') },
      { k: 'Identity', v: device.serial ?? device.mac ?? 'name match only' },
      { k: 'State', v: reported(device.state) },
      {
        k: 'Firmware',
        v: !firmwareKnown
          ? liveFirmware
          : device.firmwareApproved
            ? `${liveFirmware} (approved)`
            : `${liveFirmware} — off the approved train`,
        ...(firmwareKnown && !device.firmwareApproved ? { tone: 'var(--nd-warning)' } : {}),
      },
      { k: 'Licence', v: reported(device.licence) },
      { k: 'Local shell', v: device.localShell ? 'yes — via collector' : 'no — cloud-claimed' },
    ];

    // Five Stats (README §9), every one of them a field the poller actually
    // returned — a tile with nothing behind it reads 'Not reported' rather
    // than inventing a number.
    const liveStats: { label: string; value: string; delta: string }[] = [
      { label: 'State', value: reported(device.state), delta: `as ${device.plane} reports it` },
      {
        label: 'Firmware',
        value: liveFirmware,
        delta: !firmwareKnown ? 'no version reported' : device.firmwareApproved ? 'approved train' : 'off approved train',
      },
      {
        label: 'Claimed by',
        value: `${claimants.length} plane${claimants.length === 1 ? '' : 's'}`,
        delta: claimants.join(' + '),
      },
      {
        label: 'Clients now',
        value: clients === null ? 'Not reported' : String(clients.rows.length),
        delta: clients === null ? 'no plane reported sessions' : 'from the poller snapshot',
      },
      {
        label: 'Recorded shells',
        value: sessionsError ? 'Not reported' : String(sessions.length),
        delta: sessionsError
          ? 'session store unreadable'
          : device.localShell
            ? 'transcripts recorded by the portal'
            : 'cloud-claimed — no portal shell',
      },
    ];

    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-end',
            justifyContent: 'space-between',
            gap: 24,
            flexWrap: 'wrap',
          }}
        >
          <div>
            <Heading level={2} overline={`Devices / ${device.name}`}>
              {device.name}
            </Heading>
            <div
              style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8, flexWrap: 'wrap' }}
            >
              <Badge tone={device.stateTone} dot>
                {device.state}
              </Badge>
              {showPlatformTags ? <Badge tone={device.planeTone}>{device.plane}</Badge> : null}
              <span
                style={{
                  fontFamily: 'var(--nd-font-mono)',
                  fontSize: 'var(--nd-text-11)',
                  color: 'var(--nd-text-muted)',
                }}
              >
                {liveIdentity}
              </span>
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Button variant="ghost" size="sm" onClick={() => navigate('/devices')}>
              ← Inventory
            </Button>
            {/* Design rule 4: a plane the portal cannot write to still gets an
                honest console hand-off, never a fake edit form. The local
                collector and third-party gear have no console to hand off to,
                so they get no button rather than a dead one. `Save config`
                stays out of the live branch — no linked plane reports a
                running config here, so there is nothing to save. */}
            {device.plane !== 'LOCAL' && device.plane !== 'THIRD-PARTY' ? (
              <Button
                variant="secondary"
                size="sm"
                onClick={() =>
                  toast(`Open in ${device.plane} — console hand-off queued`, {
                    description: 'Read-only plane: the portal opens its console pre-filled.',
                    tone: 'info',
                  })
                }
              >
                Open in {device.plane}
              </Button>
            ) : null}
            <Button variant="ghost" size="sm" style={{ color: 'var(--nd-danger)' }} onClick={() => setRebootOpen(true)}>
              Reboot
            </Button>
          </div>
        </div>

        {reconciliationAlert}

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(5, minmax(0, 1fr))',
            gap: 18,
          }}
        >
          {liveStats.map((s) => (
            <Stat key={s.label} label={s.label} value={s.value} delta={s.delta} />
          ))}
        </div>

        <Divider variant="flair" />

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'minmax(0, 1.55fr) minmax(0, 1fr)',
            gap: 32,
            alignItems: 'start',
          }}
        >
          {/* ---------------- left column ---------------- */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 }}>
            {liveSsh ? (
              <TerminalPane
                key={device.name}
                transport={transport}
                prompt={livePrompt ?? `${device.name}#`}
                forName={device.name}
                sectionTitle="Local terminal"
                sectionMeta="SESSION RECORDED"
                titlebar={
                  attributed
                    ? `ssh ${attributed.user}@${attributed.target} — ${attributedVia}`
                    : `ssh ${device.name} — via collector`
                }
                titlebarRight="AES-256 · LIVE · recorded"
                online
                /* Chips come from the route when it sent them, else from the
                   inventory row's device class — never the fixture name-prefix
                   rules. Every one of them is inside the server's read-only
                   allow-list. */
                quickCommands={
                  servedQuickCommands ?? terminalQuickCommands(deviceTerminalKind(device, device.name))
                }
              />
            ) : (
              <div>
                <SectionHeader label="Local terminal" />
                <LiveGapNote>
                  {device.localShell && terminalState === 'connecting'
                    ? 'Opening a recorded shell feed through the collector…'
                    : device.localShell
                      ? 'No recorded shell feed right now — the collector bridge is unreachable from this portal.'
                    : 'Cloud-claimed device — no local shell; the owning plane serves read-only telemetry only.'}
                </LiveGapNote>
                {device.localShell && terminalState === 'disconnected' ? (
                  <Button variant="ghost" size="sm" onClick={() => setTerminalAttempt((n) => n + 1)}>
                    Reconnect terminal
                  </Button>
                ) : null}
              </div>
            )}

            {/* Recorded transcripts are fetched for every device — a live
                switch with sessions on file, or a failed load, must show. */}
            {device.localShell || sessions.length > 0 || sessionsError ? (
              <RecordedSessions
                sessions={sessions}
                sessionsError={sessionsError}
                expanded={expanded}
                toggleTranscript={toggleTranscript}
              />
            ) : null}

            <div style={{ paddingTop: 14 }}>
              <SectionHeader label="Configuration" />
              <LiveGapNote>
                Not available in live mode — no linked plane reports a running config for this device.
              </LiveGapNote>
            </div>
          </div>

          {/* ---------------- right column ---------------- */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 26, minWidth: 0 }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              {/* An 'unverified' row is only actionable next to the age of the
                  cache it came from, so the envelope's stamp is rendered. */}
              <SectionHeader
                label="Identity"
                meta={
                  data.syncedAt
                    ? `LIVE POLLER CACHE · ${hhmm(data.syncedAt)}`
                    : 'LIVE POLLER CACHE · NO SYNC STAMP'
                }
              />
              {liveFacts.map((f) => (
                <div
                  key={f.k}
                  style={{
                    display: 'flex',
                    gap: 12,
                    padding: '8px 0',
                    borderBottom: '1px solid var(--nd-border-subtle)',
                  }}
                >
                  <span
                    style={{
                      fontFamily: 'var(--nd-font-mono)',
                      fontSize: 'var(--nd-text-10)',
                      letterSpacing: '.1em',
                      textTransform: 'uppercase',
                      color: 'var(--nd-text-muted)',
                      width: 92,
                      flex: '0 0 92px',
                      paddingTop: 2,
                    }}
                  >
                    {f.k}
                  </span>
                  <span
                    style={{
                      flex: 1,
                      minWidth: 0,
                      fontFamily: 'var(--nd-font-mono)',
                      fontSize: 11.5,
                      color: f.tone ?? 'var(--nd-text-secondary)',
                      overflowWrap: 'anywhere',
                    }}
                  >
                    {f.v}
                  </span>
                </div>
              ))}
            </div>

            {/* The class block (Ports of interest / Cluster members / Radios &
                SSIDs / Services) has no live source yet. README §9 requires the
                section, and every other live gap on this screen declares
                itself rather than vanishing. */}
            <div>
              <SectionHeader label="Ports of interest" />
              <LiveGapNote>
                Not available in live mode — no linked plane reports per-port state for this device.
              </LiveGapNote>
            </div>

            <div>
              <SectionHeader label="Clients on this device" meta={clients?.meta} />
              {clients === null ? (
                <LiveGapNote>Not available in live mode — no linked plane reported client sessions.</LiveGapNote>
              ) : clients.rows.length === 0 ? (
                <LiveGapNote>No active client sessions were attached to this device in the current poller snapshot.</LiveGapNote>
              ) : (
                clients.rows.map((client) => (
                  <div
                    key={`${client.name}-${client.detail}`}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 10,
                      padding: '9px 0',
                      borderBottom: '1px solid var(--nd-border-subtle)',
                    }}
                  >
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 'var(--nd-text-12)', color: 'var(--nd-text-primary)' }}>{client.name}</div>
                      <div
                        style={{
                          fontFamily: 'var(--nd-font-mono)',
                          fontSize: 'var(--nd-text-10)',
                          color: 'var(--nd-text-muted)',
                          overflowWrap: 'anywhere',
                        }}
                      >
                        {client.detail}
                      </div>
                    </div>
                    <Badge tone={client.tone}>{client.state}</Badge>
                  </div>
                ))
              )}
              <div style={{ paddingTop: 10 }}>
                <Button variant="ghost" size="sm" onClick={() => navigate('/clients')}>
                  All clients →
                </Button>
              </div>
            </div>

            {/* The route runs the same evidence predicates /api/compliance
                does and ships this device's own verdicts, so the panel prints
                them rather than pointing at a screen that would recompute
                them. A payload without them says so — it does not imply a
                pass. */}
            <CompliancePanel
              evidence={data.evidence ?? null}
              gapNote="Live inventory evidence only — running-configuration drift remains unavailable."
            >
              <div style={{ paddingTop: 10 }}>
                <Button variant="ghost" size="sm" onClick={() => navigate('/compliance')}>
                  View evidence coverage →
                </Button>
              </div>
            </CompliancePanel>
          </div>
        </div>

        {rebootDrawer}
      </div>
    );
  }

  const canShell = profile.kind !== 'none';
  const historyRows = [...extraHistory, ...cfg.history];

  // The route ships the reconciled inventory row alongside the authored
  // profile, and the row is authoritative for identity — the header has to
  // agree with the Devices table this page was opened from. The profile only
  // fills what a DeviceRow does not carry (the management IP).
  const headerState = device?.state ?? profile.state;
  const headerStateTone = device?.stateTone ?? profile.stateTone;
  const headerPlane = device?.plane ?? profile.plane;
  const headerPlaneTone = device?.planeTone ?? profile.planeTone;
  const headerModel = device?.model ?? profile.model;
  const headerSite = device?.siteName ?? profile.site;
  const headerIp = device?.ip ?? profile.ip;
  // Identity facts stay authored except where the row contradicts them.
  const facts: Fact[] = profile.facts.map((f) => {
    if (!device) return f;
    if (f.k === 'Managed by' && device.plane !== profile.plane) {
      return { k: f.k, v: claimants.join(' + ') };
    }
    if (f.k === 'Firmware' && !f.v.includes(device.firmware)) {
      return { k: f.k, v: `${device.firmware} (${device.firmwareApproved ? 'approved' : 'not approved'})` };
    }
    return f;
  });

  const snapshotNow = () => {
    toast('Recorded locally — not persisted', {
      description: 'Added to the history below as a local row; it is gone on reload.',
      tone: 'info',
    });
    setExtraHistory((xs) => [
      {
        when: 'just now',
        what: 'Config snapshot taken from the portal',
        // Never attribute the action to the fixture operator: name the account
        // the portal's own shell session ran under, or nobody at all.
        who: attributed ? `${attributed.user} · portal snapshot` : 'portal snapshot · local only',
        tag: 'snapshot',
        tone: 'neutral',
      },
      ...xs,
    ]);
  };

  const downloadConfig = () => {
    const blob = new Blob([cfg.running], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${profile.name}-running-config.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-end',
          justifyContent: 'space-between',
          gap: 24,
          flexWrap: 'wrap',
        }}
      >
        <div>
          <Heading level={2} overline={`Devices / ${profile.name}`}>
            {profile.name}
          </Heading>
          <div
            style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8, flexWrap: 'wrap' }}
          >
            <Badge tone={headerStateTone} dot>
              {headerState}
            </Badge>
            {showPlatformTags ? <Badge tone={headerPlaneTone}>{headerPlane}</Badge> : null}
            <span
              style={{
                fontFamily: 'var(--nd-font-mono)',
                fontSize: 'var(--nd-text-11)',
                color: 'var(--nd-text-muted)',
              }}
            >
              {headerModel} · {headerSite} · {headerIp}
            </span>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Button variant="ghost" size="sm" onClick={() => navigate('/devices')}>
            ← Inventory
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() =>
              toast(`${profile.launch} — console hand-off queued`, {
                description: 'Read-only plane: the portal opens its console pre-filled.',
                tone: 'info',
              })
            }
          >
            {profile.launch}
          </Button>
          <Button variant="secondary" size="sm" onClick={saveConfig}>
            Save config
          </Button>
          <Button variant="ghost" size="sm" style={{ color: 'var(--nd-danger)' }} onClick={() => setRebootOpen(true)}>
            Reboot
          </Button>
        </div>
      </div>

      {reconciliationAlert}

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(5, minmax(0, 1fr))',
          gap: 18,
        }}
      >
        {profile.stats.map((s) => (
          <Stat key={s.label} label={s.label} value={s.value} delta={s.delta} deltaTone={s.tone} />
        ))}
      </div>

      <Divider variant="flair" />

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 1.55fr) minmax(0, 1fr)',
          gap: 32,
          alignItems: 'start',
        }}
      >
        {/* ---------------- left column ---------------- */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 }}>
          <TerminalPane
            key={profile.name}
            transport={transport}
            prompt={livePrompt ?? profile.prompt}
            forName={profile.name}
            sectionTitle={canShell ? 'Local terminal' : 'Read-only telemetry'}
            sectionMeta={
              canShell ? (sessions.length > 0 ? `SESSION RECORDED · ${sessions.length} ON FILE` : 'SESSION RECORDED') : 'CLOUD-CLAIMED DEVICE'
            }
            /* The authored `r.okafor@<fixture ip>` line is demo text. Once a
               real recorded session is up the titlebar must name the account
               and address the bridge actually dialled — the banner inside the
               pane already does, and the two must not contradict. */
            titlebar={
              !canShell
                ? `no shell — ${profile.plane} owns this device`
                : !liveSsh
                  ? `ssh r.okafor@${profile.ip} — via collector`
                  : attributed
                    ? `ssh ${attributed.user}@${attributed.target} — ${attributedVia}`
                    : `ssh ${profile.name} — via collector`
            }
            titlebarRight={
              canShell ? (liveSsh ? 'AES-256 · LIVE · recorded' : 'AES-256 · idle 14:52') : 'request remote shell ↗'
            }
            online={liveSsh}
            quickCommands={canShell ? (servedQuickCommands ?? terminalQuickCommands(profile.kind)) : []}
            readOnlyNote={canShell ? undefined : profile.readOnlyNote}
          />
          {canShell && terminalState === 'disconnected' ? (
            <div>
              <Button variant="ghost" size="sm" onClick={() => setTerminalAttempt((n) => n + 1)}>
                Reconnect live terminal
              </Button>
            </div>
          ) : null}

          {canShell ? (
            <RecordedSessions
              sessions={sessions}
              sessionsError={sessionsError}
              expanded={expanded}
              toggleTranscript={toggleTranscript}
            />
          ) : null}

          <div style={{ paddingTop: 14 }}>
            <SectionHeader label="Configuration" meta={cfg.meta} />
          </div>
          <div style={{ alignSelf: 'flex-start' }}>
            <SegmentedControl
              options={CFG_TABS}
              value={cfgTab}
              onValueChange={(v) => setCfgTab(v as CfgTab)}
              ariaLabel="Configuration view"
            />
          </div>

          {cfgTab === 'running' ? <Code block>{cfg.running}</Code> : null}
          {cfgTab === 'diff' ? <DiffCode text={cfg.diff} /> : null}
          {cfgTab === 'history' ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
              {historyRows.map((h, i) => (
                <div
                  key={`${h.when}-${i}`}
                  style={{
                    display: 'flex',
                    gap: 14,
                    padding: '11px 0',
                    borderBottom: '1px solid var(--nd-border-subtle)',
                  }}
                >
                  <span
                    style={{
                      fontFamily: 'var(--nd-font-mono)',
                      fontSize: 10.5,
                      color: 'var(--nd-text-muted)',
                      width: 88,
                      flex: '0 0 88px',
                    }}
                  >
                    {h.when}
                  </span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        fontSize: 'var(--nd-text-12)',
                        color: 'var(--nd-text-primary)',
                        lineHeight: 1.4,
                      }}
                    >
                      {h.what}
                    </div>
                    <div
                      style={{
                        fontFamily: 'var(--nd-font-mono)',
                        fontSize: 'var(--nd-text-10)',
                        color: 'var(--nd-text-muted)',
                      }}
                    >
                      {h.who}
                    </div>
                  </div>
                  <Badge tone={h.tone}>{h.tag}</Badge>
                </div>
              ))}
            </div>
          ) : null}

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', paddingTop: 4 }}>
            <Button variant="secondary" size="sm" onClick={snapshotNow}>
              Snapshot config now
            </Button>
            <Button variant="ghost" size="sm" onClick={() => navigate('/compliance')}>
              Push baseline fix
            </Button>
            <Button variant="ghost" size="sm" onClick={downloadConfig}>
              Download config
            </Button>
          </div>
        </div>

        {/* ---------------- right column ---------------- */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 26, minWidth: 0 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <SectionHeader label="Identity" />
            {facts.map((f) => (
              <div
                key={f.k}
                style={{
                  display: 'flex',
                  gap: 12,
                  padding: '8px 0',
                  borderBottom: '1px solid var(--nd-border-subtle)',
                }}
              >
                <span
                  style={{
                    fontFamily: 'var(--nd-font-mono)',
                    fontSize: 'var(--nd-text-10)',
                    letterSpacing: '.1em',
                    textTransform: 'uppercase',
                    color: 'var(--nd-text-muted)',
                    width: 92,
                    flex: '0 0 92px',
                    paddingTop: 2,
                  }}
                >
                  {f.k}
                </span>
                <span
                  style={{
                    flex: 1,
                    minWidth: 0,
                    fontFamily: 'var(--nd-font-mono)',
                    fontSize: 11.5,
                    color: 'var(--nd-text-secondary)',
                    overflowWrap: 'anywhere',
                  }}
                >
                  {f.v}
                </span>
              </div>
            ))}
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <SectionHeader label={profile.listTitle} meta={profile.listMeta} />
            {profile.ports.map((p) => (
              <div
                key={p.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  padding: '8px 0',
                  borderBottom: '1px solid var(--nd-border-subtle)',
                }}
              >
                <span
                  style={{
                    fontFamily: 'var(--nd-font-mono)',
                    fontSize: 'var(--nd-text-11)',
                    color: 'var(--nd-text-primary)',
                    width: 74,
                    flex: '0 0 74px',
                  }}
                >
                  {p.id}
                </span>
                <span
                  style={{
                    flex: 1,
                    minWidth: 0,
                    fontSize: 'var(--nd-text-12)',
                    color: 'var(--nd-text-secondary)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {p.what}
                </span>
                <Badge tone={p.tone}>{p.state}</Badge>
              </div>
            ))}
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <SectionHeader label="Clients on this device" meta={clients.meta} />
            {clients.rows.map((c) => (
              <div
                key={c.name}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  padding: '9px 0',
                  borderBottom: '1px solid var(--nd-border-subtle)',
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      fontSize: 'var(--nd-text-12)',
                      color: 'var(--nd-text-primary)',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {c.name}
                  </div>
                  <div
                    style={{
                      fontFamily: 'var(--nd-font-mono)',
                      fontSize: 'var(--nd-text-10)',
                      color: 'var(--nd-text-muted)',
                    }}
                  >
                    {c.detail}
                  </div>
                </div>
                <Badge tone={c.tone}>{c.state}</Badge>
              </div>
            ))}
            <div style={{ paddingTop: 10 }}>
              <Button variant="ghost" size="sm" onClick={() => navigate('/clients')}>
                All clients →
              </Button>
            </div>
          </div>

          {/* Same panel, same contract: the demo route sends the authored
              checks as `evidence` too, so the served block wins and the
              profile is only the fallback for a payload (or an older route)
              that carried none. */}
          <CompliancePanel evidence={data.evidence ?? { checks: profile.checks, mode: 'demo' }}>
            <div>
              <Button variant="ghost" size="sm" onClick={() => navigate('/compliance')}>
                Full compliance report
              </Button>
            </div>
          </CompliancePanel>
        </div>
      </div>

      {/* ---------------- ticket-gated reboot ---------------- */}
      {rebootDrawer}
    </div>
  );
}
