/**
 * web/src/screens/Clients.tsx — every session, wired and wireless.
 * High-fidelity port of design/NtClients.dc.html: 5-Stat row, local AND filter
 * row (search / medium / type / site / group / plane / "Problems only") with
 * the right-aligned mono count, the open table, and the width="lg"
 * client drawer (state badges, Experience metrics + quality Progress,
 *
 * The table is one fact per column and one line per session. The prototype
 * stacked pairs — type over model, role over VLAN, auth over authenticator —
 * which made every row two lines tall and put values where they could not be
 * compared down a column. Columns are built through
 * ./dataColumns partitionColumns(), so any column every visible session
 * answers identically (one site, one plane, all connected) is stated once
 * under the table instead of repeated on all of them, and comes back the
 * moment one session disagrees.
 *
 * The table itself is the nightdesk DataTable: the column manager (View
 * options → show/hide/reorder, header-edge resize) persists its controlled
 * config through SettingsContext under the 'clients' table id, and the rows
 * are a keyboard grid (j/↓ k/↑ move, Enter/→ opens the client drawer — the
 * row's one primary action — x selects, Esc clears; '?' lists them). No
 * column tints: a session's health already wears its tone as a Badge, and no
 * other column has a threshold that is the same fact down the column (the
 * same call Devices made).
 *
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
  Alert,
  Badge,
  Button,
  DATATABLE_ROW_SHORTCUTS,
  DataTable,
  Drawer,
  EmptyState,
  FormField,
  Input,
  KeyboardShortcuts,
  Progress,
  SectionHeader,
  Select,
  PageSkeleton,
  Spinner,
  Switch,
  TableViewOptions,
  useToast,
} from '../nightdesk';
import type { DataTableColumn } from '../nightdesk';
import {
  blockClient,
  disconnectClient,
  getClientDetailBlock,
  getClients,
  getSiteApplications,
  getSiteTopology,
  getTickets,
} from '../api/client';
import type { ClientDetailBlock, ClientsData, SiteApplicationsResult } from '../api/client';
import { VisualReferencePanel } from '../components/VisualReferencePanel';
import { ConfigActionPanel } from '../components/ConfigActionPanel';
import { ClientCategoryBadges } from '../components/ClientCategoryBadges';
import { ConfigRecommendationsPanel } from '../components/ConfigRecommendationsPanel';
import { getTaxonomySummary } from '../api/recommendations';
import type { CategoryBucket } from '@hpe/shared';
import { partitionColumns, SharedFacts } from './dataColumns';
import type { DataColumn } from './dataColumns';
import { useSettings } from '../app/SettingsContext';
import { planeFilterForParam } from '../app/nav';
import {
  clientFieldProvenance,
  clientPlaneSections,
  demoClient360World,
  deriveRssiDbm,
  detailState,
  pathFor,
  planeKeyOf,
  timelineFor,
  hhmmLocal as hhmm,
  countOf,
  formatCount,
} from '@hpe/shared';
import type {
  ClientDetailSection,
  ClientPlaneSection,
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
  UsageSample,
} from '@hpe/shared';
import { ScreenHeader } from './ScreenHeader';
import { ApiErrorState } from './ApiErrorState';
import { StatRow } from './StatRow';

const MEDIUM_OPTIONS = [
  { value: 'all', label: 'Wired + wireless' },
  { value: 'wireless', label: 'Wireless' },
  { value: 'wired', label: 'Wired' },
];

/** Numeric value of a metric string; fixtures use U+2212 for negative dBm. */
function metricNum(s: string): number {
  return parseFloat(s.replace(/−/g, '-'));
}

/**
 * A session the route could not re-confirm this cycle. The /clients handler
 * rewrites rows from a plane the registry considers behind to health
 * 'unverified' (design rule 1 — an aged cache is not a current session), so the
 * screen must show that as a state, not as one more health word.
 */
/**
 * A plane's "nothing here" marker, read as absent.
 *
 * The rows arrive with '—' where a plane reported no value, so a column every
 * session leaves blank is 39 identical dashes — which would otherwise collapse
 * into the sentence "Group —", a fact about nothing. Treated as absent it
 * simply drops.
 */
function reported(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (trimmed === '' || trimmed === '—' || trimmed === '–' || trimmed === '-') return null;
  return trimmed;
}

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
 * getClientDetailBlock / getSiteTopology, issued once per object while its
 * drawer is open — and a rejection is swallowed into the honest empty state
 * below rather than into a fabricated number. The block also carries the
 * Client 360 sections, which cost no plane call at all: they are a join over
 * rows the poll already fetched.
 */
