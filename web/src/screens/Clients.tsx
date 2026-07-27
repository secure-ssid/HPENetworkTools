/**
 * web/src/screens/Clients.tsx — every session, wired and wireless.
 * High-fidelity port of design/NtClients.dc.html: 5-Stat row, local AND filter
 * row (search / medium / type / site / group / plane / "Problems only") with
 * the right-aligned mono count, the 10-column open table, and the width="lg"
 * client drawer (state badges, Experience metrics + quality Progress,
 * Where it is, the vertical path-to-the-internet hop chain computed with
 * shared pathFor(), the stitched session timeline via timelineFor(), and the
 * action row).
 * The drawer is deep-linkable: selection lives in the URL as ?mac=<mac>, so a
 * link (or the auth-events screen) opens it directly; closing clears the param.
 * Data: getClients() — live /api/clients when the server is up, fixtures otherwise.
 */

import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  Badge,
  Button,
  Drawer,
  EmptyState,
  FormField,
  Input,
  Progress,
  SectionHeader,
  Select,
  Spinner,
  Stat,
  Switch,
  Table,
  useToast,
} from '../nightdesk';
import { blockClient, disconnectClient, getClients, getTickets } from '../api/client';
import type { ClientsData } from '../api/client';
import { useSettings } from '../app/SettingsContext';
import { planeFilterForParam } from '../app/nav';
import { pathFor, timelineFor } from '../../../shared';
import type { ClientRow, TicketRow } from '../../../shared';
import { ScreenHeader } from './ScreenHeader';
import { ApiErrorState } from './ApiErrorState';

const MEDIUM_OPTIONS = [
  { value: 'all', label: 'Wired + wireless' },
  { value: 'wireless', label: 'Wireless' },
  { value: 'wired', label: 'Wired' },
];

/** Numeric value of a metric string; fixtures use U+2212 for negative dBm. */
function metricNum(s: string): number {
  return parseFloat(s.replace(/−/g, '-'));
}

function uniq<K extends keyof ClientRow>(clients: ClientRow[], k: K): string[] {
  return clients.map((c) => String(c[k])).filter((v, i, a) => a.indexOf(v) === i);
}

