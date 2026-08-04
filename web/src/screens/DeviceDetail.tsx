/**
 * web/src/screens/DeviceDetail.tsx — terminal, configuration, clients and
 * compliance for one device. High-fidelity port of design/NtDeviceDetail.dc.html:
 * header (Heading = device name, state + plane Badges, mono model · site · IP,
 * actions ← Inventory / Open in <plane> / Save config / Reboot), five
 * class-specific Stats, then flair → a wide main column and a narrow
 * identity rail (1fr / 260–320px). Compliance renders the route's served
 * per-device evidence block in BOTH modes (the authored profile.checks are
 * only the fallback for a payload that carried none), and an `unavailable` or
 * empty block renders a named empty state rather than a clean scorecard.
 *
 * The telemetry — the class block, diagnostics and the client list — lives in
 * the MAIN column and the identity key/values in the rail, not the other way
 * round. Reversed, a switch put sixteen ports in a 434px column where every
 * row wrapped to three lines and the page ran to 2,900px, while the wide
 * column beside it held two one-sentence "not available" notes and 2,700px of
 * nothing. The shell and running-config notes sit below the telemetry for the
 * same reason: on a cloud-claimed device they are both empty, and an empty
 * note is not what the page should open with.
 *
 * Main column: the class block, Active diagnostics, Clients on this device
 * (multi-select **Export selected** / **Copy MACs** / Clear — Loop 180;
 * header `KeyboardShortcuts` surfaces the ports/clients grid map — Loop 199;
 * ports selection-empty `?ports=` offers **Clear selection filter** — Loop 207),
 * then the Local terminal (web/src/lib/TerminalPane —
 * shell-capable devices first try the recorded-SSH WebSocket transport from
 * web/src/lib/wsTerminal.ts, falling back to the canned demo transport when
 * the bridge is unreachable; cloud-claimed devices get read-only telemetry,
 * no input/chips; the banner and the quick-command chips come from the
 * envelope's `terminal` block when the route sent one, and from the shared
 * helpers otherwise; the titlebar names the session from the bridge's own
 * 'ready' frame — user, dialled target and jump host — falling back to the
 * recorded-transcript match only for a bridge that names none)
 * and Configuration (the Running | Drift vs. baseline | History tabs —
 * deviceDetail/panels.tsx ConfigTabs; drift rendered via DiffCode with
 * danger/success line colouring; Snapshot stores a local history row, Download
 * saves the running config as a file). The route joins the config-backup
 * store into `config` in every mode: snapshots on file for the device replace
 * the authored fixture block (demo) or the honest null (live), and the block
 * carries a `provenance` caption naming the collection channel so a real
 * snapshot is never mistaken for the fixture config. Rail: Identity facts and
 * Compliance.
 * The class block (Ports of interest / Cluster members / Radios & SSIDs /
 * Tunnels / Services) is chosen by the device CLASS, not hardcoded:
 * an AP renders Radios + SSIDs broadcast (Central /aps/{serial}/radios and
 * /wlans), a switch renders Ports of interest (/switches/{serial}/interfaces),
 * and a class the route served no subresource for renders no panel at all
 * rather than a ports panel an access point can only ever answer '—' to. Those
 * panels read the envelope's on-demand `detail` block — a per-object read made
 * for the ONE device being viewed, never on the 60s poll — and each of the four
 * read outcomes (ok / empty / failed / not fetched) prints its own sentence, so
 * "we have not asked yet" is never dressed up as "the plane does not report it".
 * Data: getDeviceDetail(name) — live /api/devices/:name when the server is up,
 * the shared deviceProfile() fixtures otherwise. The route ships the reconciled
 * inventory row alongside the authored profile, and that row is authoritative
 * for identity in both modes, so the header can never contradict the Devices
 * table it was opened from; a row the reconciler flagged carries a warning
 * Alert naming its claiming planes. Live mode carries only the
 * reconciled inventory row: the authored profile/clients are demo
 * data, so the live view renders the real row (header + console hand-off,
 * five Stats derived only from fields the poller returned, Identity stamped
 * with the envelope's syncedAt and carrying the firmware-vs-approved
 * verdict), its recorded shell sessions, plus honest "not available in
 * live mode" sections — the Configuration one only while no config-backup
 * snapshots are on file, since those render the same three tabs here (a live
 * 404 renders an EmptyState, never fixtures; an
 * OFFLINE 404 says the portal is on fixtures rather than blaming a plane).
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  PageSkeleton,
  Alert,
  Badge,
  Button,
  Code,
  DATATABLE_ROW_SHORTCUTS,
  Divider,
  Drawer,
  EmptyState,
  FormField,
  Heading,
  KeyboardShortcuts,
  SectionHeader,
  Select, Stat,
  DataTable,
  useToast,
  type DataTableColumn,
} from '../nightdesk';
import { getDeviceDetail, getTerminalSession, getTerminalSessions, getTickets, rebootDevice } from '../api/client';
import type { TerminalSession, TerminalSessionEvent } from '../api/client';
import type { DeviceDetailData } from '../api/client';
import { deviceTerminalKind, hhmmLocal as hhmm, terminalQuickCommands, countOf } from '@hpe/shared';
import type {
  CfgHistoryRow,
  DevicePortRow,
  Fact,
  Plane,
  TicketRow,
} from '@hpe/shared';

const profilePortColumns: Array<DataTableColumn<DevicePortRow>> = [
  {
    key: 'port',
    title: 'Port',
    hideable: false,
    render: (p) => <span className="nt-cell-mono nt-cell-nowrap">{p.id}</span>,
  },
  {
    key: 'what',
    title: 'What',
    render: (p) => (
      <>
        {p.what}
        {/* Authored counters ride the same contract as the live
            AOS-CX read (DevicePort.counters): a row with a block
            says it in one mono line, a row without one (psu2 is
            not an interface) gets no line — never an invented 0. */}
        {p.counters ? (
          <div className="nt-hint-muted nt-pt-2">{portCountersText(p.counters)}</div>
        ) : null}
      </>
    ),
  },
  {
    key: 'state',
    title: 'State',
    render: (p) => <Badge tone={p.tone}>{p.state}</Badge>,
  },
];
import { useSettings } from '../app/SettingsContext';
import { useIncident } from '../app/IncidentContext';
import { deviceDetailPath, namesFilterForParam } from '../app/nav';
import { TerminalPane, createCannedTransport } from '../lib/TerminalPane';
import { createWsTransport } from '../lib/wsTerminal';
import type { AsyncTerminalTransport, TerminalSessionIdentity } from '../lib/wsTerminal';
import { DiagnosticsPanel } from '../components/DiagnosticsPanel';
import { VisualReferencePanel } from '../components/VisualReferencePanel';
import { ConfigActionPanel } from '../components/ConfigActionPanel';
import { ConfigRecommendationsPanel } from '../components/ConfigRecommendationsPanel';
import { DeviceTypeBadge } from '../components/DeviceTypeBadge';
import { exportTableCsv } from '../lib/csv';
import { downloadApiCsv } from '../lib/downloadApiCsv';
import { ApiErrorState } from './ApiErrorState';
import { RecordedSessions } from './deviceDetail/RecordedSessions';
import {
  CfgTab,
  DEVICE_SUMMARY_HEADERS,
  deviceSummaryCsvRow,
  parseCfgTab,
  portCountersText,
  sectionsToRender,
  servedDeviceDetail,
} from './deviceDetail/facts';
import {
  CompliancePanel,
  ConfigTabs,
  PortsPanel,
  RadiosPanel,
  WlansPanel,
} from './deviceDetail/panels';
import { MistApPanel } from './deviceDetail/mistAp';
import { HardwareTrendsPanel } from './deviceDetail/trends';
import {
  ClientTable,
  LiveFact,
  LiveGapNote,
} from './deviceDetail/tables';




























