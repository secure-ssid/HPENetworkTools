/**
 * web/src/screens/DeviceDetail.tsx — terminal, configuration, clients and
 * compliance for one device. High-fidelity port of design/NtDeviceDetail.dc.html:
 * header (Heading = device name, state + plane Badges, mono model · site · IP,
 * actions ← Inventory / Open in <plane> / Save config / Reboot), five
 * class-specific Stats, then flair → two
 * columns (1.55fr / 1fr). Left: the Local terminal (web/src/lib/TerminalPane —
 * shell-capable devices first try the recorded-SSH WebSocket transport from
 * web/src/lib/wsTerminal.ts, falling back to the canned demo transport when
 * the bridge is unreachable; cloud-claimed devices get read-only telemetry,
 * no input/chips) and Configuration (SegmentedControl
 * Running | Drift vs. baseline | History; drift rendered via DiffCode with
 * danger/success line colouring; Snapshot stores a local history row, Download
 * saves the running config as a file). Right: Identity facts, the class block
 * (Ports of interest / Cluster members / Radios & SSIDs / Tunnels / Services),
 * Clients on this device, Compliance.
 * Data: getDeviceDetail(name) — live /api/devices/:name when the server is up,
 * the shared deviceProfile() fixtures otherwise. Live mode carries only the
 * reconciled inventory row: the authored profile/config/clients are demo
 * data, so the live view renders the real row plus honest "not available in
 * live mode" sections (a live 404 renders an EmptyState, never fixtures).
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
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
import { terminalQuickCommands } from '../../../shared';
import type { CfgHistoryRow, TicketRow } from '../../../shared';
import { useSettings } from '../app/SettingsContext';
import { TerminalPane, createCannedTransport } from '../lib/TerminalPane';
import { createWsTransport } from '../lib/wsTerminal';
import type { AsyncTerminalTransport } from '../lib/wsTerminal';
import { DiffCode } from '../lib/DiffCode';
import { ApiErrorState } from './ApiErrorState';

type CfgTab = 'running' | 'diff' | 'history';

const CFG_TABS = [
  { value: 'running', label: 'Running' },
  { value: 'diff', label: 'Drift vs. baseline' },
  { value: 'history', label: 'History' },
];

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
  const cannedTransport = useMemo(() => createCannedTransport({ kind }), [kind]);
  const [liveTransport, setLiveTransport] = useState<AsyncTerminalTransport | null>(null);
  const [livePrompt, setLivePrompt] = useState<string | null>(null);
  const [terminalAttempt, setTerminalAttempt] = useState(0);
  const [terminalState, setTerminalState] = useState<'idle' | 'connecting' | 'live' | 'disconnected'>('idle');

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

  const saveConfig = () =>
    toast('Snapshot queued', {
      description: 'The persisted snapshot pipeline lands in a later build — this queues the request.',
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
            title="Device not in the live cache"
            description={`No linked plane has reported '${name}'. It may be unmanaged, or the plane that owns it is not linked.`}
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
    const liveIdentity =
      [device.model, device.siteName, device.firmware]
        .filter((value) => reported(value) !== 'Not reported')
        .join(' · ') || 'Inventory details partial';
    const liveFacts = [
      { k: 'Model', v: reported(device.model) },
      { k: 'Type', v: reported(device.type) },
      { k: 'Site', v: reported(device.siteName) },
      { k: 'Managed by', v: device.plane },
      { k: 'State', v: reported(device.state) },
      { k: 'Firmware', v: reported(device.firmware) },
      { k: 'Licence', v: reported(device.licence) },
      { k: 'Local shell', v: device.localShell ? 'yes — via collector' : 'no — cloud-claimed' },
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
            <Button variant="ghost" size="sm" style={{ color: 'var(--nd-danger)' }} onClick={() => setRebootOpen(true)}>
              Reboot
            </Button>
          </div>
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
                titlebar={`ssh ${device.name} — via collector`}
                titlebarRight="AES-256 · LIVE · recorded"
                online
                quickCommands={[]}
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
              <SectionHeader label="Identity" meta="LIVE POLLER CACHE" />
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
                      color: 'var(--nd-text-secondary)',
                      overflowWrap: 'anywhere',
                    }}
                  >
                    {f.v}
                  </span>
                </div>
              ))}
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
            </div>

            <div>
              <SectionHeader label="Compliance" />
              <LiveGapNote>
                Live inventory evidence coverage is available; running-configuration drift remains unavailable.
              </LiveGapNote>
              <div style={{ paddingTop: 10 }}>
                <Button variant="ghost" size="sm" onClick={() => navigate('/compliance')}>
                  View evidence coverage →
                </Button>
              </div>
            </div>
          </div>
        </div>

        {rebootDrawer}
      </div>
    );
  }

  const canShell = profile.kind !== 'none';
  const historyRows = [...extraHistory, ...cfg.history];

  const snapshotNow = () => {
    toast('Snapshot stored', { description: 'Added to the history below as a local row.' });
    setExtraHistory((xs) => [
      {
        when: 'just now',
        what: 'Config snapshot taken from the portal',
        who: 'r.okafor · portal snapshot',
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
            <Badge tone={profile.stateTone} dot>
              {profile.state}
            </Badge>
            {showPlatformTags ? <Badge tone={profile.planeTone}>{profile.plane}</Badge> : null}
            <span
              style={{
                fontFamily: 'var(--nd-font-mono)',
                fontSize: 'var(--nd-text-11)',
                color: 'var(--nd-text-muted)',
              }}
            >
              {profile.model} · {profile.site} · {profile.ip}
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
            titlebar={
              canShell
                ? `ssh r.okafor@${profile.ip} — via collector`
                : `no shell — ${profile.plane} owns this device`
            }
            titlebarRight={
              canShell ? (liveSsh ? 'AES-256 · LIVE · recorded' : 'AES-256 · idle 14:52') : 'request remote shell ↗'
            }
            online={liveSsh}
            quickCommands={canShell ? terminalQuickCommands(profile.kind) : []}
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
            {profile.facts.map((f) => (
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

          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <SectionHeader label="Compliance" />
            {profile.checks.map((c) => (
              <div key={c.label} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
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
            <div>
              <Button variant="ghost" size="sm" onClick={() => navigate('/compliance')}>
                Full compliance report
              </Button>
            </div>
          </div>
        </div>
      </div>

      {/* ---------------- ticket-gated reboot ---------------- */}
      {rebootDrawer}
    </div>
  );
}