async function readClientBlock(mac: string): Promise<ClientDetailBlock | null> {
  return (await getClientDetailBlock(mac).catch(() => null)) ?? null;
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

/**
 * What the averaged throughput figure leaves out.
 *
 * Central reports usage as byte totals per fixed sampling bucket, and the
 * server divides the lot by the window. A client that saturated its radio for
 * five minutes and did nothing for the remaining three hours averages out to
 * almost nothing — which is the shape of every complaint that brings someone
 * to this drawer in the first place. The buckets are read, cached and shipped
 * here already; only the average was ever drawn.
 *
 * The bucket rate is itself an average over one interval, so it is worded as
 * the busiest sample rather than as a peak rate the plane never measured.
 *
 * A bucket the plane reported with neither figure is a reading that is not
 * there, not a quiet one, and is skipped rather than counted as a zero.
 */
function usagePeakAndSplit(
  samples: UsageSample[] | undefined,
  windowSec: number | null | undefined,
): string[] {
  if (!samples || samples.length === 0) return [];
  if (typeof windowSec !== 'number' || !Number.isFinite(windowSec) || windowSec <= 0) return [];
  const intervalSec = windowSec / samples.length;
  if (!Number.isFinite(intervalSec) || intervalSec <= 0) return [];

  let peakBytes: number | null = null;
  let tx = 0;
  let rx = 0;
  let reported = 0;
  for (const sample of samples) {
    const hasTx = typeof sample.txBytes === 'number' && Number.isFinite(sample.txBytes);
    const hasRx = typeof sample.rxBytes === 'number' && Number.isFinite(sample.rxBytes);
    if (!hasTx && !hasRx) continue;
    reported += 1;
    const sampleTx = hasTx ? sample.txBytes! : 0;
    const sampleRx = hasRx ? sample.rxBytes! : 0;
    tx += sampleTx;
    rx += sampleRx;
    const total = sampleTx + sampleRx;
    if (peakBytes === null || total > peakBytes) peakBytes = total;
  }
  if (reported === 0 || peakBytes === null) return [];

  const out = [`busiest ${formatWindow(intervalSec) ?? 'sample'} ${formatBps((peakBytes * 8) / intervalSec)}`];
  // 'tx' and 'rx' as the plane words them. Calling them up and down would
  // assert a perspective Central's usage endpoint does not state, and getting
  // it backwards is worse than not saying it.
  if (tx > 0 || rx > 0) out.push(`tx ${formatBytes(tx)} / rx ${formatBytes(rx)}`);
  return out;
}

/** Byte totals, as an operator says them. */
function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  if (bytes >= 1e3) return `${Math.round(bytes / 1e3)} kB`;
  return `${Math.round(bytes)} B`;
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
// Client 360 — one client, every plane's own answer
// ---------------------------------------------------------------------------

/** One plane's section of the Client 360 panel, with the render decisions made. */
type Plane360Row = {
  label: string;
  tone: Tone;
  lines: { text: string; muted: boolean }[];
  events: NonNullable<ClientPlaneSection['authEvents']>;
};

function pct(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}

/** Mist's per-classifier SLE line — only the classifiers Mist actually
 *  returned; a null classifier is "no signal", never a 0 (see MistSleRow). */
function sleClassifierLine(sle: NonNullable<ClientPlaneSection['siteSle']>): string | null {
  const parts = nonEmpty([
    sle.coverage !== null ? `coverage ${pct(sle.coverage)}` : null,
    sle.capacity !== null ? `capacity ${pct(sle.capacity)}` : null,
    sle.roaming !== null ? `roaming ${pct(sle.roaming)}` : null,
    sle.apHealth !== null ? `AP health ${pct(sle.apHealth)}` : null,
    sle.wan !== null ? `WAN ${pct(sle.wan)}` : null,
  ]);
  return parts.length > 0 ? parts.join(' · ') : null;
}

/**
 * A present section shows the plane's OWN rows — its session, its endpoint
 * record, its recent decisions, its site SLE — never a merged guess; an
 * absent section shows the one honest reason, muted. The section's `reason`
 * rides along as a qualifier line whenever the server sent one.
 */
function plane360Row(section: ClientPlaneSection): Plane360Row {
  if (section.state !== 'ok') {
    return {
      label: section.label,
      tone: 'neutral',
      lines: [{ text: section.reason ?? 'not reported', muted: true }],
      events: [],
    };
  }
  const lines: Plane360Row['lines'] = [];
  if (section.session) {
    const s = section.session;
    lines.push({
      text:
        nonEmpty([
          s.health,
          reported(s.attach) ? `on ${s.attach}` : null,
          reported(s.where),
          reported(s.session) ? `session ${s.session}` : null,
        ]).join(' · ') || 'session reported',
      muted: false,
    });
  }
  if (section.endpoint) {
    const e = section.endpoint;
    lines.push({
      text: nonEmpty([
        `endpoint ${e.status.toLowerCase()}`,
        e.hostname,
        e.os ?? e.family ?? e.category,
        e.profile ? `profile ${e.profile}` : null,
        e.updatedAt ? `updated ${e.updatedAt}` : null,
      ]).join(' · '),
      muted: false,
    });
  }
  if (section.siteSle) {
    const sle = section.siteSle;
    lines.push({
      text: nonEmpty([
        sle.overall !== null ? `site SLE ${pct(sle.overall)}` : 'site SLE reported',
        sle.siteName,
      ]).join(' · '),
      muted: false,
    });
    const classifiers = sleClassifierLine(sle);
    if (classifiers) lines.push({ text: classifiers, muted: true });
  }
  if (section.reason) lines.push({ text: section.reason, muted: true });
  return {
    label: section.label,
    tone: section.session?.planeTone ?? 'neutral',
    lines,
    events: section.authEvents ?? [],
  };
}

// ---------------------------------------------------------------------------
// Managed-device adjacency, from the plane's own site graph
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

/** One physical link as reported by the plane; topology does not prove traffic direction. */
function linkFact(link: TopologyLink, forward: boolean): string {
  const near = (forward ? link.fromPorts : link.toPorts).map((p) => p.name).filter(Boolean);
  const far = (forward ? link.toPorts : link.fromPorts).map((p) => p.name).filter(Boolean);
  return nonEmpty([
    near.length || far.length ? `${near.join('+') || '?'} ↔ ${far.join('+') || '?'}` : null,
    typeof link.speedBps === 'number' && link.speedBps > 0 ? formatBps(link.speedBps) : null,
    link.health && link.health.toLowerCase() !== 'good' ? `link ${link.health.toLowerCase()}` : null,
  ]).join(' · ');
}

type LivePath = {
  hops: PathHopView[];
  /** Why the chain looks the way it does — the drawer says each differently. */
  reason: 'ok' | 'wired-attachment' | 'no-graph' | 'not-on-graph' | 'no-uplink';
  /** The node the chain ends on, when it ended on one. */
  end: TopologyDeviceNode | null;
};

/**
 * Walk the plane's own site graph from a wireless client's AP out to the
 * nearest managed gateway. A wired client stops at its reported attachment
 * switch because extending it would invent a routing claim. In both cases this
 * is physical adjacency, not an assertion about internet egress.
 * Every node and segment comes directly from the plane's topology response.
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

  /* Breadth-first finds the shortest physical adjacency chain. It does not
     assert that client traffic follows that chain. */
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
  // A wired row proves only the client-facing switch and port. Walking from
  // that switch to the nearest managed gateway would turn physical adjacency
  // into an invented routing claim (and can contradict a third-party
  // 9400 → 6300 → OPNsense path that the managed graph does not contain).
  const target =
    client.medium === 'wired'
      ? undefined
      : nodes
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
  return {
    hops: decorate(hops),
    reason: target ? 'ok' : client.medium === 'wired' ? 'wired-attachment' : 'no-uplink',
    end,
  };
}

/** Stable column-manager ids for the partitioned columns. The DataColumn key
 *  is the display label; the manager persists against these slugs instead, so
 *  a label tweak never orphans a saved layout. */
const CLIENT_COLUMN_IDS: Record<string, string> = {
  Type: 'type',
  Model: 'model',
  IP: 'ip',
  Site: 'site',
  Group: 'group',
  'Connected to': 'connectedTo',
  'Port / SSID': 'where',
  Link: 'link',
  Plane: 'plane',
  Sources: 'sources',
  Auth: 'auth',
  'Auth by': 'authBy',
  Role: 'role',
  VLAN: 'vlan',
  Health: 'health',
  Signal: 'signal',
  SNR: 'snr',
  Retries: 'retries',
  Throughput: 'throughput',
  Roams: 'roams',
  Quality: 'quality',
  Session: 'session',
};

/** Session strings ('41d', '2h 14m', '19m') → sortable seconds. An unreadable
 *  or unreported value is null — it sorts last, never as zero-length. */
function sessionSortSec(value: string | null): number | null {
  if (!value) return null;
  const day = /(\d+)\s*d/.exec(value);
  const hour = /(\d+)\s*h/.exec(value);
  const min = /(\d+)\s*m(?!s)/.exec(value);
  const sec = /(\d+)\s*s/.exec(value);
  if (!day && !hour && !min && !sec) return null;
  return (
    (day ? Number(day[1]) * 86400 : 0) +
    (hour ? Number(hour[1]) * 3600 : 0) +
    (min ? Number(min[1]) * 60 : 0) +
    (sec ? Number(sec[1]) : 0)
  );
}