export default function DeviceDetail() {
  const { name = '' } = useParams();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  // The plane+serial the row that linked here carried (Devices.tsx,
  // SiteDetail's device table) — the exact identity that survives
  // reconciliation when two rows share this display name. Absent for legacy
  // name-only links (search hits, other screens' name-only fields); the
  // server still resolves those, honestly, only while the name stays unique.
  const linkPlane = searchParams.get('plane') ?? undefined;
  const linkSerial = searchParams.get('serial') ?? undefined;
  const routeIdentity = `${name}\u0000${linkPlane ?? ''}\u0000${linkSerial ?? ''}`;
  const { showPlatformTags } = useSettings();
  const { patchIncident } = useIncident();
  const { toast } = useToast();
  const [data, setData] = useState<DeviceDetailData | null>(null);
  /* Configuration tabs share via `?tab=running|diff|history` (default running
     omits the param so plane/serial links stay short). */
  const [cfgTab, setCfgTab] = useState<CfgTab>(() => parseCfgTab(searchParams.get('tab')));
  /* Profile ports multi-select (demo class block) — Loop 187. */
  const [selectedPortKeys, setSelectedPortKeys] = useState<string[]>([]);
  const [extraHistory, setExtraHistory] = useState<CfgHistoryRow[]>([]);

  useEffect(() => {
    let live = true;
    void getDeviceDetail(name, { plane: linkPlane, serial: linkSerial }).then((d) => {
      if (live) setData(d);
    });
    return () => {
      live = false;
    };
  }, [name, linkPlane, linkSerial]);

  /* Keep `?tab=` aligned with the Configuration segmented control so
     Copy view link / refresh open the same running | drift | history pane. */
  useEffect(() => {
    const next = new URLSearchParams(searchParams);
    if (cfgTab === 'running') next.delete('tab');
    else next.set('tab', cfgTab);
    if (next.toString() === searchParams.toString()) return;
    setSearchParams(next, { replace: true });
  }, [cfgTab, searchParams, setSearchParams]);

  useEffect(() => {
    if (!name) return;
    patchIncident({
      deviceName: name,
      devicePlane: linkPlane,
      sourcePath: deviceDetailPath({ name, plane: linkPlane, serial: linkSerial }),
    });
  }, [name, linkPlane, linkSerial, patchIncident]);

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
  /* A new device (or a refresh of the recordings list) closes the expanded
     transcript and clears the list during render — an effect would commit one
     frame of the previous device's recordings under the new name first. */
  const sessionsKey = `${routeIdentity} ${sessionsRefresh}`;
  const [prevSessionsKey, setPrevSessionsKey] = useState(sessionsKey);
  if (prevSessionsKey !== sessionsKey) {
    setPrevSessionsKey(sessionsKey);
    setExpanded(null);
    setSessions([]);
    setSessionsError(null);
  }
  useEffect(() => {
    let live = true;
    transcriptReq.current = null;
    void getTerminalSessions(name, { plane: linkPlane, serial: linkSerial })
      .then((s) => {
        if (live) setSessions(s);
      })
      .catch((err: Error) => {
        if (live) setSessionsError(`Recorded sessions could not be loaded: ${err.message}`);
      });
    return () => {
      live = false;
    };
  }, [name, sessionsRefresh, linkPlane, linkSerial]);

  // Shell-capable devices get a shot at the real recorded-SSH bridge
  // (web/src/lib/wsTerminal.ts → /api/terminal/:name?plane=&serial=). On any failure the
  // canned transport below renders exactly as before — the fallback is the
  // demo path, untouched.
  // Live mode: only devices the collector can shell into get the WS
  // attempt; the canned demo transport never stands in for a live device.
  const shellWorthy = data ? (data.profile ? kind !== 'none' : (data.device?.localShell ?? false)) : false;
  /* A new device, a retry, or the detail read arriving (a shell-worthy device
     becoming known) restarts the pane's session state during render — an
     effect would commit one frame of the old session against the new attempt
     first. The socket itself opens in the effect below. */
  const terminalKey = `${routeIdentity} ${terminalAttempt} ${shellWorthy}`;
  const [prevTerminalKey, setPrevTerminalKey] = useState(terminalKey);
  if (prevTerminalKey !== terminalKey) {
    setPrevTerminalKey(terminalKey);
    setLiveTransport(null);
    setLivePrompt(null);
    setLiveSince(null);
    setLiveSession(null);
    setTerminalState(shellWorthy ? 'connecting' : 'idle');
  }
  useEffect(() => {
    if (!data) return;
    const worthy = data.profile ? kind !== 'none' : (data.device?.localShell ?? false);
    if (!worthy) return;
    let live = true;
    const session = createWsTransport(
      data.device?.name ?? name,
      data.device?.serial ? { plane: data.device.plane, serial: data.device.serial } : {},
      {
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
      },
    );
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
    void getTerminalSession(file, name, { plane: linkPlane, serial: linkSerial })
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
  const actionGeneration = useRef(0);

  /* Navigating device-to-device keeps this screen mounted. Everything that
     describes the previous device — the detail payload, the config tab and its
     locally-snapshotted history rows, the reboot drawer — is dropped during
     render, so none of it can commit under the new device's name; the reads
     that repopulate it stay in the effects above and below. */
  const [prevRouteIdentity, setPrevRouteIdentity] = useState(routeIdentity);
  if (prevRouteIdentity !== routeIdentity) {
    setPrevRouteIdentity(routeIdentity);
    setData(null);
    setCfgTab(parseCfgTab(searchParams.get('tab')));
    setExtraHistory([]);
    setRebootOpen(false);
    setRebootTickets([]);
    setRebootTicket('');
    setRebooting(false);
  }
  useEffect(() => {
    actionGeneration.current += 1;
  }, [routeIdentity]);

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
    return <PageSkeleton variant="detail" />;
  }
  if (data.apiError) return <ApiErrorState message={data.apiError} />;

  const { device, profile, config: cfg, clients } = data;
  // Which source this screen is actually rendering (README §"Live/error
  // behavior"): the offline fixture fallback answers `demo` too, so an unknown
  // name means something different in each mode.
  const isDemo = data.dataSource === 'demo' && !(data.blended?.includes('devices') ?? false);
  /* LIVE badge on pure live and devices blend alike — demo stays quiet (Loop 171). */
  const sectionLive = !isDemo;
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
    if (!device) {
      toast('Device identity is no longer available — reload the device before rebooting', {
        tone: 'danger',
      });
      return;
    }
    const generation = actionGeneration.current;
    setRebooting(true);
    const res = await rebootDevice(
      device.name,
      rebootTicket,
      device.serial ? { plane: device.plane, serial: device.serial } : {},
    );
    if (generation !== actionGeneration.current) return;
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
      className="nd-drawer--write-ritual nt-write-ritual"
      title={`Reboot ${name}`}
      description="A reboot drops every client on this device. It is a brokered write: ticket-stamped, audit-logged, and only ever claimed when the plane accepts it."
    >
      <div className="nt-drawer-stack">
        <div className="nt-write-ritual nt-write-ritual--banner" aria-hidden />
        <div className="nt-body-sec">
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
        <div className="nt-row nt-gap-10">
          <Button
            variant="primary"
            size="sm"
            disabled={rebooting || !rebootTicket}
            onClick={() => void confirmReboot()}
            className="nt-dot nt-dot--danger nt-dot-danger"
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
      <span className="nt-body-sm">
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
        <div className="nt-stack">
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
            <div className="nt-mt-16">
              <Button variant="primary" size="sm" onClick={() => navigate('/systems')}>
                Connected systems
              </Button>
            </div>
          </EmptyState>
        </div>
      );
    }

    // Per-object detail for THIS device, when the route read it. Absent is the
    // normal state until the read lands (and after a failed one), and every
    // class block below renders its own honest sentence for that.
    const liveDetail = servedDeviceDetail(data);
    // The Mist AP rich-stats row (poll dataset) outranks the generic class
    // panels for radios and ports: it carries the SAME radios/uplink with the
    // fuller airtime split, plus CPU/mem/env/power the lazy read cannot map.
    // Rendering both would list every radio twice.
    const mistAp = data.mistAp ?? null;
    // Who to name in a gap sentence: the plane the read was issued against
    // when the payload says, else the plane that claims the row.
    const detailPlane = (liveDetail?.source.plane ?? device.plane).toString().toUpperCase();
    const liveSections = sectionsToRender(device.type, liveDetail).filter(
      (section) => mistAp === null || (section !== 'radios' && section !== 'ports'),
    );

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
      // The plane's claim/activation code, when it published one. It is a
      // claim secret and rides only here — an operator reading this page
      // already holds device-read access; it never goes to logs or lists.
      ...(device.claimCode ? [{ k: 'Claim code', v: device.claimCode }] : []),
      { k: 'State', v: reported(device.state) },
      {
        k: 'Firmware',
        v: !firmwareKnown
          ? liveFirmware
          : device.firmwareApproved
            ? `${liveFirmware} (approved)`
            : `${liveFirmware} — off the approved train`,
        ...(firmwareKnown && !device.firmwareApproved ? { tone: 'warning' } : {}),
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
        value: `${countOf(claimants.length, 'plane')}`,
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
      <div className="nt-stack nt-device-detail-shell nt-section-panel nt-recon-reveal">
        <div
          className="nt-hero-split nt-device-hero nt-panel-glass"
        >
          <div>
            <Heading level={2} overline={`Devices / ${device.name}`}>
              {device.name}
            </Heading>
            <div
              className="nt-wrap-10-mt8 nt-device-hero__meta"
            >
              <Badge tone={device.stateTone} dot>
                {device.state}
              </Badge>
              <DeviceTypeBadge type={device.type} model={device.model} name={device.name} showFamily showRole />
              {showPlatformTags ? <Badge plane>{device.plane}</Badge> : null}
              <span
                className="nt-hint-muted"
              >
                {liveIdentity}
              </span>
            </div>
          </div>
          <div className="nt-row nt-gap-8">
            <span className="nt-systems-brand nt-screen-kicker" aria-hidden>
              NightDesk · device
            </span>
            {sectionLive ? <Badge tone="info">LIVE</Badge> : null}
            <Button variant="ghost" size="sm" onClick={() => navigate('/devices')}>
              ← Inventory
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                void (async () => {
                  const url = `${window.location.origin}${window.location.pathname}${window.location.search}`;
                  try {
                    await navigator.clipboard.writeText(url);
                    toast('View link copied', {
                      description: window.location.search || device.name,
                      tone: 'success',
                    });
                  } catch {
                    toast('Could not copy link', { description: url, tone: 'warning' });
                  }
                })();
              }}
            >
              Copy view link
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                const n = exportTableCsv(
                  `device-summary-${device.name}.csv`,
                  [...DEVICE_SUMMARY_HEADERS],
                  [
                    deviceSummaryCsvRow({
                      name: device.name,
                      type: device.type,
                      model: device.model,
                      siteName: device.siteName,
                      plane: device.plane,
                      state: device.state,
                      firmware: device.firmware,
                      firmwareApproved: device.firmwareApproved,
                      serial: device.serial,
                      mac: device.mac,
                      ip: device.ip,
                      licence: device.licence,
                      localShell: device.localShell,
                      claimants,
                      claimCode: device.claimCode,
                    }),
                  ],
                );
                toast(`Exported ${n} device summary`, {
                  description: 'Inventory fields only — claim codes and config bodies omitted.',
                  tone: 'success',
                });
              }}
            >
              Export summary
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
            <Button variant="ghost" size="sm" className="nt-btn-danger-ghost" onClick={() => setRebootOpen(true)}>
              Reboot
            </Button>
            {/* Ports / clients tables are keyboard grids — surface the map (Loop 199). */}
            <KeyboardShortcuts entries={DATATABLE_ROW_SHORTCUTS} />
          </div>
        </div>
        <div className="nt-plane-theater" role="note">NightDesk · device cinema · facts · trends · plane ECG</div>
        <nav className="nt-incident-spine" aria-label="Incident spine">
          <span className="nt-incident-spine__step">Alert</span>
          <span className="nt-incident-spine__chev" aria-hidden>→</span>
          <span className="nt-incident-spine__step" data-active="true">Device</span>
          <span className="nt-incident-spine__chev" aria-hidden>→</span>
          <span className="nt-incident-spine__step">Ticket</span>
        </nav>

        {reconciliationAlert}

        <div className="nt-stat-grid">
          {liveStats.map((s) => (
            <Stat key={s.label} label={s.label} value={s.value} delta={s.delta} />
          ))}
        </div>

        <Divider variant="flair" />

        <div className="nt-device-layout">
          {/* ---------------- main column ---------------- */}
          <div className="nt-device-layout__main">
            {/* The Mist AP health/RF panel leads the telemetry when the
                payload carried the stats row — it is the fuller RF story, so
                the generic radios/ports panels below stay away for it. */}
            {mistAp !== null ? <MistApPanel row={mistAp} /> : null}
            {/* The class block, chosen by the device's CLASS rather than
                hardcoded: an AP gets Radios + SSIDs, a switch gets Ports, and
                a class Central serves no subresource for gets whatever the
                route actually read — nothing, rather than a ports panel that
                would blame a plane for a field the device does not have. */}
            {liveSections.map((section) =>
              section === 'radios' ? (
                <RadiosPanel key={section} detail={liveDetail} plane={detailPlane} />
              ) : section === 'wlans' ? (
                <WlansPanel key={section} detail={liveDetail} plane={detailPlane} />
              ) : (
                <PortsPanel
                  key={section}
                  detail={liveDetail}
                  plane={detailPlane}
                  deviceName={device.name}
                  devicePlane={device.plane}
                  deviceSerial={device.serial}
                />
              ),
            )}

            {/* Central's per-device telemetry, fetched on demand for the one
                device being viewed — mounted only when a claiming plane can
                answer for the class (a switch's gauges/counters, an AP's
                cpu/mem/throughput), so a LOCAL- or Mist-only row never grows
                a panel that can only ever say 'not reported'. */}
            {(device.type === 'switch' || device.type === 'ap') && claimants.includes('CENTRAL') ? (
              <HardwareTrendsPanel
                name={device.name}
                type={device.type}
                identity={{ plane: device.plane, serial: device.serial }}
              />
            ) : null}

            <div>
              <SectionHeader label="Active diagnostics" meta="NEW CENTRAL · REVIEWED" />
              <DiagnosticsPanel deviceName={device.name} plane={device.plane} serial={device.serial ?? null} />
            </div>

            <VisualReferencePanel
              target={{
                kind: 'device',
                id: device.serial ?? device.name,
                plane: device.plane,
              }}
            />
            <ConfigActionPanel
              plane={device.plane}
              targetKind="device"
              target={{
                kind: 'device',
                id: device.serial ?? device.name,
                plane: device.plane,
              }}
            />
            <ConfigRecommendationsPanel device={device.name} site={device.siteName} />

            <div className="nt-stack nt-gap-2">
              <SectionHeader label="Clients on this device" meta={clients?.meta} />
              {clients === null ? (
                <LiveGapNote>Not available in live mode — no linked plane reported client sessions.</LiveGapNote>
              ) : clients.rows.length === 0 ? (
                <LiveGapNote>No active client sessions were attached to this device in the current poller snapshot.</LiveGapNote>
              ) : (
                <>
                  <div className="nt-wrap-8">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        const n = exportTableCsv(
                          `device-clients-${device.name}.csv`,
                          ['client', 'model', 'mac', 'ip', 'where', 'state', 'detail'],
                          clients.rows.map((c) => [
                            c.name,
                            c.model ?? '',
                            c.mac ?? '',
                            c.ip ?? '',
                            c.where ?? '',
                            c.state,
                            c.detail,
                          ]),
                        );
                        toast(`Exported ${n} client row${n === 1 ? '' : 's'}`, {
                          description: 'Clients currently attached to this device.',
                        });
                      }}
                    >
                      Export clients
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        void (async () => {
                          const qs = new URLSearchParams();
                          if (device.plane) qs.set('plane', String(device.plane));
                          if (device.serial) qs.set('serial', String(device.serial));
                          const suffix = qs.toString() ? `?${qs}` : '';
                          const res = await downloadApiCsv(
                            `/api/devices/${encodeURIComponent(device.name)}/clients/export${suffix}`,
                            `device-clients-${device.name}.csv`,
                          );
                          if (res.ok) {
                            toast('Server CSV downloaded', {
                              description: 'Attached sessions from the portal inventory.',
                              tone: 'success',
                            });
                          } else {
                            toast('Server CSV failed', {
                              description: res.error ?? 'Could not download clients export',
                              tone: 'warning',
                            });
                          }
                        })();
                      }}
                    >
                      Download server CSV
                    </Button>
                  </div>
                  <ClientTable rows={clients.rows} exportName={`device-clients-${device.name}`} />
                </>
              )}
              <div className="nt-pt-10">
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

            {/* The shell and the running config are the two things a
                cloud-claimed device cannot offer, so they sit under the
                telemetry rather than in front of it. */}
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
                deviceName={device.name}
              />
            ) : null}

            <div className="nt-pt-14">
              <SectionHeader label="Configuration" meta={cfg?.meta} />
              {/* The route joins the config-backup store into `config`: real
                  snapshots on file for this device render the same three tabs
                  the authored view uses, with their provenance named. Nothing
                  on file keeps the honest gap note. */}
              {cfg ? (
                <ConfigTabs cfg={cfg} cfgTab={cfgTab} onTabChange={setCfgTab} historyRows={cfg.history} />
              ) : (
                <LiveGapNote>
                  Not available in live mode — no linked plane reports a running config for this device.
                </LiveGapNote>
              )}
            </div>
          </div>

          {/* ---------------- identity rail ---------------- */}
          <div className="nt-device-layout__rail">
            <div className="nt-stack nt-gap-2">
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
                <div key={f.k} className="nt-fact-row nt-device-fact">
                  <span className="nt-fact-row__k nt-device-fact__label">{f.k}</span>
                  <span className="nt-fact-row__v nt-device-fact__value" data-tone={f.tone || undefined}>
                    {f.v}
                  </span>
                </div>
              ))}
            </div>

            <CompliancePanel
              evidence={data.evidence ?? null}
              gapNote="Live inventory evidence only — running-configuration drift remains unavailable."
            >
              <div className="nt-pt-10">
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
  // The plane's claim/activation code, when the row carries one — a claim
  // secret shown only on the device page itself (operator already holds
  // device-read access), never in a list or a log.
  if (device?.claimCode) facts.push({ k: 'Claim code', v: device.claimCode });

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
    <div className="nt-stack">
      <div
        className="nt-hero-split nt-device-hero"
      >
        <div>
          <Heading level={2} overline={`Devices / ${profile.name}`}>
            {profile.name}
          </Heading>
          <div
            className="nt-wrap-10-mt8 nt-device-hero__meta"
          >
            <Badge tone={headerStateTone} dot>
              {headerState}
            </Badge>
            {showPlatformTags ? <Badge plane>{headerPlane}</Badge> : null}
            <span
              className="nt-hint-muted"
            >
              {headerModel} · {headerSite} · {headerIp}
            </span>
          </div>
        </div>
        <div className="nt-row nt-gap-8">
          <span className="nt-systems-brand nt-screen-kicker" aria-hidden>
            NightDesk · device
          </span>
          {sectionLive ? <Badge tone="info">LIVE</Badge> : null}
          <Button variant="ghost" size="sm" onClick={() => navigate('/devices')}>
            ← Inventory
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              void (async () => {
                const url = `${window.location.origin}${window.location.pathname}${window.location.search}`;
                try {
                  await navigator.clipboard.writeText(url);
                  toast('View link copied', {
                    description: window.location.search || profile.name,
                    tone: 'success',
                  });
                } catch {
                  toast('Could not copy link', { description: url, tone: 'warning' });
                }
              })();
            }}
          >
            Copy view link
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              const n = exportTableCsv(
                `device-summary-${profile.name}.csv`,
                [...DEVICE_SUMMARY_HEADERS],
                [
                  deviceSummaryCsvRow({
                    name: device?.name ?? profile.name,
                    type: device?.type,
                    model: headerModel,
                    siteName: headerSite,
                    plane: headerPlane,
                    state: headerState,
                    firmware: device?.firmware,
                    firmwareApproved: device?.firmwareApproved,
                    serial: device?.serial,
                    mac: device?.mac,
                    ip: headerIp,
                    licence: device?.licence,
                    localShell: device?.localShell,
                    claimants,
                    claimCode: device?.claimCode,
                  }),
                ],
              );
              toast(`Exported ${n} device summary`, {
                description: 'Inventory fields only — claim codes and config bodies omitted.',
                tone: 'success',
              });
            }}
          >
            Export summary
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
          <Button variant="ghost" size="sm" className="nt-btn-danger-ghost" onClick={() => setRebootOpen(true)}>
            Reboot
          </Button>
          {/* Ports / clients tables are keyboard grids — surface the map (Loop 199). */}
          <KeyboardShortcuts entries={DATATABLE_ROW_SHORTCUTS} />
        </div>
      </div>

      {reconciliationAlert}

      <div className="nt-stat-grid">
        {profile.stats.map((s) => (
          <Stat key={s.label} label={s.label} value={s.value} delta={s.delta} deltaTone={s.tone} />
        ))}
      </div>

      <Divider variant="flair" />

      <div className="nt-device-layout">
        {/* ---------------- main column ---------------- */}
        <div className="nt-device-layout__main">
          {/* A Mist AP's live health/RF row leads the telemetry, ahead of the
              authored class list — the same panel the live branch renders. */}
          {data.mistAp ? <MistApPanel row={data.mistAp} /> : null}
          <div className="nt-stack nt-gap-2">
            <SectionHeader label={profile.listTitle} meta={profile.listMeta} />
            {profile.ports.length > 0 ? (
              <div className="nt-filter-bar nt-gap-8">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    const n = exportTableCsv(
                      `device-ports-${device?.name ?? 'export'}.csv`,
                      ['port', 'what', 'state'],
                      profile.ports.map((p) => [p.id, p.what, p.state]),
                    );
                    toast(`Exported ${n} port row${n === 1 ? '' : 's'}`, {
                      description: 'Current ports table on this device.',
                    });
                  }}
                >
                  Export ports
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    void (async () => {
                      const devName = device?.name ?? profile.name;
                      const qs = new URLSearchParams();
                      if (device?.plane) qs.set('plane', String(device.plane));
                      if (device?.serial) qs.set('serial', String(device.serial));
                      const suffix = qs.toString() ? `?${qs}` : '';
                      const res = await downloadApiCsv(
                        `/api/devices/${encodeURIComponent(devName)}/ports/export${suffix}`,
                        `device-ports-${devName}.csv`,
                      );
                      if (res.ok) {
                        toast('Server CSV downloaded', {
                          description: 'Port/interface rows from the portal inventory.',
                          tone: 'success',
                        });
                      } else {
                        toast('Server CSV failed', {
                          description: res.error ?? 'Could not download ports export',
                          tone: 'warning',
                        });
                      }
                    })();
                  }}
                >
                  Download server CSV
                </Button>
              </div>
            ) : null}
            {(() => {
              const portsFilter = namesFilterForParam(searchParams.get('ports'));
              const portsFilterLc =
                portsFilter === null
                  ? null
                  : portsFilter.map((p) => p.trim().toLowerCase()).filter(Boolean);
              const portRows =
                portsFilterLc === null
                  ? profile.ports
                  : profile.ports.filter((p) =>
                      portsFilterLc.includes((p.id ?? '').trim().toLowerCase()),
                    );
              const portsPresent =
                portsFilterLc === null
                  ? 0
                  : portsFilterLc.filter((name) =>
                      profile.ports.some((p) => (p.id ?? '').trim().toLowerCase() === name),
                    ).length;
              return (
                <>
                  {portsFilterLc !== null ? (
                    <div className="nt-chip-row" role="group" aria-label="Selection deep link">
                      <button
                        type="button"
                        onClick={() => {
                          const next = new URLSearchParams(searchParams);
                          next.delete('ports');
                          setSearchParams(next, { replace: true });
                          setSelectedPortKeys([]);
                        }}
                        title={portsFilter?.join(', ')}
                        className="nt-chip nt-chip--active"
                      >
                        {portsPresent === portsFilterLc.length
                          ? `${portsFilterLc.length} selected port${portsFilterLc.length === 1 ? '' : 's'}`
                          : `${portsPresent} of ${portsFilterLc.length} selected ports present`}
                        {' — clear'}
                      </button>
                    </div>
                  ) : null}
                  {portRows.length === 0 && portsFilterLc !== null ? (
                    <EmptyState
                      title="No ports match this selection"
                      description="Clear the selection filter to restore the full class-block port list."
                    >
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => {
                          const next = new URLSearchParams(searchParams);
                          next.delete('ports');
                          setSearchParams(next, { replace: true });
                          setSelectedPortKeys([]);
                        }}
                      >
                        Clear selection filter
                      </Button>
                    </EmptyState>
                  ) : (
                    <DataTable
                      ariaLabel={profile.listTitle}
                      density="compact"
                      className="nt-port-table"
                      columns={profilePortColumns}
                      rows={portRows}
                      rowKey={(p) => p.id}
                      rowTone={(p) => p.tone}
                      selectedKeys={selectedPortKeys}
                      onSelectionChange={setSelectedPortKeys}
                    />
                  )}
                  {selectedPortKeys.length > 0 ? (
                    <div
                      className="nt-configure-bulk-bar nt-bulk-glass"
                      role="region"
                      aria-label="Device port selection actions"
                    >
                      <span className="nt-configure-bulk-bar__count">{`${selectedPortKeys.length} SELECTED`}</span>
                      <span className="nt-configure-bulk-bar__hint">
                        export, copy port names, or share a selection link for only the interfaces you
                        marked — full list export stays above
                      </span>
                      <span className="nt-configure-bulk-bar__actions">
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => {
                            const selected = new Set(selectedPortKeys);
                            const picked = portRows.filter((p) => selected.has(p.id));
                            if (picked.length === 0) {
                              toast('No selected ports still in view', {
                                description: 'Clear selection or refresh the device.',
                                tone: 'info',
                              });
                              return;
                            }
                            const n = exportTableCsv(
                              `device-ports-${device?.name ?? 'export'}-selected.csv`,
                              ['port', 'what', 'state'],
                              picked.map((p) => [p.id, p.what, p.state]),
                            );
                            toast(`Exported ${countOf(n, 'selected port')}`, {
                              description: 'Selected class-block port rows only.',
                              tone: 'success',
                            });
                          }}
                        >
                          Export selected
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            void (async () => {
                              const selected = new Set(selectedPortKeys);
                              const picked = portRows.filter((p) => selected.has(p.id));
                              if (picked.length === 0) {
                                toast('No selected ports still in view', {
                                  description: 'Clear selection or refresh the device.',
                                  tone: 'info',
                                });
                                return;
                              }
                              const ports = [
                                ...new Set(
                                  picked
                                    .map((p) => (p.id ?? '').trim())
                                    .filter((name) => name && name !== '—'),
                                ),
                              ];
                              if (ports.length === 0) {
                                toast('No names on the selected ports', {
                                  description: 'Export CSV for row detail instead.',
                                  tone: 'info',
                                });
                                return;
                              }
                              const text = ports.join('\n');
                              try {
                                await navigator.clipboard.writeText(text);
                                toast(`Copied ${countOf(ports.length, 'port')}`, {
                                  description:
                                    ports.length < picked.length
                                      ? `${picked.length - ports.length} selected without a name skipped`
                                      : 'newline-joined · paste into a ticket or change window',
                                  tone: 'success',
                                });
                              } catch {
                                toast('Could not copy ports', { description: text, tone: 'warning' });
                              }
                            })();
                          }}
                        >
                          Copy ports
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            void (async () => {
                              const selected = new Set(selectedPortKeys);
                              const picked = portRows.filter((p) => selected.has(p.id));
                              if (picked.length === 0) {
                                toast('No selected ports still in view', {
                                  description: 'Clear selection or refresh the device.',
                                  tone: 'info',
                                });
                                return;
                              }
                              const ports = [
                                ...new Set(
                                  picked
                                    .map((p) => (p.id ?? '').trim())
                                    .filter((name) => name.length > 0),
                                ),
                              ];
                              if (ports.length === 0) {
                                toast('No names on the selected ports', {
                                  description: 'Export CSV for row detail instead.',
                                  tone: 'info',
                                });
                                return;
                              }
                              const next = new URLSearchParams(searchParams);
                              next.set('ports', ports.join('\n'));
                              const qs = next.toString();
                              const url = `${window.location.origin}${window.location.pathname}${qs ? `?${qs}` : ''}`;
                              try {
                                await navigator.clipboard.writeText(url);
                                toast('Selection link copied', {
                                  description: `${ports.length} port${ports.length === 1 ? '' : 's'} · ports=`,
                                  tone: 'success',
                                });
                              } catch {
                                toast('Could not copy link', { description: url, tone: 'warning' });
                              }
                            })();
                          }}
                        >
                          Copy selection link
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => setSelectedPortKeys([])}>
                          Clear
                        </Button>
                      </span>
                    </div>
                  ) : null}
                </>
              );
            })()}
          </div>

          {/* Central's per-device telemetry for the demo estate's switches and
              APs: the demo reads are addressed by device NAME (the rows carry
              no serial), so every switch/AP page asks and the route answers
              with the authored read or an honest 'no read recorded' — the
              panel words either outcome. The row is authoritative for class. */}
          {device?.type === 'switch' || device?.type === 'ap' ? (
            <HardwareTrendsPanel
              name={device.name}
              type={device.type}
              identity={{ plane: device.plane, serial: device.serial }}
            />
          ) : null}

          <div className="nt-stack nt-gap-2">
            <SectionHeader label="Clients on this device" meta={clients.meta} />
            {clients.rows.length > 0 ? (
              <div className="nt-wrap-8">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    const n = exportTableCsv(
                      `device-clients-${device?.name ?? profile.name}.csv`,
                      ['client', 'model', 'mac', 'ip', 'where', 'state', 'detail'],
                      clients.rows.map((c) => [
                        c.name,
                        c.model ?? '',
                        c.mac ?? '',
                        c.ip ?? '',
                        c.where ?? '',
                        c.state,
                        c.detail,
                      ]),
                    );
                    toast(`Exported ${n} client row${n === 1 ? '' : 's'}`, {
                      description: 'Clients currently attached to this device.',
                    });
                  }}
                >
                  Export clients
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    void (async () => {
                      const devName = device?.name ?? profile.name;
                      const qs = new URLSearchParams();
                      if (device?.plane) qs.set('plane', String(device.plane));
                      if (device?.serial) qs.set('serial', String(device.serial));
                      const suffix = qs.toString() ? `?${qs}` : '';
                      const res = await downloadApiCsv(
                        `/api/devices/${encodeURIComponent(devName)}/clients/export${suffix}`,
                        `device-clients-${devName}.csv`,
                      );
                      if (res.ok) {
                        toast('Server CSV downloaded', {
                          description: 'Attached sessions from the portal inventory.',
                          tone: 'success',
                        });
                      } else {
                        toast('Server CSV failed', {
                          description: res.error ?? 'Could not download clients export',
                          tone: 'warning',
                        });
                      }
                    })();
                  }}
                >
                  Download server CSV
                </Button>
              </div>
            ) : null}
            <ClientTable
              rows={clients.rows}
              exportName={`device-clients-${device?.name ?? profile.name}`}
            />
            <div className="nt-pt-10">
              <Button variant="ghost" size="sm" onClick={() => navigate('/clients')}>
                All clients →
              </Button>
            </div>
          </div>

          <VisualReferencePanel
            target={{
              kind: 'device',
              id: device?.serial ?? profile.name,
              plane: device?.plane ?? profile.plane,
            }}
          />
          <ConfigActionPanel
            plane={device?.plane ?? profile.plane}
            targetKind="device"
            target={{
              kind: 'device',
              id: device?.serial ?? profile.name,
              plane: device?.plane ?? profile.plane,
            }}
          />
          <ConfigRecommendationsPanel device={profile.name} site={device?.siteName} />

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
              deviceName={device?.name ?? name}
            />
          ) : null}

          <div className="nt-pt-14">
            <SectionHeader label="Configuration" meta={cfg.meta} />
          </div>
          <ConfigTabs cfg={cfg} cfgTab={cfgTab} onTabChange={setCfgTab} historyRows={historyRows} />

          <div className="nt-wrap-8-pt4">
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

        {/* ---------------- identity rail ---------------- */}
        <div className="nt-device-layout__rail">
          <div className="nt-stack nt-gap-2">
            <SectionHeader label="Identity" />
            {facts.map((f) => (
              <div key={f.k} className="nt-fact-row nt-device-fact">
                <span className="nt-fact-row__k nt-device-fact__label">{f.k}</span>
                <span className="nt-fact-row__v nt-device-fact__value">{f.v}</span>
              </div>
            ))}
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
