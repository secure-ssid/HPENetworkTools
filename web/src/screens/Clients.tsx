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

import { useEffect, useRef, useState } from 'react';
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
import {
  blockClient,
  disconnectClient,
  getClientDetail,
  getClients,
  getSiteTopology,
  getTickets,
} from '../api/client';
import type { ClientsData } from '../api/client';
import { useSettings } from '../app/SettingsContext';
import { planeFilterForParam } from '../app/nav';
import {
  clientFieldProvenance,
  deriveRssiDbm,
  detailState,
  pathFor,
  planeKeyOf,
  timelineFor,
} from '../../../shared';
import type {
  ClientDetailLive,
  ClientDetailSection,
  ClientRow,
  ClientTimelineEvent,
  PathHop,
  PathHopView,
  ServingRadio,
  SiteTopologyLive,
  TicketRow,
  TimelineStep,
  Tone,
  TopologyDeviceNode,
  TopologyLink,
} from '../../../shared';
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

function hhmm(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * A session the route could not re-confirm this cycle. The /clients handler
 * rewrites rows from a plane the registry considers behind to health
 * 'unverified' (design rule 1 — an aged cache is not a current session), so the
 * screen must show that as a state, not as one more health word.
 */
function isUnverified(c: ClientRow): boolean {
  return c.health === 'unverified';
}

/** VLAN as the plane reported it, without the fixtures' own 'vlan ' prefix. */
function vlanNumber(vlan: string): string | null {
  if (vlan === '—') return null;
  return vlan.replace(/^vlan\s+/i, '');
}

function uniq<K extends keyof ClientRow>(clients: ClientRow[], k: K): string[] {
  return clients.map((c) => String(c[k])).filter((v, i, a) => a.indexOf(v) === i);
}

// ---------------------------------------------------------------------------
// On-demand detail reads — ONE client, ONE open drawer
// ---------------------------------------------------------------------------

/**
 * Central models a client across ~8 endpoints and a site across a topology
 * read; the 60s poll fetches NONE of them on purpose (9 devices x N
 * subresources x 1440 polls a day would burn the tenant's call budget for
 * rows nobody is looking at). These reads happen on the DETAIL path —
 * getClientDetail / getSiteTopology, issued once per object while its drawer
 * is open — and a rejection is swallowed into the honest empty state below
 * rather than into a fabricated number.
 */
async function readClientDetail(mac: string): Promise<ClientDetailLive | null> {
  return (await getClientDetail(mac).catch(() => null)) ?? null;
}

async function readSiteTopology(siteId: string): Promise<SiteTopologyLive | null> {
  return (await getSiteTopology(siteId).catch(() => null)) ?? null;
}

// ---------------------------------------------------------------------------
// Formatting for detail figures
// ---------------------------------------------------------------------------

/** Bits per second, as an operator says it. */
function formatBps(bps: number): string {
  if (!Number.isFinite(bps) || bps < 0) return '—';
  if (bps >= 1e9) return `${(bps / 1e9).toFixed(1)} Gbps`;
  if (bps >= 1e6) return `${(bps / 1e6).toFixed(1)} Mbps`;
  if (bps >= 1e3) return `${Math.round(bps / 1e3)} kbps`;
  return `${Math.round(bps)} bps`;
}

/** The window a detail figure covers. null when the read did not say — the
 *  sentence then must not name one, because guessing "24h" is a fabrication. */
function formatWindow(sec: number | null | undefined): string | null {
  if (typeof sec !== 'number' || !Number.isFinite(sec) || sec <= 0) return null;
  if (sec < 60) return `${Math.round(sec)}s`;
  const minutes = Math.round(sec / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

function windowPhrase(sec: number | null | undefined): string {
  const w = formatWindow(sec);
  return w ? `the last ${w}` : 'the read window';
}

/** dBm with the design's U+2212 minus, matching the fixtures' own metrics. */
function dbm(v: number): string {
  return `${String(v).replace('-', '−')} dBm`;
}

function nonEmpty(parts: (string | null | undefined | false)[]): string[] {
  return parts.filter((p): p is string => typeof p === 'string' && p.length > 0);
}

/** The radio a per-radio figure belongs to: 'radio 1 · 2.4 GHz on MBB-515'.
 *  Central models retries and the noise floor on the AP RADIO, never on the
 *  client, so a drawer that prints one has to name whose number it is. */
function servingRadioLabel(r: ServingRadio): string {
  const radio =
    nonEmpty([r.radioNumber !== null ? `radio ${r.radioNumber}` : null, r.band]).join(' · ') ||
    'serving radio';
  return r.apName ? `${radio} on ${r.apName}` : radio;
}

/** Plane session events → the rows this drawer already renders. */
function timelineRowsFrom(events: ClientTimelineEvent[], plane: string): TimelineStep[] {
  return events.map((e) => ({
    time: hhmm(e.ts),
    plane,
    what: e.detail,
    raw: nonEmpty([
      e.kind.toUpperCase(),
      e.device,
      e.port ? `port ${e.port}` : null,
      e.wlan,
      e.band,
      e.channel ? `ch ${e.channel}` : null,
      typeof e.rssiDbm === 'number' ? dbm(e.rssiDbm) : null,
      e.vlan ? `vlan ${e.vlan}` : null,
    ]).join(' · '),
  }));
}

// ---------------------------------------------------------------------------
// Path to the internet, from the plane's own site graph
// ---------------------------------------------------------------------------

/** Mirrors shared decorateHops(), which is internal to logic.ts. */
const HOP_DOT: Partial<Record<Tone, string>> = {
  success: 'var(--nd-success)',
  warning: 'var(--nd-warning)',
  danger: 'var(--nd-danger)',
  neutral: 'var(--nd-border-strong)',
  accent: 'var(--nd-accent)',
};

function decorate(hops: PathHop[]): PathHopView[] {
  return hops.map((h, i) => ({
    ...h,
    hasNext: i < hops.length - 1,
    plain: !h.device,
    dot: HOP_DOT[h.tone] ?? 'var(--nd-border-strong)',
  }));
}

function topologyTone(node: TopologyDeviceNode): Tone {
  const status = (node.status ?? '').toUpperCase();
  if (status === 'OFFLINE' || status === 'DOWN') return 'danger';
  const health = (node.health ?? '').toLowerCase();
  if (health === 'poor' || health === 'bad') return 'danger';
  if (health === 'fair') return 'warning';
  if (health === 'good') return 'success';
  return 'neutral';
}

function isGatewayNode(node: TopologyDeviceNode): boolean {
  return /gateway|gw|router|wan/i.test(`${node.deviceFunction} ${node.type}`);
}

/** One segment as a fact about the wiring, in the direction of travel. */
function linkFact(link: TopologyLink, forward: boolean): string {
  const near = (forward ? link.fromPorts : link.toPorts).map((p) => p.name).filter(Boolean);
  const far = (forward ? link.toPorts : link.fromPorts).map((p) => p.name).filter(Boolean);
  return nonEmpty([
    near.length || far.length ? `${near.join('+') || '?'} → ${far.join('+') || '?'}` : null,
    typeof link.speedBps === 'number' && link.speedBps > 0 ? formatBps(link.speedBps) : null,
    link.health && link.health.toLowerCase() !== 'good' ? `link ${link.health.toLowerCase()}` : null,
  ]).join(' · ');
}

type LivePath = {
  hops: PathHopView[];
  /** Why the chain looks the way it does — the drawer says each differently. */
  reason: 'ok' | 'no-graph' | 'not-on-graph' | 'no-uplink';
  /** The node the chain ends on, when it ended on one. */
  end: TopologyDeviceNode | null;
};

/**
 * Walk the plane's own site graph from the device this client is attached to
 * out to the nearest gateway. Nothing here is invented: every hop is a node
 * the plane returned, every segment label is that link's own ports and speed.
 * When the plane does not place the attach device on the graph we say so —
 * we do not guess the uplink.
 */
function livePathFor(client: ClientRow, topo: SiteTopologyLive): LivePath {
  const nodes = topo.nodes ?? [];
  const links = topo.links ?? [];
  if (nodes.length === 0) return { hops: [], reason: 'no-graph', end: null };

  const wanted = client.attach.trim().toLowerCase();
  const start =
    nodes.find((n) => n.name.trim().toLowerCase() === wanted) ??
    nodes.find((n) => n.serial.trim().toLowerCase() === wanted) ??
    nodes.find((n) => (n.mac ?? '').trim().toLowerCase() === wanted) ??
    null;
  if (!start) return { hops: [], reason: 'not-on-graph', end: null };

  const bySerial = new Map(nodes.map((n) => [n.serial, n]));
  const edges = new Map<string, { other: string; link: TopologyLink; forward: boolean }[]>();
  const push = (from: string, other: string, link: TopologyLink, forward: boolean) => {
    const list = edges.get(from) ?? [];
    list.push({ other, link, forward });
    edges.set(from, list);
  };
  for (const link of links) {
    push(link.from, link.to, link, true);
    push(link.to, link.from, link, false);
  }

  /* Breadth-first: the shortest hop chain is the one the traffic takes. */
  const prev = new Map<string, { from: string; link: TopologyLink; forward: boolean }>();
  const dist = new Map<string, number>([[start.serial, 0]]);
  const queue = [start.serial];
  while (queue.length) {
    const at = queue.shift() as string;
    for (const edge of edges.get(at) ?? []) {
      if (dist.has(edge.other) || !bySerial.has(edge.other)) continue;
      dist.set(edge.other, (dist.get(at) ?? 0) + 1);
      prev.set(edge.other, { from: at, link: edge.link, forward: edge.forward });
      queue.push(edge.other);
    }
  }

  const rank = (n: TopologyDeviceNode) =>
    (dist.get(n.serial) ?? 99) * 10 +
    ((n.status ?? '').toUpperCase() === 'ONLINE' ? 0 : 2) +
    ((n.health ?? '').toLowerCase() === 'good' ? 0 : 1);
  const target = nodes
    .filter((n) => n.serial !== start.serial && dist.has(n.serial) && isGatewayNode(n))
    .sort((a, b) => rank(a) - rank(b))[0];

  const chain: TopologyDeviceNode[] = [];
  if (target) {
    let cursor: string | undefined = target.serial;
    while (cursor) {
      const node = bySerial.get(cursor);
      if (node) chain.unshift(node);
      cursor = prev.get(cursor)?.from;
    }
  } else {
    chain.push(start);
  }

  const hops: PathHop[] = [
    {
      name: client.name,
      role: nonEmpty([client.model, client.type]).join(' · ') || 'client',
      state: client.health,
      tone: client.healthTone,
      link:
        nonEmpty([
          client.where !== '—' ? client.where : null,
          vlanNumber(client.vlan) ? `vlan ${vlanNumber(client.vlan)}` : null,
        ]).join(' · ') || null,
      device: false,
    },
  ];
  chain.forEach((node, i) => {
    const next = chain[i + 1];
    const step = next ? prev.get(next.serial) : undefined;
    hops.push({
      name: node.name,
      role:
        nonEmpty([
          node.deviceFunction && node.deviceFunction !== '-' ? node.deviceFunction.toLowerCase() : null,
          node.model,
          node.healthReason && node.health && node.health.toLowerCase() !== 'good'
            ? node.healthReason.toLowerCase()
            : null,
        ]).join(' · ') || node.type.toLowerCase(),
      state: (node.status ?? node.health ?? 'unknown').toLowerCase(),
      tone: topologyTone(node),
      link: step ? linkFact(step.link, step.forward) || null : null,
      device: true,
    });
  });
  /* Only the plane may claim an internet path: Central reports internet=false
     on every node of this estate, so the chain ends at the gateway and the
     drawer says that in words instead of drawing an Internet hop. */
  const end = chain[chain.length - 1] ?? null;
  if (end?.internet === true) {
    hops.push({
      name: 'Internet',
      role: `upstream of ${end.name}`,
      state: 'reachable',
      tone: 'neutral',
      link: null,
      device: false,
    });
  }
  return { hops: decorate(hops), reason: target ? 'ok' : 'no-uplink', end };
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

  /* Detail reads for the open drawer. Keyed by object, so a result that lands
   * after the operator moved on is filed, not raced; asked-for keys live in a
   * ref so a re-render (or StrictMode's double effect) cannot re-issue a call.
   * `null` = we asked and got nothing usable — an honest empty state, not an
   * excuse to substitute demo data. */
  const sectionLive = data
    ? data.dataSource === 'live' || (data.blended?.includes('clients') ?? false)
    : false;
  const [clientDetail, setClientDetail] = useState<Record<string, ClientDetailLive | null>>({});
  const [siteTopology, setSiteTopology] = useState<Record<string, SiteTopologyLive | null>>({});
  const detailAsked = useRef(new Set<string>());
  const topologyAsked = useRef(new Set<string>());

  useEffect(() => {
    /* Demo fixtures are authored and complete — nothing to fetch for them. */
    if (!macParam || !sectionLive) return;
    if (detailAsked.current.has(macParam)) return;
    detailAsked.current.add(macParam);
    void readClientDetail(macParam).then((d) => {
      setClientDetail((cache) => ({ ...cache, [macParam]: d }));
    });
  }, [macParam, sectionLive]);

  useEffect(() => {
    if (!data || !macParam || !sectionLive) return;
    const siteId = data.clients.find((c) => c.mac === macParam)?.siteId;
    if (!siteId) return;
    if (topologyAsked.current.has(siteId)) return;
    topologyAsked.current.add(siteId);
    void readSiteTopology(siteId).then((t) => {
      setSiteTopology((cache) => ({ ...cache, [siteId]: t }));
    });
  }, [data, macParam, sectionLive]);

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
   * the portal is live OR when blend mode swapped it in (`sectionLive`, computed
   * above the early return so the detail-read effects can gate on it too). */
  /* Staleness is part of the UI (README §363-366): say when these sessions were
   * pulled, and how many of them the source plane could not re-confirm. */
  const stamp = sectionLive ? `SYNCED ${data.syncedAt ? hhmm(data.syncedAt) : '—'}` : 'SYNCED 09:41';
  const unverifiedCount = clients.filter(isUnverified).length;
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

  /* Export what the operator is looking at, built here — there is no reporting
   * backend to queue a job with, and claiming one would be a fabricated write
   * (same client-side CSV the Licences screen ships). */
  const exportCsv = () => {
    const header =
      'client,mac,type,model,site,group,attached,where,plane,auth,authBy,role,vlan,health,session';
    const lines = rows.map((c) =>
      [
        c.name, c.mac, c.type, c.model, c.siteName, c.group, c.attach, c.where,
        c.plane, c.auth, c.authBy, c.role, c.vlan, c.health, c.session,
      ]
        .map((v) => `"${String(v).replace(/"/g, '""')}"`)
        .join(','),
    );
    const blob = new Blob([[header, ...lines].join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'clients-sessions.csv';
    a.click();
    URL.revokeObjectURL(url);
    toast(`Exported ${rows.length} session${rows.length === 1 ? '' : 's'}`, {
      description: 'clients-sessions.csv — the rows currently in view.',
    });
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
        const wired = cur.medium === 'wired';
        const metricNote = (value: string, note: string) =>
          sectionLive && value === '—' ? `not reported by ${cur.plane}` : note;
        const known = (...parts: string[]) => parts.filter((part) => part && part !== '—').join(' · ') || '—';

        /* The per-client detail read for THIS drawer (undefined = still in
         * flight or never asked; null = asked, nothing usable came back). */
        const det = sectionLive ? (clientDetail[cur.mac] ?? null) : null;
        const secState = (section: ClientDetailSection) => detailState(det?.source, section);
        /* One sentence per outcome. '' means "the detail path said nothing
         * about this", and the caller keeps the existing poll-level wording. */
        const detailNote = (section: ClientDetailSection, whenOk: string, whenEmpty: string): string => {
          switch (secState(section)) {
            case 'ok':
              return whenOk;
            case 'empty':
              return whenEmpty;
            case 'failed':
              return det?.source.note ? `read failed — ${det.source.note}` : 'detail read did not complete';
            default:
              return '';
          }
        };
        const roamWindow = windowPhrase(det?.roamsWindowSec);

        const rssiNum = typeof det?.rssi === 'number' ? det.rssi : null;
        const tputNum = typeof det?.tput === 'number' ? det.tput : null;
        const roamsNum = typeof det?.roams === 'number' ? det.roams : null;

        /* The AP radio this client is actually on. Central models retries and
         * the noise floor per RADIO, so these are the only honest source for
         * the Retries row and for a signal figure at all — and both must be
         * labelled as what they are, not passed off as client readings. */
        const radio = det?.servingRadio ?? null;
        const radioRetries = typeof radio?.retries === 'number' ? radio.retries : null;
        /* Signal is arithmetic (SNR + noise floor) when it matches the two
         * reported figures — a roam event's own rssi is a plane reading and
         * keeps the plain label. */
        const rssiDerived =
          rssiNum !== null && rssiNum === deriveRssiDbm(metricNum(cur.snr), radio?.noiseFloorDbm);
        /* Central's client schema has NO rssi: the one per-client rssi in its
         * whole spec is a roam-event row, so a client that never moves has no
         * sample to miss. Say that instead of implying a dropped reading. */
        const noSignalNote =
          planeKeyOf(cur.plane) === 'central'
            ? `${cur.plane} reports signal only on a roam`
            : `no signal sample in ${roamWindow}`;

        /* Where it is — the site/zone/group correction.
         * A plane that has no such concept must not be shown a dash that reads
         * as "the plane failed to report it": Central places a client by SITE
         * and models neither a zone nor a per-client config group, so those
         * rows are dropped and the reason is stated once, underneath. Demo
         * fixtures are authored and complete, so they render verbatim. */
        const placeNotes: string[] = [];
        const place: { k: string; v: string; muted: boolean }[] = [];
        const addPlace = (
          k: string,
          field: Parameters<typeof clientFieldProvenance>[1],
          value: string,
          present: (v: string) => string = (v) => v,
        ) => {
          if (!sectionLive) {
            place.push({ k, v: present(value), muted: false });
            return;
          }
          const prov = clientFieldProvenance(cur.plane, field, value);
          if (prov.kind === 'unsupported') {
            placeNotes.push(`${prov.note}.`);
            return;
          }
          place.push({
            k,
            v: prov.kind === 'present' ? present(value) : prov.note,
            muted: prov.kind !== 'present',
          });
        };
        place.push({ k: 'Site', v: cur.siteName, muted: false });
        addPlace('Zone', 'zone', cur.zone);
        addPlace('Group', 'group', cur.group, (v) => `${v} — config group`);
        place.push({ k: 'Attached to', v: known(cur.attach, cur.where), muted: false });
        /* Wiring is the AP's own uplink off the plane's site topology — the
         * switch and port it is patched into. Without that link the fixture
         * closet string is all there is, and it stays honestly blank. */
        if (det?.wiring) {
          place.push({
            k: 'Wiring',
            v: known(det.wiring.switchName, det.wiring.port),
            muted: false,
          });
        } else {
          addPlace('Wiring', 'closet', cur.closet);
        }

        /* Path to the internet. pathFor() stitches the DEMO topology; for a
         * live client it would fabricate hops through devices the estate does
         * not have (sw-core-a, gw-edge-1…), so a live chain may only come from
         * the plane's own site graph. */
        const topo = sectionLive ? (siteTopology[cur.siteId] ?? null) : null;
        const live = sectionLive ? (topo ? livePathFor(cur, topo) : null) : null;
        const path = sectionLive ? (live?.hops ?? []) : pathFor(cur);
        const weakHops = path.filter((h) => h.tone === 'warning' || h.tone === 'danger').length;
        const hopsMeta = `${path.length} HOPS${weakHops ? ` · ${weakHops} DEGRADED` : ' · ALL HEALTHY'}`;
        const topoState = detailState(topo?.source, 'nodes');
        const pathMeta = !sectionLive
          ? hopsMeta
          : path.length
            ? `${hopsMeta} · ${cur.plane} TOPOLOGY`
            : topoState === 'failed'
              ? 'TOPOLOGY READ FAILED'
              : live?.reason === 'not-on-graph'
                ? 'ATTACH POINT NOT ON GRAPH'
                : live?.reason === 'no-graph' || topoState === 'empty'
                  ? 'SITE GRAPH EMPTY'
                  : 'NO TOPOLOGY SOURCE';
        const pathEmpty =
          topoState === 'failed'
            ? `The site graph read did not complete${
                topo?.source.note ? ` — ${topo.source.note}` : ''
              }. Nothing is drawn rather than a guessed chain.`
            : live?.reason === 'not-on-graph'
              ? `${cur.plane} returned the site graph but does not place ${cur.attach} on it, so the portal will not guess this client's uplink.`
              : live?.reason === 'no-graph' || topoState === 'empty'
                ? `${cur.plane} reports no link topology for ${cur.siteName}.`
                : 'No linked topology source reported a path for this live client. The portal will not substitute the demo topology.';
        /* The chain stops where the plane's knowledge stops. Central reports
         * internet=false on every node of this estate, so say that instead of
         * drawing an internet hop nobody reported. */
        const pathNote =
          live?.reason === 'ok' && live.end && live.end.internet !== true
            ? `${cur.plane}'s site graph ends at ${live.end.name} — it does not report the upstream internet path.`
            : live?.reason === 'no-uplink' && path.length
              ? `${cur.plane} places ${cur.attach} on the site graph but reports no gateway beyond it.`
              : null;

        /* Session timeline. "Fetched and genuinely empty" (a stationary camera
         * has no roaming events) is not "nothing was fetched". */
        const timelineState = secState('timeline');
        const timeline = sectionLive
          ? timelineState === 'ok'
            ? timelineRowsFrom(det?.timeline ?? [], cur.plane)
            : []
          : timelineFor(cur);
        const timelineMeta = !sectionLive
          ? 'STITCHED ACROSS PLANES'
          : timeline.length
            ? `${timeline.length} EVENT${timeline.length === 1 ? '' : 'S'} · ${cur.plane}`
            : timelineState === 'empty' || timelineState === 'ok'
              ? `NO EVENTS IN ${(formatWindow(det?.roamsWindowSec) ?? 'THE WINDOW').toUpperCase()}`
              : timelineState === 'failed'
                ? 'SESSION READ FAILED'
                : 'NO PLANE SESSION EVENTS';
        const timelineEmpty =
          timelineState === 'empty' || timelineState === 'ok'
            ? `${cur.plane} answered for this client and reported no roaming or session events in ${roamWindow}. That is an empty result, not a failed read.`
            : timelineState === 'failed'
              ? `The session read did not complete${
                  det?.source.note ? ` — ${det.source.note}` : ''
                }. Nothing is shown rather than a stale or invented timeline.`
              : 'No linked plane reported session events for this client. The portal will not substitute the demo timeline.';

        return {
          summary: sectionLive ? known(cur.model, cur.siteName) : known(cur.role, cur.group, cur.siteName),
          metrics: [
            {
              k: 'Signal',
              v: rssiNum !== null ? dbm(rssiNum) : cur.rssi,
              note: wired
                ? 'wired link'
                : rssiDerived
                  ? 'derived from SNR + noise floor'
                  : detailNote('rssi', 'target ≥ −67 dBm', noSignalNote) ||
                    metricNote(cur.rssi, 'target ≥ −67 dBm'),
              color: warn(rssiNum !== null ? rssiNum < -67 : cur.rssi !== '—' && metricNum(cur.rssi) < -67),
            },
            {
              k: 'SNR',
              /* Radio metrics on a wired session: the plane did not fail to
               * report them, there is no radio to report. Blaming the plane
               * for a figure the link cannot have is the same lie as blaming
               * it for a zone it does not model. */
              v: cur.snr,
              note: wired ? 'not applicable to wired links' : metricNote(cur.snr, 'target ≥ 25 dB'),
              color: warn(cur.snr !== '—' && metricNum(cur.snr) < 25),
            },
            {
              k: 'Retries',
              v: radioRetries !== null ? `${radioRetries}%` : cur.retries,
              note: wired
                ? 'not applicable to wired links'
                : radio
                  ? `${servingRadioLabel(radio)} — the radio's, not this client's`
                  : metricNote(cur.retries, 'target under 8%'),
              color: warn(
                radioRetries !== null
                  ? radioRetries > 8
                  : cur.retries !== '—' && metricNum(cur.retries) > 8,
              ),
            },
            {
              k: 'Throughput',
              v: tputNum !== null ? formatBps(tputNum) : cur.tput,
              /* Central reports usage totals over a window, never an
               * instantaneous rate — label the average as an average. */
              note:
                detailNote(
                  'tput',
                  `avg over ${formatWindow(det?.tputWindowSec) ?? 'the read window'}`,
                  `no usage samples in ${windowPhrase(det?.tputWindowSec)}`,
                ) || metricNote(cur.tput, 'current rate'),
              color: warn(false),
            },
            {
              k: 'Roams',
              v: roamsNum !== null ? String(roamsNum) : cur.roams,
              note:
                detailNote(
                  'roams',
                  roamsNum === 0 ? `no roaming in ${roamWindow}` : `in ${roamWindow}`,
                  `no roaming in ${roamWindow}`,
                ) ||
                (wired ? 'not applicable to wired links' : metricNote(cur.roams, 'this session')),
              color: warn(roamsNum !== null ? roamsNum > 8 : parseInt(cur.roams, 10) > 8),
            },
            {
              k: 'IP',
              v: cur.ip,
              // Fixtures store the VLAN already prefixed ('vlan 820'); Central
              // reports the bare id ('200'). One label, no stutter.
              note: vlanNumber(cur.vlan) ? `VLAN ${vlanNumber(cur.vlan)}` : metricNote(cur.vlan, 'VLAN'),
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
          place,
          placeNotes,
          /* The section meta named the config group; for a plane that has no
           * per-client group, name what it does place the client by. */
          placeMeta: sectionLive && cur.group === '—' ? cur.siteName : cur.group,
          path,
          pathMeta,
          pathEmpty,
          pathNote,
          timeline,
          timelineMeta,
          timelineEmpty,
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
            <span
              style={{
                fontFamily: 'var(--nd-font-mono)',
                fontSize: 'var(--nd-text-10)',
                color: 'var(--nd-text-muted)',
                letterSpacing: '.08em',
              }}
            >
              {stamp}
            </span>
            {data.blended?.includes('clients') ? <Badge tone="info">LIVE</Badge> : null}
            <Button variant="ghost" size="sm" onClick={() => navigate('/auth-events')}>
              Auth events →
            </Button>
            <Button variant="secondary" size="sm" onClick={exportCsv}>
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
          {`${rows.length} of ${clients.length} sampled${
            unverifiedCount ? ` · ${unverifiedCount} unverified` : ''
          }${sectionLive ? '' : ' · 4,982 live sessions'}`}
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
                {/* 'unverified' is not a health word — it means the plane that
                    owns this session is behind and did not re-confirm it, so
                    the row is last-good, never current (design rule 1). */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <Badge tone={c.healthTone} dot>
                    {c.health}
                  </Badge>
                  {isUnverified(c) ? (
                    <span
                      style={{
                        fontFamily: 'var(--nd-font-mono)',
                        fontSize: 'var(--nd-text-10)',
                        color: 'var(--nd-text-muted)',
                      }}
                    >
                      {c.plane} behind
                    </span>
                  ) : null}
                </div>
              </Table.Cell>
              <Table.Cell numeric>{c.session}</Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table>

      {/* No sessions at all and no sessions past the filter are different facts —
          blaming a filter the operator never set hides a missing plane. */}
      {rows.length === 0 ? (
        clients.length === 0 ? (
          <EmptyState
            title="No sessions from any linked plane"
            description={
              sectionLive
                ? 'No plane reported a client on the last poll — check Connected systems.'
                : 'Nothing is associated across the linked planes.'
            }
          >
            {sectionLive ? (
              <Button variant="secondary" size="sm" onClick={() => navigate('/systems')}>
                Connected systems
              </Button>
            ) : null}
          </EmptyState>
        ) : (
          <EmptyState
            title="Nothing matches that filter"
            description="Loosen the filters or clear Problems only to see more sessions."
          />
        )
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

            {isUnverified(cur) ? (
              <div
                style={{
                  fontFamily: 'var(--nd-font-mono)',
                  fontSize: 'var(--nd-text-11)',
                  color: 'var(--nd-text-muted)',
                  lineHeight: 1.6,
                  padding: '10px 12px',
                  border: '1px solid var(--nd-border-default)',
                  background: 'var(--nd-bg-raised)',
                }}
              >
                {cur.plane} is behind, so this session was not re-confirmed on the last poll. Every
                figure below is last-good at pull time, not current — treat it as unverified.
              </div>
            ) : null}

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
              <SectionHeader label="Where it is" meta={drawer.placeMeta} />
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
                      color: p.muted ? 'var(--nd-text-muted)' : 'var(--nd-text-secondary)',
                    }}
                  >
                    {p.v}
                  </span>
                </div>
              ))}
              {/* A field the plane has no concept of gets an explanation, not a
                  dash that blames the plane for never modelling it. */}
              {drawer.placeNotes.length ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 3, paddingTop: 8 }}>
                  {drawer.placeNotes.map((note) => (
                    <span
                      key={note}
                      style={{
                        fontFamily: 'var(--nd-font-mono)',
                        fontSize: 'var(--nd-text-10)',
                        color: 'var(--nd-text-muted)',
                        lineHeight: 1.6,
                      }}
                    >
                      {note}
                    </span>
                  ))}
                </div>
              ) : null}
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
                  {drawer.pathEmpty}
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
              {drawer.pathNote ? (
                <span
                  style={{
                    fontFamily: 'var(--nd-font-mono)',
                    fontSize: 'var(--nd-text-10)',
                    color: 'var(--nd-text-muted)',
                    lineHeight: 1.6,
                  }}
                >
                  {drawer.pathNote}
                </span>
              ) : null}
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
                  {drawer.timelineEmpty}
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