export default function Clients() {
  const navigate = useNavigate();
  const { density, showPlatformTags } = useSettings();
  const { toast } = useToast();
  const [data, setData] = useState<ClientsData | null>(null);
  const [searchParams, setSearchParams] = useSearchParams();
  const [q, setQ] = useState('');
  const [medium, setMedium] = useState('all');
  const [type, setType] = useState('all');
  const [site, setSite] = useState('all');
  const [group, setGroup] = useState('all');
  const [plane, setPlane] = useState(() => planeFilterForParam(searchParams.get('plane')));
  const [problemsOnly, setProblemsOnly] = useState(false);

  useEffect(() => {
    let live = true;
    void getClients().then((d) => {
      if (live) setData(d);
    });
    return () => {
      live = false;
    };
  }, []);

  /* Deep link: /clients?plane=<registryId> (from the Systems plane drawer). */
  useEffect(() => {
    const pp = searchParams.get('plane');
    if (pp !== null) setPlane(planeFilterForParam(pp));
  }, [searchParams]);

  /* The drawer selection is the ?mac= URL param — deep links open it directly. */
  const macParam = searchParams.get('mac');

  /* Ticket-gated session writes: Reauthenticate (Central troubleshooting-API
   * disconnect — the client rejoins and reauthenticates) and Block endpoint
   * (ClearPass CoA Disconnect-Request, the wired path Central cannot reach).
   * One confirm block serves both; it closes when the drawer selection changes.
   * Hooks live ABOVE the !data early return — below it they'd fire only after
   * the first fetch resolves and React kills the screen ("rendered more hooks
   * than during the previous render"). */
  const [coaOpen, setCoaOpen] = useState(false);
  const [coaMode, setCoaMode] = useState<'reauth' | 'block'>('reauth');
  const [coaTickets, setCoaTickets] = useState<TicketRow[]>([]);
  const [coaTicket, setCoaTicket] = useState('');
  const [coaBusy, setCoaBusy] = useState(false);

  const openCoa = (mode: 'reauth' | 'block') => {
    setCoaMode(mode);
    setCoaOpen(true);
  };

  useEffect(() => {
    setCoaOpen(false);
    setCoaTicket('');
  }, [macParam]);

  useEffect(() => {
    if (!coaOpen) return;
    let live = true;
    void getTickets().then((d) => {
      if (!live) return;
      const open = d.tickets.filter((t) => !/resolved|closed/i.test(t.state));
      const rest = d.tickets.filter((t) => /resolved|closed/i.test(t.state));
      const sorted = [...open, ...rest];
      setCoaTickets(sorted);
      setCoaTicket((curId) => curId || (sorted[0]?.id ?? ''));
    });
    return () => {
      live = false;
    };
  }, [coaOpen]);

  if (!data) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: 96 }}>
        <Spinner size="md" />
      </div>
    );
  }
  if (data.apiError) return <ApiErrorState message={data.apiError} />;

  const clients = data.clients;
  /* Provenance for every derivation below: the section leads with real rows when
   * the portal is live OR when blend mode swapped it in. */
  const sectionLive = data.dataSource === 'live' || (data.blended?.includes('clients') ?? false);
  const ql = q.trim().toLowerCase();
  const rows = clients.filter(
    (c) =>
      (medium === 'all' || c.medium === medium) &&
      (type === 'all' || c.type === type) &&
      (plane === 'all' || c.plane === plane) &&
      (site === 'all' || c.siteName === site) &&
      (group === 'all' || c.group === group) &&
      (!problemsOnly || c.problem) &&
      (!ql || (c.name + c.model + c.mac + c.ip + c.attach + c.group).toLowerCase().includes(ql)),
  );

  const typeOptions = [{ value: 'all', label: 'All device types' }].concat(
    uniq(clients, 'type').map((v) => ({ value: v, label: v })),
  );
  const planeOptions = [{ value: 'all', label: 'All planes' }].concat(
    uniq(clients, 'plane').map((v) => ({ value: v, label: v })),
  );
  const siteOptions = [{ value: 'all', label: 'All sites' }].concat(
    uniq(clients, 'siteName').map((v) => ({ value: v, label: v })),
  );
  const groupOptions = [{ value: 'all', label: 'All groups' }].concat(
    uniq(clients, 'group').map((v) => ({ value: v, label: v })),
  );

  const cur = macParam ? (clients.find((c) => c.mac === macParam) ?? null) : null;
  const openClient = (mac: string) => setSearchParams({ mac }, { replace: true });
  const closeClient = () => setSearchParams({}, { replace: true });
  const openDevice = (name: string) => {
    closeClient();
    navigate(`/devices/${encodeURIComponent(name)}`);
  };

  const confirmCoa = async () => {
    if (!cur) return;
    if (!coaTicket) {
      toast('Pick the ticket that authorises this write — writes are brokered, never standing', {
        tone: 'danger',
      });
      return;
    }
    setCoaBusy(true);
    const res =
      coaMode === 'block' ? await blockClient(cur.mac, coaTicket) : await disconnectClient(cur.mac, coaTicket);
    setCoaBusy(false);
    if (!res.ok) {
      toast(res.message, { tone: 'danger' });
      return;
    }
    const verb = coaMode === 'block' ? 'Block' : 'Disconnect';
    toast(res.applied ? `${verb} accepted — ${cur.name}` : `${verb} logged, not sent`, {
      description: res.message,
      tone: res.applied ? 'success' : 'warning',
    });
    setCoaOpen(false);
  };

  /* Drawer view model — computed only while a client is selected. */
  const warn = (bad: boolean) => (bad ? 'var(--nd-warning)' : 'var(--nd-text-primary)');
  const drawer = cur
    ? (() => {
        // pathFor/timelineFor stitch from the DEMO topology + event fixtures.
        // For a live client they would fabricate hops through devices the
        // estate doesn't have (sw-core-a, gw-edge-1…) — once the section
        // leads with live rows, serve an honest empty state instead.
        const path = sectionLive ? [] : pathFor(cur);
        const weakHops = path.filter((h) => h.tone === 'warning' || h.tone === 'danger').length;
        const wired = cur.medium === 'wired';
        const metricNote = (value: string, note: string) =>
          sectionLive && value === '—' ? `not reported by ${cur.plane}` : note;
        const known = (...parts: string[]) => parts.filter((part) => part && part !== '—').join(' · ') || '—';
        return {
          summary: sectionLive ? known(cur.model, cur.siteName) : known(cur.role, cur.group, cur.siteName),
          metrics: [
            {
              k: 'Signal',
              v: cur.rssi,
              note: metricNote(cur.rssi, wired ? 'wired link' : 'target ≥ −67 dBm'),
              color: warn(cur.rssi !== '—' && metricNum(cur.rssi) < -67),
            },
            {
              k: 'SNR',
              v: cur.snr,
              note: metricNote(cur.snr, wired ? 'not applicable to wired links' : 'target ≥ 25 dB'),
              color: warn(cur.snr !== '—' && metricNum(cur.snr) < 25),
            },
            {
              k: 'Retries',
              v: cur.retries,
              note: metricNote(cur.retries, 'target under 8%'),
              color: warn(cur.retries !== '—' && metricNum(cur.retries) > 8),
            },
            {
              k: 'Throughput',
              v: cur.tput,
              note: metricNote(cur.tput, 'current rate'),
              color: warn(false),
            },
            {
              k: 'Roams',
              v: cur.roams,
              note: metricNote(cur.roams, 'this session'),
              color: warn(parseInt(cur.roams, 10) > 8),
            },
            {
              k: 'IP',
              v: cur.ip,
              note: cur.vlan === '—' ? metricNote(cur.vlan, 'VLAN') : `VLAN ${cur.vlan}`,
              color: warn(cur.ip === 'pending' || cur.ip === '—'),
            },
          ],
          qualityNote:
            cur.quality === null
              ? `${cur.plane} reports health as “${cur.health}” but did not provide a numeric experience score.`
              : cur.quality >= 85
              ? 'Signal, retries and throughput all within the clinical target.'
              : cur.quality >= 50
                ? 'Below the clinical target — signal or retries are the limiting factor.'
                : 'Session is effectively unusable; see the timeline for why.',
          experienceMeta: cur.link === '—' && sectionLive ? 'PARTIAL PLANE METRICS' : cur.link,
          place: [
            { k: 'Site', v: cur.siteName },
            { k: 'Zone', v: cur.zone },
            {
              k: 'Group',
              v: cur.group === '—' ? 'Not reported by the client plane' : `${cur.group} — config group`,
            },
            { k: 'Attached to', v: known(cur.attach, cur.where) },
            { k: 'Wiring', v: cur.closet },
          ],
          path,
          pathMeta: sectionLive
            ? 'NO TOPOLOGY SOURCE'
            : `${path.length} HOPS${weakHops ? ` · ${weakHops} DEGRADED` : ' · ALL HEALTHY'}`,
          timeline: sectionLive ? [] : timelineFor(cur),
          timelineMeta: sectionLive ? 'NO PLANE SESSION EVENTS' : 'STITCHED ACROSS PLANES',
        };
      })()
    : null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <ScreenHeader
        overline="Operate / Clients"
        title="Clients"
        subtitle="Every session, wired or wireless, whichever plane authenticated it."
        actions={
          <>
            <Button variant="ghost" size="sm" onClick={() => navigate('/auth-events')}>
              Auth events →
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() =>
                toast('Session export queued', {
                  description: 'CSV of the sampled sessions lands with the reporting backend.',
                })
              }
            >
              Export session
            </Button>
          </>
        }
      />

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, minmax(0, 1fr))', gap: 18 }}>
        {data.stats.map((s) => (
          <Stat key={s.label} label={s.label} value={s.value} delta={s.delta} deltaTone={s.tone} />
        ))}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <div style={{ width: 230 }}>
          <Input
            size="sm"
            mono
            placeholder="user, MAC, IP, hostname…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        <div style={{ width: 150 }}>
          <Select
            options={MEDIUM_OPTIONS}
            value={medium}
            onValueChange={setMedium}
            size="sm"
            aria-label="Medium"
          />
        </div>
        <div style={{ width: 160 }}>
          <Select
            options={typeOptions}
            value={type}
            onValueChange={setType}
            size="sm"
            aria-label="Device type"
          />
        </div>
        <div style={{ width: 190 }}>
          <Select
            options={siteOptions}
            value={site}
            onValueChange={setSite}
            size="sm"
            aria-label="Site"
          />
        </div>
        <div style={{ width: 190 }}>
          <Select
            options={groupOptions}
            value={group}
            onValueChange={setGroup}
            size="sm"
            aria-label="Group"
          />
        </div>
        <div style={{ width: 150 }}>
          <Select
            options={planeOptions}
            value={plane}
            onValueChange={setPlane}
            size="sm"
            aria-label="Plane"
          />
        </div>
        <Switch label="Problems only" size="sm" checked={problemsOnly} onCheckedChange={setProblemsOnly} />
        <span
          style={{
            marginLeft: 'auto',
            fontFamily: 'var(--nd-font-mono)',
            fontSize: 'var(--nd-text-11)',
            color: 'var(--nd-text-muted)',
          }}
        >
          {/* The estate total is a fixture figure; a live feed counts only what
              the poller returned, so the tail drops rather than contradict the
              `Clients now` Stat above it. */}
          {rows.length} of {clients.length} sampled{sectionLive ? '' : ' · 4,982 live sessions'}
        </span>
      </div>

      <Table density={density}>
        <Table.Head>
          <Table.Row>
            <Table.HeaderCell>Client</Table.HeaderCell>
            <Table.HeaderCell>Type</Table.HeaderCell>
            <Table.HeaderCell>Site</Table.HeaderCell>
            <Table.HeaderCell>Group</Table.HeaderCell>
            <Table.HeaderCell>Connected to</Table.HeaderCell>
            <Table.HeaderCell>Plane</Table.HeaderCell>
            <Table.HeaderCell>Auth</Table.HeaderCell>
            <Table.HeaderCell>Role / VLAN</Table.HeaderCell>
            <Table.HeaderCell>Health</Table.HeaderCell>
            <Table.HeaderCell numeric>Session</Table.HeaderCell>
          </Table.Row>
        </Table.Head>
        <Table.Body>
          {rows.map((c) => (
            <Table.Row key={c.mac} interactive onClick={() => openClient(c.mac)}>
              <Table.Cell>
                <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <span style={{ fontSize: 13, color: 'var(--nd-text-primary)' }}>{c.name}</span>
                  <span
                    style={{
                      fontFamily: 'var(--nd-font-mono)',
                      fontSize: 'var(--nd-text-10)',
                      color: 'var(--nd-text-muted)',
                    }}
                  >
                    {c.mac}
                  </span>
                </span>
              </Table.Cell>
              <Table.Cell>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <span
                    style={{
                      fontFamily: 'var(--nd-font-mono)',
                      fontSize: 10.5,
                      color: 'var(--nd-text-secondary)',
                      textTransform: 'uppercase',
                      letterSpacing: '.06em',
                    }}
                  >
                    {c.type}
                  </span>
                  <span
                    style={{
                      fontSize: 'var(--nd-text-11)',
                      color: 'var(--nd-text-muted)',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {c.model}
                  </span>
                </div>
              </Table.Cell>
              <Table.Cell>{c.siteName}</Table.Cell>
              <Table.Cell>
                <span
                  style={{
                    fontFamily: 'var(--nd-font-mono)',
                    fontSize: 10.5,
                    color: 'var(--nd-text-secondary)',
                  }}
                >
                  {c.group}
                </span>
              </Table.Cell>
              <Table.Cell>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    navigate(`/devices/${encodeURIComponent(c.attach)}`);
                  }}
                  style={{
                    background: 'none',
                    border: 'none',
                    padding: 0,
                    cursor: 'pointer',
                    textAlign: 'left',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 2,
                  }}
                >
                  <span
                    style={{
                      fontFamily: 'var(--nd-font-mono)',
                      fontSize: 'var(--nd-text-11)',
                      color: 'var(--nd-accent-text)',
                    }}
                  >
                    {c.attach}
                  </span>
                  <span
                    style={{
                      fontSize: 'var(--nd-text-11)',
                      color: 'var(--nd-text-muted)',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {c.where}
                  </span>
                </button>
              </Table.Cell>
              <Table.Cell>
                {showPlatformTags ? <Badge tone={c.planeTone}>{c.plane}</Badge> : null}
              </Table.Cell>
              <Table.Cell>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <span
                    style={{
                      fontFamily: 'var(--nd-font-mono)',
                      fontSize: 10.5,
                      color: 'var(--nd-text-secondary)',
                    }}
                  >
                    {c.auth}
                  </span>
                  <span
                    style={{
                      fontFamily: 'var(--nd-font-mono)',
                      fontSize: 'var(--nd-text-10)',
                      color: 'var(--nd-text-muted)',
                    }}
                  >
                    {c.authBy}
                  </span>
                </div>
              </Table.Cell>
              <Table.Cell>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <span style={{ fontSize: 'var(--nd-text-12)', color: 'var(--nd-text-secondary)' }}>
                    {c.role}
                  </span>
                  <span
                    style={{
                      fontFamily: 'var(--nd-font-mono)',
                      fontSize: 'var(--nd-text-10)',
                      color: 'var(--nd-text-muted)',
                    }}
                  >
                    {c.vlan}
                  </span>
                </div>
              </Table.Cell>
              <Table.Cell>
                <Badge tone={c.healthTone} dot>
                  {c.health}
                </Badge>
              </Table.Cell>
              <Table.Cell numeric>{c.session}</Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table>

      {rows.length === 0 ? (
        <EmptyState
          title="Nothing matches that filter"
          description="Loosen the filters or clear Problems only to see more sessions."
        />
      ) : null}

      <Drawer
        open={cur != null}
        onOpenChange={(open) => {
          if (!open) closeClient();
        }}
        width="lg"
        title={cur?.name}
        description={drawer?.summary}
      >
        {cur && drawer ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <Badge tone={cur.healthTone} dot>
                {cur.health}
              </Badge>
              <Badge tone={cur.planeTone}>{cur.plane}</Badge>
              <Badge tone="neutral">{cur.type}</Badge>
              <span
                style={{
                  fontFamily: 'var(--nd-font-mono)',
                  fontSize: 'var(--nd-text-11)',
                  color: 'var(--nd-text-muted)',
                }}
              >
                session {cur.session}
              </span>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <SectionHeader label="Experience" meta={drawer.experienceMeta} />
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
                  gap: '14px 18px',
                }}
              >
                {drawer.metrics.map((m) => (
                  <div key={m.k} style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                    <span
                      style={{
                        fontFamily: 'var(--nd-font-mono)',
                        fontSize: 9.5,
                        letterSpacing: '.12em',
                        textTransform: 'uppercase',
                        color: 'var(--nd-text-muted)',
                      }}
                    >
                      {m.k}
                    </span>
                    <span style={{ fontFamily: 'var(--nd-font-mono)', fontSize: 15, color: m.color }}>
                      {m.v}
                    </span>
                    <span
                      style={{
                        fontFamily: 'var(--nd-font-mono)',
                        fontSize: 'var(--nd-text-10)',
                        color: 'var(--nd-text-muted)',
                      }}
                    >
                      {m.note}
                    </span>
                  </div>
                ))}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, paddingTop: 6 }}>
                {cur.quality !== null ? (
                  <Progress
                    value={cur.quality}
                    label="Connection quality score"
                    note={`${cur.quality} / 100`}
                  />
                ) : (
                  <SectionHeader label="Connection quality score" meta="NOT REPORTED" />
                )}
                <span
                  style={{
                    fontFamily: 'var(--nd-font-mono)',
                    fontSize: 'var(--nd-text-10)',
                    color: 'var(--nd-text-muted)',
                  }}
                >
                  {drawer.qualityNote}
                </span>
              </div>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <SectionHeader label="Where it is" meta={cur.group} />
              {drawer.place.map((p) => (
                <div
                  key={p.k}
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
                      fontSize: 9.5,
                      letterSpacing: '.12em',
                      textTransform: 'uppercase',
                      color: 'var(--nd-text-muted)',
                      width: 104,
                      flex: '0 0 104px',
                      paddingTop: 2,
                    }}
                  >
                    {p.k}
                  </span>
                  <span
                    style={{
                      flex: 1,
                      minWidth: 0,
                      fontSize: 'var(--nd-text-12)',
                      color: 'var(--nd-text-secondary)',
                    }}
                  >
                    {p.v}
                  </span>
                </div>
              ))}
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <SectionHeader label="Path to the internet" meta={drawer.pathMeta} />
              {drawer.path.length === 0 ? (
                <div
                  style={{
                    fontFamily: 'var(--nd-font-mono)',
                    fontSize: 'var(--nd-text-11)',
                    color: 'var(--nd-text-muted)',
                    lineHeight: 1.6,
                  }}
                >
                  No linked topology source reported a path for this live client. The portal
                  will not substitute the demo topology.
                </div>
              ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 0, paddingLeft: 2 }}>
                {drawer.path.map((h, i) => (
                  <div key={`${h.name}-${i}`} style={{ display: 'flex', gap: 16, alignItems: 'stretch' }}>
                    <div
                      style={{
                        width: 11,
                        flex: '0 0 11px',
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'center',
                      }}
                    >
                      <span
                        style={{
                          width: 9,
                          height: 9,
                          borderRadius: 99,
                          background: h.dot,
                          marginTop: 6,
                          flex: '0 0 9px',
                        }}
                      />
                      {h.hasNext ? (
                        <span
                          style={{
                            flex: 1,
                            width: 1,
                            background: 'var(--nd-border-default)',
                            margin: '3px 0 0',
                          }}
                        />
                      ) : null}
                    </div>
                    <div style={{ flex: 1, minWidth: 0, paddingBottom: 16 }}>
                      <div
                        style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}
                      >
                        {h.device ? (
                          <button
                            type="button"
                            onClick={() => openDevice(h.name)}
                            style={{
                              background: 'none',
                              border: 'none',
                              padding: 0,
                              cursor: 'pointer',
                              fontFamily: 'var(--nd-font-mono)',
                              fontSize: 'var(--nd-text-12)',
                              color: 'var(--nd-accent-text)',
                            }}
                          >
                            {h.name}
                          </button>
                        ) : (
                          <span
                            style={{
                              fontFamily: 'var(--nd-font-mono)',
                              fontSize: 'var(--nd-text-12)',
                              color: 'var(--nd-text-primary)',
                            }}
                          >
                            {h.name}
                          </span>
                        )}
                        <span style={{ fontSize: 11.5, color: 'var(--nd-text-muted)' }}>{h.role}</span>
                        {showPlatformTags ? <Badge tone={h.tone}>{h.state}</Badge> : null}
                      </div>
                      {h.hasNext ? (
                        <div
                          style={{
                            fontFamily: 'var(--nd-font-mono)',
                            fontSize: 10.5,
                            color: 'var(--nd-text-muted)',
                            paddingTop: 5,
                          }}
                        >
                          ↓ {h.link}
                        </div>
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>
              )}
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <SectionHeader label="Session timeline" meta={drawer.timelineMeta} />
              {drawer.timeline.length === 0 ? (
                <div
                  style={{
                    fontFamily: 'var(--nd-font-mono)',
                    fontSize: 'var(--nd-text-11)',
                    color: 'var(--nd-text-muted)',
                    lineHeight: 1.6,
                    padding: '9px 0',
                  }}
                >
                  No linked plane reported session events for this client. The portal will not
                  substitute the demo timeline.
                </div>
              ) : (
              drawer.timeline.map((t, i) => (
                <div
                  key={`${t.time}-${i}`}
                  style={{
                    display: 'flex',
                    gap: 12,
                    padding: '9px 0',
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
                    {t.time}
                  </span>
                  <span
                    style={{
                      fontFamily: 'var(--nd-font-mono)',
                      fontSize: 'var(--nd-text-10)',
                      color: 'var(--nd-text-muted)',
                      width: 74,
                      flex: '0 0 74px',
                      textTransform: 'uppercase',
                    }}
                  >
                    {t.plane}
                  </span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        fontSize: 'var(--nd-text-12)',
                        color: 'var(--nd-text-primary)',
                        lineHeight: 1.4,
                      }}
                    >
                      {t.what}
                    </div>
                    <div
                      style={{
                        fontFamily: 'var(--nd-font-mono)',
                        fontSize: 'var(--nd-text-10)',
                        color: 'var(--nd-text-muted)',
                      }}
                    >
                      {t.raw}
                    </div>
                  </div>
                </div>
              ))
              )}
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <SectionHeader label="Actions" />
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => (coaOpen && coaMode === 'reauth' ? setCoaOpen(false) : openCoa('reauth'))}
                >
                  Reauthenticate
                </Button>
                <Button variant="secondary" size="sm" onClick={() => openDevice(cur.attach)}>
                  Inspect {cur.attach}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    closeClient();
                    navigate(`/auth-events?q=${encodeURIComponent(cur.mac)}`);
                  }}
                >
                  Auth history
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  style={{ color: 'var(--nd-danger)' }}
                  onClick={() => (coaOpen && coaMode === 'block' ? setCoaOpen(false) : openCoa('block'))}
                >
                  Block endpoint
                </Button>
              </div>
              {coaOpen ? (
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'flex-end',
                    gap: 10,
                    flexWrap: 'wrap',
                    padding: '12px 14px',
                    border: '1px solid var(--nd-border-default)',
                    background: 'var(--nd-bg-raised)',
                  }}
                >
                  <div style={{ flex: 1, minWidth: 240 }}>
                    <FormField
                      label="Authorising ticket"
                      help={
                        coaMode === 'block'
                          ? `ClearPass issues a CoA Disconnect-Request for ${cur.mac} to the NAD holding its session — the wired path the troubleshooting API cannot reach. Recorded against this ticket.`
                          : `Deauthenticates ${cur.name} on ${cur.attach} via the troubleshooting API (202 = accepted); the client rejoins and reauthenticates. Recorded against this ticket.`
                      }
                    >
                      <Select
                        options={coaTickets.map((t) => ({ value: t.id, label: `${t.id} · ${t.title}` }))}
                        value={coaTicket}
                        onValueChange={setCoaTicket}
                        aria-label="Authorising ticket"
                      />
                    </FormField>
                  </div>
                  <Button
                    variant="primary"
                    size="sm"
                    disabled={coaBusy || !coaTicket}
                    onClick={() => void confirmCoa()}
                    style={{ background: 'var(--nd-danger)' }}
                  >
                    {coaBusy ? 'Sending…' : coaMode === 'block' ? 'Block via ClearPass' : 'Disconnect'}
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setCoaOpen(false)}>
                    Cancel
                  </Button>
                </div>
              ) : null}
            </div>
          </div>
        ) : null}
      </Drawer>
    </div>
  );
}