export default function Clients() {
  const navigate = useNavigate();
  const { density, showPlatformTags, pollIntervalSec, tableColumns, setTableColumns } = useSettings();
  const { toast } = useToast();
  const [data, setData] = useState<ClientsData | null>(null);
  /* Row selection for the table's keyboard grid. Nothing on this screen
     consumes the selection yet — the same controlled-props wiring the Devices
     reference integration runs for the change-queue bulk-actions work. */
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  const [searchParams, setSearchParams] = useSearchParams();
  const [q, setQ] = useState('');
  const [medium, setMedium] = useState('all');
  const [type, setType] = useState('all');
  const [site, setSite] = useState('all');
  const [group, setGroup] = useState('all');
  const [plane, setPlane] = useState(() => planeFilterForParam(searchParams.get('plane')));
  const [problemsOnly, setProblemsOnly] = useState(false);
  const [expandedSources, setExpandedSources] = useState<Record<string, boolean>>({});
  const [showDiagnostics, setShowDiagnostics] = useState(() => searchParams.get('diagnostics') === '1');
  const [clientTypeBuckets, setClientTypeBuckets] = useState<CategoryBucket[]>([]);

  /* The header stamps SYNCED hh:mm, so a NOC tab must not sit on a mount-time
     snapshot under it: poll on the settings cadence, the same pattern
     Overview.tsx runs. One fetch at a time — a slow response never stacks up
     behind the interval; fixture reads poll harmlessly. Live lists page at 250. */
  const clientsAccRef = useRef<ClientRow[]>([]);
  const nextClientCursorRef = useRef<string | null>(null);
  const loadMoreClientsRef = useRef<() => void>(() => {});
  const [clientHasMore, setClientHasMore] = useState(false);
  const [clientPageTotal, setClientPageTotal] = useState<number | null>(null);
  const [loadingMoreClients, setLoadingMoreClients] = useState(false);
  const CLIENT_PAGE = 250;

  useEffect(() => {
    let live = true;
    let inFlight = false;
    const pull = (mode: 'replace' | 'append' = 'replace') => {
      if (mode === 'replace' && inFlight) return;
      if (mode === 'append' && !nextClientCursorRef.current) return;
      if (mode === 'replace') inFlight = true;
      if (mode === 'append') setLoadingMoreClients(true);
      void getClients({
        limit: CLIENT_PAGE,
        ...(mode === 'append' && nextClientCursorRef.current
          ? { cursor: nextClientCursorRef.current }
          : {}),
      })
        .then((d) => {
          if (!live) return;
          if (mode === 'append') {
            const seen = new Set(clientsAccRef.current.map((r) => r.mac));
            const extra = d.clients.filter((r) => !seen.has(r.mac));
            const merged = [...clientsAccRef.current, ...extra];
            clientsAccRef.current = merged;
            setData({ ...d, clients: merged });
          } else {
            clientsAccRef.current = d.clients;
            setData(d);
          }
          nextClientCursorRef.current = d.page?.nextCursor ?? null;
          setClientHasMore(Boolean(d.page?.nextCursor));
          setClientPageTotal(d.page?.total ?? null);
        })
        .finally(() => {
          if (mode === 'replace') inFlight = false;
          if (mode === 'append') setLoadingMoreClients(false);
        });
      if (mode === 'replace') {
        void getTaxonomySummary()
          .then((t) => {
            if (live) setClientTypeBuckets(t.clients.byType);
          })
          .catch(() => {
            /* optional enrichment */
          });
      }
    };
    loadMoreClientsRef.current = () => pull('append');
    pull('replace');
    const every = Math.max(pollIntervalSec, 10) * 1000;
    const id = setInterval(() => pull('replace'), every);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, [pollIntervalSec]);

  /* Deep link: /clients?plane=<registryId> (from the Systems plane drawer).
     Applied when the URL changes while the screen is mounted — state adjusted
     during render rather than an effect that commits the stale filter first. */
  const [prevParams, setPrevParams] = useState(searchParams);
  if (prevParams !== searchParams) {
    setPrevParams(searchParams);
    const pp = searchParams.get('plane');
    if (pp !== null) setPlane(planeFilterForParam(pp));
  }

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

  /* The confirm block closes when the drawer selection changes — adjusted
     during render so it never commits open against the wrong client. */
  const [prevMacParam, setPrevMacParam] = useState(macParam);
  if (prevMacParam !== macParam) {
    setPrevMacParam(macParam);
    setCoaOpen(false);
    setCoaTicket('');
    setShowDiagnostics(false);
  }

  /* Detail reads for the open drawer. Keyed by object, so a result that lands
   * after the operator moved on is filed, not raced; asked-for keys live in a
   * ref so a re-render (or StrictMode's double effect) cannot re-issue a call.
   * `null` = we asked and got nothing usable — an honest empty state, not an
   * excuse to substitute demo data. */
  const sectionLive = data
    ? data.dataSource === 'live' || (data.blended?.includes('clients') ?? false)
    : false;
  const [clientBlock, setClientBlock] = useState<Record<string, ClientDetailBlock | null>>({});
  const [siteTopology, setSiteTopology] = useState<Record<string, SiteTopologyLive | null>>({});
  const detailAsked = useRef(new Set<string>());
  const topologyAsked = useRef(new Set<string>());
  /* The Central client's site DPI table — the same on-demand read the site
   * page's application-visibility section runs, keyed by site so two drawers
   * at one site share it. Central's table is SITE-WIDE: it is not filtered
   * to this MAC, and the 360 line says so rather than attribute site traffic
   * to one client. */
  const [siteApps, setSiteApps] = useState<Record<string, SiteApplicationsResult>>({});
  const appsAsked = useRef(new Set<string>());

  useEffect(() => {
    /* Demo fixtures are authored and complete — nothing to fetch for them. */
    if (!macParam || !sectionLive) return;
    if (detailAsked.current.has(macParam)) return;
    detailAsked.current.add(macParam);
    void readClientBlock(macParam).then((block) => {
      setClientBlock((cache) => ({ ...cache, [macParam]: block }));
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

  /* The site DPI read behind the 360's Central line. Lazy on drawer open,
   * once per site per mount — and asked in demo too, where the route (or the
   * client's own fixture mirror) serves the authored table. */
  useEffect(() => {
    if (!data || !macParam) return;
    const client = data.clients.find((c) => c.mac === macParam);
    if (!client || planeKeyOf(client.plane) !== 'central') return;
    const siteId = client.siteId;
    if (!siteId || appsAsked.current.has(siteId)) return;
    appsAsked.current.add(siteId);
    void getSiteApplications(siteId)
      .then((r) => {
        setSiteApps((cache) => ({ ...cache, [siteId]: r }));
      })
      .catch(() => {
        setSiteApps((cache) => ({
          ...cache,
          [siteId]: { kind: 'failed', message: 'the application read failed' },
        }));
      });
  }, [data, macParam]);

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
    return <PageSkeleton variant="list" />;
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
  // Linked planes that returned no session list at all. `[]` from a plane is a
  // real answer (nobody associated); no answer is not, and the two must not
  // collapse into the same roster.
  const missingSources = data.missingSources ?? [];
  const ql = q.trim().toLowerCase();
  const rows = clients.filter(
    (c) =>
      (medium === 'all' || c.medium === medium) &&
      (type === 'all' || c.type === type) &&
      (plane === 'all' || c.plane === plane || c.sources?.some((source) => source.row.plane === plane)) &&
      (site === 'all' || c.siteName === site) &&
      (group === 'all' || c.group === group) &&
      (!problemsOnly || c.problem) &&
      (!ql || (c.name + c.model + c.mac + c.ip + c.attach + c.group).toLowerCase().includes(ql)),
  );

  /* One column per fact, not two facts stacked in one cell. The stacked form
     made every row two lines tall for values that are usually short, and it
     put the type above the model and the role above the VLAN where neither
     could be compared down its own column. Columns whose every session answers
     the same — one site, one plane, everything connected — are stated once
     under the table instead of repeated on all of them. */
  const columns: Array<DataColumn<ClientRow>> = [
    {
      key: 'Type',
      value: (c) => reported(c.type),
      nowrap: true,
      render: (c) => <ClientCategoryBadges type={c.type} model={c.model} compact />,
    },
    { key: 'Model', value: (c) => reported(c.model) },
    { key: 'IP', value: (c) => reported(c.ip), mono: true, nowrap: true },
    { key: 'Site', value: (c) => reported(c.siteName) },
    { key: 'Group', value: (c) => reported(c.group), mono: true },
    {
      key: 'Connected to',
      value: (c) => reported(c.attach),
      render: (c) => (
        <button
          type="button"
          className="nt-clients-table__link"
          onClick={(e) => {
            e.stopPropagation();
            navigate(`/devices/${encodeURIComponent(c.attach)}`);
          }}
        >
          {c.attach}
        </button>
      ),
    },
    { key: 'Port / SSID', value: (c) => reported(c.where), mono: true },
    { key: 'Link', value: (c) => reported(c.link), mono: true, nowrap: true },
    ...(showPlatformTags
      ? [
          {
            key: 'Plane',
            value: (c: ClientRow) => reported(c.plane),
            render: (c: ClientRow) => <Badge plane>{c.plane}</Badge>,
          },
        ]
      : []),
    {
      key: 'Sources',
      value: (c: ClientRow) => c.sources?.map((source) => source.row.plane).join(', ') ?? c.plane,
      render: (c: ClientRow) => {
        const sources = c.sources ?? [];
        if (sources.length < 2) return <Badge plane>{c.plane}</Badge>;
        const expanded = expandedSources[c.mac] === true;
        const labels = sources.map((source) => source.row.plane);
        return (
          <div className="nt-col-start">
            <button
              type="button"
              className="nt-clients-table__link"
              aria-expanded={expanded}
              onClick={(e) => {
                e.stopPropagation();
                setExpandedSources((current) => ({ ...current, [c.mac]: !expanded }));
              }}
            >
              {`${labels.map((label) => label[0] + label.slice(1).toLowerCase()).join(' · ')} · ${expanded ? 'hide' : 'show'} ${sources.length} sources`}
            </button>
            {expanded
              ? sources.map((source) => (
                  <span key={source.plane} className="nt-cell-mono nt-cell-dim">
                    {`${source.row.plane[0] + source.row.plane.slice(1).toLowerCase()} · ${source.stale ? 'unverified' : 'current'}`}
                  </span>
                ))
              : null}
          </div>
        );
      },
    },
    { key: 'Auth', value: (c) => reported(c.auth), mono: true, nowrap: true },
    { key: 'Auth by', value: (c) => reported(c.authBy), mono: true },
    { key: 'Role', value: (c) => reported(c.role) },
    { key: 'VLAN', value: (c) => reported(c.vlan), mono: true, nowrap: true },
    {
      key: 'Health',
      /* 'unverified' is not a health word — it means the plane that owns this
         session is behind and did not re-confirm it, so the row is last-good,
         never current (design rule 1). It is part of the value so a stale row
         can never collapse into a column of healthy ones. */
      value: (c) => (isUnverified(c) ? `${c.health} · ${c.plane} behind` : reported(c.health)),
      render: (c) => (
        <>
          <Badge tone={c.healthTone} dot>
            {c.health}
          </Badge>
          {isUnverified(c) ? (
            <span className="nt-cell-mono nt-cell-dim nt-clients-table__mac">{c.plane} behind</span>
          ) : null}
        </>
      ),
    },
    { key: 'Session', value: (c) => reported(c.session), numeric: true, nowrap: true },
    { key: 'Signal', value: (c) => reported(c.rssi), mono: true, nowrap: true },
    { key: 'SNR', value: (c) => reported(c.snr), mono: true, nowrap: true },
    { key: 'Retries', value: (c) => reported(c.retries), mono: true, nowrap: true },
    { key: 'Throughput', value: (c) => reported(c.tput), mono: true, nowrap: true },
    { key: 'Roams', value: (c) => reported(c.roams), numeric: true, nowrap: true },
    {
      key: 'Quality',
      value: (c) => (c.quality === null ? null : `${c.quality} / 100`),
      numeric: true,
      nowrap: true,
    },
  ];
  const { shown, shared } = partitionColumns(rows, columns);

  /* The partitioned set as DataTable column defs. 'Client' is the primary
     identifier — always visible, never offered for hiding. A column the
     partition collapsed this render (every visible session answers it
     identically, so it is stated once below the table) simply leaves the
     persisted layout: DataTable ignores config keys the current defs do not
     define, and the column rejoins the moment one session disagrees. */
  const clientColumns: Array<DataTableColumn<ClientRow>> = [
    {
      key: 'client',
      title: 'Client',
      hideable: false,
      sortValue: (c) => c.name,
      render: (c) => (
        <>
          {/* An unnamed client is displayed by its MAC, so printing the MAC
              underneath would print the same string twice and cost a line on
              every such row. */}
          <span className="nt-clients-table__name">{c.name}</span>
          {c.name.trim().toLowerCase() === c.mac.trim().toLowerCase() ? null : (
            <span className="nt-cell-mono nt-cell-dim nt-clients-table__mac">{c.mac}</span>
          )}
        </>
      ),
    },
    ...shown.map((column) => ({
      key: CLIENT_COLUMN_IDS[column.key] ?? column.key,
      title: column.key,
      numeric: column.numeric,
      /* Every column sorts on its text value; Session sorts by real duration,
         not alphabetically ('2h 14m' must outrank '19m'). */
      sortValue:
        column.key === 'Session'
          ? (c: ClientRow) => sessionSortSec(column.value(c))
          : (c: ClientRow) => column.value(c),
      render: (c: ClientRow) => {
        const cell = column.render
          ? column.render(c)
          : (column.value(c) ?? <span className="nt-cell-dim">—</span>);
        /* mono rode the <td> on the compound Table; DataTable owns the td, so
           the same class wraps the value instead — identical type, one level in. */
        return column.mono ? <span className="nt-cell-mono">{cell}</span> : cell;
      },
    })),
  ];

  const typeOptions = [{ value: 'all', label: 'All device types' }].concat(
    uniq(clients, 'type').map((v) => ({ value: v, label: v })),
  );
  /* A unified row has a primary plane for its compact facts, but the normal
     per-product filter must still offer every contributing observation. */
  const sourcePlanes = [...new Set(clients.flatMap((client) => [
    client.plane,
    ...(client.sources?.map((source) => source.row.plane) ?? []),
  ]))];
  const planeOptions = [{ value: 'all', label: 'All planes' }].concat(
    sourcePlanes.map((v) => ({ value: v, label: v })),
  );
  /* A ?plane= deep-link can name a plane that has no rows in this feed.
     Without its own option the Select renders blank and the filter hiding
     every row is invisible and unclearable — so union the active value in. */
  if (plane !== 'all' && !planeOptions.some((o) => o.value === plane)) {
    planeOptions.push({ value: plane, label: `${plane} (no clients)` });
  }
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
    toast(`Exported ${countOf(rows.length, 'session')}`, {
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
        const det = sectionLive ? (clientBlock[cur.mac]?.detail ?? null) : null;
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
        /* Both are about the SAME page: the plane answered with one page of
         * mobility events, and the portal drew a count and a list from it. A
         * stated window total fixes the count and leaves the list short, so
         * the two qualifiers are independent and neither implies the other. */
        const roamsFloor = det?.roamsAtLeast === true;
        const timelineCapped = det?.timelineTruncated === true;

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
          /* Both plurals are drawn, and only when they exist. A single cable
             into a single port reads exactly as it always did; a bundle names
             every member, because shutting one of four drops nothing; and a
             second uplink is counted, because "shut the port and watch it go
             down" is the test this row is read for and a dual-homed AP fails
             it while working perfectly. */
          const w = det.wiring;
          const portText = w.ports && w.ports.length > 1 ? w.ports.join(', ') : w.port;
          const lagText = w.lag?.trim() ? `lag ${w.lag.trim()}` : null;
          const moreText =
            typeof w.otherUplinks === 'number' && w.otherUplinks > 0
              ? `+${countOf(w.otherUplinks, 'further uplink')} on the site graph`
              : null;
          place.push({
            k: 'Wiring',
            v: known(w.switchName, portText, ...(lagText ? [lagText] : []), ...(moreText ? [moreText] : [])),
            muted: false,
          });
          /* The plane's own reading of that uplink. An AP whose port negotiated
           * 100 Mb, or a link the plane no longer calls healthy, is the single
           * likeliest explanation for "the wifi is slow in this corner" — and
           * every client on that AP reports the same complaint. The topology
           * read already carried both figures to the browser; the drawer threw
           * them away one line before the operator could see them, while the
           * physical-links panel on this same screen printed them (linkFact).
           *
           * Worded as the plane words it. This screen does not decide what a
           * healthy AP uplink looks like, and a plane that said nothing is told
           * apart from a plane that said the link is fine. */
          const upSpeed =
            typeof det.wiring.speedBps === 'number' && det.wiring.speedBps > 0
              ? formatBps(det.wiring.speedBps)
              : null;
          const upHealth = det.wiring.linkHealth?.trim() || null;
          const upWhy = det.wiring.linkHealthReason?.trim() || null;
          const uplink = nonEmpty([upSpeed, upHealth && upWhy ? `${upHealth} (${upWhy})` : upHealth]);
          place.push(
            uplink.length
              ? { k: 'Uplink', v: uplink.join(' · '), muted: false }
              : {
                  k: 'Uplink',
                  v: `${cur.plane} reported no speed or health for this link`,
                  muted: true,
                },
          );
        } else {
          addPlace('Wiring', 'closet', cur.closet);
        }

        /* Managed topology. pathFor() stitches the DEMO internet path; for a
         * live client it would fabricate hops through devices the estate does
         * not have (sw-core-a, gw-edge-1…), so a live chain may only come from
         * the plane's own site graph. */
        const topo = sectionLive ? (siteTopology[cur.siteId] ?? null) : null;
        const live = sectionLive ? (topo ? livePathFor(cur, topo) : null) : null;
        const path = sectionLive ? (live?.hops ?? []) : pathFor(cur);
        const weakHops = path.filter((h) => h.tone === 'warning' || h.tone === 'danger').length;
        const hopsMeta = `${path.length} ${sectionLive ? 'NODES' : 'HOPS'}${
          weakHops ? ` · ${weakHops} DEGRADED` : ' · ALL HEALTHY'
        }`;
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
        /* A managed-device graph proves physical adjacency only. It does not
         * identify traffic direction or an internet egress, and third-party
         * routers may not appear in the plane's topology at all. */
        const pathNote =
          live?.reason === 'ok' && live.end
            ? `${cur.plane} reports these managed-device links as physical adjacency, not traffic direction. The internet egress is not identified, and third-party routers may be absent.`
            : live?.reason === 'wired-attachment' && path.length
              ? `${cur.plane} identifies the wired attachment switch and port. The portal does not infer that this session routes through a managed gateway; the internet egress and any third-party 9400 → 6300 → OPNsense path remain separate physical facts.`
            : live?.reason === 'no-uplink' && path.length
              ? `${cur.plane} places ${cur.attach} on the site graph but reports no connected managed gateway. The internet egress is not identified.`
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
            ? `${timelineCapped ? 'NEWEST ' : ''}${countOf(timeline.length, 'EVENT').toUpperCase()} · ${cur.plane}`
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

        /* Client 360 — which planes see this one MAC, and what each says.
         * Live: the sections ride the same ?mac= envelope as the detail read,
         * which lands AFTER the drawer shell — three states, kept distinct:
         * undefined = the read is still in flight (a brief loading state,
         * never a verdict); null = asked, and the route attached nothing (an
         * older server, or the block read failed — the drawer says so rather
         * than guessing); sections = the planes' own answers. Collapsing the
         * first into the second flashed NOT REPORTED for a commit or two on
         * every open. Demo: derived here from the fixtures through the SAME
         * shared correlation the server runs, so the two can never disagree. */
        const block360 = sectionLive ? clientBlock[cur.mac] : null;
        const planes360 = sectionLive
          ? block360 === undefined
            ? undefined
            : (block360?.clientPlanes ?? null)
          : clientPlaneSections(cur.mac, cur.siteId, demoClient360World());
        const planesOk = planes360?.filter((s) => s.state === 'ok').length ?? 0;
        const planesMeta =
          planes360 === undefined
            ? 'CONTACTING PLANES…'
            : planes360 === null
              ? 'NOT REPORTED'
              : `${planesOk} OF ${planes360.length} PLANES REPORT THIS MAC${sectionLive ? '' : ' · DEMO FEED'}`;
        const planeRows = (planes360 ?? []).map(plane360Row);

        /* The 360's Central line: the site's top applications. Lazy — the
         * read lands after the drawer shell, like the 360 sections
         * themselves — and SITE-WIDE: Central's DPI table is not filtered to
         * one MAC, so the line names the site and says it is not per-client
         * rather than attributing site traffic to this client. */
        const apps360Lines: Plane360Row['lines'] = (() => {
          if (planeKeyOf(cur.plane) !== 'central') return [];
          if (!cur.siteId) {
            return [{ text: 'not placed at a site — no site application table to join', muted: true }];
          }
          const r = siteApps[cur.siteId];
          if (r === undefined) return [{ text: 'reading the site application table…', muted: true }];
          if (r.kind === 'not-reported') {
            return [{ text: `no application table reported for ${cur.siteName}`, muted: true }];
          }
          if (r.kind === 'failed') {
            return [{ text: `the application read failed — ${r.message}`, muted: true }];
          }
          const apps = r.applications.apps ?? [];
          const state = detailState(r.applications.source, 'apps');
          if (state === 'ok' && apps.length > 0) {
            const top = apps.slice(0, 3).map((a) => a.name).join(' · ');
            return [
              {
                text: `top applications at ${cur.siteName}: ${top}${apps.length > 3 ? ` · +${countOf(apps.length - 3, 'more')}` : ''}`,
                muted: false,
              },
              { text: 'site-wide DPI — Central does not filter this table to one client', muted: true },
            ];
          }
          if (state === 'failed') {
            return [
              {
                text: `the application read did not complete${r.applications.source.note ? ` — ${r.applications.source.note}` : ''}`,
                muted: true,
              },
            ];
          }
          if (state === 'not-fetched') {
            return [
              {
                text: `the site application table was not fetched${r.applications.source.note ? ` — ${r.applications.source.note}` : ''}`,
                muted: true,
              },
            ];
          }
          return [
            { text: `Central reported no application traffic at ${cur.siteName} in the window`, muted: true },
          ];
        })();

        const throughputMetric = {
          k: 'Throughput',
          v: tputNum !== null ? formatBps(tputNum) : cur.tput,
          /* Central reports usage totals over a window, never an
           * instantaneous rate — label the average as an average. */
          note:
            detailNote(
              'tput',
              [
                `avg over ${formatWindow(det?.tputWindowSec) ?? 'the read window'}`,
                ...usagePeakAndSplit(det?.usageSeries, det?.tputWindowSec),
              ].join(' · '),
              `no usage samples in ${windowPhrase(det?.tputWindowSec)}`,
            ) || metricNote(cur.tput, 'current rate'),
          color: warn(false),
        };
        const metrics = wired
          ? [
              {
                k: 'Switch port',
                v: cur.where,
                note: cur.where === '—' ? metricNote(cur.where, 'access port') : cur.attach,
                color: warn(false),
              },
              {
                k: 'VLAN',
                v: vlanNumber(cur.vlan) ?? cur.vlan,
                note: metricNote(cur.vlan, 'client VLAN'),
                color: warn(false),
              },
              throughputMetric,
              {
                k: 'Session',
                v: cur.session,
                note: metricNote(cur.session, 'connected duration'),
                color: warn(false),
              },
              {
                k: 'Authentication',
                v: cur.auth,
                note:
                  cur.authBy !== '—'
                    ? `authenticated by ${cur.authBy}`
                    : metricNote(cur.auth, 'access authentication'),
                color: warn(false),
              },
              {
                k: 'IP',
                v: cur.ip,
                note: 'client address',
                color: warn(cur.ip === 'pending' || cur.ip === '—'),
              },
            ]
          : [
              {
                k: 'Signal',
                v: rssiNum !== null ? dbm(rssiNum) : cur.rssi,
                note: rssiDerived
                  ? 'derived from SNR + noise floor'
                  : detailNote('rssi', 'target ≥ −67 dBm', noSignalNote) ||
                    metricNote(cur.rssi, 'target ≥ −67 dBm'),
                color: warn(rssiNum !== null ? rssiNum < -67 : cur.rssi !== '—' && metricNum(cur.rssi) < -67),
              },
              {
                k: 'SNR',
                v: cur.snr,
                note: metricNote(cur.snr, 'target ≥ 25 dB'),
                color: warn(cur.snr !== '—' && metricNum(cur.snr) < 25),
              },
              {
                k: 'Retries',
                v: radioRetries !== null ? `${radioRetries}%` : cur.retries,
                note: radio
                  ? `${servingRadioLabel(radio)} — the radio's, not this client's`
                  : metricNote(cur.retries, 'target under 8%'),
                color: warn(
                  radioRetries !== null
                    ? radioRetries > 8
                    : cur.retries !== '—' && metricNum(cur.retries) > 8,
                ),
              },
              throughputMetric,
              {
                k: 'Roams',
                // A count the plane never stated is a floor, and reads as an
                // exact number unless it is written as one. `100` and `100+`
                // are the difference between a busy client and a client the
                // portal stopped counting.
                v:
                  roamsNum !== null
                    ? `${formatCount(roamsNum)}${roamsFloor ? '+' : ''}`
                    : cur.roams,
                note:
                  detailNote(
                    'roams',
                    [
                      roamsNum === 0 ? `no roaming in ${roamWindow}` : `in ${roamWindow}`,
                      ...(roamsFloor ? [`at least — ${cur.plane} stated no total, so one page was counted`] : []),
                    ].join(' · '),
                    `no roaming in ${roamWindow}`,
                  ) || metricNote(cur.roams, 'this session'),
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
            ];

        return {
          summary: sectionLive ? known(cur.model, cur.siteName) : known(cur.role, cur.group, cur.siteName),
          metrics,
          qualityNote:
            cur.quality === null
              ? `${cur.plane} reports health as “${cur.health}” but did not provide a numeric experience score.`
              : wired && cur.quality >= 85
                ? 'Wired session health is within target.'
                : wired && cur.quality >= 50
                  ? 'Wired session health is below target; inspect the switch port, VLAN, and authentication.'
                  : wired
                    ? 'Wired session health is poor; inspect the switch port, VLAN, and authentication.'
              : cur.quality >= 85
              ? 'Signal, retries and throughput all within the clinical target.'
              : cur.quality >= 50
                ? 'Below the clinical target — signal or retries are the limiting factor.'
                : 'Session is effectively unusable; see the timeline for why.',
          experienceMeta: wired
            ? `WIRED · ${known(cur.attach, cur.where)}`
            : cur.link === '—' && sectionLive
              ? 'PARTIAL PLANE METRICS'
              : cur.link,
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
          planes360,
          planesMeta,
          planeRows,
          apps360Lines,
        };
      })()
    : null;

  return (
    <div className="nt-stack">
      <ScreenHeader
        overline="Operate / Clients"
        title="Clients"
        subtitle="Every session, wired or wireless, whichever plane authenticated it."
        actions={
          <>
            <span className="nt-mono-label">{stamp}</span>
            {data.blended?.includes('clients') ? <Badge tone="info">LIVE</Badge> : null}
            <Button variant="ghost" size="sm" onClick={() => navigate('/auth-events')}>
              Auth events →
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
                      description: window.location.search || 'unfiltered clients list',
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
            <Button variant="secondary" size="sm" onClick={exportCsv}>
              Export sessions
            </Button>
          </>
        }
      />

      <StatRow stats={data.stats} />

      {clientTypeBuckets.length > 0 ? (
        <div className="nt-chip-row" role="group" aria-label="Client categories">
          <span className="nt-chip-row__label">Categories</span>
          {clientTypeBuckets.map((b) => (
            <button
              key={b.key}
              type="button"
              onClick={() => setType(b.key === type ? 'all' : b.key)}
              className={type === b.key ? 'nt-chip nt-chip--active' : 'nt-chip'}
              aria-pressed={type === b.key}
            >
              <Badge tone={b.tone ?? 'neutral'}>{b.label}</Badge>
              <span className="nt-chip__count">{b.count}</span>
            </button>
          ))}
        </div>
      ) : null}

      {missingSources.length > 0 ? (
        <Alert
          tone="warning"
          title={`${missingSources.length} linked plane${
            missingSources.length === 1 ? '' : 's'
          } contributed no sessions: ${missingSources.join(', ')}`}
        >
          <span className="nt-body-sm">
            Their client read has not come back, so whoever is associated through them is absent from the roster and
            from the counts above. Do not read this as the whole estate.
          </span>
        </Alert>
      ) : null}

      <div className="nt-filter-bar">
        <div className="nt-filter-field nt-filter-field--xl">
          <Input
            size="sm"
            mono
            placeholder="user, MAC, IP, hostname…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            aria-label="Filter clients"
          />
        </div>
        <div className="nt-filter-field nt-filter-field--sm">
          <Select
            options={MEDIUM_OPTIONS}
            value={medium}
            onValueChange={setMedium}
            size="sm"
            aria-label="Medium"
          />
        </div>
        <div className="nt-filter-field nt-filter-field--md">
          <Select
            options={typeOptions}
            value={type}
            onValueChange={setType}
            size="sm"
            aria-label="Device type"
          />
        </div>
        <div className="nt-filter-field nt-filter-field--lg">
          <Select
            options={siteOptions}
            value={site}
            onValueChange={setSite}
            size="sm"
            aria-label="Site"
          />
        </div>
        <div className="nt-filter-field nt-filter-field--lg">
          <Select
            options={groupOptions}
            value={group}
            onValueChange={setGroup}
            size="sm"
            aria-label="Group"
          />
        </div>
        <div className="nt-filter-field nt-filter-field--sm">
          <Select
            options={planeOptions}
            value={plane}
            onValueChange={setPlane}
            size="sm"
            aria-label="Plane"
          />
        </div>
        <Switch label="Problems only" size="sm" checked={problemsOnly} onCheckedChange={setProblemsOnly} />
        <TableViewOptions
          columns={clientColumns}
          config={tableColumns.clients ?? {}}
          onChange={(config) => setTableColumns('clients', config)}
        />
        <KeyboardShortcuts entries={DATATABLE_ROW_SHORTCUTS} />
        <span className="nt-filter-bar__count">
          {/* The estate total is a fixture figure; a live feed counts only what
              the poller returned, so the tail drops rather than contradict the
              `Clients now` Stat above it. */}
          {`${rows.length} of ${clients.length} sampled${
            unverifiedCount ? ` · ${unverifiedCount} unverified` : ''
          }${sectionLive ? '' : ' · 4,982 live sessions'}`}
        </span>
      </div>

      <DataTable
        ariaLabel="Client sessions"
        density={density}
        className="nt-clients-table"
        columns={clientColumns}
        rows={rows}
        rowKey={(c) => c.mac}
        columnsConfig={tableColumns.clients}
        onColumnsConfigChange={(config) => setTableColumns('clients', config)}
        onRowActivate={(c) => openClient(c.mac)}
        selectedKeys={selectedKeys}
        onSelectionChange={setSelectedKeys}
      />
      <SharedFacts facts={shared} count={rows.length} noun="sessions" />

      {/* No sessions at all and no sessions past the filter are different facts —
          blaming a filter the operator never set hides a missing plane. */}
      {rows.length === 0 ? (
        clients.length === 0 ? (
          <EmptyState
            title={
              missingSources.length > 0
                ? 'No sessions from the planes that answered'
                : 'No sessions from any linked plane'
            }
            description={
              sectionLive
                ? missingSources.length > 0
                  ? `The planes that reported have nobody associated. ${missingSources.join(', ')} did not answer, so sessions there are unknown rather than absent.`
                  : 'No plane reported a client on the last poll — check Connected systems.'
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
      {clientHasMore || clientPageTotal != null ? (
        <div className="nt-filter-bar">
          {clientPageTotal != null ? (
            <span className="nt-mono-label">
              Loaded {data.clients.length} of {clientPageTotal}
            </span>
          ) : null}
          {clientHasMore ? (
            <Button
              variant="secondary"
              size="sm"
              disabled={loadingMoreClients}
              onClick={() => loadMoreClientsRef.current()}
            >
              {loadingMoreClients ? 'Loading…' : 'Load more'}
            </Button>
          ) : null}
        </div>
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
          <div className="nt-drawer-stack">
            <div className="nt-chip-row">
              <Badge tone={cur.healthTone} dot>
                {cur.health}
              </Badge>
              <Badge plane>{cur.plane}</Badge>
              <ClientCategoryBadges type={cur.type} model={cur.model} />
              <span
                className="nt-hint-muted"
              >
                {`${cur.sources?.length ?? 1} source${(cur.sources?.length ?? 1) === 1 ? '' : 's'}`}
              </span>
              <span
                className="nt-hint-muted"
              >
                session {cur.session}
              </span>
            </div>

            {isUnverified(cur) ? (
              <div
                className="nt-hint-muted" style={{ lineHeight: 1.6,
                  padding: '10px 12px',
                  border: '1px solid var(--nd-border-default)',
                  background: 'var(--nd-bg-raised)' }}
              >
                {cur.plane} is behind, so this session was not re-confirmed on the last poll. Every
                figure below is last-good at pull time, not current — treat it as unverified.
              </div>
            ) : null}

            <div className="nt-fact-grid">
              <div>
                <SectionHeader label="Connection quality" meta={cur.quality === null ? 'NOT REPORTED' : `${cur.quality} / 100`} />
                <span className="nt-fact-grid__k">
                  {cur.quality === null ? cur.health : `${cur.health} · ${cur.quality} / 100`}
                </span>
              </div>
              <div>
                <SectionHeader label="Current attachment" />
                <span className="nt-fact-grid__k">
                  {`${cur.siteName} · ${cur.attach}${cur.where !== '—' ? ` · ${cur.where}` : ''}`}
                </span>
              </div>
              <div>
                <SectionHeader label="Primary IP / session" />
                <span className="nt-cell-mono nt-cell-dim">{`${cur.ip} · ${cur.session}`}</span>
              </div>
            </div>

            <VisualReferencePanel target={{ kind: 'client', id: cur.mac, plane: cur.plane }} />
            <ConfigActionPanel
              plane={cur.plane}
              targetKind="client"
              target={{ kind: 'client', id: cur.mac, plane: cur.plane }}
            />
            <ConfigRecommendationsPanel clientMac={cur.mac} site={cur.siteName} />

            <Button
              variant="ghost"
              size="sm"
              aria-expanded={showDiagnostics}
              onClick={() => setShowDiagnostics((open) => !open)}
              className="nt-self-start"
            >
              {showDiagnostics ? 'Hide diagnostics' : 'More diagnostics'}
            </Button>

            {showDiagnostics ? (
              <>
            <div className="nt-stack nt-gap-10">
              <SectionHeader label="Experience" meta={drawer.experienceMeta} />
              <div
                className="nt-metrics-3"
              >
                {drawer.metrics.map((m) => (
                  <div key={m.k} className="nt-metric-tile">
                    <span className="nt-metric-tile__k">{m.k}</span>
                    <span className="nt-metric-tile__v" style={{ color: m.color }}>
                      {m.v}
                    </span>
                    <span className="nt-metric-tile__note">{m.note}</span>
                  </div>
                ))}
              </div>
              <div className="nt-stack nt-gap-8 nt-pad-top-6">
                {cur.quality !== null ? (
                  <Progress
                    value={cur.quality}
                    label="Connection quality score"
                    note={`${cur.quality} / 100`}
                  />
                ) : (
                  <SectionHeader label="Connection quality score" meta="NOT REPORTED" />
                )}
                <span className="nt-hint-muted">{drawer.qualityNote}</span>
              </div>
            </div>

            <div className="nt-stack nt-gap-2">
              <SectionHeader label="Where it is" meta={drawer.placeMeta} />
              {drawer.place.map((p) => (
                <div key={p.k} className="nt-fact-row">
                  <span className="nt-fact-row__k nt-fact-row__k--wide">{p.k}</span>
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
                <div className="nt-stack nt-gap-3 nt-pad-top-8">
                  {drawer.placeNotes.map((note) => (
                    <span
                      key={note}
                      className="nt-hint-muted nt-lh-16"
                    >
                      {note}
                    </span>
                  ))}
                </div>
              ) : null}
            </div>

            <div className="nt-stack nt-gap-2">
              <SectionHeader label="Client 360" meta={drawer.planesMeta} />
              {drawer.planes360 === undefined ? (
                /* The per-client read lands after the drawer shell: say the
                   planes are being asked, never that none reported. */
                <div className="nt-center-pad nt-pad-y-18">
                  <Spinner size="sm" />
                </div>
              ) : drawer.planes360 === null ? (
                <div className="nt-hint-muted nt-service-note nt-pad-row">
                  No cross-plane read came back for this client — the session above is unaffected;
                  only the per-plane correlation is missing.
                </div>
              ) : (
                drawer.planeRows.map((row, rowIdx) => (
                  <div key={row.label} className="nt-fact-row">
                    <span className="nt-fact-row__k nt-fact-row__k--wide nt-pad-top-1">
                      <Badge tone={row.tone}>{row.label}</Badge>
                    </span>
                    <div className="nt-stack nt-flex-1 nt-gap-3">
                      {row.lines.map((line, i) => (
                        <span
                          key={i}
                          style={{
                            fontSize: 'var(--nd-text-12)',
                            color: line.muted ? 'var(--nd-text-muted)' : 'var(--nd-text-secondary)',
                          }}
                        >
                          {line.text}
                        </span>
                      ))}
                      {/* The site-wide DPI line rides the Central row only —
                          planeRows maps planes360 in order, so the indexes
                          align. */}
                      {drawer.planes360?.[rowIdx]?.plane === 'central'
                        ? drawer.apps360Lines.map((line, j) => (
                            <span
                              key={`apps-${j}`}
                              style={{
                                fontSize: 'var(--nd-text-12)',
                                color: line.muted ? 'var(--nd-text-muted)' : 'var(--nd-text-secondary)',
                              }}
                            >
                              {line.text}
                            </span>
                          ))
                        : null}
                      {row.events.length > 0 ? (
                        <div className="nt-stack-col nt-gap-3 nt-pad-top-2">
                          <span
                            className="nt-mono-label"
                          >
                            recent auth decisions
                          </span>
                          {row.events.map((e, i) => (
                            <div
                              key={i}
                              className="nt-row-baseline"
                            >
                              <span
                                className="nt-hint-muted nt-w-62"
                              >
                                {e.time}
                              </span>
                              <Badge tone={e.tone}>{e.result}</Badge>
                              <span
                                className="nt-hint-muted"
                              >
                                {nonEmpty([e.method, e.reason]).join(' · ')}
                              </span>
                            </div>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  </div>
                ))
              )}
            </div>

            <div className="nt-stack nt-gap-12">
              <SectionHeader
                label={sectionLive ? 'Reported network topology' : 'Path to the internet'}
                meta={drawer.pathMeta}
              />
              {drawer.path.length === 0 ? (
                <div
                  className="nt-hint-muted nt-lh-16"
                >
                  {drawer.pathEmpty}
                </div>
              ) : (
              <div className="nt-stack-col nt-gap-0" style={{ paddingLeft: 2 }}>
                {drawer.path.map((h, i) => (
                  <div key={`${h.name}-${i}`} className="nt-row-stretch">
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
                    <div className="nt-flex-1" style={{ paddingBottom: 16 }}>
                      <div
                        className="nt-filter-bar nt-gap-10"
                      >
                        {h.device ? (
                          <button
                            type="button"
                            onClick={() => openDevice(h.name)}
                            className="nt-mono-link nt-body-sm"
                          >
                            {h.name}
                          </button>
                        ) : (
                          <span
                            className="nt-configure-row__name-primary"
                          >
                            {h.name}
                          </span>
                        )}
                        <span className="nt-hint-muted">{h.role}</span>
                        {showPlatformTags ? <Badge tone={h.tone}>{h.state}</Badge> : null}
                      </div>
                      {h.hasNext ? (
                        <div
                          className="nt-hint-muted nt-pad-top-5"
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
                  className="nt-hint-muted nt-lh-16"
                >
                  {drawer.pathNote}
                </span>
              ) : null}
            </div>

            {cur.medium === 'wireless' ? (
            <div className="nt-stack nt-gap-2">
              <SectionHeader label="Session timeline" meta={drawer.timelineMeta} />
              {drawer.timeline.length === 0 ? (
                <div
                  className="nt-hint-muted nt-lh-16 nt-pad-row"
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
                    className="nt-hint-muted nt-w-44"
                  >
                    {t.time}
                  </span>
                  <span
                    className="nt-hint-muted nt-w-74 nt-mono-label"
                  >
                    {t.plane}
                  </span>
                  <div className="nt-flex-1">
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
                      className="nt-hint-muted"
                    >
                      {t.raw}
                    </div>
                  </div>
                </div>
              ))
              )}
            </div>
            ) : null}

              </>
            ) : null}

            <div className="nt-stack nt-gap-10">
              <SectionHeader label="Actions" />
              <div className="nt-chip-wrap">
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
                  className="nt-danger-text"
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
                  <div className="nt-flex-1-wide">
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
